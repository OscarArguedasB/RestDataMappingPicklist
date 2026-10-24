// A small reader for ASN.1: DER, the encoding of certificates and keys, and the BER that some
// PKCS #12 files still use. Plus the few encoders needed to rewrap a key as PKCS #8 and helpers
// for bytes, hex and base64. Everything it reads comes from files people choose, so every length
// is checked against its container, nesting is bounded and nothing recurses on the input.

/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Malformed or unexpected ASN.1. The message is for developers; callers show their own. */
export class Asn1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Asn1Error';
  }
}

/** Identifier octets of the universal types used here. */
export const TAG = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  numericString: 0x12,
  printableString: 0x13,
  teletexString: 0x14,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  visibleString: 0x1a,
  universalString: 0x1c,
  bmpString: 0x1e,
  sequence: 0x30,
  set: 0x31,
} as const;

const CONSTRUCTED = 0x20;

/** The identifier octet of a context-specific tag such as [0]. */
export function contextTag(number: number, constructed = true): number {
  return 0x80 | (constructed ? CONSTRUCTED : 0) | number;
}

export interface Asn1Element {
  /** The first identifier octet: class, constructed bit and tag number (0x1f for high numbers). */
  readonly tag: number;
  readonly constructed: boolean;
  /** The whole element as it was encoded, from the identifier to the end. */
  readonly encoded: Bytes;
  /** The content octets, without the end-of-contents octets of an indefinite length. */
  readonly content: Bytes;
  /** Read as BER: indefinite lengths and constructed strings are accepted inside. */
  readonly ber: boolean;
}

/** How deeply indefinite lengths and constructed strings may nest. */
const MAX_DEPTH = 32;
/** More elements than any certificate or key file has in one place. */
const MAX_CHILDREN = 10_000;

interface Header {
  tag: number;
  constructed: boolean;
  contentStart: number;
  /** Null for an indefinite length (BER only). */
  length: number | null;
}

function byteAt(bytes: Bytes, position: number, end: number): number {
  if (position >= end) {
    throw new Asn1Error('Unexpected end of data.');
  }
  return bytes[position];
}

function readHeader(bytes: Bytes, offset: number, end: number, ber: boolean): Header {
  let position = offset;
  const tag = byteAt(bytes, position++, end);
  if ((tag & 0x1f) === 0x1f) {
    // High tag numbers aren't used by certificates or keys, but walking BER can meet one.
    let count = 0;
    while (byteAt(bytes, position++, end) & 0x80) {
      if (++count >= 4) {
        throw new Asn1Error('Tag number too large.');
      }
    }
  }
  const constructed = (tag & CONSTRUCTED) !== 0;
  const first = byteAt(bytes, position++, end);
  let length: number | null;
  if (first < 0x80) {
    length = first;
  } else if (first === 0x80) {
    if (!ber || !constructed) {
      throw new Asn1Error('Indefinite length.');
    }
    length = null;
  } else {
    const count = first & 0x7f;
    if (count > 4) {
      throw new Asn1Error('Length too large.');
    }
    length = 0;
    for (let index = 0; index < count; index++) {
      length = length * 256 + byteAt(bytes, position++, end);
    }
    // DER always uses the shortest form; BER allows padded lengths.
    if (!ber && (length < 0x80 || length < 256 ** (count - 1))) {
      throw new Asn1Error('Length not minimal.');
    }
  }
  if (length !== null && length > end - position) {
    throw new Asn1Error('Length past the end of its container.');
  }
  return { tag, constructed, contentStart: position, length };
}

/** Where the content of an indefinite-length element ends. Walks the content without recursion. */
function endOfContents(bytes: Bytes, start: number, end: number): number {
  let position = start;
  let open = 1;
  for (;;) {
    if (byteAt(bytes, position, end) === 0 && byteAt(bytes, position + 1, end) === 0) {
      open--;
      if (open === 0) {
        return position;
      }
      position += 2;
      continue;
    }
    const header = readHeader(bytes, position, end, true);
    if (header.tag === 0) {
      throw new Asn1Error('Malformed end-of-contents.');
    }
    if (header.length === null) {
      if (++open > MAX_DEPTH) {
        throw new Asn1Error('Nested too deeply.');
      }
      position = header.contentStart;
    } else {
      position = header.contentStart + header.length;
    }
  }
}

function readElement(
  bytes: Bytes,
  offset: number,
  end: number,
  ber: boolean
): { element: Asn1Element; next: number } {
  const header = readHeader(bytes, offset, end, ber);
  if (header.tag === 0) {
    throw new Asn1Error('Unexpected end-of-contents.');
  }
  let contentEnd: number;
  let next: number;
  if (header.length === null) {
    contentEnd = endOfContents(bytes, header.contentStart, end);
    next = contentEnd + 2;
  } else {
    contentEnd = header.contentStart + header.length;
    next = contentEnd;
  }
  const element: Asn1Element = {
    tag: header.tag,
    constructed: header.constructed,
    encoded: bytes.subarray(offset, next),
    content: bytes.subarray(header.contentStart, contentEnd),
    ber,
  };
  return { element, next };
}

/** Reads `bytes` as exactly one element. BER is accepted only when asked for. */
export function parseAsn1(bytes: Bytes, options: { ber?: boolean } = {}): Asn1Element {
  const { element, next } = readElement(bytes, 0, bytes.length, options.ber ?? false);
  if (next !== bytes.length) {
    throw new Asn1Error('Unexpected data after the end.');
  }
  return element;
}

/** True when `bytes` is exactly one BER element, as anything correctly decrypted here is. */
export function isSingleElement(bytes: Bytes): boolean {
  try {
    parseAsn1(bytes, { ber: true });
    return true;
  } catch {
    return false;
  }
}

/** The elements inside a constructed element, in order. */
export function children(element: Asn1Element): Asn1Element[] {
  if (!element.constructed) {
    throw new Asn1Error('Expected a constructed element.');
  }
  const { content, ber } = element;
  const items: Asn1Element[] = [];
  let offset = 0;
  while (offset < content.length) {
    if (items.length >= MAX_CHILDREN) {
      throw new Asn1Error('Too many elements.');
    }
    const { element: child, next } = readElement(content, offset, content.length, ber);
    items.push(child);
    offset = next;
  }
  return items;
}

export function expectTag(
  element: Asn1Element | undefined,
  tag: number,
  what: string
): Asn1Element {
  if (!element || element.tag !== tag) {
    throw new Asn1Error(`Expected ${what}.`);
  }
  return element;
}

/** The elements of a SEQUENCE. */
export function readSequence(element: Asn1Element | undefined, what = 'a sequence'): Asn1Element[] {
  return children(expectTag(element, TAG.sequence, what));
}

function integerContent(element: Asn1Element | undefined): Bytes {
  const bytes = expectTag(element, TAG.integer, 'an integer').content;
  if (bytes.length === 0) {
    throw new Asn1Error('Empty integer.');
  }
  // Both DER and BER forbid redundant leading octets.
  if (
    bytes.length > 1 &&
    ((bytes[0] === 0 && bytes[1] < 0x80) || (bytes[0] === 0xff && bytes[1] >= 0x80))
  ) {
    throw new Asn1Error('Integer not minimal.');
  }
  return bytes;
}

/** A non-negative INTEGER that fits a JavaScript number exactly. */
export function readSmallInteger(element: Asn1Element | undefined): number {
  const bytes = integerContent(element);
  if (bytes[0] & 0x80 || bytes.length > 7) {
    throw new Asn1Error('Integer out of range.');
  }
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Asn1Error('Integer out of range.');
  }
  return value;
}

/** The magnitude of a non-negative INTEGER, without the zero octet that keeps it positive. */
export function readUnsignedInteger(element: Asn1Element | undefined): Bytes {
  const bytes = integerContent(element);
  if (bytes[0] & 0x80) {
    throw new Asn1Error('Negative integer.');
  }
  return bytes[0] === 0 && bytes.length > 1 ? bytes.subarray(1) : bytes;
}

/** Significant bits in a big-endian magnitude, such as an RSA modulus. */
export function bitLength(magnitude: Bytes): number {
  let index = 0;
  while (index < magnitude.length && magnitude[index] === 0) {
    index++;
  }
  if (index === magnitude.length) {
    return 0;
  }
  return (magnitude.length - index - 1) * 8 + (32 - Math.clz32(magnitude[index]));
}

/** An OBJECT IDENTIFIER in dotted form, such as 1.2.840.113549.1.1.1. */
export function readOid(element: Asn1Element | undefined): string {
  const bytes = expectTag(element, TAG.oid, 'an object identifier').content;
  if (bytes.length === 0 || bytes.length > 64) {
    throw new Asn1Error('Bad object identifier.');
  }
  const arcs: string[] = [];
  let value = 0n;
  let atStart = true;
  for (const byte of bytes) {
    if (atStart && byte === 0x80) {
      throw new Asn1Error('Object identifier not minimal.');
    }
    value = (value << 7n) | BigInt(byte & 0x7f);
    atStart = (byte & 0x80) === 0;
    if (atStart) {
      if (arcs.length === 0) {
        // The first number holds the first two arcs: 40 × first + second.
        const first = value < 40n ? 0n : value < 80n ? 1n : 2n;
        arcs.push(String(first), String(value - first * 40n));
      } else {
        arcs.push(String(value));
      }
      value = 0n;
    }
  }
  if (!atStart) {
    throw new Asn1Error('Object identifier cut short.');
  }
  return arcs.join('.');
}

/** Puts a BER constructed string back together, without recursion. */
function joinSegments(element: Asn1Element, primitiveTag: number): Bytes {
  const parts: Bytes[] = [];
  const stack = [{ items: children(element), index: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.index >= top.items.length) {
      stack.pop();
      continue;
    }
    const item = top.items[top.index++];
    if (item.tag === TAG.octetString || item.tag === primitiveTag) {
      parts.push(item.content);
    } else if (item.tag === (TAG.octetString | CONSTRUCTED) && stack.length < MAX_DEPTH) {
      stack.push({ items: children(item), index: 0 });
    } else {
      throw new Asn1Error('Bad string segment.');
    }
  }
  return concatBytes(parts);
}

/**
 * The bytes of an OCTET STRING, or of an implicitly tagged one when `tag` is given (such as
 * [0] in PKCS #7). BER may split it into a constructed string of segments.
 */
export function readOctetString(
  element: Asn1Element | undefined,
  tag: number = TAG.octetString
): Bytes {
  if (element?.tag === tag) {
    return element.content;
  }
  if (element?.ber && element.tag === (tag | CONSTRUCTED)) {
    return joinSegments(element, tag);
  }
  throw new Asn1Error('Expected an octet string.');
}

/** The bytes of a BIT STRING of whole octets, as keys and signatures are. */
export function readBitString(element: Asn1Element | undefined): Bytes {
  const bytes = expectTag(element, TAG.bitString, 'a bit string').content;
  if (bytes.length === 0 || bytes[0] !== 0) {
    throw new Asn1Error('Bit string with unused bits.');
  }
  return bytes.subarray(1);
}

/** Each byte as the character with that code, as in ISO 8859-1. */
export function latin1(bytes: Bytes): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x2000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x2000));
  }
  return text;
}

const LATIN1_STRINGS: ReadonlySet<number> = new Set([
  TAG.numericString,
  TAG.printableString,
  TAG.teletexString,
  TAG.ia5String,
  TAG.visibleString,
]);

/** The text of a character string; null when the element isn't one. */
export function readString(element: Asn1Element): string | null {
  const bytes = element.content;
  if (element.tag === TAG.utf8String) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Asn1Error('Bad UTF-8.');
    }
  }
  if (element.tag === TAG.bmpString || element.tag === TAG.universalString) {
    const width = element.tag === TAG.bmpString ? 2 : 4;
    if (bytes.length % width !== 0) {
      throw new Asn1Error('Bad string length.');
    }
    let text = '';
    for (let index = 0; index < bytes.length; index += width) {
      let code = 0;
      for (let offset = 0; offset < width; offset++) {
        code = code * 256 + bytes[index + offset];
      }
      // BMPString is UTF-16BE, so surrogate pairs come through as two code units.
      if (width === 4 && (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) {
        throw new Asn1Error('Bad character.');
      }
      text += width === 2 ? String.fromCharCode(code) : String.fromCodePoint(code);
    }
    return text;
  }
  // PrintableString and IA5String are ASCII. Teletex is read as Latin-1, as most tools do.
  return LATIN1_STRINGS.has(element.tag) ? latin1(bytes) : null;
}

const UTC_TIME = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/;
const GENERALIZED_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3})\d*)?Z$/;

/** A UTCTime or GeneralizedTime in UTC, as certificates use them. */
export function readTime(element: Asn1Element | undefined): Date {
  const text = element ? latin1(element.content) : '';
  const match =
    element?.tag === TAG.utcTime
      ? UTC_TIME.exec(text)
      : element?.tag === TAG.generalizedTime
        ? GENERALIZED_TIME.exec(text)
        : null;
  if (!match) {
    throw new Asn1Error('Expected a time.');
  }
  let year = Number(match[1]);
  if (element?.tag === TAG.utcTime) {
    // RFC 5280: two-digit years from 50 are 19xx, the rest 20xx.
    year += year >= 50 ? 1900 : 2000;
  }
  const [month, day, hour, minute] = [2, 3, 4, 5].map((index) => Number(match[index]));
  const second = Number(match[6] ?? '0');
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  // setUTCFullYear keeps years below 100 as they are, unlike Date.UTC.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  // Out-of-range parts roll over (February 30 becomes March 2); a real time reads back the same.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Asn1Error('Bad time.');
  }
  return date;
}

// ---------------------------------------------------------------------------------------------
// Encoding (DER)

function encodeLength(length: number): Bytes {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }
  const octets: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    octets.unshift(rest % 256);
  }
  return Uint8Array.of(0x80 | octets.length, ...octets);
}

/** One element in DER, from its identifier octet and content. */
export function encodeElement(tag: number, ...contents: Bytes[]): Bytes {
  const content = concatBytes(contents);
  return concatBytes([Uint8Array.of(tag), encodeLength(content.length), content]);
}

/** An OBJECT IDENTIFIER from its dotted form (only for the constants in this code). */
export function encodeOid(oid: string): Bytes {
  const arcs = oid.split('.').map((arc) => BigInt(arc));
  const values = [arcs[0] * 40n + arcs[1], ...arcs.slice(2)];
  const bytes: number[] = [];
  for (const value of values) {
    const group = [Number(value & 0x7fn)];
    for (let rest = value >> 7n; rest > 0n; rest >>= 7n) {
      group.unshift(Number(rest & 0x7fn) | 0x80);
    }
    bytes.push(...group);
  }
  return encodeElement(TAG.oid, Uint8Array.from(bytes));
}

/** A small non-negative INTEGER, such as a version number. */
export function encodeSmallInteger(value: number): Bytes {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }
  return encodeElement(TAG.integer, Uint8Array.from(bytes));
}

export const DER_NULL: Bytes = Uint8Array.of(TAG.null, 0);

// ---------------------------------------------------------------------------------------------
// Bytes, hex and base64

export function concatBytes(parts: readonly Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

/** Uppercase hex, as certificate tools print thumbprints and serial numbers. */
export function toHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text.toUpperCase();
}

export function toBase64(bytes: Bytes): string {
  return btoa(latin1(bytes));
}

/** Base64 with the URL-safe alphabet and no padding, as JWS headers use it. */
export function toBase64Url(bytes: Bytes): string {
  return toBase64(bytes).replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
}

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/** The bytes of base64 text (standard alphabet, padding optional); null when it isn't base64. */
export function fromBase64(text: string): Bytes | null {
  // The pattern is checked first: it runs in linear time and allows at most two "=" at the end,
  // while stripping a long run of "=" with a regular expression takes quadratic time.
  if (!BASE64_TEXT.test(text)) {
    return null;
  }
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x3d) {
    end--;
  }
  const unpadded = text.slice(0, end);
  if (unpadded.length % 4 === 1) {
    return null;
  }
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The bytes of base64url text, as JWK members are; null when it isn't base64url. */
export function fromBase64Url(text: string): Bytes | null {
  return /^[A-Za-z0-9_-]*$/.test(text)
    ? fromBase64(text.replaceAll('-', '+').replaceAll('_', '/'))
    : null;
}
