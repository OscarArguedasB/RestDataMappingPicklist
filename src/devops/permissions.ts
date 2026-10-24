import type { PermissionSnapshot } from '../core/configurations';
import { permissionErrorMessage, permissionUnverifiedMessage } from '../core/configurations';
import { PicklistError } from '../core/errors';
import { isPlainObject } from '../core/values';
import type { ProcessSummary } from './processes';
import type { DevOpsApi } from './rest';

// What the signed-in user may change on the setup page, asked of the Security REST API (the
// collection first, then the processes). Azure DevOps itself only enforces process permissions
// when a layout changes; for configurations (kept in extension data, which any member can write)
// this is a guard rail the page keeps. Hub only: the form control never needs it.

/** The "Process" security namespace; its Edit permission is "Edit process". */
export const PROCESS_NAMESPACE_ID = '2dab47f9-bd70-49ed-9bd5-8eb051e59c02';
/** The "Collection" security namespace, whose GENERIC_WRITE Project Collection Administrators have. */
export const COLLECTION_NAMESPACE_ID = '3e65f728-f8bc-4ecd-8764-7e378b19bfa7';
export const PROCESS_EDIT = 1;
export const COLLECTION_GENERIC_WRITE = 2;
export const COLLECTION_TOKEN = 'NAMESPACE:';
export const PERMISSION_EVALUATION_PATH =
  '_apis/security/permissionevaluationbatch?api-version=7.1';
// What Processes - List gives as the parent of a process that has none.
const NO_PARENT = '00000000-0000-0000-0000-000000000000';

export interface PermissionEvaluation {
  securityNamespaceId: string;
  token: string;
  permissions: number;
}

/**
 * The tokens an inherited process may be secured by. The documented form has a trailing colon;
 * both are asked and either one counts, since a wrong token can only deny.
 */
export function processTokens(
  process: Pick<ProcessSummary, 'id' | 'parentProcessTypeId'>
): string[] {
  const parent = process.parentProcessTypeId.trim();
  const path =
    parent && parent !== NO_PARENT ? `$PROCESS:${parent}:${process.id}` : `$PROCESS:${process.id}`;
  return [`${path}:`, path];
}

/** Process evaluations asked in one request at most: two tokens for each of 50 processes. */
export const MAX_EVALUATIONS_PER_REQUEST = 100;

export interface PermissionRequest {
  alwaysAllowAdministrators: true;
  evaluations: PermissionEvaluation[];
}

/**
 * The collection permission, asked on its own: whatever goes wrong with the process tokens,
 * Project Collection Administrators are still recognized.
 */
export function collectionRequest(): PermissionRequest {
  // Administrators pass every check, even where a permission is denied to them.
  return {
    alwaysAllowAdministrators: true,
    evaluations: [
      {
        securityNamespaceId: COLLECTION_NAMESPACE_ID,
        token: COLLECTION_TOKEN,
        permissions: COLLECTION_GENERIC_WRITE,
      },
    ],
  };
}

/**
 * The request bodies for the processes' Edit permission: each process's two tokens in order, in
 * as many requests as needed to keep each one at MAX_EVALUATIONS_PER_REQUEST or fewer.
 */
export function processRequests(
  processes: ReadonlyArray<Pick<ProcessSummary, 'id' | 'parentProcessTypeId'>>,
  maxEvaluations = MAX_EVALUATIONS_PER_REQUEST
): PermissionRequest[] {
  const perRequest = Math.max(1, Math.floor(maxEvaluations / 2));
  const requests: PermissionRequest[] = [];
  for (let start = 0; start < processes.length; start += perRequest) {
    const evaluations = processes.slice(start, start + perRequest).flatMap((process) =>
      processTokens(process).map((token): PermissionEvaluation => ({
        securityNamespaceId: PROCESS_NAMESPACE_ID,
        token,
        permissions: PROCESS_EDIT,
      }))
    );
    requests.push({ alwaysAllowAdministrators: true, evaluations });
  }
  return requests;
}

function sameEvaluation(answer: Record<string, unknown>, asked: PermissionEvaluation): boolean {
  return (
    typeof answer.token === 'string' &&
    answer.token.toLowerCase() === asked.token.toLowerCase() &&
    (answer.securityNamespaceId === undefined ||
      (typeof answer.securityNamespaceId === 'string' &&
        answer.securityNamespaceId.toLowerCase() === asked.securityNamespaceId))
  );
}

/**
 * Whether each asked evaluation was granted. Answers are matched by position, checked by token,
 * and looked up by token when the order differs; anything missing or unclear counts as denied.
 */
function readAnswers(data: unknown, asked: readonly PermissionEvaluation[]): boolean[] {
  if (!isPlainObject(data) || !Array.isArray(data.evaluations)) {
    throw new PicklistError('shape', 'Azure DevOps sent an unexpected answer about permissions.');
  }
  const answers = data.evaluations.filter(isPlainObject);
  return asked.map((evaluation, index) => {
    const inPlace = answers[index];
    const answer =
      inPlace && sameEvaluation(inPlace, evaluation)
        ? inPlace
        : answers.find((candidate) => sameEvaluation(candidate, evaluation));
    return answer?.value === true;
  });
}

function failureReason(error: unknown): string {
  if (!(error instanceof PicklistError)) {
    return 'something went wrong';
  }
  switch (error.kind) {
    case 'timeout':
      return 'Azure DevOps took too long to answer';
    case 'network':
      return 'Azure DevOps couldn’t be reached';
    case 'aborted':
      return 'the request was cancelled';
    case 'parse':
    case 'shape':
      return 'Azure DevOps sent an unexpected answer';
    default:
      return error.status ? `Azure DevOps answered ${error.status}` : 'something went wrong';
  }
}

/** Azure DevOps refused the question itself, which trying again won't change. */
function isRefusal(error: unknown): boolean {
  return error instanceof PicklistError && (error.status === 401 || error.status === 403);
}

async function ask(api: DevOpsApi, request: PermissionRequest): Promise<boolean[]> {
  const data = await api.post(PERMISSION_EVALUATION_PATH, request, {
    action: 'check your permissions',
  });
  return readAnswers(data, request.evaluations);
}

/** Nothing may be changed, and `error` says why. */
function denied(error: unknown): PermissionSnapshot {
  return {
    collectionAdmin: false,
    editableProcessIds: new Set<string>(),
    error: permissionErrorMessage(failureReason(error)),
  };
}

/**
 * What the signed-in user may change: whether they can write to the collection (Project
 * Collection Administrators can) and which processes they may edit. The collection is asked on
 * its own, then the processes, 50 at a time. Never throws.
 *
 * When Azure DevOps can't be reached or fails, `error` explains why and nothing may be changed
 * until the check works; but once the collection check said the user is an administrator, a
 * failure checking processes doesn't matter (administrators may edit every process). When it
 * refuses the check (401 or 403, which may happen for everyone if the extension's token isn't
 * allowed to ask), `unverified` says so: processes' configurations stay editable, since Azure
 * DevOps enforces Edit process on layout changes itself, but nothing meant for administrators
 * only (see canManageAll).
 */
export async function loadPermissions(
  api: DevOpsApi,
  processes: ReadonlyArray<Pick<ProcessSummary, 'id' | 'parentProcessTypeId'>>
): Promise<PermissionSnapshot> {
  let collectionAdmin: boolean;
  try {
    [collectionAdmin = false] = await ask(api, collectionRequest());
  } catch (error) {
    if (isRefusal(error)) {
      return {
        collectionAdmin: false,
        editableProcessIds: new Set<string>(),
        error: null,
        unverified: permissionUnverifiedMessage(failureReason(error)),
      };
    }
    return denied(error);
  }
  const editableProcessIds = new Set<string>();
  try {
    const unique = processes.filter(
      (process, index) =>
        process.id.trim() !== '' &&
        processes.findIndex((other) => other.id === process.id) === index
    );
    const perRequest = Math.floor(MAX_EVALUATIONS_PER_REQUEST / 2);
    for (const [chunk, request] of processRequests(unique).entries()) {
      // Two tokens for each process, in order; either one counts.
      const answers = await ask(api, request);
      unique.slice(chunk * perRequest, (chunk + 1) * perRequest).forEach((process, index) => {
        if (answers[index * 2] || answers[index * 2 + 1]) {
          editableProcessIds.add(process.id);
        }
      });
    }
  } catch (error) {
    // Administrators may edit every process anyway.
    if (!collectionAdmin) {
      return denied(error);
    }
  }
  return { collectionAdmin, editableProcessIds, error: null };
}
