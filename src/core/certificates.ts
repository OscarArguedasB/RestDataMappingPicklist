import type { Asn1Element, Bytes } from './asn1';
import {
  Asn1Error,
  TAG,
  bytesEqual,
  children,
  fromBase64,
  parseAsn1,
  readOctetString,
  readSequence,
  toBase64,
} from './asn1';
import { PicklistError } from './errors';
import {
  PasswordError,
  UnsupportedEncryptionError,
  decryptWithPassword,
  passwordEncodings,
  passwordIterations,
} from './pbe';
import type { Pkcs12Contents } from './pkcs12';
import { looksLikePkcs12, readPkcs12 } from './pkcs12';
import type { KeyType, NamedCurve, PrivateKey } from './privateKeys';
import {
  UnsupportedKeyError,
  readEcPrivateKey,
  readPrivateKeyInfo,
  readRsaPrivateKey,
  withPublicPoint,
} from './privateKeys';
import type { CertificateInfo, JwsAlgorithm, SigningKey } from './secrets';
import { SECRET_LIMITS } from './secrets';
import type { ParsedCertificate } from './x509';
import { parseCertificate } from './x509';

// Keys and certificates for OAuth 2.0 "private_key_jwt" sign-in, read from the files people
// have: PEM with one or several blocks, DER, or PKCS #12. Only the setup page uses this, and it
// loads it when someone picks a key; the form control signs with the SigningKey made here and
// never needs this code. Everything stays in memory, and messages name the file, never its
// contents or the password.

export type { KeyType, NamedCurve } from './privateKeys';

export interface CredentialSource {
  /** The file name, or a label such as “Pasted text”; used in messages. */
  name: string;
  /** The file's bytes, or the UTF-8 of pasted text. */
  data: Uint8Array;
}

export interface ParseCredentialOptions {
  /** For encrypted keys and PKCS #12 files. Empty or missing works for files without one. */
  password?: string;
  /** The "kid" header, for keys registered by key ID. */
  keyId?: string;
  /** Used when the key allows it; otherwise the key's default (see defaultAlgorithm). */
  algorithm?: JwsAlgorithm;
  /** When to check the certificate's dates against; tests set it. */
  now?: Date;
  /** WebCrypto, for tests. */
  subtle?: SubtleCrypto;
}

export interface ParsedCredential {
  signingKey: SigningKey;
  /** The certificate that belongs to the key, if one was given. */
  certificate: CertificateInfo | null;
  keyType: KeyType;
  /** RSA: the modulus size. EC: the curve size (256, 384 or 521). */
  keyBits: number;
  curve?: NamedCurve;
  /** Things worth knowing that don't stop it working, such as a certificate about to expire. */
  warnings: string[];
}

export const CREDENTIAL_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxSources: 10,
  minRsaBits: 2048,
  maxRsaBits: 16_384,
  expiryWarningDays: 30,
  /**
   * Password iterations, in all, that the encrypted keys chosen at once may ask for: two keys at
   * the most a single key may use (see pbe.ts). Without it, a file of 50 copies of a key with
   * 10 million iterations each would keep the page reading for minutes.
   */
  maxPasswordIterations: 20_000_000,
} as const;

const RSA_ALGORITHMS: readonly JwsAlgorithm[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
];
const EC_ALGORITHMS: Readonly<Record<NamedCurve, JwsAlgorithm>> = {
  'P-256': 'ES256',
  'P-384': 'ES384',
  'P-521': 'ES512',
};
const CURVE_BITS: Readonly<Record<number, NamedCurve>> = {
  256: 'P-256',
  384: 'P-384',
  521: 'P-521',
};

/**
 * The JWS algorithms a key can sign with: RSA keys of 2048 bits or more any RS* or PS*; EC keys
 * only the one for their curve (RFC 7518). Empty for keys that can't sign here.
 */
export function allowedAlgorithms(
  keyType: KeyType,
  keyBitsOrCurve: number | NamedCurve
): JwsAlgorithm[] {
  if (keyType === 'RSA') {
    const bits = typeof keyBitsOrCurve === 'number' ? keyBitsOrCurve : 0;
    return bits >= CREDENTIAL_LIMITS.minRsaBits && bits <= CREDENTIAL_LIMITS.maxRsaBits
      ? [...RSA_ALGORITHMS]
      : [];
  }
  const curve = typeof keyBitsOrCurve === 'number' ? CURVE_BITS[keyBitsOrCurve] : keyBitsOrCurve;
  const algorithm = curve ? EC_ALGORITHMS[curve] : undefined;
  return algorithm ? [algorithm] : [];
}

const UNSUPPORTED_KEY_ADVICE =
  'Use an RSA key of 2048 bits or more, or an EC key on P-256, P-384 or P-521.';

/** RS256 for RSA keys; ES256, ES384 or ES512 for EC keys, by curve. */
export function defaultAlgorithm(
  keyType: KeyType,
  keyBitsOrCurve: number | NamedCurve
): JwsAlgorithm {
  const [algorithm] = allowedAlgorithms(keyType, keyBitsOrCurve);
  if (!algorithm) {
    throw new PicklistError('config', `This key can’t sign here. ${UNSUPPORTED_KEY_ADVICE}`);
  }
  return algorithm;
}

// ---------------------------------------------------------------------------------------------
// Messages

function configError(message: string): PicklistError {
  return new PicklistError('config', message);
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/** `text` without control characters (they're all single UTF-16 code units). */
function withoutControls(text: string): string {
  let kept = '';
  for (let index = 0; index < text.length; index++) {
    if (!isControl(text.charCodeAt(index))) {
      kept += text[index];
    }
  }
  return kept;
}

/** A file name fit for a message. */
function displayName(name: unknown): string {
  const text = withoutControls(typeof name === 'string' ? name : '').trim();
  if (!text) {
    return 'Pasted text';
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function notRecognized(name: string): PicklistError {
  return configError(
    `“${name}” isn’t a key or certificate file. Use PEM, DER (.cer, .crt, .der, .key) or PKCS #12 (.pfx, .p12).`
  );
}

const CONVERT_KEY = 'openssl pkcs8 -topk8 -v2 aes-256-cbc -in key.pem -out key-pkcs8.pem';
const CONVERT_PFX = 'openssl pkcs12 -legacy -in cert.pfx -out cert.pem';

function unsupportedEncryption(
  name: string,
  error: UnsupportedEncryptionError,
  command: string
): PicklistError {
  if (error.browser) {
    return configError(
      `“${name}” is encrypted with ${error.algorithm}, which this browser can’t decrypt. Convert it with: ${command}`
    );
  }
  if (!error.convertible) {
    return configError(
      `“${name}” is protected with ${error.algorithm}, which isn’t supported. Export it again protected by a password.`
    );
  }
  return configError(
    `“${name}” is encrypted with ${error.algorithm}, which isn’t supported. Convert it with: ${command}`
  );
}

function unsupportedKey(name: string, error: UnsupportedKeyError): PicklistError {
  if (error.curve) {
    return configError(
      `The key in “${name}” is on ${error.curve}, which isn’t supported. ${UNSUPPORTED_KEY_ADVICE}`
    );
  }
  return configError(
    `The key in “${name}” is ${error.keyType}, which isn’t supported. ${UNSUPPORTED_KEY_ADVICE}`
  );
}

/** The message for anything that went wrong reading one file. */
function explain(error: unknown, name: string, password: string): PicklistError {
  if (error instanceof PicklistError) {
    return error;
  }
  if (error instanceof PasswordError) {
    return configError(
      password
        ? `The password for “${name}” is wrong.`
        : `“${name}” is protected by a password. Enter it and try again.`
    );
  }
  if (error instanceof UnsupportedKeyError) {
    return unsupportedKey(name, error);
  }
  if (error instanceof UnsupportedEncryptionError) {
    return unsupportedEncryption(name, error, CONVERT_KEY);
  }
  // Malformed ASN.1, bad base64 or anything unexpected: never pass on details of the contents.
  return configError(`“${name}” looks damaged or incomplete.`);
}

// ---------------------------------------------------------------------------------------------
// Reading files

interface FoundKey {
  key: PrivateKey;
  /** The display name of the file it came from. */
  source: string;
}

interface Context {
  password: string;
  subtle: SubtleCrypto;
  keys: FoundKey[];
  certificates: ParsedCertificate[];
  /** Public keys seen, only to explain a missing private key. */
  publicKeys: number;
  /** Encrypted keys already decrypted, by their DER in base64: the same one isn't decrypted twice. */
  decrypted: Map<string, PrivateKey>;
  /** Password iterations spent so far (see CREDENTIAL_LIMITS.maxPasswordIterations). */
  passwordIterations: number;
}

type DerKind = 'certificate' | 'pkcs8' | 'encryptedPkcs8' | 'pkcs1' | 'sec1' | 'publicKey';

/** What a DER structure is, from its outline. */
function classify(root: Asn1Element): DerKind | null {
  if (root.tag !== TAG.sequence) {
    return null;
  }
  const items = children(root);
  const [first, second, third] = items.map((item) => item.tag);
  if (first === TAG.sequence) {
    if (items.length === 3 && second === TAG.sequence && third === TAG.bitString) {
      return 'certificate';
    }
    if (items.length === 2 && second === TAG.octetString) {
      return 'encryptedPkcs8';
    }
    return items.length === 2 && second === TAG.bitString ? 'publicKey' : null;
  }
  if (first !== TAG.integer) {
    return null;
  }
  if (second === TAG.sequence && third === TAG.octetString) {
    return 'pkcs8';
  }
  if (second === TAG.integer) {
    // An RSAPrivateKey has nine integers, an RSAPublicKey two.
    return items.length >= 9 ? 'pkcs1' : items.length === 2 ? 'publicKey' : null;
  }
  return second === TAG.octetString ? 'sec1' : null;
}

async function readEncryptedKey(der: Bytes, context: Context, name: string): Promise<PrivateKey> {
  const id = toBase64(der);
  const known = context.decrypted.get(id);
  if (known) {
    return known;
  }
  const [algorithm, data] = readSequence(parseAsn1(der), 'an encrypted key');
  context.passwordIterations += passwordIterations(algorithm);
  if (context.passwordIterations > CREDENTIAL_LIMITS.maxPasswordIterations) {
    throw configError(
      `“${name}” has more password-protected keys than can be read at once. Choose only the key you need.`
    );
  }
  const key = await decryptKey(algorithm, data, context, name);
  context.decrypted.set(id, key);
  return key;
}

async function decryptKey(
  algorithm: Asn1Element | undefined,
  data: Asn1Element | undefined,
  context: Context,
  name: string
): Promise<PrivateKey> {
  let plain: Bytes;
  try {
    const passwords = passwordEncodings(context.password);
    plain = await decryptWithPassword(algorithm, readOctetString(data), passwords, context.subtle);
  } catch (error) {
    if (error instanceof UnsupportedEncryptionError) {
      throw unsupportedEncryption(name, error, CONVERT_KEY);
    }
    throw error;
  }
  try {
    return readPrivateKeyInfo(plain);
  } catch (error) {
    // Garbage that happened to decrypt with valid padding: the password was wrong after all.
    throw error instanceof Asn1Error ? new PasswordError() : error;
  }
}

async function readKind(kind: DerKind, der: Bytes, context: Context, name: string): Promise<void> {
  const addKey = (key: PrivateKey) => context.keys.push({ key, source: name });
  switch (kind) {
    case 'certificate':
      context.certificates.push(await parseCertificate(der, context.subtle));
      break;
    case 'pkcs8':
      addKey(readPrivateKeyInfo(der));
      break;
    case 'encryptedPkcs8':
      addKey(await readEncryptedKey(der, context, name));
      break;
    case 'pkcs1':
      addKey(readRsaPrivateKey(der));
      break;
    case 'sec1':
      addKey(readEcPrivateKey(der));
      break;
    case 'publicKey':
      context.publicKeys++;
      break;
  }
}

async function readPfx(der: Bytes, context: Context, name: string): Promise<void> {
  let contents: Pkcs12Contents;
  try {
    contents = await readPkcs12(der, context.password, context.subtle);
  } catch (error) {
    if (error instanceof UnsupportedEncryptionError) {
      throw unsupportedEncryption(name, error, CONVERT_PFX);
    }
    throw error;
  }
  for (const key of contents.keys) {
    context.keys.push({ key: readPrivateKeyInfo(key), source: name });
  }
  for (const certificate of contents.certificates) {
    context.certificates.push(await parseCertificate(certificate, context.subtle));
  }
}

/** DER, or the BER of a PKCS #12 file. */
async function readBinary(bytes: Bytes, context: Context, name: string): Promise<void> {
  const root = parseAsn1(bytes, { ber: true });
  if (looksLikePkcs12(root)) {
    await readPfx(bytes, context, name);
    return;
  }
  // Everything else must be strict DER.
  const kind = classify(parseAsn1(bytes));
  if (!kind) {
    throw notRecognized(name);
  }
  await readKind(kind, bytes, context, name);
}

/** PEM labels (RFC 7468 and OpenSSL's older ones) and what they hold. */
const PEM_LABELS: Readonly<Record<string, DerKind>> = {
  CERTIFICATE: 'certificate',
  'X509 CERTIFICATE': 'certificate',
  'PRIVATE KEY': 'pkcs8',
  'ENCRYPTED PRIVATE KEY': 'encryptedPkcs8',
  'RSA PRIVATE KEY': 'pkcs1',
  'EC PRIVATE KEY': 'sec1',
  'PUBLIC KEY': 'publicKey',
  'RSA PUBLIC KEY': 'publicKey',
};

const MAX_PEM_BLOCKS = 50;
const PEM_MARKER = /-----(BEGIN|END) ([A-Z0-9 ]{1,64})-----/g;

interface PemBlock {
  label: string;
  headers: string[];
  base64: string;
}

function pemBlock(label: string, body: string): PemBlock {
  const block: PemBlock = { label, headers: [], base64: '' };
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (!block.base64 && line.includes(':')) {
      // RFC 1421 headers, such as Proc-Type, come before the base64.
      block.headers.push(line.trim());
    } else {
      block.base64 += line.replace(/\s+/g, '');
    }
  }
  return block;
}

/**
 * The PEM blocks in text, in order. Text around them, such as OpenSSL's "Bag Attributes", is
 * skipped. The markers don't need lines of their own, so a key pasted as one line still reads.
 */
function readPem(text: string): PemBlock[] {
  // A key copied out of a JSON file keeps its line breaks as \n.
  const source = text.includes('\\n') ? text.replace(/\\r\\n|\\n/g, '\n') : text;
  const blocks: PemBlock[] = [];
  let open: { label: string; start: number } | null = null;
  for (const marker of source.matchAll(PEM_MARKER)) {
    if (marker[1] === 'BEGIN' && !open) {
      open = { label: marker[2], start: marker.index + marker[0].length };
    } else if (marker[1] === 'END' && open?.label === marker[2]) {
      blocks.push(pemBlock(open.label, source.slice(open.start, marker.index)));
      open = null;
      if (blocks.length > MAX_PEM_BLOCKS) {
        throw new Asn1Error('Too many PEM blocks.');
      }
    } else {
      throw new Asn1Error('Mismatched PEM markers.');
    }
  }
  if (open) {
    throw new Asn1Error('PEM block cut short.');
  }
  return blocks;
}

/**
 * Refuses text whose distinct encrypted keys ask for more password iterations in all than may be
 * spent (see CREDENTIAL_LIMITS.maxPasswordIterations), before any is decrypted.
 */
function checkPasswordWork(blocks: readonly PemBlock[], context: Context, name: string): void {
  const encrypted = new Set(
    blocks
      .filter((block) => PEM_LABELS[block.label] === 'encryptedPkcs8')
      .map((block) => block.base64)
  );
  let total = context.passwordIterations;
  for (const base64 of encrypted) {
    const der = fromBase64(base64);
    if (!der?.length) {
      continue;
    }
    try {
      const [algorithm] = readSequence(parseAsn1(der), 'an encrypted key');
      total += passwordIterations(algorithm);
    } catch {
      // Reading the block explains it.
    }
  }
  if (total > CREDENTIAL_LIMITS.maxPasswordIterations) {
    throw configError(
      `“${name}” has more password-protected keys than can be read at once. Choose only the key you need.`
    );
  }
}

async function readPemText(text: string, context: Context, name: string): Promise<void> {
  const blocks = readPem(text);
  checkPasswordWork(blocks, context, name);
  for (const block of blocks) {
    if (block.headers.some((header) => /^Proc-Type:\s*4\s*,\s*ENCRYPTED\b/i.test(header))) {
      throw configError(
        `“${name}” uses an old encryption format. Convert it to PKCS #8 with: openssl pkcs8 -topk8 -in key.pem -out key-pkcs8.pem`
      );
    }
    if (block.label === 'OPENSSH PRIVATE KEY') {
      throw configError(
        `“${name}” is an OpenSSH key. Convert a copy to PKCS #8 with: ssh-keygen -p -m PKCS8 -f key-copy`
      );
    }
    if (block.label === 'DSA PRIVATE KEY') {
      throw new UnsupportedKeyError('DSA');
    }
    const kind = PEM_LABELS[block.label];
    // Other blocks, such as EC PARAMETERS next to an EC key, aren't needed.
    if (kind) {
      const der = fromBase64(block.base64);
      if (!der?.length) {
        throw new Asn1Error('Bad base64.');
      }
      await readKind(kind, der, context, name);
    }
  }
}

function decodeText(data: Bytes): string {
  // Windows PowerShell 5 writes UTF-16 with a byte order mark.
  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(data.subarray(2));
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(data.subarray(2));
  }
  return new TextDecoder('utf-8').decode(data);
}

async function readSource(source: CredentialSource, context: Context): Promise<void> {
  const name = displayName(source.name);
  if (!(source.data instanceof Uint8Array)) {
    throw notRecognized(name);
  }
  if (source.data.length === 0) {
    throw configError(`“${name}” is empty.`);
  }
  if (source.data.length > CREDENTIAL_LIMITS.maxFileBytes) {
    throw configError(`“${name}” is larger than 1 MB, so it isn’t a key or certificate file.`);
  }
  // A copy on a plain ArrayBuffer, which WebCrypto needs.
  const data = Uint8Array.from(source.data);
  const before = context.keys.length + context.certificates.length + context.publicKeys;
  try {
    // DER starts with a SEQUENCE, which is never how PEM or base64 text starts.
    if (data[0] === TAG.sequence) {
      await readBinary(data, context, name);
    } else {
      const text = decodeText(data);
      if (text.includes('-----BEGIN ')) {
        await readPemText(text, context, name);
      } else {
        // Base64 without the PEM lines, as some portals show a certificate.
        const der = fromBase64(text.replace(/\s+/g, ''));
        if (der?.[0] !== TAG.sequence) {
          throw notRecognized(name);
        }
        await readBinary(der, context, name);
      }
    }
  } catch (error) {
    throw explain(error, name, context.password);
  }
  if (context.keys.length + context.certificates.length + context.publicKeys === before) {
    throw notRecognized(name);
  }
}

// ---------------------------------------------------------------------------------------------
// The key and its certificate

/** One entry per key, preferring the copy that includes an EC public key. */
function uniqueKeys(keys: readonly FoundKey[]): FoundKey[] {
  const unique: FoundKey[] = [];
  for (const entry of keys) {
    const index = unique.findIndex(
      (other) =>
        other.key.keyType === entry.key.keyType &&
        bytesEqual(other.key.identity, entry.key.identity)
    );
    if (index < 0) {
      unique.push(entry);
    } else if (!unique[index].key.publicPoint && entry.key.publicPoint) {
      unique[index] = entry;
    }
  }
  return unique;
}

function uniqueCertificates(certificates: readonly ParsedCertificate[]): ParsedCertificate[] {
  const seen = new Set<string>();
  return certificates.filter((certificate) => {
    const thumbprint = certificate.info.sha256Thumbprint;
    if (seen.has(thumbprint)) {
      return false;
    }
    seen.add(thumbprint);
    return true;
  });
}

interface WebCryptoParameters {
  key: RsaHashedImportParams | EcKeyImportParams;
  signature: AlgorithmIdentifier | EcdsaParams;
}

function webCryptoParameters(key: PrivateKey): WebCryptoParameters {
  return key.keyType === 'RSA'
    ? { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, signature: 'RSASSA-PKCS1-v1_5' }
    : {
        key: { name: 'ECDSA', namedCurve: key.curve ?? '' },
        signature: { name: 'ECDSA', hash: 'SHA-256' },
      };
}

async function importPrivateKey(key: PrivateKey, subtle: SubtleCrypto): Promise<CryptoKey | null> {
  try {
    return await subtle.importKey('pkcs8', key.pkcs8, webCryptoParameters(key).key, false, [
      'sign',
    ]);
  } catch {
    return null;
  }
}

const CHECK_MESSAGE = new TextEncoder().encode('REST Picklist key check');

/** A signature over a fixed message; null when the key doesn't sign, as a damaged key won't. */
async function checkSignature(
  key: PrivateKey,
  privateKey: CryptoKey,
  subtle: SubtleCrypto
): Promise<ArrayBuffer | null> {
  try {
    return await subtle.sign(webCryptoParameters(key).signature, privateKey, CHECK_MESSAGE);
  } catch {
    return null;
  }
}

/** The certificates whose public key verifies `signature` (see checkSignature). */
async function matchingCertificates(
  key: PrivateKey,
  signature: ArrayBuffer,
  certificates: readonly ParsedCertificate[],
  subtle: SubtleCrypto
): Promise<ParsedCertificate[]> {
  const parameters = webCryptoParameters(key);
  const candidates = certificates.filter(
    ({ publicKey }) =>
      publicKey.keyType === key.keyType &&
      publicKey.keyBits === key.keyBits &&
      publicKey.curve === key.curve
  );
  const matches: ParsedCertificate[] = [];
  for (const certificate of candidates) {
    try {
      const publicKey = await subtle.importKey(
        'spki',
        certificate.publicKey.spki,
        parameters.key,
        false,
        ['verify']
      );
      if (await subtle.verify(parameters.signature, publicKey, signature, CHECK_MESSAGE)) {
        matches.push(certificate);
      }
    } catch {
      // A public key this browser can't import doesn't match.
    }
  }
  return matches;
}

/**
 * The key ready to sign, with its EC public point added, and a signature it made (see
 * checkSignature) to find its certificate with.
 */
async function usableKey(
  entry: FoundKey,
  certificates: readonly ParsedCertificate[],
  subtle: SubtleCrypto
): Promise<{ key: PrivateKey; signature: ArrayBuffer }> {
  let key = entry.key;
  try {
    key = await withPublicPoint(key, subtle);
  } catch {
    // This browser can't import an EC key without its public point; a certificate may have it.
  }
  const imported = await importPrivateKey(key, subtle);
  if (imported) {
    const signature = await checkSignature(key, imported, subtle);
    if (signature) {
      return { key, signature };
    }
  } else if (key.keyType === 'EC' && !key.publicPoint) {
    for (const certificate of certificates) {
      const point = certificate.publicKey.publicPoint;
      if (!point || certificate.publicKey.curve !== key.curve) {
        continue;
      }
      const candidate = await withPublicPoint(key, subtle, point);
      const cryptoKey = await importPrivateKey(candidate, subtle);
      const signature = cryptoKey && (await checkSignature(candidate, cryptoKey, subtle));
      if (
        signature &&
        (await matchingCertificates(candidate, signature, [certificate], subtle)).length
      ) {
        return { key: candidate, signature };
      }
    }
  }
  throw configError(`The private key in “${entry.source}” can’t be used. It may be damaged.`);
}

function checkKeySize(entry: FoundKey): void {
  const { key, source } = entry;
  if (key.keyType !== 'RSA') {
    return;
  }
  if (key.keyBits < CREDENTIAL_LIMITS.minRsaBits) {
    throw configError(
      `The RSA key in “${source}” is ${key.keyBits} bits. Use one of at least ${CREDENTIAL_LIMITS.minRsaBits} bits.`
    );
  }
  if (key.keyBits > CREDENTIAL_LIMITS.maxRsaBits) {
    throw configError(
      `The RSA key in “${source}” is ${key.keyBits} bits. Use one of at most ${CREDENTIAL_LIMITS.maxRsaBits} bits.`
    );
  }
}

function readKeyId(keyId: unknown): string | undefined {
  const value = typeof keyId === 'string' ? keyId.trim() : '';
  if (!value) {
    return undefined;
  }
  if (value.length > SECRET_LIMITS.maxTextLength) {
    throw configError(`The key ID can have ${SECRET_LIMITS.maxTextLength} characters at most.`);
  }
  if (withoutControls(value) !== value) {
    throw configError('The key ID can’t contain line breaks or other control characters.');
  }
  return value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Such as “22 Oct 2026”, in UTC. */
function formatDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const DAY_MS = 86_400_000;

function validityWarnings(certificate: ParsedCertificate, now: Date): string[] {
  const time = now.getTime();
  if (time < certificate.notBefore.getTime()) {
    return [`The certificate isn’t valid until ${formatDate(certificate.notBefore)}.`];
  }
  const left = certificate.notAfter.getTime() - time;
  if (left < 0) {
    return [`The certificate expired on ${formatDate(certificate.notAfter)}.`];
  }
  if (left <= CREDENTIAL_LIMITS.expiryWarningDays * DAY_MS) {
    const days = Math.floor(left / DAY_MS);
    const when = days === 0 ? 'in less than a day' : days === 1 ? 'in 1 day' : `in ${days} days`;
    return [`The certificate expires on ${formatDate(certificate.notAfter)} (${when}).`];
  }
  return [];
}

/** Of several certificates for the same key, the one valid now that lasts longest. */
function preferredCertificate(matches: readonly ParsedCertificate[], now: Date): ParsedCertificate {
  const time = now.getTime();
  const valid = (certificate: ParsedCertificate) =>
    certificate.notBefore.getTime() <= time && time <= certificate.notAfter.getTime();
  return matches.toSorted(
    (a, b) => Number(valid(b)) - Number(valid(a)) || b.notAfter.getTime() - a.notAfter.getTime()
  )[0];
}

/**
 * Reads the private key, and the certificate that belongs to it if there's one, from files or
 * pasted text: PEM (CERTIFICATE, PRIVATE KEY, RSA PRIVATE KEY, EC PRIVATE KEY, ENCRYPTED PRIVATE
 * KEY), DER certificates and keys, and PKCS #12. Exactly one private key must be found across
 * all of them. Certificates that don't belong to it (such as a CA chain) are skipped, but when
 * none belongs to it that's an error. Every failure is a PicklistError for the setup page.
 */
export async function parseCredentials(
  sources: readonly CredentialSource[],
  options: ParseCredentialOptions = {}
): Promise<ParsedCredential> {
  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) {
    throw configError(
      'This browser can’t read keys on this page, because WebCrypto isn’t available.'
    );
  }
  if (sources.length === 0) {
    throw configError('Choose a key or certificate file, or paste one.');
  }
  if (sources.length > CREDENTIAL_LIMITS.maxSources) {
    throw configError(`Choose ${CREDENTIAL_LIMITS.maxSources} files at most.`);
  }
  const kid = readKeyId(options.keyId);
  const now = options.now ?? new Date();
  const context: Context = {
    password: typeof options.password === 'string' ? options.password : '',
    subtle,
    keys: [],
    certificates: [],
    publicKeys: 0,
    decrypted: new Map(),
    passwordIterations: 0,
  };
  for (const source of sources) {
    await readSource(source, context);
  }
  const keys = uniqueKeys(context.keys);
  const certificates = uniqueCertificates(context.certificates);
  if (keys.length === 0) {
    if (certificates.length > 0) {
      throw configError(
        'There’s a certificate but no private key. Add the private key, or a .pfx file that includes it.'
      );
    }
    throw configError(
      context.publicKeys > 0
        ? 'That’s a public key. Add the private key that goes with it.'
        : 'No private key found. Add the private key: PEM, DER or a .pfx file.'
    );
  }
  if (keys.length > 1) {
    throw configError(
      `Found ${keys.length} different private keys. Use only the one this configuration signs with.`
    );
  }
  checkKeySize(keys[0]);
  const { key, signature } = await usableKey(keys[0], certificates, subtle);
  let certificate: ParsedCertificate | null = null;
  const warnings: string[] = [];
  if (certificates.length > 0) {
    const matches = await matchingCertificates(key, signature, certificates, subtle);
    if (matches.length === 0) {
      throw configError(
        certificates.length === 1
          ? 'The certificate doesn’t match the private key.'
          : 'None of the certificates matches the private key.'
      );
    }
    certificate = preferredCertificate(matches, now);
    if (matches.length > 1) {
      warnings.push('Several certificates belong to this key. The one valid the longest is used.');
    }
    warnings.push(...validityWarnings(certificate, now));
  }
  const allowed = allowedAlgorithms(key.keyType, key.curve ?? key.keyBits);
  const algorithm =
    options.algorithm && allowed.includes(options.algorithm) ? options.algorithm : allowed[0];
  const pkcs8 = toBase64(key.pkcs8);
  // Neither happens with the size limits above; the saved secret's own limits must hold anyway.
  if (!algorithm || pkcs8.length > SECRET_LIMITS.maxKeyLength) {
    throw configError(`This key can’t be saved. ${UNSUPPORTED_KEY_ADVICE}`);
  }
  const signingKey: SigningKey = { pkcs8, algorithm };
  if (certificate) {
    signingKey.x5t = certificate.x5t;
    signingKey.x5tS256 = certificate.x5tS256;
  }
  if (kid) {
    signingKey.kid = kid;
  }
  const parsed: ParsedCredential = {
    signingKey,
    certificate: certificate ? certificate.info : null,
    keyType: key.keyType,
    keyBits: key.keyBits,
    warnings,
  };
  if (key.curve) {
    parsed.curve = key.curve;
  }
  return parsed;
}
