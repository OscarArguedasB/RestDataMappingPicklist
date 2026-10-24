import { PicklistError, toUserMessage } from '../core/errors';
import { locateRows } from '../core/items';
import type { AccessToken } from '../core/oauth';
import { requestAccessToken } from '../core/oauth';
import type { LoadRowsProgress } from '../core/paging';
import { loadRows } from '../core/paging';
import type { SecurityPolicy } from '../core/policy';
import { effectiveLimits } from '../core/policy';
import type { RequestSettings } from '../core/request';
import { prepareRequest } from '../core/request';
import type { StoredSecret } from '../core/secrets';
import type { Draft } from './settings';
import { describeSignIn, effectiveAdvanced, effectiveOAuth, secretKindOf } from './settings';

// The setup page's test request: the same request, paging, limits and policy checks the control
// uses on the form, plus what the page shows about it. For OAuth 2.0 it gets a token first, like
// the control, and only the access token goes to the API.

export type ProbeMode = 'detect' | 'test';

/** What the test signs in with: memory only, for one run, and never part of the result. */
export interface ProbeCredential {
  secret: StoredSecret;
  /** Typed or chosen on this page, or the configuration's saved secret. */
  source: 'entered' | 'saved';
}

export interface ProbeResult {
  mode: ProbeMode;
  /** The first page's URL, with parameters and without credentials. */
  url: string;
  /** How it signed in, never the secret: “API key (x-api-key)”. */
  signIn: string;
  /** Where the secret came from, when it signed in with one. */
  secretSource: ProbeCredential['source'] | null;
  /** OAuth 2.0: when the token it got stops being used. Never the token itself. */
  token: { expiresAt: number } | null;
  httpStatus: number;
  ms: number;
  rows: unknown[];
  pages: number;
  truncated: boolean;
  /** Paging was on, so the first response is one page of the list. */
  paged: boolean;
  /** The path actually used (found automatically when the setting was empty). */
  arrayPath: string;
  /** The setting as it was for this run, to tell whether `rows` still match it. */
  requestedArrayPath: string;
  firstResponse: unknown;
  limits: { maxPages: number; maxItems: number; timeoutMs: number };
  /** Identifies what was requested; a different key means the settings changed since. */
  key: string;
}

export interface ProbeFailure {
  message: string;
  /** Couldn't reach the service (or the token URL) at all, often CORS. */
  network: boolean;
  httpStatus?: number;
  /** Getting the OAuth 2.0 token failed, so the API wasn't called; or the request itself did. */
  step: 'token' | 'request';
}

/** Getting the OAuth 2.0 token failed, so the API wasn't called. Keeps the token service's error. */
export class TokenStepError extends PicklistError {
  constructor(error: unknown) {
    const cause =
      error instanceof PicklistError
        ? error
        : new PicklistError('network', 'Couldn’t get a token from the access token URL.');
    super(cause.kind, cause.message, cause.status);
    this.name = 'TokenStepError';
  }
}

/**
 * A short fingerprint (FNV-1a) of a secret, so a result's key notices a changed secret without
 * holding a copy of it. Only used to spot changes, never for security.
 */
export function secretFingerprint(secret: StoredSecret): string {
  const text =
    secret.kind === 'signingKey'
      ? [secret.key.pkcs8, secret.key.algorithm, secret.key.kid ?? ''].join('\n')
      : secret.value;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${secret.kind}:${hash.toString(36)}`;
}

/**
 * Everything that changes the request, so the page can say when a result is out of date.
 * `credentialId` identifies the secret it signs in with (see secretFingerprint), never the secret.
 */
export function probeKey(
  draft: Draft,
  samples: Record<string, string>,
  policy: SecurityPolicy,
  credentialId = ''
): string {
  const advanced = effectiveAdvanced(draft);
  return JSON.stringify([
    draft.url.trim(),
    draft.params.trim(),
    draft.authMethod,
    draft.username,
    draft.authMethod === 'oauth2' ? effectiveOAuth(draft) : null,
    credentialId,
    advanced.apiKeyHeader,
    advanced.paging,
    advanced.maxItems,
    advanced.timeoutSeconds,
    samples,
    policy,
  ]);
}

export async function runProbe(options: {
  draft: Draft;
  samples: Record<string, string>;
  policy: SecurityPolicy;
  mode: ProbeMode;
  /** Null when the request doesn't sign in, or nothing is there to sign in with. */
  credential: ProbeCredential | null;
  /** For the result's key (see probeKey). */
  credentialId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: LoadRowsProgress) => void;
  /** OAuth 2.0: told when the token request starts (null) and when the token arrives. */
  onToken?: (token: { expiresAt: number } | null) => void;
  /** Milliseconds since 1970, for the token's lifetime. Default: Date.now. */
  now?: () => number;
}): Promise<ProbeResult> {
  const { draft, samples, policy, mode, credential, signal, onProgress } = options;
  const advanced = effectiveAdvanced(draft);
  const limits = effectiveLimits(advanced, policy);
  const baseFetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  if (credential && credential.secret.kind !== secretKindOf(draft)) {
    throw new PicklistError('config', 'The secret doesn’t match the sign-in method.');
  }
  const settings: RequestSettings = {
    url: draft.url,
    params: draft.params,
    authMethod: draft.authMethod,
    username: draft.username,
    password: '',
    apiKeyHeader: advanced.apiKeyHeader,
  };
  // Checked before anything is sent, so a request that can't be made never costs a token.
  prepareRequest(settings, samples, policy);

  let password = '';
  let token: { expiresAt: number } | null = null;
  if (draft.authMethod === 'oauth2') {
    if (!credential) {
      throw new PicklistError(
        'config',
        'Enter the client secret, or choose the certificate, to get a token.'
      );
    }
    options.onToken?.(null);
    let access: AccessToken;
    try {
      access = await requestAccessToken(effectiveOAuth(draft), credential.secret, policy, {
        fetchImpl: baseFetch,
        signal,
        timeoutMs: limits.timeoutMs,
        now: options.now,
      });
    } catch (error) {
      throw new TokenStepError(error);
    }
    password = access.accessToken;
    token = { expiresAt: access.expiresAt };
    options.onToken?.(token);
  } else if (credential && credential.secret.kind !== 'signingKey') {
    password = credential.secret.value;
  }
  const request = prepareRequest({ ...settings, password }, samples, policy);

  let httpStatus = 0;
  const started = performance.now();
  try {
    const result = await loadRows({
      request,
      arrayPath: draft.arrayPath,
      paging: advanced.paging,
      maxItems: limits.maxItems,
      // Detect only needs a sample, so it stops after the first page.
      maxPages: mode === 'detect' ? 1 : limits.maxPages,
      policy,
      onProgress,
      fetchOptions: {
        signal,
        timeoutMs: limits.timeoutMs,
        fetchImpl: async (input, init) => {
          const response = await baseFetch(input, init);
          httpStatus = response.status;
          return response;
        },
      },
    });
    return {
      mode,
      url: request.url,
      signIn: describeSignIn(draft),
      secretSource: credential?.source ?? null,
      token,
      httpStatus,
      ms: Math.round(performance.now() - started),
      rows: result.rows,
      pages: result.pages,
      truncated: result.truncated,
      paged: advanced.paging.type !== 'none',
      arrayPath: result.arrayPath,
      requestedArrayPath: draft.arrayPath.trim(),
      firstResponse: result.firstResponse,
      limits,
      key: probeKey(draft, samples, policy, options.credentialId),
    };
  } catch (error) {
    if (error instanceof PicklistError && httpStatus && !error.status) {
      throw new PicklistError(error.kind, error.message, httpStatus);
    }
    throw error;
  }
}

/**
 * What a test's item counts cover. The list chips count the first response only, while the rows
 * can span several pages or stop at a limit; the page names the scope so the two never disagree
 * silently (“60 items from 3 pages” next to “25 items on the first page”).
 */
export interface CountScope {
  /** Pages the rows came from. */
  pages: number;
  /** Only the first page was read although the service has more (Detect reads one page). */
  firstPageOfMore: boolean;
  /** A limit stopped loading while more data existed. */
  limited: boolean;
}

export function countScope(result: ProbeResult): CountScope {
  const firstPageOfMore = result.paged && result.truncated && result.pages === 1;
  return { pages: result.pages, firstPageOfMore, limited: result.truncated && !firstPageOfMore };
}

export function describeFailure(error: unknown): ProbeFailure {
  return {
    message: toUserMessage(error),
    network: error instanceof PicklistError && error.kind === 'network',
    httpStatus: error instanceof PicklistError ? error.status : undefined,
    step: error instanceof TokenStepError ? 'token' : 'request',
  };
}

export interface LocatedRows {
  rows: readonly unknown[] | null;
  /** The path in use ('' for the whole response). */
  path: string;
  /** True when the rows were found automatically. */
  automatic: boolean;
  /** Only the first page is available for this path (the setting changed after the test). */
  firstPageOnly: boolean;
  error: string | null;
}

/**
 * The rows for the current “JSON path to the list”. When the setting changed after the last run,
 * the first response is searched again, so trying another path needs no new request.
 */
export function locateCurrentRows(result: ProbeResult, arrayPath: string): LocatedRows {
  const wanted = arrayPath.trim();
  if (wanted === result.requestedArrayPath) {
    return {
      rows: result.rows,
      path: result.arrayPath,
      automatic: !wanted,
      firstPageOnly: false,
      error: null,
    };
  }
  try {
    const located = locateRows(result.firstResponse, wanted);
    const rows = located.rows.slice(0, result.limits.maxItems);
    return {
      rows,
      path: located.path,
      automatic: !wanted,
      firstPageOnly: result.pages > 1,
      error: null,
    };
  } catch (error) {
    return {
      rows: null,
      path: wanted,
      automatic: !wanted,
      firstPageOnly: false,
      error: toUserMessage(error),
    };
  }
}
