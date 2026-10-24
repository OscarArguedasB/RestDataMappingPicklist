import { afterEach, describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import type { DevOpsSdk, LocationService } from './rest';
import { LOCATION_SERVICE_ID, createDevOpsApi, createDevOpsApiForTests } from './rest';

// The real SDK talks to the parent window as soon as it's imported.
vi.mock('azure-devops-extension-sdk', () => ({}));

const BASE = 'https://dev.azure.com/contoso';
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.secret-token';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function mockFetch(...responses: Array<Response | Error>) {
  const queue = [...responses];
  return vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('No more responses');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
}

function call(fetchImpl: ReturnType<typeof mockFetch>, index = 0) {
  const [input, init] = fetchImpl.mock.calls[index] ?? [];
  return { url: typeof input === 'string' ? input : '', init: init ?? {} };
}

async function failure(promise: Promise<unknown>): Promise<PicklistError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PicklistError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the request to fail');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DevOpsApi requests', () => {
  it('resolves paths against the organization and adds the API version', async () => {
    const fetchImpl = mockFetch(json({ count: 0, value: [] }), json({ ok: true }));
    const api = createDevOpsApiForTests(BASE, TOKEN, fetchImpl);
    expect(api.collectionUrl).toBe('https://dev.azure.com/contoso/');

    await expect(api.get('_apis/work/processes?$expand=projects')).resolves.toEqual({
      count: 0,
      value: [],
    });
    expect(call(fetchImpl).url).toBe(
      'https://dev.azure.com/contoso/_apis/work/processes?$expand=projects&api-version=7.1'
    );

    await api.get('/_apis/projects?api-version=7.2-preview');
    expect(call(fetchImpl, 1).url).toBe(
      'https://dev.azure.com/contoso/_apis/projects?api-version=7.2-preview'
    );
  });

  it('sends the access token as a bearer token, without cookies or redirects', async () => {
    const fetchImpl = mockFetch(json({}));
    await createDevOpsApiForTests(BASE, TOKEN, fetchImpl).get('_apis/work/processes');
    const { init } = call(fetchImpl);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-TFS-FedAuthRedirect': 'Suppress',
    });
    expect(init.body).toBeUndefined();
  });

  it('sends PATCH bodies as JSON', async () => {
    const fetchImpl = mockFetch(json({ id: 'c1' }));
    const api = createDevOpsApiForTests(`${BASE}/`, TOKEN, fetchImpl);
    await expect(api.patch('_apis/things/1', { label: 'Customer' })).resolves.toEqual({
      id: 'c1',
    });
    const { url, init } = call(fetchImpl);
    expect(url).toBe('https://dev.azure.com/contoso/_apis/things/1?api-version=7.1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"label":"Customer"}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('never sends the token outside the organization', async () => {
    const fetchImpl = mockFetch();
    const api = createDevOpsApiForTests(BASE, TOKEN, fetchImpl);
    for (const path of [
      '../fabrikam/_apis/projects',
      '%2e%2e/fabrikam/_apis',
      'https://evil.example/_apis',
      '\\evil.example/_apis',
      'javascript:alert(1)',
      '',
    ]) {
      const error = await failure(api.get(path));
      expect(error.kind).toBe('config');
      expect(error.message).toMatch(/stay within the current organization/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats leading slashes as relative to the organization', async () => {
    const fetchImpl = mockFetch(json({}));
    await createDevOpsApiForTests(BASE, TOKEN, fetchImpl).get('//evil.example/_apis');
    expect(call(fetchImpl).url).toBe(
      'https://dev.azure.com/contoso/evil.example/_apis?api-version=7.1'
    );
  });

  it('only accepts an https organization address', () => {
    const fetchImpl = mockFetch();
    expect(() => createDevOpsApiForTests('http://dev.azure.com/contoso', TOKEN, fetchImpl)).toThrow(
      /valid organization address/
    );
    expect(() => createDevOpsApiForTests('not a url', TOKEN, fetchImpl)).toThrow(
      /valid organization address/
    );
    expect(() =>
      createDevOpsApiForTests('https://user:pw@dev.azure.com/contoso', TOKEN, fetchImpl)
    ).toThrow(/valid organization address/);
  });

  it('returns undefined for empty bodies', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    await expect(
      createDevOpsApiForTests(BASE, TOKEN, fetchImpl).get('_apis/x')
    ).resolves.toBeUndefined();
  });
});

describe('DevOpsApi errors', () => {
  it('explains a refused request with the action and Azure DevOps’ reason', async () => {
    const fetchImpl = mockFetch(
      json(
        {
          $id: '1',
          message: 'VS402375: Access denied. Ada needs Edit process permission.',
          typeKey: 'ProcessWorkItemTypeException',
        },
        403
      )
    );
    const error = await failure(
      createDevOpsApiForTests(BASE, TOKEN, fetchImpl).patch(
        '_apis/work/processes/p/workItemTypes/w/layout/groups/g/controls/c',
        {},
        { action: 'edit the “Custom Agile” process' }
      )
    );
    expect(error).toMatchObject({ kind: 'http', status: 403 });
    expect(error.message).toBe(
      'You don’t have permission to edit the “Custom Agile” process (403). VS402375: Access denied. Ada needs Edit process permission.'
    );
  });

  it('uses a general action when none is given', async () => {
    const error = await failure(
      createDevOpsApiForTests(BASE, TOKEN, mockFetch(json({}, 403))).get('_apis/x')
    );
    expect(error.message).toBe('You don’t have permission to read this from Azure DevOps (403).');
  });

  it('tries once more with a fresh token after a 401', async () => {
    const tokens = ['expired-token', 'fresh-token'];
    const location: LocationService = { getServiceLocation: async () => `${BASE}/` };
    const getService = vi.fn<DevOpsSdk['getService']>(async (id) => {
      expect(id).toBe(LOCATION_SERVICE_ID);
      return location;
    });
    const sdk: DevOpsSdk = {
      getAccessToken: vi.fn<DevOpsSdk['getAccessToken']>(async () => tokens.shift() ?? ''),
      getService,
      getExtensionContext: () => ({ id: 'publisher.extension' }),
      getHost: () => ({ id: 'host', name: 'contoso' }),
      getUser: () => ({ displayName: 'Ada', name: 'ada@contoso.com' }),
    };
    const fetchImpl = mockFetch(json({}, 401), json({ value: [] }));
    const api = await createDevOpsApi(sdk, fetchImpl);
    await expect(api.get('_apis/x')).resolves.toEqual({ value: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(call(fetchImpl, 1).init.headers).toMatchObject({
      Authorization: 'Bearer fresh-token',
    });
  });

  it('reports a 401 that persists as a permission problem', async () => {
    const fetchImpl = mockFetch(json({}, 401), json({}, 401));
    const error = await failure(createDevOpsApiForTests(BASE, TOKEN, fetchImpl).get('_apis/x'));
    expect(error).toMatchObject({ kind: 'http', status: 401 });
    expect(error.message).toMatch(/^You don’t have permission to/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('writes friendly messages for other statuses', async () => {
    const cases: Array<[Response, RegExp]> = [
      [json({ message: 'VS402805: Cannot find group.' }, 404), /couldn’t find.*\(404\)\. VS402805/],
      [json({}, 409), /changed this at the same time \(409\)/],
      [json({}, 429), /limiting requests \(429\)/],
      [json({ message: 'Stack trace…' }, 500), /^Azure DevOps had a problem \(500\)\. Try again/],
      [
        json({ message: 'Bad input.' }, 400),
        /^Azure DevOps returned an error \(400\)\. Bad input\.$/,
      ],
    ];
    for (const [response, message] of cases) {
      const error = await failure(
        createDevOpsApiForTests(BASE, TOKEN, mockFetch(response)).get('_apis/x')
      );
      expect(error.kind).toBe('http');
      expect(error.message).toMatch(message);
    }
  });

  it('keeps long server messages short', async () => {
    const error = await failure(
      createDevOpsApiForTests(BASE, TOKEN, mockFetch(json({ message: 'x'.repeat(5000) }, 400))).get(
        '_apis/x'
      )
    );
    expect(error.message.length).toBeLessThan(400);
  });

  it('rejects a sign-in page instead of JSON', async () => {
    const html = new Response('<html>Sign in</html>', {
      status: 203,
      headers: { 'Content-Type': 'text/html' },
    });
    const error = await failure(
      createDevOpsApiForTests(BASE, TOKEN, mockFetch(html)).get('_apis/x')
    );
    expect(error.kind).toBe('parse');
    expect(error.message).toMatch(/didn’t return JSON/);
  });

  it('rejects broken JSON', async () => {
    const broken = new Response('{ "value": [', {
      headers: { 'Content-Type': 'application/json' },
    });
    const error = await failure(
      createDevOpsApiForTests(BASE, TOKEN, mockFetch(broken)).get('_apis/x')
    );
    expect(error.kind).toBe('parse');
  });

  it('reports network failures, timeouts and cancellation', async () => {
    const offline = await failure(
      createDevOpsApiForTests(BASE, TOKEN, mockFetch(new TypeError('Failed to fetch'))).get(
        '_apis/x'
      )
    );
    expect(offline).toMatchObject({ kind: 'network' });
    expect(offline.message).toMatch(/Couldn’t reach Azure DevOps/);

    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new Error('aborted'));
          }
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const slow = await failure(
      createDevOpsApiForTests(BASE, TOKEN, hanging, { timeoutMs: 10 }).get('_apis/x')
    );
    expect(slow.kind).toBe('timeout');

    const controller = new AbortController();
    const pending = createDevOpsApiForTests(BASE, TOKEN, hanging).get('_apis/x', {
      signal: controller.signal,
    });
    controller.abort();
    expect((await failure(pending)).kind).toBe('aborted');
  });

  it('reports a missing access token without calling Azure DevOps', async () => {
    const fetchImpl = mockFetch();
    const error = await failure(createDevOpsApiForTests(BASE, '  ', fetchImpl).get('_apis/x'));
    expect(error.message).toMatch(/Couldn’t get permission to call Azure DevOps/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the token in messages or logs', async () => {
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const messages: string[] = [];
    for (const response of [
      json({ message: `Bad token ${TOKEN.slice(0, 3)}` }, 403),
      json({}, 500),
      new TypeError('Failed to fetch'),
    ]) {
      const error = await failure(
        createDevOpsApiForTests(BASE, TOKEN, mockFetch(response, response)).get('_apis/x')
      );
      messages.push(error.message);
    }
    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
    }
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    }
  });
});

describe('DevOpsApi.post', () => {
  it('sends POST bodies as JSON, without cookies or redirects', async () => {
    const fetchImpl = mockFetch(json({ evaluations: [] }));
    const api = createDevOpsApiForTests(BASE, TOKEN, fetchImpl);
    const body = { alwaysAllowAdministrators: true, evaluations: [] };
    await expect(
      api.post('_apis/security/permissionevaluationbatch?api-version=7.1', body)
    ).resolves.toEqual({ evaluations: [] });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(
      'https://dev.azure.com/contoso/_apis/security/permissionevaluationbatch?api-version=7.1'
    );
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify(body),
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
    });
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-TFS-FedAuthRedirect': 'Suppress',
    });
  });

  it('never sends the token outside the organization', async () => {
    const fetchImpl = mockFetch();
    const api = createDevOpsApiForTests(BASE, TOKEN, fetchImpl);
    for (const path of ['../fabrikam/_apis/x', 'https://evil.example/_apis', '']) {
      const error = await failure(api.post(path, {}));
      expect(error.message).toMatch(/stay within the current organization/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tries once more with a fresh token after a 401', async () => {
    const tokens = ['expired-token', 'fresh-token'];
    const sdk: DevOpsSdk = {
      getAccessToken: async () => tokens.shift() ?? '',
      getService: async () => ({ getServiceLocation: async () => `${BASE}/` }),
      getExtensionContext: () => ({ id: 'publisher.extension' }),
      getHost: () => ({ id: 'host', name: 'contoso' }),
      getUser: () => ({ displayName: 'Ada', name: 'ada@contoso.com' }),
    };
    const fetchImpl = mockFetch(json({}, 401), json({ ok: true }));
    const api = await createDevOpsApi(sdk, fetchImpl);
    await expect(api.post('_apis/x', { a: 1 })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(call(fetchImpl, 1).init).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(call(fetchImpl, 1).init.headers).toMatchObject({ Authorization: 'Bearer fresh-token' });
  });

  it('explains refusals with the action', async () => {
    const error = await failure(
      createDevOpsApiForTests(BASE, TOKEN, mockFetch(json({ message: 'Denied.' }, 403))).post(
        '_apis/x',
        {},
        { action: 'check your permissions' }
      )
    );
    expect(error).toMatchObject({ kind: 'http', status: 403 });
    expect(error.message).toBe(
      'You don’t have permission to check your permissions (403). Denied.'
    );
    const general = await failure(
      createDevOpsApiForTests(BASE, TOKEN, mockFetch(json({}, 403))).post('_apis/x', {})
    );
    expect(general.message).toBe('You don’t have permission to make this change (403).');
  });
});

function sdkWithService(service: () => Promise<unknown>): DevOpsSdk {
  return {
    getAccessToken: async () => TOKEN,
    getService: service,
    getExtensionContext: () => ({ id: 'publisher.extension' }),
    getHost: () => ({ id: 'host', name: 'contoso' }),
    getUser: () => ({ displayName: 'Ada', name: 'ada@contoso.com' }),
  };
}

describe('createDevOpsApi', () => {
  it('reports a missing organization address', async () => {
    const sdk = sdkWithService;
    const missing = sdk(async () => {
      throw new Error('Service not found');
    });
    await expect(createDevOpsApi(missing, mockFetch())).rejects.toThrow(
      /valid organization address/
    );
    await expect(
      createDevOpsApi(
        sdk(async () => ({})),
        mockFetch()
      )
    ).rejects.toThrow(/valid organization address/);
    const http = sdk(async () => ({ getServiceLocation: async () => 'http://tfs.local/' }));
    await expect(createDevOpsApi(http, mockFetch())).rejects.toThrow(/valid organization address/);
  });
});
