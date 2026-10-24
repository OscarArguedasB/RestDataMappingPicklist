import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OAuthSettings } from './config';
import { DEFAULT_OAUTH } from './config';
import { PicklistError } from './errors';
import {
  ENTRA_BROWSER_WARNING,
  TokenCache,
  buildTokenRequest,
  createClientAssertion,
  isMicrosoftEntraTokenUrl,
  parseTokenResponse,
  requestAccessToken,
  sharedTokenCache,
  validateOAuthSettings,
} from './oauth';
import type { SecurityPolicy } from './policy';
import { DEFAULT_POLICY } from './policy';
import type { JwsAlgorithm, SigningKey, StoredSecret } from './secrets';
import { isPlainObject } from './values';

const subtle = globalThis.crypto.subtle;
const TOKEN_URL = 'https://auth.contoso.com/realms/picklist/protocol/openid-connect/token';
const ENTRA_TOKEN_URL =
  'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token';
const SECRET = 'p@ss:wörd+/~ tail';
const CLIENT_SECRET: StoredSecret = { kind: 'clientSecret', value: SECRET };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW_SECONDS = 1_800_000_000;
// Written as code points so the source shows no invisible characters.
const NUL = String.fromCharCode(0);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

function settings(overrides: Partial<OAuthSettings> = {}): OAuthSettings {
  return {
    ...DEFAULT_OAUTH,
    extraParams: {},
    tokenUrl: TOKEN_URL,
    clientId: 'picklist',
    ...overrides,
  };
}

function policy(overrides: Partial<SecurityPolicy>): SecurityPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

// Test-only keys, made fresh for each run and never written anywhere.
interface TestKey {
  pkcs8: string;
  spki: ArrayBuffer;
}

let rsaKey: TestKey;
let p256Key: TestKey;
let p384Key: TestKey;
let p521Key: TestKey;

function toBase64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64Url(text: string) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function testKey(algorithm: RsaHashedKeyGenParams | EcKeyGenParams): Promise<TestKey> {
  const pair = await subtle.generateKey(algorithm, true, ['sign', 'verify']);
  return {
    pkcs8: toBase64(await subtle.exportKey('pkcs8', pair.privateKey)),
    spki: await subtle.exportKey('spki', pair.publicKey),
  };
}

const RSA_2048: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

beforeAll(async () => {
  [rsaKey, p256Key, p384Key, p521Key] = await Promise.all([
    testKey(RSA_2048),
    testKey({ name: 'ECDSA', namedCurve: 'P-256' }),
    testKey({ name: 'ECDSA', namedCurve: 'P-384' }),
    testKey({ name: 'ECDSA', namedCurve: 'P-521' }),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// How a token service checks each algorithm, written out apart from the code under test.
const VERIFY: Record<
  JwsAlgorithm,
  {
    key: RsaHashedImportParams | EcKeyImportParams;
    verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  }
> = {
  RS256: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: 'RSASSA-PKCS1-v1_5' },
  RS384: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, verify: 'RSASSA-PKCS1-v1_5' },
  RS512: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, verify: 'RSASSA-PKCS1-v1_5' },
  PS256: { key: { name: 'RSA-PSS', hash: 'SHA-256' }, verify: { name: 'RSA-PSS', saltLength: 32 } },
  PS384: { key: { name: 'RSA-PSS', hash: 'SHA-384' }, verify: { name: 'RSA-PSS', saltLength: 48 } },
  PS512: { key: { name: 'RSA-PSS', hash: 'SHA-512' }, verify: { name: 'RSA-PSS', saltLength: 64 } },
  ES256: {
    key: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: 'SHA-256' },
  },
  ES384: {
    key: { name: 'ECDSA', namedCurve: 'P-384' },
    verify: { name: 'ECDSA', hash: 'SHA-384' },
  },
  ES512: {
    key: { name: 'ECDSA', namedCurve: 'P-521' },
    verify: { name: 'ECDSA', hash: 'SHA-512' },
  },
};

function jwtPart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
  if (!isPlainObject(value)) {
    throw new Error('Expected a JSON object in the JWT');
  }
  return value;
}

function decodeJwt(jwt: string) {
  expect(jwt).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  return {
    header: jwtPart(header),
    payload: jwtPart(payload),
    signingInput: `${header}.${payload}`,
    signature: fromBase64Url(signature),
  };
}

async function verifies(jwt: string, spki: ArrayBuffer, algorithm: JwsAlgorithm) {
  const { signingInput, signature } = decodeJwt(jwt);
  const publicKey = await subtle.importKey('spki', spki, VERIFY[algorithm].key, false, ['verify']);
  return subtle.verify(
    VERIFY[algorithm].verify,
    publicKey,
    signature,
    new TextEncoder().encode(signingInput)
  );
}

function signingSecret(key: TestKey, algorithm: JwsAlgorithm, extra: Partial<SigningKey> = {}) {
  return { kind: 'signingKey', key: { pkcs8: key.pkcs8, algorithm, ...extra } } as const;
}

function es256Assertion() {
  return createClientAssertion(
    { pkcs8: p256Key.pkcs8, algorithm: 'ES256' },
    { clientId: 'picklist', audience: TOKEN_URL },
    NOW_SECONDS
  );
}

function tokenUrlProblems(tokenUrl: string, rules = DEFAULT_POLICY) {
  return validateOAuthSettings(settings({ tokenUrl }), rules);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The form fields of a request a fake fetch received. */
function sentBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
}

/** A token service that hands out token-1, token-2… and records every request. */
function tokenService(answer: Record<string, unknown> = { expires_in: 3600 }) {
  let issued = 0;
  return vi.fn<typeof fetch>(async () => {
    issued += 1;
    return json({ access_token: `token-${issued}`, token_type: 'Bearer', ...answer });
  });
}

/** A token service that answers only when told to. */
function heldTokenService() {
  const releases: Array<() => void> = [];
  let issued = 0;
  const fetchImpl = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        releases.push(() => {
          issued += 1;
          resolve(json({ access_token: `token-${issued}`, expires_in: 3600 }));
        });
      })
  );
  return { fetchImpl, release: () => releases.shift()?.() };
}

async function offline(): Promise<Response> {
  throw new TypeError('Failed to fetch');
}

function neverResponds(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
  });
}

/** The PicklistError a promise fails with. */
function failure(promise: Promise<unknown>): Promise<PicklistError> {
  return promise.then(
    () => {
      throw new Error('Expected the promise to fail');
    },
    (error: unknown) => {
      if (error instanceof PicklistError) {
        return error;
      }
      throw new Error('Expected a PicklistError', { cause: error });
    }
  );
}

/** The PicklistError `run` throws. */
function thrown(run: () => unknown): PicklistError {
  try {
    run();
  } catch (error) {
    if (error instanceof PicklistError) {
      return error;
    }
    throw new Error('Expected a PicklistError', { cause: error });
  }
  throw new Error('Expected a PicklistError');
}

/** The keys of a token cache's private map, to see what it's keyed by. */
function entryKeys(cache: TokenCache): string[] {
  const entries: unknown = Reflect.get(cache, 'entries');
  if (!(entries instanceof Map)) {
    throw new Error('Expected the token cache to keep a map');
  }
  const map: Map<unknown, unknown> = entries;
  return [...map.keys()].filter((key): key is string => typeof key === 'string');
}

describe('isMicrosoftEntraTokenUrl', () => {
  it('recognizes Entra ID in every cloud, External ID and B2C', () => {
    for (const url of [
      ENTRA_TOKEN_URL,
      'https://login.microsoftonline.us/tenant/oauth2/v2.0/token',
      'https://login.chinacloudapi.cn/tenant/oauth2/token',
      'https://login.partner.microsoftonline.cn/tenant/oauth2/v2.0/token',
      'https://login.microsoftonline.de/tenant/oauth2/token',
      'https://login.windows.net/tenant/oauth2/token',
      'https://sts.windows.net/tenant/',
      'https://login.microsoft.com/tenant/oauth2/v2.0/token',
      'https://contoso.ciamlogin.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
      'https://contoso.b2clogin.com/contoso.onmicrosoft.com/b2c_1_signin/oauth2/v2.0/token',
      'https://LOGIN.MicrosoftOnline.com./tenant/oauth2/v2.0/token',
      ' login.microsoftonline.com/tenant/oauth2/v2.0/token ',
    ]) {
      expect({ url, entra: isMicrosoftEntraTokenUrl(url) }).toEqual({ url, entra: true });
    }
  });

  it('leaves other token URLs alone', () => {
    for (const url of [
      TOKEN_URL,
      'https://login.microsoftonline.com.evil.example/token',
      'https://ciamlogin.com/token',
      'https://notb2clogin.com/token',
      'https://dev-123.okta.com/oauth2/default/v1/token',
      'not a url',
      '',
    ]) {
      expect({ url, entra: isMicrosoftEntraTokenUrl(url) }).toEqual({ url, entra: false });
    }
    // The same words under the field, in the list (shortened) and on the form.
    expect(ENTRA_BROWSER_WARNING).toBe(
      'Microsoft Entra ID refuses client credentials sent from a browser, so this token URL won’t work. Use a token service that accepts requests from Azure DevOps.'
    );
  });
});

describe('validateOAuthSettings', () => {
  it('accepts complete settings', () => {
    expect(validateOAuthSettings(settings(), DEFAULT_POLICY)).toEqual([]);
    expect(tokenUrlProblems(ENTRA_TOKEN_URL)).toEqual([]);
  });

  it('asks for the token URL and the client ID', () => {
    expect(validateOAuthSettings(DEFAULT_OAUTH, DEFAULT_POLICY)).toEqual([
      'Add the access token URL for OAuth 2.0.',
      'Add the client ID for OAuth 2.0.',
    ]);
    expect(validateOAuthSettings(settings({ clientId: ' ' }), DEFAULT_POLICY)).toEqual([
      'Add the client ID for OAuth 2.0.',
    ]);
  });

  it('checks the token URL like the API’s URL', () => {
    expect(tokenUrlProblems('https://$(Custom.Tenant).contoso.com/token')).toEqual([
      'Field values can’t be used in the access token URL.',
    ]);
    expect(tokenUrlProblems('https://auth.contoso.com/$(Custom.Realm)/token')).toEqual([
      'Field values can’t be used in the access token URL.',
    ]);
    expect(tokenUrlProblems('auth.contoso.com/token')).toEqual([
      'Use a full URL for the access token URL, for example https://login.example.com/oauth2/token.',
    ]);
    expect(tokenUrlProblems('http://auth.contoso.com/token')).toEqual([
      'The access token URL must use https://.',
    ]);
    expect(tokenUrlProblems('https://id:secret@auth.contoso.com/token')[0]).toMatch(
      /Remove the user name and password/
    );
    expect(tokenUrlProblems('http://localhost:8080/token')[0]).toMatch(
      /doesn’t allow http:\/\/localhost/
    );
    expect(
      tokenUrlProblems('http://localhost:8080/token', policy({ allowLocalhost: true }))
    ).toEqual([]);
    expect(tokenUrlProblems(TOKEN_URL, policy({ allowedHosts: ['api.contoso.com'] }))).toEqual([
      'auth.contoso.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.',
    ]);
    expect(
      tokenUrlProblems('https://10.1.2.3/token', policy({ blockPrivateNetworks: true }))[0]
    ).toMatch(/private network address/);
  });

  it('checks extra parameters set by hand', () => {
    expect(
      validateOAuthSettings(settings({ extraParams: { grant_type: 'password' } }), DEFAULT_POLICY)
    ).toEqual(['“grant_type” can’t be an extra token parameter. REST Picklist sets it.']);
  });
});

describe('createClientAssertion', () => {
  it('signs with every supported algorithm in the JWS format', async () => {
    // ECDSA signatures are r and s side by side (not DER), at the curve's size.
    const cases: Array<[JwsAlgorithm, () => TestKey, number]> = [
      ['RS256', () => rsaKey, 256],
      ['RS384', () => rsaKey, 256],
      ['RS512', () => rsaKey, 256],
      ['PS256', () => rsaKey, 256],
      ['PS384', () => rsaKey, 256],
      ['PS512', () => rsaKey, 256],
      ['ES256', () => p256Key, 64],
      ['ES384', () => p384Key, 96],
      ['ES512', () => p521Key, 132],
    ];
    for (const [algorithm, key, signatureLength] of cases) {
      const jwt = await createClientAssertion(
        { pkcs8: key().pkcs8, algorithm },
        { clientId: 'picklist', audience: TOKEN_URL },
        NOW_SECONDS
      );
      const decoded = decodeJwt(jwt);
      expect(decoded.header.alg).toBe(algorithm);
      expect({ algorithm, valid: await verifies(jwt, key().spki, algorithm) }).toEqual({
        algorithm,
        valid: true,
      });
      expect({ algorithm, length: decoded.signature.length }).toEqual({
        algorithm,
        length: signatureLength,
      });
    }
  });

  it('puts the key’s identifiers in the header and the client in the claims', async () => {
    const jwt = await createClientAssertion(
      { pkcs8: rsaKey.pkcs8, algorithm: 'RS256', kid: 'key-1', x5t: 'c2hhMQ', x5tS256: 'c2hh_-' },
      { clientId: 'picklist', audience: 'https://auth.contoso.com' },
      NOW_SECONDS + 0.75
    );
    const { header, payload } = decodeJwt(jwt);
    expect(Object.keys(header)).toEqual(['alg', 'typ', 'kid', 'x5t', 'x5t#S256']);
    expect(header).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'key-1',
      x5t: 'c2hhMQ',
      'x5t#S256': 'c2hh_-',
    });
    expect(payload).toEqual({
      iss: 'picklist',
      sub: 'picklist',
      aud: 'https://auth.contoso.com',
      jti: expect.stringMatching(UUID),
      iat: NOW_SECONDS,
      nbf: NOW_SECONDS - 30,
      exp: NOW_SECONDS + 300,
    });
  });

  it('leaves out identifiers the key doesn’t have, and never repeats a jti', async () => {
    const first = decodeJwt(await es256Assertion());
    const second = decodeJwt(await es256Assertion());
    expect(first.header).toEqual({ alg: 'ES256', typ: 'JWT' });
    expect(first.payload.jti).not.toBe(second.payload.jti);
  });

  it('imports each key once, as non-extractable', async () => {
    // Keys no other test signs with, so neither has been imported yet.
    const [fresh, other] = await Promise.all([
      testKey({ name: 'ECDSA', namedCurve: 'P-256' }),
      testKey({ name: 'ECDSA', namedCurve: 'P-256' }),
    ]);
    const importKey = vi.spyOn(subtle, 'importKey');
    const claims = { clientId: 'picklist', audience: TOKEN_URL };
    await createClientAssertion({ pkcs8: fresh.pkcs8, algorithm: 'ES256' }, claims, NOW_SECONDS);
    await createClientAssertion(
      { pkcs8: fresh.pkcs8, algorithm: 'ES256', kid: 'same key' },
      claims,
      NOW_SECONDS
    );
    expect(importKey).toHaveBeenCalledTimes(1);
    expect(importKey.mock.calls[0]?.[3]).toBe(false);
    await createClientAssertion({ pkcs8: other.pkcs8, algorithm: 'ES256' }, claims, NOW_SECONDS);
    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it('refuses keys that can’t be used, without saying anything about them', async () => {
    const claims = { clientId: 'picklist', audience: TOKEN_URL };
    const unknownAlgorithm: SigningKey = { pkcs8: rsaKey.pkcs8, algorithm: 'RS256' };
    // Extension data can hold anything, including an algorithm REST Picklist doesn't have.
    Reflect.set(unknownAlgorithm, 'algorithm', 'HS256');
    const importKey = vi.spyOn(subtle, 'importKey');
    const keys: SigningKey[] = [
      { pkcs8: p256Key.pkcs8, algorithm: 'RS256' },
      { pkcs8: rsaKey.pkcs8, algorithm: 'ES256' },
      { pkcs8: p256Key.pkcs8, algorithm: 'ES384' },
      { pkcs8: 'bm90IGEga2V5', algorithm: 'PS256' },
      unknownAlgorithm,
    ];
    for (const key of keys) {
      const error = await failure(createClientAssertion(key, claims, NOW_SECONDS));
      expect(error).toMatchObject({
        kind: 'config',
        message:
          'The signing key can’t be used. Ask an administrator to enter it again in Organization settings › Extensions › REST Picklist.',
      });
    }
    // Failed imports aren't kept: the next try imports again.
    const imports = importKey.mock.calls.length;
    await failure(
      createClientAssertion({ pkcs8: p256Key.pkcs8, algorithm: 'RS256' }, claims, NOW_SECONDS)
    );
    expect(importKey.mock.calls.length).toBe(imports + 1);
  });

  it('refuses RSA keys shorter than 2048 bits', async () => {
    const short = await testKey({ ...RSA_2048, modulusLength: 1024 });
    await expect(
      createClientAssertion(
        { pkcs8: short.pkcs8, algorithm: 'RS256' },
        { clientId: 'picklist', audience: TOKEN_URL },
        NOW_SECONDS
      )
    ).rejects.toThrow(/RSA keys need at least 2048 bits/);
  });
});

describe('buildTokenRequest', () => {
  it('sends the secret in a Basic header, form-encoded first, and not in the body', async () => {
    const request = await buildTokenRequest(
      settings({ clientId: 'my client', scope: ' read   write ' }),
      CLIENT_SECRET
    );
    expect(request).toEqual({
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        // enc(x) = encodeURIComponent(x) with "+" for spaces (RFC 6749 §2.3.1).
        Authorization: `Basic ${btoa('my+client:p%40ss%3Aw%C3%B6rd%2B%2F~+tail')}`,
      },
      body: 'grant_type=client_credentials&scope=read+write',
    });
    expect(request.body).not.toContain('client_secret');
    expect(request.body).not.toContain('client_id');
    // RFC 7617's example, form-encoded.
    const aladdin = await buildTokenRequest(settings({ clientId: 'Aladdin' }), {
      kind: 'clientSecret',
      value: 'open sesame',
    });
    expect(aladdin.headers.Authorization).toBe('Basic QWxhZGRpbjpvcGVuK3Nlc2FtZQ==');
  });

  it('sends the client ID and secret in the body when asked', async () => {
    const request = await buildTokenRequest(
      settings({
        clientId: 'my client',
        clientAuthentication: 'body',
        scope: 'read',
        audience: 'https://api.contoso.com',
        resource: 'urn:contoso:api',
        extraParams: { tenant: 'contoso' },
      }),
      CLIENT_SECRET
    );
    expect(request.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    expect(request.body).toBe(
      'grant_type=client_credentials&client_id=my+client&client_secret=p%40ss%3Aw%C3%B6rd%2B%2F%7E+tail&scope=read&audience=https%3A%2F%2Fapi.contoso.com&resource=urn%3Acontoso%3Aapi&tenant=contoso'
    );
  });

  it('sends a signed JWT instead of a secret', async () => {
    const request = await buildTokenRequest(
      settings({
        tokenUrl: `${TOKEN_URL}?tenant=contoso#ignored`,
        clientAuthentication: 'privateKeyJwt',
        scope: 'read',
      }),
      signingSecret(rsaKey, 'PS256', { kid: 'key-1' }),
      { now: () => NOW_SECONDS * 1000 }
    );
    expect(request.url).toBe(`${TOKEN_URL}?tenant=contoso`);
    expect(request.headers).not.toHaveProperty('Authorization');
    const body = new URLSearchParams(request.body);
    expect([...body.keys()]).toEqual([
      'grant_type',
      'client_id',
      'client_assertion_type',
      'client_assertion',
      'scope',
    ]);
    expect(body.get('client_id')).toBe('picklist');
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    );
    const assertion = body.get('client_assertion') ?? '';
    const { header, payload } = decodeJwt(assertion);
    expect(header).toEqual({ alg: 'PS256', typ: 'JWT', kid: 'key-1' });
    // The audience is the token URL without its query string or fragment.
    expect(payload).toMatchObject({ aud: TOKEN_URL, iss: 'picklist', iat: NOW_SECONDS });
    expect(await verifies(assertion, rsaKey.spki, 'PS256')).toBe(true);
  });

  it('uses the assertion audience when it’s set', async () => {
    const request = await buildTokenRequest(
      settings({
        clientAuthentication: 'privateKeyJwt',
        assertionAudience: ' https://auth.contoso.com/realms/picklist ',
      }),
      signingSecret(p384Key, 'ES384')
    );
    const assertion = new URLSearchParams(request.body).get('client_assertion') ?? '';
    expect(decodeJwt(assertion).payload.aud).toBe('https://auth.contoso.com/realms/picklist');
    expect(await verifies(assertion, p384Key.spki, 'ES384')).toBe(true);
  });

  it('never lets extra parameters replace the ones it sets', async () => {
    const request = await buildTokenRequest(
      settings({
        clientAuthentication: 'body',
        extraParams: {
          client_secret: 'replaced',
          Scope: 'admin',
          GRANT_TYPE: 'password',
          tenant: 'contoso',
          ' tenant': 'twice',
          'bad name': 'x',
        },
      }),
      CLIENT_SECRET
    );
    const body = new URLSearchParams(request.body);
    expect(body.getAll('client_secret')).toEqual([SECRET]);
    expect(body.getAll('grant_type')).toEqual(['client_credentials']);
    expect(body.has('Scope')).toBe(false);
    expect(body.getAll('tenant')).toEqual(['contoso']);
    expect(body.has('bad name')).toBe(false);
  });

  it('cleans pasted line breaks out of the secret', async () => {
    const request = await buildTokenRequest(settings({ clientAuthentication: 'body' }), {
      kind: 'clientSecret',
      value: 's3cret\r\n',
    });
    expect(new URLSearchParams(request.body).get('client_secret')).toBe('s3cret');
  });

  it('refuses a secret of the wrong kind, without showing it', async () => {
    for (const [clientAuthentication, secret] of [
      ['basic', signingSecret(p256Key, 'ES256')],
      ['body', { kind: 'password', value: SECRET }],
      ['privateKeyJwt', CLIENT_SECRET],
    ] as const) {
      const error = await failure(buildTokenRequest(settings({ clientAuthentication }), secret));
      expect(error.kind).toBe('config');
      expect(error.message).toMatch(/secret doesn’t match how it signs in/);
      expect(error.message).not.toContain(SECRET);
    }
  });

  it('refuses settings it can’t send', async () => {
    await expect(
      buildTokenRequest(settings({ tokenUrl: 'not a url' }), CLIENT_SECRET)
    ).rejects.toThrow('The access token URL isn’t valid.');
    await expect(buildTokenRequest(settings({ clientId: '' }), CLIENT_SECRET)).rejects.toThrow(
      'Add the client ID for OAuth 2.0.'
    );
  });
});

describe('parseTokenResponse', () => {
  const NOW = 1_000_000;
  const parse = (body: unknown, status = 200) =>
    parseTokenResponse(status, typeof body === 'string' ? body : JSON.stringify(body), NOW);
  const parseError = (body: unknown, status = 200) => thrown(() => parse(body, status));
  const lifetime = (expiresIn: unknown) =>
    (parse({ access_token: 'abc', expires_in: expiresIn }).expiresAt - NOW) / 1000;

  it('reads the token, a minute short of its expiry, and the scope', () => {
    expect(
      parse({ access_token: 'abc', token_type: 'Bearer', expires_in: 3600, scope: 'read' })
    ).toEqual({ accessToken: 'abc', expiresAt: NOW + 3_540_000, scope: 'read' });
    expect(parse({ access_token: 'abc', token_type: 'bearer', expires_in: '3600' })).toEqual({
      accessToken: 'abc',
      expiresAt: NOW + 3_540_000,
    });
    expect(parse({ access_token: 'abc', token_type: 'BEARER', expires_in: ' 120 ' })).toEqual({
      accessToken: 'abc',
      expiresAt: NOW + 60_000,
    });
  });

  it('uses short-lived tokens for at least 30 seconds, but never past their expiry', () => {
    expect(lifetime(90)).toBe(30);
    expect(lifetime(45)).toBe(30);
    expect(lifetime(20)).toBe(20);
    // Unknown or nonsense expiry: five minutes.
    for (const unknown of [undefined, null, 0, -5, 'soon', '1e3', '', Number.NaN, {}]) {
      expect({ unknown, seconds: lifetime(unknown) }).toEqual({ unknown, seconds: 300 });
    }
    // However long the token service says, at most a day.
    expect(lifetime(10 ** 12)).toBe(86_400);
  });

  it('needs a non-empty access token', () => {
    for (const body of [{}, { access_token: '' }, { access_token: 42 }, [], 'null', '"abc"']) {
      expect(parseError(body)).toMatchObject({
        kind: 'shape',
        message: 'The token service didn’t return an access token.',
      });
    }
  });

  it('accepts only bearer tokens', () => {
    expect(parse({ access_token: 'abc', token_type: '' }).accessToken).toBe('abc');
    expect(parse({ access_token: 'abc', token_type: null }).accessToken).toBe('abc');
    expect(parseError({ access_token: 'abc', token_type: 'DPoP' }).message).toBe(
      'The token service returned a “DPoP” token, but only bearer tokens can be used.'
    );
    expect(
      parseError({ access_token: 'abc', token_type: `mac${RIGHT_TO_LEFT_OVERRIDE}\n` }).message
    ).toBe('The token service returned a “mac” token, but only bearer tokens can be used.');
    expect(parseError({ access_token: 'abc', token_type: 1 }).message).toMatch(
      /only bearer tokens can be used/
    );
  });

  it('refuses tokens that can’t be sent, without repeating them', () => {
    const long = `eyJ${'a'.repeat(16_381)}`;
    expect(parse({ access_token: long }).accessToken).toHaveLength(16_384);
    expect(parseError({ access_token: `${long}b` }).message).toBe(
      'The access token is longer than 16 KB, so it can’t be sent to the API.'
    );
    for (const token of ['tokén', 'tok\nen', '“token”']) {
      const refused = parseError({ access_token: token });
      expect(refused.message).toBe(
        'The access token contains characters that can’t be sent to the API.'
      );
      expect(refused.message).not.toContain(token);
    }
  });

  it('explains error answers with a short, clean description', () => {
    expect(
      parseError(
        {
          error: 'invalid_client',
          error_description: `Client authentication failed.\r\nTrace ID: 1${NUL}${RIGHT_TO_LEFT_OVERRIDE}`,
        },
        401
      )
    ).toMatchObject({
      kind: 'http',
      status: 401,
      message:
        'The token service refused the request (invalid_client: Client authentication failed. Trace ID: 1).',
    });
    const long = parseError({ error: 'invalid_scope', error_description: 'x'.repeat(500) }, 400);
    const description = /\(invalid_scope: (.*)\)\.$/.exec(long.message)?.[1] ?? '';
    expect(Array.from(description)).toHaveLength(200);
    expect(description.endsWith('…')).toBe(true);
    expect(parseError({ error: 'unauthorized_client' }, 403).message).toBe(
      'The token service refused the request (unauthorized_client).'
    );
    // Some services report errors with 200 OK.
    expect(parseError({ error: 'invalid_grant' })).toMatchObject({
      message: 'The token service refused the request (invalid_grant).',
      status: undefined,
    });
  });

  it('explains other failures by status', () => {
    expect(parseError('', 401).message).toBe('The token service refused the request (401).');
    expect(parseError('<html>Forbidden</html>', 403).message).toBe(
      'The token service refused the request (403).'
    );
    expect(parseError({ message: 'no' }, 400).message).toBe(
      'The token service refused the request (400).'
    );
    expect(parseError('', 404).message).toBe(
      'The token URL wasn’t found (404). Check the address.'
    );
    expect(parseError('', 429).message).toBe('The token service is limiting requests (429).');
    expect(parseError({ error: 'server_error' }, 503)).toMatchObject({
      message: 'The token service had a problem (503).',
      status: 503,
    });
    expect(parseError('', 418).message).toBe('The token service returned an error (418).');
    expect(parseError({ error: 'teapot' }, 418).message).toBe(
      'The token service refused the request (teapot).'
    );
  });

  it('explains answers that aren’t JSON', () => {
    expect(parseError('access_token=abc&token_type=bearer')).toMatchObject({
      kind: 'parse',
      message: 'The token URL didn’t return JSON.',
    });
    expect(parseError('  <!doctype html><title>Sign in</title>').message).toBe(
      'The token URL didn’t return JSON. It sent a web page, so check the address.'
    );
    expect(parseError(`{"access_token":"${'a'.repeat(1_000_001)}"}`).message).toBe(
      'The token URL’s answer is too large to be a token.'
    );
  });

  it('cuts anything sensitive out of what it repeats', () => {
    const error = thrown(() =>
      parseTokenResponse(
        401,
        JSON.stringify({
          error: 'invalid_client',
          error_description: `Unknown secret ${SECRET} for client`,
        }),
        NOW,
        [SECRET]
      )
    );
    expect(error.message).toBe(
      'The token service refused the request (invalid_client: Unknown secret … for client).'
    );
  });
});

describe('requestAccessToken', () => {
  it('posts the token request without cookies or redirects', async () => {
    const fetchImpl = tokenService({ expires_in: 3600, scope: 'read' });
    const token = await requestAccessToken(
      settings({ scope: 'read' }),
      CLIENT_SECRET,
      DEFAULT_POLICY,
      { fetchImpl, now: () => 5_000 }
    );
    expect(token).toEqual({ accessToken: 'token-1', expiresAt: 5_000 + 3_540_000, scope: 'read' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${btoa('picklist:p%40ss%3Aw%C3%B6rd%2B%2F~+tail')}`,
      },
      body: 'grant_type=client_credentials&scope=read',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
  });

  it('stops reading a token answer that keeps coming, at 1 MB', async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(endless, { status: 200 }));
    await expect(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })
    ).rejects.toMatchObject({
      kind: 'parse',
      message: 'The token URL’s answer is too large to be a token.',
    });
    expect(pulls).toBeLessThanOrEqual(17);
    // An error answer that's too large is explained by its status.
    const huge = vi.fn<typeof fetch>(
      async () =>
        new Response('x', { status: 500, headers: { 'Content-Length': String(5_000_000) } })
    );
    await expect(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl: huge })
    ).rejects.toMatchObject({ message: 'The token service had a problem (500).' });
  });

  it('gets a token with a signed JWT', async () => {
    const fetchImpl = tokenService();
    await requestAccessToken(
      settings({ clientAuthentication: 'privateKeyJwt' }),
      signingSecret(p256Key, 'ES256'),
      DEFAULT_POLICY,
      { fetchImpl }
    );
    const body = sentBody(fetchImpl.mock.calls[0]?.[1]);
    expect(body.has('client_secret')).toBe(false);
    expect(await verifies(body.get('client_assertion') ?? '', p256Key.spki, 'ES256')).toBe(true);
  });

  it('checks the policy and the settings before sending the secret', async () => {
    const fetchImpl = tokenService();
    const refused = async (oauth: OAuthSettings, rules: SecurityPolicy) => {
      const error = await failure(requestAccessToken(oauth, CLIENT_SECRET, rules, { fetchImpl }));
      expect(error.kind).toBe('config');
      return error.message;
    };
    expect(await refused(settings(), policy({ allowedAuthMethods: ['none', 'bearer'] }))).toBe(
      'Your organization’s security policy doesn’t allow the “OAuth 2.0” sign-in method. Use None or Bearer token.'
    );
    expect(await refused(settings(), policy({ allowedHosts: ['api.contoso.com'] }))).toBe(
      'auth.contoso.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(
      await refused(settings({ tokenUrl: 'http://auth.contoso.com/token' }), DEFAULT_POLICY)
    ).toBe('The access token URL must use https://.');
    expect(await refused(settings({ clientId: '' }), DEFAULT_POLICY)).toBe(
      'Add the client ID for OAuth 2.0.'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the secret only where it was saved for, when told', async () => {
    const fetchImpl = tokenService();
    const error = await failure(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
        fetchImpl,
        boundOrigin: 'https://old-auth.contoso.com',
      })
    );
    expect(error).toMatchObject({
      kind: 'config',
      message:
        'This configuration’s address changed after its secret was saved. Ask an administrator to enter the secret again.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
      fetchImpl,
      boundOrigin: 'https://auth.contoso.com',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('explains a token URL that can’t be reached, and Entra ID’s rule', async () => {
    const error = await failure(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl: offline })
    );
    expect(error).toMatchObject({
      kind: 'network',
      message:
        'Couldn’t reach the token URL. It must allow requests from Azure DevOps (CORS). Redirects aren’t followed here, so use the final address.',
    });
    const entra = await failure(
      requestAccessToken(settings({ tokenUrl: ENTRA_TOKEN_URL }), CLIENT_SECRET, DEFAULT_POLICY, {
        fetchImpl: offline,
      })
    );
    expect(entra.message).toBe(
      `Couldn’t reach the token URL. It must allow requests from Azure DevOps (CORS). ${ENTRA_BROWSER_WARNING}`
    );
  });

  it('adds Entra ID’s rule when Entra refuses the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json(
        {
          error: 'invalid_request',
          error_description: 'AADSTS9002326: Cross-origin token redemption is not permitted.',
        },
        400
      )
    );
    const error = await failure(
      requestAccessToken(settings({ tokenUrl: ENTRA_TOKEN_URL }), CLIENT_SECRET, DEFAULT_POLICY, {
        fetchImpl,
      })
    );
    expect(error).toMatchObject({
      kind: 'http',
      status: 400,
      message: `The token service refused the request (invalid_request: AADSTS9002326: Cross-origin token redemption is not permitted.). ${ENTRA_BROWSER_WARNING}`,
    });
  });

  it('never repeats the secret or the signed JWT from an error answer', async () => {
    const echo = vi.fn<typeof fetch>(async (_url, init) =>
      json({ error: 'invalid_client', error_description: `Got ${sentBody(init).toString()}` }, 401)
    );
    for (const [oauth, secret] of [
      [settings({ clientAuthentication: 'body' }), CLIENT_SECRET],
      [settings({ clientAuthentication: 'privateKeyJwt' }), signingSecret(p256Key, 'ES256')],
    ] as const) {
      const error = await failure(
        requestAccessToken(oauth, secret, DEFAULT_POLICY, { fetchImpl: echo })
      );
      const sent = sentBody(echo.mock.lastCall?.[1]);
      const sensitive = [sent.get('client_secret'), sent.get('client_assertion')].filter(
        (value): value is string => Boolean(value)
      );
      expect(sensitive).toHaveLength(1);
      expect(error.message).toMatch(/^The token service refused the request \(invalid_client: /);
      for (const value of sensitive) {
        expect(error.message).not.toContain(value.slice(0, 20));
      }
      expect(error.message).not.toContain(SECRET);
    }
    const basicEcho = vi.fn<typeof fetch>(async (_url, init) =>
      json(
        {
          error: 'invalid_client',
          error_description: `Bad header ${new Headers(init?.headers).get('Authorization')}`,
        },
        401
      )
    );
    const basic = await failure(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl: basicEcho })
    );
    expect(basic.message).toBe(
      'The token service refused the request (invalid_client: Bad header Basic …).'
    );
  });

  it('refuses redirects', async () => {
    const redirected = vi.fn<typeof fetch>(async () => {
      const response = json({ access_token: 'abc' });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    const movedTo = vi.fn<typeof fetch>(async () => {
      const response = json({ access_token: 'abc' });
      Object.defineProperty(response, 'url', { value: 'https://elsewhere.example/token' });
      return response;
    });
    for (const fetchImpl of [redirected, movedTo]) {
      const error = await failure(
        requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })
      );
      expect(error.message).toBe(
        'The token URL redirected the request. Redirects aren’t followed here, so use the final address as the access token URL.'
      );
    }
    // The same address, as a browser reports it, is fine.
    const same = vi.fn<typeof fetch>(async () => {
      const response = json({ access_token: 'abc' });
      Object.defineProperty(response, 'url', { value: TOKEN_URL });
      return response;
    });
    await expect(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl: same })
    ).resolves.toMatchObject({ accessToken: 'abc' });
  });

  it('gives up after the timeout', async () => {
    const error = await failure(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
        fetchImpl: neverResponds,
        timeoutMs: 10,
      })
    );
    expect(error).toMatchObject({
      kind: 'timeout',
      message: 'The token service took too long to respond.',
    });
  });

  it('can be cancelled before or during the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(neverResponds);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
        fetchImpl,
        signal: cancelled.signal,
      })
    ).rejects.toMatchObject({ kind: 'aborted', message: 'The request was cancelled.' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const controller = new AbortController();
    const pending = requestAccessToken(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
      fetchImpl,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('TokenCache', () => {
  const now = { value: 1_000_000 };
  const clock = () => now.value;

  it('reuses a token until a minute before it expires', async () => {
    now.value = 1_000_000;
    const cache = new TokenCache({ now: clock });
    const fetchImpl = tokenService({ expires_in: 3600 });
    const first = await cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl });
    expect(first).toEqual({ accessToken: 'token-1', expiresAt: 1_000_000 + 3_540_000 });
    now.value = first.expiresAt - 1;
    await expect(cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })).resolves.toBe(
      first
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now.value = first.expiresAt;
    await expect(
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })
    ).resolves.toMatchObject({ accessToken: 'token-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one request between callers asking at once', async () => {
    const cache = new TokenCache();
    const service = heldTokenService();
    const asks = [1, 2, 3].map(() =>
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl: service.fetchImpl })
    );
    await vi.waitFor(() => expect(service.fetchImpl).toHaveBeenCalledTimes(1));
    service.release();
    const tokens = await Promise.all(asks);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]?.accessToken).toBe('token-1');
    expect(service.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets one caller stop waiting without cancelling the shared request', async () => {
    const cache = new TokenCache();
    const service = heldTokenService();
    const controller = new AbortController();
    const leaving = cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
      fetchImpl: service.fetchImpl,
      signal: controller.signal,
    });
    const staying = cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
      fetchImpl: service.fetchImpl,
    });
    await vi.waitFor(() => expect(service.fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(leaving).rejects.toMatchObject({ kind: 'aborted' });
    expect(service.fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    service.release();
    await expect(staying).resolves.toMatchObject({ accessToken: 'token-1' });
    // The token was kept for the next caller.
    await cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl: service.fetchImpl });
    expect(service.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forgets a token the API refused, and only that token', async () => {
    const cache = new TokenCache();
    const fetchImpl = tokenService();
    const first = await cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl });
    await cache.invalidate(settings(), CLIENT_SECRET);
    const second = await cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl });
    expect(second.accessToken).toBe('token-2');
    // A late report about the first token doesn't drop the newer one.
    await cache.invalidate(settings(), CLIENT_SECRET, first.accessToken);
    await expect(cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })).resolves.toBe(
      second
    );
    await cache.invalidate(settings(), CLIENT_SECRET, second.accessToken);
    await expect(
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })
    ).resolves.toMatchObject({ accessToken: 'token-3' });
  });

  it('keeps different secrets and settings apart', async () => {
    const cache = new TokenCache();
    const fetchImpl = tokenService();
    const ask = (oauth: OAuthSettings, secret: StoredSecret) =>
      cache.get(oauth, secret, DEFAULT_POLICY, { fetchImpl });
    const tokens = [
      await ask(settings(), CLIENT_SECRET),
      await ask(settings(), { kind: 'clientSecret', value: 'another secret' }),
      await ask(settings({ scope: 'admin' }), CLIENT_SECRET),
      await ask(settings({ clientAuthentication: 'body' }), CLIENT_SECRET),
      await ask(settings({ extraParams: { tenant: 'a' } }), CLIENT_SECRET),
    ];
    expect(new Set(tokens.map((token) => token.accessToken)).size).toBe(5);
    // The order of extra parameters doesn't make a different token.
    const one = await ask(settings({ extraParams: { a: '1', b: '2' } }), CLIENT_SECRET);
    const same = await ask(settings({ extraParams: { b: '2', a: '1' } }), CLIENT_SECRET);
    expect(same).toBe(one);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('finds tokens by fingerprint, never by the secret', async () => {
    const cache = new TokenCache();
    await cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl: tokenService() });
    await cache.get(
      settings({ clientAuthentication: 'privateKeyJwt' }),
      signingSecret(p256Key, 'ES256'),
      DEFAULT_POLICY,
      { fetchImpl: tokenService() }
    );
    const keys = entryKeys(cache);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('doesn’t keep failures', async () => {
    const cache = new TokenCache();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(offline)
      .mockImplementation(async () => json({ access_token: 'abc' }));
    await expect(
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })
    ).rejects.toMatchObject({ kind: 'network' });
    await expect(
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })
    ).resolves.toMatchObject({ accessToken: 'abc' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks again when told to refresh, and forgets everything when cleared', async () => {
    const cache = new TokenCache();
    const fetchImpl = tokenService();
    await cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl });
    await expect(
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl, refresh: true })
    ).resolves.toMatchObject({ accessToken: 'token-2' });
    cache.clear();
    expect(entryKeys(cache)).toEqual([]);
    await expect(
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl })
    ).resolves.toMatchObject({ accessToken: 'token-3' });
  });

  it('keeps a bounded number of tokens', async () => {
    const cache = new TokenCache({ maxEntries: 2 });
    const fetchImpl = tokenService();
    for (const clientId of ['a', 'b', 'c']) {
      await cache.get(settings({ clientId }), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl });
    }
    expect(entryKeys(cache)).toHaveLength(2);
    // The oldest went first.
    await cache.get(settings({ clientId: 'a' }), CLIENT_SECRET, DEFAULT_POLICY, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('checks the policy before asking for a token', async () => {
    const cache = new TokenCache();
    const fetchImpl = tokenService();
    await expect(
      cache.get(settings(), CLIENT_SECRET, policy({ allowedAuthMethods: ['none'] }), {
        fetchImpl,
      })
    ).rejects.toMatchObject({ kind: 'config' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(entryKeys(cache)).toEqual([]);
  });

  it('doesn’t start when the caller already gave up', async () => {
    const cache = new TokenCache();
    const fetchImpl = tokenService();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cache.get(settings(), CLIENT_SECRET, DEFAULT_POLICY, {
        fetchImpl,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('has one shared instance for the form control', () => {
    expect(sharedTokenCache).toBeInstanceOf(TokenCache);
  });
});
