import { isPlainObject } from './values';

// Credentials a configuration signs in with. They're kept apart from the configuration, in the
// extension's "secrets" document collection, and the setup page never shows them again once
// saved: it can only replace or remove them. They still have to reach the browser of everyone who
// opens a work item that uses them, and Azure DevOps lets any member read the extension's data,
// so they're hidden from every screen rather than encrypted.

/** JWS algorithms a private key JWT client assertion can be signed with through WebCrypto. */
export const JWS_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;

export type JwsAlgorithm = (typeof JWS_ALGORITHMS)[number];

/** A private key for OAuth 2.0 "private_key_jwt" client authentication. */
export interface SigningKey {
  /** PKCS #8 private key: DER bytes, base64 with the standard alphabet and no line breaks. */
  pkcs8: string;
  algorithm: JwsAlgorithm;
  /** "x5t" header: base64url SHA-1 of the DER certificate. */
  x5t?: string;
  /** "x5t#S256" header: base64url SHA-256 of the DER certificate. */
  x5tS256?: string;
  /** "kid" header, for keys registered by key id rather than certificate. */
  kid?: string;
}

export type StoredSecret =
  /** Basic sign-in. */
  | { kind: 'password'; value: string }
  /** Bearer token sign-in. */
  | { kind: 'token'; value: string }
  | { kind: 'apiKey'; value: string }
  /** OAuth 2.0 client secret, sent in the Authorization header or the request body. */
  | { kind: 'clientSecret'; value: string }
  /** OAuth 2.0 private key JWT, signed with a key or a certificate's key. */
  | { kind: 'signingKey'; key: SigningKey };

export type SecretKind = StoredSecret['kind'];

export const SECRET_KINDS: readonly SecretKind[] = [
  'password',
  'token',
  'apiKey',
  'clientSecret',
  'signingKey',
];

/** What may be shown about a certificate. Never the key. */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  /** Hex, as printed by most tools. */
  serialNumber: string;
  /** ISO 8601. */
  notBefore: string;
  /** ISO 8601. */
  notAfter: string;
  /** SHA-1 of the DER certificate in uppercase hex, as Windows and most portals show it. */
  sha1Thumbprint: string;
  /** SHA-256 of the DER certificate in uppercase hex. */
  sha256Thumbprint: string;
}

/**
 * Kept in the configuration document, so the setup page can describe a secret without reading
 * it. `boundOrigin` is where the secret may be sent: the API's origin for Basic, bearer tokens and
 * API keys, or the token URL's origin for OAuth 2.0. Pointing the configuration somewhere else
 * needs the secret to be entered again.
 */
export interface SecretSummary {
  kind: SecretKind;
  boundOrigin: string;
  /**
   * OAuth 2.0: the API's origin when the secret was saved. The secret only goes to the token
   * URL, but the access tokens it gets go to the API, so pointing the API somewhere else needs the
   * secret again too. Left out for other sign-in methods, whose boundOrigin is the API's.
   */
  apiOrigin?: string;
  updatedBy?: string;
  /** ISO 8601. */
  updatedAt?: string;
  /** Signing keys only. */
  algorithm?: JwsAlgorithm;
  keyId?: string;
  certificate?: CertificateInfo;
}

/** One document in the "secrets" collection. Its id is the configuration's id. */
export interface SecretDocument {
  id: string;
  /** Set by the extension data service; used to detect concurrent changes. */
  __etag?: number;
  version: 1;
  secret: StoredSecret;
  /** The same origin as in the configuration's SecretSummary, checked again before sending. */
  boundOrigin: string;
  /** OAuth 2.0: where the tokens it gets may go (see SecretSummary.apiOrigin). */
  apiOrigin?: string;
  updatedBy?: string;
  /** ISO 8601. */
  updatedAt?: string;
}

export const SECRETS_COLLECTION = 'secrets';

export const SECRET_LIMITS = {
  /** Passwords, tokens, API keys and client secrets. */
  maxValueLength: 16_384,
  /** Base64 PKCS #8; an RSA 4096 key is about 3.2 KB. */
  maxKeyLength: 16_384,
  /** Names, key ids, subjects and other short text. */
  maxTextLength: 400,
} as const;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEX = /^[0-9A-F]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isAlgorithm(value: unknown): value is JwsAlgorithm {
  return typeof value === 'string' && (JWS_ALGORITHMS as readonly string[]).includes(value);
}

function isSecretKind(value: unknown): value is SecretKind {
  return typeof value === 'string' && (SECRET_KINDS as readonly string[]).includes(value);
}

function shortText(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SECRET_LIMITS.maxTextLength
    ? value
    : undefined;
}

/** Like shortText, but empty text counts: a certificate's subject or issuer can be empty. */
function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= SECRET_LIMITS.maxTextLength
    ? value
    : undefined;
}

function isoDate(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_DATE.test(value) ? value : undefined;
}

function secretValue(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SECRET_LIMITS.maxValueLength
    ? value
    : null;
}

/**
 * The origin a secret may be sent to, or null when `value` isn't one: HTTPS, or HTTP on
 * localhost for testing, with no path, credentials, query or fragment.
 */
export function parseOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > SECRET_LIMITS.maxTextLength) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return null;
  }
  return url.origin === value ? value : null;
}

function parseSigningKey(value: unknown): SigningKey | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { pkcs8, algorithm, x5t, x5tS256, kid } = value;
  if (
    typeof pkcs8 !== 'string' ||
    pkcs8.length > SECRET_LIMITS.maxKeyLength ||
    !BASE64.test(pkcs8) ||
    !isAlgorithm(algorithm)
  ) {
    return null;
  }
  const key: SigningKey = { pkcs8, algorithm };
  if (typeof x5t === 'string' && x5t.length <= 100 && BASE64URL.test(x5t)) {
    key.x5t = x5t;
  }
  if (typeof x5tS256 === 'string' && x5tS256.length <= 100 && BASE64URL.test(x5tS256)) {
    key.x5tS256 = x5tS256;
  }
  const keyId = shortText(kid);
  if (keyId) {
    key.kid = keyId;
  }
  return key;
}

/**
 * Reads a stored secret. Anyone in the organization can write extension data, so anything
 * malformed or unknown is rejected rather than repaired.
 */
export function parseStoredSecret(value: unknown): StoredSecret | null {
  if (!isPlainObject(value)) {
    return null;
  }
  switch (value.kind) {
    case 'password':
    case 'token':
    case 'apiKey':
    case 'clientSecret': {
      const secret = secretValue(value.value);
      return secret === null ? null : { kind: value.kind, value: secret };
    }
    case 'signingKey': {
      const key = parseSigningKey(value.key);
      return key ? { kind: 'signingKey', key } : null;
    }
    default:
      return null;
  }
}

function parseCertificateInfo(value: unknown): CertificateInfo | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const subject = boundedText(value.subject);
  const issuer = boundedText(value.issuer);
  const serialNumber = shortText(value.serialNumber);
  const notBefore = isoDate(value.notBefore);
  const notAfter = isoDate(value.notAfter);
  const { sha1Thumbprint, sha256Thumbprint } = value;
  if (
    subject === undefined ||
    issuer === undefined ||
    !serialNumber ||
    !notBefore ||
    !notAfter ||
    typeof sha1Thumbprint !== 'string' ||
    sha1Thumbprint.length !== 40 ||
    !HEX.test(sha1Thumbprint) ||
    typeof sha256Thumbprint !== 'string' ||
    sha256Thumbprint.length !== 64 ||
    !HEX.test(sha256Thumbprint)
  ) {
    return undefined;
  }
  return { subject, issuer, serialNumber, notBefore, notAfter, sha1Thumbprint, sha256Thumbprint };
}

/** Reads the description of a secret kept in a configuration document; null when malformed. */
export function parseSecretSummary(value: unknown): SecretSummary | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const kind = value.kind;
  const boundOrigin = parseOrigin(value.boundOrigin);
  if (!isSecretKind(kind) || !boundOrigin) {
    return null;
  }
  const summary: SecretSummary = { kind, boundOrigin };
  const apiOrigin = parseOrigin(value.apiOrigin);
  if (apiOrigin) {
    summary.apiOrigin = apiOrigin;
  }
  const updatedBy = shortText(value.updatedBy);
  const updatedAt = isoDate(value.updatedAt);
  if (updatedBy) {
    summary.updatedBy = updatedBy;
  }
  if (updatedAt) {
    summary.updatedAt = updatedAt;
  }
  if (kind === 'signingKey') {
    if (isAlgorithm(value.algorithm)) {
      summary.algorithm = value.algorithm;
    }
    const keyId = shortText(value.keyId);
    if (keyId) {
      summary.keyId = keyId;
    }
    const certificate = parseCertificateInfo(value.certificate);
    if (certificate) {
      summary.certificate = certificate;
    }
  }
  return summary;
}

/** Reads a document from the "secrets" collection; null when it's missing or malformed. */
export function parseSecretDocument(value: unknown): SecretDocument | null {
  // A document from a newer version may keep its secret differently: don't guess.
  if (!isPlainObject(value) || typeof value.id !== 'string' || !value.id || value.version !== 1) {
    return null;
  }
  const secret = parseStoredSecret(value.secret);
  const boundOrigin = parseOrigin(value.boundOrigin);
  if (!secret || !boundOrigin) {
    return null;
  }
  const document: SecretDocument = { id: value.id, version: 1, secret, boundOrigin };
  // A value that isn't an origin can't be compared with anything: it's refused, not ignored,
  // so a damaged binding never turns into no binding.
  if (value.apiOrigin !== undefined) {
    const apiOrigin = parseOrigin(value.apiOrigin);
    if (!apiOrigin) {
      return null;
    }
    document.apiOrigin = apiOrigin;
  }
  if (typeof value.__etag === 'number' && Number.isFinite(value.__etag)) {
    document.__etag = value.__etag;
  }
  const updatedBy = shortText(value.updatedBy);
  const updatedAt = isoDate(value.updatedAt);
  if (updatedBy) {
    document.updatedBy = updatedBy;
  }
  if (updatedAt) {
    document.updatedAt = updatedAt;
  }
  return document;
}

// Characters Azure DevOps or a browser may show in place of a hidden value.
const MASK_CHARACTERS = new Set(['*', '•', '●', '∙', '·']);

/**
 * True for text that only hides a value, like "********": what a process layout may return
 * instead of a control's password. Such text must never be saved as the secret.
 */
export function isMaskedValue(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  for (const character of value.trim()) {
    if (!MASK_CHARACTERS.has(character)) {
      return false;
    }
  }
  return true;
}

/**
 * The summary to keep in the configuration for a secret that's about to be saved. `apiOrigin`
 * is for OAuth 2.0 (see SecretSummary.apiOrigin).
 */
export function summarizeSecret(
  secret: StoredSecret,
  boundOrigin: string,
  stamp: { updatedBy?: string; updatedAt?: string } = {},
  certificate?: CertificateInfo,
  apiOrigin?: string
): SecretSummary {
  const summary: SecretSummary = { kind: secret.kind, boundOrigin, ...stamp };
  if (apiOrigin) {
    summary.apiOrigin = apiOrigin;
  }
  if (secret.kind === 'signingKey') {
    summary.algorithm = secret.key.algorithm;
    if (secret.key.kid) {
      summary.keyId = secret.key.kid;
    }
    if (certificate) {
      summary.certificate = certificate;
    }
  }
  return summary;
}
