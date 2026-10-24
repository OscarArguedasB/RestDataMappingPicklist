import { ResponseCache } from '../core/cache';
import type { PicklistConfig } from '../core/config';
import {
  INPUT_IDS,
  configProblems,
  hasLegacySettings,
  mergeSavedInputs,
  parseConfig,
  pickConfigurationSettings,
  secretBindingProblem,
  secretKindFor,
} from '../core/config';
import { PicklistError, toUserMessage } from '../core/errors';
import { fieldMapUpdates, fieldMapUpdatesForRows } from '../core/fieldMap';
import type { FieldKind } from '../core/fieldTypes';
import { fieldKind, fieldProblem, valueLengthLimit } from '../core/fieldTypes';
import type { PicklistData, PicklistItem } from '../core/items';
import { IncrementalPicklistBuilder, buildPicklistData, itemsWithValue } from '../core/items';
import {
  MULTI_VALUE_SEPARATOR,
  SINGLE_LINE_TEXT_LIMIT,
  escapeHtml,
  formatMultiValue,
  htmlToPlainText,
  parseMultiValue,
} from '../core/multi';
import type { LoadRowsProgress } from '../core/paging';
import { loadRows } from '../core/paging';
import type { SecurityPolicy } from '../core/policy';
import { DEFAULT_POLICY, effectiveLimits } from '../core/policy';
import type { PreparedRequest, RequestSettings } from '../core/request';
import { prepareRequest, requestFieldDependencies } from '../core/request';
import type { SecretDocument } from '../core/secrets';
import { scalarToString } from '../core/values';
import type { ResolvedConfiguration } from '../devops/configurationStore';
import type {
  WorkItemFieldChangedArgs,
  WorkItemFieldInfo,
  WorkItemFormService,
  WorkItemLoadedArgs,
} from '../devops/formService';

export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface PicklistState {
  /** False until the first work item has been read. */
  ready: boolean;
  /** The field's values: at most one unless `multiple`. */
  selected: readonly string[];
  /**
   * The key of the row behind each of `selected`, where known (a value with no entry here was
   * read from the field rather than picked from the list this session, or its row isn't loaded).
   * Rows can share a value but differ in their second line; this is how the list marks the row
   * actually picked instead of every row with that value. See Combobox's `selectedKeys`.
   */
  pickedKeys: readonly string[];
  /** The values as last saved, used to show unsaved changes. */
  savedSelected: readonly string[];
  multiple: boolean;
  fieldLabel: string;
  /** Work item rules consider the field invalid (for example: required and empty). */
  ruleInvalid: boolean;
  readOnly: boolean;
  /** The control's own “Mark as required” option. */
  required: boolean;
  status: LoadStatus;
  /** Null until the list has been loaded for the current work item. */
  items: readonly PicklistItem[] | null;
  /** More pages are still loading; `items` holds what arrived so far. */
  loadingMore: boolean;
  /** Rows loaded so far. */
  loadedCount: number;
  /** The list was cut short by a limit while more data existed. */
  truncated: boolean;
  /** A load failure that “Try again” may fix. */
  error: string | null;
  /** A setup problem an administrator must fix; retrying won't help. */
  configError: string | null;
  /**
   * 4.0: the control names no configuration and keeps no settings of its own, so it has nothing
   * to load. The view says where API settings are managed now.
   */
  moved: boolean;
  /**
   * The REST Picklist settings page, to link from the setup message shown: the moved message, or
   * a problem with a configuration. Null when there's nothing to link, or its address isn't known.
   */
  settingsUrl: string | null;
  /** Multiple values: no other item fits in the field any more. */
  limitReached: boolean;
  /** A short message about the last action, such as a value that didn't fit. */
  notice: string | null;
  /** The “Message when the value isn’t in the list” setting, once the settings are known. */
  notFoundMessage: string;
}

export interface PicklistHost {
  getFormService(): Promise<WorkItemFormService>;
  fetch?: typeof fetch;
  /**
   * The organization's security policy. Default: the built-in rules. With `strict`, a policy that
   * can't be read rejects instead of giving the built-in rules.
   */
  loadPolicy?(options?: { strict?: boolean }): Promise<SecurityPolicy>;
  /** Before 4.0: the shared settings saved under `name` in the process of `projectName`. */
  resolveSavedInputs?(name: string, projectName: string): Promise<Record<string, string>>;
  /**
   * The configuration named `name` (or formerly so) that's shared with the process of
   * `projectName`, from Organization settings › Extensions › REST Picklist.
   */
  resolveConfiguration?(name: string, projectName: string): Promise<ResolvedConfiguration>;
  /** A configuration's secret, or null when none is stored. Kept in memory only. */
  loadSecret?(configurationId: string): Promise<SecretDocument | null>;
  /** The REST Picklist settings page, for links to it; null when its address can't be told. */
  settingsPageUrl?(): Promise<string | null>;
  /** Opens the settings page in a new tab. */
  openSettingsPage?(url: string): void;
}

/** What the response cache keeps for a list: its rows, never whole responses. */
export interface LoadedList {
  rows: unknown[];
  truncated: boolean;
  pages: number;
}

export const LIMIT_MESSAGE = `This field holds up to ${SINGLE_LINE_TEXT_LIMIT} characters. Remove a value to add another.`;

/**
 * Where a control's settings come from: a configuration it names (4.0), the settings it keeps on
 * its own Options tab as before 4.0, or nowhere, because they've moved to the settings page.
 */
type SettingsOrigin = 'configured' | 'legacy' | 'moved';

/** The data source settings in effect: the control's own, merged with a saved configuration. */
interface Source {
  config: PicklistConfig;
  policy: SecurityPolicy;
  dependencies: string[];
  /** The configuration behind `config`, for configured controls. */
  configuration: ResolvedConfiguration | null;
  /** Its secret, read the first time the list loads, and kept in memory only. */
  secret?: Promise<SecretDocument | null>;
}

/** The configuration a control names, with its settings parsed for this control's field. */
interface FoundConfiguration {
  resolved: ResolvedConfiguration;
  config: PicklistConfig;
}

interface FetchedList {
  data: PicklistData;
  truncated: boolean;
  count: number;
}

type Limits = ReturnType<typeof effectiveLimits>;

const LOG_PREFIX = '[REST picklist]';
const VALIDITY_DELAY_MS = 50;
/** How often the list may redraw while pages are still streaming in (a person can't tell the
 *  difference from more often than this, and it bounds the cost of doing so). */
const PROGRESS_PUBLISH_INTERVAL_MS = 120;
const PROJECT_FIELD = 'System.TeamProject';
const MISSING_SECRET =
  'This configuration signs in, but its secret isn’t set. Ask an administrator to set it in Organization settings › Extensions › REST Picklist.';
const SECRET_MISMATCH =
  'This configuration’s secret doesn’t match how it signs in. Ask an administrator to enter it again in Organization settings › Extensions › REST Picklist.';
const sharedCache = new ResponseCache<LoadedList>();

function toFieldText(value: unknown): string {
  return scalarToString(value) ?? '';
}

function sameField(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function findField(fields: readonly WorkItemFieldInfo[], name: string) {
  return fields.find((field) => sameField(field.referenceName, name));
}

function includesField(fields: readonly WorkItemFieldInfo[] | null | undefined, name: string) {
  return (fields ?? []).some((field) => sameField(field.referenceName, name));
}

function quote(value: string): string {
  return `“${value.length > 80 ? `${value.slice(0, 79)}…` : value}”`;
}

/** The API refused the request's credentials. */
function isUnauthorized(error: unknown): boolean {
  return error instanceof PicklistError && error.kind === 'http' && error.status === 401;
}

/**
 * Keeps the picklist in sync with the work item form: reads and writes the field (one value, or
 * several as “A; B; C”), loads the list (eagerly or on first open, page by page), and reloads it
 * when a field used in the request changes.
 *
 * Since 4.0 a control names a configuration from Organization settings › Extensions › REST
 * Picklist, which decides both where the data comes from and how the field behaves; it's found
 * when the work item opens. Its secret, an OAuth 2.0 access token and the organization's policy
 * are only looked up when the list is first loaded, so opening a work item calls no API unless
 * preloading is on. Controls set up before 4.0 keep working with the settings on their own
 * Options tab, and controls with neither only say where API settings are managed now.
 */
export class PicklistController {
  private state: PicklistState;
  private readonly listeners = new Set<() => void>();
  private readonly inputs: Record<string, unknown>;
  /** The control's own settings: the field, and before 4.0 everything else too. */
  private readonly own: PicklistConfig;
  private readonly origin: SettingsOrigin;
  /** What decides how the field behaves: the control's own settings, or its configuration's. */
  private behavior: PicklistConfig;
  /** Configured controls: `behavior` came from the configuration (until then, values are kept). */
  private behaviorKnown = false;
  private readonly host: PicklistHost;
  private readonly cache: ResponseCache<LoadedList>;
  private configuration: { project: string; promise: Promise<FoundConfiguration> } | null = null;
  private source: { project: string; promise: Promise<Source> } | null = null;
  /** The settings behind the list currently shown. */
  private active: PicklistConfig | null = null;
  private dependencies: string[] = [];
  private data: PicklistData | null = null;
  /** Multiple values: the item picked for each value, so equal values copy the right row. */
  private readonly picks = new Map<string, string>();
  private loadToken = 0;
  /** Stops the current load waiting for an access token once it's no longer wanted. */
  private loadAbort: AbortController | null = null;
  /** Counts work items opened, so an earlier one still waiting gives way. */
  private visits = 0;
  /** The list whose pages may update the view while they arrive. */
  private streamingKey: string | null = null;
  private listOpen = false;
  private formReadOnly = false;
  private validityTimer: ReturnType<typeof setTimeout> | undefined;
  private fieldsRequest: Promise<WorkItemFieldInfo[]> | undefined;
  private inspection: Promise<void> | undefined;
  private inspected = false;
  private kind: FieldKind = 'unknown';
  private label = '';
  /** The work item type has no field with the control's “Field to fill in”. */
  private fieldMissing = false;
  /** The field can't be used with this control; nothing is loaded or written. */
  private fieldError: string | null = null;
  /** The settings in effect can't be used (configuration, policy, invalid settings). */
  private sourceError: string | null = null;
  private settingsUrl: string | null = null;
  private settingsUrlRequested = false;

  constructor(
    inputs: Record<string, unknown> | undefined,
    host: PicklistHost,
    cache: ResponseCache<LoadedList> = sharedCache
  ) {
    this.inputs = { ...inputs };
    this.own = parseConfig(this.inputs);
    this.host = host;
    this.cache = cache;
    if (this.own.configuration) {
      this.origin = 'configured';
    } else {
      this.origin = hasLegacySettings(this.inputs) ? 'legacy' : 'moved';
    }
    // A configuration says how the field behaves; until it's found, only the field is known.
    this.behavior =
      this.origin === 'legacy'
        ? this.own
        : parseConfig({ [INPUT_IDS.fieldName]: this.own.fieldName });
    this.state = {
      ready: false,
      selected: [],
      pickedKeys: [],
      savedSelected: [],
      multiple: this.behavior.allowMultiple,
      fieldLabel: '',
      ruleInvalid: false,
      readOnly: false,
      required: this.behavior.required,
      status: 'idle',
      items: null,
      loadingMore: false,
      loadedCount: 0,
      truncated: false,
      error: null,
      configError: null,
      moved: this.origin === 'moved',
      settingsUrl: null,
      limitReached: false,
      notice: null,
      notFoundMessage: this.behavior.notFoundMessage,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PicklistState => this.state;

  readonly onLoaded = async (args: WorkItemLoadedArgs): Promise<void> => {
    const visit = ++this.visits;
    this.cancelLoad();
    this.data = null;
    // The settings behind the last list belong to the last work item, which may be in another
    // project with another configuration (and other fields to fill in).
    this.active = null;
    this.picks.clear();
    this.sourceError = null;
    // Another work item may be in another project, whose configuration may hold values differently.
    this.behaviorKnown = false;
    this.formReadOnly = args.isReadOnly ?? false;
    this.setState({
      status: 'idle',
      items: null,
      loadingMore: false,
      loadedCount: 0,
      truncated: false,
      error: null,
      notice: null,
      pickedKeys: [],
      readOnly: this.isReadOnly(),
    });
    if (this.origin !== 'legacy') {
      // Known before any message needs to link to it.
      this.requestSettingsUrl();
    }
    const usable = this.origin !== 'configured' || (await this.prepareConfiguration(visit));
    if (visit !== this.visits) {
      // Another work item opened meanwhile.
      return;
    }
    await this.syncFromForm();
    this.setState({ ready: true, status: this.fieldError || !usable ? 'error' : 'idle' });
    if (usable && this.canLoad() && (this.behavior.loadOnFormOpen || this.listOpen)) {
      void this.loadItems();
    }
  };

  readonly onFieldChanged = (args: WorkItemFieldChangedArgs): void => {
    const changed = Object.keys(args.changedFields ?? {});
    const own = changed.find((name) => sameField(name, this.own.fieldName));
    if (own !== undefined) {
      const selected = this.readValues(args.changedFields[own]);
      this.setState({
        selected,
        pickedKeys: this.pickedKeysFor(selected),
        limitReached: this.limitReachedFor(selected),
      });
    }
    if (changed.some((name) => this.dependencies.some((field) => sameField(field, name)))) {
      this.invalidateItems();
    }
    this.scheduleValidityCheck();
  };

  readonly onSaved = (): Promise<void> => this.syncFromForm();

  readonly onRefreshed = async (): Promise<void> => {
    // A configuration, its secret, a saved configuration or the policy may have changed too.
    this.source = null;
    this.configuration = null;
    this.active = null;
    this.invalidateItems();
    if (this.origin === 'configured') {
      await this.prepareConfiguration(this.visits);
    }
    await this.syncFromForm();
  };

  readonly onReset = (): Promise<void> => this.onRefreshed();

  readonly onUnloaded = (): void => {
    this.cancelLoad();
    clearTimeout(this.validityTimer);
  };

  /** Called by the view; loads the list on first open when it isn't preloaded. */
  readonly setListOpen = (open: boolean): void => {
    this.listOpen = open;
    if (!open && this.state.notice) {
      this.setState({ notice: null });
    }
    // A configuration problem shown in the open list is spelled out under the field once it closes.
    if (!open && this.isReadOnly() !== this.state.readOnly) {
      this.setState({ readOnly: this.isReadOnly() });
    }
    if (open && this.state.ready && this.state.status === 'idle') {
      void this.loadItems();
    } else if (open && this.state.ready && this.loadFailed()) {
      // Opening the list again tries again: its “Try again” button can't be reached with Tab.
      void this.loadItems({ refresh: true });
    }
  };

  readonly retry = (): void => {
    if (!this.state.configError) {
      void this.loadItems({ refresh: true });
    }
  };

  /**
   * Opens the settings page from a link in a setup message. False when the host can't open it:
   * the link then opens like any other.
   */
  readonly openSettingsPage = (url: string): boolean => {
    if (!this.host.openSettingsPage) {
      return false;
    }
    try {
      this.host.openSettingsPage(url);
      return true;
    } catch {
      return false;
    }
  };

  /** Single value: picks the item. Multiple values: adds its value. */
  readonly select = async (item: PicklistItem): Promise<void> => {
    if (!this.writable()) {
      return;
    }
    if (this.behavior.allowMultiple) {
      await this.add(item);
      return;
    }
    const { value } = item;
    const limit = valueLengthLimit(this.kind);
    if (limit !== null && value.length > limit) {
      this.setState({
        notice: `${quote(value)} is longer than the ${limit} characters this field holds.`,
      });
      return;
    }
    const row = this.data?.rows.get(item.key);
    const updates = {
      ...(await this.forTargetFields(fieldMapUpdates(row, this.active?.fieldMap ?? null))),
      [this.own.fieldName]: this.toFieldValue([value]),
    };
    // Remembers which row this value came from, so a second row with the same value (but a
    // different second line) doesn't look picked too.
    this.picks.clear();
    this.picks.set(value, item.key);
    // Picking a value normally satisfies the rule that flagged the empty field; re-checked below.
    this.setState({ selected: [value], pickedKeys: [item.key], ruleInvalid: false, notice: null });
    await this.writeFields(updates);
  };

  /**
   * Multiple values: adds the item's value, if it fits in the field. When the value is already
   * selected but this is a different row for it (rows can share a value but differ in their
   * second line), it replaces which row is remembered for that value instead of adding a
   * duplicate; mapped fields are recomputed from the new row. Nothing changes when it's the row
   * already remembered, or when no particular row is remembered yet (nothing to switch from).
   */
  readonly add = async (item: PicklistItem): Promise<void> => {
    if (!this.writable()) {
      return;
    }
    const value = item.value.trim();
    if (!value) {
      return;
    }
    if (this.state.selected.includes(value)) {
      const current = this.picks.get(value);
      if (current !== undefined && current !== item.key) {
        this.picks.set(value, item.key);
        await this.applySelection(this.state.selected);
      }
      return;
    }
    if (value.includes(';')) {
      this.setState({
        notice: `${quote(value)} contains a semicolon, which separates the values in this field, so it can’t be added.`,
      });
      return;
    }
    const next = [...this.state.selected, value];
    const limit = valueLengthLimit(this.kind);
    if (limit !== null && formatMultiValue(next).length > limit) {
      this.setState({
        notice: `${quote(value)} doesn’t fit: this field holds up to ${limit} characters. Remove a value to add it.`,
      });
      return;
    }
    this.picks.set(value, item.key);
    await this.applySelection(next);
  };

  /** Multiple values: removes one value. */
  readonly remove = async (value: string): Promise<void> => {
    if (!this.writable()) {
      return;
    }
    const next = this.state.selected.filter((selected) => selected !== value);
    if (next.length === this.state.selected.length) {
      return;
    }
    this.picks.delete(value);
    await this.applySelection(next);
  };

  /** Empties the field and the fields filled from it, like removing the last value does. */
  readonly clear = async (): Promise<void> => {
    if (!this.writable()) {
      return;
    }
    this.picks.clear();
    // Before the first load, a saved configuration's field map isn't known yet; look it up so
    // those fields are emptied too. If that fails, they're left as they are. (A configuration's
    // field map is known as soon as the work item opens.)
    if (
      !this.active &&
      this.origin === 'legacy' &&
      this.own.savedConfiguration &&
      !this.own.fieldMap
    ) {
      try {
        this.active = (await this.getSource(await this.host.getFormService())).config;
      } catch {
        // The list shows the problem the next time it loads.
      }
    }
    await this.applySelection([]);
  };

  private setState(patch: Partial<PicklistState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private writable(): boolean {
    return (
      !this.state.readOnly &&
      !this.fieldError &&
      Boolean(this.own.fieldName) &&
      // Until its configuration is found, the control can't tell how the field holds its values.
      (this.origin !== 'configured' || this.behaviorKnown)
    );
  }

  /** Whether anything can be loaded at all. */
  private canLoad(): boolean {
    return !this.fieldError && this.origin !== 'moved';
  }

  /** The last load failed in a way trying again may fix (not a setup problem). */
  private loadFailed(): boolean {
    return (
      this.state.status === 'error' &&
      this.state.error !== null &&
      this.state.configError === null &&
      !this.state.moved
    );
  }

  private isReadOnly(): boolean {
    return (
      this.formReadOnly ||
      this.fieldError !== null ||
      this.origin === 'moved' ||
      // A configuration that can't be used is spelled out under the field while the list is closed.
      (this.origin === 'configured' && this.sourceError !== null && !this.listOpen)
    );
  }

  /** The setup problem to show, and whether it links to the settings page. */
  private setupState(): Pick<PicklistState, 'configError' | 'settingsUrl'> {
    const configError = this.fieldError ?? this.sourceError;
    // Field problems are fixed in the process editor, and older controls keep their 3.0 messages;
    // the moved message and problems with a configuration point to the settings page.
    const linked =
      this.origin === 'moved' ||
      (this.origin === 'configured' && this.fieldError === null && this.sourceError !== null);
    return { configError, settingsUrl: linked ? this.settingsUrl : null };
  }

  /** Asks the host once where the settings page is, for links from setup messages. */
  private requestSettingsUrl(): void {
    if (this.settingsUrlRequested || !this.host.settingsPageUrl) {
      return;
    }
    this.settingsUrlRequested = true;
    void Promise.resolve()
      .then(() => this.host.settingsPageUrl?.())
      .then(
        (url) => {
          if (url) {
            this.settingsUrl = url;
            this.setState(this.setupState());
          }
        },
        () => {
          // The messages still say where the settings are.
        }
      );
  }

  // ---- Reading and writing the field ----

  private readValues(raw: unknown): string[] {
    let text = toFieldText(raw);
    if (this.kind === 'html') {
      text = htmlToPlainText(text);
    }
    if (this.behavior.allowMultiple) {
      return parseMultiValue(text);
    }
    return text === '' ? [] : [text];
  }

  private toFieldValue(values: readonly string[]): string {
    const text = this.behavior.allowMultiple ? formatMultiValue(values) : (values[0] ?? '');
    // HTML fields show markup, so text from the API must never become markup.
    return this.kind === 'html' ? escapeHtml(text) : text;
  }

  private limitReachedFor(
    selected: readonly string[],
    items: readonly PicklistItem[] | null = this.state.items
  ): boolean {
    const limit = this.behavior.allowMultiple ? valueLengthLimit(this.kind) : null;
    if (limit === null) {
      return false;
    }
    const used = formatMultiValue(selected).length;
    const separator = selected.length > 0 ? MULTI_VALUE_SEPARATOR.length : 0;
    if (!items) {
      return used + separator + 1 > limit;
    }
    // Reached when not even the shortest value still available would fit.
    const chosen = new Set(selected);
    let shortest = Number.POSITIVE_INFINITY;
    for (const item of items) {
      const value = item.value.trim();
      if (value && !chosen.has(value) && !value.includes(';')) {
        shortest = Math.min(shortest, value.length);
      }
    }
    return Number.isFinite(shortest) && used + separator + shortest > limit;
  }

  private async applySelection(next: readonly string[]): Promise<void> {
    const updates = {
      ...(await this.forTargetFields(this.mappedValuesFor(next))),
      [this.own.fieldName]: this.toFieldValue(next),
    };
    this.setState({
      selected: next,
      pickedKeys: this.pickedKeysFor(next),
      notice: null,
      limitReached: this.limitReachedFor(next),
      ruleInvalid: next.length > 0 ? false : this.state.ruleInvalid,
    });
    await this.writeFields(updates);
  }

  /** The remembered row key for each of `values` that has one (see `PicklistState.pickedKeys`). */
  private pickedKeysFor(values: readonly string[]): string[] {
    const keys: string[] = [];
    for (const value of values) {
      const key = this.picks.get(value);
      if (key !== undefined) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * What the mapped fields get for these values, from the row picked for each value (or the
   * first row with that value). With no values they're emptied. Otherwise nothing changes while
   * the list isn't loaded, so fields aren't emptied just because their rows aren't known yet.
   */
  private mappedValuesFor(values: readonly string[]): Record<string, string> {
    // Before the first load only the control's own map (or its configuration's) is known; for
    // controls set up before 4.0, it wins over a saved one anyway.
    const map = this.active?.fieldMap ?? this.behavior.fieldMap;
    if (!map) {
      return {};
    }
    if (values.length === 0) {
      return fieldMapUpdatesForRows([], map, 'all');
    }
    const data = this.data;
    if (!data) {
      return {};
    }
    const rows: unknown[] = [];
    for (const value of values) {
      const picked = this.picks.get(value);
      const key =
        picked !== undefined && data.rows.has(picked)
          ? picked
          : itemsWithValue(data, value)[0]?.key;
      if (key !== undefined && data.rows.has(key)) {
        rows.push(data.rows.get(key));
      }
    }
    return fieldMapUpdatesForRows(rows, map, this.active?.advanced.copyMode ?? 'all');
  }

  /** Escapes values for mapped fields that hold HTML. */
  private async forTargetFields(
    updates: Record<string, string | number | boolean>
  ): Promise<Record<string, unknown>> {
    if (Object.keys(updates).length === 0) {
      return updates;
    }
    const form = await this.host.getFormService();
    const fields = await this.fieldInfos(form);
    const result: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(updates)) {
      const target = findField(fields, name);
      result[name] = fieldKind(target) === 'html' ? escapeHtml(String(value)) : value;
    }
    return result;
  }

  private async writeFields(updates: Record<string, unknown>): Promise<void> {
    try {
      const form = await this.host.getFormService();
      const results = await form.setFieldValues(updates);
      const failed = Object.entries(results ?? {})
        .filter(([, succeeded]) => !succeeded)
        .map(([field]) => field);
      if (failed.length > 0) {
        console.warn(`${LOG_PREFIX} These fields could not be updated: ${failed.join(', ')}`);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Could not update the work item:`, error);
      await this.syncFromForm();
    }
    this.scheduleValidityCheck();
  }

  private async syncFromForm(): Promise<void> {
    const field = this.own.fieldName;
    if (!field) {
      this.fieldError =
        'Choose the field this control fills in: Options › “Field to fill in” in the process editor.';
      this.setState({ ...this.setupState(), readOnly: true });
      return;
    }
    try {
      const form = await this.host.getFormService();
      const [value, savedValue, invalidFields] = await Promise.all([
        form.getFieldValue(field, { returnOriginalValue: false }),
        form.getFieldValue(field, { returnOriginalValue: true }),
        form.getInvalidFields().catch(() => []),
        this.inspectField(form),
      ]);
      const selected = this.readValues(value);
      this.setState({
        selected,
        pickedKeys: this.pickedKeysFor(selected),
        savedSelected: this.readValues(savedValue),
        ruleInvalid: includesField(invalidFields, field),
        fieldLabel: this.label,
        limitReached: this.limitReachedFor(selected),
        ...this.setupState(),
        readOnly: this.isReadOnly(),
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} Could not read “${field}” from the work item:`, error);
    }
  }

  private fieldInfos(form: WorkItemFormService): Promise<WorkItemFieldInfo[]> {
    this.fieldsRequest ??= form.getFields().then(
      (fields) => fields ?? [],
      () => []
    );
    return this.fieldsRequest;
  }

  /** Reads the field's label and type once, and checks that the control can fill it. */
  private async inspectField(form: WorkItemFormService): Promise<void> {
    this.inspection ??= this.fieldInfos(form).then((fields) => {
      const field = this.own.fieldName;
      const info = findField(fields, field);
      this.kind = fieldKind(info);
      this.label = info?.name ?? field;
      this.fieldMissing = fields.length > 0 && !info;
      this.inspected = true;
    });
    await this.inspection;
    this.checkField();
  }

  /** Whether the control can fill its field the way the settings in effect use it. */
  private checkField(): void {
    if (!this.inspected) {
      return;
    }
    this.fieldError = this.fieldMissing
      ? `${quote(this.own.fieldName)} isn’t a field of this work item type. Check the control’s “Field to fill in” option.`
      : fieldProblem(this.kind, this.behavior.allowMultiple, this.label);
  }

  private scheduleValidityCheck(): void {
    clearTimeout(this.validityTimer);
    this.validityTimer = setTimeout(() => void this.checkValidity(), VALIDITY_DELAY_MS);
  }

  private async checkValidity(): Promise<void> {
    try {
      const form = await this.host.getFormService();
      const invalidFields = await form.getInvalidFields();
      this.setState({ ruleInvalid: includesField(invalidFields, this.own.fieldName) });
    } catch {
      // The form may be closing; there's nothing left to update.
    }
  }

  // ---- Finding the settings ----

  private async projectOf(form: WorkItemFormService): Promise<string> {
    return toFieldText(
      await form.getFieldValue(PROJECT_FIELD, { returnOriginalValue: false })
    ).trim();
  }

  /**
   * Configured controls: finds the configuration when the work item opens, because it says how
   * the field behaves (multiple values, required, load on open). Its secret is only read when the
   * list loads. False when it can't be used; the problem is shown.
   */
  private async prepareConfiguration(visit: number): Promise<boolean> {
    let found: FoundConfiguration;
    try {
      const form = await this.host.getFormService();
      found = await this.findConfiguration(await this.projectOf(form));
    } catch (error) {
      if (visit === this.visits) {
        this.showLoadError(error);
      }
      return false;
    }
    if (visit === this.visits) {
      this.useConfiguration(found.config);
    }
    return true;
  }

  /** The configuration this control names, for the work item's project; looked up once per project. */
  private findConfiguration(project: string): Promise<FoundConfiguration> {
    if (this.configuration && this.configuration.project === project) {
      return this.configuration.promise;
    }
    const promise = this.lookUpConfiguration(project);
    const entry = { project, promise };
    this.configuration = entry;
    // Failures aren't kept: the next load asks again.
    void promise.catch(() => {
      if (this.configuration === entry) {
        this.configuration = null;
      }
    });
    return promise;
  }

  private async lookUpConfiguration(project: string): Promise<FoundConfiguration> {
    const name = this.own.configuration;
    if (!this.host.resolveConfiguration) {
      throw new PicklistError(
        'config',
        `Configurations aren’t available here, so ${quote(name)} can’t be used.`
      );
    }
    if (!project) {
      throw new PicklistError(
        'config',
        `Couldn’t tell which project this work item is in, so the configuration ${quote(name)} can’t be used.`
      );
    }
    const resolved = await this.host.resolveConfiguration(name, project);
    // Only a configuration's own settings: its credentials come from its secret, never from the
    // control, and the control only adds its field.
    const config = parseConfig({
      ...pickConfigurationSettings(resolved.settings),
      [INPUT_IDS.fieldName]: this.own.fieldName,
    });
    const problems = configProblems(config);
    if (problems.length > 0) {
      throw new PicklistError('config', problems.join(' '));
    }
    return { resolved, config };
  }

  /**
   * Takes a configuration's behavior for the field: multiple values, required, load on open and
   * the message for values not in the list. True when the field's values must be read again,
   * because multiple values were turned on or off.
   */
  private useConfiguration(config: PicklistConfig): boolean {
    if (this.behaviorKnown && this.behavior === config) {
      return false;
    }
    const reread = this.behavior.allowMultiple !== config.allowMultiple;
    this.behavior = config;
    this.behaviorKnown = true;
    this.checkField();
    this.setState({
      multiple: config.allowMultiple,
      required: config.required,
      notFoundMessage: config.notFoundMessage,
      ...this.setupState(),
      readOnly: this.isReadOnly(),
    });
    return reread;
  }

  // ---- Loading the list ----

  /** Keeps the load in progress, if any, from changing anything. */
  private cancelLoad(): void {
    this.loadToken++;
    this.streamingKey = null;
    this.loadAbort?.abort();
    this.loadAbort = null;
  }

  private invalidateItems(): void {
    this.cancelLoad();
    this.data = null;
    this.sourceError = null;
    this.setState({
      status: this.fieldError ? 'error' : 'idle',
      items: null,
      loadingMore: false,
      loadedCount: 0,
      truncated: false,
      error: null,
      ...this.setupState(),
      readOnly: this.isReadOnly(),
      limitReached: this.limitReachedFor(this.state.selected, null),
    });
    if (this.canLoad() && this.state.ready && (this.behavior.loadOnFormOpen || this.listOpen)) {
      void this.loadItems();
    }
  }

  /**
   * The organization's security policy. `strict` (configurations, whose secrets the policy
   * guards): a policy that can't be read stops the list, so a secret never goes where the policy
   * would have refused it. Otherwise (controls from before 4.0, as in 3.0) the built-in rules
   * apply, so a storage outage doesn't break their forms.
   */
  private async loadPolicy(strict = false): Promise<SecurityPolicy> {
    if (!this.host.loadPolicy) {
      return DEFAULT_POLICY;
    }
    try {
      return await this.host.loadPolicy(strict ? { strict: true } : undefined);
    } catch (error) {
      if (strict) {
        throw new PicklistError(
          'network',
          'The organization’s security policy couldn’t be read. Try again.'
        );
      }
      console.warn(
        `${LOG_PREFIX} Using the built-in rules: the security policy couldn’t be read.`,
        error
      );
      return DEFAULT_POLICY;
    }
  }

  private async resolveSource(project: string): Promise<Source> {
    if (this.origin === 'configured') {
      const [policy, found] = await Promise.all([
        this.loadPolicy(true),
        this.findConfiguration(project),
      ]);
      return {
        config: found.config,
        policy,
        dependencies: found.config.url ? requestFieldDependencies(found.config) : [],
        configuration: found.resolved,
      };
    }
    const policy = await this.loadPolicy();
    let config = this.own;
    const savedName = this.own.savedConfiguration;
    if (savedName) {
      if (!policy.allowSavedConfigurations) {
        throw new PicklistError(
          'config',
          `Your organization’s security policy doesn’t allow saved configurations, so ${quote(savedName)} can’t be used. Fill in this control’s settings instead.`
        );
      }
      if (!this.host.resolveSavedInputs) {
        throw new PicklistError(
          'config',
          `Saved configurations aren’t available here, so ${quote(savedName)} can’t be used.`
        );
      }
      if (!project) {
        throw new PicklistError(
          'config',
          `Couldn’t tell which project this work item is in, so the saved configuration ${quote(savedName)} can’t be used.`
        );
      }
      const saved = await this.host.resolveSavedInputs(savedName, project);
      // The control's own non-empty settings win; credentials always come from the control.
      config = parseConfig(mergeSavedInputs(this.inputs, saved));
    }
    // A token URL and a client secret or key only live in configurations.
    if (config.authMethod === 'oauth2') {
      throw new PicklistError(
        'config',
        'OAuth 2.0 sign-in needs a configuration. Set one up in Organization settings › Extensions › REST Picklist.'
      );
    }
    const problems = configProblems(config);
    if (problems.length > 0) {
      throw new PicklistError('config', problems.join(' '));
    }
    return {
      config,
      policy,
      dependencies: config.url ? requestFieldDependencies(config) : [],
      configuration: null,
    };
  }

  /** The settings in effect for this work item, looked up once per project. */
  private async getSource(form: WorkItemFormService): Promise<Source> {
    const project =
      this.origin === 'configured' || this.own.savedConfiguration ? await this.projectOf(form) : '';
    if (this.source && this.source.project === project) {
      return this.source.promise;
    }
    const promise = this.resolveSource(project);
    const entry = { project, promise };
    this.source = entry;
    // Failures aren't kept: the next load asks again.
    void promise.catch(() => {
      if (this.source === entry) {
        this.source = null;
      }
    });
    return promise;
  }

  /** The secret a configuration signs in with: read once per source, and kept in memory only. */
  private secretOf(source: Source): Promise<SecretDocument | null> {
    const { configuration } = source;
    if (!configuration) {
      return Promise.resolve(null);
    }
    if (!source.secret) {
      const promise = this.readSecret(configuration, source.config);
      source.secret = promise;
      // Failures aren't kept: the next load asks again.
      void promise.catch(() => {
        if (source.secret === promise) {
          source.secret = undefined;
        }
      });
    }
    return source.secret;
  }

  private async readSecret(
    configuration: ResolvedConfiguration,
    config: PicklistConfig
  ): Promise<SecretDocument | null> {
    const kind = secretKindFor(config.authMethod, config.oauth.clientAuthentication);
    if (!kind) {
      return null;
    }
    if (!this.host.loadSecret) {
      throw new PicklistError(
        'config',
        'Secrets aren’t available here, so this configuration can’t sign in.'
      );
    }
    const secret = await this.host.loadSecret(configuration.id);
    if (!secret) {
      // Basic sign-in with a user name and no password sends the user name alone, as it did
      // before 4.0: some APIs take a key as the user name.
      if (config.authMethod === 'basic' && config.username.trim()) {
        return null;
      }
      throw new PicklistError('config', MISSING_SECRET);
    }
    // A secret is only ever sent where it was saved for, and for OAuth 2.0 its tokens too.
    const moved = secretBindingProblem(
      secret.boundOrigin,
      configuration.settings,
      secret.apiOrigin
    );
    if (moved) {
      throw new PicklistError('config', moved);
    }
    if (secret.secret.kind !== kind) {
      throw new PicklistError('config', SECRET_MISMATCH);
    }
    return secret;
  }

  private async loadItems({ refresh = false } = {}): Promise<void> {
    if (!this.canLoad()) {
      return;
    }
    this.cancelLoad();
    const token = this.loadToken;
    const abort = new AbortController();
    this.loadAbort = abort;
    this.sourceError = null;
    this.setState({
      status: 'loading',
      error: null,
      ...this.setupState(),
      readOnly: this.isReadOnly(),
      loadingMore: false,
      truncated: false,
    });
    try {
      const form = await this.host.getFormService();
      const source = await this.getSource(form);
      if (token !== this.loadToken) {
        return;
      }
      if (source.configuration && this.useConfiguration(source.config)) {
        // The configuration found on a retry holds the field's values differently.
        await this.syncFromForm();
        if (token !== this.loadToken) {
          return;
        }
      }
      if (this.fieldError) {
        // The configuration uses the field in a way it can't be used; syncFromForm shows why.
        this.setState({ status: 'error', ...this.setupState(), readOnly: this.isReadOnly() });
        return;
      }
      this.active = source.config;
      this.dependencies = source.dependencies;
      this.setState({ notFoundMessage: source.config.notFoundMessage });
      const list = await this.fetchList(form, source, refresh, abort.signal);
      if (token !== this.loadToken) {
        return;
      }
      this.showList(list.data, {
        status: 'loaded',
        loadingMore: false,
        loadedCount: list.count,
        truncated: list.truncated,
      });
    } catch (error) {
      if (token !== this.loadToken) {
        return;
      }
      this.showLoadError(error);
    }
  }

  /** Shows why the settings or the list couldn't be loaded. */
  private showLoadError(error: unknown): void {
    this.streamingKey = null;
    if (error instanceof PicklistError && error.kind === 'config') {
      // fetchList() already sorted and showed whatever had streamed in before this error.
      this.sourceError = error.message;
      this.setState({
        status: 'error',
        ...this.setupState(),
        readOnly: this.isReadOnly(),
        loadingMore: false,
      });
      return;
    }
    console.warn(`${LOG_PREFIX} Could not load the list:`, error);
    this.setState({ status: 'error', error: toUserMessage(error), loadingMore: false });
  }

  private showList(data: PicklistData, patch: Partial<PicklistState>): void {
    this.data = data;
    this.setState({
      ...patch,
      items: data.items,
      limitReached: this.limitReachedFor(this.state.selected, data.items),
    });
  }

  private async fetchList(
    form: WorkItemFormService,
    source: Source,
    refresh: boolean,
    signal: AbortSignal
  ): Promise<FetchedList> {
    const { config, policy } = source;
    if (!config.url) {
      // Without an endpoint, offer the values allowed by the process instead.
      const allowed = (await form.getAllowedFieldValues(this.own.fieldName)) ?? [];
      return { data: buildPicklistData(allowed, ''), truncated: false, count: allowed.length };
    }
    const fieldValues = source.dependencies.length
      ? await form.getFieldValues(source.dependencies, { returnOriginalValue: false })
      : {};
    const limits = effectiveLimits(config.advanced, policy);
    const settings = (password: string): RequestSettings => ({
      ...config,
      password,
      apiKeyHeader: config.advanced.apiKeyHeader,
    });
    // Before a configuration's secret is read, the request (its address, the field values in it
    // and the sign-in method) must pass the policy. Older controls keep their password inline.
    const request = prepareRequest(settings(config.password), fieldValues, policy);
    if (!source.configuration) {
      return this.streamList(request, source, limits, refresh);
    }
    const secret = await this.secretOf(source);
    if (!secret) {
      return this.streamList(request, source, limits, refresh);
    }
    const stored = secret.secret;
    if (config.authMethod !== 'oauth2') {
      // A password, token or API key: readSecret checked that it's the kind this method sends.
      const value = stored.kind === 'signingKey' ? '' : stored.value;
      return this.streamList(
        prepareRequest(settings(value), fieldValues, policy),
        source,
        limits,
        refresh
      );
    }
    // OAuth 2.0: the client secret or key only goes to the token URL, and the API gets the token.
    // Forms whose configuration doesn't use it never download this code.
    const { sharedTokenCache } = await import('../core/oauth');
    const accessToken = async (): Promise<string> => {
      const token = await sharedTokenCache.get(config.oauth, stored, policy, {
        fetchImpl: this.host.fetch,
        timeoutMs: limits.timeoutMs,
        signal,
        boundOrigin: secret.boundOrigin,
      });
      return token.accessToken;
    };
    const token = await accessToken();
    try {
      return await this.streamList(
        prepareRequest(settings(token), fieldValues, policy),
        source,
        limits,
        refresh
      );
    } catch (error) {
      // Only the API's own refusal: a token service that refuses has already said why.
      if (!isUnauthorized(error)) {
        throw error;
      }
      // The token may have been revoked before it expired: get a new one and try once more.
      await sharedTokenCache.invalidate(config.oauth, stored, token);
      return this.streamList(
        prepareRequest(settings(await accessToken()), fieldValues, policy),
        source,
        limits,
        refresh
      );
    }
  }

  private async streamList(
    request: PreparedRequest,
    source: Source,
    limits: Limits,
    refresh: boolean
  ): Promise<FetchedList> {
    const { config, policy } = source;
    const { paging } = config.advanced;
    // The same request with other paging or limits gives a different list.
    const key = [
      request.cacheKey,
      config.arrayPath,
      JSON.stringify(paging),
      limits.maxItems,
      limits.maxPages,
    ].join('\n');
    this.streamingKey = key;

    // Builds the visible list as pages stream in without re-sorting (or re-scanning rows already
    // added) on every page: rows keep the order they were first seen in while more may still
    // arrive, so an open list doesn't reorder under the pointer, and a page's own cost doesn't
    // grow with how much has loaded before it. It's sorted once, below, either when the load
    // finishes or (with whatever streamed in) if it fails partway through.
    const builder = new IncrementalPicklistBuilder(config.keyField, config.secondLineProperty);
    let streamed = false;
    let seenRows = 0;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPublishedAt = -Infinity;

    const publish = () => {
      publishTimer = undefined;
      if (this.streamingKey !== key) {
        return;
      }
      lastPublishedAt = Date.now();
      this.showList(builder.snapshot, {
        status: 'loaded',
        loadingMore: true,
        loadedCount: seenRows,
      });
    };
    // A copy of everything loaded so far (cheap: no sort, no per-row work) is what gives React a
    // new `items` reference to notice; publishing it on every page would still cost O(everything
    // so far) once per page, so it's throttled to about the same rate a person can perceive.
    const onProgress = (progress: LoadRowsProgress) => {
      if (progress.done || this.streamingKey !== key) {
        return;
      }
      streamed = true;
      // Only the rows new to this page are scanned; rows already added aren't looked at again.
      builder.add(progress.rows.slice(seenRows));
      seenRows = progress.rows.length;
      if (publishTimer !== undefined) {
        return;
      }
      const wait = PROGRESS_PUBLISH_INTERVAL_MS - (Date.now() - lastPublishedAt);
      if (wait <= 0) {
        publish();
      } else {
        publishTimer = setTimeout(publish, wait);
      }
    };
    const clearPublishTimer = () => {
      if (publishTimer !== undefined) {
        clearTimeout(publishTimer);
        publishTimer = undefined;
      }
    };

    let loaded: LoadedList;
    try {
      loaded = await this.cache.get(
        key,
        async () => {
          const result = await loadRows({
            request,
            arrayPath: config.arrayPath,
            paging,
            maxItems: limits.maxItems,
            maxPages: limits.maxPages,
            policy,
            fetchOptions: { fetchImpl: this.host.fetch, timeoutMs: limits.timeoutMs },
            onProgress: paging.type === 'none' ? undefined : onProgress,
          });
          return { rows: result.rows, truncated: result.truncated, pages: result.pages };
        },
        { refresh }
      );
    } catch (error) {
      clearPublishTimer();
      // Sort whatever streamed in before the failure, so the error doesn't leave the list
      // looking unfinished (still in the order pages happened to arrive in) underneath it.
      if (streamed && this.streamingKey === key) {
        this.showList(builder.finish(), { loadingMore: false });
      }
      throw error;
    }
    clearPublishTimer();
    if (this.streamingKey === key) {
      this.streamingKey = null;
    }
    // Streamed loads already have every row in the builder: finishing it is the same result as
    // rebuilding from `loaded.rows`, without scanning them again. A cache hit, or paging "none",
    // never streamed, so it's built here instead.
    const data = streamed
      ? builder.finish()
      : buildPicklistData(loaded.rows, config.keyField, config.secondLineProperty);
    return {
      data,
      truncated: loaded.truncated,
      count: loaded.rows.length,
    };
  }
}
