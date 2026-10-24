import type { AuthMethod } from './config';
import { DEFAULT_API_KEY_HEADER, validateHeaderName } from './config';
import { PicklistError } from './errors';
import type { SecurityPolicy } from './policy';
import { DEFAULT_POLICY, checkAuthMethod, checkEndpoint } from './policy';
import { readLimitedText } from './responseBody';
import { findFieldTokens, substituteForJson, substituteForUrl } from './tokens';
import { isPlainObject, scalarToString } from './values';

export interface RequestSettings {
  url: string;
  params: string;
  authMethod: AuthMethod;
  username: string;
  /**
   * The password, token or API key, depending on the sign-in method. For OAuth 2.0, the access
   * token from the token URL: the client's own secret never goes to the API.
   */
  password: string;
  /** Header that carries the API key. Empty: x-api-key. */
  apiKeyHeader: string;
}

export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  /** Identifies identical requests so a response can be reused. Kept in memory only. */
  cacheKey: string;
  /**
   * False when a redirect must fail instead of being followed. The browser contacts a redirect's
   * target before the extension can check it, so redirects are off whenever the request signs in
   * or the organization's policy restricts hosts. Missing: follow unless the request signs in.
   */
  followRedirects?: boolean;
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchedJson {
  /** The parsed body; null when the body was empty. */
  data: unknown;
  headers: Headers;
  /** The URL that answered, after any same-site redirect. */
  url: string;
  status: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ORIGIN_PATTERN = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)/i;

/**
 * The most one response may hold. Far more than a list of 50,000 items (the most a policy
 * allows) needs; it stops a service that keeps sending from filling the page's memory.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Work item fields whose values are inserted into the request. */
export function requestFieldDependencies(settings: Pick<RequestSettings, 'url' | 'params'>) {
  return findFieldTokens(settings.url, settings.params);
}

/**
 * Returns a description of what's wrong with the endpoint URL, or null when it's usable. The
 * scheme and host are checked against the organization's policy before field values are added.
 */
export function validateEndpoint(
  template: string,
  policy: SecurityPolicy = DEFAULT_POLICY
): string | null {
  const trimmed = template.trim();
  if (!trimmed) {
    return 'Add the REST endpoint URL.';
  }
  const origin = ORIGIN_PATTERN.exec(trimmed);
  if (!origin) {
    return 'Use a full URL, for example https://api.example.com/items.';
  }
  if (origin[0].includes('$(')) {
    return 'Field values can be used in the path or query string, but not in the host name.';
  }
  let parsed: URL;
  try {
    parsed = new URL(origin[0]);
  } catch {
    return 'The endpoint URL isn’t valid.';
  }
  if (parsed.username || parsed.password) {
    return 'Remove the user name and password from the URL and use the sign-in settings instead.';
  }
  return checkEndpoint(parsed, policy);
}

export function parseParameters(
  template: string,
  fieldValues: Record<string, unknown> = {}
): Record<string, unknown> {
  if (!template.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(substituteForJson(template, fieldValues));
  } catch {
    throw new PicklistError(
      'config',
      'The URL parameters setting isn’t valid JSON. Example: { "page": "2" }'
    );
  }
  if (!isPlainObject(parsed)) {
    throw new PicklistError(
      'config',
      'The URL parameters setting must be a JSON object, for example { "page": "2" }.'
    );
  }
  return parsed;
}

// Same shape as the axios serializer used before 2.0: `key[]=a` for arrays, `key[sub]=b` for objects.
function appendParameter(search: URLSearchParams, key: string, value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      appendParameter(search, `${key}[]`, item);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      appendParameter(search, `${key}[${childKey}]`, childValue);
    }
    return;
  }
  const text = scalarToString(value);
  if (text !== undefined) {
    search.append(key, text);
  }
}

/** Base64 of the UTF-8 bytes, so user names and passwords outside ASCII survive. */
function encodeBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// Line breaks can't appear in a header and usually come from a bad paste.
function cleanSecret(secret: string): string {
  return secret.replace(/[\r\n]/g, '');
}

/** The token without a pasted "Bearer " prefix. */
function bearerToken(secret: string): string {
  const token = cleanSecret(secret).trim();
  return token.toLowerCase().startsWith('bearer ') ? token.slice(7).trim() : token;
}

function apiKeyHeaderName(name: string): string {
  return name.trim() || DEFAULT_API_KEY_HEADER;
}

/**
 * The headers that sign a request in: Basic (user name and password), a bearer token (also an
 * OAuth 2.0 access token), or an API key in a header. Empty when there's nothing to send, or when
 * the API key header isn't allowed.
 */
export function authHeaders(
  settings: Pick<RequestSettings, 'authMethod' | 'username' | 'password' | 'apiKeyHeader'>
): Record<string, string> {
  switch (settings.authMethod) {
    case 'basic': {
      const user = settings.username.trim();
      const password = cleanSecret(settings.password);
      // An empty user name with a password is valid, for example with personal access tokens.
      return user || password
        ? { Authorization: `Basic ${encodeBase64(`${user}:${password}`)}` }
        : {};
    }
    case 'bearer':
    case 'oauth2': {
      const token = bearerToken(settings.password);
      return token ? { Authorization: `Bearer ${token}` } : {};
    }
    case 'apiKey': {
      const key = cleanSecret(settings.password).trim();
      const name = apiKeyHeaderName(settings.apiKeyHeader);
      // Never put a secret into a header the browser or a proxy treats specially.
      return key && !validateHeaderName(name) ? { [name]: key } : {};
    }
    default:
      return {};
  }
}

/** Header values must be printable ASCII; anything else usually means a bad paste. */
function isHeaderSafe(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function credentialProblem(settings: RequestSettings): string | null {
  switch (settings.authMethod) {
    case 'basic':
      return settings.username.includes(':')
        ? 'The user name can’t contain a colon (:). Check the sign-in settings.'
        : null;
    case 'bearer':
      return isHeaderSafe(bearerToken(settings.password))
        ? null
        : 'The token contains characters that can’t be sent, such as curly quotes or hidden spaces. Paste it again as plain text.';
    case 'oauth2':
      return isHeaderSafe(bearerToken(settings.password))
        ? null
        : 'The access token from the token URL contains characters that can’t be sent.';
    case 'apiKey': {
      const headerProblem = validateHeaderName(apiKeyHeaderName(settings.apiKeyHeader));
      if (headerProblem) {
        return headerProblem;
      }
      return isHeaderSafe(cleanSecret(settings.password).trim())
        ? null
        : 'The API key contains characters that can’t be sent, such as curly quotes or hidden spaces. Paste it again as plain text.';
    }
    default:
      return null;
  }
}

export function prepareRequest(
  settings: RequestSettings,
  fieldValues: Record<string, unknown> = {},
  policy: SecurityPolicy = DEFAULT_POLICY
): PreparedRequest {
  const template = settings.url.trim();
  const problem = validateEndpoint(template, policy);
  const origin = ORIGIN_PATTERN.exec(template);
  if (problem || !origin) {
    throw new PicklistError('config', problem ?? 'The endpoint URL isn’t valid.');
  }
  const authProblem = checkAuthMethod(settings.authMethod, policy) ?? credentialProblem(settings);
  if (authProblem) {
    throw new PicklistError('config', authProblem);
  }
  const expectedOrigin = new URL(origin[0]).origin;

  let url: URL;
  try {
    url = new URL(substituteForUrl(template, fieldValues));
  } catch {
    throw new PicklistError('config', 'The endpoint URL isn’t valid once field values are added.');
  }
  // Defense in depth: work item values must never redirect credentials to another host.
  if (url.origin !== expectedOrigin) {
    throw new PicklistError('config', 'Field values can’t change the endpoint’s host.');
  }
  const finalProblem = checkEndpoint(url, policy);
  if (finalProblem) {
    throw new PicklistError('config', finalProblem);
  }

  const extra = new URLSearchParams();
  for (const [key, value] of Object.entries(parseParameters(settings.params, fieldValues))) {
    appendParameter(extra, key, value);
  }
  url.hash = '';
  let href = url.href;
  const query = extra.toString();
  if (query) {
    href += href.endsWith('?') ? query : `${url.search ? '&' : '?'}${query}`;
  }

  const auth = authHeaders(settings);
  const headers: Record<string, string> = { Accept: 'application/json', ...auth };
  const restrictsHosts = policy.allowedHosts.length > 0 || policy.blockPrivateNetworks;
  return {
    url: href,
    headers,
    cacheKey: `${href}\n${JSON.stringify(auth)}`,
    followRedirects: !carriesCredentials(headers) && !restrictsHosts,
  };
}

function httpError(status: number): PicklistError {
  if (status === 401 || status === 403) {
    return new PicklistError(
      'http',
      `The service refused access (${status}). Check the sign-in settings.`,
      status
    );
  }
  if (status === 404) {
    return new PicklistError('http', 'The endpoint wasn’t found (404). Check the URL.', status);
  }
  // The list shows its own "Try again" button, so these messages don't repeat the advice.
  if (status === 429) {
    return new PicklistError('http', 'The service is limiting requests (429).', status);
  }
  if (status >= 500) {
    return new PicklistError('http', `The service had a problem (${status}).`, status);
  }
  return new PicklistError('http', `The service returned an error (${status}).`, status);
}

/** Any header besides Accept may carry a credential. */
function carriesCredentials(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() !== 'accept');
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * GETs JSON with a timeout and returns it with the response headers and final URL. Cookies are
 * never sent. Signed-in requests don't follow redirects, because the browser would forward an API
 * key header to wherever the redirect points; other requests may only be redirected within the
 * same site.
 */
export async function fetchJsonResponse(
  request: PreparedRequest,
  options: FetchOptions = {}
): Promise<FetchedJson> {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (signal?.aborted) {
    throw new PicklistError('aborted', 'The request was cancelled.');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const signedIn = carriesCredentials(request.headers);
  const followRedirects = !signedIn && request.followRedirects !== false;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const failure = (): PicklistError => {
    if (timedOut) {
      return new PicklistError('timeout', 'The service took too long to respond.');
    }
    if (signal?.aborted) {
      return new PicklistError('aborted', 'The request was cancelled.');
    }
    return new PicklistError(
      'network',
      followRedirects
        ? 'Couldn’t reach the service. Check the URL and that it allows requests from Azure DevOps (CORS).'
        : 'Couldn’t reach the service. Check the URL and that it allows requests from Azure DevOps (CORS). Redirects aren’t followed here, so use the final address.'
    );
  };

  try {
    let response: Response;
    let body: string;
    let finalUrl: string;
    try {
      response = await fetchImpl(request.url, {
        method: 'GET',
        headers: request.headers,
        credentials: 'omit',
        mode: 'cors',
        redirect: followRedirects ? 'follow' : 'error',
        signal: controller.signal,
      });
      finalUrl = response.url || request.url;
      const finalOrigin = originOf(finalUrl);
      if (finalOrigin !== originOf(request.url)) {
        const host = finalOrigin ? new URL(finalUrl).hostname : 'another address';
        throw new PicklistError(
          'http',
          `The service redirected the request to another site (${host}). Use that address as the endpoint URL if you trust it.`
        );
      }
      if (!response.ok) {
        throw httpError(response.status);
      }
      const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
      if (text === null) {
        throw new PicklistError(
          'parse',
          'The service’s answer is larger than 64 MB, which is too much for a list. Ask for less, for example with paging.'
        );
      }
      body = text;
    } catch (error) {
      throw error instanceof PicklistError ? error : failure();
    }
    if (!body.trim()) {
      return { data: null, headers: response.headers, url: finalUrl, status: response.status };
    }
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw new PicklistError(
        'parse',
        body.trimStart().startsWith('<')
          ? 'The service didn’t return JSON. It sent a web page, often a sign-in page, so check the URL and sign-in settings.'
          : 'The service didn’t return JSON.'
      );
    }
    return { data, headers: response.headers, url: finalUrl, status: response.status };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
