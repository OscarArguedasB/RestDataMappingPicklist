import type { Asn1Element, Bytes } from './asn1';
import {
  Asn1Error,
  TAG,
  children,
  contextTag,
  expectTag,
  parseAsn1,
  readBitString,
  readOid,
  readSequence,
  readSmallInteger,
  readString,
  readTime,
  toBase64Url,
  toHex,
} from './asn1';
import { digest } from './pbe';
import type { PublicKey } from './privateKeys';
import { readPublicKeyInfo } from './privateKeys';
import type { CertificateInfo } from './secrets';
import { SECRET_LIMITS } from './secrets';

// X.509 certificates: what the setup page shows about one (subject, issuer, validity,
// thumbprints) and the public key, to check that it belongs to the private key. Signatures and
// chains aren't checked: the token service decides whether it trusts the certificate.

export interface ParsedCertificate {
  der: Bytes;
  info: CertificateInfo;
  notBefore: Date;
  notAfter: Date;
  publicKey: PublicKey;
  /** The "x5t" and "x5t#S256" JWS headers: SHA-1 and SHA-256 of the DER, base64url. */
  x5t: string;
  x5tS256: string;
}

/** Short names for attribute types, as RFC 4514 and OpenSSL print them. */
const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'title',
  '2.5.4.13': 'description',
  '2.5.4.15': 'businessCategory',
  '2.5.4.17': 'postalCode',
  '2.5.4.41': 'name',
  '2.5.4.42': 'GN',
  '2.5.4.43': 'initials',
  '2.5.4.44': 'generationQualifier',
  '2.5.4.46': 'dnQualifier',
  '2.5.4.65': 'pseudonym',
  '2.5.4.97': 'organizationIdentifier',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '1.3.6.1.4.1.311.60.2.1.1': 'jurisdictionL',
  '1.3.6.1.4.1.311.60.2.1.2': 'jurisdictionST',
  '1.3.6.1.4.1.311.60.2.1.3': 'jurisdictionC',
};

/** Characters RFC 4514 escapes anywhere in a value. */
const SPECIAL = new Set(['"', '+', ',', ';', '<', '>', '\\']);

/** Control and bidirectional formatting characters, escaped so a name can't disguise itself. */
function isInvisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code < 0xa0) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** A value escaped as RFC 4514 says, one code point at a time. */
function escapeValue(text: string): string {
  let escaped = '';
  let offset = 0;
  for (const character of text) {
    const first = offset === 0;
    offset += character.length;
    const last = offset === text.length;
    if (
      SPECIAL.has(character) ||
      (first && (character === '#' || character === ' ')) ||
      (last && character === ' ')
    ) {
      escaped += `\\${character}`;
    } else if (isInvisible(character.codePointAt(0) ?? 0)) {
      for (const byte of new TextEncoder().encode(character)) {
        escaped += `\\${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function formatAttribute(attribute: Asn1Element): string {
  const [typeElement, value] = readSequence(attribute, 'an attribute');
  if (!value) {
    throw new Asn1Error('Attribute without a value.');
  }
  const oid = readOid(typeElement);
  const name = ATTRIBUTE_NAMES[oid];
  const text = name ? readString(value) : null;
  // RFC 4514: anything else is written as the DER of the value, in hex.
  return text === null ? `${name ?? oid}=#${toHex(value.encoded)}` : `${name}=${escapeValue(text)}`;
}

/** A Name as an RFC 4514 string: the most specific part first, such as “CN=api,O=Contoso”. */
export function formatName(name: Asn1Element): string {
  const parts = readSequence(name, 'a name').map((rdn) =>
    children(expectTag(rdn, TAG.set, 'a relative name'))
      .map(formatAttribute)
      .join('+')
  );
  return parts.toReversed().join(',');
}

/** What fits a CertificateInfo field when it's saved. */
function shorten(text: string): string {
  const limit = SECRET_LIMITS.maxTextLength;
  if (text.length <= limit) {
    return text;
  }
  let end = limit - 1;
  // Never cut a character outside the BMP in half.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return `${text.slice(0, end)}…`;
}

/** The serial number in hex, without the zero octet that keeps a high first bit positive. */
function serialNumber(element: Asn1Element | undefined): string {
  // Some CAs write serial numbers that aren't minimal, so this isn't readUnsignedInteger.
  let bytes = expectTag(element, TAG.integer, 'a serial number').content;
  if (bytes.length === 0) {
    throw new Asn1Error('Empty serial number.');
  }
  while (bytes.length > 1 && bytes[0] === 0) {
    bytes = bytes.subarray(1);
  }
  return toHex(bytes);
}

/** Reads a DER certificate. */
export async function parseCertificate(
  der: Bytes,
  subtle: SubtleCrypto
): Promise<ParsedCertificate> {
  const [tbs, signatureAlgorithm, signature, ...extra] = readSequence(
    parseAsn1(der),
    'a certificate'
  );
  readSequence(signatureAlgorithm, 'a signature algorithm');
  readBitString(signature);
  if (extra.length > 0) {
    throw new Asn1Error('Unexpected certificate fields.');
  }
  const fields = readSequence(tbs, 'certificate fields');
  // Version 1 certificates leave the version out.
  const version = fields[0]?.tag === contextTag(0) ? fields.shift() : undefined;
  if (version && readSmallInteger(children(version)[0]) > 2) {
    throw new Asn1Error('Unknown certificate version.');
  }
  const [serial, , issuer, validity, subject, subjectPublicKeyInfo] = fields;
  if (!subjectPublicKeyInfo) {
    throw new Asn1Error('Certificate fields cut short.');
  }
  const [start, end, ...rest] = readSequence(validity, 'a validity period');
  if (rest.length > 0) {
    throw new Asn1Error('Unexpected validity fields.');
  }
  const notBefore = readTime(start);
  const notAfter = readTime(end);
  const [sha1, sha256] = await Promise.all([
    digest('SHA-1', der, subtle),
    digest('SHA-256', der, subtle),
  ]);
  return {
    der,
    info: {
      subject: shorten(formatName(subject)),
      issuer: shorten(formatName(issuer)),
      serialNumber: shorten(serialNumber(serial)),
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      sha1Thumbprint: toHex(sha1),
      sha256Thumbprint: toHex(sha256),
    },
    notBefore,
    notAfter,
    publicKey: readPublicKeyInfo(subjectPublicKeyInfo),
    x5t: toBase64Url(sha1),
    x5tS256: toBase64Url(sha256),
  };
}
