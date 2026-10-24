import type { Bytes } from './asn1';

// SHA-1, SHA-224 and SHA-256 written out (FIPS 180-4), for the two places WebCrypto can't serve:
// it has no SHA-224, which OpenSSL can use for PBKDF2, and its digests are asynchronous. The
// PKCS #12 KDF hashes its own output thousands of times in a row, and a WebCrypto round trip per
// round made opening a legacy .pfx file about 50 times slower than hashing here. Everything else
// still hashes with WebCrypto.

/** One hash function: the whole input in, the digest out. */
export type HashFunction = (data: Uint8Array) => Bytes;

// The message schedule, reused by every call: the functions are synchronous, so no two calls
// can share it at the same time.
const schedule = new Int32Array(80);

/** The message padded to whole 64-byte blocks, ending with its length in bits (big-endian). */
function pad(data: Uint8Array): Bytes {
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const bits = data.length * 8;
  writeWord(padded, padded.length - 8, Math.floor(bits / 2 ** 32));
  writeWord(padded, padded.length - 4, bits >>> 0);
  return padded;
}

function readWord(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
  );
}

/** Typed arrays keep the low 8 bits of what's stored, so each byte needs no mask. */
function writeWord(bytes: Uint8Array, offset: number, word: number): void {
  bytes[offset] = word >>> 24;
  bytes[offset + 1] = word >>> 16;
  bytes[offset + 2] = word >>> 8;
  bytes[offset + 3] = word;
}

function digestBytes(state: Int32Array, words: number): Bytes {
  const output = new Uint8Array(words * 4);
  for (let index = 0; index < words; index++) {
    writeWord(output, index * 4, state[index]);
  }
  return output;
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

// ---------------------------------------------------------------------------------------------
// SHA-1

const SHA1_INITIAL = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];

export function sha1(data: Uint8Array): Bytes {
  const padded = pad(data);
  const state = Int32Array.from(SHA1_INITIAL);
  const words = schedule;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = readWord(padded, offset + index * 4);
    }
    for (let index = 16; index < 80; index++) {
      words[index] = rotateLeft(
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
        1
      );
    }
    let [a, b, c, d, e] = state;
    for (let index = 0; index < 80; index++) {
      let mix: number;
      let constant: number;
      if (index < 20) {
        mix = (b & c) | (~b & d);
        constant = 0x5a827999;
      } else if (index < 40) {
        mix = b ^ c ^ d;
        constant = 0x6ed9eba1;
      } else if (index < 60) {
        mix = (b & c) | (b & d) | (c & d);
        constant = 0x8f1bbcdc;
      } else {
        mix = b ^ c ^ d;
        constant = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + mix + e + constant + words[index]) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }
    // Int32Array keeps each sum modulo 2^32.
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
  }
  return digestBytes(state, 5);
}

// ---------------------------------------------------------------------------------------------
// SHA-256 and SHA-224 (SHA-256 with other starting values, cut to 28 bytes)

const SHA256_CONSTANTS = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA224_INITIAL = [
  0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
];

function sha256State(data: Uint8Array, initial: readonly number[]): Int32Array {
  const padded = pad(data);
  const state = Int32Array.from(initial);
  const words = schedule;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = readWord(padded, offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const early = words[index - 15];
      const late = words[index - 2];
      const s0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3);
      const s1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_CONSTANTS[index] + words[index]) | 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + sum0 + majority) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }
  return state;
}

export function sha256(data: Uint8Array): Bytes {
  return digestBytes(sha256State(data, SHA256_INITIAL), 8);
}

export function sha224(data: Uint8Array): Bytes {
  return digestBytes(sha256State(data, SHA224_INITIAL), 7);
}
