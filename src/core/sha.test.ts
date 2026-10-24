import { describe, expect, it } from 'vitest';
import { toHex } from './asn1';
import type { HashFunction } from './sha';
import { sha1, sha224, sha256 } from './sha';

const subtle = globalThis.crypto.subtle;

const ascii = (text: string) => new TextEncoder().encode(text);

/** Bytes (7i + 3) mod 256, the pattern the OpenSSL vectors below were made from. */
function pattern(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, index) => (index * 7 + 3) & 255);
}

const WEBCRYPTO: Array<[string, HashFunction, 'SHA-1' | 'SHA-256']> = [
  ['sha1', sha1, 'SHA-1'],
  ['sha256', sha256, 'SHA-256'],
];

describe('sha1, sha224 and sha256', () => {
  it('match the FIPS 180 examples', () => {
    // FIPS 180-2 appendices A and B (checked with openssl dgst): “abc”, the 448-bit message and
    // a million “a”s.
    const long = ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
    const million = new Uint8Array(1_000_000).fill(0x61);
    const vectors: Array<[HashFunction, Uint8Array, string]> = [
      [sha1, ascii('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d'],
      [sha1, long, '84983e441c3bd26ebaae4aa1f95129e5e54670f1'],
      [sha1, million, '34aa973cd4c4daa4f61eeb2bdbad27316534016f'],
      [sha224, ascii('abc'), '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7'],
      [sha224, long, '75388b16512776cc5dba5da1fd890150b0c6455cb4f58b1952522525'],
      [sha224, million, '20794655980c91d8bbb4c1ea97618a4bf03f42581948b2ee4ee7ad67'],
      [sha256, ascii('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      [sha256, long, '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      [sha256, million, 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
    ];
    for (const [hash, data, expected] of vectors) {
      expect(toHex(hash(data))).toBe(expected.toUpperCase());
    }
  });

  it('match WebCrypto for every length up to five blocks', async () => {
    const lengths = Array.from({ length: 321 }, (_, length) => length);
    for (const [name, hash, algorithm] of WEBCRYPTO) {
      const expected = await Promise.all(
        lengths.map(async (length) => {
          const digest = new Uint8Array(await subtle.digest(algorithm, pattern(length)));
          return `${name}(${length}) ${toHex(digest)}`;
        })
      );
      expect(lengths.map((length) => `${name}(${length}) ${toHex(hash(pattern(length)))}`)).toEqual(
        expected
      );
    }
  });

  it('match WebCrypto when hashing their own output over and over, as the PKCS #12 KDF does', async () => {
    for (const [, hash, algorithm] of WEBCRYPTO) {
      let ours: Uint8Array = pattern(64 + 20);
      let theirs: Uint8Array<ArrayBuffer> = pattern(64 + 20);
      for (let round = 0; round < 100; round++) {
        ours = hash(ours);
        theirs = new Uint8Array(await subtle.digest(algorithm, theirs));
      }
      expect(toHex(ours)).toBe(toHex(theirs));
    }
  });

  it('leave their input alone', () => {
    const data = pattern(100);
    sha1(data);
    sha224(data);
    sha256(data);
    expect(data).toEqual(pattern(100));
  });
});

describe('sha224', () => {
  it('matches OpenSSL across block boundaries', () => {
    // openssl dgst -sha224 of bytes (7i + 3) mod 256, for these lengths.
    const vectors: Array<[number, string]> = [
      [0, 'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f'],
      [3, '956a7e9eeefc4f6175e8cd337cd28a80f6a0a988b3fe0ed647b4a953'],
      [55, '703a7d6e61c83903b5db54ddf6dda2268211b47c90bbdac2ed306d8a'],
      [56, '850fef35478d7a94a417713dbded4a39c18be2b40e6f20f47066d306'],
      [63, '246a939bfdd1eedb1ad51b53a250d197b5752aab09580b7f1df50df7'],
      [64, 'e480c1c21ffd3f109fc0cde0daf967c748932b64f8e259d98db17420'],
      [65, '574507bf89b5d3a0b5dcf4a684a645f27f058f3b11fde279d5b0e462'],
      [119, '6c9c99e7d1090cb995200ccc9fc757a4383d3a1004cc36bc266c7947'],
      [120, 'd733ebb80612c4699bfca3061aab0cd9e138ef73aecf1d0f23e75340'],
      [1000, '23729dacbd480285c5c68439e2fe22ca5611a63cd6c14d2ec5ae2c85'],
    ];
    for (const [length, expected] of vectors) {
      expect(toHex(sha224(pattern(length)))).toBe(expected.toUpperCase());
    }
  });
});
