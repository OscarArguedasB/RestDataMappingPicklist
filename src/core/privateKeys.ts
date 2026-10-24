import type { Asn1Element, Bytes } from './asn1';
import {
  Asn1Error,
  DER_NULL,
  TAG,
  bitLength,
  children,
  concatBytes,
  contextTag,
  encodeElement,
  encodeOid,
  encodeSmallInteger,
  fromBase64Url,
  parseAsn1,
  readBitString,
  readOctetString,
  readOid,
  readSequence,
  readSmallInteger,
  readUnsignedInteger,
} from './asn1';

// Private keys in the formats people have them: PKCS #8 (what WebCrypto imports), PKCS #1 RSA
// keys and SEC1 EC keys from OpenSSL. Each is rewritten as a plain PKCS #8 that every browser
// imports: version 0, no attributes, and for EC keys the curve only in the algorithm and the
// public key included (Safari and Firefox need it).

export type KeyType = 'RSA' | 'EC';
export type NamedCurve = 'P-256' | 'P-384' | 'P-521';

export const RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const RSASSA_PSS = '1.2.840.113549.1.1.10';
const EC_PUBLIC_KEY = '1.2.840.10045.2.1';

interface CurveInfo {
  name: NamedCurve;
  oid: string;
  bits: number;
  /** Bytes in a coordinate or the private value. */
  size: number;
}

const CURVES: readonly CurveInfo[] = [
  { name: 'P-256', oid: '1.2.840.10045.3.1.7', bits: 256, size: 32 },
  { name: 'P-384', oid: '1.3.132.0.34', bits: 384, size: 48 },
  { name: 'P-521', oid: '1.3.132.0.35', bits: 521, size: 66 },
];

/** Curves people have keys on that WebCrypto can't sign with, named for messages. */
const OTHER_CURVES: Readonly<Record<string, string>> = {
  '1.3.132.0.10': 'secp256k1',
  '1.3.132.0.33': 'P-224',
  '1.2.840.10045.3.1.1': 'P-192',
  '1.3.36.3.3.2.8.1.1.7': 'brainpoolP256r1',
  '1.3.36.3.3.2.8.1.1.11': 'brainpoolP384r1',
  '1.3.36.3.3.2.8.1.1.13': 'brainpoolP512r1',
  '1.2.156.10197.1.301': 'SM2',
};

/** Key types WebCrypto can't sign a JWT with here, named for messages. */
const OTHER_KEY_TYPES: Readonly<Record<string, string>> = {
  '1.3.101.112': 'Ed25519',
  '1.3.101.113': 'Ed448',
  '1.3.101.110': 'X25519',
  '1.3.101.111': 'X448',
  '1.2.840.10040.4.1': 'DSA',
  '1.2.840.113549.1.3.1': 'Diffie-Hellman',
  '1.2.840.10046.2.1': 'Diffie-Hellman',
  '2.16.840.1.101.3.4.3.17': 'ML-DSA-44',
  '2.16.840.1.101.3.4.3.18': 'ML-DSA-65',
  '2.16.840.1.101.3.4.3.19': 'ML-DSA-87',
  '2.16.840.1.101.3.4.4.1': 'ML-KEM-512',
  '2.16.840.1.101.3.4.4.2': 'ML-KEM-768',
  '2.16.840.1.101.3.4.4.3': 'ML-KEM-1024',
};

/** A key that can't sign here: another type, or an EC key on another curve. */
export class UnsupportedKeyError extends Error {
  /** Such as “Ed25519”. */
  readonly keyType: string;
  /** For EC keys, the curve, such as “secp256k1”. */
  readonly curve: string | null;

  constructor(keyType: string, curve: string | null = null) {
    super(`Unsupported key: ${curve ? `${keyType} on ${curve}` : keyType}.`);
    this.name = 'UnsupportedKeyError';
    this.keyType = keyType;
    this.curve = curve;
  }
}

export interface PrivateKey {
  /** The key as plain PKCS #8 (see above). */
  pkcs8: Bytes;
  keyType: KeyType;
  /** RSA: the modulus size. EC: the curve size (256, 384 or 521). */
  keyBits: number;
  curve?: NamedCurve;
  /**
   * Tells keys apart: the RSA modulus, or the EC private value. Never shown or stored; it only
   * spots the same key arriving in two files.
   */
  identity: Bytes;
  /** EC keys: the uncompressed public point, when the key includes it. */
  publicPoint?: Bytes;
}

/** The public half of a key, from a certificate. */
export interface PublicKey {
  /** SubjectPublicKeyInfo for importKey('spki'); RSA-PSS keys are relabeled as plain RSA. */
  spki: Bytes;
  /** Null for keys that can't sign here. */
  keyType: KeyType | null;
  keyBits: number;
  curve?: NamedCurve;
  /** EC keys: the uncompressed public point. */
  publicPoint?: Bytes;
}

function curveByOid(oid: string): CurveInfo {
  const curve = CURVES.find((candidate) => candidate.oid === oid);
  if (!curve) {
    throw new UnsupportedKeyError('EC', OTHER_CURVES[oid] ?? oid);
  }
  return curve;
}

/** The curve in EC parameters, which must name one (explicit parameters aren't supported). */
function readCurve(parameters: Asn1Element | undefined): CurveInfo {
  if (parameters?.tag !== TAG.oid) {
    throw new UnsupportedKeyError('EC', 'a curve given by its parameters');
  }
  return curveByOid(readOid(parameters));
}

function algorithmIdentifier(oid: string, parameters: Bytes): Bytes {
  return encodeElement(TAG.sequence, encodeOid(oid), parameters);
}

function wrapPkcs8(algorithm: Bytes, privateKey: Bytes): Bytes {
  return encodeElement(
    TAG.sequence,
    encodeSmallInteger(0),
    algorithm,
    encodeElement(TAG.octetString, privateKey)
  );
}

/** A PKCS #1 RSAPrivateKey, as found inside PKCS #8 or on its own ("RSA PRIVATE KEY"). */
export function readRsaPrivateKey(der: Bytes): PrivateKey {
  const fields = readSequence(parseAsn1(der), 'an RSA private key');
  const version = readSmallInteger(fields[0]);
  if (version !== 0) {
    // Version 1 has more than two primes, which WebCrypto can't import.
    throw new UnsupportedKeyError('Multi-prime RSA');
  }
  if (fields.length !== 9) {
    throw new Asn1Error('Expected nine RSA key fields.');
  }
  const [modulus] = fields.slice(1).map(readUnsignedInteger);
  return {
    pkcs8: wrapPkcs8(algorithmIdentifier(RSA_ENCRYPTION, DER_NULL), der),
    keyType: 'RSA',
    keyBits: bitLength(modulus),
    identity: modulus,
  };
}

function encodeEcPrivateKey(privateValue: Bytes, publicPoint: Bytes | undefined): Bytes {
  const fields = [encodeSmallInteger(1), encodeElement(TAG.octetString, privateValue)];
  if (publicPoint) {
    const bits = encodeElement(TAG.bitString, Uint8Array.of(0), publicPoint);
    fields.push(encodeElement(contextTag(1), bits));
  }
  return encodeElement(TAG.sequence, ...fields);
}

function ecKey(curve: CurveInfo, privateValue: Bytes, publicPoint: Bytes | undefined): PrivateKey {
  const algorithm = algorithmIdentifier(EC_PUBLIC_KEY, encodeOid(curve.oid));
  return {
    pkcs8: wrapPkcs8(algorithm, encodeEcPrivateKey(privateValue, publicPoint)),
    keyType: 'EC',
    keyBits: curve.bits,
    curve: curve.name,
    identity: privateValue,
    publicPoint,
  };
}

/**
 * A SEC1 ECPrivateKey ("EC PRIVATE KEY", or inside PKCS #8). `algorithmCurve` is the curve from
 * the PKCS #8 algorithm, when there is one.
 */
export function readEcPrivateKey(der: Bytes, algorithmCurve?: CurveInfo): PrivateKey {
  const [version, privateElement, ...optional] = readSequence(parseAsn1(der), 'an EC private key');
  if (readSmallInteger(version) !== 1) {
    throw new Asn1Error('Unknown EC key version.');
  }
  let curve = algorithmCurve;
  let publicPoint: Bytes | undefined;
  for (const field of optional) {
    if (field.tag === contextTag(0)) {
      const [parameters] = children(field);
      const own = readCurve(parameters);
      if (curve && curve.oid !== own.oid) {
        throw new Asn1Error('The key names two curves.');
      }
      curve = own;
    } else if (field.tag === contextTag(1)) {
      publicPoint = readBitString(children(field)[0]);
    } else {
      throw new Asn1Error('Unexpected EC key field.');
    }
  }
  if (!curve) {
    throw new UnsupportedKeyError('EC', 'an unnamed curve');
  }
  const value = readOctetString(privateElement);
  if (value.length === 0 || value.length > curve.size || value.every((byte) => byte === 0)) {
    throw new Asn1Error('Bad EC private value.');
  }
  // Some tools drop leading zeros; RFC 5915 wants the full size.
  const privateValue = new Uint8Array(curve.size);
  privateValue.set(value, curve.size - value.length);
  if (publicPoint && (publicPoint[0] !== 4 || publicPoint.length !== 1 + 2 * curve.size)) {
    // A compressed point isn't imported everywhere; WebCrypto can recompute it (see below).
    publicPoint = undefined;
  }
  return ecKey(curve, privateValue, publicPoint);
}

/** A PKCS #8 PrivateKeyInfo (version 1), or a OneAsymmetricKey (version 2). */
export function readPrivateKeyInfo(der: Bytes): PrivateKey {
  const [version, algorithm, privateKey] = readSequence(parseAsn1(der), 'a private key');
  if (readSmallInteger(version) > 1) {
    throw new Asn1Error('Unknown PKCS #8 version.');
  }
  // Attributes and a version 2 public key are left out: browsers don't need them.
  const [oidElement, parameters] = readSequence(algorithm, 'a key algorithm');
  const oid = readOid(oidElement);
  const inner = readOctetString(privateKey);
  switch (oid) {
    case RSA_ENCRYPTION:
    case RSASSA_PSS:
      // RSA-PSS keys sign as well with RSASSA-PKCS1-v1_5; browsers only import plain RSA keys.
      return readRsaPrivateKey(inner);
    case EC_PUBLIC_KEY:
      // The curve may be in the algorithm, in the key or in both.
      return readEcPrivateKey(
        inner,
        parameters && parameters.tag !== TAG.null ? readCurve(parameters) : undefined
      );
    default:
      throw new UnsupportedKeyError(OTHER_KEY_TYPES[oid] ?? `an unknown kind (${oid})`);
  }
}

/** The public key in a SubjectPublicKeyInfo. */
export function readPublicKeyInfo(spki: Asn1Element): PublicKey {
  const [algorithm, subjectPublicKey] = readSequence(spki, 'a public key');
  const [oidElement, parameters] = readSequence(algorithm, 'a key algorithm');
  const oid = readOid(oidElement);
  const key = readBitString(subjectPublicKey);
  if (oid === RSA_ENCRYPTION || oid === RSASSA_PSS) {
    const [modulus, exponent] = readSequence(parseAsn1(key), 'an RSA public key');
    readUnsignedInteger(exponent);
    const relabeled =
      oid === RSA_ENCRYPTION
        ? spki.encoded
        : encodeElement(
            TAG.sequence,
            algorithmIdentifier(RSA_ENCRYPTION, DER_NULL),
            subjectPublicKey.encoded
          );
    return { spki: relabeled, keyType: 'RSA', keyBits: bitLength(readUnsignedInteger(modulus)) };
  }
  if (oid === EC_PUBLIC_KEY) {
    try {
      const curve = readCurve(parameters);
      const publicKey: PublicKey = {
        spki: spki.encoded,
        keyType: 'EC',
        keyBits: curve.bits,
        curve: curve.name,
      };
      if (key[0] === 4 && key.length === 1 + 2 * curve.size) {
        publicKey.publicPoint = key;
      }
      return publicKey;
    } catch (error) {
      if (!(error instanceof UnsupportedKeyError)) {
        throw error;
      }
    }
  }
  return { spki: spki.encoded, keyType: null, keyBits: 0 };
}

/**
 * Adds the public point to an EC key that lacks it, as some tools (older Java among them) write
 * keys. WebCrypto computes it on import, where the browser imports such a key at all; otherwise
 * `publicPoint` can come from a certificate (the caller checks that it matches).
 */
export async function withPublicPoint(
  key: PrivateKey,
  subtle: SubtleCrypto,
  publicPoint?: Bytes
): Promise<PrivateKey> {
  const curve = CURVES.find((candidate) => candidate.name === key.curve);
  if (key.keyType !== 'EC' || key.publicPoint || !curve) {
    return key;
  }
  if (publicPoint) {
    return ecKey(curve, key.identity, publicPoint);
  }
  const imported = await subtle.importKey(
    'pkcs8',
    key.pkcs8,
    { name: 'ECDSA', namedCurve: curve.name },
    true,
    ['sign']
  );
  const jwk = await subtle.exportKey('jwk', imported);
  const x = fromBase64Url(jwk.x ?? '');
  const y = fromBase64Url(jwk.y ?? '');
  if (!x || !y || x.length !== curve.size || y.length !== curve.size) {
    throw new Asn1Error('Unexpected public key.');
  }
  return ecKey(curve, key.identity, concatBytes([Uint8Array.of(4), x, y]));
}
