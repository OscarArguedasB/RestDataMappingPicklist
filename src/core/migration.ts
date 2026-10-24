import type { AuthMethod } from './config';
import {
  AUTH_METHOD_LABELS,
  INPUT_IDS,
  hasLegacySettings,
  mergeSavedInputs,
  parseAuthMethod,
  pickConfigurationSettings,
  pickSavedInputs,
} from './config';
import type { ConfigurationDocument } from './configurations';
import {
  CONFIGURATION_LIMITS,
  cleanConfigurationName,
  configurationsForProcess,
  nameKey,
  quoteName,
  shortenName,
} from './configurations';
import type { SecretKind, StoredSecret } from './secrets';
import { SECRET_LIMITS, isMaskedValue } from './secrets';
import { scalarToString } from './values';

// Before 4.0, each control kept its API settings on its Options tab, and a 3.0 control could save
// them for other controls of the process ("saved configurations"). Moving a process means turning
// those settings into configurations and pointing each control at one by name. Planning is done
// here, without side effects; the setup page runs the plan.

export interface WorkItemTypeRef {
  name: string;
  referenceName: string;
}

/** One of this extension's controls in a process layout (see layout.ts). */
export interface LayoutControl {
  processId: string;
  processName: string;
  workItemType: WorkItemTypeRef;
  groupId: string;
  controlId: string;
  /** The control's label in the layout; may be empty. */
  label: string;
  /** The field it fills in (its FieldName input), trimmed; may be empty. */
  fieldName: string;
  /** The contribution's inputs as Azure DevOps returned them. */
  inputs: Record<string, unknown>;
  /** The layout control exactly as Azure DevOps returned it, for updates. */
  control: Record<string, unknown>;
}

export type ControlStatus =
  /** Uses a configuration by name. `leftovers`: settings from before 4.0 are still stored on it. */
  | { kind: 'configured'; configuration: string; leftovers: boolean }
  /** Keeps its API settings on its Options tab, as before 4.0. */
  | { kind: 'legacy' }
  /** Not set up yet. */
  | { kind: 'empty' };

/** Where a configuration's secret comes from when a group of controls moves. */
export type MigrationSecret =
  /** The sign-in method needs no secret. */
  | { status: 'none' }
  /**
   * Read from the controls' Options tab; save it with the configuration. Memory only: never show,
   * log or store it anywhere else.
   */
  | { status: 'ready'; secret: StoredSecret }
  /** The configuration being reused already has a secret, which is kept. */
  | { status: 'kept' }
  /** Azure DevOps hid it or left it out, so it has to be entered again after moving. */
  | { status: 'needed' };

/** Controls with the same settings and secret, moving into one configuration. */
export interface MigrationGroup {
  /** The new configuration's name (unique in the process), or the reused one's. */
  name: string;
  /** A configuration of this process with the same settings, used instead of a new one. */
  existing: ConfigurationDocument | null;
  /** The settings the controls work with today, as a configuration keeps them. */
  settings: Record<string, string>;
  secret: MigrationSecret;
  /** The 3.0 saved configuration the settings came from, if they did. */
  savedConfigurationName: string | null;
  controls: LayoutControl[];
}

export interface MigrationStep {
  control: LayoutControl;
  /** Index of the control's group in MigrationPlan.groups. */
  group: number;
  /**
   * Controls that still use this control's 3.0 saved configuration. They come earlier in the
   * steps; update this control only when all of them moved, or they'd lose their settings.
   */
  usedBy: LayoutControl[];
  /** Things to check after moving, such as a sign-in Azure DevOps doesn't show. */
  warnings: string[];
}

export interface MigrationProblem {
  control: LayoutControl;
  /** Why it can't move now. It keeps working on its own settings meanwhile. */
  message: string;
}

/**
 * How to move a process's controls. Run it in order: create or reuse each group's configuration
 * (and save its secret), then update each step's control to migratedInputs(control, group name),
 * skipping a step whose `usedBy` controls didn't all move.
 */
export interface MigrationPlan {
  processId: string;
  processName: string;
  groups: MigrationGroup[];
  steps: MigrationStep[];
  problems: MigrationProblem[];
}

function text(value: unknown): string {
  return scalarToString(value) ?? '';
}

function flag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/** Where a control is, like “Bug › Customer”. */
export function describeControl(
  control: Pick<LayoutControl, 'workItemType' | 'label' | 'fieldName' | 'controlId'>
): string {
  return `${control.workItemType.name} › ${control.label || control.fieldName || control.controlId}`;
}

function isSet(value: unknown): boolean {
  const trimmed = text(value).trim();
  return trimmed !== '' && trimmed.toLowerCase() !== 'false';
}

/** Whether a control uses a configuration, still keeps its settings itself, or isn't set up. */
export function controlStatus(control: Pick<LayoutControl, 'inputs'>): ControlStatus {
  const { inputs } = control;
  const configuration = text(inputs[INPUT_IDS.configuration]).trim();
  if (configuration) {
    const leftovers = Object.entries(inputs).some(
      ([id, value]) => id !== INPUT_IDS.fieldName && id !== INPUT_IDS.configuration && isSet(value)
    );
    return { kind: 'configured', configuration, leftovers };
  }
  return hasLegacySettings(inputs) ? { kind: 'legacy' } : { kind: 'empty' };
}

/**
 * The inputs a control keeps once it uses a configuration: the field and the configuration's
 * name, nothing else. Sending exactly these removes the old settings, passwords included.
 */
export function migratedInputs(
  control: Pick<LayoutControl, 'inputs' | 'fieldName'>,
  name: string
): Record<string, string> {
  return {
    [INPUT_IDS.fieldName]: control.fieldName || text(control.inputs[INPUT_IDS.fieldName]).trim(),
    [INPUT_IDS.configuration]: name.trim(),
  };
}

function isHolder(control: LayoutControl): boolean {
  return flag(control.inputs[INPUT_IDS.saveConfiguration]);
}

/** The name a 3.0 control saved its settings under, by the same rules 3.0 used. */
function savedNameOf(control: LayoutControl): string {
  return (
    text(control.inputs[INPUT_IDS.savedConfigurationName]).trim() ||
    control.label ||
    control.fieldName ||
    control.controlId
  );
}

function referenceOf(control: LayoutControl): string {
  return text(control.inputs[INPUT_IDS.savedConfiguration]).trim();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareControls(a: LayoutControl, b: LayoutControl): number {
  const options = { sensitivity: 'base', numeric: true } as const;
  return (
    a.workItemType.name.localeCompare(b.workItemType.name, undefined, options) ||
    a.label.localeCompare(b.label, undefined, options) ||
    a.fieldName.localeCompare(b.fieldName, undefined, options) ||
    compareText(a.workItemType.referenceName, b.workItemType.referenceName) ||
    compareText(a.controlId, b.controlId)
  );
}

/**
 * The legacy controls that use the settings `holder` saves for its process. Changing what the
 * holder saves (moving it, or cleaning up its old settings) takes them away from these controls.
 * Only controls of the holder's own process count, so `controls` may span several processes.
 */
export function controlsUsingSavedConfiguration(
  controls: readonly LayoutControl[],
  holder: LayoutControl
): LayoutControl[] {
  if (!isHolder(holder)) {
    return [];
  }
  const key = nameKey(savedNameOf(holder));
  return controls
    .filter(
      (control) =>
        control !== holder &&
        control.processId === holder.processId &&
        controlStatus(control).kind === 'legacy' &&
        nameKey(referenceOf(control)) === key
    )
    .toSorted(compareControls);
}

/**
 * The inputs to send when a control is pointed at the configuration `name`: migratedInputs, so
 * old settings and passwords go. A control that still saves 3.0 settings other legacy controls
 * of its process use (see controlsUsingSavedConfiguration; `controls` is the layout scan) keeps
 * those shared settings, and what makes it save them, until they move: otherwise they'd lose
 * their settings. Its own credentials go either way, since 3.0 never shared them.
 */
export function assignmentInputs(
  control: LayoutControl,
  name: string,
  controls: readonly LayoutControl[]
): Record<string, string> {
  const inputs = migratedInputs(control, name);
  if (controlsUsingSavedConfiguration(controls, control).length === 0) {
    return inputs;
  }
  const kept: Record<string, string> = {
    ...pickSavedInputs(control.inputs),
    [INPUT_IDS.saveConfiguration]: 'true',
  };
  const savedName = text(control.inputs[INPUT_IDS.savedConfigurationName]).trim();
  if (savedName) {
    kept[INPUT_IDS.savedConfigurationName] = savedName;
  }
  return { ...kept, ...inputs };
}

/** The secrets a control could keep on its Options tab before 4.0. */
type LegacySecretKind = 'password' | 'token' | 'apiKey';

function legacySecretKind(method: AuthMethod): LegacySecretKind | null {
  switch (method) {
    case 'basic':
      return 'password';
    case 'bearer':
      return 'token';
    case 'apiKey':
      return 'apiKey';
    default:
      return null;
  }
}

/**
 * Settings written the way a configuration keeps them: the sign-in method by its label (left out
 * for None), and the user name only for Basic. Older controls inferred the method from the user
 * name and password, which a configuration no longer has, so it's spelled out.
 */
function canonicalSettings(
  settings: Record<string, string>,
  password = ''
): Record<string, string> {
  const auth = parseAuthMethod(
    settings[INPUT_IDS.authMethod] ?? '',
    settings[INPUT_IDS.username] ?? '',
    password
  );
  if (auth.error) {
    return settings;
  }
  const canonical = { ...settings };
  delete canonical[INPUT_IDS.authMethod];
  delete canonical[INPUT_IDS.username];
  if (auth.method !== 'none') {
    canonical[INPUT_IDS.authMethod] = AUTH_METHOD_LABELS[auth.method];
  }
  const username = settings[INPUT_IDS.username];
  if (auth.method === 'basic' && username !== undefined) {
    canonical[INPUT_IDS.username] = username;
  }
  return canonical;
}

function settingsKey(settings: Record<string, string>): string {
  return JSON.stringify(Object.entries(settings).toSorted(([a], [b]) => compareText(a, b)));
}

/**
 * Whether a stored configuration has the settings a migration group would give it (the group's
 * are already canonical): compared the way planMigration compares them to reuse one.
 */
export function hasGroupSettings(
  doc: Pick<ConfigurationDocument, 'settings'>,
  settings: Record<string, string>
): boolean {
  return settingsKey(canonicalSettings(doc.settings)) === settingsKey(settings);
}

type EntrySecret =
  { status: 'none' } | { status: 'ready'; secret: StoredSecret } | { status: 'needed' };

interface Holder {
  control: LayoutControl;
  name: string;
}

interface Entry {
  control: LayoutControl;
  settings: Record<string, string>;
  secret: EntrySecret;
  /** The kind of secret its sign-in method needs; null when none or unknown. */
  secretKind: SecretKind | null;
  /** The 3.0 saved configuration name it saves or uses. */
  source: string | null;
  holder: boolean;
  /** The control whose saved configuration it uses. */
  uses: LayoutControl | null;
  warnings: string[];
}

function secretKey(secret: EntrySecret): string {
  // Kept in memory only, to tell apart controls that sign in with different secrets.
  return secret.status === 'ready'
    ? `ready\u0000${secret.secret.kind}\u0000${'value' in secret.secret ? secret.secret.value : ''}`
    : secret.status;
}

function readEntry(
  control: LayoutControl,
  holdersByKey: ReadonlyMap<string, Holder[]>,
  processName: string
): Entry | MigrationProblem {
  const own = control.inputs;
  let effective: Record<string, unknown> = own;
  let source = isHolder(control) ? savedNameOf(control) : null;
  let uses: LayoutControl | null = null;
  const reference = referenceOf(control);
  if (reference) {
    const holders = holdersByKey.get(nameKey(reference)) ?? [];
    const [holder] = holders;
    if (!holder) {
      return {
        control,
        message: `${describeControl(control)} uses the saved configuration ${quoteName(reference)}, but no control in the ${processName} process saves it.`,
      };
    }
    if (holders.length > 1) {
      return {
        control,
        message: `${describeControl(control)} uses the saved configuration ${quoteName(reference)}, which more than one control saves: ${holders.map((item) => describeControl(item.control)).join(', ')}.`,
      };
    }
    // The 3.0 rules: the control's own non-empty settings win, credentials are its own.
    effective = mergeSavedInputs(own, pickSavedInputs(holder.control.inputs));
    source ??= holder.name;
    uses = holder.control === control ? null : holder.control;
  }

  const warnings: string[] = [];
  const explicit = text(effective[INPUT_IDS.authMethod]);
  const password = text(own[INPUT_IDS.password]);
  const auth = parseAuthMethod(explicit, text(effective[INPUT_IDS.username]), password);
  const picked = pickConfigurationSettings(effective);
  let secret: EntrySecret;
  let secretKind: LegacySecretKind | null = null;
  if (auth.error) {
    warnings.push(`${auth.error} Choose the sign-in method after moving, then enter the secret.`);
    secret = { status: 'needed' };
  } else if (auth.method === 'none') {
    secret = { status: 'none' };
    // Older controls signed in with Basic when only a password was filled in, which the layout
    // may leave out.
    if (!explicit.trim() && !Object.hasOwn(own, INPUT_IDS.password)) {
      warnings.push(
        'Azure DevOps doesn’t show whether this control signs in to its API, so it moves without signing in. If it did, choose its sign-in method and enter the secret after moving.'
      );
    }
  } else {
    secretKind = legacySecretKind(auth.method);
    secret =
      secretKind &&
      password &&
      !isMaskedValue(password) &&
      password.length <= SECRET_LIMITS.maxValueLength
        ? { status: 'ready', secret: { kind: secretKind, value: password } }
        : { status: 'needed' };
  }
  return {
    control,
    settings: canonicalSettings(picked, password),
    secret,
    secretKind,
    source,
    holder: isHolder(control),
    uses,
    warnings,
  };
}

interface Draft {
  entries: Entry[];
  name: string;
  existing: ConfigurationDocument | null;
}

function draftSource(draft: Draft): string | null {
  const holder = draft.entries.find((entry) => entry.holder);
  return holder?.source ?? draft.entries.find((entry) => entry.source)?.source ?? null;
}

function baseName(draft: Draft): string {
  const [first] = draft.entries;
  const candidates = [
    draftSource(draft),
    first?.control.label,
    first?.control.fieldName,
    first?.control.controlId,
  ];
  for (const candidate of candidates) {
    const name = candidate ? cleanConfigurationName(candidate) : '';
    if (name) {
      return name;
    }
  }
  return 'REST Picklist configuration';
}

function nameSuffix(attempt: number, typeSuffix: string): string {
  if (attempt === 0) {
    return '';
  }
  if (!typeSuffix) {
    return ` ${attempt + 1}`;
  }
  return attempt === 1 ? typeSuffix : `${typeSuffix} ${attempt}`;
}

/** The name, else with “ (Work item type)”, then also “ 2”, “ 3” and so on, until it's free. */
function uniqueName(base: string, workItemType: string, taken: ReadonlySet<string>): string {
  const type = cleanConfigurationName(workItemType);
  const typeSuffix = type ? ` (${shortenName(type, 40)})` : '';
  for (let attempt = 0; ; attempt += 1) {
    const suffix = nameSuffix(attempt, typeSuffix);
    const name = `${shortenName(base, CONFIGURATION_LIMITS.maxNameLength - suffix.length)}${suffix}`;
    if (!taken.has(nameKey(name))) {
      return name;
    }
  }
}

function groupSecret(draft: Draft): MigrationSecret {
  const [first] = draft.entries;
  if (!first || first.secret.status === 'none') {
    return { status: 'none' };
  }
  const stored = draft.existing?.secret;
  if (stored && (first.secretKind === null || stored.kind === first.secretKind)) {
    return { status: 'kept' };
  }
  return first.secret;
}

/**
 * Plans moving a process's legacy controls into configurations. `controls` is the process's
 * layout scan and `existing` the organization's configurations. Each legacy control's settings
 * are what it works with today: its own, combined with the 3.0 saved configuration it uses, plus
 * its own behavior options. Controls with the same settings and secret share a configuration,
 * reusing one of this process with the same settings when there is one. Deterministic: the same
 * layout and configurations always give the same plan.
 */
export function planMigration(
  process: { id: string; name: string },
  controls: readonly LayoutControl[],
  existing: readonly ConfigurationDocument[]
): MigrationPlan {
  const holdersByKey = new Map<string, Holder[]>();
  for (const control of controls.toSorted(compareControls)) {
    if (isHolder(control)) {
      const name = savedNameOf(control);
      const key = nameKey(name);
      holdersByKey.set(key, [...(holdersByKey.get(key) ?? []), { control, name }]);
    }
  }

  const legacy = controls
    .filter((control) => controlStatus(control).kind === 'legacy')
    .toSorted(compareControls);
  const problems: MigrationProblem[] = [];
  const movable = new Map<LayoutControl, Entry>();
  for (const control of legacy) {
    const entry = readEntry(control, holdersByKey, process.name);
    if ('message' in entry) {
      problems.push(entry);
    } else {
      movable.set(control, entry);
    }
  }

  // A control that saves settings stays while any control that uses them can't move, and that
  // can make the control whose settings it uses stay too.
  for (let changed = true; changed;) {
    changed = false;
    for (const [control, entry] of movable) {
      if (!entry.holder) {
        continue;
      }
      const waiting = controlsUsingSavedConfiguration(legacy, control).filter(
        (user) => !movable.has(user)
      );
      if (waiting.length > 0) {
        movable.delete(control);
        problems.push({
          control,
          message: `${describeControl(control)} saves ${quoteName(savedNameOf(control))} for controls that can’t move yet (${waiting.map(describeControl).join(', ')}), so it stays until they can.`,
        });
        changed = true;
      }
    }
  }

  const drafts: Draft[] = [];
  const draftsByKey = new Map<string, Draft>();
  for (const entry of movable.values()) {
    const key = `${settingsKey(entry.settings)}\u0000${secretKey(entry.secret)}`;
    let draft = draftsByKey.get(key);
    if (!draft) {
      draft = { entries: [], name: '', existing: null };
      draftsByKey.set(key, draft);
      drafts.push(draft);
    }
    draft.entries.push(entry);
  }

  const shared = configurationsForProcess(existing, process.id);
  const reused = new Set<string>();
  const taken = new Set<string>();
  for (const doc of shared) {
    taken.add(nameKey(doc.name));
    for (const alias of doc.aliases) {
      taken.add(nameKey(alias));
    }
  }
  for (const draft of drafts) {
    const settings = settingsKey(draft.entries[0]?.settings ?? {});
    // Controls whose own secret could be read don't take over a configuration that keeps a
    // secret already: the two may differ, and the controls would sign in as someone else. They
    // get a configuration of their own instead.
    const ownSecret = draft.entries[0]?.secret.status === 'ready';
    const match = shared.find(
      (doc) =>
        !reused.has(doc.id) &&
        !(ownSecret && doc.secret) &&
        settingsKey(canonicalSettings(doc.settings)) === settings
    );
    if (match) {
      reused.add(match.id);
      draft.existing = match;
      draft.name = match.name;
    }
  }
  // Groups with the control that saves a 3.0 configuration are named first, so the new
  // configuration keeps the name the other controls know it by.
  const naming = [
    ...drafts.filter((draft) => draft.entries.some((entry) => entry.holder)),
    ...drafts.filter((draft) => !draft.entries.some((entry) => entry.holder)),
  ];
  for (const draft of naming) {
    if (draft.existing) {
      continue;
    }
    draft.name = uniqueName(
      baseName(draft),
      draft.entries[0]?.control.workItemType.name ?? '',
      taken
    );
    taken.add(nameKey(draft.name));
  }

  const groups: MigrationGroup[] = drafts.map((draft) => ({
    name: draft.name,
    existing: draft.existing,
    settings: { ...draft.entries[0]?.settings },
    secret: groupSecret(draft),
    savedConfigurationName: draftSource(draft),
    controls: draft.entries.map((entry) => entry.control),
  }));
  const groupOf = new Map<LayoutControl, number>();
  drafts.forEach((draft, index) => {
    for (const entry of draft.entries) {
      groupOf.set(entry.control, index);
    }
  });

  // Controls that use a 3.0 saved configuration move before the control that saves it.
  const usersOf = new Map<LayoutControl, LayoutControl[]>();
  for (const entry of movable.values()) {
    if (entry.uses && movable.has(entry.uses)) {
      usersOf.set(entry.uses, [...(usersOf.get(entry.uses) ?? []), entry.control]);
    }
  }
  const remaining = [...movable.values()];
  const placed = new Set<LayoutControl>();
  const steps: MigrationStep[] = [];
  while (remaining.length > 0) {
    let index = remaining.findIndex((entry) =>
      (usersOf.get(entry.control) ?? []).every((user) => placed.has(user))
    );
    // Controls that use each other's saved settings: take them in order.
    if (index < 0) {
      index = 0;
    }
    const [entry] = remaining.splice(index, 1);
    if (!entry) {
      break;
    }
    placed.add(entry.control);
    steps.push({
      control: entry.control,
      group: groupOf.get(entry.control) ?? 0,
      usedBy: (usersOf.get(entry.control) ?? []).filter((user) => placed.has(user)),
      warnings: entry.warnings,
    });
  }

  return {
    processId: process.id,
    processName: process.name,
    groups,
    steps,
    problems: problems.toSorted((a, b) => compareControls(a.control, b.control)),
  };
}
