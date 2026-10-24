import { describe, expect, it } from 'vitest';
import type { AdvancedSettings } from './config';
import { DEFAULT_ADVANCED, LIMITS } from './config';
import type { SecurityPolicy } from './policy';
import {
  DEFAULT_POLICY,
  POLICY_VERSION,
  checkAuthMethod,
  checkEndpoint,
  checkTokenUrl,
  effectiveLimits,
  hostMatches,
  isPrivateHost,
  parsePolicy,
  validateHostPattern,
} from './policy';

function policy(overrides: Partial<SecurityPolicy>): SecurityPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

function advanced(overrides: Partial<AdvancedSettings>): AdvancedSettings {
  return { ...DEFAULT_ADVANCED, ...overrides };
}

const CORRECT = { privateHosts: [], publicHosts: [] };

/** The hosts classified wrongly, so a failure names the culprits. */
function misclassified(privateHosts: readonly string[], publicHosts: readonly string[]) {
  return {
    privateHosts: privateHosts.filter((host) => !isPrivateHost(host)),
    publicHosts: publicHosts.filter((host) => isPrivateHost(host)),
  };
}

describe('parsePolicy', () => {
  it('falls back to the defaults for anything missing or malformed', () => {
    expect(parsePolicy(null)).toBe(DEFAULT_POLICY);
    expect(parsePolicy({ maxPages: 'lots', allowedAuthMethods: 'basic' })).toMatchObject({
      maxPages: DEFAULT_POLICY.maxPages,
      allowedAuthMethods: DEFAULT_POLICY.allowedAuthMethods,
    });
  });

  it('normalizes hosts and clamps limits', () => {
    const parsed = parsePolicy({
      allowedHosts: [' API.Example.com ', 'api.example.com', 3, ''],
      allowedAuthMethods: ['bearer', 'magic'],
      maxItems: 1e9,
      allowLocalhost: 'yes',
    });
    expect(parsed.allowedHosts).toEqual(['api.example.com']);
    expect(parsed.allowedAuthMethods).toEqual(['bearer']);
    expect(parsed.maxItems).toBe(LIMITS.maxItems.max);
    expect(parsed.allowLocalhost).toBe(false);
  });

  it('allows every sign-in method by default, OAuth 2.0 included', () => {
    expect(DEFAULT_POLICY.version).toBe(2);
    expect(POLICY_VERSION).toBe(2);
    expect(DEFAULT_POLICY.allowedAuthMethods).toEqual([
      'none',
      'basic',
      'bearer',
      'apiKey',
      'oauth2',
    ]);
    expect(DEFAULT_POLICY.allowSavedConfigurations).toBe(true);
    expect(parsePolicy({}).allowedAuthMethods).toEqual(DEFAULT_POLICY.allowedAuthMethods);
  });

  it('lets a version 1 policy that allowed every method of its time allow OAuth 2.0', () => {
    const all = ['bearer', 'none', 'apiKey', 'basic'];
    for (const stored of [
      { version: 1, allowedAuthMethods: all },
      { allowedAuthMethods: all },
      { version: '1', allowedAuthMethods: [...all, 'magic'] },
    ]) {
      expect(parsePolicy(stored)).toMatchObject({
        version: 2,
        allowedAuthMethods: [...all, 'oauth2'],
      });
    }
    // Reading the result again changes nothing, so a cached copy stays the same.
    const migrated = parsePolicy({ version: 1, allowedAuthMethods: all });
    expect(parsePolicy(migrated)).toEqual(migrated);
  });

  it('keeps any other version 1 list as it was saved', () => {
    expect(
      parsePolicy({ version: 1, allowedAuthMethods: ['none', 'bearer', 'apiKey'] })
        .allowedAuthMethods
    ).toEqual(['none', 'bearer', 'apiKey']);
    expect(parsePolicy({ version: 1, allowedAuthMethods: [] }).allowedAuthMethods).toEqual([]);
    expect(
      parsePolicy({ version: 1, allowedAuthMethods: ['basic', 'oauth2'] }).allowedAuthMethods
    ).toEqual(['basic', 'oauth2']);
  });

  it('keeps a version 2 list exactly as saved', () => {
    const fourOnly = ['none', 'basic', 'bearer', 'apiKey'];
    expect(parsePolicy({ version: 2, allowedAuthMethods: fourOnly }).allowedAuthMethods).toEqual(
      fourOnly
    );
    expect(parsePolicy({ version: 3, allowedAuthMethods: fourOnly }).allowedAuthMethods).toEqual(
      fourOnly
    );
    expect(
      parsePolicy({ version: 2, allowedAuthMethods: ['oauth2', 'oauth2'] }).allowedAuthMethods
    ).toEqual(['oauth2']);
  });

  it('never changes the defaults it falls back to', () => {
    const before = [...DEFAULT_POLICY.allowedAuthMethods];
    parsePolicy({ version: 1, allowedAuthMethods: 'all' });
    parsePolicy({ version: 1 });
    expect(DEFAULT_POLICY.allowedAuthMethods).toEqual(before);
  });

  it('keeps the 3.0 saved configurations switch for older controls', () => {
    expect(parsePolicy({ allowSavedConfigurations: false }).allowSavedConfigurations).toBe(false);
    expect(parsePolicy({ version: 2 }).allowSavedConfigurations).toBe(true);
  });
});

describe('hostMatches', () => {
  it('matches exact names, ignoring case and a trailing dot', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('API.Example.COM', ' api.example.com ')).toBe(true);
    expect(hostMatches('api.example.com.', 'api.example.com')).toBe(true);
    expect(hostMatches('api.example.com', 'example.com')).toBe(false);
    expect(hostMatches('example.com', 'api.example.com')).toBe(false);
    expect(hostMatches('api.example.com.evil.net', 'api.example.com')).toBe(false);
  });

  it('matches wildcard subdomains at any depth, but not the domain itself', () => {
    expect(hostMatches('a.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('a.b.example.com', '*.EXAMPLE.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('badexample.com', '*.example.com')).toBe(false);
    expect(hostMatches('a.example.com.evil.net', '*.example.com')).toBe(false);
  });

  it('compares IP addresses and international names in canonical form', () => {
    expect(hostMatches('[::1]', '0:0:0:0:0:0:0:1')).toBe(true);
    expect(hostMatches('::1', '[::1]')).toBe(true);
    expect(hostMatches('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(hostMatches('xn--bcher-kva.example', 'bücher.example')).toBe(true);
  });

  it('never matches malformed patterns', () => {
    expect(hostMatches('api.example.com', '')).toBe(false);
    expect(hostMatches('api.example.com', '*')).toBe(false);
    expect(hostMatches('api.example.com', 'api.*.com')).toBe(false);
    expect(hostMatches('api.example.com', '*.*.com')).toBe(false);
    expect(hostMatches('api.example.com', 'api.example.com:8443')).toBe(false);
    expect(hostMatches('api.example.com', 'https://api.example.com')).toBe(false);
    expect(hostMatches('1.2.3.4', '*.3.4')).toBe(false);
    expect(hostMatches('', 'api.example.com')).toBe(false);
  });
});

describe('validateHostPattern', () => {
  it('accepts names, wildcards and IP addresses', () => {
    for (const pattern of ['api.example.com', '*.example.com', '10.0.0.1', '[::1]', '::1']) {
      expect(validateHostPattern(pattern)).toBeNull();
    }
  });

  it('explains what’s wrong', () => {
    expect(validateHostPattern(' ')).toMatch(/Enter a host name/);
    expect(validateHostPattern('https://api.example.com')).toMatch(/without https:\/\//);
    expect(validateHostPattern('api.example.com/items')).toMatch(/without https:\/\/ or a path/);
    expect(validateHostPattern('api.*.com')).toMatch(/wildcard can only start/);
    expect(validateHostPattern('*')).toMatch(/wildcard can only start/);
    expect(validateHostPattern('api.example.com:8443')).toMatch(/Leave out the port/);
    expect(validateHostPattern('exa mple.com')).toBe('“exa mple.com” isn’t a valid host name.');
    expect(validateHostPattern('user@api.example.com')).toMatch(/isn’t a valid host name/);
    expect(validateHostPattern('*.10.0.0.1')).toMatch(/not with IP addresses/);
    expect(validateHostPattern('*.com')).toMatch(/too many sites/);
  });
});

describe('isPrivateHost', () => {
  it('recognizes local and intranet names', () => {
    expect(
      misclassified(
        [
          'localhost',
          'LOCALHOST.',
          'app.localhost',
          'printer.local',
          'db.internal',
          'nas.home.arpa',
          'intranet',
        ],
        ['api.example.com', 'local.example.com', 'internal.example.com']
      )
    ).toEqual(CORRECT);
  });

  it('recognizes private IPv4 ranges, including their boundaries', () => {
    expect(
      misclassified(
        [
          '0.0.0.0',
          '10.0.0.1',
          '10.255.255.255',
          '127.0.0.1',
          '127.8.9.10',
          '100.64.0.1',
          '100.127.255.255',
          '169.254.169.254',
          '172.16.0.0',
          '172.31.255.255',
          '192.168.1.1',
        ],
        [
          '8.8.8.8',
          '1.1.1.1',
          '100.63.255.255',
          '100.128.0.0',
          '169.253.1.1',
          '172.15.255.255',
          '172.32.0.0',
          '192.167.1.1',
          '11.0.0.1',
        ]
      )
    ).toEqual(CORRECT);
  });

  it('sees through other ways of writing IPv4 addresses', () => {
    // The browser reads all of these as 127.0.0.1 or 10.0.0.1.
    expect(isPrivateHost('0x7f.1')).toBe(true);
    expect(isPrivateHost('2130706433')).toBe(true);
    expect(isPrivateHost('012.0.0.1')).toBe(true);
    expect(isPrivateHost('10.1')).toBe(true);
  });

  it('recognizes private IPv6 ranges and IPv4-mapped addresses', () => {
    expect(
      misclassified(
        [
          '[::1]',
          '::1',
          '::',
          '[0:0:0:0:0:0:0:1]',
          'fc00::1',
          '[fd12:3456:789a::1]',
          'fe80::1',
          '[febf::1]',
          'fec0::1',
          '[::ffff:127.0.0.1]',
          '[::ffff:7f00:1]',
          '::ffff:10.0.0.1',
          '[::ffff:c0a8:101]',
          '[::ffff:0:a00:1]',
          '[::127.0.0.1]',
        ],
        [
          '[2001:4860:4860::8888]',
          '2606:4700::1111',
          '[::ffff:8.8.8.8]',
          '[::ffff:808:808]',
          '[fbff::1]',
          '[ff02::1]',
        ]
      )
    ).toEqual(CORRECT);
  });

  it('doesn’t mistake names that contain numbers for addresses', () => {
    expect(isPrivateHost('10.0.0.1.example.com')).toBe(false);
    expect(isPrivateHost('fd00.example.com')).toBe(false);
    expect(isPrivateHost('')).toBe(false);
  });

  it('handles long hostile input quickly', () => {
    const started = performance.now();
    isPrivateHost(`${'1.'.repeat(50_000)}1`);
    isPrivateHost(`${':'.repeat(50_000)}1`);
    isPrivateHost(`[${'0:'.repeat(50_000)}]`);
    hostMatches('a'.repeat(50_000), `*.${'a.'.repeat(20_000)}com`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('checkEndpoint', () => {
  it('always allows https and never plain http elsewhere', () => {
    expect(checkEndpoint('https://api.example.com/items', DEFAULT_POLICY)).toBeNull();
    expect(checkEndpoint(new URL('https://api.example.com'), DEFAULT_POLICY)).toBeNull();
    expect(checkEndpoint('http://api.example.com', DEFAULT_POLICY)).toBe(
      'The endpoint must use https://.'
    );
    expect(checkEndpoint('http://api.example.com', policy({ allowLocalhost: true }))).toBe(
      'The endpoint must use https://.'
    );
    expect(checkEndpoint('ws://api.example.com', DEFAULT_POLICY)).toMatch(/must use https/);
    expect(checkEndpoint('not a url', DEFAULT_POLICY)).toMatch(/isn’t valid/);
    expect(checkEndpoint('https://u:p@api.example.com', DEFAULT_POLICY)).toMatch(/Remove the user/);
  });

  it('allows http only for localhost, and only when the policy does', () => {
    expect(checkEndpoint('http://localhost:3000', DEFAULT_POLICY)).toMatch(
      /doesn’t allow http:\/\/localhost/
    );
    const local = policy({ allowLocalhost: true });
    const urls = ['http://localhost:3000/a', 'http://127.0.0.1/a', 'http://[::1]/a'];
    expect(urls.map((url) => checkEndpoint(url, local))).toEqual([null, null, null]);
    expect(checkEndpoint('http://127.0.0.2/a', local)).toMatch(/must use https/);
    expect(checkEndpoint('http://app.localhost/a', local)).toMatch(/must use https/);
  });

  it('keeps allowed localhost usable with other restrictions', () => {
    const strict = policy({
      allowLocalhost: true,
      blockPrivateNetworks: true,
      allowedHosts: ['api.example.com'],
    });
    expect(checkEndpoint('http://localhost:3000/a', strict)).toBeNull();
    expect(checkEndpoint('https://10.0.0.1/a', strict)).toMatch(/allowed hosts/);
  });

  it('applies the list of allowed hosts', () => {
    const hosts = policy({ allowedHosts: ['api.example.com', '*.contoso.com'] });
    expect(checkEndpoint('https://api.example.com/items', hosts)).toBeNull();
    expect(checkEndpoint('https://eu.api.contoso.com/items', hosts)).toBeNull();
    expect(checkEndpoint('https://api.evil.com/items', hosts)).toBe(
      'api.evil.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(checkEndpoint('https://contoso.com/items', hosts)).toMatch(/allowed hosts/);
    expect(checkEndpoint('https://localhost/items', hosts)).toMatch(/allowed hosts/);
  });

  it('blocks private networks when the policy asks', () => {
    const closed = policy({ blockPrivateNetworks: true });
    expect(checkEndpoint('https://192.168.0.10/api', closed)).toBe(
      '192.168.0.10 is a private network address, and your organization’s security policy blocks those.'
    );
    expect(checkEndpoint('https://[::ffff:10.0.0.1]/api', closed)).toMatch(/private network/);
    expect(checkEndpoint('https://0x7f000001/api', closed)).toMatch(/127\.0\.0\.1 is a private/);
    expect(checkEndpoint('https://localhost/api', closed)).toMatch(/private network/);
    expect(checkEndpoint('https://intranet/api', closed)).toMatch(/private network/);
    expect(checkEndpoint('https://api.example.com/api', closed)).toBeNull();
    expect(checkEndpoint('https://192.168.0.10/api', DEFAULT_POLICY)).toBeNull();
  });
});

describe('checkTokenUrl', () => {
  it('applies the endpoint rules, naming the token URL', () => {
    expect(checkTokenUrl('https://auth.example.com/oauth2/token', DEFAULT_POLICY)).toBeNull();
    expect(checkTokenUrl('http://auth.example.com/token', DEFAULT_POLICY)).toBe(
      'The access token URL must use https://.'
    );
    expect(checkTokenUrl('not a url', DEFAULT_POLICY)).toBe('The access token URL isn’t valid.');
    expect(checkTokenUrl('https://id:secret@auth.example.com/token', DEFAULT_POLICY)).toMatch(
      /Remove the user name and password/
    );
    expect(checkTokenUrl('http://localhost:8080/token', DEFAULT_POLICY)).toMatch(
      /doesn’t allow http:\/\/localhost/
    );
    expect(
      checkTokenUrl('http://localhost:8080/token', policy({ allowLocalhost: true }))
    ).toBeNull();
    expect(
      checkTokenUrl('https://auth.evil.com/token', policy({ allowedHosts: ['*.example.com'] }))
    ).toBe(
      'auth.evil.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(checkTokenUrl('https://10.0.0.5/token', policy({ blockPrivateNetworks: true }))).toMatch(
      /private network address/
    );
  });
});

describe('checkAuthMethod', () => {
  it('allows the methods in the policy', () => {
    expect(checkAuthMethod('basic', DEFAULT_POLICY)).toBeNull();
    expect(checkAuthMethod('none', DEFAULT_POLICY)).toBeNull();
  });

  it('explains which methods can be used instead', () => {
    const tokens = policy({ allowedAuthMethods: ['apiKey', 'bearer'] });
    expect(checkAuthMethod('basic', tokens)).toBe(
      'Your organization’s security policy doesn’t allow the “Basic” sign-in method. Use Bearer token or API key.'
    );
    expect(checkAuthMethod('none', tokens)).toBe(
      'Your organization’s security policy requires signing in to the API. Use Bearer token or API key.'
    );
    expect(
      checkAuthMethod('bearer', policy({ allowedAuthMethods: ['none', 'basic', 'apiKey'] }))
    ).toMatch(/Use None, Basic or API key\.$/);
    expect(checkAuthMethod('none', policy({ allowedAuthMethods: [] }))).toMatch(
      /doesn’t allow any sign-in method/
    );
  });

  it('includes OAuth 2.0', () => {
    expect(checkAuthMethod('oauth2', DEFAULT_POLICY)).toBeNull();
    expect(checkAuthMethod('oauth2', policy({ allowedAuthMethods: ['none', 'apiKey'] }))).toBe(
      'Your organization’s security policy doesn’t allow the “OAuth 2.0” sign-in method. Use None or API key.'
    );
    expect(
      checkAuthMethod('basic', policy({ allowedAuthMethods: ['oauth2', 'bearer', 'apiKey'] }))
    ).toBe(
      'Your organization’s security policy doesn’t allow the “Basic” sign-in method. Use Bearer token, API key or OAuth 2.0.'
    );
    expect(checkAuthMethod('none', policy({ allowedAuthMethods: ['oauth2'] }))).toBe(
      'Your organization’s security policy requires signing in to the API. Use OAuth 2.0.'
    );
  });
});

describe('effectiveLimits', () => {
  it('uses the control’s settings within the policy’s caps', () => {
    expect(effectiveLimits(DEFAULT_ADVANCED, DEFAULT_POLICY)).toEqual({
      maxPages: LIMITS.maxPages.default,
      maxItems: LIMITS.maxItems.default,
      timeoutMs: LIMITS.timeoutSeconds.default * 1000,
    });
    const settings = advanced({
      paging: { type: 'nextLink', nextLink: '', maxPages: 50 },
      maxItems: 20_000,
      timeoutSeconds: 60,
    });
    expect(effectiveLimits(settings, DEFAULT_POLICY)).toEqual({
      maxPages: 50,
      maxItems: 20_000,
      timeoutMs: 60_000,
    });
    expect(
      effectiveLimits(settings, policy({ maxPages: 5, maxItems: 1000, timeoutSeconds: 10 }))
    ).toEqual({ maxPages: 5, maxItems: 1000, timeoutMs: 10_000 });
  });

  it('never goes past the built-in limits, even with malformed values', () => {
    const settings = advanced({ maxItems: Number.NaN, timeoutSeconds: 9999 });
    expect(
      effectiveLimits(settings, policy({ maxPages: Number.POSITIVE_INFINITY, maxItems: -5 }))
    ).toEqual({
      maxPages: LIMITS.maxPages.default,
      maxItems: LIMITS.maxItems.min,
      timeoutMs: LIMITS.timeoutSeconds.max * 1000,
    });
  });
});
