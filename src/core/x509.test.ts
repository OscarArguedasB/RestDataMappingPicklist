import { describe, expect, it } from 'vitest';
import type { Bytes } from './asn1';
import {
  Asn1Error,
  TAG,
  contextTag,
  encodeElement,
  encodeOid,
  encodeSmallInteger,
  parseAsn1,
  readSequence,
} from './asn1';
import { CA, EC_P256, RSA_2048, RSA_3072, fromBase64 } from './__fixtures__/credentials';
import { formatName, parseCertificate } from './x509';

const subtle = globalThis.crypto.subtle;
const utf8 = (text: string) => new TextEncoder().encode(text);
const sequence = (...parts: Bytes[]) => encodeElement(TAG.sequence, ...parts);
const set = (...parts: Bytes[]) => encodeElement(TAG.set, ...parts);

function attribute(oid: string, value: Bytes): Bytes {
  return sequence(encodeOid(oid), value);
}

const CN = '2.5.4.3';
const O = '2.5.4.10';
const utf8String = (text: string) => encodeElement(TAG.utf8String, utf8(text));

/** Names are written in the order of the DER (least specific first) and printed reversed. */
function name(...rdns: Bytes[][]): string {
  return formatName(parseAsn1(sequence(...rdns.map((attributes) => set(...attributes)))));
}

describe('formatName', () => {
  it('prints RFC 4514 names, most specific first', () => {
    expect(
      name(
        [attribute('2.5.4.6', encodeElement(TAG.printableString, utf8('US')))],
        [attribute(CN, utf8String('api'))]
      )
    ).toBe('CN=api,C=US');
    // A multi-valued RDN joins with +.
    expect(name([attribute(CN, utf8String('a')), attribute('2.5.4.11', utf8String('b'))])).toBe(
      'CN=a+OU=b'
    );
    expect(name()).toBe('');
  });

  it('escapes special characters, edges, controls and bidirectional formatting', () => {
    const cases: Array<[string, string]> = [
      ['Contoso, Ltd.', 'Contoso\\, Ltd.'],
      ['a+b;c<d>e"f\\g', 'a\\+b\\;c\\<d\\>e\\"f\\\\g'],
      ['#1 team', '\\#1 team'],
      [' padded ', '\\ padded\\ '],
      ['x#y = z', 'x#y = z'],
      ['bell\u0007', 'bell\\07'],
      ['evil‮txt', 'evil\\E2\\80\\AEtxt'],
      ['San José', 'San José'],
    ];
    for (const [value, expected] of cases) {
      expect(name([attribute(O, utf8String(value))])).toBe(`O=${expected}`);
    }
  });

  it('writes unknown attributes and values that aren’t strings in hex', () => {
    expect(name([attribute('1.2.3.4', utf8String('x'))])).toBe('1.2.3.4=#0C0178');
    expect(name([attribute(CN, encodeSmallInteger(5))])).toBe('CN=#020105');
    expect(name([attribute(CN, encodeElement(TAG.bmpString, Uint8Array.of(0, 0x41)))])).toBe(
      'CN=A'
    );
  });

  it('refuses malformed names', () => {
    expect(() => name([sequence(encodeOid(CN))])).toThrow(Asn1Error);
    expect(() => formatName(parseAsn1(sequence(sequence())))).toThrow(Asn1Error);
  });
});

/** A certificate made of parts; the signature isn't checked, so it can be anything. */
function certificate(
  options: { version?: Bytes; serial?: Bytes; subject?: Bytes; validity?: Bytes } = {}
): Bytes {
  const real = readSequence(readSequence(parseAsn1(fromBase64(EC_P256.certificate)))[0]);
  const [, , signature, issuer, validity, , spki] = real;
  const subject = options.subject ?? sequence(set(attribute(CN, utf8String('v1'))));
  const fields = [
    ...(options.version ? [options.version] : []),
    options.serial ?? encodeElement(TAG.integer, Uint8Array.of(0, 0, 1)),
    signature.encoded,
    issuer.encoded,
    options.validity ?? validity.encoded,
    subject,
    spki.encoded,
  ];
  return sequence(
    sequence(...fields),
    signature.encoded,
    encodeElement(TAG.bitString, Uint8Array.of(0, 1, 2))
  );
}

describe('parseCertificate', () => {
  it('describes certificates as OpenSSL does', async () => {
    for (const fixture of [CA, RSA_2048, RSA_3072, EC_P256]) {
      const parsed = await parseCertificate(fromBase64(fixture.certificate), subtle);
      expect(parsed.info).toEqual(fixture.info);
      expect(parsed.notAfter.toISOString()).toBe(fixture.info.notAfter);
    }
    const rsa = await parseCertificate(fromBase64(RSA_2048.certificate), subtle);
    expect(rsa.publicKey).toMatchObject({ keyType: 'RSA', keyBits: 2048 });
    const ec = await parseCertificate(fromBase64(EC_P256.certificate), subtle);
    expect(ec.publicKey).toMatchObject({ keyType: 'EC', keyBits: 256, curve: 'P-256' });
    expect(ec.publicKey.publicPoint).toHaveLength(65);
  });

  it('reads version 1 certificates and serial numbers that aren’t minimal', async () => {
    const parsed = await parseCertificate(certificate(), subtle);
    expect(parsed.info.subject).toBe('CN=v1');
    expect(parsed.info.serialNumber).toBe('01');
    const v3 = encodeElement(contextTag(0), encodeSmallInteger(2));
    expect((await parseCertificate(certificate({ version: v3 }), subtle)).info.subject).toBe(
      'CN=v1'
    );
    const v9 = encodeElement(contextTag(0), encodeSmallInteger(8));
    await expect(parseCertificate(certificate({ version: v9 }), subtle)).rejects.toThrow(/version/);
  });

  it('shortens very long names to what a saved summary allows', async () => {
    const long = sequence(set(attribute(CN, utf8String('x'.repeat(1000)))));
    const parsed = await parseCertificate(certificate({ subject: long }), subtle);
    expect(parsed.info.subject).toHaveLength(400);
    expect(parsed.info.subject.endsWith('x…')).toBe(true);
    // After "CN=x", the cut at 399 code units falls inside the 198th emoji, which is dropped whole.
    const emoji = sequence(set(attribute(CN, utf8String(`x${'😀'.repeat(300)}`))));
    const cut = (await parseCertificate(certificate({ subject: emoji }), subtle)).info.subject;
    expect(cut).toBe(`CN=x${'😀'.repeat(197)}…`);
  });

  it('refuses malformed certificates', async () => {
    const badDates = sequence(
      encodeElement(TAG.utcTime, utf8('261301000000Z')),
      encodeElement(TAG.utcTime, utf8('271001000000Z'))
    );
    await expect(
      parseCertificate(certificate({ validity: badDates }), subtle)
    ).rejects.toBeInstanceOf(Asn1Error);
    const der = fromBase64(RSA_2048.certificate);
    await expect(parseCertificate(der.subarray(0, der.length - 1), subtle)).rejects.toBeInstanceOf(
      Asn1Error
    );
    await expect(parseCertificate(sequence(sequence(), sequence()), subtle)).rejects.toBeInstanceOf(
      Asn1Error
    );
  });
});
