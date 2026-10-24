import { describe, expect, it } from 'vitest';
import type { Bytes } from './asn1';
import { toBase64, toBase64Url } from './asn1';
import {
  CA,
  EC_P256,
  EC_P384,
  EC_P521,
  ED25519,
  OTHER_P256,
  PASSWORD,
  PFX,
  RSA_1024,
  RSA_2048,
  RSA_3072,
  SECP256K1,
  fromBase64,
  pem,
} from './__fixtures__/credentials';
import type { CredentialSource, ParseCredentialOptions } from './certificates';
import {
  CREDENTIAL_LIMITS,
  allowedAlgorithms,
  defaultAlgorithm,
  parseCredentials,
} from './certificates';
import { PicklistError } from './errors';
import type { JwsAlgorithm, SigningKey } from './secrets';
import { parseSecretSummary, summarizeSecret } from './secrets';
import { parseCertificate } from './x509';

const subtle = globalThis.crypto.subtle;
const NOW = new Date('2026-10-22T12:00:00.000Z');

const utf8 = (text: string) => new TextEncoder().encode(text);
const compact = (base64: string) => base64.replace(/\s+/g, '');

function file(name: string, data: string | Uint8Array): CredentialSource {
  return { name, data: typeof data === 'string' ? utf8(data) : data };
}

function parse(sources: CredentialSource[], options: ParseCredentialOptions = {}) {
  return parseCredentials(sources, { now: NOW, ...options });
}

/** The error a parse fails with; anything but a setup error fails the test. */
async function failure(promise: Promise<unknown>): Promise<PicklistError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PicklistError && error.kind === 'config') {
      return error;
    }
    throw error;
  }
  throw new Error('Expected parsing to fail');
}

function hexToBase64Url(hex: string): string {
  return toBase64Url(Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16)));
}

const keyPem = (base64: string) => pem('PRIVATE KEY', base64);
const certificatePem = (base64: string) => pem('CERTIFICATE', base64);
const pfx = (base64: string, name = 'cert.pfx') => file(name, fromBase64(base64));
const damaged = (name: string) => `“${name}” looks damaged or incomplete.`;

function byteLength(data: unknown): number {
  return ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data.byteLength : 0;
}

/** WebCrypto with one import refused, the way a given browser would refuse it. */
function refusingImports(refuse: (format: string, data: unknown, algorithm: unknown) => boolean) {
  return new Proxy(subtle, {
    get(target, property) {
      if (property === 'importKey') {
        return (...args: Parameters<SubtleCrypto['importKey']>) =>
          refuse(args[0], args[1], args[2])
            ? Promise.reject(new DOMException('Not supported here', 'NotSupportedError'))
            : target.importKey(...args);
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** WebCrypto that counts PBKDF2 derivations (the costly part of reading an encrypted key). */
function countingSubtle() {
  let count = 0;
  const counting = new Proxy(subtle, {
    get(target, property) {
      if (property === 'deriveBits') {
        return (...args: Parameters<SubtleCrypto['deriveBits']>) => {
          count += 1;
          return target.deriveBits(...args);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { subtle: counting, derivations: () => count };
}

/** DER: a tag, a definite length and the contents. */
function tlv(tag: number, ...parts: Bytes[]): Bytes {
  const body = Uint8Array.from(parts.flatMap((part) => [...part]));
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Uint8Array.from([tag, ...length, ...body]);
}

/** An EncryptedPrivateKeyInfo (PBES2, PBKDF2 with HMAC-SHA-256, AES-256-CBC) that only claims to hold a key. */
function pbes2Key(iterations: number, salt: number): Bytes {
  const oid = (...bytes: number[]) => tlv(0x06, Uint8Array.from(bytes));
  const integer = (value: number) => {
    const bytes: number[] = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) {
      bytes.unshift(rest % 256);
    }
    if ((bytes[0] ?? 0) & 0x80) {
      bytes.unshift(0);
    }
    return tlv(0x02, Uint8Array.from(bytes));
  };
  const pbkdf2 = tlv(
    0x30,
    oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0c),
    tlv(
      0x30,
      tlv(0x04, new Uint8Array(8).fill(salt)),
      integer(iterations),
      tlv(0x30, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x09), tlv(0x05))
    )
  );
  const aes256 = tlv(
    0x30,
    oid(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a),
    tlv(0x04, new Uint8Array(16))
  );
  const algorithm = tlv(
    0x30,
    oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d),
    tlv(0x30, pbkdf2, aes256)
  );
  return tlv(0x30, algorithm, tlv(0x04, new Uint8Array(32)));
}

/** The warnings for EC_P256's key and certificate (valid 1 Oct to 1 Dec 2026) at a time. */
async function warningsAt(iso: string): Promise<string[]> {
  const sources = [
    file('key.pem', keyPem(EC_P256.pkcs8)),
    file('cert.pem', certificatePem(EC_P256.certificate)),
  ];
  return (await parse(sources, { now: new Date(iso) })).warnings;
}

describe('parseCredentials: PEM', () => {
  it('reads a PKCS #8 key and its certificate from separate files', async () => {
    const parsed = await parse([
      file('key.pem', keyPem(RSA_2048.pkcs8)),
      file('cert.pem', certificatePem(RSA_2048.certificate)),
    ]);
    expect(parsed.keyType).toBe('RSA');
    expect(parsed.keyBits).toBe(2048);
    expect(parsed.curve).toBeUndefined();
    expect(parsed.certificate).toEqual(RSA_2048.info);
    expect(parsed.signingKey).toEqual({
      pkcs8: compact(RSA_2048.pkcs8),
      algorithm: 'RS256',
      x5t: hexToBase64Url(RSA_2048.info.sha1Thumbprint),
      x5tS256: hexToBase64Url(RSA_2048.info.sha256Thumbprint),
    });
    expect(parsed.warnings).toEqual([]);
  });

  it('reads several blocks in one text, with Windows line endings and stray whitespace', async () => {
    const bundle = [
      'Bag Attributes',
      '    localKeyID: 01 02 03',
      'subject=CN=picklist-rsa',
      certificatePem(CA.certificate),
      pem('ENCRYPTED PRIVATE KEY', RSA_2048.encrypted)
        .split('\n')
        .map((line, index) => (index % 3 === 1 ? `  ${line}\t ` : line))
        .join('\n'),
      certificatePem(RSA_2048.certificate),
    ]
      .join('\n')
      .replaceAll('\n', '\r\n');
    const parsed = await parse([file('bundle.pem', bundle)], { password: PASSWORD });
    expect(parsed.signingKey.pkcs8).toBe(compact(RSA_2048.pkcs8));
    // The CA certificate doesn't belong to the key, so the other one is used.
    expect(parsed.certificate).toEqual(RSA_2048.info);
  });

  it('rewrites PKCS #1 and SEC1 keys as the PKCS #8 OpenSSL writes', async () => {
    const rsa = await parse([file('rsa.pem', pem('RSA PRIVATE KEY', RSA_2048.pkcs1))]);
    expect(rsa.signingKey.pkcs8).toBe(compact(RSA_2048.pkcs8));
    expect(rsa.certificate).toBeNull();
    // OpenSSL writes EC PARAMETERS ahead of the key; it isn't needed.
    const ecText = `${pem('EC PARAMETERS', 'BggqhkjOPQMBBw==')}${pem('EC PRIVATE KEY', EC_P256.sec1)}`;
    const ec = await parse([file('ec.pem', ecText)]);
    expect(ec.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
    expect(ec).toMatchObject({ keyType: 'EC', keyBits: 256, curve: 'P-256' });
    expect(ec.signingKey.algorithm).toBe('ES256');
  });

  it('adds the public key to EC keys saved without it', async () => {
    const parsed = await parse([file('ec.pem', pem('EC PRIVATE KEY', EC_P256.sec1NoPublicKey))]);
    expect(parsed.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
  });

  it('decrypts PBES2 and PKCS #12 encrypted keys', async () => {
    for (const [name, base64] of Object.entries(EC_P256.encrypted)) {
      if (name === 'scrypt') {
        continue;
      }
      const parsed = await parse([file(`${name}.pem`, pem('ENCRYPTED PRIVATE KEY', base64))], {
        password: PASSWORD,
      });
      expect(parsed.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
    }
  });

  it('decrypts the same encrypted key only once, however often it’s pasted', async () => {
    const block = pem('ENCRYPTED PRIVATE KEY', EC_P256.encrypted.sha512Aes256);
    const counting = countingSubtle();
    const parsed = await parse([file('keys.pem', `${block}\n${block}\n${block}`)], {
      password: PASSWORD,
      subtle: counting.subtle,
    });
    expect(parsed.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
    expect(counting.derivations()).toBe(1);
  });

  it('refuses keys that ask for too much password work in all, before deriving any', async () => {
    expect(CREDENTIAL_LIMITS.maxPasswordIterations).toBe(20_000_000);
    // Three different keys at 9 million iterations each: 27 million in all.
    const blocks = [1, 2, 3].map((salt) =>
      pem('ENCRYPTED PRIVATE KEY', toBase64(pbes2Key(9_000_000, salt)))
    );
    const counting = countingSubtle();
    const error = await failure(
      parse([file('keys.pem', blocks.join('\n'))], { password: PASSWORD, subtle: counting.subtle })
    );
    expect(error.message).toBe(
      '“keys.pem” has more password-protected keys than can be read at once. Choose only the key you need.'
    );
    expect(counting.derivations()).toBe(0);
  });

  it('reports a missing or wrong password', async () => {
    const encrypted = file('key.pem', pem('ENCRYPTED PRIVATE KEY', RSA_2048.encrypted));
    expect((await failure(parse([encrypted]))).message).toBe(
      '“key.pem” is protected by a password. Enter it and try again.'
    );
    expect((await failure(parse([encrypted], { password: 'wrong' }))).message).toBe(
      'The password for “key.pem” is wrong.'
    );
    const legacy = file('old.pem', pem('ENCRYPTED PRIVATE KEY', EC_P256.encrypted.pkcs12TripleDes));
    expect((await failure(parse([legacy], { password: 'wrong' }))).message).toBe(
      'The password for “old.pem” is wrong.'
    );
  });

  it('refuses OpenSSL’s traditional encryption with the command to convert it', async () => {
    const { headers, body } = EC_P256.legacyPem;
    const error = await failure(
      parse([file('key.pem', pem('EC PRIVATE KEY', body, headers))], { password: PASSWORD })
    );
    expect(error.message).toBe(
      '“key.pem” uses an old encryption format. Convert it to PKCS #8 with: openssl pkcs8 -topk8 -in key.pem -out key-pkcs8.pem'
    );
  });

  it('refuses encryption it can’t do, with the command to convert it', async () => {
    const scrypt = file('key.pem', pem('ENCRYPTED PRIVATE KEY', EC_P256.encrypted.scrypt));
    expect((await failure(parse([scrypt], { password: PASSWORD }))).message).toBe(
      '“key.pem” is encrypted with scrypt, which isn’t supported. Convert it with: openssl pkcs8 -topk8 -v2 aes-256-cbc -in key.pem -out key-pkcs8.pem'
    );
    // Chrome and Edge have no AES-192 in WebCrypto.
    const noAes192 = refusingImports(
      (format, data, algorithm) =>
        format === 'raw' && algorithm === 'AES-CBC' && byteLength(data) === 24
    );
    const aes192 = file('key.pem', pem('ENCRYPTED PRIVATE KEY', EC_P256.encrypted.sha384Aes192));
    expect((await failure(parse([aes192], { password: PASSWORD, subtle: noAes192 }))).message).toBe(
      '“key.pem” is encrypted with AES-192, which this browser can’t decrypt. Convert it with: openssl pkcs8 -topk8 -v2 aes-256-cbc -in key.pem -out key-pkcs8.pem'
    );
  });

  it('reads keys pasted on one line, copied out of JSON, or saved as UTF-16', async () => {
    const oneLine = await parse([file('pasted', keyPem(EC_P256.pkcs8).replaceAll('\n', ' '))]);
    expect(oneLine.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
    const { headers, body } = EC_P256.legacyPem;
    const legacyOneLine = pem('EC PRIVATE KEY', body, headers).replaceAll('\n', ' ');
    expect((await failure(parse([file('pasted', legacyOneLine)]))).message).toMatch(
      /^“pasted” uses an old encryption format\./
    );
    const json = JSON.stringify({ private_key: keyPem(EC_P256.pkcs8) });
    const escaped = json.slice(json.indexOf('-----'), json.lastIndexOf('-----') + 5);
    expect(escaped).toContain('\\n');
    const fromJson = await parse([file('pasted', escaped)]);
    expect(fromJson.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
    const text = keyPem(EC_P256.pkcs8);
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let index = 0; index < text.length; index++) {
      utf16[2 + index * 2] = text.charCodeAt(index);
    }
    const fromUtf16 = await parse([file('key.pem', utf16)]);
    expect(fromUtf16.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
  });
});

describe('parseCredentials: DER', () => {
  it('reads DER certificates and keys, and base64 without PEM lines', async () => {
    const parsed = await parse([
      file('key.der', fromBase64(EC_P384.pkcs8)),
      file('cert.cer', fromBase64(EC_P384.certificate)),
    ]);
    expect(parsed).toMatchObject({ keyType: 'EC', keyBits: 384, curve: 'P-384' });
    expect(parsed.signingKey.algorithm).toBe('ES384');
    expect(parsed.certificate).toEqual(EC_P384.info);
    const pasted = await parse([
      file('Pasted key', compact(EC_P384.pkcs8)),
      file('Pasted certificate', `\n  ${EC_P384.certificate}  \n`),
    ]);
    expect(pasted.certificate).toEqual(EC_P384.info);
  });

  it('reads PKCS #1, SEC1 and encrypted PKCS #8 DER', async () => {
    const rsa = await parse([file('rsa.key', fromBase64(RSA_2048.pkcs1))]);
    expect(rsa.signingKey.pkcs8).toBe(compact(RSA_2048.pkcs8));
    const ec = await parse([file('ec.key', fromBase64(EC_P256.sec1))]);
    expect(ec.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
    const encrypted = await parse([file('key.p8', fromBase64(RSA_2048.encrypted))], {
      password: PASSWORD,
    });
    expect(encrypted.signingKey.pkcs8).toBe(compact(RSA_2048.pkcs8));
  });

  it('reads RSA 3072 and P-521 keys', async () => {
    const rsa = await parse([
      file('key.der', fromBase64(RSA_3072.pkcs8)),
      file('cert.der', fromBase64(RSA_3072.certificate)),
    ]);
    expect(rsa.keyBits).toBe(3072);
    // A GeneralizedTime end date and a serial number with its high bit set.
    expect(rsa.certificate).toEqual(RSA_3072.info);
    const ec = await parse([file('p521.der', fromBase64(EC_P521.pkcs8))]);
    expect(ec).toMatchObject({ keyType: 'EC', keyBits: 521, curve: 'P-521' });
    expect(ec.signingKey.algorithm).toBe('ES512');
  });
});

describe('parseCredentials: PKCS #12', () => {
  it('reads files with OpenSSL 3 defaults, picking the certificate of the key', async () => {
    const parsed = await parse([pfx(PFX.modern)], { password: PASSWORD });
    expect(parsed.signingKey.pkcs8).toBe(compact(RSA_2048.pkcs8));
    expect(parsed.certificate).toEqual(RSA_2048.info);
  });

  it('reads Triple DES, RC2 and unencrypted files', async () => {
    const tripleDes = await parse([pfx(PFX.tripleDes)], { password: PASSWORD });
    expect(tripleDes.signingKey.pkcs8).toBe(compact(RSA_2048.pkcs8));
    expect(tripleDes.certificate).toEqual(RSA_2048.info);
    for (const base64 of [PFX.legacy, PFX.rc2, PFX.unencrypted]) {
      const parsed = await parse([pfx(base64)], { password: PASSWORD });
      expect(parsed.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
      expect(parsed.certificate).toEqual(EC_P256.info);
    }
  });

  // SHA-384 and SHA-512 MACs still take one WebCrypto digest per KDF round, 2,048 rounds each.
  it(
    'checks SHA-384, SHA-512 and PBMAC1 MACs, and reads files without a MAC',
    { timeout: 15_000 },
    async () => {
      for (const base64 of [PFX.sha384Mac, PFX.sha512Mac, PFX.pbmac1, PFX.noMac]) {
        const parsed = await parse([pfx(base64)], { password: PASSWORD });
        expect(parsed.certificate).toEqual(EC_P256.info);
      }
    }
  );

  it('reads a file with an empty password, given or not', async () => {
    for (const options of [{}, { password: '' }]) {
      const parsed = await parse([pfx(PFX.emptyPassword)], options);
      expect(parsed.signingKey.pkcs8).toBe(compact(EC_P384.pkcs8));
      expect(parsed.certificate).toEqual(EC_P384.info);
    }
  });

  it('reports a missing or wrong password', async () => {
    for (const base64 of [PFX.modern, PFX.legacy, PFX.pbmac1, PFX.noMac]) {
      expect((await failure(parse([pfx(base64)]))).message).toBe(
        '“cert.pfx” is protected by a password. Enter it and try again.'
      );
      expect((await failure(parse([pfx(base64)], { password: 'wrong' }))).message).toBe(
        'The password for “cert.pfx” is wrong.'
      );
    }
  });

  it('takes the certificate from a .cer next to a .pfx without one', async () => {
    const parsed = await parse(
      [pfx(PFX.unencrypted), file('extra.cer', fromBase64(OTHER_P256.certificate))],
      { password: PASSWORD }
    );
    expect(parsed.certificate).toEqual(EC_P256.info);
  });
});

describe('parseCredentials: the key and its certificate', () => {
  it('refuses a certificate that doesn’t belong to the key', async () => {
    const ec = await failure(
      parse([
        file('key.pem', keyPem(EC_P256.pkcs8)),
        file('cert.pem', certificatePem(OTHER_P256.certificate)),
      ])
    );
    expect(ec.message).toBe('The certificate doesn’t match the private key.');
    const rsa = await failure(
      parse([
        file('key.pem', keyPem(RSA_2048.pkcs8)),
        file('certs.pem', certificatePem(RSA_3072.certificate) + certificatePem(CA.certificate)),
      ])
    );
    expect(rsa.message).toBe('None of the certificates matches the private key.');
  });

  it('needs exactly one private key', async () => {
    expect(
      (await failure(parse([file('cert.pem', certificatePem(RSA_2048.certificate))]))).message
    ).toBe(
      'There’s a certificate but no private key. Add the private key, or a .pfx file that includes it.'
    );
    const { publicKey } = await parseCertificate(fromBase64(EC_P256.certificate), subtle);
    const publicPem = file('public.pem', pem('PUBLIC KEY', toBase64(publicKey.spki)));
    expect((await failure(parse([publicPem]))).message).toBe(
      'That’s a public key. Add the private key that goes with it.'
    );
    const two = await failure(
      parse([file('a.pem', keyPem(EC_P256.pkcs8)), file('b.pem', keyPem(EC_P384.pkcs8))])
    );
    expect(two.message).toBe(
      'Found 2 different private keys. Use only the one this configuration signs with.'
    );
    // The same key twice is one key.
    const same = await parse(
      [
        file('a.pem', keyPem(EC_P256.pkcs8)),
        file('b.pem', pem('EC PRIVATE KEY', EC_P256.sec1NoPublicKey)),
        file('c.pfx', fromBase64(PFX.unencrypted)),
      ],
      { password: PASSWORD }
    );
    expect(same.certificate).toEqual(EC_P256.info);
  });

  it('refuses small RSA keys, other curves and other key types', async () => {
    expect((await failure(parse([file('small.pem', keyPem(RSA_1024.pkcs8))]))).message).toBe(
      'The RSA key in “small.pem” is 1024 bits. Use one of at least 2048 bits.'
    );
    expect((await failure(parse([file('k1.pem', keyPem(SECP256K1.pkcs8))]))).message).toBe(
      'The key in “k1.pem” is on secp256k1, which isn’t supported. Use an RSA key of 2048 bits or more, or an EC key on P-256, P-384 or P-521.'
    );
    expect((await failure(parse([file('ed.pem', keyPem(ED25519.pkcs8))]))).message).toBe(
      'The key in “ed.pem” is Ed25519, which isn’t supported. Use an RSA key of 2048 bits or more, or an EC key on P-256, P-384 or P-521.'
    );
    expect(
      (await failure(parse([file('dsa.pem', pem('DSA PRIVATE KEY', 'MAA='))]))).message
    ).toMatch(/^The key in “dsa\.pem” is DSA, which isn’t supported\./);
    expect(
      (await failure(parse([file('id_rsa', pem('OPENSSH PRIVATE KEY', 'b3BlbnNzaA=='))]))).message
    ).toBe(
      '“id_rsa” is an OpenSSH key. Convert a copy to PKCS #8 with: ssh-keygen -p -m PKCS8 -f key-copy'
    );
  });

  it('uses the chosen algorithm when the key allows it, and the key ID', async () => {
    const rsa = await parse([file('key.pem', keyPem(RSA_2048.pkcs8))], {
      algorithm: 'PS384',
      keyId: '  key-2026  ',
    });
    expect(rsa.signingKey).toEqual({
      pkcs8: compact(RSA_2048.pkcs8),
      algorithm: 'PS384',
      kid: 'key-2026',
    });
    const ec = await parse([file('key.pem', keyPem(EC_P256.pkcs8))], { algorithm: 'RS256' });
    expect(ec.signingKey.algorithm).toBe('ES256');
    expect(
      (await failure(parse([file('key.pem', keyPem(EC_P256.pkcs8))], { keyId: 'a\nb' }))).message
    ).toBe('The key ID can’t contain line breaks or other control characters.');
    expect(
      (await failure(parse([file('key.pem', keyPem(EC_P256.pkcs8))], { keyId: 'k'.repeat(401) })))
        .message
    ).toBe('The key ID can have 400 characters at most.');
  });

  it('warns about certificates that expire soon, have expired or aren’t valid yet', async () => {
    expect(await warningsAt('2026-10-22T12:00:00Z')).toEqual([]);
    expect(await warningsAt('2026-11-15T00:00:00Z')).toEqual([
      'The certificate expires on 1 Dec 2026 (in 16 days).',
    ]);
    expect(await warningsAt('2026-11-29T12:00:00Z')).toEqual([
      'The certificate expires on 1 Dec 2026 (in 1 day).',
    ]);
    expect(await warningsAt('2026-11-30T12:00:00Z')).toEqual([
      'The certificate expires on 1 Dec 2026 (in less than a day).',
    ]);
    expect(await warningsAt('2026-12-02T00:00:00Z')).toEqual([
      'The certificate expired on 1 Dec 2026.',
    ]);
    expect(await warningsAt('2026-09-30T00:00:00Z')).toEqual([
      'The certificate isn’t valid until 1 Oct 2026.',
    ]);
  });

  it('refuses a key that imports but doesn’t sign', async () => {
    const broken = new Proxy(subtle, {
      get(target, property) {
        if (property === 'sign') {
          return () => Promise.reject(new DOMException('Operation failed', 'OperationError'));
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const error = await failure(
      parse([file('key.pem', keyPem(RSA_2048.pkcs8))], { subtle: broken })
    );
    expect(error.message).toBe('The private key in “key.pem” can’t be used. It may be damaged.');
  });

  it('falls back to the certificate’s public key where the browser needs it in the key', async () => {
    // Like Safari: an EC PKCS #8 key without its public key (67 bytes for P-256) doesn't import.
    const strict = refusingImports((format, data) => format === 'pkcs8' && byteLength(data) < 100);
    const keyOnly = file('key.pem', pem('EC PRIVATE KEY', EC_P256.sec1NoPublicKey));
    expect((await failure(parse([keyOnly], { subtle: strict }))).message).toBe(
      'The private key in “key.pem” can’t be used. It may be damaged.'
    );
    const parsed = await parse(
      [
        keyOnly,
        file('other.pem', certificatePem(OTHER_P256.certificate)),
        file('cert.pem', certificatePem(EC_P256.certificate)),
      ],
      { subtle: strict }
    );
    expect(parsed.signingKey.pkcs8).toBe(compact(EC_P256.pkcs8));
    expect(parsed.certificate).toEqual(EC_P256.info);
  });

  it('produces keys whose JWS signatures verify with the certificate', async () => {
    // [key, certificate, algorithm, signature length]: ECDSA signatures are r and s side by
    // side, which is the JWS format.
    const cases: Array<[string, string, JwsAlgorithm, number]> = [
      [RSA_2048.pkcs8, RSA_2048.certificate, 'RS256', 256],
      [RSA_2048.pkcs8, RSA_2048.certificate, 'PS256', 256],
      [RSA_3072.pkcs8, RSA_3072.certificate, 'RS512', 384],
      [RSA_3072.pkcs8, RSA_3072.certificate, 'PS512', 384],
      [EC_P256.pkcs8, EC_P256.certificate, 'ES256', 64],
      [EC_P384.pkcs8, EC_P384.certificate, 'ES384', 96],
    ];
    for (const [key, certificate, algorithm, length] of cases) {
      const parsed = await parse(
        [file('key.pem', keyPem(key)), file('cert.pem', certificatePem(certificate))],
        { algorithm }
      );
      expect(parsed.signingKey.algorithm).toBe(algorithm);
      const { signature, verified } = await signJws(parsed.signingKey, fromBase64(certificate));
      expect(signature).toHaveLength(length);
      expect(verified).toBe(true);
      // The x5t header is the certificate's SHA-1 thumbprint.
      const sha1 = await subtle.digest('SHA-1', fromBase64(certificate));
      expect(parsed.signingKey.x5t).toBe(toBase64Url(new Uint8Array(sha1)));
    }
    // A P-521 key alone signs ES512.
    const p521 = await parse([file('key.pem', keyPem(EC_P521.pkcs8))]);
    const key = await subtle.importKey(
      'pkcs8',
      fromBase64(p521.signingKey.pkcs8),
      JWS_PARAMETERS.ES512.key,
      false,
      ['sign']
    );
    const signature = await subtle.sign(JWS_PARAMETERS.ES512.signature, key, utf8('x.y'));
    expect(signature.byteLength).toBe(132);
  });

  it('describes the certificate in a summary that survives saving', async () => {
    const parsed = await parse([pfx(PFX.modern)], { password: PASSWORD });
    const summary = summarizeSecret(
      { kind: 'signingKey', key: parsed.signingKey },
      'https://auth.example.com',
      {},
      parsed.certificate ?? undefined
    );
    expect(parseSecretSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
  });
});

/** WebCrypto parameters for each JWS algorithm, as a client assertion is signed with them. */
const JWS_PARAMETERS: Record<
  JwsAlgorithm,
  {
    key: RsaHashedImportParams | EcKeyImportParams;
    signature: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  }
> = {
  RS256: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, signature: 'RSASSA-PKCS1-v1_5' },
  RS384: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, signature: 'RSASSA-PKCS1-v1_5' },
  RS512: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, signature: 'RSASSA-PKCS1-v1_5' },
  PS256: {
    key: { name: 'RSA-PSS', hash: 'SHA-256' },
    signature: { name: 'RSA-PSS', saltLength: 32 },
  },
  PS384: {
    key: { name: 'RSA-PSS', hash: 'SHA-384' },
    signature: { name: 'RSA-PSS', saltLength: 48 },
  },
  PS512: {
    key: { name: 'RSA-PSS', hash: 'SHA-512' },
    signature: { name: 'RSA-PSS', saltLength: 64 },
  },
  ES256: {
    key: { name: 'ECDSA', namedCurve: 'P-256' },
    signature: { name: 'ECDSA', hash: 'SHA-256' },
  },
  ES384: {
    key: { name: 'ECDSA', namedCurve: 'P-384' },
    signature: { name: 'ECDSA', hash: 'SHA-384' },
  },
  ES512: {
    key: { name: 'ECDSA', namedCurve: 'P-521' },
    signature: { name: 'ECDSA', hash: 'SHA-512' },
  },
};

/** Signs a JWS as a client assertion is signed, and checks it with the certificate's key. */
async function signJws(key: SigningKey, certificate: Bytes) {
  const parameters = JWS_PARAMETERS[key.algorithm];
  const encode = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));
  const header = encode({ alg: key.algorithm, typ: 'JWT', x5t: key.x5t });
  const payload = encode({
    iss: 'picklist',
    sub: 'picklist',
    aud: 'https://auth.example.com/token',
  });
  const input = utf8(`${header}.${payload}`);
  const privateKey = await subtle.importKey('pkcs8', fromBase64(key.pkcs8), parameters.key, false, [
    'sign',
  ]);
  const signature = new Uint8Array(await subtle.sign(parameters.signature, privateKey, input));
  const { publicKey } = await parseCertificate(certificate, subtle);
  const verifier = await subtle.importKey('spki', publicKey.spki, parameters.key, false, [
    'verify',
  ]);
  const verified = await subtle.verify(parameters.signature, verifier, signature, input);
  return { signature, verified };
}

describe('parseCredentials: limits and damaged input', () => {
  it('refuses no files, too many files, empty files and files over 1 MB', async () => {
    expect((await failure(parse([]))).message).toBe(
      'Choose a key or certificate file, or paste one.'
    );
    const many = Array.from({ length: CREDENTIAL_LIMITS.maxSources + 1 }, (_, index) =>
      file(`${index}.pem`, keyPem(EC_P256.pkcs8))
    );
    expect((await failure(parse(many))).message).toBe('Choose 10 files at most.');
    expect((await failure(parse([file('empty.pem', '')]))).message).toBe('“empty.pem” is empty.');
    const big = new Uint8Array(CREDENTIAL_LIMITS.maxFileBytes + 1).fill(0x41);
    expect((await failure(parse([file('big.pfx', big)]))).message).toBe(
      '“big.pfx” is larger than 1 MB, so it isn’t a key or certificate file.'
    );
  });

  it('refuses files that aren’t keys or certificates', async () => {
    const notKey =
      '“notes.txt” isn’t a key or certificate file. Use PEM, DER (.cer, .crt, .der, .key) or PKCS #12 (.pfx, .p12).';
    expect((await failure(parse([file('notes.txt', 'just some notes')]))).message).toBe(notKey);
    expect(
      (await failure(parse([file('notes.txt', pem('CERTIFICATE REQUEST', 'MAA='))]))).message
    ).toBe(notKey);
    // Valid DER that's neither a key nor a certificate.
    expect(
      (await failure(parse([file('notes.txt', Uint8Array.of(0x30, 0x03, 0x01, 0x01, 0xff))])))
        .message
    ).toBe(notKey);
  });

  it('reports truncated and corrupted files as damaged', async () => {
    const der = fromBase64(RSA_2048.certificate);
    for (const cut of [1, 4, 100, der.length - 1]) {
      expect((await failure(parse([file('cert.cer', der.subarray(0, cut))]))).message).toBe(
        damaged('cert.cer')
      );
    }
    const modern = fromBase64(PFX.modern);
    const truncated = file('cert.pfx', modern.subarray(0, modern.length - 10));
    expect((await failure(parse([truncated], { password: PASSWORD }))).message).toBe(
      damaged('cert.pfx')
    );
    const flipped = Uint8Array.from(fromBase64(PFX.unencrypted));
    flipped[flipped.length - 40] ^= 0xff;
    // A changed byte breaks the MAC, which looks the same as a wrong password.
    expect(
      (await failure(parse([file('cert.pfx', flipped)], { password: PASSWORD }))).message
    ).toBe('The password for “cert.pfx” is wrong.');
    const text = keyPem(EC_P256.pkcs8);
    expect((await failure(parse([file('key.pem', text.replace('M', '*'))]))).message).toBe(
      damaged('key.pem')
    );
    expect(
      (await failure(parse([file('key.pem', text.replace('END PRIVATE', 'END PUBLIC'))]))).message
    ).toBe(damaged('key.pem'));
    expect((await failure(parse([file('key.pem', text.slice(0, 80))]))).message).toBe(
      damaged('key.pem')
    );
    const garbled = keyPem(toBase64(Uint8Array.from(fromBase64(EC_P256.pkcs8)).fill(0x30, 10, 20)));
    expect((await failure(parse([file('key.pem', garbled)]))).message).toBe(damaged('key.pem'));
  });

  it('never puts the password or key material in messages', async () => {
    const secretPassword = 'Hunter2-very-secret';
    const keyStart = compact(RSA_2048.pkcs8).slice(30, 60);
    const messages: string[] = [];
    const attempts: Array<[CredentialSource[], ParseCredentialOptions]> = [
      [[file('cert.pfx', fromBase64(PFX.modern))], { password: secretPassword }],
      [
        [file('key.pem', pem('ENCRYPTED PRIVATE KEY', RSA_2048.encrypted))],
        { password: secretPassword },
      ],
      [[file('key.pem', keyPem(RSA_2048.pkcs8).slice(0, 400))], { password: secretPassword }],
      [
        [
          file('key.pem', keyPem(RSA_2048.pkcs8)),
          file('cert.pem', certificatePem(RSA_3072.certificate)),
        ],
        {},
      ],
    ];
    for (const [sources, options] of attempts) {
      messages.push((await failure(parse(sources, options))).message);
    }
    for (const message of messages) {
      expect(message).not.toContain(secretPassword);
      expect(message).not.toContain(keyStart);
    }
  });

  it('cleans up file names for messages', async () => {
    expect((await failure(parse([file(' \u0007bad\nname.pem ', '')]))).message).toBe(
      '“badname.pem” is empty.'
    );
    expect((await failure(parse([file('', '')]))).message).toBe('“Pasted text” is empty.');
  });
});

describe('allowedAlgorithms and defaultAlgorithm', () => {
  it('follow the key type and size', () => {
    expect(allowedAlgorithms('RSA', 2048)).toEqual([
      'RS256',
      'RS384',
      'RS512',
      'PS256',
      'PS384',
      'PS512',
    ]);
    expect(allowedAlgorithms('RSA', 1024)).toEqual([]);
    expect(allowedAlgorithms('EC', 'P-256')).toEqual(['ES256']);
    expect(allowedAlgorithms('EC', 384)).toEqual(['ES384']);
    expect(allowedAlgorithms('EC', 'P-521')).toEqual(['ES512']);
    expect(allowedAlgorithms('EC', 255)).toEqual([]);
    expect(defaultAlgorithm('RSA', 4096)).toBe('RS256');
    expect(defaultAlgorithm('EC', 'P-384')).toBe('ES384');
    expect(defaultAlgorithm('EC', 521)).toBe('ES512');
    expect(() => defaultAlgorithm('RSA', 1024)).toThrow(PicklistError);
  });
});
