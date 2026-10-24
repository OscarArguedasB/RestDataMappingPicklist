import type { Bytes } from './asn1';

// Triple DES and RC2 in CBC mode, decryption only. WebCrypto has neither, but PKCS #12 files
// exported by Windows and by older OpenSSL still protect keys and certificates with them
// (pbeWithSHAAnd3-KeyTripleDES-CBC, pbeWithSHAAnd40BitRC2-CBC). Written for clarity rather than
// speed: they only ever decrypt one small file. The tables are FIPS 46-3 and RFC 2268 as
// published; bits are numbered from 1 at the most significant end, as there.

/** CBC decryption with an 8-byte block cipher; the caller checks and removes the padding. */
function cbcDecrypt(iv: Bytes, data: Bytes, decryptBlock: (block: Bytes) => Bytes): Bytes {
  if (iv.length !== 8 || data.length % 8 !== 0) {
    throw new RangeError('CBC needs an 8-byte IV and whole blocks.');
  }
  const output = new Uint8Array(data.length);
  let previous = iv;
  for (let offset = 0; offset < data.length; offset += 8) {
    const block = data.subarray(offset, offset + 8);
    const plain = decryptBlock(block);
    for (let index = 0; index < 8; index++) {
      output[offset + index] = plain[index] ^ previous[index];
    }
    previous = block;
  }
  return output;
}

// ---------------------------------------------------------------------------------------------
// DES (FIPS 46-3)

const INITIAL_PERMUTATION = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64,
  56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53,
  45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FINAL_PERMUTATION = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37,
  5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2,
  42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

/** Permuted choice 1: the 56 key bits that matter, as C (the first 28) and D. */
const PERMUTED_CHOICE_1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60,
  52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
  13, 5, 28, 20, 12, 4,
];

/** Permuted choice 2: a 48-bit round key from C and D. */
const PERMUTED_CHOICE_2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52,
  31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const KEY_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

/** The permutation P applied to the S-box outputs. */
const PERMUTATION = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13,
  30, 6, 22, 11, 4, 25,
];

/** S1 to S8, each as four rows of sixteen. */
const S_BOXES = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11,
    9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5,
    11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10,
    6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2,
    11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12,
    11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4,
    15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1,
    10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9,
    4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10,
    3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6,
    15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14,
    0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10,
    11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12,
    2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9,
    5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11,
    0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13,
    15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

/**
 * S-box `index` followed by P, for each 6-bit input, so the round function is eight lookups.
 * S-box `index` fills bits 4 × index + 1 to 4 × index + 4 of the 32 that P permutes.
 */
const SP_BOXES = S_BOXES.map((box, index) => {
  const table = new Uint32Array(64);
  for (let input = 0; input < 64; input++) {
    // The outer two bits pick the row, the middle four the column.
    const row = ((input & 0x20) >>> 4) | (input & 1);
    const column = (input >>> 1) & 0xf;
    const output = box[row * 16 + column] << (28 - 4 * index);
    let permuted = 0;
    for (let bit = 0; bit < 32; bit++) {
      if (output & (1 << (32 - PERMUTATION[bit]))) {
        permuted |= 1 << (31 - bit);
      }
    }
    table[input] = permuted;
  }
  return table;
});

/** A 64-bit block as its most and least significant 32 bits. */
type Block = [number, number];

function permute64([high, low]: Block, table: readonly number[]): Block {
  let outHigh = 0;
  let outLow = 0;
  for (let index = 0; index < 64; index++) {
    const source = table[index] - 1;
    const bit = source < 32 ? (high >>> (31 - source)) & 1 : (low >>> (63 - source)) & 1;
    if (index < 32) {
      outHigh |= bit << (31 - index);
    } else {
      outLow |= bit << (63 - index);
    }
  }
  return [outHigh >>> 0, outLow >>> 0];
}

/** The 16 round keys of an 8-byte DES key, each as eight 6-bit groups. */
function desRoundKeys(key: Bytes): Uint8Array[] {
  const keyBit = (position: number) =>
    (key[(position - 1) >>> 3] >>> (7 - ((position - 1) & 7))) & 1;
  const selected = PERMUTED_CHOICE_1.map(keyBit);
  let c = selected.slice(0, 28);
  let d = selected.slice(28);
  return KEY_SHIFTS.map((shift) => {
    c = [...c.slice(shift), ...c.slice(0, shift)];
    d = [...d.slice(shift), ...d.slice(0, shift)];
    const cd = [...c, ...d];
    const groups = new Uint8Array(8);
    PERMUTED_CHOICE_2.forEach((position, index) => {
      groups[Math.floor(index / 6)] |= cd[position - 1] << (5 - (index % 6));
    });
    return groups;
  });
}

/** The round function f(R, K). */
function feistel(right: number, roundKey: Uint8Array): number {
  // E repeats bits at the group edges. Rotating R right by one puts group j, bits 4j to 4j + 5
  // (bit 0 being bit 32), at a fixed shift; the last group wraps around to bit 1.
  const rotated = ((right >>> 1) | (right << 31)) >>> 0;
  let output = 0;
  for (let group = 0; group < 7; group++) {
    output |= SP_BOXES[group][((rotated >>> (26 - 4 * group)) & 0x3f) ^ roundKey[group]];
  }
  output |= SP_BOXES[7][(((rotated << 2) | (rotated >>> 30)) & 0x3f) ^ roundKey[7]];
  return output >>> 0;
}

function desBlock(block: Block, roundKeys: Uint8Array[], decrypt: boolean): Block {
  let [left, right] = permute64(block, INITIAL_PERMUTATION);
  for (let round = 0; round < 16; round++) {
    const roundKey = roundKeys[decrypt ? 15 - round : round];
    const next = (left ^ feistel(right, roundKey)) >>> 0;
    left = right;
    right = next;
  }
  // The halves are swapped back before the final permutation.
  return permute64([right, left], FINAL_PERMUTATION);
}

/**
 * Triple DES (EDE) in CBC mode. A 24-byte key is three DES keys; a 16-byte key is two, the first
 * one used again as the third.
 */
export function tripleDesCbcDecrypt(key: Bytes, iv: Bytes, data: Bytes): Bytes {
  if (key.length !== 16 && key.length !== 24) {
    throw new RangeError('Triple DES needs a 16- or 24-byte key.');
  }
  const first = desRoundKeys(key.subarray(0, 8));
  const second = desRoundKeys(key.subarray(8, 16));
  const third = key.length === 24 ? desRoundKeys(key.subarray(16, 24)) : first;
  const plain = new Uint8Array(8);
  const view = new DataView(plain.buffer);
  return cbcDecrypt(iv, data, (block) => {
    const input = new DataView(block.buffer, block.byteOffset, 8);
    // Encryption was E(K1), D(K2), E(K3); decryption undoes it in reverse.
    let state: Block = [input.getUint32(0), input.getUint32(4)];
    state = desBlock(state, third, true);
    state = desBlock(state, second, false);
    state = desBlock(state, first, true);
    view.setUint32(0, state[0]);
    view.setUint32(4, state[1]);
    return plain;
  });
}

// ---------------------------------------------------------------------------------------------
// RC2 (RFC 2268)

/** PITABLE: a permutation of 0 to 255 based on the digits of pi. */
const PI_TABLE = Uint8Array.from([
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a, 0xa0, 0xd8, 0x9d,
  0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2,
  0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3, 0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32,
  0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82,
  0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c, 0xf1, 0xdc,
  0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6, 0x26,
  0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03,
  0xf8, 0x11, 0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7,
  0x08, 0xe8, 0xea, 0xde, 0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a,
  0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e, 0x04, 0x18, 0xa4, 0xec,
  0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24, 0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39,
  0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31,
  0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9,
  0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9,
  0x0d, 0x38, 0x34, 0x1b, 0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e,
  0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c, 0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad,
]);

/** Key expansion: 64 16-bit words from the key and the effective key length in bits. */
function rc2ExpandKey(key: Bytes, effectiveBits: number): Uint16Array {
  if (key.length < 1 || key.length > 128 || effectiveBits < 1 || effectiveBits > 1024) {
    throw new RangeError('RC2 key out of range.');
  }
  const expanded = new Uint8Array(128);
  expanded.set(key);
  for (let index = key.length; index < 128; index++) {
    expanded[index] = PI_TABLE[(expanded[index - 1] + expanded[index - key.length]) & 0xff];
  }
  const effectiveBytes = (effectiveBits + 7) >>> 3;
  const mask = 0xff >>> (8 * effectiveBytes - effectiveBits);
  expanded[128 - effectiveBytes] = PI_TABLE[expanded[128 - effectiveBytes] & mask];
  for (let index = 127 - effectiveBytes; index >= 0; index--) {
    expanded[index] = PI_TABLE[expanded[index + 1] ^ expanded[index + effectiveBytes]];
  }
  const words = new Uint16Array(64);
  for (let index = 0; index < 64; index++) {
    words[index] = expanded[2 * index] | (expanded[2 * index + 1] << 8);
  }
  return words;
}

const RC2_ROTATIONS = [1, 2, 3, 5];

/** Decrypts one block in place: four little-endian 16-bit words. */
function rc2DecryptBlock(keyWords: Uint16Array, words: Uint16Array): void {
  // Uint16Array arithmetic wraps modulo 2^16, as RC2 needs.
  let next = 63;
  const mix = () => {
    for (let index = 3; index >= 0; index--) {
      const shift = RC2_ROTATIONS[index];
      words[index] = (words[index] >>> shift) | (words[index] << (16 - shift));
      words[index] -=
        keyWords[next--] +
        (words[(index + 3) & 3] & words[(index + 2) & 3]) +
        (~words[(index + 3) & 3] & words[(index + 1) & 3]);
    }
  };
  const mash = () => {
    for (let index = 3; index >= 0; index--) {
      words[index] -= keyWords[words[(index + 3) & 3] & 63];
    }
  };
  // Encryption in reverse: five mixing rounds, a mashing round, six mixing, a mashing, five mixing.
  const mixRounds = (count: number) => {
    for (let round = 0; round < count; round++) {
      mix();
    }
  };
  mixRounds(5);
  mash();
  mixRounds(6);
  mash();
  mixRounds(5);
}

/** RC2 in CBC mode, with the effective key length PKCS #12 names (40 or 128 bits). */
export function rc2CbcDecrypt(key: Bytes, effectiveBits: number, iv: Bytes, data: Bytes): Bytes {
  const keyWords = rc2ExpandKey(key, effectiveBits);
  const words = new Uint16Array(4);
  const plain = new Uint8Array(8);
  return cbcDecrypt(iv, data, (block) => {
    for (let index = 0; index < 4; index++) {
      words[index] = block[2 * index] | (block[2 * index + 1] << 8);
    }
    rc2DecryptBlock(keyWords, words);
    for (let index = 0; index < 4; index++) {
      plain[2 * index] = words[index] & 0xff;
      plain[2 * index + 1] = words[index] >>> 8;
    }
    return plain;
  });
}
