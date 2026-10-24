import { describe, expect, it } from 'vitest';
import type { Asn1Element, Bytes } from './asn1';
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
  readSequence,
} from './asn1';
import { EC_P256, PASSWORD, PFX, RSA_2048, fromBase64 } from './__fixtures__/credentials';
import { parseCredentials } from './certificates';
import { PasswordError } from './pbe';
import { looksLikePkcs12, readPkcs12 } from './pkcs12';

const subtle = globalThis.crypto.subtle;

const DATA = '1.2.840.113549.1.7.1';
const KEY_BAG = '1.2.840.113549.1.12.10.1.1';
const SHROUDED_KEY_BAG = '1.2.840.113549.1.12.10.1.2';
const CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const SAFE_CONTENTS_BAG = '1.2.840.113549.1.12.10.1.6';
const X509 = '1.2.840.113549.1.9.22.1';

const sequence = (...parts: Bytes[]) => encodeElement(TAG.sequence, ...parts);
const explicit = (...parts: Bytes[]) => encodeElement(contextTag(0), ...parts);
const octets = (bytes: Bytes) => encodeElement(TAG.octetString, bytes);
const oid = encodeOid;

/** A PFX without a MAC or encryption around the given SafeContents. */
function plainPfx(safeContents: Bytes, version = 3): Bytes {
  const authSafe = sequence(sequence(oid(DATA), explicit(octets(safeContents))));
  return sequence(encodeSmallInteger(version), sequence(oid(DATA), explicit(octets(authSafe))));
}

const keyBag = (pkcs8: Bytes) => sequence(oid(KEY_BAG), explicit(pkcs8));
const certBag = (der: Bytes) =>
  sequence(oid(CERT_BAG), explicit(sequence(oid(X509), explicit(octets(der)))));
const nestedBag = (...bags: Bytes[]) =>
  sequence(oid(SAFE_CONTENTS_BAG), explicit(sequence(...bags)));

/** BER as NSS writes it: indefinite lengths throughout and octet strings in 16-byte segments. */
function toBer(element: Asn1Element, inner?: (content: Bytes) => Bytes): Bytes {
  const end = Uint8Array.of(0, 0);
  if (element.constructed) {
    const parts = children(element).map((child) => toBer(child, inner));
    return concatBytes([Uint8Array.of(element.tag, 0x80), ...parts, end]);
  }
  const isString = element.tag === TAG.octetString || element.tag === contextTag(0, false);
  if (!isString || element.content.length <= 16) {
    return element.encoded;
  }
  const content = inner ? inner(element.content) : element.content;
  const segments: Bytes[] = [];
  for (let offset = 0; offset < content.length; offset += 16) {
    segments.push(octets(content.subarray(offset, offset + 16)));
  }
  return concatBytes([Uint8Array.of(element.tag | 0x20, 0x80), ...segments, end]);
}

describe('readPkcs12', () => {
  it('returns every key and certificate', async () => {
    const contents = await readPkcs12(fromBase64(PFX.modern), PASSWORD, subtle);
    expect(contents.keys).toEqual([fromBase64(RSA_2048.pkcs8)]);
    expect(contents.certificates).toHaveLength(2);
    expect(contents.certificates).toContainEqual(fromBase64(RSA_2048.certificate));
  });

  it('reads BER with indefinite lengths and split octet strings', async () => {
    // The MAC covers the authenticated safe's bytes, which stay the same however they're split.
    const outer = toBer(parseAsn1(fromBase64(PFX.modern)));
    expect(outer.length).toBeGreaterThan(fromBase64(PFX.modern).length);
    const contents = await readPkcs12(outer, PASSWORD, subtle);
    expect(contents.keys).toEqual([fromBase64(RSA_2048.pkcs8)]);
    // Without a MAC the contents can be BER too, including the encrypted data.
    const [version, authSafe] = readSequence(parseAsn1(fromBase64(PFX.noMac)));
    const [type, wrapper] = readSequence(authSafe);
    const safe = toBer(parseAsn1(children(wrapper)[0].content));
    const ber = concatBytes([
      Uint8Array.of(0x30, 0x80),
      version.encoded,
      Uint8Array.of(0x30, 0x80),
      type.encoded,
      Uint8Array.of(0xa0, 0x80),
      toBer(parseAsn1(octets(safe))),
      new Uint8Array(6),
    ]);
    const deep = await readPkcs12(ber, PASSWORD, subtle);
    expect(deep.keys).toEqual([fromBase64(EC_P256.pkcs8)]);
    expect(deep.certificates).toEqual([fromBase64(EC_P256.certificate)]);
  });

  it('reads nested safe contents, within limits', async () => {
    const key = fromBase64(EC_P256.pkcs8);
    const nested = plainPfx(
      sequence(nestedBag(nestedBag(keyBag(key))), certBag(fromBase64(EC_P256.certificate)))
    );
    const contents = await readPkcs12(nested, '', subtle);
    expect(contents.keys).toEqual([key]);
    expect(contents.certificates).toHaveLength(1);
    const tooDeep = plainPfx(sequence(nestedBag(nestedBag(nestedBag(nestedBag(keyBag(key)))))));
    await expect(readPkcs12(tooDeep, '', subtle)).rejects.toThrow(/nested too deeply/);
    const tooMany = plainPfx(sequence(...Array.from({ length: 257 }, () => keyBag(key))));
    await expect(readPkcs12(tooMany, '', subtle)).rejects.toThrow(/Too many bags/);
  });

  it('decrypts a limited number of items, since each one runs the password KDF', async () => {
    // EncryptedPrivateKeyInfo is exactly what a shrouded key bag holds.
    const shrouded = sequence(
      oid(SHROUDED_KEY_BAG),
      explicit(fromBase64(EC_P256.encrypted.sha1Aes256))
    );
    const eight = await readPkcs12(
      plainPfx(sequence(...Array.from({ length: 8 }, () => shrouded))),
      PASSWORD,
      subtle
    );
    expect(eight.keys).toHaveLength(8);
    const nine = plainPfx(sequence(...Array.from({ length: 9 }, () => shrouded)));
    await expect(readPkcs12(nine, PASSWORD, subtle)).rejects.toThrow(/Too many encrypted items/);
  });

  it('skips bags it doesn’t need', async () => {
    const secretBag = sequence(oid('1.2.840.113549.1.12.10.1.5'), explicit(sequence()));
    const sdsi = sequence(
      oid(CERT_BAG),
      explicit(sequence(oid('1.2.840.113549.1.9.22.2'), explicit(octets(new Uint8Array(4)))))
    );
    const contents = await readPkcs12(plainPfx(sequence(secretBag, sdsi)), '', subtle);
    expect(contents).toEqual({ keys: [], certificates: [] });
  });

  it('reports wrong passwords as PasswordError', async () => {
    await expect(readPkcs12(fromBase64(PFX.tripleDes), 'wrong', subtle)).rejects.toBeInstanceOf(
      PasswordError
    );
    await expect(readPkcs12(fromBase64(PFX.noMac), 'wrong', subtle)).rejects.toBeInstanceOf(
      PasswordError
    );
  });

  it('refuses public-key modes, unknown MACs and versions', async () => {
    const signed = sequence(
      encodeSmallInteger(3),
      sequence(oid('1.2.840.113549.1.7.2'), explicit(sequence()))
    );
    await expect(readPkcs12(signed, '', subtle)).rejects.toMatchObject({
      name: 'UnsupportedEncryptionError',
      convertible: false,
    });
    const envelopedSafe = sequence(sequence(oid('1.2.840.113549.1.7.3'), explicit(sequence())));
    const enveloped = sequence(
      encodeSmallInteger(3),
      sequence(oid(DATA), explicit(octets(envelopedSafe)))
    );
    await expect(readPkcs12(enveloped, '', subtle)).rejects.toMatchObject({ convertible: false });
    // A MAC with MD5.
    const authSafe = readSequence(parseAsn1(plainPfx(sequence())))[1].encoded;
    const macData = sequence(
      sequence(sequence(oid('1.2.840.113549.2.5')), octets(new Uint8Array(16))),
      octets(new Uint8Array(8)),
      encodeSmallInteger(1)
    );
    const md5 = sequence(encodeSmallInteger(3), authSafe, macData);
    await expect(readPkcs12(md5, '', subtle)).rejects.toThrow(/unknown hash/);
    await expect(readPkcs12(plainPfx(sequence(), 2), '', subtle)).rejects.toBeInstanceOf(Asn1Error);
  });

  it('says so in the setup page’s words', async () => {
    const signed = sequence(
      encodeSmallInteger(3),
      sequence(oid('1.2.840.113549.1.7.2'), explicit(sequence()))
    );
    await expect(parseCredentials([{ name: 'signed.pfx', data: signed }])).rejects.toThrow(
      '“signed.pfx” is protected with a signature (public-key integrity mode), which isn’t supported. Export it again protected by a password.'
    );
  });
});

describe('looksLikePkcs12', () => {
  it('tells PFX files from other DER', () => {
    expect(looksLikePkcs12(parseAsn1(fromBase64(PFX.modern)))).toBe(true);
    expect(looksLikePkcs12(parseAsn1(fromBase64(RSA_2048.certificate)))).toBe(false);
    expect(looksLikePkcs12(parseAsn1(fromBase64(RSA_2048.pkcs8)))).toBe(false);
  });
});
