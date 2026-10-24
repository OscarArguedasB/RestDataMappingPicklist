import type { Asn1Element, Bytes } from './asn1';
import {
  Asn1Error,
  TAG,
  bytesEqual,
  children,
  contextTag,
  parseAsn1,
  readOctetString,
  readOid,
  readSequence,
  readSmallInteger,
} from './asn1';
import type { PasswordEncodings } from './pbe';
import {
  DIGEST_ALGORITHMS,
  HMAC_ALGORITHMS,
  PBKDF2,
  PKCS12_MAC_KEY,
  PasswordError,
  UnsupportedEncryptionError,
  decryptWithPassword,
  hashLength,
  hmac,
  passwordEncodings,
  pbkdf2,
  pkcs12Kdf,
  readPbkdf2Params,
} from './pbe';

// PKCS #12 (.pfx, .p12) files as Windows, macOS, Java and OpenSSL write them (RFC 7292): an
// authenticated safe of plain and password-encrypted contents, holding key and certificate bags.
// Only password integrity and privacy are supported; files signed or encrypted to a public key
// are rare and refused. Some writers still use BER (indefinite lengths), so it's read as BER.

const DATA = '1.2.840.113549.1.7.1';
const SIGNED_DATA = '1.2.840.113549.1.7.2';
const ENVELOPED_DATA = '1.2.840.113549.1.7.3';
const ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const PBMAC1 = '1.2.840.113549.1.5.14';

const BAGS = {
  key: '1.2.840.113549.1.12.10.1.1',
  shroudedKey: '1.2.840.113549.1.12.10.1.2',
  certificate: '1.2.840.113549.1.12.10.1.3',
  safeContents: '1.2.840.113549.1.12.10.1.6',
} as const;

const X509_CERTIFICATE = '1.2.840.113549.1.9.22.1';

/** Far more than real files have: they hold two or three contents and bags, one or two encrypted. */
const LIMITS = { contents: 32, bags: 256, nesting: 4, encrypted: 8 } as const;

/** Decrypts one encrypted content or key bag of the file. */
type Decrypt = (algorithm: Asn1Element | undefined, data: Bytes) => Promise<Bytes>;

export interface Pkcs12Contents {
  /** PKCS #8 PrivateKeyInfo DER, decrypted. */
  keys: Bytes[];
  /** X.509 certificate DER. */
  certificates: Bytes[];
}

/** True when the DER (read as BER) has the shape of a PFX: version 3 and a ContentInfo. */
export function looksLikePkcs12(element: Asn1Element): boolean {
  try {
    const [version, authSafe] = readSequence(element);
    readOid(readSequence(authSafe)[0]);
    return readSmallInteger(version) === 3;
  } catch {
    return false;
  }
}

/** The content of a PKCS #7 ContentInfo whose type is data: the bytes it wraps. */
function dataContent(contentType: string, content: Asn1Element | undefined): Bytes {
  if (contentType === SIGNED_DATA) {
    throw new UnsupportedEncryptionError('a signature (public-key integrity mode)', {
      convertible: false,
    });
  }
  if (contentType !== DATA || content?.tag !== contextTag(0)) {
    throw new Asn1Error('Expected PKCS #7 data.');
  }
  return readOctetString(children(content)[0]);
}

async function verifyMac(
  macData: Asn1Element,
  content: Bytes,
  passwords: PasswordEncodings,
  subtle: SubtleCrypto
): Promise<PasswordEncodings> {
  const [digestInfo, saltElement, iterationsElement] = readSequence(macData, 'MAC data');
  const [algorithm, digestElement] = readSequence(digestInfo, 'a MAC');
  const [oidElement, parameters] = readSequence(algorithm, 'a MAC algorithm');
  const oid = readOid(oidElement);
  const expected = readOctetString(digestElement);
  if (oid === PBMAC1) {
    // RFC 9579: an HMAC keyed by PBKDF2 from the UTF-8 password. It says nothing about which
    // BMPString encoding of an empty password the contents use, so both stay possible.
    const [kdf, scheme] = readSequence(parameters, 'PBMAC1 parameters');
    const [kdfOid, kdfParameters] = readSequence(kdf, 'a key derivation');
    const [schemeOid] = readSequence(scheme, 'a MAC scheme');
    const hash = HMAC_ALGORITHMS[readOid(schemeOid)];
    if (readOid(kdfOid) !== PBKDF2 || !hash) {
      throw new UnsupportedEncryptionError('a PBMAC1 MAC that isn’t PBKDF2 with HMAC');
    }
    const { salt, iterations, keyLength, prf } = readPbkdf2Params(kdfParameters);
    if (keyLength === null || keyLength < 1 || keyLength > 64) {
      throw new Asn1Error('Bad PBMAC1 key length.');
    }
    const key = await pbkdf2(prf, passwords.utf8, salt, iterations, keyLength, subtle);
    if (!bytesEqual(await hmac(hash, key, content, subtle), expected)) {
      throw new PasswordError();
    }
    return passwords;
  }
  const hash = DIGEST_ALGORITHMS[oid];
  if (!hash) {
    throw new UnsupportedEncryptionError(`a MAC with an unknown hash (${oid})`);
  }
  const salt = readOctetString(saltElement);
  const iterations = iterationsElement ? readSmallInteger(iterationsElement) : 1;
  for (const password of passwords.bmp) {
    const key = await pkcs12Kdf(
      hash,
      password,
      salt,
      iterations,
      PKCS12_MAC_KEY,
      hashLength(hash),
      subtle
    );
    if (bytesEqual(await hmac(hash, key, content, subtle), expected)) {
      // The contents were encrypted with the same encoding of the password.
      return { utf8: passwords.utf8, bmp: [password] };
    }
  }
  throw new PasswordError();
}

/** The SafeContents inside one ContentInfo of the authenticated safe, decrypted if needed. */
async function safeContents(contentInfo: Asn1Element, decrypt: Decrypt): Promise<Bytes> {
  const [typeElement, content] = readSequence(contentInfo, 'a ContentInfo');
  const contentType = readOid(typeElement);
  if (contentType === ENVELOPED_DATA) {
    throw new UnsupportedEncryptionError('encryption to a certificate (public-key privacy mode)', {
      convertible: false,
    });
  }
  if (contentType !== ENCRYPTED_DATA) {
    return dataContent(contentType, content);
  }
  if (content?.tag !== contextTag(0)) {
    throw new Asn1Error('Expected encrypted data.');
  }
  const [version, encryptedContentInfo] = readSequence(children(content)[0], 'encrypted data');
  if (readSmallInteger(version) > 2) {
    throw new Asn1Error('Unknown encrypted data version.');
  }
  const [innerType, algorithm, encrypted] = readSequence(encryptedContentInfo, 'encrypted content');
  if (readOid(innerType) !== DATA || !encrypted) {
    throw new Asn1Error('Expected encrypted PKCS #7 data.');
  }
  // [0] IMPLICIT OCTET STRING, constructed when BER splits it.
  const ciphertext = readOctetString(encrypted, contextTag(0, false));
  return decrypt(algorithm, ciphertext);
}

async function readBags(contents: Bytes, decrypt: Decrypt, found: Pkcs12Contents): Promise<void> {
  // Bags can hold more SafeContents; a queue instead of recursion, with a depth limit.
  const queue = [{ contents, depth: 0 }];
  let count = 0;
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const bag of readSequence(parseAsn1(next.contents, { ber: true }), 'safe contents')) {
      if (++count > LIMITS.bags) {
        throw new Asn1Error('Too many bags.');
      }
      const [bagId, bagValue] = readSequence(bag, 'a safe bag');
      if (bagValue?.tag !== contextTag(0)) {
        throw new Asn1Error('Expected a bag value.');
      }
      const [value] = children(bagValue);
      switch (readOid(bagId)) {
        case BAGS.key:
          found.keys.push(value.encoded);
          break;
        case BAGS.shroudedKey: {
          const [algorithm, encrypted] = readSequence(value, 'an encrypted key');
          found.keys.push(await decrypt(algorithm, readOctetString(encrypted)));
          break;
        }
        case BAGS.certificate: {
          const [certId, certValue] = readSequence(value, 'a certificate bag');
          if (readOid(certId) === X509_CERTIFICATE && certValue?.tag === contextTag(0)) {
            found.certificates.push(readOctetString(children(certValue)[0]));
          }
          break;
        }
        case BAGS.safeContents:
          if (next.depth + 1 >= LIMITS.nesting) {
            throw new Asn1Error('Bags nested too deeply.');
          }
          queue.push({ contents: value.encoded, depth: next.depth + 1 });
          break;
        default:
          // CRLs, secrets and unknown bags aren't needed.
          break;
      }
    }
  }
}

/**
 * The keys and certificates in a PKCS #12 file. An empty or missing password works for files
 * without one. Throws PasswordError when the MAC doesn't match (a wrong password), or, for
 * files without a MAC, when nothing decrypts.
 */
export async function readPkcs12(
  der: Bytes,
  password: string,
  subtle: SubtleCrypto
): Promise<Pkcs12Contents> {
  const [version, authSafe, macData, ...extra] = readSequence(
    parseAsn1(der, { ber: true }),
    'a PKCS #12 file'
  );
  if (readSmallInteger(version) !== 3 || extra.length > 0) {
    throw new Asn1Error('Unknown PKCS #12 version.');
  }
  const [typeElement, content] = readSequence(authSafe, 'a ContentInfo');
  const authenticated = dataContent(readOid(typeElement), content);
  let passwords = passwordEncodings(password);
  if (macData) {
    if (macData.tag !== TAG.sequence) {
      throw new Asn1Error('Expected MAC data.');
    }
    passwords = await verifyMac(macData, authenticated, passwords, subtle);
  }
  const contentInfos = readSequence(parseAsn1(authenticated, { ber: true }), 'safe contents');
  if (contentInfos.length > LIMITS.contents) {
    throw new Asn1Error('Too many contents.');
  }
  // Every decryption runs the password through a KDF, so a file can't ask for too many.
  let decryptions = 0;
  const decrypt: Decrypt = (algorithm, data) => {
    if (++decryptions > LIMITS.encrypted) {
      throw new Asn1Error('Too many encrypted items.');
    }
    return decryptWithPassword(algorithm, data, passwords, subtle);
  };
  const found: Pkcs12Contents = { keys: [], certificates: [] };
  for (const contentInfo of contentInfos) {
    await readBags(await safeContents(contentInfo, decrypt), decrypt, found);
  }
  return found;
}
