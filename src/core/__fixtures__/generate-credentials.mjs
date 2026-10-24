// Writes credentials.ts: throwaway keys and certificates for the tests of the key and certificate
// readers. Needs OpenSSL 3.5 or later on PATH, with its legacy provider (for RC2).
//
//   node src/core/__fixtures__/generate-credentials.mjs [work folder]
//
// Every run makes new keys, so the expected values in credentials.ts change with them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PASSWORD = 'test-password';
const pass = `pass:${PASSWORD}`;
const output = join(dirname(fileURLToPath(import.meta.url)), 'credentials.ts');
const keepWork = Boolean(process.argv[2]);
const work = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'picklist-credentials-'));
mkdirSync(work, { recursive: true });

function openssl(...args) {
  return execFileSync('openssl', args, { cwd: work, encoding: 'utf8', stdio: 'pipe' });
}

function base64(name) {
  return readFileSync(join(work, name)).toString('base64');
}

// Subjects go through a config file so UTF-8 survives the command line on every platform.
function subjectConfig(name, dn) {
  const lines = ['[req]', 'distinguished_name = dn', 'prompt = no', 'string_mask = utf8only'];
  lines.push('[dn]', ...Object.entries(dn).map(([key, value]) => `${key} = ${value}`));
  writeFileSync(join(work, `${name}.cnf`), `${lines.join('\n')}\n`, 'utf8');
  return `${name}.cnf`;
}

const KEYS = {
  rsa2048: ['RSA', 'rsa_keygen_bits:2048'],
  rsa3072: ['RSA', 'rsa_keygen_bits:3072'],
  rsa1024: ['RSA', 'rsa_keygen_bits:1024'],
  ec256: ['EC', 'ec_paramgen_curve:P-256'],
  other256: ['EC', 'ec_paramgen_curve:P-256'],
  ec384: ['EC', 'ec_paramgen_curve:P-384'],
  ec521: ['EC', 'ec_paramgen_curve:P-521'],
  secp256k1: ['EC', 'ec_paramgen_curve:secp256k1'],
  ca: ['EC', 'ec_paramgen_curve:P-256'],
};
for (const [name, [algorithm, option]] of Object.entries(KEYS)) {
  openssl('genpkey', '-algorithm', algorithm, '-pkeyopt', option, '-out', `${name}.pem`);
}
openssl('genpkey', '-algorithm', 'ED25519', '-out', 'ed25519.pem');

function pkcs8(name) {
  openssl(
    'pkcs8',
    '-topk8',
    '-nocrypt',
    '-in',
    `${name}.pem`,
    '-outform',
    'DER',
    '-out',
    `${name}.p8`
  );
  return base64(`${name}.p8`);
}

function encrypted(name, out, ...options) {
  openssl(
    'pkcs8',
    '-topk8',
    '-in',
    `${name}.pem`,
    '-passout',
    pass,
    '-outform',
    'DER',
    '-out',
    out,
    ...options
  );
  return base64(out);
}

function certificate(name, subject, serial, notBefore, notAfter, signer) {
  const config = subjectConfig(name, subject);
  const dates = ['-not_before', notBefore, '-not_after', notAfter];
  if (signer) {
    openssl(
      'req',
      '-new',
      '-key',
      `${name}.pem`,
      '-config',
      config,
      '-utf8',
      '-out',
      `${name}.csr`
    );
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${signer}.crt`,
      '-CAkey',
      `${signer}.pem`,
      '-set_serial',
      serial,
      ...dates,
      '-out',
      `${name}.crt`
    );
  } else {
    openssl(
      'req',
      '-x509',
      '-new',
      '-key',
      `${name}.pem`,
      '-config',
      config,
      '-utf8',
      '-set_serial',
      serial,
      ...dates,
      '-out',
      `${name}.crt`
    );
  }
  openssl('x509', '-in', `${name}.crt`, '-outform', 'DER', '-out', `${name}.cer`);
  // OpenSSL prints "name=value"; the expected values come from there, not from the code tested.
  const read = (...options) =>
    afterEquals(openssl('x509', '-in', `${name}.cer`, '-inform', 'DER', '-noout', ...options));
  const names = ['-nameopt', 'RFC2253,-esc_msb'];
  return {
    der: base64(`${name}.cer`),
    info: {
      subject: read('-subject', ...names),
      issuer: read('-issuer', ...names),
      serialNumber: read('-serial'),
      notBefore: isoDate(read('-startdate', '-dateopt', 'iso_8601')),
      notAfter: isoDate(read('-enddate', '-dateopt', 'iso_8601')),
      sha1Thumbprint: read('-fingerprint', '-sha1').replaceAll(':', ''),
      sha256Thumbprint: read('-fingerprint', '-sha256').replaceAll(':', ''),
    },
  };
}

function afterEquals(text) {
  return text.slice(text.indexOf('=') + 1).trim();
}

/** "2026-10-01 00:00:00Z" as "2026-10-01T00:00:00.000Z". */
function isoDate(text) {
  return `${text.replace(' ', 'T').replace('Z', '')}.000Z`;
}

/** A value written with a doc comment. */
const NOTE = Symbol('note');
const note = (text, value) => ({ [NOTE]: text, value });
const noteOf = (value) =>
  value && typeof value === 'object' && NOTE in value ? value[NOTE] : null;

function pfx(out, password, ...options) {
  openssl('pkcs12', '-export', '-out', out, '-passout', `pass:${password}`, ...options);
  return base64(out);
}

const ca = certificate(
  'ca',
  { C: 'US', O: 'Contoso, Ltd.', CN: 'REST Picklist Test CA' },
  '0x1000',
  '20260101000000Z',
  '20360101000000Z'
);
const rsa2048 = certificate(
  'rsa2048',
  {
    C: 'CR',
    ST: 'San José',
    L: 'San José',
    O: 'Contoso, Ltd.',
    OU: 'Integration',
    CN: 'picklist-rsa',
    emailAddress: 'picklist@example.com',
  },
  '1',
  '20261001000000Z',
  '20271001000000Z',
  'ca'
);
// After 2049 the end date is a GeneralizedTime; the serial needs a leading zero byte in DER.
const rsa3072 = certificate(
  'rsa3072',
  { CN: 'picklist-rsa-3072' },
  '0xF1E2D3C4B5A69788',
  '20261001000000Z',
  '20561001000000Z'
);
const ec256 = certificate(
  'ec256',
  { O: 'Contoso', CN: 'picklist-ec-256' },
  '0x0A',
  '20261001000000Z',
  '20261201000000Z'
);
const ec384 = certificate(
  'ec384',
  { CN: 'picklist-ec-384' },
  '0x0B',
  '20261001000000Z',
  '20271001000000Z'
);
const other256 = certificate(
  'other256',
  { CN: 'someone-else' },
  '0x0C',
  '20261001000000Z',
  '20271001000000Z'
);

openssl('rsa', '-in', 'rsa2048.pem', '-traditional', '-outform', 'DER', '-out', 'rsa2048.p1');
openssl('ec', '-in', 'ec256.pem', '-outform', 'DER', '-out', 'ec256.sec1');
openssl('ec', '-in', 'ec256.pem', '-no_public', '-outform', 'DER', '-out', 'ec256.sec1-no-public');
openssl('ec', '-in', 'ec256.pem', '-aes-128-cbc', '-passout', pass, '-out', 'ec256.legacy.pem');
const legacyPem = readFileSync(join(work, 'ec256.legacy.pem'), 'utf8').split(/\r?\n/);

const rsa2048Pair = ['-inkey', 'rsa2048.pem', '-in', 'rsa2048.crt'];
const ec256Pair = ['-inkey', 'ec256.pem', '-in', 'ec256.crt'];
const fixtures = {
  CA: { certificate: ca.der, info: ca.info },
  RSA_2048: {
    pkcs8: pkcs8('rsa2048'),
    pkcs1: note('PKCS #1 RSAPrivateKey of the same key.', base64('rsa2048.p1')),
    encrypted: note(
      'EncryptedPrivateKeyInfo: PBES2 with PBKDF2-HMAC-SHA256 and AES-256-CBC.',
      encrypted('rsa2048', 'rsa2048.enc', '-v2', 'aes-256-cbc', '-v2prf', 'hmacWithSHA256')
    ),
    certificate: note('Signed by CA.', rsa2048.der),
    info: rsa2048.info,
  },
  RSA_3072: { pkcs8: pkcs8('rsa3072'), certificate: rsa3072.der, info: rsa3072.info },
  RSA_1024: { pkcs8: pkcs8('rsa1024') },
  EC_P256: {
    pkcs8: pkcs8('ec256'),
    sec1: note('SEC1 ECPrivateKey of the same key.', base64('ec256.sec1')),
    sec1NoPublicKey: note('SEC1 without the public key.', base64('ec256.sec1-no-public')),
    certificate: ec256.der,
    info: ec256.info,
    legacyPem: note('Traditional OpenSSL encryption (Proc-Type: 4,ENCRYPTED).', {
      headers: legacyPem.filter((line) => line.includes(':')),
      body: legacyPem
        .filter((line) => line && !line.includes(':') && !line.startsWith('-----'))
        .join(''),
    }),
    encrypted: note(
      'EncryptedPrivateKeyInfo with PBES2 (PRF and cipher), PKCS #12 PBE or scrypt.',
      {
        sha1Aes256: encrypted('ec256', 'e1', '-v2', 'aes-256-cbc', '-v2prf', 'hmacWithSHA1'),
        sha224Aes128: encrypted('ec256', 'e2', '-v2', 'aes-128-cbc', '-v2prf', 'hmacWithSHA224'),
        sha384Aes192: encrypted('ec256', 'e3', '-v2', 'aes-192-cbc', '-v2prf', 'hmacWithSHA384'),
        sha512Aes256: encrypted('ec256', 'e4', '-v2', 'aes-256-cbc', '-v2prf', 'hmacWithSHA512'),
        sha256Des3: encrypted('ec256', 'e5', '-v2', 'des3'),
        pkcs12TripleDes: encrypted('ec256', 'e6', '-v1', 'PBE-SHA1-3DES'),
        scrypt: encrypted('ec256', 'e7', '-scrypt'),
      }
    ),
  },
  EC_P384: { pkcs8: pkcs8('ec384'), certificate: ec384.der, info: ec384.info },
  EC_P521: { pkcs8: pkcs8('ec521') },
  SECP256K1: { pkcs8: pkcs8('secp256k1') },
  ED25519: { pkcs8: pkcs8('ed25519') },
  OTHER_P256: note('A certificate for another P-256 key.', {
    certificate: other256.der,
    info: other256.info,
  }),
  PFX: {
    modern: note(
      'OpenSSL 3 defaults: PBES2 with AES-256-CBC, HMAC-SHA256 MAC. RSA_2048 and the CA.',
      pfx('modern.pfx', PASSWORD, ...rsa2048Pair, '-certfile', 'ca.crt')
    ),
    tripleDes: note(
      'Triple DES key and certificate, SHA-1 MAC, like Windows’ TripleDES-SHA1. RSA_2048.',
      pfx(
        '3des.pfx',
        PASSWORD,
        ...rsa2048Pair,
        '-keypbe',
        'PBE-SHA1-3DES',
        '-certpbe',
        'PBE-SHA1-3DES',
        '-macalg',
        'sha1'
      )
    ),
    legacy: note(
      'openssl pkcs12 -legacy: Triple DES key, 40-bit RC2 certificate, SHA-1 MAC. EC_P256.',
      pfx('legacy.pfx', PASSWORD, ...ec256Pair, '-legacy')
    ),
    rc2: note(
      'Two-key Triple DES key, 128-bit RC2 certificate, SHA-1 MAC. EC_P256.',
      pfx(
        'rc2.pfx',
        PASSWORD,
        ...ec256Pair,
        '-provider',
        'legacy',
        '-provider',
        'default',
        '-keypbe',
        'PBE-SHA1-2DES',
        '-certpbe',
        'PBE-SHA1-RC2-128',
        '-macalg',
        'sha1'
      )
    ),
    unencrypted: note(
      'No encryption (a keyBag in plain data), with a MAC. EC_P256.',
      pfx('plain.pfx', PASSWORD, ...ec256Pair, '-keypbe', 'NONE', '-certpbe', 'NONE')
    ),
    sha384Mac: note(
      'HMAC-SHA384 MAC: the PKCS #12 KDF with 128-byte blocks. EC_P256.',
      pfx('sha384.pfx', PASSWORD, ...ec256Pair, '-macalg', 'sha384')
    ),
    sha512Mac: note(
      'HMAC-SHA512 MAC. EC_P256.',
      pfx('sha512.pfx', PASSWORD, ...ec256Pair, '-macalg', 'sha512')
    ),
    pbmac1: note(
      'PBMAC1 (RFC 9579) instead of the PKCS #12 MAC. EC_P256.',
      pfx('pbmac1.pfx', PASSWORD, ...ec256Pair, '-pbmac1_pbkdf2')
    ),
    noMac: note('No MAC at all. EC_P256.', pfx('nomac.pfx', PASSWORD, ...ec256Pair, '-nomac')),
    emptyPassword: note(
      'An empty password. EC_P384.',
      pfx('empty.pfx', '', '-inkey', 'ec384.pem', '-in', 'ec384.crt')
    ),
  },
};

function literal(value, indent) {
  const pad = ' '.repeat(indent);
  if (typeof value === 'string') {
    // Base64 is wrapped like PEM; everything else is a plain string.
    if (/^[A-Za-z0-9+/=]{80,}$/.test(value)) {
      return `\`\n${value.match(/.{1,76}/g).join('\n')}\``;
    }
    return JSON.stringify(value)
      .replaceAll("'", "\\'")
      .replace(/^"|"$/g, "'")
      .replaceAll('\\"', '"');
  }
  if (noteOf(value) !== null) {
    return literal(value.value, indent);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => literal(item, indent)).join(', ')}]`;
  }
  const entries = Object.entries(value).map(([key, item]) => {
    const text = noteOf(item);
    const doc = text === null ? '' : `${pad}  /** ${text} */\n`;
    return `${doc}${pad}  ${key}: ${literal(item, indent + 2)},`;
  });
  return `{\n${entries.join('\n')}\n${pad}}`;
}

const header = `// Throwaway keys and certificates for tests only. They were made for these tests, protect
// nothing and must never be trusted. Generated with OpenSSL 3.5 by generate-credentials.mjs (run
// it again to replace them all); the password is “${PASSWORD}” unless noted. They're kept as
// base64 DER without PEM armor, so secret scanners don't take them for leaked keys: tests add
// the armor with pem().

export const PASSWORD = '${PASSWORD}';

/** The bytes of base64 text; line breaks are ignored. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/\\s+/g, '')), (char) => char.charCodeAt(0));
}

/** PEM text for base64 DER, with RFC 1421 headers when given. Built at test time. */
export function pem(label: string, base64: string, headers: string[] = []): string {
  const dashes = '-----';
  const lines = base64.replace(/\\s+/g, '').match(/.{1,64}/g) ?? [];
  return [
    \`\${dashes}BEGIN \${label}\${dashes}\`,
    ...headers,
    ...(headers.length > 0 ? [''] : []),
    ...lines,
    \`\${dashes}END \${label}\${dashes}\`,
    '',
  ].join('\\n');
}
`;

const body = Object.entries(fixtures)
  .map(([name, value]) => {
    const text = noteOf(value);
    const doc = text === null ? '' : `/** ${text} */\n`;
    return `${doc}export const ${name} = ${literal(value, 0)};`;
  })
  .join('\n\n');
writeFileSync(output, `${header}\n${body}\n`, 'utf8');
if (!keepWork) {
  rmSync(work, { recursive: true, force: true });
}
console.info(`Wrote ${output}`);
