import { describe, expect, it, vi } from 'vitest';
import { RSA_2048 } from '../core/__fixtures__/credentials';
import { DEFAULT_ADVANCED, DEFAULT_OAUTH } from '../core/config';
import { PicklistError } from '../core/errors';
import { ENTRA_BROWSER_WARNING } from '../core/oauth';
import { DEFAULT_POLICY, parsePolicy } from '../core/policy';
import type { StoredSecret } from '../core/secrets';
import type { ProbeCredential } from './probe';
import {
  TokenStepError,
  countScope,
  describeFailure,
  locateCurrentRows,
  probeKey,
  runProbe,
  secretFingerprint,
} from './probe';
import type { Draft } from './settings';
import { EMPTY_DRAFT } from './settings';

vi.mock('azure-devops-extension-sdk', () => ({}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The form-encoded body a request was sent with. */
function sentBody(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

const PAGES: Record<string, unknown> = {
  'https://api.contoso.com/items': {
    value: [{ name: 'A' }, { name: 'B' }],
    '@odata.nextLink': 'https://api.contoso.com/items?page=2',
  },
  'https://api.contoso.com/items?page=2': { value: [{ name: 'C' }] },
};

const draft: Draft = {
  ...EMPTY_DRAFT,
  url: 'https://api.contoso.com/items',
  authMethod: 'apiKey',
  advanced: { ...DEFAULT_ADVANCED, paging: { type: 'nextLink', nextLink: '', maxPages: 10 } },
};

const API_KEY: ProbeCredential = { secret: { kind: 'apiKey', value: 'k3y' }, source: 'entered' };

function pagedFetch() {
  return vi.fn<typeof fetch>(async (input) => json(PAGES[urlOf(input)] ?? {}, 200));
}

/** One probe of the paged sample API, with some settings changed. */
function run(mode: 'test' | 'detect', changes: Partial<Draft> = {}) {
  return runProbe({
    draft: { ...draft, ...changes },
    samples: {},
    policy: DEFAULT_POLICY,
    mode,
    credential: API_KEY,
    fetchImpl: pagedFetch(),
  });
}

describe('runProbe', () => {
  it('loads every page like the control, and describes sign-in without the key', async () => {
    const fetchImpl = pagedFetch();
    const progress: number[] = [];
    const result = await runProbe({
      draft,
      samples: {},
      policy: DEFAULT_POLICY,
      mode: 'test',
      credential: API_KEY,
      fetchImpl,
      onProgress: (update) => progress.push(update.rows.length),
    });
    expect(result.rows).toEqual([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    expect(result.pages).toBe(2);
    expect(result.arrayPath).toBe('value');
    expect(result.signIn).toBe('API key (x-api-key)');
    expect(result.secretSource).toBe('entered');
    expect(result.token).toBeNull();
    expect(result.httpStatus).toBe(200);
    expect(progress).toEqual([2, 3, 3]);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-api-key')).toBe('k3y');
    expect(JSON.stringify(result)).not.toContain('k3y');
  });

  it('stops after the first page for Detect', async () => {
    const result = await run('detect');
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('refuses requests the policy blocks before calling anything', async () => {
    const fetchImpl = pagedFetch();
    await expect(
      runProbe({
        draft,
        samples: {},
        policy: parsePolicy({ allowedAuthMethods: ['none'] }),
        mode: 'test',
        credential: API_KEY,
        fetchImpl,
      })
    ).rejects.toThrow(PicklistError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never sends a secret meant for another kind of sign-in', async () => {
    const fetchImpl = pagedFetch();
    await expect(
      runProbe({
        draft,
        samples: {},
        policy: DEFAULT_POLICY,
        mode: 'test',
        credential: { secret: { kind: 'password', value: 'p' }, source: 'saved' },
        fetchImpl,
      })
    ).rejects.toThrow('The secret doesn’t match the sign-in method.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-reads the first response when the list path changes', async () => {
    const result = await runProbe({
      draft,
      samples: {},
      policy: DEFAULT_POLICY,
      mode: 'test',
      credential: API_KEY,
      credentialId: secretFingerprint(API_KEY.secret),
      fetchImpl: pagedFetch(),
    });
    expect(locateCurrentRows(result, '').rows).toHaveLength(3);
    const moved = locateCurrentRows(result, 'value');
    expect(moved.rows).toHaveLength(2);
    expect(moved.firstPageOnly).toBe(true);
    expect(locateCurrentRows(result, 'nothing.here').error).toBe(
      'No list was found at “nothing.here” in the response.'
    );
    const id = secretFingerprint(API_KEY.secret);
    expect(result.key).toBe(probeKey(draft, {}, DEFAULT_POLICY, id));
    expect(result.key).not.toBe(
      probeKey({ ...draft, params: '{"a":"1"}' }, {}, DEFAULT_POLICY, id)
    );
    // Another key makes the result out of date too, without the key being part of it.
    const other = secretFingerprint({ kind: 'apiKey', value: 'other' });
    expect(result.key).not.toBe(probeKey(draft, {}, DEFAULT_POLICY, other));
    expect(other).not.toContain('other');
  });

  it('says what the counts cover: every page, the first of more, or up to a limit', async () => {
    const test = await run('test');
    expect(test.paged).toBe(true);
    expect(countScope(test)).toEqual({ pages: 2, firstPageOfMore: false, limited: false });

    // Detect reads one page of a paged list: its counts are the first page's.
    expect(countScope(await run('detect'))).toEqual({
      pages: 1,
      firstPageOfMore: true,
      limited: false,
    });

    // Without paging the first response is the whole list; only the item limit can cut it.
    const limited = await run('test', {
      advanced: { ...DEFAULT_ADVANCED, maxItems: 1 },
    });
    expect(limited.paged).toBe(false);
    expect(countScope(limited)).toEqual({ pages: 1, firstPageOfMore: false, limited: true });
    expect(
      countScope(await run('test', { advanced: { ...DEFAULT_ADVANCED, maxItems: 10 } }))
    ).toEqual({ pages: 1, firstPageOfMore: false, limited: false });
  });

  it('marks network failures so the page can mention CORS', () => {
    expect(describeFailure(new PicklistError('network', 'Couldn’t reach the service.'))).toEqual({
      message: 'Couldn’t reach the service.',
      network: true,
      httpStatus: undefined,
      step: 'request',
    });
  });
});

describe('runProbe with OAuth 2.0', () => {
  const TOKEN_URL = 'https://auth.contoso.com/oauth2/token';
  const oauthDraft: Draft = {
    ...EMPTY_DRAFT,
    url: 'https://api.contoso.com/items',
    authMethod: 'oauth2',
    oauth: { ...DEFAULT_OAUTH, tokenUrl: TOKEN_URL, clientId: 'picklist', extraParams: {} },
  };
  const NOW = Date.UTC(2026, 9, 22, 12);

  /** A token service and the API behind it; the API only answers with the right token. */
  function services(
    tokenResponse: () => Response = () =>
      json({ access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 })
  ) {
    return vi.fn<typeof fetch>(async (input, init) => {
      const url = urlOf(input);
      if (url === TOKEN_URL) {
        return tokenResponse();
      }
      const authorization = new Headers(init?.headers).get('authorization');
      return authorization === 'Bearer tok-123'
        ? json({ value: [{ name: 'A' }] })
        : json({ error: 'no' }, 401);
    });
  }

  function probe(
    fetchImpl: typeof fetch,
    secret: StoredSecret,
    patch: Partial<Draft> = {},
    onToken?: (token: { expiresAt: number } | null) => void
  ) {
    return runProbe({
      draft: { ...oauthDraft, ...patch },
      samples: {},
      policy: DEFAULT_POLICY,
      mode: 'test',
      credential: { secret, source: 'saved' },
      fetchImpl,
      onToken,
      now: () => NOW,
    });
  }

  it('gets a token with the client secret first, then calls the API with only the token', async () => {
    const fetchImpl = services();
    const steps: Array<{ expiresAt: number } | null> = [];
    const result = await probe(fetchImpl, { kind: 'clientSecret', value: 's3cret!' }, {}, (token) =>
      steps.push(token)
    );
    expect(result.rows).toEqual([{ name: 'A' }]);
    expect(result.signIn).toBe('OAuth 2.0 with a client secret');
    expect(result.secretSource).toBe('saved');
    // Used until a minute before it expires: 59 minutes from now.
    expect(result.token).toEqual({ expiresAt: NOW + 3_540_000 });
    expect(steps).toEqual([null, { expiresAt: NOW + 3_540_000 }]);

    const [tokenCall, apiCall] = fetchImpl.mock.calls;
    expect(urlOf(tokenCall?.[0] ?? '')).toBe(TOKEN_URL);
    expect(tokenCall?.[1]?.method).toBe('POST');
    expect(new Headers(tokenCall?.[1]?.headers).get('authorization')).toMatch(/^Basic /);
    expect(sentBody(tokenCall?.[1])).toBe('grant_type=client_credentials');
    expect(new Headers(apiCall?.[1]?.headers).get('authorization')).toBe('Bearer tok-123');
    // Neither the token nor the secret ever reaches the result.
    expect(JSON.stringify(result)).not.toContain('tok-123');
    expect(JSON.stringify(result)).not.toContain('s3cret');
  });

  it('can send the client credentials in the body', async () => {
    const fetchImpl = services();
    await probe(
      fetchImpl,
      { kind: 'clientSecret', value: 's3cret' },
      { oauth: { ...oauthDraft.oauth, clientAuthentication: 'body' } }
    );
    const tokenCall = fetchImpl.mock.calls[0];
    expect(new Headers(tokenCall?.[1]?.headers).get('authorization')).toBeNull();
    expect(new URLSearchParams(sentBody(tokenCall?.[1])).get('client_secret')).toBe('s3cret');
  });

  it('signs a JWT with a certificate’s key instead of sending a secret', async () => {
    const fetchImpl = services();
    const pkcs8 = RSA_2048.pkcs8.replace(/\s+/g, '');
    const result = await probe(
      fetchImpl,
      { kind: 'signingKey', key: { pkcs8, algorithm: 'RS256', kid: 'key-1' } },
      { credential: 'certificate' }
    );
    expect(result.signIn).toBe('OAuth 2.0 with a certificate');
    const body = new URLSearchParams(sentBody(fetchImpl.mock.calls[0]?.[1]));
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    );
    const [header] = (body.get('client_assertion') ?? '').split('.');
    expect(JSON.parse(atob((header ?? '').replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'key-1',
    });
    expect(body.get('client_secret')).toBeNull();
    expect(JSON.stringify(result)).not.toContain(pkcs8.slice(0, 40));
  });

  it('stops at the token step when the token service refuses, without calling the API', async () => {
    const fetchImpl = services(() =>
      json({ error: 'invalid_client', error_description: 'Unknown client.' }, 401)
    );
    const failure = await probe(fetchImpl, { kind: 'clientSecret', value: 'wrong' }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(TokenStepError);
    expect(describeFailure(failure)).toEqual({
      message: 'The token service refused the request (invalid_client: Unknown client.).',
      network: false,
      httpStatus: 401,
      step: 'token',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('explains why Microsoft Entra ID can’t be reached from a browser', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const failure = await probe(
      fetchImpl,
      { kind: 'clientSecret', value: 's3cret' },
      {
        oauth: {
          ...oauthDraft.oauth,
          tokenUrl: 'https://login.microsoftonline.com/contoso/oauth2/v2.0/token',
        },
      }
    ).catch((error: unknown) => error);
    const described = describeFailure(failure);
    expect(described.step).toBe('token');
    expect(described.network).toBe(true);
    expect(described.message).toBe(
      `Couldn’t reach the token URL. It must allow requests from Azure DevOps (CORS). ${ENTRA_BROWSER_WARNING}`
    );
  });

  it('needs a secret before it asks for a token, and checks the API request first', async () => {
    const fetchImpl = services();
    await expect(
      runProbe({
        draft: oauthDraft,
        samples: {},
        policy: DEFAULT_POLICY,
        mode: 'test',
        credential: null,
        fetchImpl,
      })
    ).rejects.toThrow('Enter the client secret, or choose the certificate, to get a token.');
    await expect(
      probe(fetchImpl, { kind: 'clientSecret', value: 's' }, { url: 'http://api.contoso.com/x' })
    ).rejects.toThrow('The endpoint must use https://.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
