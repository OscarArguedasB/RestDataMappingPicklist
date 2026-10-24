import { INPUT_IDS, SAVED_INPUT_IDS, pickSavedInputs } from '../core/config';
import { nameKey, quoteName } from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { WorkItemTypeRef } from '../core/migration';
import { isPlainObject, scalarToString } from '../core/values';
import type { SessionStore } from './extensionData';
import { defaultSessionStore, readSessionCache, writeSessionCache } from './extensionData';
import { savedConfigurationsCacheKey, scanProcessControls } from './layout';
import { processForProject } from './processes';
import type { DevOpsApi } from './rest';

// Before 4.0, a saved configuration was one of this extension's controls in the process layout
// whose Options have "Save as a reusable configuration" checked; other controls of the process
// used it by name. Controls set up that way keep working until they're moved to a configuration
// (see core/migration.ts), so the form control still resolves them here.

// Enough for any real process; a larger cached list is treated as tampered with.
const MAX_CACHED_CONFIGURATIONS = 2000;
const MAX_LISTED_NAMES = 10;
const MAX_LISTED_SOURCES = 5;

export interface SavedConfiguration {
  name: string;
  processId: string;
  processName: string;
  workItemType: WorkItemTypeRef;
  groupId: string;
  controlId: string;
  /** The control's label in the layout; may be empty. */
  label: string;
  fieldName: string;
  /** Where it's saved, like “Bug › Customer”. */
  source: string;
  /** The shared settings: pickSavedInputs(...), so never credentials. */
  inputs: Record<string, string>;
  /** The layout control exactly as Azure DevOps returned it. */
  control: Record<string, unknown>;
}

export interface SavedConfigurationScan {
  /** Sorted by name. */
  configurations: SavedConfiguration[];
}

function text(value: unknown): string {
  return scalarToString(value)?.trim() ?? '';
}

function flag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/** Saved inputs that are non-empty strings; anything else, including credentials, is dropped. */
function savedStringInputs(inputs: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const id of SAVED_INPUT_IDS) {
    const value = inputs[id];
    if (typeof value === 'string' && value.trim()) {
      picked[id] = value;
    }
  }
  return picked;
}

export async function scanSavedConfigurations(
  api: DevOpsApi,
  process: { id: string; name: string }
): Promise<SavedConfigurationScan> {
  const configurations: SavedConfiguration[] = [];
  for (const found of await scanProcessControls(api, process)) {
    const { workItemType, groupId, controlId, control, inputs, label, fieldName } = found;
    if (flag(inputs[INPUT_IDS.saveConfiguration])) {
      configurations.push({
        name: text(inputs[INPUT_IDS.savedConfigurationName]) || label || fieldName || controlId,
        processId: process.id,
        processName: process.name,
        workItemType,
        groupId,
        controlId,
        label,
        fieldName,
        source: `${workItemType.name} › ${label || fieldName || controlId}`,
        inputs: pickSavedInputs(inputs),
        control,
      });
    }
  }
  configurations.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
      a.source.localeCompare(b.source)
  );
  return { configurations };
}

function pickByName<T extends { name: string; source: string }>(
  items: readonly T[],
  name: string
): T {
  const wanted = nameKey(name);
  if (!wanted) {
    throw new PicklistError('config', 'Enter the name of a saved configuration.');
  }
  const matches = items.filter((item) => nameKey(item.name) === wanted);
  const [first] = matches;
  if (first && matches.length === 1) {
    return first;
  }
  if (matches.length > 1) {
    const sources = matches.slice(0, MAX_LISTED_SOURCES).map((item) => item.source);
    const more =
      matches.length > MAX_LISTED_SOURCES ? ` and ${matches.length - MAX_LISTED_SOURCES} more` : '';
    throw new PicklistError(
      'config',
      `${quoteName(name)} is saved by more than one control: ${sources.join(', ')}${more}. Give each one a unique name.`
    );
  }
  const available = [...new Set(items.map((item) => item.name))];
  let hint = '';
  if (available.length === 0) {
    hint = ' This process has no saved configurations yet.';
  } else if (available.length <= MAX_LISTED_NAMES) {
    hint = ` Available: ${available.map(quoteName).join(', ')}.`;
  }
  throw new PicklistError(
    'config',
    `No saved configuration named ${quoteName(name)} in this process.${hint}`
  );
}

/** Finds a saved configuration by name, ignoring case. */
export function findSavedConfiguration(
  scan: SavedConfigurationScan,
  name: string
): SavedConfiguration {
  return pickByName(scan.configurations, name);
}

// ---- Resolving a saved configuration for a form control ----

interface CachedConfiguration {
  name: string;
  source: string;
  inputs: Record<string, string>;
}

function parseCachedScan(data: unknown): CachedConfiguration[] | null {
  if (
    !isPlainObject(data) ||
    !Array.isArray(data.configurations) ||
    data.configurations.length > MAX_CACHED_CONFIGURATIONS
  ) {
    return null;
  }
  const configurations: CachedConfiguration[] = [];
  for (const entry of data.configurations) {
    if (
      !isPlainObject(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.source !== 'string' ||
      !isPlainObject(entry.inputs)
    ) {
      return null;
    }
    configurations.push({
      name: entry.name,
      source: entry.source,
      inputs: savedStringInputs(entry.inputs),
    });
  }
  return configurations;
}

/**
 * The settings saved under `name` in the process of `projectName`, for the form control. Results
 * are kept for five minutes in this tab (only the shared settings, never credentials).
 */
export async function resolveSavedInputs(
  api: DevOpsApi,
  projectName: string,
  name: string,
  storage?: SessionStore | null
): Promise<Record<string, string>> {
  if (!name.trim()) {
    return {};
  }
  const store = storage === undefined ? defaultSessionStore() : storage;
  const process = await processForProject(api, projectName, store);
  if (!process) {
    throw new PicklistError(
      'config',
      `Couldn’t find the process of project ${quoteName(projectName)}, so the saved configuration ${quoteName(name)} can’t be used.`
    );
  }
  const key = savedConfigurationsCacheKey(api, process.id);
  const cached = readSessionCache(store, key, parseCachedScan);
  if (cached) {
    try {
      return { ...pickByName(cached, name).inputs };
    } catch {
      // It may have been saved or renamed since: ask Azure DevOps again below.
    }
  }
  const scan = await scanSavedConfigurations(api, process);
  const compact: CachedConfiguration[] = scan.configurations.map((item) => ({
    name: item.name,
    source: item.source,
    inputs: item.inputs,
  }));
  writeSessionCache(store, key, { configurations: compact });
  return { ...findSavedConfiguration(scan, name).inputs };
}
