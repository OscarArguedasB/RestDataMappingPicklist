import { describe, expect, it } from 'vitest';
import type { Bytes } from './asn1';
import {
  TAG,
  encodeElement,
  encodeOid,
  encodeSmallInteger,
  parseAsn1,
  readOctetString,
  readSequence,
  toHex,
} from './asn1';
import { EC_P256, PASSWORD, fromBase64 } from './__fixtures__/credentials';
import type { HashName } from './pbe';
import {
  PasswordError,
  UnsupportedEncryptionError,
  decryptWithPassword,
  hmac,
  passwordEncodings,
  pbkdf2,
  pkcs12Kdf,
} from './pbe';

const subtle = globalThis.crypto.subtle;

function hex(text: string): Bytes {
  return Uint8Array.from(text.match(/[0-9a-f]{2}/gi) ?? [], (pair) => parseInt(pair, 16));
}

const ascii = (text: string) => new TextEncoder().encode(text);

/** WebCrypto that counts its digest calls. */
function countingDigests() {
  const calls: string[] = [];
  const counting = new Proxy(subtle, {
    get(target, property) {
      if (property === 'digest') {
        return (algorithm: AlgorithmIdentifier, data: BufferSource) => {
          calls.push(typeof algorithm === 'string' ? algorithm : algorithm.name);
          return target.digest(algorithm, data);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { subtle: counting, calls };
}

describe('SHA-224 HMAC and PBKDF2', () => {
  it('keys HMAC and PBKDF2 like OpenSSL', async () => {
    // RFC 4231 test case 2.
    expect(
      toHex(await hmac('SHA-224', ascii('Jefe'), ascii('what do ya want for nothing?'), subtle))
    ).toBe('A30E01098BC6DBBF45690F3A7E9E6D0F8BBEA2A39E6148008FD05E44');
    // openssl kdf -kdfopt digest:SHA2-224 ... PBKDF2
    expect(toHex(await pbkdf2('SHA-224', ascii('password'), ascii('salt'), 2, 20, subtle))).toBe(
      '93200FFA96C5776D38FA10ABDF8F5BFC0054B971'
    );
    const long = await pbkdf2(
      'SHA-224',
      ascii('passwordPASSWORDpassword'),
      ascii('saltSALTsaltSALTsaltSALTsaltSALTsalt'),
      4096,
      40,
      subtle
    );
    expect(toHex(long)).toBe(
      '056C4BA438DED91FC14E0594E6F52B87E1F3690C0DC0FBC05784ED9A754CA780E6C017E80C8DE278'
    );
  });

  it('lets the page breathe during long SHA-224 derivations and refuses absurd ones', async () => {
    // It runs in TypeScript on the page's thread, so it pauses like the PKCS #12 KDF does.
    let ran = false;
    setTimeout(() => {
      ran = true;
    }, 0);
    await pbkdf2('SHA-224', ascii('password'), ascii('salt'), 5000, 28, subtle);
    expect(ran).toBe(true);
    // A million rounds took about ten seconds per key, with the page frozen.
    await expect(
      pbkdf2('SHA-224', ascii('password'), ascii('salt'), 1_000_000, 28, subtle)
    ).rejects.toBeInstanceOf(UnsupportedEncryptionError);
    // WebCrypto's PBKDF2 runs off the page's thread and keeps its higher limit.
    await expect(
      pbkdf2('SHA-256', ascii('password'), ascii('salt'), 200_000, 32, subtle)
    ).resolves.toHaveLength(32);
  });
});

describe('pkcs12Kdf', () => {
  const salt = hex('0a58cf64530d823f');

  it('matches OpenSSL’s PKCS12KDF for each purpose and hash', async () => {
    // openssl kdf -kdfopt hexpass:<"test" as BMPString> -kdfopt hexsalt:0a58cf64530d823f
    //   -kdfopt iter:5 -kdfopt id:<id> -keylen <length> PKCS12KDF
    const password = passwordEncodings('test').bmp[0];
    expect(toHex(password)).toBe('00740065007300740000');
    const vectors: Array<[HashName, number, number, string]> = [
      ['SHA-1', 1, 24, 'c3506f2f89cd72c5cd03001848fa3eb8c2688915c34f23c5'],
      ['SHA-1', 2, 8, 'c7719970882ef599'],
      ['SHA-1', 3, 20, '0b6e7ccc97cafd58bc807cddad8d46dc73362525'],
      ['SHA-256', 3, 32, 'e1220691f884ce2626ee80d9f9ac7978cfaa7f193be62021d3fee5fc57aedbbe'],
      [
        'SHA-512',
        1,
        70,
        '0186c7bcb834a00962de7938a585a831ca45bdd299fa6f17d92fac6d71d2961e574f5430428efaa623ba03ffd6f7796c04355bc714345566bbcb1821e9072cdf4172bd41081c',
      ],
    ];
    for (const [hash, id, length, expected] of vectors) {
      const output = await pkcs12Kdf(hash, password, salt, 5, id, length, subtle);
      expect(toHex(output)).toBe(expected.toUpperCase());
    }
  });

  it('handles an empty password and inputs longer than a block', async () => {
    // The two zero bytes of an empty BMPString.
    const empty = passwordEncodings('').bmp[1];
    const vectors: Array<[HashName, number, number, string]> = [
      ['SHA-1', 1, 24, 'e98a01263a6bf0c65bb8c58786a59f6d86b05a0be704dc90'],
      [
        'SHA-384',
        3,
        48,
        'd83e0a74147d0c8d964fe3540eeb3291a561f636cfdf69254305e76450558063d73d445127a7afdf0f5d3cce64e75c7a',
      ],
    ];
    for (const [hash, id, length, expected] of vectors) {
      expect(toHex(await pkcs12Kdf(hash, empty, salt, 5, id, length, subtle))).toBe(
        expected.toUpperCase()
      );
    }
    const longPassword = passwordEncodings('p'.repeat(70)).bmp[0];
    const longSalt = Uint8Array.from({ length: 20 }, (_, index) => index);
    expect(toHex(await pkcs12Kdf('SHA-1', longPassword, longSalt, 2, 1, 24, subtle))).toBe(
      'D5A98B28CBF565030DC713198CC0D2C85842409271C88AD9'
    );
  });

  it('matches OpenSSL at the iteration counts real files use', async () => {
    // As above, with -kdfopt iter:2048 (OpenSSL and Windows) or iter:10000 (Java).
    const password = passwordEncodings('test').bmp[0];
    const vectors: Array<[HashName, number, number, string]> = [
      ['SHA-1', 1, 24, 'f17346c8c8af3fb015eb668915977c553e9e945fc210140d'],
      ['SHA-1', 2, 8, '8ab629722152845d'],
      ['SHA-1', 3, 20, 'c0ce5d553e1bed8bc6839ce3e154d9cb082f1cc1'],
      ['SHA-224', 3, 28, '51af76fd2a49ba68c7aa20545fd30dd3116dd8cf24756e0456cf399d'],
      ['SHA-256', 1, 32, '274e947744480bde0c3d3422741cd2ca526434153125895d90ccb860e5cf2221'],
      ['SHA-256', 3, 32, '31e064774d488cf65fc99c26c505976c7c3d86119df72413fce3ffaaae5de454'],
    ];
    for (const [hash, id, length, expected] of vectors) {
      const output = await pkcs12Kdf(hash, password, salt, 2048, id, length, subtle);
      expect(`${hash} ${id} ${toHex(output)}`).toBe(`${hash} ${id} ${expected.toUpperCase()}`);
    }
    const longSalt = Uint8Array.from({ length: 20 }, (_, index) => index);
    expect(toHex(await pkcs12Kdf('SHA-1', password, longSalt, 10_000, 1, 40, subtle))).toBe(
      '30BBC664126E79EE56BA2CDAA030C9B1FDFF19FA4A89852F844863842BA0EDE330437F93471D7585'
    );
  });

  it('runs SHA-1 and SHA-256 rounds in TypeScript, and SHA-512 rounds in WebCrypto', async () => {
    // One WebCrypto call per round made legacy .pfx files slow to open.
    const password = passwordEncodings('test').bmp[0];
    const counting = countingDigests();
    await pkcs12Kdf('SHA-1', password, salt, 2048, 1, 24, counting.subtle);
    await pkcs12Kdf('SHA-256', password, salt, 2048, 3, 32, counting.subtle);
    expect(counting.calls).toEqual([]);
    await pkcs12Kdf('SHA-512', password, salt, 5, 3, 64, counting.subtle);
    expect(counting.calls).toEqual(['SHA-512', 'SHA-512', 'SHA-512', 'SHA-512', 'SHA-512']);
  });

  it('lets other work run during very long derivations only', async () => {
    const password = passwordEncodings('test').bmp[0];
    const timerRan = async (iterations: number) => {
      let ran = false;
      setTimeout(() => {
        ran = true;
      }, 0);
      await pkcs12Kdf('SHA-1', password, salt, iterations, 3, 20, subtle);
      return ran;
    };
    // Real files are hashed in one go; the maximum pauses so the page can repaint.
    expect(await timerRan(2048)).toBe(false);
    expect(await timerRan(100_000)).toBe(true);
  });

  it('refuses absurd iteration counts', async () => {
    await expect(pkcs12Kdf('SHA-1', new Uint8Array(2), salt, 0, 1, 8, subtle)).rejects.toThrow(
      /iteration/
    );
    await expect(
      pkcs12Kdf('SHA-1', new Uint8Array(2), salt, 10_000_000, 1, 8, subtle)
    ).rejects.toBeInstanceOf(UnsupportedEncryptionError);
  });
});

describe('passwordEncodings', () => {
  it('encodes UTF-8 for PBES2 and BMPString for the PKCS #12 KDF', () => {
    const encodings = passwordEncodings('pä😀');
    expect(toHex(encodings.utf8)).toBe('70C3A4F09F9880');
    expect(encodings.bmp.map(toHex)).toEqual(['007000E4D83DDE000000']);
    // An empty password is tried with no bytes at all, then with the terminator alone.
    expect(passwordEncodings('').bmp.map(toHex)).toEqual(['', '0000']);
  });
});

/** The algorithm and the ciphertext of an EncryptedPrivateKeyInfo. */
function parts(base64: string) {
  const [algorithm, data] = readSequence(parseAsn1(fromBase64(base64)));
  return { algorithm, data: readOctetString(data) };
}

describe('decryptWithPassword', () => {
  it('decrypts PBES2 with each PRF and cipher OpenSSL offers', async () => {
    const passwords = passwordEncodings(PASSWORD);
    for (const [name, base64] of Object.entries(EC_P256.encrypted)) {
      if (name === 'scrypt') {
        continue;
      }
      const { algorithm, data } = parts(base64);
      const plain = await decryptWithPassword(algorithm, data, passwords, subtle);
      expect(plain).toEqual(fromBase64(EC_P256.pkcs8));
    }
  });

  it('reports wrong passwords and unsupported methods', async () => {
    const { algorithm, data } = parts(EC_P256.encrypted.sha1Aes256);
    await expect(
      decryptWithPassword(algorithm, data, passwordEncodings('nope'), subtle)
    ).rejects.toBeInstanceOf(PasswordError);
    const legacy = parts(EC_P256.encrypted.pkcs12TripleDes);
    await expect(
      decryptWithPassword(legacy.algorithm, legacy.data, passwordEncodings('nope'), subtle)
    ).rejects.toBeInstanceOf(PasswordError);
    const scrypt = parts(EC_P256.encrypted.scrypt);
    await expect(
      decryptWithPassword(scrypt.algorithm, scrypt.data, passwordEncodings(PASSWORD), subtle)
    ).rejects.toThrow(/scrypt/);
    const rc4 = parseAsn1(
      encodeElement(
        TAG.sequence,
        encodeOid('1.2.840.113549.1.12.1.1'),
        encodeElement(
          TAG.sequence,
          encodeElement(TAG.octetString, new Uint8Array(8)),
          encodeSmallInteger(1)
        )
      )
    );
    const rc4Attempt = decryptWithPassword(
      rc4,
      new Uint8Array(16),
      passwordEncodings(PASSWORD),
      subtle
    );
    await expect(rc4Attempt).rejects.toBeInstanceOf(UnsupportedEncryptionError);
    await expect(rc4Attempt).rejects.toMatchObject({ algorithm: '128-bit RC4' });
  });
});
