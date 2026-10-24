import { PicklistError } from '../core/errors';
import { isPlainObject } from '../core/values';
import type { SessionStore } from './extensionData';
import {
  cacheKey,
  defaultSessionStore,
  readSessionCache,
  writeSessionCache,
} from './extensionData';
import type { DevOpsApi } from './rest';

export interface ProcessSummary {
  /** The process type id (`typeId` in the REST response). */
  id: string;
  name: string;
  /** "system", "inherited" or "custom". Only inherited processes can hold custom controls. */
  customizationType: string;
  isEnabled: boolean;
  /** Projects using the process that the signed-in user can see. */
  projectNames: string[];
  projectIds: string[];
  /** The type id of the process it inherits from; '' when none (system and Hosted XML processes). */
  parentProcessTypeId: string;
}

export const PROCESSES_PATH = '_apis/work/processes?$expand=projects&api-version=7.1';

// Processes - List gives system processes this parent.
const NO_PARENT = '00000000-0000-0000-0000-000000000000';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Reads a Processes - List response (`{ count, value: [...] }`). */
export function parseProcesses(data: unknown): ProcessSummary[] {
  const list = Array.isArray(data)
    ? data
    : isPlainObject(data) && Array.isArray(data.value)
      ? data.value
      : null;
  if (!list) {
    throw new PicklistError('shape', 'Azure DevOps returned an unexpected list of processes.');
  }
  const processes: ProcessSummary[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) {
      continue;
    }
    const id = text(item.typeId) || text(item.id);
    const name = text(item.name);
    if (!id || !name) {
      continue;
    }
    const projects = Array.isArray(item.projects) ? item.projects.filter(isPlainObject) : [];
    const parent = text(item.parentProcessTypeId);
    processes.push({
      id,
      name,
      customizationType: text(item.customizationType).toLowerCase(),
      isEnabled: item.isEnabled !== false,
      projectNames: projects.map((project) => text(project.name)).filter(Boolean),
      projectIds: projects.map((project) => text(project.id)).filter(Boolean),
      parentProcessTypeId: parent === NO_PARENT ? '' : parent,
    });
  }
  return processes.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Whether a process can hold this extension's control: inherited and Hosted XML ("custom")
 * processes can, system processes can't be changed at all.
 */
export function canHoldControls(process: Pick<ProcessSummary, 'customizationType'>): boolean {
  return process.customizationType === 'inherited' || process.customizationType === 'custom';
}

export async function listProcesses(api: DevOpsApi): Promise<ProcessSummary[]> {
  const data = await api.get(PROCESSES_PATH, {
    action: 'read the organization’s processes',
  });
  return parseProcesses(data);
}

/** The process a project uses, found by project name (any case) or id; null when not listed. */
export async function findProcessForProject(
  api: DevOpsApi,
  projectName: string
): Promise<ProcessSummary | null> {
  const wanted = projectName.trim();
  if (!wanted) {
    return null;
  }
  const processes = await listProcesses(api);
  return (
    processes.find(
      (process) =>
        process.projectNames.some((name) => sameText(name, wanted)) ||
        process.projectIds.some((id) => sameText(id, wanted))
    ) ?? null
  );
}

function parseCachedProcess(data: unknown): { id: string; name: string } | null {
  return isPlainObject(data) &&
    typeof data.id === 'string' &&
    data.id &&
    typeof data.name === 'string'
    ? { id: data.id, name: data.name }
    : null;
}

/**
 * Like findProcessForProject, for the form control: the answer is kept for five minutes in this
 * tab (`storage`, sessionStorage by default; null turns the cache off), per organization.
 */
export async function processForProject(
  api: DevOpsApi,
  projectName: string,
  storage?: SessionStore | null
): Promise<{ id: string; name: string } | null> {
  const store = storage === undefined ? defaultSessionStore() : storage;
  const key = cacheKey('process', api.collectionUrl, projectName.trim().toLowerCase());
  const cached = readSessionCache(store, key, parseCachedProcess);
  if (cached) {
    return cached;
  }
  const process = await findProcessForProject(api, projectName);
  if (process) {
    writeSessionCache(store, key, { id: process.id, name: process.name });
  }
  return process ? { id: process.id, name: process.name } : null;
}
