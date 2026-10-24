import { describe, expect, it, vi } from 'vitest';
import { PicklistError } from './errors';
import type { SecurityPolicy } from './policy';
import { DEFAULT_POLICY } from './policy';
import type { RequestSettings } from './request';
import {
  MAX_RESPONSE_BYTES,
  authHeaders,
  fetchJsonResponse,
  prepareRequest,
  requestFieldDependencies,
  validateEndpoint,
} from './request';

const base: RequestSettings = {
  url: 'https://api.example.com/items',
  params: '',
  authMethod: 'none',
  username: '',
  password: '',
  apiKeyHeader: '',
};

function policy(overrides: Partial<SecurityPolicy>): SecurityPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

/** The error prepareRequest throws for these settings, or null when it doesn't throw. */
function configError(settings: Partial<RequestSettings>): unknown {
  try {
    prepareRequest({ ...base, ...settings });
  } catch (error) {
    return error;
  }
  return null;
}

describe('validateEndpoint', () => {
  it('requires https', () => {
    expect(validateEndpoint('https://api.example.com')).toBeNull();
    expect(validateEndpoint('http://api.example.com')).toMatch(/must use https/);
    expect(validateEndpoint('javascript:alert(1)')).toMatch(/full URL/);
    expect(validateEndpoint('ftp://api.example.com')).toMatch(/must use https/);
    expect(validateEndpoint('')).toMatch(/Add the REST endpoint/);
  });

  it('allows http://localhost only when the policy does', () => {
    expect(validateEndpoint('http://localhost:5000/api')).toMatch(
      /doesn’t allow http:\/\/localhost/
    );
    const local = policy({ allowLocalhost: true });
    expect(validateEndpoint('http://localhost:5000/api', local)).toBeNull();
    expect(validateEndpoint('http://127.0.0.1/api', local)).toBeNull();
    expect(validateEndpoint('http://[::1]:8080/api', local)).toBeNull();
    expect(validateEndpoint('http://intranet/api', local)).toMatch(/must use https/);
  });

  it('rejects field tokens in the host and credentials in the URL', () => {
    expect(validateEndpoint('https://$(Custom.Host)/items')).toMatch(/not in the host name/);
    expect(validateEndpoint('https://api.$(Custom.Env).example.com')).toMatch(/not in the host/);
    expect(validateEndpoint('https://user:secret@api.example.com')).toMatch(/Remove the user name/);
  });

  it('applies the allowed hosts and the private network block', () => {
    const hosts = policy({ allowedHosts: ['*.example.com'] });
    expect(validateEndpoint('https://api.example.com/$(Custom.Id)', hosts)).toBeNull();
    expect(validateEndpoint('https://api.evil.com/items', hosts)).toBe(
      'api.evil.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    const closed = policy({ blockPrivateNetworks: true });
    expect(validateEndpoint('https://10.1.2.3/items', closed)).toMatch(/private network/);
    expect(validateEndpoint('https://api.example.com/items', closed)).toBeNull();
  });
});

describe('authHeaders', () => {
  it('sends nothing without a sign-in method or secret', () => {
    expect(authHeaders({ ...base, password: 'secret' })).toEqual({});
    expect(authHeaders({ ...base, authMethod: 'bearer' })).toEqual({});
    expect(authHeaders({ ...base, authMethod: 'apiKey', password: ' \n' })).toEqual({});
    expect(authHeaders({ ...base, authMethod: 'basic' })).toEqual({});
  });

  it('encodes Basic credentials as UTF-8', () => {
    // "user:pässword" as UTF-8 bytes, base64-encoded.
    expect(
      authHeaders({ ...base, authMethod: 'basic', username: ' user ', password: 'pässword' })
    ).toEqual({ Authorization: 'Basic dXNlcjpww6Rzc3dvcmQ=' });
    // An empty user name is valid, for example with personal access tokens (":pat").
    expect(authHeaders({ ...base, authMethod: 'basic', password: 'pat' })).toEqual({
      Authorization: 'Basic OnBhdA==',
    });
    // Line breaks from a bad paste are dropped; other spaces are part of the password.
    expect(
      authHeaders({ ...base, authMethod: 'basic', username: 'u', password: ' p \r\n' })
    ).toEqual({ Authorization: `Basic ${btoa('u: p ')}` });
  });

  it('sends a bearer token, even when the prefix was pasted too', () => {
    expect(authHeaders({ ...base, authMethod: 'bearer', password: ' tok\n' })).toEqual({
      Authorization: 'Bearer tok',
    });
    expect(authHeaders({ ...base, authMethod: 'bearer', password: 'Bearer abc.def' })).toEqual({
      Authorization: 'Bearer abc.def',
    });
  });

  it('sends an OAuth 2.0 access token as a bearer token', () => {
    expect(authHeaders({ ...base, authMethod: 'oauth2', password: 'eyJ.access.token' })).toEqual({
      Authorization: 'Bearer eyJ.access.token',
    });
    // The user name never matters, and no token means no header.
    expect(authHeaders({ ...base, authMethod: 'oauth2', username: 'u', password: 't' })).toEqual({
      Authorization: 'Bearer t',
    });
    expect(authHeaders({ ...base, authMethod: 'oauth2' })).toEqual({});
  });

  it('sends an API key in the configured header', () => {
    expect(authHeaders({ ...base, authMethod: 'apiKey', password: 'k-1' })).toEqual({
      'x-api-key': 'k-1',
    });
    expect(
      authHeaders({
        ...base,
        authMethod: 'apiKey',
        password: 'k-1',
        apiKeyHeader: ' Ocp-Apim-Key ',
      })
    ).toEqual({ 'Ocp-Apim-Key': 'k-1' });
    // A header the browser controls never receives the secret.
    expect(
      authHeaders({ ...base, authMethod: 'apiKey', password: 'k-1', apiKeyHeader: 'Cookie' })
    ).toEqual({});
  });
});

describe('prepareRequest', () => {
  it('adds URL parameters with field values and keeps existing query strings', () => {
    const request = prepareRequest(
      {
        ...base,
        url: 'https://api.example.com/regions/$(Custom.Region)/items?active=true#top',
        params: '{ "q": "$(Custom.Name)", "ids": [1, 2], "filter": { "level": 3 }, "skip": null }',
      },
      { 'Custom.Region': 'EU/West', 'Custom.Name': 'A&B "C"' }
    );
    const url = new URL(request.url);
    expect(url.pathname).toBe('/regions/EU%2FWest/items');
    expect(url.searchParams.get('active')).toBe('true');
    expect(url.searchParams.get('q')).toBe('A&B "C"');
    expect(url.searchParams.getAll('ids[]')).toEqual(['1', '2']);
    expect(url.searchParams.get('filter[level]')).toBe('3');
    expect(url.searchParams.has('skip')).toBe(false);
    expect(url.hash).toBe('');
    expect(request.headers).toEqual({ Accept: 'application/json' });
  });

  it('lists the fields it depends on', () => {
    expect(
      requestFieldDependencies({ url: 'https://a.example/$(A)', params: '{"b":"$(B)"}' })
    ).toEqual(['A', 'B']);
  });

  it('reports bad parameter JSON clearly', () => {
    expect(() => prepareRequest({ ...base, params: '{ page: 2 }' })).toThrow(/isn’t valid JSON/);
    expect(() => prepareRequest({ ...base, params: '[1]' })).toThrow(/must be a JSON object/);
  });

  it('keeps field values from changing the host', () => {
    expect(() =>
      prepareRequest(
        { ...base, url: 'https://api.example.com$(Custom.Path)' },
        {
          'Custom.Path': '@evil.com',
        }
      )
    ).toThrow(PicklistError);
  });

  it('adds sign-in headers and keys the cache by them', () => {
    const bearer = prepareRequest({ ...base, authMethod: 'bearer', password: 'tok' });
    expect(bearer.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer tok' });
    const apiKey = prepareRequest({ ...base, authMethod: 'apiKey', password: 'key' });
    expect(apiKey.headers).toEqual({ Accept: 'application/json', 'x-api-key': 'key' });
    const other = prepareRequest({ ...base, authMethod: 'apiKey', password: 'other' });
    expect(new Set([bearer.cacheKey, apiKey.cacheKey, other.cacheKey]).size).toBe(3);
  });

  it('sends OAuth 2.0 access tokens with the same checks as bearer tokens', () => {
    const request = prepareRequest({ ...base, authMethod: 'oauth2', password: 'access-1' });
    expect(request.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer access-1',
    });
    // Signed in, so a redirect fails instead of taking the token elsewhere.
    expect(request.followRedirects).toBe(false);
    const renewed = prepareRequest({ ...base, authMethod: 'oauth2', password: 'access-2' });
    expect(renewed.cacheKey).not.toBe(request.cacheKey);
    expect(configError({ authMethod: 'oauth2', password: 'tokén' })).toMatchObject({
      kind: 'config',
      message: 'The access token from the token URL contains characters that can’t be sent.',
    });
    expect(() =>
      prepareRequest(
        { ...base, authMethod: 'oauth2', password: 't' },
        {},
        policy({ allowedAuthMethods: ['none', 'apiKey'] })
      )
    ).toThrow(
      'Your organization’s security policy doesn’t allow the “OAuth 2.0” sign-in method. Use None or API key.'
    );
  });

  it('rejects sign-in settings that could never work', () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    expect(configError({ authMethod: 'basic', username: 'a:b', password: 'p' })).toMatchObject({
      kind: 'config',
      message: expect.stringMatching(/colon/),
    });
    expect(configError({ authMethod: 'bearer', password: '“token”' })).toMatchObject({
      kind: 'config',
      message: expect.stringMatching(/Paste it again/),
    });
    expect(configError({ authMethod: 'apiKey', password: `k${zeroWidthSpace}` })).toMatchObject({
      kind: 'config',
      message: expect.stringMatching(/API key contains/),
    });
    expect(
      configError({ authMethod: 'apiKey', password: 'k', apiKeyHeader: 'Host' })
    ).toMatchObject({
      kind: 'config',
      message: expect.stringMatching(/can’t be used for an API key/),
    });
    expect(
      configError({ authMethod: 'apiKey', password: 'k', apiKeyHeader: 'x api key' })
    ).toMatchObject({
      kind: 'config',
      message: expect.stringMatching(/isn’t a valid header name/),
    });
  });

  it('enforces the organization’s policy', () => {
    const bearerOnly = policy({ allowedAuthMethods: ['bearer'] });
    expect(() =>
      prepareRequest({ ...base, authMethod: 'basic', username: 'u' }, {}, bearerOnly)
    ).toThrow(
      'Your organization’s security policy doesn’t allow the “Basic” sign-in method. Use Bearer token.'
    );
    expect(() => prepareRequest(base, {}, bearerOnly)).toThrow(/requires signing in/);
    expect(
      prepareRequest({ ...base, authMethod: 'bearer', password: 't' }, {}, bearerOnly).headers
    ).toHaveProperty('Authorization', 'Bearer t');
    expect(() => prepareRequest(base, {}, policy({ allowedHosts: ['other.example.com'] }))).toThrow(
      /list of allowed hosts/
    );
    expect(() => prepareRequest({ ...base, url: 'http://localhost/items' })).toThrow(/localhost/);
  });
});

describe('fetchJsonResponse', () => {
  const request = prepareRequest(base);
  const signedIn = prepareRequest({ ...base, authMethod: 'apiKey', password: 'key' });

  it('never sends cookies and returns the data, headers, status and final URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('{"ok":true}', { status: 200, headers: { Link: '<https://x>; rel="next"' } })
    );
    const result = await fetchJsonResponse(request, { fetchImpl });
    expect(result.data).toEqual({ ok: true });
    expect(result.status).toBe(200);
    expect(result.url).toBe(request.url);
    expect(result.headers.get('link')).toBe('<https://x>; rel="next"');
    expect(fetchImpl).toHaveBeenCalledWith(
      request.url,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      })
    );
  });

  it('doesn’t follow redirects when credentials are attached', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('[]'));
    await fetchJsonResponse(signedIn, { fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { 'x-api-key': 'key' },
    });
    const withToken = prepareRequest({ ...base, authMethod: 'oauth2', password: 'access' });
    await fetchJsonResponse(withToken, { fetchImpl });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer access' },
    });
    await expect(fetchJsonResponse(signedIn, { fetchImpl: offline })).rejects.toThrow(
      /Redirects aren’t followed here/
    );
  });

  it('doesn’t follow redirects when the policy restricts hosts', async () => {
    // The browser would contact a redirect's target before the host could be checked.
    for (const restricted of [
      policy({ allowedHosts: ['api.example.com'] }),
      policy({ blockPrivateNetworks: true }),
    ]) {
      const prepared = prepareRequest(base, {}, restricted);
      expect(prepared.followRedirects).toBe(false);
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('[]'));
      await fetchJsonResponse(prepared, { fetchImpl });
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    }
    expect(request.followRedirects).toBe(true);
    expect(signedIn.followRedirects).toBe(false);
  });

  it('accepts redirects within the site and reports the final URL', async () => {
    const fetchImpl = respondFrom('https://api.example.com/items/', '[1]');
    const result = await fetchJsonResponse(request, { fetchImpl });
    expect(result).toMatchObject({ data: [1], url: 'https://api.example.com/items/' });
  });

  it('refuses a redirect to another site', async () => {
    const fetchImpl = respondFrom('https://elsewhere.example.net/items', '[1]');
    await expect(fetchJsonResponse(request, { fetchImpl })).rejects.toThrow(
      /redirected the request to another site \(elsewhere\.example\.net\)/
    );
  });

  it('treats an empty body as null', async () => {
    const result = await fetchJsonResponse(request, { fetchImpl: respondWith('', 200) });
    expect(result.data).toBeNull();
    const noContent = await fetchJsonResponse(request, {
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(noContent).toMatchObject({ data: null, status: 204 });
  });

  it('doesn’t start a request that was already cancelled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchJsonResponse(request, { fetchImpl, signal: controller.signal })
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a cancellation during the request', async () => {
    const controller = new AbortController();
    const pending = fetchJsonResponse(request, {
      fetchImpl: neverResponds,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('fetchJsonResponse failures', () => {
  const request = prepareRequest(base);

  it('returns the parsed JSON', async () => {
    await expect(
      fetchJsonResponse(request, { fetchImpl: respondWith('{"ok":true}', 200) })
    ).resolves.toMatchObject({ data: { ok: true }, status: 200 });
  });

  it('turns failures into readable errors', async () => {
    await expect(fetchJsonResponse(request, { fetchImpl: respondWith('', 401) })).rejects.toThrow(
      /refused access \(401\)\. Check the sign-in settings/
    );
    await expect(fetchJsonResponse(request, { fetchImpl: respondWith('', 404) })).rejects.toThrow(
      /wasn’t found \(404\)/
    );
    await expect(fetchJsonResponse(request, { fetchImpl: respondWith('', 429) })).rejects.toThrow(
      /limiting requests/
    );
    await expect(fetchJsonResponse(request, { fetchImpl: respondWith('', 503) })).rejects.toThrow(
      /had a problem \(503\)/
    );
    await expect(fetchJsonResponse(request, { fetchImpl: respondWith('', 418) })).rejects.toThrow(
      /returned an error \(418\)/
    );
    await expect(
      fetchJsonResponse(request, { fetchImpl: respondWith('<html>', 200) })
    ).rejects.toThrow(/didn’t return JSON\. It sent a web page/);
    await expect(
      fetchJsonResponse(request, { fetchImpl: respondWith('nope', 200) })
    ).rejects.toThrow(/^The service didn’t return JSON\.$/);
    await expect(fetchJsonResponse(request, { fetchImpl: offline })).rejects.toThrow(/CORS\)\.$/);
  });

  it('refuses an answer too large for a list without reading it all', async () => {
    const declared = vi.fn<typeof fetch>(
      async () =>
        new Response('[]', {
          status: 200,
          headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) },
        })
    );
    await expect(fetchJsonResponse(request, { fetchImpl: declared })).rejects.toMatchObject({
      kind: 'parse',
      message:
        'The service’s answer is larger than 64 MB, which is too much for a list. Ask for less, for example with paging.',
    });
  });

  it('never repeats the response body in an error', async () => {
    const secretBody = '<html>token=abc123</html>';
    for (const status of [200, 500]) {
      await expect(
        fetchJsonResponse(request, { fetchImpl: respondWith(secretBody, status) })
      ).rejects.toMatchObject({ message: expect.not.stringContaining('abc123') });
    }
  });

  it('gives up after the timeout', async () => {
    await expect(
      fetchJsonResponse(request, { fetchImpl: neverResponds, timeoutMs: 10 })
    ).rejects.toThrow(/too long/);
  });
});

function respondWith(body: string, status: number): typeof fetch {
  return async () => new Response(body, { status });
}

/** A response whose final URL differs from the request, as after a redirect. */
function respondFrom(finalUrl: string, body: string): typeof fetch {
  return async () => {
    const response = new Response(body, { status: 200 });
    Object.defineProperty(response, 'url', { value: finalUrl });
    return response;
  };
}

async function offline(): Promise<Response> {
  throw new TypeError('Failed to fetch');
}

function neverResponds(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
  });
}
