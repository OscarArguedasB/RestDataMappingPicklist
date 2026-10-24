import * as SDK from 'azure-devops-extension-sdk';
import { PicklistError } from '../core/errors';
import { isPlainObject } from '../core/values';

export const API_VERSION = '7.1';
export const LOCATION_SERVICE_ID = 'ms.vss-features.location-service';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DETAIL_LENGTH = 300;

/** The part of azure-devops-extension-api's location service this extension uses. */
export interface LocationService {
  /** With no arguments: the current organization's URL, such as https://dev.azure.com/contoso/. */
  getServiceLocation(serviceInstanceType?: string, hostType?: number): Promise<string>;
}

/** The parts of azure-devops-extension-sdk this layer uses. Tests pass their own. */
export interface DevOpsSdk {
  getAccessToken(): Promise<string>;
  /** Unknown on purpose: services come from the host page, so callers check their shape. */
  getService(contributionId: string): Promise<unknown>;
  getExtensionContext(): { id: string };
  getHost(): { id: string; name: string };
  getUser(): { displayName: string; name: string };
}

// Wrappers rather than the functions themselves, so the SDK is only touched when used.
export const devOpsSdk: DevOpsSdk = {
  getAccessToken: () => SDK.getAccessToken(),
  getService: (contributionId: string) => SDK.getService<unknown>(contributionId),
  getExtensionContext: () => SDK.getExtensionContext(),
  getHost: () => SDK.getHost(),
  getUser: () => SDK.getUser(),
};

export interface DevOpsRequestOptions {
  /** Completes “You don’t have permission to …” when Azure DevOps refuses the request. */
  action?: string;
  signal?: AbortSignal;
}

/** Calls the Azure DevOps REST API of the current organization as the signed-in user. */
export interface DevOpsApi {
  /** The organization (collection) URL that paths are relative to. Always ends with “/”. */
  readonly collectionUrl: string;
  /**
   * `path` is relative to the organization, like `_apis/work/processes`. The parsed JSON comes back
   * as `unknown` on purpose: callers check its shape before using it.
   */
  get(path: string, options?: DevOpsRequestOptions): Promise<unknown>;
  patch(path: string, body: unknown, options?: DevOpsRequestOptions): Promise<unknown>;
  /** Also for questions with a body, such as permission checks. Same rules as get and patch. */
  post(path: string, body: unknown, options?: DevOpsRequestOptions): Promise<unknown>;
}

interface ApiSettings {
  collectionUrl: string;
  getToken: () => Promise<string>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

function isLocationService(value: unknown): value is LocationService {
  return isPlainObject(value) && typeof value.getServiceLocation === 'function';
}

function invalidAddress(): PicklistError {
  return new PicklistError(
    'config',
    'Azure DevOps didn’t provide a valid organization address. Reload the page and try again.'
  );
}

function normalizeCollectionUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidAddress();
  }
  // The access token must never travel unencrypted or to an address with embedded credentials.
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw invalidAddress();
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url;
}

/** Resolves a path against the organization URL and adds `api-version` when it's missing. */
function resolveApiUrl(base: URL, path: string): string {
  const relative = path.trim().replace(/^\/+/, '');
  const outside = new PicklistError(
    'config',
    'Azure DevOps requests must stay within the current organization.'
  );
  if (!relative || /^[a-z][a-z\d+.-]*:/i.test(relative)) {
    throw outside;
  }
  const url = new URL(relative, base);
  // The token is only for this organization: "../" or "//host" must not lead anywhere else.
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw outside;
  }
  url.hash = '';
  if (url.searchParams.has('api-version')) {
    return url.href;
  }
  // Appended by hand: rewriting searchParams would re-encode names like $expand.
  return `${url.href}${url.search ? '&' : '?'}api-version=${API_VERSION}`;
}

function cleanDetail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}

/** Azure DevOps explains most failures in a JSON body: `{ "message": "VS402…: …" }`. */
async function serverDetail(response: Response): Promise<string> {
  try {
    const body: unknown = JSON.parse(await response.text());
    return isPlainObject(body) ? cleanDetail(body.message) : '';
  } catch {
    return '';
  }
}

function httpError(status: number, action: string, detail: string): PicklistError {
  const suffix = detail ? ` ${detail}` : '';
  if (status === 401 || status === 403) {
    return new PicklistError(
      'http',
      `You don’t have permission to ${action} (${status}).${status === 403 ? suffix : ''}`,
      status
    );
  }
  if (status === 404) {
    return new PicklistError(
      'http',
      `Azure DevOps couldn’t find what was requested (404).${suffix}`,
      status
    );
  }
  if (status === 409 || status === 412) {
    return new PicklistError(
      'http',
      `Someone changed this at the same time (${status}). Refresh and try again.${suffix}`,
      status
    );
  }
  if (status === 429) {
    return new PicklistError(
      'http',
      'Azure DevOps is limiting requests (429). Wait a moment and try again.',
      status
    );
  }
  if (status >= 500) {
    return new PicklistError(
      'http',
      `Azure DevOps had a problem (${status}). Try again in a moment.`,
      status
    );
  }
  return new PicklistError('http', `Azure DevOps returned an error (${status}).${suffix}`, status);
}

const NOT_JSON = 'Azure DevOps didn’t return JSON. Your sign-in may have expired: reload the page.';

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  // A sign-in page comes back as HTML with status 203, which still counts as "ok".
  if (!/json/i.test(response.headers.get('content-type') ?? '')) {
    throw new PicklistError('parse', NOT_JSON);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PicklistError('parse', NOT_JSON);
  }
}

function createApi(settings: ApiSettings): DevOpsApi {
  const base = normalizeCollectionUrl(settings.collectionUrl);

  async function token(): Promise<string> {
    let value: unknown;
    try {
      value = await settings.getToken();
    } catch {
      value = '';
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new PicklistError(
        'network',
        'Couldn’t get permission to call Azure DevOps. Reload the page and try again.'
      );
    }
    return value.trim();
  }

  async function send(
    method: 'GET' | 'PATCH' | 'POST',
    path: string,
    body: unknown,
    options: DevOpsRequestOptions
  ): Promise<unknown> {
    const url = resolveApiUrl(base, path);
    const action =
      options.action ?? (method === 'GET' ? 'read this from Azure DevOps' : 'make this change');
    const { signal } = options;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.timeoutMs);

    // Error messages never include the URL's query, the headers or the token.
    const failure = (): PicklistError => {
      if (timedOut) {
        return new PicklistError('timeout', 'Azure DevOps took too long to respond.');
      }
      if (signal?.aborted) {
        return new PicklistError('aborted', 'The request was cancelled.');
      }
      return new PicklistError(
        'network',
        'Couldn’t reach Azure DevOps. Check your connection and try again.'
      );
    };

    const attempt = async (): Promise<Response> => {
      const accessToken = await token();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        // Like Microsoft's own client: answer 401 instead of redirecting to a sign-in page.
        'X-TFS-FedAuthRedirect': 'Suppress',
        'X-VSS-ReauthenticationAction': 'Suppress',
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      // Cancelled or timed out while waiting for the token.
      if (controller.signal.aborted) {
        throw failure();
      }
      try {
        return await settings.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // The bearer token is enough; cookies are never needed.
          credentials: 'omit',
          mode: 'cors',
          // A redirect could carry the token elsewhere.
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw failure();
      }
    };

    try {
      let response = await attempt();
      if (response.status === 401) {
        // Access tokens expire; the SDK hands out a fresh one, so try once more.
        response = await attempt();
      }
      if (!response.ok) {
        throw httpError(response.status, action, await serverDetail(response));
      }
      return await readJson(response);
    } catch (error) {
      throw error instanceof PicklistError ? error : failure();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  return {
    collectionUrl: base.href,
    get: (path, options = {}) => send('GET', path, undefined, options),
    patch: (path, body, options = {}) => send('PATCH', path, body, options),
    post: (path, body, options = {}) => send('POST', path, body, options),
  };
}

/** The REST API of the organization the extension runs in, called as the signed-in user. */
export async function createDevOpsApi(
  sdk: DevOpsSdk = devOpsSdk,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
): Promise<DevOpsApi> {
  let collectionUrl: unknown;
  try {
    const location = await sdk.getService(LOCATION_SERVICE_ID);
    collectionUrl = isLocationService(location) ? await location.getServiceLocation() : null;
  } catch {
    throw invalidAddress();
  }
  if (typeof collectionUrl !== 'string') {
    throw invalidAddress();
  }
  return createApi({
    collectionUrl,
    getToken: () => sdk.getAccessToken(),
    fetchImpl,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

/** Same client with a fixed address and token, for tests and the playground. */
export function createDevOpsApiForTests(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number } = {}
): DevOpsApi {
  return createApi({
    collectionUrl: baseUrl,
    getToken: async () => token,
    fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
