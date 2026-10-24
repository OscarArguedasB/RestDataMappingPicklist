import { CONFIGURATION_SETTING_IDS, INPUT_IDS, pickConfigurationSettings } from './config';
import { PicklistError } from './errors';
import type { SecretSummary } from './secrets';
import { parseSecretSummary } from './secrets';
import { isPlainObject } from './values';

// A configuration holds the settings for one API: where to call, how to sign in (never the secret
// itself, see secrets.ts), how to read the response and how the field behaves. Configurations live
// in the organization's extension data and are shared with one or more processes, so they're
// managed in one place (Organization settings › Extensions › REST Picklist) instead of on each
// control. Any member of the organization can read and write that data through the API, so every
// document is checked before it's used, and the permission rules below are a guard rail kept by
// the setup page: Azure DevOps only enforces them when a process layout changes.

export const CONFIGURATIONS_COLLECTION = 'configurations';

export const CONFIGURATION_LIMITS = {
  maxNameLength: 100,
  /** Former names kept after renaming, newest first. */
  maxAliases: 5,
  /** Characters in one setting. Real ones, even long field maps, are far shorter. */
  maxSettingLength: 20_000,
  /** Processes one configuration can be shared with; more is treated as tampered with. */
  maxProcesses: 1000,
  /** Extension data allows document ids of up to 50 characters. */
  maxIdLength: 50,
  /** Names in the “changed by” stamps. */
  maxStampLength: 200,
} as const;

/** One document in the "configurations" collection. */
export interface ConfigurationDocument {
  /** A random UUID; also the id of its secret in the "secrets" collection. */
  id: string;
  /** Set by the extension data service; saving with an older one is refused. */
  __etag?: number;
  version: 1;
  name: string;
  /** Former names, newest first, so controls that still use one keep working. */
  aliases: string[];
  /** Type ids of the processes it's shared with; at least one. */
  processIds: string[];
  /** Keys from CONFIGURATION_SETTING_IDS only; flags are "true" or left out. */
  settings: Record<string, string>;
  /** What may be shown about the stored secret; null when none is stored. */
  secret: SecretSummary | null;
  createdBy?: string;
  /** ISO 8601. */
  createdAt?: string;
  updatedBy?: string;
  /** ISO 8601. */
  updatedAt?: string;
}

const DOCUMENT_ID = /^[A-Za-z0-9_-]+$/;
const PROCESS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// Line breaks, other control characters and invisible direction marks, which could make one name
// look like another.
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ALL_CONTROL_CHARACTERS = new RegExp(CONTROL_CHARACTERS.source, 'gu');
// Enough to find a configuration's few former names in a document that has been tampered with.
const MAX_ALIASES_READ = 100;
const MAX_LISTED_NAMES = 10;

/** Whether text has line breaks, other control characters or direction marks; names can't. */
export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

/** How names are compared: ignoring case and surrounding spaces, in Unicode's composed form. */
export function nameKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * Text made usable as a name, such as a control's label: control characters become spaces, runs
 * of spaces become one, and long text is cut to the maximum length. May return ''.
 */
export function cleanConfigurationName(value: string): string {
  return shortenName(
    value.normalize('NFC').replace(ALL_CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim(),
    CONFIGURATION_LIMITS.maxNameLength
  );
}

/** Cuts text to `maxLength` UTF-16 units without splitting a character, then trims the end. */
export function shortenName(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const cut = value.slice(0, Math.max(0, maxLength));
  // Don't leave half of a surrogate pair (most emoji) at the end.
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

function shortened(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 100 ? `${shortenName(trimmed, 99)}…` : trimmed;
}

/** A name in quotes for messages, shortened when it's very long. */
export function quoteName(name: string): string {
  return `“${shortened(name)}”`;
}

function processLabel(processName: string): string {
  return processName.trim() ? `the ${shortened(processName)} process` : 'this process';
}

/** Why a configuration name can't be used, or null when it can. */
export function validateConfigurationName(name: string): string | null {
  const trimmed = name.normalize('NFC').trim();
  if (!trimmed) {
    return 'Enter a name for the configuration.';
  }
  if (trimmed.length > CONFIGURATION_LIMITS.maxNameLength) {
    return `A name can be up to ${CONFIGURATION_LIMITS.maxNameLength} characters.`;
  }
  if (hasControlCharacters(trimmed)) {
    return 'A name can’t contain line breaks or other control characters.';
  }
  return null;
}

/** The name as it's stored: trimmed and composed. Throws when it can't be used. */
function checkedName(name: string): string {
  const problem = validateConfigurationName(name);
  if (problem) {
    throw new PicklistError('config', problem);
  }
  return name.normalize('NFC').trim();
}

function parseName(value: unknown): string | null {
  return typeof value === 'string' && !validateConfigurationName(value)
    ? value.normalize('NFC').trim()
    : null;
}

function parseAliases(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const aliases: string[] = [];
  const seen = new Set([nameKey(name)]);
  for (const entry of value.slice(0, MAX_ALIASES_READ)) {
    const alias = parseName(entry);
    if (alias === null || seen.has(nameKey(alias))) {
      continue;
    }
    seen.add(nameKey(alias));
    aliases.push(alias);
    if (aliases.length === CONFIGURATION_LIMITS.maxAliases) {
      break;
    }
  }
  return aliases;
}

function parseProcessIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > CONFIGURATION_LIMITS.maxProcesses) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (PROCESS_ID.test(id) && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Known settings with text values, as a configuration keeps them. Anything else is dropped,
 * including credentials, values that aren't text and inherited keys.
 */
function parseSettings(value: Record<string, unknown>): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const id of CONFIGURATION_SETTING_IDS) {
    const setting = Object.hasOwn(value, id) ? value[id] : undefined;
    if (typeof setting === 'string' && setting.length <= CONFIGURATION_LIMITS.maxSettingLength) {
      strings[id] = setting;
    }
  }
  return pickConfigurationSettings(strings);
}

function parseStamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed &&
    trimmed.length <= CONFIGURATION_LIMITS.maxStampLength &&
    !hasControlCharacters(trimmed)
    ? trimmed
    : undefined;
}

function parseDate(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_DATE.test(value) ? value : undefined;
}

/** Whether `value` can be a document id: what the extension data service accepts, nothing odd. */
export function isConfigurationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CONFIGURATION_LIMITS.maxIdLength &&
    DOCUMENT_ID.test(value)
  );
}

/**
 * Reads a document from the "configurations" collection. Anyone in the organization can write
 * there, so only what's understood is kept: known settings with text values, valid names and
 * former names, process ids, and a secret summary that checks out (or none). Returns null for
 * anything that can't be a configuration.
 */
export function parseConfigurationDocument(value: unknown): ConfigurationDocument | null {
  if (!isPlainObject(value) || !isConfigurationId(value.id) || value.version !== 1) {
    return null;
  }
  const name = parseName(value.name);
  const processIds = parseProcessIds(value.processIds);
  if (name === null || processIds.length === 0 || !isPlainObject(value.settings)) {
    return null;
  }
  const document: ConfigurationDocument = {
    id: value.id,
    version: 1,
    name,
    aliases: parseAliases(value.aliases, name),
    processIds,
    settings: parseSettings(value.settings),
    // A summary that doesn't check out is shown as no secret; the secret itself is checked again
    // when it's read.
    secret: parseSecretSummary(value.secret),
  };
  if (typeof value.__etag === 'number' && Number.isFinite(value.__etag)) {
    document.__etag = value.__etag;
  }
  const createdBy = parseStamp(value.createdBy);
  const createdAt = parseDate(value.createdAt);
  const updatedBy = parseStamp(value.updatedBy);
  const updatedAt = parseDate(value.updatedAt);
  if (createdBy) {
    document.createdBy = createdBy;
  }
  if (createdAt) {
    document.createdAt = createdAt;
  }
  if (updatedBy) {
    document.updatedBy = updatedBy;
  }
  if (updatedAt) {
    document.updatedAt = updatedAt;
  }
  return document;
}

/** A random id for a new configuration (and its secret). */
export function newConfigurationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * A new, unsaved configuration. Throws a PicklistError when the name can't be used or no process
 * is given. Settings go through pickConfigurationSettings, so credentials are never kept.
 */
export function createConfigurationDocument(init: {
  name: string;
  processIds: readonly string[];
  settings?: Record<string, unknown>;
  id?: string;
}): ConfigurationDocument {
  const name = checkedName(init.name);
  const processIds = parseProcessIds(init.processIds);
  if (processIds.length === 0) {
    throw new PicklistError('config', 'Share the configuration with at least one process.');
  }
  const id = init.id ?? newConfigurationId();
  if (!isConfigurationId(id)) {
    throw new PicklistError('config', 'This configuration’s id isn’t valid.');
  }
  return {
    id,
    version: 1,
    name,
    aliases: [],
    processIds,
    settings: pickConfigurationSettings(init.settings ?? {}),
    secret: null,
  };
}

/**
 * A copy under a new name and id, not saved yet. It keeps the secret summary: copy the secret
 * document too (configurationStore's copySecret), or clear `secret` when that isn't possible.
 */
export function duplicateConfiguration(
  doc: ConfigurationDocument,
  name: string
): ConfigurationDocument {
  return {
    id: newConfigurationId(),
    version: 1,
    name: checkedName(name),
    aliases: [],
    processIds: [...doc.processIds],
    settings: { ...doc.settings },
    secret: doc.secret ? { ...doc.secret } : null,
  };
}

/**
 * Renames a configuration, keeping the old name as a former name (newest first, at most five) so
 * controls that still use it keep working. Renaming back to a former name takes it off the list,
 * and changing only the capitalization keeps the list as it is. Throws a PicklistError when the
 * new name can't be used; it doesn't check other configurations (see findNameConflicts).
 */
export function renameConfiguration(
  doc: ConfigurationDocument,
  newName: string
): ConfigurationDocument {
  const name = checkedName(newName);
  const newKey = nameKey(name);
  if (newKey === nameKey(doc.name)) {
    return { ...doc, name };
  }
  const aliases: string[] = [];
  for (const alias of [doc.name, ...doc.aliases]) {
    const key = nameKey(alias);
    if (key !== newKey && !aliases.some((kept) => nameKey(kept) === key)) {
      aliases.push(alias);
    }
  }
  return { ...doc, name, aliases: aliases.slice(0, CONFIGURATION_LIMITS.maxAliases) };
}

/** Stops answering to a former name. Controls that still use it will need another name. */
export function forgetAlias(doc: ConfigurationDocument, alias: string): ConfigurationDocument {
  const key = nameKey(alias);
  return { ...doc, aliases: doc.aliases.filter((existing) => nameKey(existing) !== key) };
}

function compareByName(a: ConfigurationDocument, b: ConfigurationDocument): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
    a.name.localeCompare(b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Sorted by name, for stable lists. */
export function sortConfigurations(
  docs: readonly ConfigurationDocument[]
): ConfigurationDocument[] {
  return docs.toSorted(compareByName);
}

/** The configurations shared with a process, sorted by name. */
export function configurationsForProcess(
  docs: readonly ConfigurationDocument[],
  processId: string
): ConfigurationDocument[] {
  return sortConfigurations(docs.filter((doc) => doc.processIds.includes(processId)));
}

/** A configuration being named or shared, checked against the others by findNameConflicts. */
export interface NameCandidate {
  /** Its own id, so it isn't compared with itself; leave it out for a new configuration. */
  id?: string;
  name: string;
  aliases?: readonly string[];
  processIds: readonly string[];
}

export interface NameConflict {
  /** The candidate's name, or one of its former names, that's already taken. */
  name: string;
  /** The other configuration that answers to it. */
  configuration: ConfigurationDocument;
  /** True when it's one of the other configuration's former names. */
  formerName: boolean;
  /** The processes both are shared with, where the names would clash. */
  processIds: string[];
}

/**
 * Where the candidate's name or former names are already used by another configuration in a
 * process both are shared with. Names are unique per process, former names included, so a control
 * that uses a name always finds exactly one configuration.
 */
export function findNameConflicts(
  docs: readonly ConfigurationDocument[],
  candidate: NameCandidate
): NameConflict[] {
  const names = [candidate.name, ...(candidate.aliases ?? [])].filter((name) => nameKey(name));
  const conflicts: NameConflict[] = [];
  for (const doc of docs) {
    if (candidate.id !== undefined && doc.id === candidate.id) {
      continue;
    }
    const processIds = doc.processIds.filter((id) => candidate.processIds.includes(id));
    if (processIds.length === 0) {
      continue;
    }
    for (const name of names) {
      const key = nameKey(name);
      if (nameKey(doc.name) === key) {
        conflicts.push({ name, configuration: doc, formerName: false, processIds });
      } else if (doc.aliases.some((alias) => nameKey(alias) === key)) {
        conflicts.push({ name, configuration: doc, formerName: true, processIds });
      }
    }
  }
  return conflicts;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join('');
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Explains a name conflict. `processName` turns a process id into its name. */
export function nameConflictMessage(
  conflict: NameConflict,
  processName: (processId: string) => string | undefined
): string {
  const names = conflict.processIds
    .map((id) => processName(id)?.trim())
    .filter((name): name is string => Boolean(name));
  const where =
    names.length === 0
      ? 'a process they share'
      : names.length === 1
        ? `the ${names[0]} process`
        : `the ${joinNames(names)} processes`;
  if (conflict.formerName) {
    return `${quoteName(conflict.name)} is a former name of ${quoteName(conflict.configuration.name)} in ${where}, and controls may still use it. Choose another name, or have ${quoteName(conflict.configuration.name)} forget it.`;
  }
  return `${quoteName(conflict.name)} is already the name of another configuration in ${where}. Choose another name.`;
}

function listNames(docs: readonly ConfigurationDocument[]): string {
  if (docs.length === 0) {
    return ' No configurations are shared with it yet.';
  }
  const shown = docs.slice(0, MAX_LISTED_NAMES).map((doc) => quoteName(doc.name));
  const more = docs.length > MAX_LISTED_NAMES ? ` and ${docs.length - MAX_LISTED_NAMES} more` : '';
  return ` Available: ${shown.join(', ')}${more}.`;
}

/**
 * The configuration a control uses: the one shared with the work item's process whose name, or
 * else one of its former names, matches (ignoring case). Throws a PicklistError that lists the
 * available names when there's none or more than one.
 */
export function findConfigurationForProcess(
  docs: readonly ConfigurationDocument[],
  processId: string,
  processName: string,
  name: string
): ConfigurationDocument {
  const wanted = nameKey(name);
  if (!wanted) {
    throw new PicklistError('config', 'Enter the name of a configuration.');
  }
  const shared = configurationsForProcess(docs, processId);
  const byName = shared.filter((doc) => nameKey(doc.name) === wanted);
  const matches =
    byName.length > 0
      ? byName
      : shared.filter((doc) => doc.aliases.some((alias) => nameKey(alias) === wanted));
  const [first] = matches;
  if (first && matches.length === 1) {
    return first;
  }
  const where = processLabel(processName);
  if (matches.length > 1) {
    throw new PicklistError(
      'config',
      `More than one configuration shared with ${where} answers to ${quoteName(name)}: ${matches
        .slice(0, MAX_LISTED_NAMES)
        .map((doc) => quoteName(doc.name))
        .join(', ')}. Rename one of them in Organization settings › Extensions › REST Picklist.`
    );
  }
  const elsewhere = docs.some(
    (doc) =>
      !doc.processIds.includes(processId) &&
      (nameKey(doc.name) === wanted || doc.aliases.some((alias) => nameKey(alias) === wanted))
  );
  if (elsewhere) {
    throw new PicklistError(
      'config',
      `The configuration ${quoteName(name)} isn’t shared with ${where}.${listNames(shared)}`
    );
  }
  throw new PicklistError(
    'config',
    `No configuration named ${quoteName(name)} is shared with ${where}.${listNames(shared)}`
  );
}

// ---- Permissions ----

/**
 * What the signed-in user may change, from one permission check when the setup page opens.
 * `editableProcessIds` holds the processes the user has "Edit process" permission on.
 */
export interface PermissionSnapshot {
  /** Project Collection Administrators and others with write access to the collection. */
  collectionAdmin: boolean;
  editableProcessIds: ReadonlySet<string>;
  /**
   * Why the check failed, ready to show: Azure DevOps couldn't be reached or had a problem. While
   * it's set, everything is read-only, and trying again may help.
   */
  error: string | null;
  /**
   * Set, ready to show, when Azure DevOps refused the check itself (401 or 403): the extension
   * may not be allowed to ask, for anyone, so trying again won't help. Configurations shared with
   * a process stay editable, since Azure DevOps still checks Edit process whenever a process's
   * controls change. What's meant for Project Collection Administrators only (the security
   * policy, and configurations no process uses) stays read-only until the check works.
   */
  unverified?: string | null;
}

/** Nothing may be changed: before the check completes, and in tests. */
export const READ_ONLY_PERMISSIONS: PermissionSnapshot = {
  collectionAdmin: false,
  editableProcessIds: new Set<string>(),
  error: null,
};

/** The text shown when the permission check fails; `reason` is short, like “Azure DevOps answered 500”. */
export function permissionErrorMessage(reason: string): string {
  return `Couldn’t check your permissions (${reason}). Editing is turned off until it works.`;
}

/** The text shown when Azure DevOps refuses the permission check; see PermissionSnapshot.unverified. */
export function permissionUnverifiedMessage(reason: string): string {
  return `Couldn’t verify your permissions (${reason}), so editing configurations isn’t limited here. Azure DevOps still checks Edit process permission when a process’s controls change, so only change what you’re responsible for. The security policy and configurations no process uses stay read-only until the check works.`;
}

/**
 * True when the check was refused (see PermissionSnapshot.unverified): every process's
 * configurations may be edited, but nothing meant for administrators only.
 */
export function permissionsUnverified(snapshot: PermissionSnapshot): boolean {
  return snapshot.error === null && Boolean(snapshot.unverified);
}

/**
 * Project Collection Administrators only, as the check said: what's meant for administrators,
 * like the security policy and configurations no process uses. Never granted while the check is
 * refused or failed.
 */
export function canManageAll(snapshot: PermissionSnapshot): boolean {
  return snapshot.error === null && snapshot.collectionAdmin;
}

/** Whether the user may change a process's configurations and controls. */
export function canEditProcess(snapshot: PermissionSnapshot, processId: string): boolean {
  return (
    canManageAll(snapshot) ||
    permissionsUnverified(snapshot) ||
    (snapshot.error === null && snapshot.editableProcessIds.has(processId))
  );
}

/** Creating a configuration in a process, or assigning and moving its controls. */
export function canCreateIn(snapshot: PermissionSnapshot, processId: string): boolean {
  return canEditProcess(snapshot, processId);
}

/** Changing a configuration's settings, name or credentials: any process it's shared with will do. */
export function canEditConfiguration(
  snapshot: PermissionSnapshot,
  doc: Pick<ConfigurationDocument, 'processIds'>
): boolean {
  return canManageAll(snapshot) || doc.processIds.some((id) => canEditProcess(snapshot, id));
}

/** Sharing a configuration with another process needs both the configuration and that process. */
export function canShareWith(
  snapshot: PermissionSnapshot,
  doc: Pick<ConfigurationDocument, 'processIds'>,
  processId: string
): boolean {
  return canEditConfiguration(snapshot, doc) && canEditProcess(snapshot, processId);
}

/**
 * Stopping sharing with a process needs that process, and the configuration has to stay shared
 * with another one: taking the last one away is deleting it.
 *
 * With `knownProcessIds` (the processes that exist now), a process that was deleted can be
 * dropped by anyone who may edit the configuration, since nobody has Edit process on it any
 * more; and only processes that still exist count as the one it stays shared with.
 */
export function canUnshareFrom(
  snapshot: PermissionSnapshot,
  doc: Pick<ConfigurationDocument, 'processIds'>,
  processId: string,
  knownProcessIds?: ReadonlySet<string>
): boolean {
  const gone = knownProcessIds !== undefined && !knownProcessIds.has(processId);
  const staysShared = knownProcessIds
    ? doc.processIds.some((id) => id !== processId && knownProcessIds.has(id))
    : doc.processIds.length > 1;
  return (
    (gone ? canEditConfiguration(snapshot, doc) : canEditProcess(snapshot, processId)) &&
    doc.processIds.includes(processId) &&
    staysShared
  );
}

/**
 * Deleting a configuration needs every process it's shared with, since they all lose it. With
 * `knownProcessIds`, processes that were deleted don't count: nobody can have Edit process on
 * them. A configuration shared with no process that exists is for administrators to clean up.
 */
export function canDeleteConfiguration(
  snapshot: PermissionSnapshot,
  doc: Pick<ConfigurationDocument, 'processIds'>,
  knownProcessIds?: ReadonlySet<string>
): boolean {
  const live = knownProcessIds
    ? doc.processIds.filter((id) => knownProcessIds.has(id))
    : doc.processIds;
  return (
    canManageAll(snapshot) || (live.length > 0 && live.every((id) => canEditProcess(snapshot, id)))
  );
}

/** The security policy applies to the whole organization. */
export function canEditPolicy(snapshot: PermissionSnapshot): boolean {
  return canManageAll(snapshot);
}

// ---- Export and import ----

export const FILE_FORMAT = 'rest-picklist-configurations';
export const FILE_LIMITS = {
  maxBytes: 1024 * 1024,
  maxConfigurations: 200,
  maxNameLength: 100,
  maxSourceLength: 200,
} as const;

/** One configuration in an exported file, or read from one. Never credentials. */
export interface ConfigurationFileEntry {
  name: string;
  /** Where it came from, such as the processes it was shared with; informational. */
  source?: string;
  settings: Record<string, string>;
}

/** What 4.0 exports. 3.0 wrote version 1, with `inputs` instead of `settings`. */
export interface ConfigurationFileV2 {
  format: typeof FILE_FORMAT;
  version: 2;
  exportedAt: string;
  configurations: ConfigurationFileEntry[];
}

/**
 * Settings that travel in files: all of a configuration's settings except the user name, which,
 * like passwords, tokens and keys, exported files have never contained.
 */
const FILE_SETTING_IDS: readonly string[] = CONFIGURATION_SETTING_IDS.filter(
  (id) => id !== INPUT_IDS.username
);

const FLAG_SETTING_IDS: ReadonlySet<string> = new Set([
  INPUT_IDS.allowMultiple,
  INPUT_IDS.loadOnFormOpen,
  INPUT_IDS.required,
]);

function fileSettings(settings: Record<string, unknown>): Record<string, string> {
  const picked = pickConfigurationSettings(settings);
  const kept: Record<string, string> = {};
  for (const id of FILE_SETTING_IDS) {
    const value = picked[id];
    if (value !== undefined) {
      kept[id] = value;
    }
  }
  return kept;
}

/** A JSON file with each configuration's settings. Credentials and user names are never included. */
export function exportConfigurationFile(
  items: ReadonlyArray<{ name: string; source?: string; settings: Record<string, unknown> }>,
  now: Date = new Date()
): string {
  if (items.length > FILE_LIMITS.maxConfigurations) {
    throw new PicklistError(
      'config',
      `Export up to ${FILE_LIMITS.maxConfigurations} configurations at a time.`
    );
  }
  const file: ConfigurationFileV2 = {
    format: FILE_FORMAT,
    version: 2,
    exportedAt: now.toISOString(),
    configurations: items.map((item) => {
      const source = item.source?.trim().slice(0, FILE_LIMITS.maxSourceLength);
      return {
        name: item.name.trim(),
        ...(source ? { source } : {}),
        settings: fileSettings(item.settings),
      };
    }),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Whether text is over the file size limit in UTF-8. */
export function isLargerThanFileLimit(content: string): boolean {
  // Characters never outnumber UTF-8 bytes, so only count bytes when it could matter.
  return (
    content.length > FILE_LIMITS.maxBytes ||
    (content.length * 3 > FILE_LIMITS.maxBytes &&
      new TextEncoder().encode(content).length > FILE_LIMITS.maxBytes)
  );
}

const NOT_A_CONFIGURATION_FILE = 'This isn’t a REST Picklist configuration file.';

function fail(error: string): { configurations: ConfigurationFileEntry[]; error: string } {
  return { configurations: [], error };
}

/**
 * Reads an exported file: version 2 from 4.0 (`settings`), version 1 from 3.0 (`inputs`), or a
 * single `{ "name": …, "settings": { … } }` or `{ "name": …, "inputs": { … } }` object. Only
 * settings a file may carry are kept: credentials, user names and unknown keys are ignored, and
 * anything malformed is an error.
 */
export function parseConfigurationFile(content: string): {
  configurations: ConfigurationFileEntry[];
  error: string | null;
} {
  if (isLargerThanFileLimit(content)) {
    return fail('This file is larger than 1 MB.');
  }
  let data: unknown;
  try {
    data = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    return fail('This file isn’t valid JSON.');
  }
  if (!isPlainObject(data)) {
    return fail(NOT_A_CONFIGURATION_FILE);
  }
  let entries: unknown[];
  let namesRequired: boolean;
  let settingsKey: 'inputs' | 'settings';
  if (data.format !== undefined) {
    if (data.format !== FILE_FORMAT) {
      return fail(NOT_A_CONFIGURATION_FILE);
    }
    if (typeof data.version === 'number' && data.version > 2) {
      return fail(
        'This file was made by a newer version of REST Picklist. Update the extension and try again.'
      );
    }
    if ((data.version !== 1 && data.version !== 2) || !Array.isArray(data.configurations)) {
      return fail(NOT_A_CONFIGURATION_FILE);
    }
    entries = data.configurations;
    namesRequired = true;
    settingsKey = data.version === 1 ? 'inputs' : 'settings';
  } else if (isPlainObject(data.settings) || isPlainObject(data.inputs)) {
    entries = [data];
    namesRequired = false;
    settingsKey = isPlainObject(data.settings) ? 'settings' : 'inputs';
  } else {
    return fail(NOT_A_CONFIGURATION_FILE);
  }
  if (entries.length === 0) {
    return fail('This file has no configurations.');
  }
  if (entries.length > FILE_LIMITS.maxConfigurations) {
    return fail(
      `This file has ${entries.length} configurations. Import up to ${FILE_LIMITS.maxConfigurations} at a time.`
    );
  }

  const configurations: ConfigurationFileEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const position = `Configuration ${index + 1}`;
    if (!isPlainObject(entry)) {
      return fail(`${position} isn’t an object.`);
    }
    if (entry.name !== undefined && entry.name !== null && typeof entry.name !== 'string') {
      return fail(`${position}: “name” must be text.`);
    }
    const name = typeof entry.name === 'string' ? entry.name.normalize('NFC').trim() : '';
    if (namesRequired && !name) {
      return fail(`${position} has no name.`);
    }
    if (name.length > FILE_LIMITS.maxNameLength) {
      return fail(`${position}: names can be up to ${FILE_LIMITS.maxNameLength} characters.`);
    }
    if (hasControlCharacters(name)) {
      return fail(`${position}: the name can’t contain line breaks or control characters.`);
    }
    const label = name ? quoteName(name) : position;
    if (name) {
      if (seen.has(nameKey(name))) {
        return fail(`${label} appears more than once in this file.`);
      }
      seen.add(nameKey(name));
    }
    const raw = entry[settingsKey];
    if (!isPlainObject(raw)) {
      return fail(`${label} has no “${settingsKey}” object.`);
    }
    const values: Record<string, unknown> = {};
    for (const id of FILE_SETTING_IDS) {
      const value = Object.hasOwn(raw, id) ? raw[id] : undefined;
      if (value === undefined || value === null) {
        continue;
      }
      // Checkboxes may have been written as true or false by hand.
      if (typeof value !== 'string' && !(FLAG_SETTING_IDS.has(id) && typeof value === 'boolean')) {
        return fail(`${label}: “${id}” must be text.`);
      }
      if (typeof value === 'string' && value.length > CONFIGURATION_LIMITS.maxSettingLength) {
        return fail(
          `${label}: “${id}” can be up to ${CONFIGURATION_LIMITS.maxSettingLength.toLocaleString('en-US')} characters.`
        );
      }
      values[id] = value;
    }
    const settings = fileSettings(values);
    if (Object.keys(settings).length === 0) {
      return fail(`${label} has no settings to import.`);
    }
    const source =
      typeof entry.source === 'string'
        ? entry.source.trim().slice(0, FILE_LIMITS.maxSourceLength)
        : '';
    configurations.push({ name, ...(source ? { source } : {}), settings });
  }
  return { configurations, error: null };
}
