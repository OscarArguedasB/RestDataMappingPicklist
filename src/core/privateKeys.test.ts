import { describe, expect, it } from 'vitest';
import type { Bytes } from './asn1';
import {
  Asn1Error,
  TAG,
  children,
  concatBytes,
  contextTag,
  encodeElement,
  encodeOid,
  encodeSmallInteger,
  parseAsn1,
  readBitString,
  readOctetString,
  readSequence,
} from './asn1';
import { EC_P256, RSA_2048, fromBase64 } from './__fixtures__/credentials';
import {
  UnsupportedKeyError,
  readEcPrivateKey,
  readPrivateKeyInfo,
  readPublicKeyInfo,
  readRsaPrivateKey,
  withPublicPoint,
} from './privateKeys';

const subtle = globalThis.crypto.subtle;
const sequence = (...parts: Bytes[]) => encodeElement(TAG.sequence, ...parts);
const octets = (bytes: Bytes) => encodeElement(TAG.octetString, bytes);

const EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const P256 = '1.2.840.10045.3.1.7';
const P384 = '1.3.132.0.34';

/** The ECPrivateKey fields of the EC_P256 fixture: the private value and the public point. */
function ecParts() {
  const [, , privateKey] = readSequence(parseAsn1(fromBase64(EC_P256.pkcs8)));
  const [, value, publicKey] = readSequence(parseAsn1(readOctetString(privateKey)));
  return { value: readOctetString(value), point: readBitString(children(publicKey)[0]) };
}

function sec1(value: Bytes, ...optional: Bytes[]): Bytes {
  return sequence(encodeSmallInteger(1), octets(value), ...optional);
}

const curveField = (oid: string) => encodeElement(contextTag(0), encodeOid(oid));
const pointField = (point: Bytes) =>
  encodeElement(contextTag(1), encodeElement(TAG.bitString, Uint8Array.of(0), point));

describe('readPrivateKeyInfo', () => {
  it('drops attributes and the version 2 public key', () => {
    const [, algorithm, privateKey] = readSequence(parseAsn1(fromBase64(EC_P256.pkcs8)));
    const attributes = encodeElement(
      contextTag(0),
      sequence(
        encodeOid('2.5.29.15'),
        encodeElement(TAG.set, encodeElement(TAG.bitString, Uint8Array.of(7, 0x80)))
      )
    );
    const publicKey = encodeElement(contextTag(1, false), Uint8Array.of(0, ...ecParts().point));
    const v2 = sequence(
      encodeSmallInteger(1),
      algorithm.encoded,
      privateKey.encoded,
      attributes,
      publicKey
    );
    expect(readPrivateKeyInfo(v2).pkcs8).toEqual(fromBase64(EC_P256.pkcs8));
    const v3 = sequence(encodeSmallInteger(2), algorithm.encoded, privateKey.encoded);
    expect(() => readPrivateKeyInfo(v3)).toThrow(/version/);
  });

  it('relabels RSA-PSS keys as plain RSA keys', () => {
    const [, , privateKey] = readSequence(parseAsn1(fromBase64(RSA_2048.pkcs8)));
    const pss = sequence(
      encodeSmallInteger(0),
      sequence(encodeOid('1.2.840.113549.1.1.10')),
      privateKey.encoded
    );
    const key = readPrivateKeyInfo(pss);
    expect(key.pkcs8).toEqual(fromBase64(RSA_2048.pkcs8));
    expect(key).toMatchObject({ keyType: 'RSA', keyBits: 2048 });
  });

  it('takes the curve from the key when the algorithm doesn’t name it', () => {
    const { value, point } = ecParts();
    const noParameters = sequence(
      encodeSmallInteger(0),
      sequence(encodeOid(EC_PUBLIC_KEY)),
      octets(sec1(value, curveField(P256), pointField(point)))
    );
    expect(readPrivateKeyInfo(noParameters).pkcs8).toEqual(fromBase64(EC_P256.pkcs8));
    const conflicting = sequence(
      encodeSmallInteger(0),
      sequence(encodeOid(EC_PUBLIC_KEY), encodeOid(P384)),
      octets(sec1(value, curveField(P256)))
    );
    expect(() => readPrivateKeyInfo(conflicting)).toThrow(/two curves/);
    expect(() => readEcPrivateKey(sec1(value))).toThrow(UnsupportedKeyError);
  });

  it('names key types and curves it can’t sign with', () => {
    const ed448 = sequence(
      encodeSmallInteger(0),
      sequence(encodeOid('1.3.101.113')),
      octets(octets(new Uint8Array(57)))
    );
    expect(() => readPrivateKeyInfo(ed448)).toThrow(
      expect.objectContaining({ keyType: 'Ed448', curve: null })
    );
    const unknown = sequence(
      encodeSmallInteger(0),
      sequence(encodeOid('1.2.3.4')),
      octets(new Uint8Array(4))
    );
    expect(() => readPrivateKeyInfo(unknown)).toThrow(
      expect.objectContaining({ keyType: 'an unknown kind (1.2.3.4)' })
    );
    const brainpool = sec1(ecParts().value, curveField('1.3.36.3.3.2.8.1.1.7'));
    expect(() => readEcPrivateKey(brainpool)).toThrow(
      expect.objectContaining({ curve: 'brainpoolP256r1' })
    );
    const explicit = sec1(
      ecParts().value,
      encodeElement(contextTag(0), sequence(encodeSmallInteger(1)))
    );
    expect(() => readEcPrivateKey(explicit)).toThrow(
      expect.objectContaining({ curve: 'a curve given by its parameters' })
    );
  });
});

describe('readEcPrivateKey', () => {
  it('pads private values written without their leading zeros', () => {
    const short = Uint8Array.from({ length: 31 }, (_, index) => index + 1);
    const key = readEcPrivateKey(sec1(short, curveField(P256)));
    expect(key.identity).toEqual(concatBytes([Uint8Array.of(0), short]));
    expect(() => readEcPrivateKey(sec1(new Uint8Array(33).fill(1), curveField(P256)))).toThrow(
      Asn1Error
    );
    expect(() => readEcPrivateKey(sec1(new Uint8Array(32), curveField(P256)))).toThrow(Asn1Error);
  });

  it('recomputes a compressed public point', async () => {
    const { value, point } = ecParts();
    const compressed = Uint8Array.of(point[64] & 1 ? 3 : 2, ...point.subarray(1, 33));
    const key = readEcPrivateKey(sec1(value, curveField(P256), pointField(compressed)));
    expect(key.publicPoint).toBeUndefined();
    expect((await withPublicPoint(key, subtle)).pkcs8).toEqual(fromBase64(EC_P256.pkcs8));
  });
});

describe('readRsaPrivateKey', () => {
  it('refuses multi-prime keys and missing fields', () => {
    const integers = Array.from({ length: 8 }, () => encodeSmallInteger(3));
    expect(() => readRsaPrivateKey(sequence(encodeSmallInteger(1), ...integers))).toThrow(
      expect.objectContaining({ keyType: 'Multi-prime RSA' })
    );
    expect(() => readRsaPrivateKey(sequence(encodeSmallInteger(0), ...integers.slice(1)))).toThrow(
      /nine/
    );
  });
});

describe('readPublicKeyInfo', () => {
  it('relabels RSA-PSS public keys and passes on others it can’t use', () => {
    const tbs = readSequence(readSequence(parseAsn1(fromBase64(RSA_2048.certificate)))[0]);
    const spki = tbs.find(
      (field, index) =>
        index > 4 && field.tag === TAG.sequence && children(field)[1]?.tag === TAG.bitString
    );
    expect(spki).toBeDefined();
    if (!spki) {
      return;
    }
    const [, bits] = readSequence(spki);
    const pss = parseAsn1(sequence(sequence(encodeOid('1.2.840.113549.1.1.10')), bits.encoded));
    expect(readPublicKeyInfo(pss)).toEqual({ spki: spki.encoded, keyType: 'RSA', keyBits: 2048 });
    const ed25519 = parseAsn1(
      sequence(sequence(encodeOid('1.3.101.112')), encodeElement(TAG.bitString, new Uint8Array(33)))
    );
    expect(readPublicKeyInfo(ed25519)).toMatchObject({ keyType: null });
    const k1 = parseAsn1(
      sequence(
        sequence(encodeOid(EC_PUBLIC_KEY), encodeOid('1.3.132.0.10')),
        encodeElement(TAG.bitString, new Uint8Array(66))
      )
    );
    expect(readPublicKeyInfo(k1)).toMatchObject({ keyType: null });
  });
});
