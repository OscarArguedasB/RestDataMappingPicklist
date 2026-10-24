import { INPUT_IDS } from '../core/config';
import { quoteName } from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { LayoutControl, WorkItemTypeRef } from '../core/migration';
import { isPlainObject, scalarToString } from '../core/values';
import type { SessionStore } from './extensionData';
import { cacheKey, clearSessionCache, defaultSessionStore } from './extensionData';
import type { DevOpsApi } from './rest';

// This extension's controls in a process's work item forms, read from the process layout. Azure
// DevOps checks the "Edit process" permission when one is changed.
//
// Types only from core/migration: the form control loads this module for older controls, and
// must not download the migration code.

/** The control's contribution id; the full id is "<publisher>.<extension>.rest-data-mapping-picklist". */
export const CONTROL_CONTRIBUTION = 'rest-data-mapping-picklist';
const CONTRIBUTION_SUFFIX = `.${CONTROL_CONTRIBUTION}`;

function text(value: unknown): string {
  return scalarToString(value)?.trim() ?? '';
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

export function isPicklistContribution(contributionId: unknown): boolean {
  return (
    typeof contributionId === 'string' && contributionId.toLowerCase().endsWith(CONTRIBUTION_SUFFIX)
  );
}

/** Work Item Types - List with each type's form layout. */
export function workItemTypesPath(processId: string): string {
  return `_apis/work/processes/${encodeURIComponent(processId)}/workitemtypes?$expand=layout&api-version=7.1`;
}

/**
 * The session cache key of a process's 3.0 saved configurations, cleared whenever one of its
 * controls changes.
 */
export function savedConfigurationsCacheKey(api: DevOpsApi, processId: string): string {
  return cacheKey('saved', api.collectionUrl, processId);
}

/** This extension's controls in a Work Item Types - List response with `$expand=layout`. */
export function findPicklistControls(
  data: unknown,
  process: { id: string; name: string }
): LayoutControl[] {
  const types = Array.isArray(data)
    ? data
    : isPlainObject(data) && Array.isArray(data.value)
      ? data.value
      : null;
  if (!types) {
    throw new PicklistError(
      'shape',
      'Azure DevOps returned an unexpected list of work item types.'
    );
  }
  const found: LayoutControl[] = [];
  const seen = new Set<string>();
  for (const type of objects(types)) {
    const referenceName = text(type.referenceName);
    if (!referenceName || !isPlainObject(type.layout)) {
      continue;
    }
    const workItemType: WorkItemTypeRef = { name: text(type.name) || referenceName, referenceName };
    for (const page of objects(type.layout.pages)) {
      for (const section of objects(page.sections)) {
        for (const group of objects(section.groups)) {
          for (const control of objects(group.controls)) {
            const contribution = control.contribution;
            if (
              control.isContribution === false ||
              !isPlainObject(contribution) ||
              !isPicklistContribution(contribution.contributionId)
            ) {
              continue;
            }
            const groupId = text(group.id);
            const controlId = text(control.id);
            const key = `${referenceName}\n${controlId}`;
            if (!groupId || !controlId || seen.has(key)) {
              continue;
            }
            seen.add(key);
            const inputs = isPlainObject(contribution.inputs) ? { ...contribution.inputs } : {};
            found.push({
              processId: process.id,
              processName: process.name,
              workItemType,
              groupId,
              controlId,
              label: text(control.label),
              fieldName: text(inputs[INPUT_IDS.fieldName]),
              inputs,
              control,
            });
          }
        }
      }
    }
  }
  return found;
}

/** Every REST Picklist control in a process's work item forms, in layout order. */
export async function scanProcessControls(
  api: DevOpsApi,
  process: { id: string; name: string }
): Promise<LayoutControl[]> {
  const data = await api.get(workItemTypesPath(process.id), {
    action: `read the ${quoteName(process.name)} process`,
  });
  return findPicklistControls(data, process);
}

/** What identifies a control in a layout, and the control as Azure DevOps returned it. */
export type ControlTarget = Pick<
  LayoutControl,
  'processId' | 'processName' | 'workItemType' | 'groupId' | 'controlId' | 'control'
>;

/**
 * Sends a control's new inputs with Controls - Update, and returns what Azure DevOps answered.
 * Errors come as DevOpsApi reports them; updateControlInputs explains them.
 */
export async function patchControlInputs(
  api: DevOpsApi,
  target: ControlTarget,
  inputs: Record<string, unknown>
): Promise<unknown> {
  const { control } = target;
  const contribution = isPlainObject(control.contribution) ? control.contribution : {};
  // Shaped like Microsoft's Controls - Update example. The inputs go complete, because Azure
  // DevOps stores the contribution's inputs as a whole.
  const body = {
    id: target.controlId,
    label: control.label,
    readOnly: control.readOnly,
    visible: control.visible,
    contribution: {
      contributionId: contribution.contributionId,
      inputs,
      height: contribution.height,
      showOnDeletedWorkItem: contribution.showOnDeletedWorkItem,
    },
    isContribution: true,
  };
  const path =
    `_apis/work/processes/${encodeURIComponent(target.processId)}` +
    `/workItemTypes/${encodeURIComponent(target.workItemType.referenceName)}` +
    `/layout/groups/${encodeURIComponent(target.groupId)}` +
    `/controls/${encodeURIComponent(target.controlId)}?api-version=7.1`;
  return api.patch(path, body, { action: `edit the ${quoteName(target.processName)} process` });
}

function where(control: LayoutControl): string {
  return `${control.workItemType.name} › ${control.label || control.fieldName || control.controlId}`;
}

const LEFTOVER_PASSWORD =
  'The old settings, including the password, are still stored on this control. Try again, or remove the control from the form and add it again.';
const LEFTOVER_SETTINGS =
  'The old settings are still stored on this control. Try again, or remove the control from the form and add it again.';

/**
 * Azure DevOps kept inputs it was asked to remove, such as a 3.0 password, even when sent again
 * empty. The control was still updated: `control` is how Azure DevOps has it now, so it uses what
 * it was given (a configuration, say), but it isn't clean.
 */
export class LeftoverInputsError extends PicklistError {
  readonly control: LayoutControl;
  /** The ids of the inputs that stayed. Never their values. */
  readonly inputIds: readonly string[];

  constructor(control: LayoutControl, inputIds: readonly string[]) {
    super('http', inputIds.includes(INPUT_IDS.password) ? LEFTOVER_PASSWORD : LEFTOVER_SETTINGS);
    this.name = 'LeftoverInputsError';
    this.control = control;
    this.inputIds = inputIds;
  }
}

/** Inputs Azure DevOps still has that weren't sent, so they weren't meant to stay. */
function leftoverInputIds(returned: Record<string, unknown>, sent: Record<string, string>) {
  return Object.keys(returned).filter((id) => {
    const value = text(returned[id]);
    return !Object.hasOwn(sent, id) && value !== '' && value.toLowerCase() !== 'false';
  });
}

/**
 * Replaces a control's inputs: `inputs` is everything it keeps, so inputs left out are removed
 * (use migratedInputs for a control moving to a configuration). Azure DevOps checks the "Edit
 * process" permission. Returns the control as Azure DevOps now has it.
 *
 * Azure DevOps is expected to store the inputs as sent. If its answer still has others (as if it
 * merged them), they're sent again, empty; if they still stay, a LeftoverInputsError carries the
 * updated control, since an old password may still be stored on it.
 */
export async function updateControlInputs(
  api: DevOpsApi,
  control: LayoutControl,
  inputs: Record<string, string>,
  storage?: SessionStore | null
): Promise<LayoutControl> {
  // Controls - Update sends the label, visibility and height too: they come from the layout as
  // it is now, not as the page read it (maybe hours ago), so changes made since aren't undone.
  const current = await currentControl(api, control);
  const first = await replaceControlInputs(api, current, inputs, storage);
  if (first.leftovers.length === 0) {
    return first.control;
  }
  const blanked = {
    ...inputs,
    ...Object.fromEntries(first.leftovers.map((id): [string, string] => [id, ''])),
  };
  const second = await replaceControlInputs(api, first.control, blanked, storage).catch(
    // The first update stands; what it left behind is reported below.
    () => null
  );
  if (!second) {
    throw new LeftoverInputsError(first.control, first.leftovers);
  }
  // Sent empty, they count as removed when they come back empty (or not at all).
  const kept = second.control.inputs;
  const remaining = [...first.leftovers.filter((id) => text(kept[id]) !== ''), ...second.leftovers];
  if (remaining.length === 0) {
    return second.control;
  }
  throw new LeftoverInputsError(second.control, remaining);
}

/** Layout - Get: one work item type's form layout. */
export function workItemTypeLayoutPath(processId: string, workItemType: string): string {
  return (
    `_apis/work/processes/${encodeURIComponent(processId)}` +
    `/workItemTypes/${encodeURIComponent(workItemType)}/layout?api-version=7.1`
  );
}

/**
 * The control as the work item type's layout has it now (its label, visibility and height may
 * have changed in the process editor since the page read the layout), found by its id, in
 * whichever group it's in now.
 */
export async function currentControl(
  api: DevOpsApi,
  control: LayoutControl
): Promise<LayoutControl> {
  let layout: unknown;
  try {
    layout = await api.get(
      workItemTypeLayoutPath(control.processId, control.workItemType.referenceName),
      { action: `read the ${quoteName(control.processName)} process` }
    );
  } catch (error) {
    if (error instanceof PicklistError && error.status === 404) {
      throw new PicklistError('http', notFound(control), 404);
    }
    throw error;
  }
  const found = findPicklistControls(
    {
      value: [
        {
          referenceName: control.workItemType.referenceName,
          name: control.workItemType.name,
          layout,
        },
      ],
    },
    { id: control.processId, name: control.processName }
  ).find((candidate) => candidate.controlId === control.controlId);
  if (!found) {
    throw new PicklistError('http', notFound(control), 404);
  }
  return { ...found, processName: control.processName, workItemType: control.workItemType };
}

function notFound(control: LayoutControl): string {
  return `The control ${where(control)} wasn’t found. It may have been changed or removed: refresh the list.`;
}

/** One Controls - Update, explained and checked; returns the control and any leftover inputs. */
async function replaceControlInputs(
  api: DevOpsApi,
  control: LayoutControl,
  inputs: Record<string, string>,
  storage: SessionStore | null | undefined
): Promise<{ control: LayoutControl; leftovers: string[] }> {
  let result: unknown;
  try {
    result = await patchControlInputs(api, control, inputs);
  } catch (error) {
    if (error instanceof PicklistError && (error.status === 401 || error.status === 403)) {
      throw new PicklistError(
        'http',
        `You don’t have permission to edit the ${quoteName(control.processName)} process. Ask a process administrator to change ${where(control)}, or to give you the “Edit process” permission.`,
        error.status
      );
    }
    if (error instanceof PicklistError && error.status === 404) {
      throw new PicklistError('http', notFound(control), 404);
    }
    throw error;
  } finally {
    // Forms using 3.0 saved configurations read the layout again.
    clearSessionCache(
      storage === undefined ? defaultSessionStore() : storage,
      savedConfigurationsCacheKey(api, control.processId)
    );
  }
  const returned =
    isPlainObject(result) && isPlainObject(result.contribution) ? result.contribution : null;
  const returnedInputs = returned && isPlainObject(returned.inputs) ? returned.inputs : null;
  if (
    returnedInputs &&
    Object.entries(inputs).some(([id, value]) => text(returnedInputs[id]) !== value.trim())
  ) {
    throw new PicklistError(
      'http',
      `Azure DevOps didn’t save the change. Open the ${quoteName(control.processName)} process and check ${where(control)}.`
    );
  }
  const updatedInputs = returnedInputs ? { ...returnedInputs } : { ...inputs };
  const contribution = isPlainObject(control.control.contribution)
    ? control.control.contribution
    : {};
  return {
    control: {
      ...control,
      fieldName: text(updatedInputs[INPUT_IDS.fieldName]),
      inputs: updatedInputs,
      control:
        isPlainObject(result) && returned
          ? result
          : { ...control.control, contribution: { ...contribution, inputs: { ...inputs } } },
    },
    leftovers: returnedInputs ? leftoverInputIds(returnedInputs, inputs) : [],
  };
}
