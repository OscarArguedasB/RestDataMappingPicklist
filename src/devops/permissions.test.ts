import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canCreateIn,
  canDeleteConfiguration,
  canEditConfiguration,
  canEditPolicy,
  canEditProcess,
} from '../core/configurations';
import { isPlainObject } from '../core/values';
import {
  COLLECTION_NAMESPACE_ID,
  MAX_EVALUATIONS_PER_REQUEST,
  PROCESS_NAMESPACE_ID,
  collectionRequest,
  loadPermissions,
  processRequests,
  processTokens,
} from './permissions';
import type { ProcessSummary } from './processes';
import { createDevOpsApiForTests } from './rest';

// The real SDK talks to the parent window as soon as it's imported.
vi.mock('azure-devops-extension-sdk', () => ({}));

const BASE = 'https://dev.azure.com/contoso/';
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.permission-token';
const AGILE_PARENT = 'adcc42ab-9882-485e-a3ed-7678f01f66bc';
const CONTOSO_AGILE = 'e31fd6e1-c6af-44bb-925e-dfa71f551463';
const FABRIKAM_SCRUM = '6b724908-ef14-45cf-84f8-768b5384da45';
const HOSTED_XML = '27450541-8e31-4150-9947-dc59f998fc01';

function process(id: string, parentProcessTypeId: string): ProcessSummary {
  return {
    id,
    name: id,
    customizationType: parentProcessTypeId ? 'inherited' : 'custom',
    isEnabled: true,
    projectNames: [],
    projectIds: [],
    parentProcessTypeId,
  };
}

const PROCESSES = [
  process(CONTOSO_AGILE, AGILE_PARENT),
  process(FABRIKAM_SCRUM, '27450541-0000-0000-0000-000000000000'),
  process(HOSTED_XML, ''),
];

const COLLECTION_BODY = {
  alwaysAllowAdministrators: true,
  evaluations: [
    { securityNamespaceId: COLLECTION_NAMESPACE_ID, token: 'NAMESPACE:', permissions: 2 },
  ],
};

const PROCESS_BODY = {
  alwaysAllowAdministrators: true,
  evaluations: [
    {
      securityNamespaceId: PROCESS_NAMESPACE_ID,
      token: `$PROCESS:${AGILE_PARENT}:${CONTOSO_AGILE}:`,
      permissions: 1,
    },
    {
      securityNamespaceId: PROCESS_NAMESPACE_ID,
      token: `$PROCESS:${AGILE_PARENT}:${CONTOSO_AGILE}`,
      permissions: 1,
    },
    {
      securityNamespaceId: PROCESS_NAMESPACE_ID,
      token: `$PROCESS:27450541-0000-0000-0000-000000000000:${FABRIKAM_SCRUM}:`,
      permissions: 1,
    },
    {
      securityNamespaceId: PROCESS_NAMESPACE_ID,
      token: `$PROCESS:27450541-0000-0000-0000-000000000000:${FABRIKAM_SCRUM}`,
      permissions: 1,
    },
    { securityNamespaceId: PROCESS_NAMESPACE_ID, token: `$PROCESS:${HOSTED_XML}:`, permissions: 1 },
    { securityNamespaceId: PROCESS_NAMESPACE_ID, token: `$PROCESS:${HOSTED_XML}`, permissions: 1 },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** The answer Azure DevOps gives, echoing each evaluation with its value. */
function answer(
  asked: ReadonlyArray<Record<string, unknown>>,
  values: boolean[],
  order: (index: number) => number = (index) => index
) {
  const evaluations = asked.map((evaluation, index) => ({
    ...evaluation,
    value: values[index] ?? false,
  }));
  return { evaluations: evaluations.map((_, index) => evaluations[order(index)]) };
}

/** The collection's answer. */
function admin(value: boolean): Response {
  return json(answer(COLLECTION_BODY.evaluations, [value]));
}

/** The processes' answer, two values for each process in PROCESSES. */
function editable(values: boolean[], order?: (index: number) => number): Response {
  return json(answer(PROCESS_BODY.evaluations, values, order));
}

function setup(...responses: Array<Response | Error>) {
  const queue = [...responses];
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('No more responses');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { api: createDevOpsApiForTests(BASE, TOKEN, fetchImpl), fetchImpl };
}

/** The evaluations a request body asks for. */
function evaluationsIn(body: unknown): Array<Record<string, unknown>> {
  return isPlainObject(body) && Array.isArray(body.evaluations)
    ? body.evaluations.filter(isPlainObject)
    : [];
}

function sentBody(fetchImpl: ReturnType<typeof setup>['fetchImpl'], call = 0): unknown {
  const body = fetchImpl.mock.calls[call]?.[1]?.body;
  return typeof body === 'string' ? JSON.parse(body) : null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processTokens', () => {
  it('asks for both forms of an inherited process’s token', () => {
    expect(processTokens({ id: 'child', parentProcessTypeId: 'parent' })).toEqual([
      '$PROCESS:parent:child:',
      '$PROCESS:parent:child',
    ]);
    for (const parentProcessTypeId of ['', ' ', '00000000-0000-0000-0000-000000000000']) {
      expect(processTokens({ id: 'xml', parentProcessTypeId })).toEqual([
        '$PROCESS:xml:',
        '$PROCESS:xml',
      ]);
    }
  });

  it('builds the requests: the collection on its own, then the processes in chunks', () => {
    expect(collectionRequest()).toEqual(COLLECTION_BODY);
    expect(processRequests(PROCESSES)).toEqual([PROCESS_BODY]);
    expect(processRequests([])).toEqual([]);
    // A process's two tokens always go together.
    const chunks = processRequests(PROCESSES, 4);
    expect(chunks.map((request) => request.evaluations)).toEqual([
      PROCESS_BODY.evaluations.slice(0, 4),
      PROCESS_BODY.evaluations.slice(4),
    ]);
    expect(MAX_EVALUATIONS_PER_REQUEST).toBe(100);
  });
});

describe('loadPermissions', () => {
  it('asks about the collection, then the processes, each only once', async () => {
    const { api, fetchImpl } = setup(
      admin(false),
      editable([true, false, false, false, false, false])
    );
    await loadPermissions(api, [...PROCESSES, process(CONTOSO_AGILE, AGILE_PARENT)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(input).toBe(`${BASE}_apis/security/permissionevaluationbatch?api-version=7.1`);
      expect(init?.method).toBe('POST');
    }
    expect(sentBody(fetchImpl, 0)).toEqual(COLLECTION_BODY);
    // Duplicates are asked about once.
    expect(sentBody(fetchImpl, 1)).toEqual(PROCESS_BODY);
  });

  it('asks about many processes in several requests', async () => {
    const many = Array.from({ length: 120 }, (_, index) => process(`p-${index}`, AGILE_PARENT));
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const asked = evaluationsIn(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
      // Only the first token of p-119 is granted.
      return json(
        answer(
          asked,
          asked.map((item) => item.token === `$PROCESS:${AGILE_PARENT}:p-119:`)
        )
      );
    });
    const api = createDevOpsApiForTests(BASE, TOKEN, fetchImpl);
    const snapshot = await loadPermissions(api, many);
    // The collection, then 50 processes at a time.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const call of [1, 2, 3]) {
      const asked = evaluationsIn(sentBody(fetchImpl, call));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.length).toBeLessThanOrEqual(MAX_EVALUATIONS_PER_REQUEST);
    }
    expect(snapshot).toEqual({
      collectionAdmin: false,
      editableProcessIds: new Set(['p-119']),
      error: null,
    });
  });

  it('finds collection administrators', async () => {
    const { api } = setup(admin(true), editable([]));
    const snapshot = await loadPermissions(api, PROCESSES);
    expect(snapshot).toEqual({ collectionAdmin: true, editableProcessIds: new Set(), error: null });
    expect(canEditPolicy(snapshot)).toBe(true);
    expect(canCreateIn(snapshot, FABRIKAM_SCRUM)).toBe(true);
  });

  it('keeps administrators able to edit when checking the processes fails', async () => {
    for (const failure of [json({}, 400), json({}, 500), json({}, 403), json({ value: [] })]) {
      const { api } = setup(admin(true), failure);
      const snapshot = await loadPermissions(api, PROCESSES);
      expect(snapshot).toEqual({
        collectionAdmin: true,
        editableProcessIds: new Set(),
        error: null,
      });
      expect(canEditPolicy(snapshot)).toBe(true);
      expect(canEditProcess(snapshot, HOSTED_XML)).toBe(true);
    }
  });

  it('turns editing off for everyone else when checking the processes fails', async () => {
    for (const [failure, reason] of [
      [json({}, 400), 'Azure DevOps answered 400'],
      // Refused for the processes only: not the same as a refused check.
      [json({}, 403), 'Azure DevOps answered 403'],
    ] as const) {
      const { api } = setup(admin(false), failure);
      expect(await loadPermissions(api, PROCESSES)).toEqual({
        collectionAdmin: false,
        editableProcessIds: new Set(),
        error: `Couldn’t check your permissions (${reason}). Editing is turned off until it works.`,
      });
    }
  });

  it('finds the processes the user may edit, by either token', async () => {
    const { api } = setup(admin(false), editable([false, true, true, false, false, false]));
    const snapshot = await loadPermissions(api, PROCESSES);
    expect(snapshot).toEqual({
      collectionAdmin: false,
      editableProcessIds: new Set([CONTOSO_AGILE, FABRIKAM_SCRUM]),
      error: null,
    });
    expect(canCreateIn(snapshot, HOSTED_XML)).toBe(false);
    expect(canEditPolicy(snapshot)).toBe(false);
  });

  it('matches answers by token when they come in another order', async () => {
    const { api } = setup(
      admin(false),
      editable([true, false, false, false, false, true], (index) => 5 - index)
    );
    expect(await loadPermissions(api, PROCESSES)).toEqual({
      collectionAdmin: false,
      editableProcessIds: new Set([CONTOSO_AGILE, HOSTED_XML]),
      error: null,
    });
  });

  it('counts anything missing or unclear as denied', async () => {
    const { evaluations } = answer(PROCESS_BODY.evaluations, [true, true, true, true, true, true]);
    const odd = [
      evaluations[0],
      // Another token in the right place doesn't count for this one.
      { ...evaluations[2], token: '$PROCESS:somewhere-else:' },
      null,
      { ...evaluations[3], value: 'true' },
    ];
    const { api } = setup(
      json({ evaluations: [{ ...COLLECTION_BODY.evaluations[0], value: 'true' }] }),
      json({ evaluations: odd })
    );
    expect(await loadPermissions(api, PROCESSES)).toEqual({
      collectionAdmin: false,
      editableProcessIds: new Set([CONTOSO_AGILE]),
      error: null,
    });
  });

  it('checks the collection even without processes', async () => {
    const { api, fetchImpl } = setup(admin(true));
    expect(await loadPermissions(api, [])).toMatchObject({ collectionAdmin: true, error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchImpl)).toEqual(COLLECTION_BODY);
  });

  it('marks it unverified when Azure DevOps refuses the check itself, without granting administrators’ rights', async () => {
    // The extension's token may not be allowed to ask (no OAuth scope covers this API), and then
    // it's refused for everyone, Project Collection Administrators included. Processes'
    // configurations stay editable (Azure DevOps guards layout changes itself); the security
    // policy and configurations no process uses don't.
    const cases: Array<[ReturnType<typeof setup>, string]> = [
      [setup(json({ message: 'Access denied.' }, 403)), 'Azure DevOps answered 403'],
      [setup(json({}, 401), json({}, 401)), 'Azure DevOps answered 401'],
    ];
    for (const [{ api, fetchImpl }, reason] of cases) {
      const snapshot = await loadPermissions(api, PROCESSES);
      expect(snapshot).toEqual({
        collectionAdmin: false,
        editableProcessIds: new Set(),
        error: null,
        unverified: `Couldn’t verify your permissions (${reason}), so editing configurations isn’t limited here. Azure DevOps still checks Edit process permission when a process’s controls change, so only change what you’re responsible for. The security policy and configurations no process uses stay read-only until the check works.`,
      });
      // The processes aren't asked about: that would be refused too.
      expect(sentBody(fetchImpl, fetchImpl.mock.calls.length - 1)).toEqual(COLLECTION_BODY);
      expect(snapshot.unverified).not.toContain(TOKEN);
      expect(canEditProcess(snapshot, CONTOSO_AGILE)).toBe(true);
      expect(canEditConfiguration(snapshot, { processIds: [CONTOSO_AGILE] })).toBe(true);
      expect(canDeleteConfiguration(snapshot, { processIds: [CONTOSO_AGILE, 'other'] })).toBe(true);
      expect(canDeleteConfiguration(snapshot, { processIds: [] })).toBe(false);
      expect(canEditPolicy(snapshot)).toBe(false);
    }
  });

  it('never throws: other failures turn editing off with a reason', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const cases: Array<[ReturnType<typeof setup>['api'], string]> = [
      [setup(json({}, 500)).api, 'Azure DevOps answered 500'],
      [setup(json({}, 429)).api, 'Azure DevOps answered 429'],
      [setup(new TypeError('Failed to fetch')).api, 'Azure DevOps couldn’t be reached'],
      [setup(json({ value: [] })).api, 'Azure DevOps sent an unexpected answer'],
      [
        setup(new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }))
          .api,
        'Azure DevOps sent an unexpected answer',
      ],
      [
        createDevOpsApiForTests(BASE, TOKEN, hanging, { timeoutMs: 10 }),
        'Azure DevOps took too long to answer',
      ],
    ];
    for (const [api, reason] of cases) {
      const snapshot = await loadPermissions(api, PROCESSES);
      expect(snapshot).toEqual({
        collectionAdmin: false,
        editableProcessIds: new Set(),
        error: `Couldn’t check your permissions (${reason}). Editing is turned off until it works.`,
      });
      expect(snapshot.error).not.toContain(TOKEN);
    }
  });

  it('turns editing off when the API isn’t usable at all', async () => {
    const broken = {
      collectionUrl: BASE,
      get: async () => undefined,
      patch: async () => undefined,
      post: () => {
        throw new Error('Not ready');
      },
    };
    expect(await loadPermissions(broken, PROCESSES)).toMatchObject({
      collectionAdmin: false,
      error:
        'Couldn’t check your permissions (something went wrong). Editing is turned off until it works.',
    });
  });
});
