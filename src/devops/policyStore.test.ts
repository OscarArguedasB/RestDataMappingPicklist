import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import type { SecurityPolicy } from '../core/policy';
import { DEFAULT_POLICY, parsePolicy } from '../core/policy';
import type { ExtensionDataManager, ExtensionDataService } from './extensionData';
import { EXTENSION_DATA_SERVICE_ID } from './extensionData';
import { POLICY_KEY, loadPolicy, savePolicy } from './policyStore';
import type { DevOpsSdk } from './rest';

// The real SDK talks to the parent window as soon as it's imported.
vi.mock('azure-devops-extension-sdk', () => ({}));

const TOKEN = 'token-abc-123';
const EXTENSION_ID = 'OscarArguedasBarboza.RestDataMappingPicklist';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function fakeDevOps(initial?: unknown) {
  const stored = new Map<string, unknown>();
  if (initial !== undefined) {
    stored.set(POLICY_KEY, initial);
  }
  const getValue = vi.fn<ExtensionDataManager['getValue']>(async (key, options) =>
    stored.has(key) ? stored.get(key) : options?.defaultValue
  );
  const setValue = vi.fn<ExtensionDataManager['setValue']>(async (key, value) => {
    stored.set(key, value);
    return value;
  });
  const getExtensionDataManager = vi.fn<ExtensionDataService['getExtensionDataManager']>(
    async () => ({ getValue, setValue })
  );
  const host = { id: 'host-contoso', name: 'contoso' };
  const user = { displayName: 'Ada Lovelace', name: 'ada@contoso.com' };
  const sdk: DevOpsSdk = {
    getAccessToken: async () => TOKEN,
    getService: async (id) =>
      id === EXTENSION_DATA_SERVICE_ID ? { getExtensionDataManager } : undefined,
    getExtensionContext: () => ({ id: EXTENSION_ID }),
    getHost: () => host,
    getUser: () => user,
  };
  return { sdk, stored, getValue, setValue, getExtensionDataManager, host, user };
}

const STRICT: SecurityPolicy = {
  ...DEFAULT_POLICY,
  allowedHosts: ['api.contoso.com', '*.service-now.com'],
  allowedAuthMethods: ['none', 'bearer'],
  blockPrivateNetworks: true,
  maxPages: 5,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loadPolicy', () => {
  it('uses the built-in rules when nothing is saved', async () => {
    const devOps = fakeDevOps();
    await expect(loadPolicy({ sdk: devOps.sdk, storage: null })).resolves.toEqual(DEFAULT_POLICY);
    expect(devOps.getExtensionDataManager).toHaveBeenCalledWith(EXTENSION_ID, TOKEN);
    expect(devOps.getValue).toHaveBeenCalledWith('securityPolicy', {
      scopeType: 'Default',
      defaultValue: null,
    });
  });

  it('reads and checks the saved policy', async () => {
    const saved = {
      version: 1,
      allowedHosts: ['API.Contoso.com', 5, ' '],
      allowedAuthMethods: ['bearer', 'magic'],
      allowLocalhost: 'yes',
      blockPrivateNetworks: true,
      maxPages: 1000,
      extra: '<script>',
    };
    const policy = await loadPolicy({ sdk: fakeDevOps(saved).sdk, storage: null });
    expect(policy).toEqual(parsePolicy(saved));
    expect(policy).toMatchObject({
      allowedHosts: ['api.contoso.com'],
      allowedAuthMethods: ['bearer'],
      allowLocalhost: false,
      blockPrivateNetworks: true,
      maxPages: 100,
    });
    expect(policy).not.toHaveProperty('extra');
  });

  it('keeps the policy for five minutes per organization', async () => {
    const devOps = fakeDevOps(STRICT);
    const storage = memoryStorage();
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toEqual(STRICT);
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toEqual(STRICT);
    expect(devOps.getValue).toHaveBeenCalledTimes(1);

    await loadPolicy({ sdk: devOps.sdk, storage, fresh: true });
    expect(devOps.getValue).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await loadPolicy({ sdk: devOps.sdk, storage });
    expect(devOps.getValue).toHaveBeenCalledTimes(3);

    // Another organization in the same tab has its own policy.
    const other = fakeDevOps();
    other.host.id = 'host-fabrikam';
    await expect(loadPolicy({ sdk: other.sdk, storage })).resolves.toEqual(DEFAULT_POLICY);
    expect(other.getValue).toHaveBeenCalledTimes(1);
  });

  it('checks the cached copy before using it', async () => {
    const devOps = fakeDevOps(STRICT);
    const storage = memoryStorage();
    await loadPolicy({ sdk: devOps.sdk, storage });
    const [key] = [...storage.map.keys()];
    if (!key) {
      throw new Error('Expected a cache entry');
    }
    storage.setItem(key, JSON.stringify({ expires: Date.now() + 1000, data: 'relaxed' }));
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toEqual(STRICT);
    expect(devOps.getValue).toHaveBeenCalledTimes(2);

    storage.setItem(
      key,
      JSON.stringify({ expires: Date.now() + 1000, data: { maxPages: 'lots', allowedHosts: 'x' } })
    );
    // Malformed values in a cached object fall back to the defaults for those settings.
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toMatchObject({
      maxPages: DEFAULT_POLICY.maxPages,
      allowedHosts: [],
    });
  });

  it('doesn’t cache when the organization is unknown', async () => {
    const devOps = fakeDevOps(STRICT);
    const storage = memoryStorage();
    const sdk: DevOpsSdk = {
      ...devOps.sdk,
      getHost: () => {
        throw new Error('Not ready');
      },
    };
    await loadPolicy({ sdk, storage });
    await loadPolicy({ sdk, storage });
    expect(storage.map.size).toBe(0);
    expect(devOps.getValue).toHaveBeenCalledTimes(2);
  });

  it('falls back to the built-in rules when the policy can’t be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const devOps = fakeDevOps(STRICT);
    devOps.getValue.mockRejectedValueOnce(new Error('TF400898: An internal error occurred.'));
    const storage = memoryStorage();
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toEqual(DEFAULT_POLICY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    // A failure isn't cached: the next load tries again.
    expect(storage.map.size).toBe(0);
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toEqual(STRICT);
  });

  it('throws instead of falling back when asked to be strict', async () => {
    const devOps = fakeDevOps(STRICT);
    devOps.getValue.mockRejectedValueOnce(new Error('TF400898: An internal error occurred.'));
    await expect(loadPolicy({ sdk: devOps.sdk, storage: null, strict: true })).rejects.toThrow(
      /so the saved policy isn’t replaced by the defaults/
    );
    devOps.getValue.mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }));
    await expect(loadPolicy({ sdk: devOps.sdk, storage: null, strict: true })).rejects.toThrow(
      /don’t have permission to read/
    );
  });

  it('falls back when the extension data service is missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const devOps = fakeDevOps(STRICT);
    const sdk: DevOpsSdk = { ...devOps.sdk, getService: async () => undefined };
    await expect(loadPolicy({ sdk, storage: null })).resolves.toEqual(DEFAULT_POLICY);
  });

  it('reads a 3.0 policy that allowed every method as allowing OAuth 2.0 too', async () => {
    // As 3.0 saved it.
    const saved30 = {
      version: 1,
      allowedHosts: ['api.contoso.com'],
      allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey'],
      allowLocalhost: false,
      blockPrivateNetworks: false,
      maxPages: 100,
      maxItems: 50_000,
      timeoutSeconds: 120,
      allowSavedConfigurations: false,
      changedBy: 'Megan Bowen',
      changedAt: '2026-09-14T15:32:00.000Z',
    };
    const policy = await loadPolicy({ sdk: fakeDevOps(saved30).sdk, storage: null });
    expect(policy).toMatchObject({
      version: 2,
      allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey', 'oauth2'],
      allowSavedConfigurations: false,
      changedBy: 'Megan Bowen',
    });
    const restricted = await loadPolicy({
      sdk: fakeDevOps({ ...saved30, allowedAuthMethods: ['bearer', 'apiKey'] }).sdk,
      storage: null,
    });
    expect(restricted.allowedAuthMethods).toEqual(['bearer', 'apiKey']);
  });
});

describe('savePolicy', () => {
  it('saves for the organization, noting who changed it and when', async () => {
    const devOps = fakeDevOps();
    const withExtra = { ...STRICT, extra: 'ignored', changedBy: 'Someone else' };
    const saved = await savePolicy(withExtra, { sdk: devOps.sdk, storage: null });
    expect(saved).toEqual({
      ...STRICT,
      changedBy: 'Ada Lovelace',
      changedAt: '2026-09-28T12:00:00.000Z',
    });
    expect(devOps.setValue).toHaveBeenCalledWith('securityPolicy', saved, { scopeType: 'Default' });
    expect(devOps.stored.get(POLICY_KEY)).not.toHaveProperty('extra');
  });

  it('saves version 2, so a list without OAuth 2.0 stays that way', async () => {
    const devOps = fakeDevOps();
    const storage = memoryStorage();
    const withoutOAuth: SecurityPolicy = {
      ...DEFAULT_POLICY,
      allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey'],
    };
    await savePolicy(withoutOAuth, { sdk: devOps.sdk, storage });
    expect(devOps.stored.get(POLICY_KEY)).toMatchObject({
      version: 2,
      allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey'],
    });
    // Neither the stored copy nor the cached one gains OAuth 2.0 when read back.
    const fresh = await loadPolicy({ sdk: devOps.sdk, storage });
    expect(fresh.allowedAuthMethods).toEqual(['none', 'basic', 'bearer', 'apiKey']);
    const cached = await loadPolicy({ sdk: devOps.sdk, storage });
    expect(cached.allowedAuthMethods).toEqual(['none', 'basic', 'bearer', 'apiKey']);
    expect(devOps.getValue).toHaveBeenCalledTimes(1);

    // Whatever version the caller passes, the methods are saved as chosen.
    const legacyShape = Object.assign({ ...withoutOAuth }, { version: 1 });
    const saved = await savePolicy(legacyShape, { sdk: devOps.sdk, storage: null });
    expect(saved).toMatchObject({
      version: 2,
      allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey'],
    });
  });

  it('never reads a copy that 3.0 cached in the same tab', async () => {
    const devOps = fakeDevOps({
      ...DEFAULT_POLICY,
      allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey'],
    });
    const storage = memoryStorage();
    // 3.0 cached version 1 policies under this key; read here, the copy would allow OAuth 2.0.
    storage.setItem(
      'rest-picklist:v1:policy:host-contoso',
      JSON.stringify({
        expires: Date.now() + 60_000,
        data: { version: 1, allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey'] },
      })
    );
    const policy = await loadPolicy({ sdk: devOps.sdk, storage });
    expect(policy.allowedAuthMethods).toEqual(['none', 'basic', 'bearer', 'apiKey']);
    expect(devOps.getValue).toHaveBeenCalledTimes(1);
    expect([...storage.map.keys()]).toContain('rest-picklist:v1:policy:2:host-contoso');
  });

  it('uses the sign-in name when there’s no display name', async () => {
    const devOps = fakeDevOps();
    devOps.user.displayName = '';
    const saved = await savePolicy(STRICT, { sdk: devOps.sdk, storage: null });
    expect(saved.changedBy).toBe('ada@contoso.com');
  });

  it('clears the cached policy', async () => {
    const devOps = fakeDevOps();
    const storage = memoryStorage();
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toEqual(DEFAULT_POLICY);
    await savePolicy(STRICT, { sdk: devOps.sdk, storage });
    expect(storage.map.size).toBe(0);
    await expect(loadPolicy({ sdk: devOps.sdk, storage })).resolves.toMatchObject({
      allowedHosts: STRICT.allowedHosts,
      changedBy: 'Ada Lovelace',
    });
  });

  it('explains failures', async () => {
    const devOps = fakeDevOps();
    const storage = memoryStorage();
    await loadPolicy({ sdk: devOps.sdk, storage });

    devOps.setValue.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    const refused = savePolicy(STRICT, { sdk: devOps.sdk, storage });
    await expect(refused).rejects.toThrow(PicklistError);
    await expect(refused).rejects.toThrow(
      'You don’t have permission to change the security policy.'
    );
    // The cache is cleared even when saving fails, so the next load shows what's really stored.
    expect(storage.map.size).toBe(0);

    devOps.setValue.mockRejectedValueOnce(new Error(`Network error with ${TOKEN}`));
    const failed = savePolicy(STRICT, { sdk: devOps.sdk, storage });
    await expect(failed).rejects.toThrow(
      'Couldn’t save the security policy. Try again in a moment.'
    );
  });
});
