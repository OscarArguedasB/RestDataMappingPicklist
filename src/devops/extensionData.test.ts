import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentManager } from './extensionData';
import {
  EXTENSION_DATA_SERVICE_ID,
  SESSION_CACHE_TTL_MS,
  cacheKey,
  clearSessionCache,
  defaultSessionStore,
  getDocumentManager,
  getExtensionDataManager,
  hasDocumentMethods,
  readSessionCache,
  writeSessionCache,
} from './extensionData';
import type { DevOpsSdk } from './rest';

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

const asText = (data: unknown) => (typeof data === 'string' ? data : null);

describe('session cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps values for five minutes', () => {
    const storage = memoryStorage();
    writeSessionCache(storage, 'k', 'value');
    expect(readSessionCache(storage, 'k', asText)).toBe('value');
    vi.setSystemTime(Date.now() + SESSION_CACHE_TTL_MS - 1);
    expect(readSessionCache(storage, 'k', asText)).toBe('value');
    vi.setSystemTime(Date.now() + 2);
    expect(readSessionCache(storage, 'k', asText)).toBeNull();
  });

  it('treats anything unexpected as a miss', () => {
    const storage = memoryStorage();
    const now = Date.now();
    for (const raw of [
      '',
      'not json',
      '[]',
      JSON.stringify({ data: 'value' }),
      JSON.stringify({ expires: 'soon', data: 'value' }),
      JSON.stringify({ expires: now + SESSION_CACHE_TTL_MS * 10, data: 'value' }),
      JSON.stringify({ expires: now + 1000, data: 42 }),
    ]) {
      storage.setItem('k', raw);
      expect(readSessionCache(storage, 'k', asText)).toBeNull();
    }
    storage.setItem('k', JSON.stringify({ expires: now + 1000, data: 'value' }));
    expect(
      readSessionCache(storage, 'k', () => {
        throw new Error('bad');
      })
    ).toBeNull();
  });

  it('never throws when storage is blocked or missing', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('Full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    };
    expect(() => writeSessionCache(blocked, 'k', 'value')).not.toThrow();
    expect(readSessionCache(blocked, 'k', asText)).toBeNull();
    expect(() => clearSessionCache(blocked, 'k')).not.toThrow();
    expect(readSessionCache(null, 'k', asText)).toBeNull();
    expect(() => writeSessionCache(undefined, 'k', 'value')).not.toThrow();
  });

  it('uses sessionStorage only when the browser allows it', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(defaultSessionStore()).toBeNull();
    vi.unstubAllGlobals();

    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    try {
      expect(defaultSessionStore()).toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'sessionStorage', original);
      } else {
        Reflect.deleteProperty(globalThis, 'sessionStorage');
      }
    }
  });

  it('skips entries too large for the tab’s storage', () => {
    const storage = memoryStorage();
    writeSessionCache(storage, 'k', 'x'.repeat(1_000_001));
    expect(storage.map.size).toBe(0);
  });

  it('clears entries, with or without removeItem', () => {
    const storage = memoryStorage();
    writeSessionCache(storage, 'k', 'value');
    clearSessionCache(storage, 'k');
    expect(storage.map.has('k')).toBe(false);

    const { map, getItem, setItem } = memoryStorage();
    writeSessionCache({ getItem, setItem }, 'k', 'value');
    clearSessionCache({ getItem, setItem }, 'k');
    expect(map.get('k')).toBe('');
    expect(readSessionCache({ getItem, setItem }, 'k', asText)).toBeNull();
  });

  it('builds keys that keep organizations apart', () => {
    expect(cacheKey('saved', 'https://dev.azure.com/contoso/', 'p1')).toBe(
      'rest-picklist:v1:saved:https%3A%2F%2Fdev.azure.com%2Fcontoso%2F:p1'
    );
    expect(cacheKey('a:b', 'c')).not.toBe(cacheKey('a', 'b:c'));
  });
});

function sdk(service: unknown): DevOpsSdk {
  return {
    getAccessToken: async () => 'token-abc',
    getService: async (id) => (id === EXTENSION_DATA_SERVICE_ID ? service : undefined),
    getExtensionContext: () => ({ id: 'OscarArguedasBarboza.RestDataMappingPicklist' }),
    getHost: () => ({ id: 'host-1', name: 'contoso' }),
    getUser: () => ({ displayName: 'Ada Lovelace', name: 'ada@contoso.com' }),
  };
}

describe('getExtensionDataManager', () => {
  it('asks the host for this extension’s data manager', async () => {
    const manager = { getValue: async () => null, setValue: async () => null };
    const getManager = vi.fn<(extensionId: string, token: string) => Promise<unknown>>(
      async () => manager
    );
    await expect(
      getExtensionDataManager(sdk({ getExtensionDataManager: getManager }))
    ).resolves.toBe(manager);
    expect(getManager).toHaveBeenCalledWith(
      'OscarArguedasBarboza.RestDataMappingPicklist',
      'token-abc'
    );
  });

  it('rejects services that don’t look right', async () => {
    await expect(getExtensionDataManager(sdk(undefined))).rejects.toThrow(/isn’t available/);
    await expect(
      getExtensionDataManager(sdk({ getExtensionDataManager: async () => ({}) }))
    ).rejects.toThrow(/isn’t available/);
  });
});

const resolved = async () => null;

function documentManager(): DocumentManager {
  return {
    getValue: resolved,
    setValue: resolved,
    getDocument: resolved,
    getDocuments: resolved,
    createDocument: resolved,
    setDocument: resolved,
    updateDocument: resolved,
    deleteDocument: resolved,
  };
}

describe('getDocumentManager', () => {
  it('returns a manager with every document method', async () => {
    const manager = documentManager();
    expect(hasDocumentMethods(manager)).toBe(true);
    await expect(
      getDocumentManager(sdk({ getExtensionDataManager: async () => manager }))
    ).resolves.toBe(manager);
  });

  it('rejects a manager that only keeps settings', async () => {
    const { getValue, setValue, getDocument, getDocuments, createDocument, setDocument } =
      documentManager();
    const partial = { getValue, setValue, getDocument, getDocuments, createDocument, setDocument };
    expect(hasDocumentMethods(partial)).toBe(false);
    await expect(
      getDocumentManager(sdk({ getExtensionDataManager: async () => partial }))
    ).rejects.toThrow('The extension data service isn’t available.');
    await expect(
      getDocumentManager(
        sdk({ getExtensionDataManager: async () => ({ ...documentManager(), deleteDocument: 1 }) })
      )
    ).rejects.toThrow(/isn’t available/);
  });
});
