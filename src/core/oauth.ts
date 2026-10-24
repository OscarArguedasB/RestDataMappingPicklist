import type { OAuthSettings } from './config';
import { OAUTH_LIMITS, oauthSettingsProblems, validateTokenParameterName } from './config';
import { PicklistError } from './errors';
import type { SecurityPolicy } from './policy';
import { checkAuthMethod, checkTokenUrl, hostMatches } from './policy';
import { readLimitedText } from './responseBody';
import type { JwsAlgorithm, SigningKey, StoredSecret } from './secrets';
import { isPlainObject } from './values';

// OAuth 2.0 client credentials (RFC 6749 §4.4) from the browser, the way Postman does it: the
// client's secret, or a JWT signed with its private key, goes to the token URL, and only the
// access token that comes back goes to the API. The form control loads this module only for
// configurations that use OAuth 2.0, so it stays free of React and the SDK.

/** An access token, kept in memory only. Never shown, logged or stored. */
export interface AccessToken {
  accessToken: string;
  /**
   * When to stop using it, in milliseconds since 1970: a minute before the token service says it
   * expires, so a request that starts just before can still finish.
   */
  expiresAt: number;
  /** The scope the token service granted, when it says. */
  scope?: string;
}

export interface TokenRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** The configuration's timeout, capped by the policy (see effectiveLimits). Default: 30 s. */
  timeoutMs?: number;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  /** WebCrypto. Default: globalThis.crypto.subtle. */
  subtle?: SubtleCrypto;
  /** The origin the secret was saved for. When given, the secret is only sent there. */
  boundOrigin?: string;
}

export interface TokenRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  /** Form-encoded. It carries the secret or the signed JWT, so it's never logged or shown. */
  body: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const FULL_URL = /^[a-z][a-z\d+.-]*:\/\//i;

const TOKEN_LIMITS = {
  /** Longer tokens don't fit in the headers most services accept. */
  maxTokenLength: 16_384,
  /** A token service's answer is a few kilobytes; anything far bigger isn't one. */
  maxResponseLength: 1_000_000,
  /** How long a token without "expires_in" is used. */
  unknownLifetimeSeconds: 300,
  // Otherwise a token is used until a minute before the token service says it expires, but for
  // at least 30 seconds (or its whole life, when that's shorter) and at most a day.
  expiryMarginSeconds: 60,
  minLifetimeSeconds: 30,
  maxLifetimeSeconds: 86_400,
} as const;

const CANCELLED = 'The request was cancelled.';
const UNREACHABLE =
  'Couldn’t reach the token URL. It must allow requests from Azure DevOps (CORS).';
const SECRET_MISMATCH =
  'This configuration’s secret doesn’t match how it signs in. Ask an administrator to enter it again in Organization settings › Extensions › REST Picklist.';
const KEY_UNUSABLE =
  'The signing key can’t be used. Ask an administrator to enter it again in Organization settings › Extensions › REST Picklist.';
const SECRET_MOVED =
  'This configuration’s address changed after its secret was saved. Ask an administrator to enter the secret again.';
const TOO_LARGE = 'The token URL’s answer is too large to be a token.';

/** The Entra problem in a few words, for the configuration list. */
export const ENTRA_REFUSES_BROWSER =
  'Microsoft Entra ID refuses client credentials sent from a browser';

/**
 * Why a Microsoft Entra ID token URL can't work here, in the same words on the setup page (under
 * the field) and on the form when the token request fails.
 */
export const ENTRA_TOKEN_URL_PROBLEM = `${ENTRA_REFUSES_BROWSER}, so this token URL won’t work. Use a token service that accepts requests from Azure DevOps.`;

/** Added to token request failures for Entra hosts: the same words as ENTRA_TOKEN_URL_PROBLEM. */
export const ENTRA_BROWSER_WARNING = ENTRA_TOKEN_URL_PROBLEM;

// Microsoft Entra ID's sign-in hosts in each cloud (with their aliases), External ID and B2C.
const ENTRA_HOSTS = [
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net',
  'sts.windows.net',
  'login.microsoftonline.us',
  'login.usgovcloudapi.net',
  'login-us.microsoftonline.com',
  'login.chinacloudapi.cn',
  'login.partner.microsoftonline.cn',
  'login.microsoftonline.de',
  '*.ciamlogin.com',
  '*.b2clogin.com',
];

/**
 * True when `url` points at Microsoft Entra ID. Entra refuses client credentials in any request
 * that carries an Origin header, which every request from a browser does, so OAuth 2.0 here
 * can't work with it. A custom domain in front of Entra can't be recognized.
 */
export function isMicrosoftEntraTokenUrl(url: string): boolean {
  const trimmed = url.trim();
  let host: string;
  try {
    host = new URL(FULL_URL.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return false;
  }
  return ENTRA_HOSTS.some((pattern) => hostMatches(host, pattern));
}

function tokenUrlProblem(tokenUrl: string, policy: SecurityPolicy): string | null {
  if (tokenUrl.includes('$(')) {
    return 'Field values can’t be used in the access token URL.';
  }
  if (!FULL_URL.test(tokenUrl)) {
    return 'Use a full URL for the access token URL, for example https://login.example.com/oauth2/token.';
  }
  return checkTokenUrl(tokenUrl, policy);
}

/**
 * What's wrong with OAuth 2.0 settings under the organization's policy, written for the
 * administrator; empty when a token can be requested. The token URL gets the same checks as the
 * API's URL, since the client's secret is sent there.
 */
export function validateOAuthSettings(settings: OAuthSettings, policy: SecurityPolicy): string[] {
  const problems = oauthSettingsProblems(settings);
  const tokenUrl = settings.tokenUrl.trim();
  const urlProblem = tokenUrl ? tokenUrlProblem(tokenUrl, policy) : null;
  return urlProblem ? [urlProblem, ...problems] : problems;
}

// Encoding helpers. The base64url form has no padding (RFC 7515 §2).

function utf8(text: string) {
  return new TextEncoder().encode(text);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(subtle: SubtleCrypto, text: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', utf8(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface SigningParams {
  key: RsaHashedImportParams | EcKeyImportParams;
  sign: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
}

function rsaPkcs1(hash: string): SigningParams {
  return { key: { name: 'RSASSA-PKCS1-v1_5', hash }, sign: { name: 'RSASSA-PKCS1-v1_5' } };
}

// RFC 7518 §3.5: the salt is as long as the hash.
function rsaPss(hash: string, saltLength: number): SigningParams {
  return { key: { name: 'RSA-PSS', hash }, sign: { name: 'RSA-PSS', saltLength } };
}

// WebCrypto's ECDSA signature is r and s side by side, which is the JWS format (RFC 7518 §3.4).
function ecdsa(namedCurve: string, hash: string): SigningParams {
  return { key: { name: 'ECDSA', namedCurve }, sign: { name: 'ECDSA', hash } };
}

const SIGNING: Record<JwsAlgorithm, SigningParams> = {
  RS256: rsaPkcs1('SHA-256'),
  RS384: rsaPkcs1('SHA-384'),
  RS512: rsaPkcs1('SHA-512'),
  PS256: rsaPss('SHA-256', 32),
  PS384: rsaPss('SHA-384', 48),
  PS512: rsaPss('SHA-512', 64),
  ES256: ecdsa('P-256', 'SHA-256'),
  ES384: ecdsa('P-384', 'SHA-384'),
  ES512: ecdsa('P-521', 'SHA-512'),
};

// Imported keys, per WebCrypto implementation and by a hash of the key, because importing an RSA
// key takes longer than signing with it. They're imported as non-extractable.
const importedKeys = new WeakMap<SubtleCrypto, Map<string, Promise<CryptoKey>>>();
const MAX_IMPORTED_KEYS = 10;

async function importSigningKey(key: SigningKey, subtle: SubtleCrypto): Promise<CryptoKey> {
  // The key comes from extension data that any member can write, so nothing about it is trusted.
  const params = Object.hasOwn(SIGNING, key.algorithm) ? SIGNING[key.algorithm] : undefined;
  if (!params || typeof key.pkcs8 !== 'string') {
    throw new PicklistError('config', KEY_UNUSABLE);
  }
  const keys = importedKeys.get(subtle) ?? new Map<string, Promise<CryptoKey>>();
  importedKeys.set(subtle, keys);
  const id = await sha256Hex(subtle, `${key.algorithm}\n${key.pkcs8}`);
  const cached = keys.get(id);
  if (cached) {
    return cached;
  }
  const imported = (async () => {
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await subtle.importKey('pkcs8', decodeBase64(key.pkcs8), params.key, false, [
        'sign',
      ]);
    } catch {
      throw new PicklistError('config', KEY_UNUSABLE);
    }
    const { modulusLength }: Partial<RsaHashedKeyAlgorithm> = cryptoKey.algorithm;
    if (typeof modulusLength === 'number' && modulusLength < 2048) {
      throw new PicklistError(
        'config',
        'The signing key is too short: RSA keys need at least 2048 bits. Ask an administrator to replace it in Organization settings › Extensions › REST Picklist.'
      );
    }
    return cryptoKey;
  })();
  keys.set(id, imported);
  // A key that failed to import is tried again next time.
  imported.catch(() => {
    if (keys.get(id) === imported) {
      keys.delete(id);
    }
  });
  while (keys.size > MAX_IMPORTED_KEYS) {
    const oldest = keys.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    keys.delete(oldest);
  }
  return imported;
}

/**
 * A client assertion (RFC 7523): a JWT saying this client is asking, signed with its private key.
 * It's valid for five minutes, starting 30 seconds early for token services whose clock is a
 * little behind, and carries a new "jti" every time so it can't be replayed.
 */
export async function createClientAssertion(
  key: SigningKey,
  claims: { clientId: string; audience: string },
  nowSeconds: number,
  subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<string> {
  const header: Record<string, string> = { alg: key.algorithm, typ: 'JWT' };
  if (key.kid) {
    header.kid = key.kid;
  }
  if (key.x5t) {
    header.x5t = key.x5t;
  }
  if (key.x5tS256) {
    header['x5t#S256'] = key.x5tS256;
  }
  const now = Math.floor(nowSeconds);
  const payload = {
    iss: claims.clientId,
    sub: claims.clientId,
    aud: claims.audience,
    jti: globalThis.crypto.randomUUID(),
    iat: now,
    nbf: now - 30,
    exp: now + 300,
  };
  const encodedHeader = base64Url(utf8(JSON.stringify(header)));
  const encodedPayload = base64Url(utf8(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const cryptoKey = await importSigningKey(key, subtle);
  let signature: ArrayBuffer;
  try {
    signature = await subtle.sign(SIGNING[key.algorithm].sign, cryptoKey, utf8(signingInput));
  } catch {
    throw new PicklistError('config', KEY_UNUSABLE);
  }
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** RFC 6749 §2.3.1: the client ID and secret are form-encoded before they're joined for Basic. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

// Line breaks can't be part of a secret and usually come from a bad paste.
function clientSecretOf(secret: StoredSecret): string {
  const value = secret.kind === 'clientSecret' ? secret.value.replace(/[\r\n]/g, '') : '';
  if (!value) {
    throw new PicklistError('config', SECRET_MISMATCH);
  }
  return value;
}

/**
 * The token request for these settings and secret: client_secret_basic, client_secret_post or
 * private_key_jwt, then the scope, audience, resource and extra parameters. The settings aren't
 * checked against the policy here; requestAccessToken does that first.
 */
export async function buildTokenRequest(
  settings: OAuthSettings,
  secret: StoredSecret,
  options: { now?: () => number; subtle?: SubtleCrypto } = {}
): Promise<TokenRequest> {
  let url: URL;
  try {
    url = new URL(settings.tokenUrl.trim());
  } catch {
    throw new PicklistError('config', 'The access token URL isn’t valid.');
  }
  url.hash = '';
  const clientId = settings.clientId.trim();
  if (!clientId) {
    throw new PicklistError('config', 'Add the client ID for OAuth 2.0.');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  switch (settings.clientAuthentication) {
    case 'basic': {
      // The secret goes only in the header, never in the body as well.
      const credentials = `${formEncode(clientId)}:${formEncode(clientSecretOf(secret))}`;
      headers.Authorization = `Basic ${btoa(credentials)}`;
      break;
    }
    case 'body':
      body.append('client_id', clientId);
      body.append('client_secret', clientSecretOf(secret));
      break;
    case 'privateKeyJwt': {
      if (secret.kind !== 'signingKey') {
        throw new PicklistError('config', SECRET_MISMATCH);
      }
      const now = options.now ?? Date.now;
      const audience = settings.assertionAudience.trim() || `${url.origin}${url.pathname}`;
      const assertion = await createClientAssertion(
        secret.key,
        { clientId, audience },
        now() / 1000,
        options.subtle
      );
      body.append('client_id', clientId);
      body.append('client_assertion_type', ASSERTION_TYPE);
      body.append('client_assertion', assertion);
      break;
    }
    default:
      throw new PicklistError('config', SECRET_MISMATCH);
  }
  const scope = settings.scope.trim().split(/\s+/).filter(Boolean).join(' ');
  if (scope) {
    body.append('scope', scope);
  }
  for (const name of ['audience', 'resource'] as const) {
    const value = settings[name].trim();
    if (value) {
      body.append(name, value);
    }
  }
  // Checked again here: these settings may not have come through parseOAuthSettings, and nothing
  // may replace the parameters above.
  const seen = new Set<string>();
  for (const [rawName, value] of Object.entries(settings.extraParams)) {
    const name = rawName.trim();
    if (
      seen.size < OAUTH_LIMITS.maxExtraParams &&
      typeof value === 'string' &&
      !seen.has(name) &&
      validateTokenParameterName(name) === null
    ) {
      seen.add(name);
      body.append(name, value);
    }
  }
  return { url: url.href, method: 'POST', headers, body: body.toString() };
}

/** True for printable ASCII only, which is all a header value may hold. */
function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

// Control characters and bidirectional overrides from a token service could garble or disguise
// a message on screen.
function cleanText(value: string, maxLength: number): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const hidden =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x061c;
    cleaned += hidden ? ' ' : char;
  }
  const characters = Array.from(cleaned.replace(/\s+/g, ' ').trim());
  return characters.length > maxLength
    ? `${characters
        .slice(0, maxLength - 1)
        .join('')
        .trimEnd()}…`
    : characters.join('');
}

// A careless token service might repeat what it was sent; that never reaches the screen.
function redact(text: string, sensitive: readonly string[]): string {
  let result = text;
  for (const value of sensitive) {
    if (value) {
      result = result.split(value).join('…');
    }
  }
  return result;
}

/** "invalid_client: Client authentication failed." from an error answer, or ''. */
function errorDetail(body: unknown, sensitive: readonly string[]): string {
  if (!isPlainObject(body) || typeof body.error !== 'string') {
    return '';
  }
  const code = cleanText(redact(body.error, sensitive), 100);
  if (!code) {
    return '';
  }
  const description =
    typeof body.error_description === 'string'
      ? cleanText(redact(body.error_description, sensitive), 200)
      : '';
  return description ? `${code}: ${description}` : code;
}

function refused(detail: string, status?: number): PicklistError {
  return new PicklistError('http', `The token service refused the request (${detail}).`, status);
}

function tokenHttpError(status: number, bodyText: string, sensitive: readonly string[]) {
  if (status === 404) {
    return new PicklistError(
      'http',
      'The token URL wasn’t found (404). Check the address.',
      status
    );
  }
  if (status === 429) {
    return new PicklistError('http', 'The token service is limiting requests (429).', status);
  }
  if (status >= 500) {
    return new PicklistError('http', `The token service had a problem (${status}).`, status);
  }
  let body: unknown = null;
  if (bodyText.length <= TOKEN_LIMITS.maxResponseLength) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      body = null;
    }
  }
  const detail = errorDetail(body, sensitive);
  if (detail || status === 400 || status === 401 || status === 403) {
    return refused(detail || String(status), status);
  }
  return new PicklistError('http', `The token service returned an error (${status}).`, status);
}

function expiresInSeconds(value: unknown): number | null {
  let seconds = Number.NaN;
  if (typeof value === 'number') {
    seconds = value;
  } else if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) {
    seconds = Number(value);
  }
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function lifetimeSeconds(expiresIn: number | null): number {
  if (expiresIn === null) {
    return TOKEN_LIMITS.unknownLifetimeSeconds;
  }
  const withMargin = expiresIn - TOKEN_LIMITS.expiryMarginSeconds;
  const minimum = Math.min(TOKEN_LIMITS.minLifetimeSeconds, expiresIn);
  return Math.min(TOKEN_LIMITS.maxLifetimeSeconds, Math.max(withMargin, minimum));
}

/**
 * Reads the token service's answer (RFC 6749 §5). Errors are written for people and never
 * include the token; `sensitive` values, such as the secret that was sent, are cut from any text
 * repeated from the answer.
 */
export function parseTokenResponse(
  status: number,
  bodyText: string,
  nowMs: number,
  sensitive: readonly string[] = []
): AccessToken {
  if (status < 200 || status > 299) {
    throw tokenHttpError(status, bodyText, sensitive);
  }
  if (bodyText.length > TOKEN_LIMITS.maxResponseLength) {
    throw new PicklistError('parse', TOO_LARGE);
  }
  let data: unknown;
  try {
    data = JSON.parse(bodyText) as unknown;
  } catch {
    throw new PicklistError(
      'parse',
      bodyText.trimStart().startsWith('<')
        ? 'The token URL didn’t return JSON. It sent a web page, so check the address.'
        : 'The token URL didn’t return JSON.'
    );
  }
  if (!isPlainObject(data)) {
    throw new PicklistError('shape', 'The token service didn’t return an access token.');
  }
  const token = data.access_token;
  if (typeof token !== 'string' || !token) {
    // Some services answer an error with 200 OK.
    const detail = errorDetail(data, sensitive);
    throw detail
      ? refused(detail)
      : new PicklistError('shape', 'The token service didn’t return an access token.');
  }
  if (token.length > TOKEN_LIMITS.maxTokenLength) {
    throw new PicklistError(
      'shape',
      'The access token is longer than 16 KB, so it can’t be sent to the API.'
    );
  }
  if (!isPrintableAscii(token)) {
    throw new PicklistError(
      'shape',
      'The access token contains characters that can’t be sent to the API.'
    );
  }
  const tokenType = typeof data.token_type === 'string' ? data.token_type.trim() : data.token_type;
  if (tokenType !== undefined && tokenType !== null && tokenType !== '') {
    if (typeof tokenType !== 'string') {
      throw new PicklistError(
        'shape',
        'The token service didn’t say the token is a bearer token, and only bearer tokens can be used.'
      );
    }
    if (tokenType.toLowerCase() !== 'bearer') {
      throw new PicklistError(
        'shape',
        `The token service returned a “${cleanText(tokenType, 40)}” token, but only bearer tokens can be used.`
      );
    }
  }
  const accessToken: AccessToken = {
    accessToken: token,
    expiresAt: nowMs + lifetimeSeconds(expiresInSeconds(data.expires_in)) * 1000,
  };
  const scope = typeof data.scope === 'string' ? cleanText(data.scope, 1000) : '';
  if (scope) {
    accessToken.scope = scope;
  }
  return accessToken;
}

/** What must never be repeated from the token service's answer: the secret, in every form sent. */
function sensitiveValues(request: TokenRequest, secret: StoredSecret): string[] {
  const body = new URLSearchParams(request.body);
  const sent = [
    secret.kind === 'clientSecret' ? secret.value.replace(/[\r\n]/g, '') : '',
    body.get('client_secret') ?? '',
    body.get('client_assertion') ?? '',
    request.headers.Authorization?.replace(/^Basic /, '') ?? '',
  ];
  const values = sent.flatMap((value) =>
    value ? [value, formEncode(value), new URLSearchParams({ v: value }).toString().slice(2)] : []
  );
  // Longest first, so a value that contains another is cut whole.
  return [...new Set(values)].toSorted((a, b) => b.length - a.length);
}

/**
 * Gets an access token from the token URL. The method and the token URL are checked against the
 * organization's policy before the secret is sent. Cookies are never sent and redirects are
 * refused, because the browser would send the secret on to the redirect's target.
 */
export async function requestAccessToken(
  settings: OAuthSettings,
  secret: StoredSecret,
  policy: SecurityPolicy,
  options: TokenRequestOptions = {}
): Promise<AccessToken> {
  const methodProblem = checkAuthMethod('oauth2', policy);
  if (methodProblem) {
    throw new PicklistError('config', methodProblem);
  }
  const problems = validateOAuthSettings(settings, policy);
  if (problems.length > 0) {
    throw new PicklistError('config', problems.join(' '));
  }
  if (
    options.boundOrigin !== undefined &&
    options.boundOrigin !== new URL(settings.tokenUrl.trim()).origin
  ) {
    throw new PicklistError('config', SECRET_MOVED);
  }
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (signal?.aborted) {
    throw new PicklistError('aborted', CANCELLED);
  }
  const now = options.now ?? Date.now;
  const request = await buildTokenRequest(settings, secret, { now, subtle: options.subtle });
  // Signing takes a moment, and the request may have been cancelled meanwhile.
  if (signal?.aborted) {
    throw new PicklistError('aborted', CANCELLED);
  }
  const entra = isMicrosoftEntraTokenUrl(request.url);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
      return new PicklistError('timeout', 'The token service took too long to respond.');
    }
    if (signal?.aborted) {
      return new PicklistError('aborted', CANCELLED);
    }
    // A refused redirect fails exactly like a CORS error, so both are explained.
    return new PicklistError(
      'network',
      entra
        ? `${UNREACHABLE} ${ENTRA_BROWSER_WARNING}`
        : `${UNREACHABLE} Redirects aren’t followed here, so use the final address.`
    );
  };

  let status: number;
  let bodyText: string;
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.redirected || (response.url && response.url !== request.url)) {
      throw new PicklistError(
        'http',
        'The token URL redirected the request. Redirects aren’t followed here, so use the final address as the access token URL.'
      );
    }
    status = response.status;
    // Read up to the limit only: a service that keeps sending is cut off, not read to the end.
    const text = await readLimitedText(response, TOKEN_LIMITS.maxResponseLength);
    if (text === null && status >= 200 && status <= 299) {
      throw new PicklistError('parse', TOO_LARGE);
    }
    // An error answer that's too large is explained by its status alone.
    bodyText = text ?? '';
  } catch (error) {
    throw error instanceof PicklistError ? error : failure();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
  try {
    return parseTokenResponse(status, bodyText, now(), sensitiveValues(request, secret));
  } catch (error) {
    if (entra && error instanceof PicklistError && error.kind === 'http') {
      throw new PicklistError('http', `${error.message} ${ENTRA_BROWSER_WARNING}`, error.status);
    }
    throw error;
  }
}

/** What identifies one token: every setting that changes the request, and the secret. */
async function tokenFingerprint(
  settings: OAuthSettings,
  secret: StoredSecret,
  subtle: SubtleCrypto
): Promise<string> {
  const material =
    secret.kind === 'signingKey'
      ? [
          secret.kind,
          secret.key.algorithm,
          secret.key.pkcs8,
          secret.key.kid ?? '',
          secret.key.x5t ?? '',
          secret.key.x5tS256 ?? '',
        ]
      : [secret.kind, secret.value];
  const extraParams = Object.entries(settings.extraParams).toSorted(([a], [b]) => (a < b ? -1 : 1));
  return sha256Hex(
    subtle,
    JSON.stringify([
      settings.tokenUrl.trim(),
      settings.clientId.trim(),
      settings.scope.trim(),
      settings.audience.trim(),
      settings.resource.trim(),
      settings.clientAuthentication,
      settings.assertionAudience.trim(),
      extraParams,
      material,
    ])
  );
}

/** Lets one caller stop waiting without cancelling a request that others share. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PicklistError('aborted', CANCELLED));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

interface CacheEntry {
  promise: Promise<AccessToken>;
  /** Set once the token arrives. */
  token?: AccessToken;
}

export interface TokenCacheOptions {
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  /** Default: 20. */
  maxEntries?: number;
  /** WebCrypto, for the fingerprints and the signing. Default: globalThis.crypto.subtle. */
  subtle?: SubtleCrypto;
}

/**
 * Access tokens in memory, so the token URL is asked again only when a token is about to expire.
 * Entries are found by a SHA-256 fingerprint of the settings and the secret, never by the secret
 * itself. Callers asking for the same token at once share one request. Nothing is persisted, and
 * failures aren't kept.
 */
export class TokenCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly subtle: SubtleCrypto | undefined;

  constructor(options: TokenCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 20;
    this.subtle = options.subtle;
  }

  /**
   * A token for these settings: the cached one while it's fresh, otherwise a new one. `refresh`
   * asks for a new one anyway. A caller's `signal` only stops that caller waiting: a request
   * other callers share keeps going.
   */
  async get(
    settings: OAuthSettings,
    secret: StoredSecret,
    policy: SecurityPolicy,
    options: TokenRequestOptions & { refresh?: boolean } = {}
  ): Promise<AccessToken> {
    const { signal } = options;
    if (signal?.aborted) {
      throw new PicklistError('aborted', CANCELLED);
    }
    const subtle = options.subtle ?? this.subtle ?? globalThis.crypto.subtle;
    const key = await tokenFingerprint(settings, secret, subtle);
    let entry = this.entries.get(key);
    if (entry && (options.refresh || (entry.token && entry.token.expiresAt <= this.now()))) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const promise = requestAccessToken(settings, secret, policy, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now ?? this.now,
        subtle,
        boundOrigin: options.boundOrigin,
      });
      const created: CacheEntry = { promise };
      entry = created;
      this.entries.set(key, created);
      promise.then(
        (token) => {
          created.token = token;
        },
        () => {
          if (this.entries.get(key) === created) {
            this.entries.delete(key);
          }
        }
      );
      this.prune();
    }
    return signal ? abortable(entry.promise, signal) : entry.promise;
  }

  /**
   * Forgets the token for these settings, for example after the API refused it. With
   * `rejectedToken`, only that token is forgotten: a newer one fetched meanwhile is kept.
   */
  async invalidate(
    settings: OAuthSettings,
    secret: StoredSecret,
    rejectedToken?: string
  ): Promise<void> {
    const key = await tokenFingerprint(settings, secret, this.subtle ?? globalThis.crypto.subtle);
    const entry = this.entries.get(key);
    if (entry && (rejectedToken === undefined || entry.token?.accessToken === rejectedToken)) {
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.token && entry.token.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

/** The form control's cache: one per page (each control runs in its own frame), in memory. */
export const sharedTokenCache = new TokenCache();
