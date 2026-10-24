import { describe, expect, it } from 'vitest';
import type { Bytes } from './asn1';
import {
  Asn1Error,
  DER_NULL,
  TAG,
  bitLength,
  bytesEqual,
  children,
  concatBytes,
  contextTag,
  encodeElement,
  encodeOid,
  encodeSmallInteger,
  fromBase64,
  fromBase64Url,
  parseAsn1,
  readBitString,
  readOctetString,
  readOid,
  readSequence,
  readSmallInteger,
  readString,
  readTime,
  readUnsignedInteger,
  toBase64,
  toBase64Url,
  toHex,
} from './asn1';

function hex(text: string): Bytes {
  return Uint8Array.from(text.match(/[0-9a-f]{2}/gi) ?? [], (pair) => parseInt(pair, 16));
}

function element(tag: number, content: Bytes) {
  return parseAsn1(encodeElement(tag, content));
}

describe('parseAsn1', () => {
  it('reads short and long lengths and nested elements', () => {
    const long = new Uint8Array(300).fill(7);
    const der = encodeElement(
      TAG.sequence,
      encodeSmallInteger(5),
      encodeElement(TAG.octetString, long)
    );
    expect(toHex(der.subarray(0, 4))).toBe('30820133');
    const [integer, octets] = readSequence(parseAsn1(der));
    expect(readSmallInteger(integer)).toBe(5);
    expect(readOctetString(octets)).toEqual(long);
    expect(octets.encoded.length).toBe(304);
  });

  it('refuses truncated input and lengths past the container', () => {
    const der = encodeElement(
      TAG.sequence,
      encodeSmallInteger(5),
      encodeElement(TAG.octetString, new Uint8Array(20))
    );
    for (let cut = 0; cut < der.length; cut++) {
      expect(() => parseAsn1(der.subarray(0, cut))).toThrow(Asn1Error);
    }
    // The inner length claims more than the outer element holds.
    expect(() => children(parseAsn1(hex('3004 0405 0102 0304')))).toThrow(Asn1Error);
    expect(() => parseAsn1(hex('0484 ffffffff 00'))).toThrow(/past the end/);
    expect(() => parseAsn1(hex('0485 0000000001 00'))).toThrow(/too large/);
  });

  it('refuses trailing data, non-minimal lengths and indefinite lengths in DER', () => {
    expect(() => parseAsn1(hex('0500 00'))).toThrow(/after the end/);
    expect(() => parseAsn1(hex('0481 01 ff'))).toThrow(/not minimal/);
    expect(() => parseAsn1(hex('048200 01 ff'))).toThrow(/not minimal/);
    expect(() => parseAsn1(hex('3080 0500 0000'))).toThrow(/Indefinite/);
    // BER accepts both, but never an indefinite primitive.
    expect(readOctetString(parseAsn1(hex('0481 01 ff'), { ber: true }))).toEqual(hex('ff'));
    expect(() => parseAsn1(hex('0480 ff 0000'), { ber: true })).toThrow(/Indefinite/);
  });

  it('reads BER indefinite lengths and constructed octet strings', () => {
    // SEQUENCE { OCTET STRING (constructed) { "ab", { "cd" } }, NULL }
    const ber = hex('3080 2480 0402 6162 2480 0402 6364 0000 0000 0500 0000');
    const root = parseAsn1(ber, { ber: true });
    const [octets, nothing] = readSequence(root);
    expect(new TextDecoder().decode(readOctetString(octets))).toBe('abcd');
    expect(nothing.tag).toBe(TAG.null);
    expect(root.encoded.length).toBe(ber.length);
    // DER never accepts a constructed string.
    expect(() => readOctetString({ ...octets, ber: false })).toThrow(Asn1Error);
    // An end-of-contents marker that never comes, or comes too soon.
    expect(() => parseAsn1(hex('3080 0500'), { ber: true })).toThrow(Asn1Error);
    expect(() => parseAsn1(hex('0000'), { ber: true })).toThrow(/end-of-contents/);
  });

  it('bounds nesting without recursing on the input', () => {
    // 2,000 nested indefinite lengths stop at the depth limit instead of the stack's.
    const deep = concatBytes([
      ...Array.from({ length: 2000 }, () => hex('3080')),
      ...Array.from({ length: 2000 }, () => hex('0000')),
    ]);
    expect(() => parseAsn1(deep, { ber: true })).toThrow(/Nested too deeply/);
    // Definite lengths are skipped over, however deep; only the outer element is read.
    let nested: Bytes = DER_NULL;
    for (let depth = 0; depth < 5000; depth++) {
      nested = encodeElement(TAG.sequence, nested);
    }
    expect(parseAsn1(nested).tag).toBe(TAG.sequence);
    // A container can't hold an unbounded number of elements.
    const many = encodeElement(TAG.sequence, ...Array.from({ length: 10_001 }, () => DER_NULL));
    expect(() => children(parseAsn1(many))).toThrow(/Too many/);
  });

  it('reads high tag numbers when walking BER', () => {
    const ber = hex('3080 bf8a3b 0100 0000');
    expect(children(parseAsn1(ber, { ber: true }))[0].tag).toBe(0xbf);
    expect(() => parseAsn1(hex('3f8080808001 00'))).toThrow(/Tag number too large/);
  });
});

describe('integers and object identifiers', () => {
  it('reads small and unsigned integers, refusing redundant octets', () => {
    expect(readSmallInteger(element(TAG.integer, hex('00')))).toBe(0);
    expect(readSmallInteger(element(TAG.integer, hex('0800')))).toBe(2048);
    expect(readSmallInteger(element(TAG.integer, hex('00ff')))).toBe(255);
    expect(() => readSmallInteger(element(TAG.integer, hex('ff')))).toThrow(/out of range/);
    expect(() => readSmallInteger(element(TAG.integer, hex('0001')))).toThrow(/not minimal/);
    expect(() => readSmallInteger(element(TAG.integer, hex('ff80')))).toThrow(/not minimal/);
    expect(() => readSmallInteger(element(TAG.integer, new Uint8Array(0)))).toThrow(/Empty/);
    expect(() => readSmallInteger(element(TAG.integer, hex('7fffffffffffffff')))).toThrow(
      /out of range/
    );
    expect(() => readSmallInteger(element(TAG.octetString, hex('01')))).toThrow(/an integer/);
    expect(readUnsignedInteger(element(TAG.integer, hex('00f1e2')))).toEqual(hex('f1e2'));
    expect(() => readUnsignedInteger(element(TAG.integer, hex('f1e2')))).toThrow(/Negative/);
    expect(toHex(encodeSmallInteger(128))).toBe('02020080');
    expect(toHex(encodeSmallInteger(0))).toBe('020100');
  });

  it('measures bit lengths', () => {
    expect(bitLength(hex('00'))).toBe(0);
    expect(bitLength(hex('01'))).toBe(1);
    expect(bitLength(hex('0080'))).toBe(8);
    expect(bitLength(new Uint8Array(256).fill(0xff))).toBe(2048);
  });

  it('reads and writes object identifiers', () => {
    for (const oid of [
      '1.2.840.113549.1.1.1',
      '2.5.4.3',
      '0.9.2342.19200300.100.1.25',
      '2.999.3',
    ]) {
      expect(readOid(parseAsn1(encodeOid(oid)))).toBe(oid);
    }
    expect(toHex(encodeOid('1.2.840.10045.3.1.7'))).toBe('06082A8648CE3D030107');
    // Arcs beyond 2^53 survive.
    const uuid = '2.25.329800735698586629295641978511506172918';
    expect(readOid(parseAsn1(encodeOid(uuid)))).toBe(uuid);
    expect(() => readOid(element(TAG.oid, hex('2a81')))).toThrow(/cut short/);
    expect(() => readOid(element(TAG.oid, hex('2a8001')))).toThrow(/not minimal/);
    expect(() => readOid(element(TAG.oid, new Uint8Array(0)))).toThrow(/Bad object/);
  });

  it('reads bit strings of whole octets', () => {
    expect(readBitString(element(TAG.bitString, hex('00 0102')))).toEqual(hex('0102'));
    expect(() => readBitString(element(TAG.bitString, hex('01 0102')))).toThrow(/unused bits/);
    expect(() => readBitString(element(TAG.bitString, new Uint8Array(0)))).toThrow(/unused bits/);
  });

  it('reads implicitly tagged octet strings', () => {
    const tag = contextTag(0, false);
    expect(readOctetString(element(tag, hex('0102')), tag)).toEqual(hex('0102'));
    const ber = parseAsn1(hex('a080 0402 0102 0401 03 0000'), { ber: true });
    expect(readOctetString(ber, tag)).toEqual(hex('010203'));
    expect(() => readOctetString(element(TAG.octetString, hex('01')), tag)).toThrow(Asn1Error);
  });
});

const text = (tag: number, bytes: Bytes) => readString(element(tag, bytes));
const time = (tag: number, value: string) =>
  readTime(element(tag, new TextEncoder().encode(value))).toISOString();

describe('strings and times', () => {
  it('decodes the string types names use', () => {
    expect(text(TAG.utf8String, new TextEncoder().encode('San José'))).toBe('San José');
    expect(text(TAG.printableString, new TextEncoder().encode('Contoso'))).toBe('Contoso');
    expect(text(TAG.ia5String, new TextEncoder().encode('a@b.c'))).toBe('a@b.c');
    expect(text(TAG.teletexString, hex('e9'))).toBe('é');
    expect(text(TAG.bmpString, hex('0041 00e9 d83d de00'))).toBe('Aé😀');
    expect(text(TAG.universalString, hex('00000041 0001f600'))).toBe('A😀');
    expect(text(TAG.integer, hex('01'))).toBeNull();
    expect(() => text(TAG.utf8String, hex('c3'))).toThrow(/UTF-8/);
    expect(() => text(TAG.bmpString, hex('00'))).toThrow(/length/);
    expect(() => text(TAG.universalString, hex('00110000'))).toThrow(/character/);
  });

  it('reads UTCTime and GeneralizedTime', () => {
    expect(time(TAG.utcTime, '261001000000Z')).toBe('2026-10-01T00:00:00.000Z');
    expect(time(TAG.utcTime, '500101000000Z')).toBe('1950-01-01T00:00:00.000Z');
    expect(time(TAG.utcTime, '4912312359Z')).toBe('2049-12-31T23:59:00.000Z');
    expect(time(TAG.generalizedTime, '20561001000000Z')).toBe('2056-10-01T00:00:00.000Z');
    expect(time(TAG.generalizedTime, '99991231235959Z')).toBe('9999-12-31T23:59:59.000Z');
    expect(time(TAG.generalizedTime, '20261001123456.5Z')).toBe('2026-10-01T12:34:56.500Z');
    expect(time(TAG.generalizedTime, '00500101000000Z')).toBe('0050-01-01T00:00:00.000Z');
    for (const bad of [
      '260230000000Z',
      '261301000000Z',
      '261001246000Z',
      '261001000000+0100',
      '2610',
    ]) {
      expect(() => time(TAG.utcTime, bad)).toThrow(Asn1Error);
    }
    expect(() => time(TAG.octetString, '261001000000Z')).toThrow(/a time/);
  });
});

describe('bytes and base64', () => {
  it('converts base64, base64url and hex', () => {
    const bytes = hex('fbff00');
    expect(toBase64(bytes)).toBe('+/8A');
    expect(toBase64Url(bytes)).toBe('-_8A');
    expect(toBase64Url(hex('ff'))).toBe('_w');
    expect(fromBase64('+/8A')).toEqual(bytes);
    expect(fromBase64('_w')).toBeNull();
    expect(fromBase64Url('_w')).toEqual(hex('ff'));
    expect(fromBase64('/w')).toEqual(hex('ff'));
    expect(fromBase64('/w==')).toEqual(hex('ff'));
    expect(fromBase64('a')).toBeNull();
    expect(fromBase64('ab c')).toBeNull();
    expect(fromBase64Url('a+b')).toBeNull();
    expect(toHex(hex('0aff'))).toBe('0AFF');
    // Large inputs don't overflow the call stack. (toEqual is slow on 200 KB, hence bytesEqual.)
    const big = new Uint8Array(200_000).fill(65);
    const back = fromBase64(toBase64(big));
    expect(back?.length).toBe(big.length);
    expect(back !== null && bytesEqual(back, big)).toBe(true);
  });

  it('refuses long runs of padding quickly', () => {
    // Stripping these with /=+$/ took seconds (quadratic time) and froze the page.
    const started = performance.now();
    expect(fromBase64(`${'='.repeat(100_000)}A`)).toBeNull();
    expect(fromBase64('='.repeat(100_000))).toBeNull();
    expect(fromBase64(`QUJD${'='.repeat(100_000)}`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    // At most two "=" are padding.
    expect(fromBase64('QQ==')).toEqual(hex('41'));
    expect(fromBase64('QQ===')).toBeNull();
    expect(fromBase64('====')).toBeNull();
    expect(fromBase64('')).toEqual(new Uint8Array(0));
  });
});
