import type { Asn1Element, Bytes } from './asn1';
import {
  Asn1Error,
  TAG,
  concatBytes,
  isSingleElement,
  readOctetString,
  readOid,
  readSequence,
  readSmallInteger,
} from './asn1';
import { rc2CbcDecrypt, tripleDesCbcDecrypt } from './legacyCiphers';
import type { HashFunction } from './sha';
import { sha1, sha224, sha256 } from './sha';

// Password-based decryption of keys and PKCS #12 contents: PBES2 (PBKDF2 with AES-CBC or Triple
// DES), the older PKCS #12 schemes (Triple DES and RC2, keyed by the PKCS #12 KDF) and the
// PKCS #12 integrity MAC. WebCrypto does the HMAC, PBKDF2, AES and single digests; the PKCS #12
// KDF's thousands of chained digests and everything SHA-224 run in TypeScript (see sha.ts).

export type HashName = 'SHA-1' | 'SHA-224' | 'SHA-256' | 'SHA-384' | 'SHA-512';

/** Output and block sizes in bytes. */
const HASHES: Record<HashName, { length: number; blockSize: number }> = {
  'SHA-1': { length: 20, blockSize: 64 },
  'SHA-224': { length: 28, blockSize: 64 },
  'SHA-256': { length: 32, blockSize: 64 },
  'SHA-384': { length: 48, blockSize: 128 },
  'SHA-512': { length: 64, blockSize: 128 },
};

export function hashLength(hash: HashName): number {
  return HASHES[hash].length;
}

/** Digest algorithm identifiers, as a PKCS #12 MAC names them. */
export const DIGEST_ALGORITHMS: Readonly<Record<string, HashName>> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.4': 'SHA-224',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

/** HMAC algorithm identifiers, as PBKDF2 and PBMAC1 name them. */
export const HMAC_ALGORITHMS: Readonly<Record<string, HashName>> = {
  '1.2.840.113549.2.7': 'SHA-1',
  '1.2.840.113549.2.8': 'SHA-224',
  '1.2.840.113549.2.9': 'SHA-256',
  '1.2.840.113549.2.10': 'SHA-384',
  '1.2.840.113549.2.11': 'SHA-512',
};

export const PBES2 = '1.2.840.113549.1.5.13';
export const PBKDF2 = '1.2.840.113549.1.5.12';

/** Encryption the files use that this code doesn't read, named for messages. */
const UNSUPPORTED_NAMES: Readonly<Record<string, string>> = {
  '1.2.840.113549.1.5.1': 'PBES1 (MD2 and DES)',
  '1.2.840.113549.1.5.3': 'PBES1 (MD5 and DES)',
  '1.2.840.113549.1.5.4': 'PBES1 (MD2 and RC2)',
  '1.2.840.113549.1.5.6': 'PBES1 (MD5 and RC2)',
  '1.2.840.113549.1.5.10': 'PBES1 (SHA-1 and DES)',
  '1.2.840.113549.1.5.11': 'PBES1 (SHA-1 and RC2)',
  '1.2.840.113549.1.12.1.1': '128-bit RC4',
  '1.2.840.113549.1.12.1.2': '40-bit RC4',
  '1.3.6.1.4.1.11591.4.11': 'scrypt',
  '1.3.14.3.2.7': 'DES',
  '2.16.840.1.101.3.4.1.6': 'AES-GCM',
  '2.16.840.1.101.3.4.1.26': 'AES-GCM',
  '2.16.840.1.101.3.4.1.46': 'AES-GCM',
  '1.2.840.113549.3.2': 'RC2',
};

/** Encryption, a key derivation or a MAC that this code doesn't support. */
export class UnsupportedEncryptionError extends Error {
  /** A plain name for messages, such as “scrypt”. */
  readonly algorithm: string;
  /** True when it's this browser that can't do it (WebCrypto in Chrome has no AES-192). */
  readonly browser: boolean;
  /** False when OpenSSL can't convert it either, such as PKCS #12 signed with a key. */
  readonly convertible: boolean;

  constructor(algorithm: string, options: { browser?: boolean; convertible?: boolean } = {}) {
    super(`Unsupported encryption: ${algorithm}.`);
    this.name = 'UnsupportedEncryptionError';
    this.algorithm = algorithm;
    this.browser = options.browser ?? false;
    this.convertible = options.convertible ?? true;
  }
}

/** Decryption or a MAC check failed: almost always a wrong password. */
export class PasswordError extends Error {
  constructor() {
    super('Wrong password or damaged data.');
    this.name = 'PasswordError';
  }
}

function unsupported(oid: string): UnsupportedEncryptionError {
  return new UnsupportedEncryptionError(UNSUPPORTED_NAMES[oid] ?? `an unknown method (${oid})`);
}

/** Generous limits that keep a malicious file from freezing the page. */
const LIMITS = {
  /** PBKDF2 runs inside WebCrypto, so it's fast; SHA-224 runs in TypeScript. */
  pbkdf2Iterations: 10_000_000,
  /**
   * About a second per key on the page's own thread (each round is two SHA-224 digests). Real
   * files ask for a few thousand, and SHA-224 is rarely used at all.
   */
  sha224Iterations: 100_000,
  /** The PKCS #12 KDF takes one digest per iteration, on the page's own thread. */
  pkcs12Iterations: 100_000,
  saltLength: 1024,
} as const;

/** HMAC-SHA-224 rounds of PBKDF2 between pauses, about 20 ms of work. */
const HMAC_ROUNDS_BETWEEN_PAUSES = 2048;

/** Hashes the PKCS #12 KDF runs in TypeScript; SHA-384 and SHA-512 files use WebCrypto. */
const TYPESCRIPT_HASHES: Readonly<Partial<Record<HashName, HashFunction>>> = {
  'SHA-1': sha1,
  'SHA-224': sha224,
  'SHA-256': sha256,
};

function checkIterations(iterations: number, limit: number): void {
  if (iterations < 1) {
    throw new Asn1Error('Bad iteration count.');
  }
  if (iterations > limit) {
    throw new UnsupportedEncryptionError(
      `${iterations.toLocaleString('en-US')} password iterations`
    );
  }
}

function readSalt(element: Asn1Element | undefined): Bytes {
  const salt = readOctetString(element);
  if (salt.length > LIMITS.saltLength) {
    throw new Asn1Error('Salt too long.');
  }
  return salt;
}

// ---------------------------------------------------------------------------------------------
// Passwords

/** A password as each scheme wants it. */
export interface PasswordEncodings {
  /** PBES2 and PBMAC1: UTF-8, as OpenSSL does. */
  utf8: Bytes;
  /**
   * The PKCS #12 KDF: UTF-16BE (BMPString) ending in two zero bytes. An empty password is tried
   * both ways, as OpenSSL does: no bytes at all, then just the two zero bytes.
   */
  bmp: Bytes[];
}

export function passwordEncodings(password: string): PasswordEncodings {
  const utf8 = new TextEncoder().encode(password);
  if (!password) {
    return { utf8, bmp: [new Uint8Array(0), new Uint8Array(2)] };
  }
  const bmp = new Uint8Array(password.length * 2 + 2);
  for (let index = 0; index < password.length; index++) {
    const unit = password.charCodeAt(index);
    bmp[2 * index] = unit >>> 8;
    bmp[2 * index + 1] = unit & 0xff;
  }
  return { utf8, bmp: [bmp] };
}

// ---------------------------------------------------------------------------------------------
// Hashes, HMAC and PBKDF2

function hmacSha224(key: Uint8Array, data: Uint8Array): Bytes {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha224(key) : key);
  const inner = block.map((byte) => byte ^ 0x36);
  const outer = block.map((byte) => byte ^ 0x5c);
  return sha224(concatBytes([outer, sha224(concatBytes([inner, data]))]));
}

async function pbkdf2Sha224(
  password: Bytes,
  salt: Bytes,
  iterations: number,
  length: number
): Promise<Bytes> {
  const output = new Uint8Array(length);
  for (let block = 1, offset = 0; offset < length; block++, offset += 28) {
    const index = Uint8Array.of(
      block >>> 24,
      (block >>> 16) & 0xff,
      (block >>> 8) & 0xff,
      block & 0xff
    );
    let u = hmacSha224(password, concatBytes([salt, index]));
    const t = u.slice();
    for (let round = 1; round < iterations; round++) {
      u = hmacSha224(password, u);
      for (let byte = 0; byte < t.length; byte++) {
        t[byte] ^= u[byte];
      }
      // Like the PKCS #12 KDF below: a long derivation mustn't freeze the page while it runs.
      if (round % HMAC_ROUNDS_BETWEEN_PAUSES === 0) {
        await pause();
      }
    }
    output.set(t.subarray(0, Math.min(28, length - offset)), offset);
  }
  return output;
}

export async function digest(hash: HashName, data: Bytes, subtle: SubtleCrypto): Promise<Bytes> {
  return hash === 'SHA-224' ? sha224(data) : new Uint8Array(await subtle.digest(hash, data));
}

export async function hmac(
  hash: HashName,
  key: Bytes,
  data: Bytes,
  subtle: SubtleCrypto
): Promise<Bytes> {
  if (hash === 'SHA-224') {
    return hmacSha224(key, data);
  }
  const cryptoKey = await subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', cryptoKey, data));
}

export async function pbkdf2(
  hash: HashName,
  password: Bytes,
  salt: Bytes,
  iterations: number,
  length: number,
  subtle: SubtleCrypto
): Promise<Bytes> {
  if (hash === 'SHA-224') {
    checkIterations(iterations, LIMITS.sha224Iterations);
    return pbkdf2Sha224(password, salt, iterations, length);
  }
  checkIterations(iterations, LIMITS.pbkdf2Iterations);
  const key = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash, salt, iterations }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------------------------
// The PKCS #12 KDF (RFC 7292, appendix B.2)

/** What the derived bytes are for. */
export const PKCS12_KEY_MATERIAL = 1;
export const PKCS12_IV = 2;
export const PKCS12_MAC_KEY = 3;

/** Rounds hashed in TypeScript between pauses, about 15 ms of work. */
const ROUNDS_BETWEEN_PAUSES = 32_768;

/** Lets the page handle input and repaint before hashing goes on. */
function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The digest of `data`, hashed again until there have been `rounds` digests in all. */
async function chainedDigest(
  hash: HashName,
  data: Bytes,
  rounds: number,
  subtle: SubtleCrypto
): Promise<Bytes> {
  let block = data;
  const typescript = TYPESCRIPT_HASHES[hash];
  if (typescript) {
    for (let round = 1; round <= rounds; round++) {
      block = typescript(block);
      // Real files ask for a few thousand rounds and never pause; a file asking for the
      // maximum mustn't freeze the page while it's read.
      if (round % ROUNDS_BETWEEN_PAUSES === 0 && round < rounds) {
        await pause();
      }
    }
    return block;
  }
  for (let round = 0; round < rounds; round++) {
    block = await digest(hash, block, subtle);
  }
  return block;
}

/** `source` repeated to fill whole blocks of `size` bytes; empty stays empty. */
function fillBlocks(source: Bytes, size: number): Bytes {
  const output = new Uint8Array(Math.ceil(source.length / size) * size);
  for (let index = 0; index < output.length; index++) {
    output[index] = source[index % source.length];
  }
  return output;
}

/**
 * Derives `length` bytes from a BMPString password (see passwordEncodings) and a salt. `id`
 * says what for: key material, an IV or a MAC key.
 */
export async function pkcs12Kdf(
  hash: HashName,
  password: Bytes,
  salt: Bytes,
  iterations: number,
  id: number,
  length: number,
  subtle: SubtleCrypto
): Promise<Bytes> {
  checkIterations(iterations, LIMITS.pkcs12Iterations);
  const { length: u, blockSize: v } = HASHES[hash];
  const diversifier = new Uint8Array(v).fill(id);
  const input = concatBytes([fillBlocks(salt, v), fillBlocks(password, v)]);
  const output = new Uint8Array(length);
  for (let offset = 0; ; offset += u) {
    const block = await chainedDigest(hash, concatBytes([diversifier, input]), iterations, subtle);
    output.set(block.subarray(0, Math.min(u, length - offset)), offset);
    if (offset + u >= length) {
      return output;
    }
    // Each v-byte block of the input becomes (block + B + 1) mod 2^(8v), where B repeats A.
    const repeated = fillBlocks(block, v).subarray(0, v);
    for (let start = 0; start < input.length; start += v) {
      let carry = 1;
      for (let index = v - 1; index >= 0; index--) {
        const sum = input[start + index] + repeated[index] + carry;
        input[start + index] = sum & 0xff;
        carry = sum >>> 8;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Decryption

/** Removes PKCS #7 padding; null when it isn't valid, which usually means a wrong password. */
function removePadding(data: Bytes, blockSize: number): Bytes | null {
  const count = data.length > 0 ? data[data.length - 1] : 0;
  if (count < 1 || count > blockSize || count > data.length) {
    return null;
  }
  for (let index = data.length - count; index < data.length; index++) {
    if (data[index] !== count) {
      return null;
    }
  }
  return data.subarray(0, data.length - count);
}

interface Pbes2Cipher {
  name: 'AES-CBC' | 'DES-EDE3-CBC';
  keyLength: number;
  ivLength: number;
}

const PBES2_CIPHERS: Readonly<Record<string, Pbes2Cipher>> = {
  '2.16.840.1.101.3.4.1.2': { name: 'AES-CBC', keyLength: 16, ivLength: 16 },
  '2.16.840.1.101.3.4.1.22': { name: 'AES-CBC', keyLength: 24, ivLength: 16 },
  '2.16.840.1.101.3.4.1.42': { name: 'AES-CBC', keyLength: 32, ivLength: 16 },
  '1.2.840.113549.3.7': { name: 'DES-EDE3-CBC', keyLength: 24, ivLength: 8 },
};

/** PBKDF2-params: salt, iterations, an optional key length and the PRF (HMAC-SHA1 by default). */
export function readPbkdf2Params(element: Asn1Element | undefined): {
  salt: Bytes;
  iterations: number;
  keyLength: number | null;
  prf: HashName;
} {
  const [saltElement, iterationsElement, ...rest] = readSequence(element, 'PBKDF2 parameters');
  if (saltElement?.tag !== TAG.octetString) {
    throw new UnsupportedEncryptionError('PBKDF2 with a salt from another source');
  }
  const salt = readSalt(saltElement);
  const iterations = readSmallInteger(iterationsElement);
  let keyLength: number | null = null;
  if (rest[0]?.tag === TAG.integer) {
    keyLength = readSmallInteger(rest.shift());
  }
  let prf: HashName = 'SHA-1';
  if (rest.length > 0) {
    const [prfOid] = readSequence(rest.shift(), 'a PRF');
    const oid = readOid(prfOid);
    const hash = HMAC_ALGORITHMS[oid];
    if (!hash) {
      throw new UnsupportedEncryptionError(`PBKDF2 with ${UNSUPPORTED_NAMES[oid] ?? oid}`);
    }
    prf = hash;
  }
  if (rest.length > 0) {
    throw new Asn1Error('Unexpected PBKDF2 parameters.');
  }
  return { salt, iterations, keyLength, prf };
}

async function aesCbcDecrypt(
  key: Bytes,
  iv: Bytes,
  data: Bytes,
  subtle: SubtleCrypto
): Promise<Bytes> {
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  } catch {
    // Chrome and Edge don't do AES-192.
    throw new UnsupportedEncryptionError(`AES-${key.length * 8}`, { browser: true });
  }
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data));
  } catch {
    // WebCrypto checks the padding and fails without saying why.
    throw new PasswordError();
  }
}

async function decryptPbes2(
  params: Asn1Element | undefined,
  data: Bytes,
  password: Bytes,
  subtle: SubtleCrypto
): Promise<Bytes> {
  const [kdf, scheme] = readSequence(params, 'PBES2 parameters');
  const [kdfOid, kdfParams] = readSequence(kdf, 'a key derivation');
  const kdfName = readOid(kdfOid);
  if (kdfName !== PBKDF2) {
    throw unsupported(kdfName);
  }
  const [schemeOid, ivElement] = readSequence(scheme, 'an encryption scheme');
  const schemeName = readOid(schemeOid);
  const cipher = PBES2_CIPHERS[schemeName];
  if (!cipher) {
    throw unsupported(schemeName);
  }
  const iv = readOctetString(ivElement);
  const { salt, iterations, keyLength, prf } = readPbkdf2Params(kdfParams);
  if (iv.length !== cipher.ivLength || (keyLength !== null && keyLength !== cipher.keyLength)) {
    throw new Asn1Error('PBES2 parameters don’t match the cipher.');
  }
  const key = await pbkdf2(prf, password, salt, iterations, cipher.keyLength, subtle);
  if (data.length === 0 || data.length % cipher.ivLength !== 0) {
    throw new PasswordError();
  }
  if (cipher.name === 'AES-CBC') {
    return aesCbcDecrypt(key, iv, data, subtle);
  }
  const plain = removePadding(tripleDesCbcDecrypt(key, iv, data), 8);
  if (!plain) {
    throw new PasswordError();
  }
  return plain;
}

interface Pkcs12Scheme {
  cipher: 'DES-EDE3-CBC' | 'RC2-CBC';
  keyLength: number;
  /** RC2 only. */
  effectiveBits?: number;
}

/** pkcs-12PbeIds; RC4 (1 and 2) isn't supported. */
const PKCS12_SCHEMES: Readonly<Record<string, Pkcs12Scheme>> = {
  '1.2.840.113549.1.12.1.3': { cipher: 'DES-EDE3-CBC', keyLength: 24 },
  '1.2.840.113549.1.12.1.4': { cipher: 'DES-EDE3-CBC', keyLength: 16 },
  '1.2.840.113549.1.12.1.5': { cipher: 'RC2-CBC', keyLength: 16, effectiveBits: 128 },
  '1.2.840.113549.1.12.1.6': { cipher: 'RC2-CBC', keyLength: 5, effectiveBits: 40 },
};

async function decryptPkcs12Pbe(
  scheme: Pkcs12Scheme,
  params: Asn1Element | undefined,
  data: Bytes,
  passwords: readonly Bytes[],
  subtle: SubtleCrypto
): Promise<Bytes> {
  const [saltElement, iterationsElement] = readSequence(params, 'PKCS #12 PBE parameters');
  const salt = readSalt(saltElement);
  const iterations = readSmallInteger(iterationsElement);
  if (data.length === 0 || data.length % 8 !== 0) {
    throw new PasswordError();
  }
  for (const password of passwords) {
    const key = await pkcs12Kdf(
      'SHA-1',
      password,
      salt,
      iterations,
      PKCS12_KEY_MATERIAL,
      scheme.keyLength,
      subtle
    );
    const iv = await pkcs12Kdf('SHA-1', password, salt, iterations, PKCS12_IV, 8, subtle);
    const decrypted =
      scheme.cipher === 'RC2-CBC'
        ? rc2CbcDecrypt(key, scheme.effectiveBits ?? 0, iv, data)
        : tripleDesCbcDecrypt(key, iv, data);
    const plain = removePadding(decrypted, 8);
    // With an empty password one of two encodings is right; valid padding alone could be luck.
    if (plain && isSingleElement(plain)) {
      return plain;
    }
  }
  throw new PasswordError();
}

/**
 * How many password iterations decrypting with this AlgorithmIdentifier takes (PBKDF2's, or the
 * PKCS #12 KDF's), so a caller can bound the work a file asks for before doing it. 0 when it
 * can't tell; decrypting then says what's wrong.
 */
export function passwordIterations(algorithm: Asn1Element | undefined): number {
  try {
    const [oidElement, params] = readSequence(algorithm, 'an encryption algorithm');
    const oid = readOid(oidElement);
    if (oid === PBES2) {
      const [kdf] = readSequence(params, 'PBES2 parameters');
      const [, kdfParams] = readSequence(kdf, 'a key derivation');
      return readPbkdf2Params(kdfParams).iterations;
    }
    if (PKCS12_SCHEMES[oid]) {
      const [, iterationsElement] = readSequence(params, 'PKCS #12 PBE parameters');
      return readSmallInteger(iterationsElement);
    }
  } catch {
    // Decrypting reports it.
  }
  return 0;
}

/**
 * Decrypts data protected by a password, given its AlgorithmIdentifier: from an
 * EncryptedPrivateKeyInfo, a PKCS #12 shrouded key bag or PKCS #7 encrypted data. What comes
 * out is always one DER element; anything else means the password was wrong.
 */
export async function decryptWithPassword(
  algorithm: Asn1Element | undefined,
  data: Bytes,
  passwords: PasswordEncodings,
  subtle: SubtleCrypto
): Promise<Bytes> {
  const [oidElement, params] = readSequence(algorithm, 'an encryption algorithm');
  const oid = readOid(oidElement);
  const scheme = PKCS12_SCHEMES[oid];
  let plain: Bytes;
  if (oid === PBES2) {
    plain = await decryptPbes2(params, data, passwords.utf8, subtle);
  } else if (scheme) {
    plain = await decryptPkcs12Pbe(scheme, params, data, passwords.bmp, subtle);
  } else {
    throw unsupported(oid);
  }
  if (!isSingleElement(plain)) {
    throw new PasswordError();
  }
  return plain;
}
