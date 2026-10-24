import { describe, expect, it } from 'vitest';
import type { Bytes } from './asn1';
import { toHex } from './asn1';
import { rc2CbcDecrypt, tripleDesCbcDecrypt } from './legacyCiphers';

function hex(text: string): Bytes {
  return Uint8Array.from(text.match(/[0-9a-f]{2}/gi) ?? [], (pair) => parseInt(pair, 16));
}

// Made with `openssl enc -<cipher> -K <key> -iv <iv> -nopad` from random keys, IVs and 24 bytes
// of random plaintext: [key, iv, plaintext, ciphertext].
const TRIPLE_DES = [
  [
    '2699195670e91fb39c23ec2fc9e1983b1181e44a5222d127',
    '4803b51fd11b0561',
    'beff41d821c00bfe03cc8e8f8c9106b9da170d2cc430d08f',
    'f7a950d6dcb95d5900a27473420bb99915a2d13df798a1e5',
  ],
  [
    '788fd80ee0e0b33bc86172d95a2f6c32f68e52f50952cb1a',
    'e2f65550bb1469d7',
    '1dea56f6f523f732a76f2f9ff14db02967740ef61411d5da',
    'ae802803d4698bd69d4567bff912469935d21702aab55aa0',
  ],
  [
    'dd48364897d2aae00fdcd570837aa291397d946ede4b3176',
    '207cf6cc1df47ef9',
    '67feb30fa910cdbf7ed5139cff537a5eae872c2dd4fd39df',
    '50fd4defc3ff1fe749d13f4ccec90886e26e0753e0b47573',
  ],
  [
    'a942ff91cd4e3ec2999e4b10e2ea1409dcc65858831be85b',
    'd759d911bc90018f',
    '11b066160904642ccda410a5f0f9ea49a63458bb0ea39b10',
    '0c597a242511f733622d8e51c759055b1035552d73c95226',
  ],
  [
    'f26c7d4e3accab9672a2683f5d5745b1dfbddb9c9bae1da9',
    '37d6159d4edc65f8',
    '8e97f446c7c7ecc775b115c64ca2486ab09278c711f6f604',
    '168c927359a445dab81db8e3f4cec718c4c6346f15b7505e',
  ],
  [
    '0b13f7d1d613f73474fb8351e1fd45c0b7fdf0a10fb1bfc3',
    '62a335d453ea97aa',
    'ab5942dfe5c8ea985571ba0307b33e9e6983cea77707aa65',
    '710db1ac10327eb67bc23a5c57dc5fb85a11fdec0fd04358',
  ],
  [
    '484d12ec7409d7afebaf9f809377f1a419c4ec3ae21323b4',
    '0ee65d0b816f066d',
    '8d10a338f68a1a860a198ae3929eb08d4643ae1bebf4ee03',
    'bcadb6c8abee3bd3d2b32edf495a2fa01ee1ffbc92e558fc',
  ],
  [
    '21eb40a47ec5c4ea17ed2552cf0914c028413de7fa3f622c',
    '6c2e6990b3ffa195',
    'c94df192e7abc5857f4fb51215b24d27c2737faff0c14b17',
    '3d74c11a267b1cbc15b28637986da57ab138cfef72294ba6',
  ],
  [
    'b5778602263d829adfedda6d3629ea380e0bd5925f98c336',
    '99e2f0a22a758e6f',
    '7a801502cb29d36529f3bda0257e0649c94712962499ab74',
    'd7b8f17204eaeec5cceda867f8bda345b96927a8512e1fae',
  ],
  [
    '397d00ee975962f60abcbfd7cadd212e6926ccc610148e40',
    'f7b91f8b4366bbb9',
    'd67d99480d1fe48f1d8dd8b8f615cf92e2d0f39f5d3d6bb8',
    '947bd711cbb3fe67288fe95c7bfeab57c9436f2082e75dd1',
  ],
  [
    '5f416eddee112950ad3301cc209ce53ae9513f7b9e369adb',
    '5c48bb22de5ca39b',
    '53c24145afef94d9ff748f699d074bcde3807f154e68c709',
    'cf28fdab64fabbed0d14f828ce5628edee2beafa74f35448',
  ],
  [
    'e04d98ca470d58f751703e6510b2e8cdb7402d8fa19da738',
    '5b3caf202ab3fbd5',
    'ea539b308fe51c3ee28845b24cf62818cc1796b37dbfd2b2',
    'c93708cbab1c51c3bc73c0c9dc82fe033ab7fa4c2aeba657',
  ],
];

// des-ede-cbc: two-key Triple DES.
const TWO_KEY_TRIPLE_DES = [
  [
    'c9db362378198d9b0dd8fa4e6f33f513',
    '20390ce1e9d1edfc',
    '017f419aa15c202c9f3ade4d31945f06495859c889fdffcc',
    '7219357dff93701b12e6c5c8e4cb7571e4c5415e3f10a3ee',
  ],
  [
    '3001aec5c345a775d4c00f7b660fe5f0',
    'f3856fa0fdc5ea9d',
    '60ce732469100e291c59460a67a24e98c01338a3d5bbc4a0',
    'd314dee006b2eee7db45ea4ab963c522b1ac3f506637ef10',
  ],
  [
    '79396b37ef532ce97000f4dfdad8987a',
    '471330e042110d8c',
    'c0dd9965e0ff58761cf1baaf22f044a611f5634936999f14',
    '6ae3189056ad4c25353fc667be30479a5397612cd8d859cd',
  ],
];

// rc2-40-cbc, rc2-64-cbc and rc2-cbc (128 bits): the effective key length equals the key's.
const RC2 = [
  [
    'e82022e7b9',
    '76e410d94d66c0f7',
    '2fc110c4034a047b7df69ceabf8b6891ea8328c0dbfee993',
    '6b3e01e39cc2c65581d54c629a92389011a002f8655081b6',
  ],
  [
    'd634838cb0',
    '2ee520fc74724f47',
    '24e89acc96e645449a4847af67ae5cdf157d1c29d3abc0cb',
    '69c7a56fad309ae65eeb7ea4ef8ba05aacbf06a025b4f21b',
  ],
  [
    '756c08712a',
    'e528a211ba2a58fc',
    '0aeb1641397d609560af5b14ebd14035e726488d440d25c7',
    '2c66c191494743c2cd1f27c3e538bd1f854f947d1b89701a',
  ],
  [
    '24d608c458',
    'f8794c5ba18bf121',
    '4fc587ef2bc88eff7a9e94e1fd10873ff76583ab484e8ba7',
    'b8a9c3daba466dc9c5c39ffc7f836095d87f31e2bd46c091',
  ],
  [
    'b3373c40f9',
    'f22d009c5f60c658',
    'b77f7fd3f0ae760398f9743b8cae4bb34cc78376acadcd25',
    '30d3d1c66490dded4d4e8771bb2add68518b3b0b3eb74034',
  ],
  [
    '777c4bdb8b',
    '545c5c79a39a869d',
    '8cfd098b7245aa32d0b066dde7ff20196bd6a0bcf10a12ca',
    'de438dcf44b21c333561c40506e13b49b10c559d490d187e',
  ],
  [
    '13b358a619',
    'f661f8810349c812',
    '2d8a58ceb49681963ed903ad77a0d5a60936512426dc3bd3',
    '4658424b2a84692b74e2ba05bda2133ffb6129d9c93001fa',
  ],
  [
    'd1e9283b00',
    '15ee6fedb525619f',
    'beadbbd989b47e99f23cda0abda8b8e3ba4d10344181959f',
    '4d36be9f2641b0df4dfeee772bf9aff698497e336b92672b',
  ],
  [
    '3a1a63ae2a2d61f6',
    'a80cf0a3208e2e8a',
    'd842fe9804fa362c8658ee2df9c8b8d533169c1df8a00c0c',
    '4761efe63844b435560f74489b08af47ff66c093e944329f',
  ],
  [
    'd0b227857cb83fae',
    'ada75558c7db8fee',
    'f6aceb496fcd736626f5257e42e97578a0997422acc1f565',
    'bcc5e44f92f57fbe9273d8f4b6def7df48ea3a30e5e22b9b',
  ],
  [
    'ded6ccd3c7b06c32',
    '12ad9d4d6a72fbcc',
    '53d5745c6b0a3639e3d74fef3430e3e561a5ed7e39535135',
    '0ed822c733ccc0f4ec4a90e17765074e0978fd410176c547',
  ],
  [
    '86eb13c7813137037db94a511d164bd3',
    '0f009668064c51a3',
    '08c7b5f52ea90d057309d916296f85f377b9c020864dd457',
    '719d70445ca6d62854c1dae2b6b6976d2782edc3753b177d',
  ],
  [
    '8a38d1b2f6ee226ba3b40fa2a97061b3',
    '9aca703675766a49',
    '030407f1c834216e2a9e916f9fd95a6999d09bf18973c1ab',
    '581ba38586bf4614ed41fd7d17b697b4c2b48b574a7daeeb',
  ],
  [
    '1f16db030d5872468572d4e905fc2cb5',
    '73912008451e5cb9',
    '03412d5e50c8bcd66309e0a46a1240c04f357266d91fa650',
    '496813a54fdc8ff2ee4329a511babdc395196f9985da2044',
  ],
  [
    '28b1652ceb5a51891145abe6c3a8267b',
    '8f2162ec9d3c539d',
    '9ee6176f4285c64f070427bcd6fe67141e61ce685e8e16dd',
    'e9e873e44da92d3ef9511ec753525dd1fa8d018c053176c9',
  ],
  [
    '4b79881f8e62b530b4f8994d71afd762',
    'c7ebb6a473033727',
    'd5e5492c80ca698954c6aca00d0e8e038a87ae2d2c131e70',
    'a3d571257f7c47192bfaea95e492478fb3a97ecbbb7ff02c',
  ],
  [
    '38021eb4a4cfffc61c084b50037cbc28',
    '2ab063271914beaa',
    '14307c76c1494b90d9839d388aa9b6b6a731e072715c5027',
    '5c53ac32e4a953e038ac84aad4daec0652046806cee2529d',
  ],
  [
    '93faf41b8aca6ca98ae413eefaeeb8ea',
    '2f6de89e4b5b423b',
    'c936ad6af644c7c491b2f4d66422187cbd68af48e3ee2fe2',
    '5a9620f9150ea134e4401be97850eec7f20879ce1fff04b0',
  ],
  [
    '10cc1ad27bdb4342510d9676ba752b68',
    '870a3edc3b78e517',
    '0a8bbbb539ecc9908338c27408d0d8a81b8f39ac0a1f308c',
    '3608df9bce613d7fbd7c2b6e3570fed83e9976d8649ddf93',
  ],
];

describe('tripleDesCbcDecrypt', () => {
  it('matches OpenSSL with three keys', () => {
    for (const [key, iv, plain, cipher] of TRIPLE_DES) {
      expect(toHex(tripleDesCbcDecrypt(hex(key), hex(iv), hex(cipher)))).toBe(plain.toUpperCase());
    }
  });

  it('matches OpenSSL with two keys', () => {
    for (const [key, iv, plain, cipher] of TWO_KEY_TRIPLE_DES) {
      expect(toHex(tripleDesCbcDecrypt(hex(key), hex(iv), hex(cipher)))).toBe(plain.toUpperCase());
    }
  });

  it('is DES when all three keys are the same (FIPS 81 example)', () => {
    // Key 0123456789ABCDEF, IV 1234567890ABCDEF: "Now is the time for all ".
    const key = hex('0123456789abcdef'.repeat(3));
    const cipher = hex('e5c7cdde872bf27c43e934008c389c0f683788499a7c05f6');
    const plain = tripleDesCbcDecrypt(key, hex('1234567890abcdef'), cipher);
    expect(new TextDecoder().decode(plain)).toBe('Now is the time for all ');
  });

  it('refuses bad sizes', () => {
    expect(() =>
      tripleDesCbcDecrypt(hex('00'.repeat(8)), hex('00'.repeat(8)), hex('00'.repeat(8)))
    ).toThrow(RangeError);
    expect(() =>
      tripleDesCbcDecrypt(hex('00'.repeat(24)), hex('00'.repeat(8)), hex('00'.repeat(7)))
    ).toThrow(RangeError);
  });
});

describe('rc2CbcDecrypt', () => {
  it('matches OpenSSL for 40-, 64- and 128-bit keys', () => {
    for (const [key, iv, plain, cipher] of RC2) {
      const bits = (key.length / 2) * 8;
      expect(toHex(rc2CbcDecrypt(hex(key), bits, hex(iv), hex(cipher)))).toBe(plain.toUpperCase());
    }
  });

  it('matches RFC 2268 with effective key lengths other than the key’s', () => {
    // Section 5: 8-byte key of zeros with 63 effective bits, ECB on one block.
    const zeroIv = hex('0000000000000000');
    expect(toHex(rc2CbcDecrypt(hex('0000000000000000'), 63, zeroIv, hex('ebb773f993278eff')))).toBe(
      '0000000000000000'
    );
    expect(toHex(rc2CbcDecrypt(hex('88'), 64, zeroIv, hex('61a8a244adacccf0')))).toBe(
      '0000000000000000'
    );
    expect(
      toHex(
        rc2CbcDecrypt(hex('88bca90e90875a7f0f79c384627bafb2'), 64, zeroIv, hex('1a807d272bbe5db1'))
      )
    ).toBe('0000000000000000');
  });

  it('refuses bad sizes', () => {
    expect(() =>
      rc2CbcDecrypt(new Uint8Array(0), 40, hex('00'.repeat(8)), hex('00'.repeat(8)))
    ).toThrow(RangeError);
    expect(() => rc2CbcDecrypt(hex('01'), 40, hex('00'.repeat(4)), hex('00'.repeat(8)))).toThrow(
      RangeError
    );
  });
});
