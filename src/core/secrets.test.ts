import { describe, expect, it } from 'vitest';
import type { CertificateInfo, SigningKey } from './secrets';
import {
  JWS_ALGORITHMS,
  SECRET_KINDS,
  SECRET_LIMITS,
  isMaskedValue,
  parseOrigin,
  parseSecretDocument,
  parseSecretSummary,
  parseStoredSecret,
  summarizeSecret,
} from './secrets';

// Test-only values: not real credentials.
const PKCS8 = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj+test/key==';
const X5T = 'kXz3Dy0Zy3cCmVVXM_xK8bxE9nE';
const X5T_S256 = 'bwcK0esc3ACC3DB2Y5_lESsXE8o9ltc05O89jdN-dg2';

const CERTIFICATE: CertificateInfo = {
  subject: 'CN=picklist, O=Contoso',
  issuer: 'CN=Contoso Issuing CA',
  serialNumber: '0A1B2C',
  notBefore: '2026-10-01T00:00:00.000Z',
  notAfter: '2027-10-01T00:00:00Z',
  sha1Thumbprint: '0123456789ABCDEF0123456789ABCDEF01234567',
  sha256Thumbprint: '0123456789ABCDEF'.repeat(4),
};

describe('constants', () => {
  it('lists the algorithms and kinds WebCrypto can handle', () => {
    expect(JWS_ALGORITHMS).toEqual([
      'RS256',
      'RS384',
      'RS512',
      'PS256',
      'PS384',
      'PS512',
      'ES256',
      'ES384',
      'ES512',
    ]);
    expect(SECRET_KINDS).toEqual(['password', 'token', 'apiKey', 'clientSecret', 'signingKey']);
  });
});

describe('parseOrigin', () => {
  it('accepts HTTPS origins, and HTTP on localhost for testing', () => {
    for (const origin of [
      'https://api.contoso.com',
      'https://api.contoso.com:8443',
      'https://xn--bcher-kva.example',
      'http://localhost',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://[::1]:5000',
    ]) {
      expect(parseOrigin(origin)).toBe(origin);
    }
  });

  it('refuses anything that isn’t exactly an origin', () => {
    for (const value of [
      'http://api.contoso.com',
      'https://api.contoso.com/',
      'https://api.contoso.com/path',
      'https://api.contoso.com?x=1',
      'https://api.contoso.com#x',
      'https://user:pw@api.contoso.com',
      'https://API.contoso.com',
      'https://api.contoso.com:443',
      'ftp://api.contoso.com',
      'javascript:alert(1)',
      'api.contoso.com',
      '',
      `https://${'a'.repeat(SECRET_LIMITS.maxTextLength)}.example`,
      42,
      null,
      undefined,
      { origin: 'https://api.contoso.com' },
    ]) {
      expect(parseOrigin(value)).toBeNull();
    }
  });
});

describe('parseStoredSecret', () => {
  it('reads each kind of secret', () => {
    for (const kind of ['password', 'token', 'apiKey', 'clientSecret'] as const) {
      expect(parseStoredSecret({ kind, value: 's3cret' })).toEqual({ kind, value: 's3cret' });
    }
    const key: SigningKey = {
      pkcs8: PKCS8,
      algorithm: 'PS256',
      x5t: X5T,
      x5tS256: X5T_S256,
      kid: 'key-1',
    };
    expect(parseStoredSecret({ kind: 'signingKey', key })).toEqual({ kind: 'signingKey', key });
  });

  it('keeps only what each kind has', () => {
    expect(parseStoredSecret({ kind: 'password', value: 'pw', key: { pkcs8: PKCS8 } })).toEqual({
      kind: 'password',
      value: 'pw',
    });
    expect(
      parseStoredSecret({
        kind: 'signingKey',
        value: 'ignored',
        key: { pkcs8: PKCS8, algorithm: 'RS256', extra: 'ignored' },
      })
    ).toEqual({ kind: 'signingKey', key: { pkcs8: PKCS8, algorithm: 'RS256' } });
  });

  it('refuses anything malformed rather than repairing it', () => {
    for (const value of [
      null,
      'pw',
      [],
      { kind: 'password' },
      { kind: 'password', value: '' },
      { kind: 'password', value: 42 },
      { kind: 'token', value: 'x'.repeat(SECRET_LIMITS.maxValueLength + 1) },
      { kind: 'cookie', value: 'x' },
      { kind: 'signingKey' },
      { kind: 'signingKey', key: 'MII…' },
      { kind: 'signingKey', key: { pkcs8: PKCS8 } },
      { kind: 'signingKey', key: { pkcs8: PKCS8, algorithm: 'HS256' } },
      {
        kind: 'signingKey',
        key: { pkcs8: `${PKCS8.slice(0, 20)}\n${PKCS8.slice(20)}`, algorithm: 'RS256' },
      },
      { kind: 'signingKey', key: { pkcs8: 'not base64!', algorithm: 'RS256' } },
      {
        kind: 'signingKey',
        key: { pkcs8: 'A'.repeat(SECRET_LIMITS.maxKeyLength + 1), algorithm: 'RS256' },
      },
    ]) {
      expect(parseStoredSecret(value)).toBeNull();
    }
    expect(
      parseStoredSecret({ kind: 'token', value: 'x'.repeat(SECRET_LIMITS.maxValueLength) })
    ).not.toBeNull();
  });

  it('drops key headers that aren’t valid', () => {
    expect(
      parseStoredSecret({
        kind: 'signingKey',
        key: {
          pkcs8: PKCS8,
          algorithm: 'ES256',
          x5t: 'has+plus/and=pad',
          x5tS256: 'x'.repeat(101),
          kid: 'k'.repeat(SECRET_LIMITS.maxTextLength + 1),
        },
      })
    ).toEqual({ kind: 'signingKey', key: { pkcs8: PKCS8, algorithm: 'ES256' } });
  });
});

describe('parseSecretSummary', () => {
  it('describes a secret without its value', () => {
    expect(
      parseSecretSummary({
        kind: 'password',
        boundOrigin: 'https://api.contoso.com',
        updatedBy: 'Ana Díaz',
        updatedAt: '2026-10-22T14:03:00.000Z',
        value: 'p@ssw0rd',
        algorithm: 'RS256',
        certificate: CERTIFICATE,
      })
    ).toEqual({
      kind: 'password',
      boundOrigin: 'https://api.contoso.com',
      updatedBy: 'Ana Díaz',
      updatedAt: '2026-10-22T14:03:00.000Z',
    });
  });

  it('describes a signing key and its certificate', () => {
    expect(
      parseSecretSummary({
        kind: 'signingKey',
        boundOrigin: 'https://auth.contoso.com',
        algorithm: 'RS256',
        keyId: 'key-1',
        certificate: CERTIFICATE,
        key: { pkcs8: PKCS8 },
      })
    ).toEqual({
      kind: 'signingKey',
      boundOrigin: 'https://auth.contoso.com',
      algorithm: 'RS256',
      keyId: 'key-1',
      certificate: CERTIFICATE,
    });
  });

  it('drops parts that aren’t valid', () => {
    const summary = parseSecretSummary({
      kind: 'signingKey',
      boundOrigin: 'https://auth.contoso.com',
      algorithm: 'none',
      keyId: '',
      updatedBy: 'x'.repeat(SECRET_LIMITS.maxTextLength + 1),
      updatedAt: '22 Oct 2026',
      certificate: { ...CERTIFICATE, sha1Thumbprint: CERTIFICATE.sha1Thumbprint.toLowerCase() },
    });
    expect(summary).toEqual({ kind: 'signingKey', boundOrigin: 'https://auth.contoso.com' });
    for (const certificate of [
      { ...CERTIFICATE, sha256Thumbprint: 'AB' },
      { ...CERTIFICATE, notAfter: '2027-10-01' },
      { ...CERTIFICATE, subject: 5 },
      { ...CERTIFICATE, issuer: 'x'.repeat(SECRET_LIMITS.maxTextLength + 1) },
      'CN=picklist',
    ]) {
      expect(
        parseSecretSummary({ kind: 'signingKey', boundOrigin: 'https://a.example', certificate })
      ).not.toHaveProperty('certificate');
    }
  });

  it('keeps a certificate whose subject or issuer is empty', () => {
    const certificate = { ...CERTIFICATE, subject: '', issuer: '' };
    expect(
      parseSecretSummary({ kind: 'signingKey', boundOrigin: 'https://a.example', certificate })
        ?.certificate
    ).toEqual(certificate);
  });

  it('refuses summaries without a kind or a valid origin', () => {
    for (const value of [
      null,
      'set',
      { kind: 'password' },
      { kind: 'password', boundOrigin: 'http://api.contoso.com' },
      { kind: 'password', boundOrigin: 'https://api.contoso.com/' },
      { kind: 'magic', boundOrigin: 'https://api.contoso.com' },
    ]) {
      expect(parseSecretSummary(value)).toBeNull();
    }
  });
});

describe('parseSecretDocument', () => {
  const stored = {
    id: '6f1c0f3e-3f0b-4c55-9a43-0d3a6c1e9b21',
    __etag: 2,
    version: 1,
    secret: { kind: 'clientSecret', value: 'client-s3cret' },
    boundOrigin: 'https://auth.contoso.com',
    updatedBy: 'Ana Díaz',
    updatedAt: '2026-10-22T14:03:00.000Z',
  };

  it('reads a stored secret', () => {
    expect(parseSecretDocument(stored)).toEqual(stored);
    expect(parseSecretDocument({ ...stored, extra: 'x' })).toEqual(stored);
  });

  it('refuses documents without an id, a valid secret or a valid origin', () => {
    for (const value of [
      null,
      [],
      { ...stored, id: '' },
      { ...stored, id: 5 },
      { ...stored, secret: { kind: 'clientSecret', value: '' } },
      { ...stored, secret: undefined },
      { ...stored, boundOrigin: 'https://auth.contoso.com/token' },
      { ...stored, boundOrigin: undefined },
      { ...stored, version: 2 },
      { ...stored, version: undefined },
    ]) {
      expect(parseSecretDocument(value)).toBeNull();
    }
  });

  it('reads where an OAuth 2.0 secret’s tokens may go, and refuses a damaged one', () => {
    const bound = { ...stored, apiOrigin: 'https://api.contoso.com' };
    expect(parseSecretDocument(bound)).toEqual(bound);
    // A binding that can't be read never turns into no binding.
    for (const apiOrigin of ['https://api.contoso.com/v1', 'http://api.contoso.com', 7, '']) {
      expect(parseSecretDocument({ ...stored, apiOrigin })).toBeNull();
    }
    expect(
      parseSecretSummary({
        kind: 'clientSecret',
        boundOrigin: 'https://auth.contoso.com',
        apiOrigin: 'https://api.contoso.com',
      })
    ).toEqual({
      kind: 'clientSecret',
      boundOrigin: 'https://auth.contoso.com',
      apiOrigin: 'https://api.contoso.com',
    });
    expect(
      summarizeSecret(
        { kind: 'clientSecret', value: 'x' },
        'https://auth.contoso.com',
        {},
        undefined,
        'https://api.contoso.com'
      )
    ).toEqual({
      kind: 'clientSecret',
      boundOrigin: 'https://auth.contoso.com',
      apiOrigin: 'https://api.contoso.com',
    });
  });

  it('drops stamps and versions that aren’t valid', () => {
    expect(
      parseSecretDocument({
        ...stored,
        __etag: 'two',
        updatedBy: '',
        updatedAt: 'yesterday',
      })
    ).toEqual({
      id: stored.id,
      version: 1,
      secret: stored.secret,
      boundOrigin: stored.boundOrigin,
    });
    expect(parseSecretDocument({ ...stored, __etag: Number.NaN })).not.toHaveProperty('__etag');
  });
});

describe('summarizeSecret', () => {
  it('keeps the kind, origin and stamp, never the value', () => {
    const summary = summarizeSecret(
      { kind: 'token', value: 'token-123' },
      'https://api.contoso.com',
      { updatedBy: 'Ana Díaz', updatedAt: '2026-10-22T14:03:00.000Z' },
      CERTIFICATE
    );
    expect(summary).toEqual({
      kind: 'token',
      boundOrigin: 'https://api.contoso.com',
      updatedBy: 'Ana Díaz',
      updatedAt: '2026-10-22T14:03:00.000Z',
    });
    expect(JSON.stringify(summary)).not.toContain('token-123');
    expect(parseSecretSummary(summary)).toEqual(summary);
  });

  it('describes signing keys by algorithm, key id and certificate', () => {
    const summary = summarizeSecret(
      { kind: 'signingKey', key: { pkcs8: PKCS8, algorithm: 'ES384', kid: 'key-7' } },
      'https://auth.contoso.com',
      {},
      CERTIFICATE
    );
    expect(summary).toEqual({
      kind: 'signingKey',
      boundOrigin: 'https://auth.contoso.com',
      algorithm: 'ES384',
      keyId: 'key-7',
      certificate: CERTIFICATE,
    });
    expect(JSON.stringify(summary)).not.toContain(PKCS8);
    expect(
      summarizeSecret(
        { kind: 'signingKey', key: { pkcs8: PKCS8, algorithm: 'RS256' } },
        'https://auth.contoso.com'
      )
    ).toEqual({ kind: 'signingKey', boundOrigin: 'https://auth.contoso.com', algorithm: 'RS256' });
  });
});

describe('isMaskedValue', () => {
  it('recognizes text that only hides a value', () => {
    for (const value of ['********', ' *** ', '•••', '●●●●', '∙∙', '··', '*•●']) {
      expect(isMaskedValue(value)).toBe(true);
    }
    for (const value of ['', '   ', 'p@ss', '**a**', '* *', 42, null, undefined, ['***']]) {
      expect(isMaskedValue(value)).toBe(false);
    }
  });
});
