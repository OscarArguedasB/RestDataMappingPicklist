import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationDocument } from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { StoredSecret } from '../core/secrets';
import { isPlainObject } from '../core/values';
import {
  copySecret,
  deleteConfiguration,
  deleteSecret,
  listConfigurations,
  loadSecret,
  resolveConfiguration,
  saveConfiguration,
  saveSecret,
} from './configurationStore';
import type { DocumentManager, ExtensionDataService } from './extensionData';
import { EXTENSION_DATA_SERVICE_ID } from './extensionData';
import type { DevOpsSdk } from './rest';
import { createDevOpsApiForTests } from './rest';

// The real SDK talks to the parent window as soon as it's imported.
vi.mock('azure-devops-extension-sdk', () => ({}));

const TOKEN = 'token-abc-123';
const EXTENSION_ID = 'OscarArguedasBarboza.RestDataMappingPicklist';
const BASE = 'https://dev.azure.com/contoso/';
const AGILE = 'e31fd6e1-c6af-44bb-925e-dfa71f551463';
const SCRUM = '6b724908-ef14-45cf-84f8-768b5384da45';
const SCOPE = { scopeType: 'Default' };
const NOW = '2026-10-22T14:03:00.000Z';
const PASSWORD = 'Hunter2-secret-value';

/** Errors arrive from the host frame as plain objects rather than Error instances. */
function hostError(fields: Record<string, unknown>): unknown {
  return { ...fields };
}

type Stored = Record<string, unknown>;

/** A deep copy, as documents are when they pass between the host frame and the extension. */
function record(value: unknown): Stored {
  return isPlainObject(value) ? structuredClone(value) : {};
}

function idOf(doc: unknown): string {
  return isPlainObject(doc) && typeof doc.id === 'string' ? doc.id : '';
}

function etagOf(doc: unknown): unknown {
  return isPlainObject(doc) ? doc.__etag : undefined;
}

function missingDocument(): unknown {
  return hostError({
    status: 404,
    message: 'Document not found.',
    typeKey: 'DocumentDoesNotExistException',
  });
}

/** An in-memory extension data service that behaves like the documented one. */
function fakeDevOps() {
  const collections = new Map<string, Map<string, Stored>>();
  const log: string[] = [];
  const documents = (name: string) => {
    let collection = collections.get(name);
    if (!collection) {
      collection = new Map();
      collections.set(name, collection);
    }
    return collection;
  };

  const getDocuments = vi.fn<DocumentManager['getDocuments']>(async (name) => {
    log.push(`getDocuments ${name}`);
    const collection = collections.get(name);
    if (!collection) {
      throw hostError({
        message: `The collection “${name}” doesn’t exist.`,
        serverError: { typeKey: 'DocumentCollectionDoesNotExistException' },
      });
    }
    return [...collection.values()].map(record);
  });
  const getDocument = vi.fn<DocumentManager['getDocument']>(async (name, id) => {
    log.push(`getDocument ${name} ${id}`);
    const stored = collections.get(name)?.get(id);
    if (!stored) {
      throw missingDocument();
    }
    return record(stored);
  });
  const createDocument = vi.fn<DocumentManager['createDocument']>(async (name, doc) => {
    log.push(`createDocument ${name} ${idOf(doc)}`);
    const collection = documents(name);
    if (collection.has(idOf(doc))) {
      throw hostError({ status: 409, typeKey: 'DocumentExistsException', message: 'Exists.' });
    }
    const stored = { ...record(doc), __etag: 1 };
    collection.set(idOf(doc), stored);
    return record(stored);
  });
  const updateDocument = vi.fn<DocumentManager['updateDocument']>(async (name, doc) => {
    log.push(`updateDocument ${name} ${idOf(doc)}`);
    const existing = collections.get(name)?.get(idOf(doc));
    if (!existing) {
      throw missingDocument();
    }
    if (existing.__etag !== etagOf(doc)) {
      throw hostError({ typeKey: 'InvalidDocumentVersionException', message: 'Stale.' });
    }
    const stored = { ...record(doc), __etag: Number(existing.__etag) + 1 };
    documents(name).set(idOf(doc), stored);
    return record(stored);
  });
  const setDocument = vi.fn<DocumentManager['setDocument']>(async (name, doc) => {
    log.push(`setDocument ${name} ${idOf(doc)}`);
    const existing = documents(name).get(idOf(doc));
    if (existing && etagOf(doc) !== -1 && existing.__etag !== etagOf(doc)) {
      throw hostError({ typeKey: 'InvalidDocumentVersionException' });
    }
    const stored = { ...record(doc), __etag: existing ? Number(existing.__etag) + 1 : 1 };
    documents(name).set(idOf(doc), stored);
    return record(stored);
  });
  const deleteDocument = vi.fn<DocumentManager['deleteDocument']>(async (name, id) => {
    log.push(`deleteDocument ${name} ${id}`);
    if (!collections.get(name)?.delete(id)) {
      throw missingDocument();
    }
    return undefined;
  });
  const manager: DocumentManager = {
    getValue: async () => null,
    setValue: async () => null,
    getDocument,
    getDocuments,
    createDocument,
    setDocument,
    updateDocument,
    deleteDocument,
  };
  const getExtensionDataManager = vi.fn<ExtensionDataService['getExtensionDataManager']>(
    async () => manager
  );
  const host = { id: 'host-contoso', name: 'contoso' };
  const user = { displayName: 'Ana Díaz', name: 'ana@contoso.com' };
  const sdk: DevOpsSdk = {
    getAccessToken: async () => TOKEN,
    getService: async (id) =>
      id === EXTENSION_DATA_SERVICE_ID ? { getExtensionDataManager } : undefined,
    getExtensionContext: () => ({ id: EXTENSION_ID }),
    getHost: () => host,
    getUser: () => user,
  };
  const seed = (name: string, ...docs: unknown[]) => {
    for (const doc of docs) {
      documents(name).set(idOf(doc), record(doc));
    }
  };
  return {
    sdk,
    host,
    user,
    log,
    collections,
    seed,
    getDocuments,
    getDocument,
    createDocument,
    updateDocument,
    setDocument,
    deleteDocument,
    getExtensionDataManager,
  };
}

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

function configuration(
  id: string,
  name: string,
  processIds: string[],
  extra: Partial<ConfigurationDocument> = {}
): ConfigurationDocument {
  return {
    id,
    version: 1,
    name,
    aliases: [],
    processIds,
    settings: { RestServiceAddress: `https://api.contoso.com/${id}` },
    secret: null,
    ...extra,
  };
}

async function failure(promise: Promise<unknown>): Promise<PicklistError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PicklistError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a failure');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('listConfigurations', () => {
  it('is empty before anything is saved', async () => {
    const devOps = fakeDevOps();
    await expect(listConfigurations({ sdk: devOps.sdk, storage: null })).resolves.toEqual([]);
    expect(devOps.getExtensionDataManager).toHaveBeenCalledWith(EXTENSION_ID, TOKEN);
    expect(devOps.getDocuments).toHaveBeenCalledWith('configurations', SCOPE);
    devOps.getDocuments.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 })
    );
    await expect(listConfigurations({ sdk: devOps.sdk, storage: null })).resolves.toEqual([]);
  });

  it('keeps the first of documents with the same id, and reads long lists quickly', async () => {
    const devOps = fakeDevOps();
    const many = Array.from({ length: 20_000 }, (_, index) =>
      configuration(`c-${index}`, `Configuration ${index}`, [AGILE])
    );
    const first = configuration('c-1', 'First copy', [AGILE]);
    devOps.getDocuments.mockResolvedValueOnce([first, ...many]);
    const started = performance.now();
    const docs = await listConfigurations({ sdk: devOps.sdk, storage: null });
    // Comparing every id with every other took seconds at this size.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(docs).toHaveLength(20_000);
    expect(docs.find((doc) => doc.id === 'c-1')?.name).toBe('First copy');
  });

  it('reads, checks and sorts the configurations', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const devOps = fakeDevOps();
    const regions = configuration('regions', 'Regions', [AGILE]);
    devOps.seed(
      'configurations',
      { ...regions, settings: { ...regions.settings, RestServicePassword: PASSWORD } },
      configuration('customers', 'customers API', [AGILE, SCRUM], { aliases: ['Customers'] }),
      { ...configuration('bad-name', '', [AGILE]), settings: { ErrorMessage: PASSWORD } },
      { ...configuration('bad-processes', 'No processes', []) },
      { name: 'No id', settings: {} }
    );
    const docs = await listConfigurations({ sdk: devOps.sdk, storage: null });
    expect(docs.map((doc) => doc.name)).toEqual(['customers API', 'Regions']);
    expect(docs[1]).toEqual(regions);
    expect(JSON.stringify(docs)).not.toContain(PASSWORD);
    // One warning, naming the documents only.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('bad-name');
    expect(logged).toContain('bad-processes');
    expect(logged).toContain('(no id)');
    expect(logged).not.toContain(PASSWORD);
  });

  it('keeps the list for five minutes per organization, unless asked for a fresh one', async () => {
    const devOps = fakeDevOps();
    devOps.seed('configurations', configuration('regions', 'Regions', [AGILE]));
    const storage = memoryStorage();
    await listConfigurations({ sdk: devOps.sdk, storage });
    await expect(listConfigurations({ sdk: devOps.sdk, storage })).resolves.toMatchObject([
      { name: 'Regions' },
    ]);
    expect(devOps.getDocuments).toHaveBeenCalledTimes(1);

    await listConfigurations({ sdk: devOps.sdk, storage, fresh: true });
    expect(devOps.getDocuments).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await listConfigurations({ sdk: devOps.sdk, storage });
    expect(devOps.getDocuments).toHaveBeenCalledTimes(3);

    // Another organization in the same tab has its own list.
    const other = fakeDevOps();
    other.host.id = 'host-fabrikam';
    await expect(listConfigurations({ sdk: other.sdk, storage })).resolves.toEqual([]);
    expect(other.getDocuments).toHaveBeenCalledTimes(1);
  });

  it('checks the kept list before using it', async () => {
    const devOps = fakeDevOps();
    devOps.seed('configurations', configuration('regions', 'Regions', [AGILE]));
    const storage = memoryStorage();
    await listConfigurations({ sdk: devOps.sdk, storage });
    const [key] = [...storage.map.keys()];
    if (!key) {
      throw new Error('Expected a cache entry');
    }
    for (const data of [
      { configurations: [{ id: 'evil', name: 'Evil' }] },
      { configurations: 'none' },
      'relaxed',
    ]) {
      storage.setItem(key, JSON.stringify({ expires: Date.now() + 1000, data }));
      devOps.getDocuments.mockClear();
      await expect(listConfigurations({ sdk: devOps.sdk, storage })).resolves.toMatchObject([
        { name: 'Regions' },
      ]);
      expect(devOps.getDocuments).toHaveBeenCalledTimes(1);
    }
  });

  it('doesn’t keep anything when the organization is unknown', async () => {
    const devOps = fakeDevOps();
    const storage = memoryStorage();
    const sdk: DevOpsSdk = {
      ...devOps.sdk,
      getHost: () => {
        throw new Error('Not ready');
      },
    };
    await listConfigurations({ sdk, storage });
    await listConfigurations({ sdk, storage });
    expect(storage.map.size).toBe(0);
    expect(devOps.getDocuments).toHaveBeenCalledTimes(2);
  });

  it('explains failures', async () => {
    const devOps = fakeDevOps();
    const options = { sdk: devOps.sdk, storage: null };
    devOps.getDocuments.mockRejectedValueOnce(hostError({ status: 403, message: 'Denied' }));
    expect(await failure(listConfigurations(options))).toMatchObject({
      kind: 'http',
      status: 403,
      message: 'You don’t have permission to read the REST Picklist configurations.',
    });
    devOps.getDocuments.mockRejectedValueOnce(new Error('TF400898: An internal error occurred.'));
    expect((await failure(listConfigurations(options))).message).toBe(
      'Couldn’t read the REST Picklist configurations. Try again in a moment.'
    );
    devOps.getDocuments.mockResolvedValueOnce({ value: [] });
    expect(await failure(listConfigurations(options))).toMatchObject({ kind: 'shape' });
    const missing: DevOpsSdk = { ...devOps.sdk, getService: async () => undefined };
    expect((await failure(listConfigurations({ sdk: missing, storage: null }))).message).toMatch(
      /^Couldn’t read the REST Picklist configurations\./
    );
  });
});

describe('saveConfiguration', () => {
  it('creates a new configuration, noting who and when', async () => {
    const devOps = fakeDevOps();
    const draft = configuration('c-new', 'Customers', [AGILE]);
    const saved = await saveConfiguration(draft, { sdk: devOps.sdk, storage: null });
    const expected = {
      ...draft,
      createdBy: 'Ana Díaz',
      createdAt: NOW,
      updatedBy: 'Ana Díaz',
      updatedAt: NOW,
    };
    expect(devOps.createDocument).toHaveBeenCalledWith('configurations', expected, SCOPE);
    expect(devOps.updateDocument).not.toHaveBeenCalled();
    expect(saved).toEqual({ ...expected, __etag: 1 });
  });

  it('updates with the etag it was read with, keeping when it was created', async () => {
    const devOps = fakeDevOps();
    const created = await saveConfiguration(configuration('c1', 'Customers', [AGILE]), {
      sdk: devOps.sdk,
      storage: null,
    });
    vi.setSystemTime(new Date('2026-10-23T09:00:00.000Z'));
    devOps.user.displayName = 'Ben Okafor';
    const updated = await saveConfiguration(
      { ...created, settings: { RestServiceAddress: 'https://api.contoso.com/v2' } },
      { sdk: devOps.sdk, storage: null }
    );
    expect(devOps.updateDocument).toHaveBeenCalledWith(
      'configurations',
      expect.objectContaining({ __etag: 1 }),
      SCOPE
    );
    expect(updated).toMatchObject({
      __etag: 2,
      settings: { RestServiceAddress: 'https://api.contoso.com/v2' },
      createdBy: 'Ana Díaz',
      createdAt: NOW,
      updatedBy: 'Ben Okafor',
      updatedAt: '2026-10-23T09:00:00.000Z',
    });
  });

  it('stores only what it understands', async () => {
    const devOps = fakeDevOps();
    const draft = {
      ...configuration('c1', 'Customers', [AGILE]),
      aliases: ['Old', `Bad${String.fromCharCode(10)}name`],
      settings: {
        RestServiceAddress: 'https://api.contoso.com/customers',
        RestServicePassword: PASSWORD,
        Unknown: 'x',
      },
      evil: '<script>',
    };
    await saveConfiguration(draft, { sdk: devOps.sdk, storage: null });
    const stored = devOps.collections.get('configurations')?.get('c1');
    expect(stored).toMatchObject({
      aliases: ['Old'],
      settings: { RestServiceAddress: 'https://api.contoso.com/customers' },
    });
    expect(stored).not.toHaveProperty('evil');
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  it('refuses a change someone else made in between', async () => {
    const devOps = fakeDevOps();
    const options = { sdk: devOps.sdk, storage: null };
    const created = await saveConfiguration(configuration('c1', 'Customers', [AGILE]), options);
    await saveConfiguration({ ...created, aliases: ['Theirs'] }, options);
    const error = await failure(saveConfiguration({ ...created, aliases: ['Mine'] }, options));
    expect(error).toMatchObject({
      kind: 'http',
      status: 409,
      message: 'Someone changed “Customers” since you opened it. Reload to see their changes.',
    });
    expect(devOps.collections.get('configurations')?.get('c1')).toMatchObject({
      aliases: ['Theirs'],
    });
  });

  it('reports every kind of conflict the same way', async () => {
    const devOps = fakeDevOps();
    const options = { sdk: devOps.sdk, storage: null };
    const draft = configuration('c1', 'Customers', [AGILE]);
    await saveConfiguration(draft, options);
    // Saving the same new configuration twice.
    expect((await failure(saveConfiguration(draft, options))).status).toBe(409);
    for (const rejection of [
      Object.assign(new Error('Precondition failed'), { status: 412 }),
      hostError({ statusCode: 409 }),
      hostError({ name: 'InvalidDocumentVersionException' }),
    ]) {
      devOps.updateDocument.mockRejectedValueOnce(rejection);
      const error = await failure(saveConfiguration({ ...draft, __etag: 1 }, options));
      expect(error.message).toBe(
        'Someone changed “Customers” since you opened it. Reload to see their changes.'
      );
    }
  });

  it('says when the configuration was deleted meanwhile', async () => {
    const devOps = fakeDevOps();
    const error = await failure(
      saveConfiguration(
        { ...configuration('gone', 'Customers', [AGILE]), __etag: 4 },
        { sdk: devOps.sdk, storage: null }
      )
    );
    expect(error).toMatchObject({
      status: 404,
      message:
        '“Customers” was deleted since you opened it. Reload to see the current configurations.',
    });
  });

  it('explains other failures without the settings', async () => {
    const devOps = fakeDevOps();
    const options = { sdk: devOps.sdk, storage: null };
    const draft = configuration('c1', 'Customers', [AGILE], {
      settings: { RestServiceAddress: 'https://api.contoso.com/customers?key=abc' },
    });
    devOps.createDocument.mockRejectedValueOnce(hostError({ status: 401 }));
    expect(await failure(saveConfiguration(draft, options))).toMatchObject({
      kind: 'http',
      status: 401,
      message: 'You don’t have permission to change REST Picklist configurations.',
    });
    devOps.createDocument.mockRejectedValueOnce(new Error('Network error with key=abc'));
    const error = await failure(saveConfiguration(draft, options));
    expect(error).toMatchObject({
      kind: 'network',
      message: 'Couldn’t save “Customers”. Try again in a moment.',
    });
    expect(error.message).not.toContain('key=abc');
  });

  it('checks the configuration before saving', async () => {
    const devOps = fakeDevOps();
    const options = { sdk: devOps.sdk, storage: null };
    const cases: Array<[ConfigurationDocument, string | RegExp]> = [
      [configuration('c1', ' ', [AGILE]), 'Enter a name for the configuration.'],
      [configuration('c1', 'Customers', []), 'Share the configuration with at least one process.'],
      [configuration('../c1', 'Customers', [AGILE]), /id isn’t valid/],
      [configuration('c1', 'Customers', ['not a process id']), /can’t be saved/],
    ];
    for (const [draft, message] of cases) {
      const error = await failure(saveConfiguration(draft, options));
      expect(error.kind).toBe('config');
      expect(error.message).toMatch(message);
    }
    expect(devOps.getExtensionDataManager).not.toHaveBeenCalled();
  });

  it('clears the kept list, even when saving fails', async () => {
    const devOps = fakeDevOps();
    const storage = memoryStorage();
    const options = { sdk: devOps.sdk, storage };
    await listConfigurations(options);
    await saveConfiguration(configuration('c1', 'Customers', [AGILE]), options);
    expect(storage.map.size).toBe(0);
    await expect(listConfigurations(options)).resolves.toMatchObject([{ name: 'Customers' }]);

    devOps.createDocument.mockRejectedValueOnce(new Error('Offline'));
    await failure(saveConfiguration(configuration('c2', 'Regions', [AGILE]), options));
    expect(storage.map.size).toBe(0);
  });

  it('uses the sign-in name when there’s no display name, and nothing when it’s unknown', async () => {
    const devOps = fakeDevOps();
    devOps.user.displayName = '';
    const saved = await saveConfiguration(configuration('c1', 'A', [AGILE]), {
      sdk: devOps.sdk,
      storage: null,
    });
    expect(saved).toMatchObject({ createdBy: 'ana@contoso.com', updatedBy: 'ana@contoso.com' });
    const anonymous: DevOpsSdk = {
      ...devOps.sdk,
      getUser: () => {
        throw new Error('Not ready');
      },
    };
    const unknown = await saveConfiguration(configuration('c2', 'B', [AGILE]), {
      sdk: anonymous,
      storage: null,
    });
    expect(unknown).not.toHaveProperty('createdBy');
    expect(unknown).toMatchObject({ createdAt: NOW, updatedAt: NOW });
  });
});

describe('deleteConfiguration', () => {
  it('deletes the configuration, then its secret', async () => {
    const devOps = fakeDevOps();
    devOps.seed('configurations', configuration('c1', 'Customers', [AGILE]));
    devOps.seed('secrets', {
      id: 'c1',
      version: 1,
      secret: { kind: 'password', value: PASSWORD },
      boundOrigin: 'https://api.contoso.com',
    });
    await deleteConfiguration(configuration('c1', 'Customers', [AGILE]), {
      sdk: devOps.sdk,
      storage: null,
    });
    expect(devOps.log).toEqual(['deleteDocument configurations c1', 'deleteDocument secrets c1']);
    expect(devOps.collections.get('configurations')?.size).toBe(0);
    expect(devOps.collections.get('secrets')?.size).toBe(0);
  });

  it('is fine with whatever is already gone', async () => {
    const devOps = fakeDevOps();
    devOps.seed('secrets', {
      id: 'c1',
      version: 1,
      secret: { kind: 'token', value: PASSWORD },
      boundOrigin: 'https://api.contoso.com',
    });
    await deleteConfiguration({ id: 'c1', name: 'Customers' }, { sdk: devOps.sdk, storage: null });
    expect(devOps.collections.get('secrets')?.size).toBe(0);
    await expect(
      deleteConfiguration({ id: 'c1', name: 'Customers' }, { sdk: devOps.sdk, storage: null })
    ).resolves.toBeUndefined();
  });

  it('keeps the secret when the configuration can’t be deleted', async () => {
    const devOps = fakeDevOps();
    devOps.seed('configurations', configuration('c1', 'Customers', [AGILE]));
    devOps.deleteDocument.mockRejectedValueOnce(hostError({ status: 403 }));
    expect(
      await failure(
        deleteConfiguration({ id: 'c1', name: 'Customers' }, { sdk: devOps.sdk, storage: null })
      )
    ).toMatchObject({ status: 403, message: 'You don’t have permission to delete “Customers”.' });
    devOps.deleteDocument.mockRejectedValueOnce(new Error('Offline'));
    expect(
      (
        await failure(
          deleteConfiguration({ id: 'c1', name: 'Customers' }, { sdk: devOps.sdk, storage: null })
        )
      ).message
    ).toBe('Couldn’t delete “Customers”. Try again in a moment.');
    expect(devOps.log.filter((entry) => entry.includes('secrets'))).toEqual([]);
  });

  it('explains a secret that couldn’t be removed', async () => {
    const devOps = fakeDevOps();
    devOps.seed('configurations', configuration('c1', 'Customers', [AGILE]));
    devOps.deleteDocument.mockImplementation(async (name, id) => {
      if (name === 'secrets') {
        throw new Error('Offline');
      }
      devOps.collections.get(name)?.delete(id);
      return undefined;
    });
    expect(
      (
        await failure(
          deleteConfiguration({ id: 'c1', name: 'Customers' }, { sdk: devOps.sdk, storage: null })
        )
      ).message
    ).toBe('“Customers” was deleted, but its secret couldn’t be removed. Try removing it again.');
  });

  it('clears the kept list', async () => {
    const devOps = fakeDevOps();
    devOps.seed('configurations', configuration('c1', 'Customers', [AGILE]));
    const storage = memoryStorage();
    await listConfigurations({ sdk: devOps.sdk, storage });
    await deleteConfiguration({ id: 'c1', name: 'Customers' }, { sdk: devOps.sdk, storage });
    await expect(listConfigurations({ sdk: devOps.sdk, storage })).resolves.toEqual([]);
  });
});

describe('secrets', () => {
  const secret: StoredSecret = { kind: 'clientSecret', value: PASSWORD };

  it('saves a secret bound to its origin, the last write winning', async () => {
    const devOps = fakeDevOps();
    const saved = await saveSecret('c1', secret, 'https://auth.contoso.com', { sdk: devOps.sdk });
    const document = {
      id: 'c1',
      version: 1,
      secret,
      boundOrigin: 'https://auth.contoso.com',
      updatedBy: 'Ana Díaz',
      updatedAt: NOW,
    };
    expect(devOps.setDocument).toHaveBeenCalledWith('secrets', { ...document, __etag: -1 }, SCOPE);
    expect(saved).toEqual({ ...document, __etag: 1 });
    // Saved again over someone else's change.
    devOps.collections.get('secrets')?.set('c1', { ...document, __etag: 9 });
    await expect(
      saveSecret('c1', { kind: 'clientSecret', value: 'other' }, 'https://auth.contoso.com', {
        sdk: devOps.sdk,
      })
    ).resolves.toMatchObject({ __etag: 10, secret: { value: 'other' } });
  });

  it('binds an OAuth 2.0 secret to the API its tokens go to', async () => {
    const devOps = fakeDevOps();
    const saved = await saveSecret('c1', secret, 'https://auth.contoso.com', {
      sdk: devOps.sdk,
      apiOrigin: 'https://api.contoso.com',
    });
    expect(saved).toMatchObject({
      boundOrigin: 'https://auth.contoso.com',
      apiOrigin: 'https://api.contoso.com',
    });
    await expect(loadSecret('c1', { sdk: devOps.sdk })).resolves.toMatchObject({
      apiOrigin: 'https://api.contoso.com',
    });
    const error = await failure(
      saveSecret('c1', secret, 'https://auth.contoso.com', {
        sdk: devOps.sdk,
        apiOrigin: 'https://api.contoso.com/v1',
      })
    );
    expect(error.message).toMatch(/HTTPS address/);
  });

  it('loads a stored secret, checked, every time it’s asked for', async () => {
    const devOps = fakeDevOps();
    await saveSecret('c1', secret, 'https://auth.contoso.com', { sdk: devOps.sdk });
    await expect(loadSecret('c1', { sdk: devOps.sdk })).resolves.toEqual({
      id: 'c1',
      __etag: 1,
      version: 1,
      secret,
      boundOrigin: 'https://auth.contoso.com',
      updatedBy: 'Ana Díaz',
      updatedAt: NOW,
    });
    await loadSecret('c1', { sdk: devOps.sdk });
    expect(devOps.getDocument).toHaveBeenCalledTimes(2);
    expect(devOps.getDocument).toHaveBeenCalledWith('secrets', 'c1', SCOPE);
  });

  it('loads nothing when no valid secret is stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const devOps = fakeDevOps();
    await expect(loadSecret('missing', { sdk: devOps.sdk })).resolves.toBeNull();
    devOps.seed(
      'secrets',
      {
        id: 'bad',
        version: 1,
        secret: { kind: 'magic', value: PASSWORD },
        boundOrigin: 'https://a.example',
      },
      { id: 'moved', version: 1, secret, boundOrigin: 'https://a.example/path' }
    );
    await expect(loadSecret('bad', { sdk: devOps.sdk })).resolves.toBeNull();
    await expect(loadSecret('moved', { sdk: devOps.sdk })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).toContain('bad');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSWORD);

    // A document answering for another id isn't used.
    devOps.getDocument.mockResolvedValueOnce({
      id: 'other',
      version: 1,
      secret,
      boundOrigin: 'https://a.example',
    });
    await expect(loadSecret('c1', { sdk: devOps.sdk })).resolves.toBeNull();
    devOps.getDocument.mockClear();
    await expect(loadSecret('../c1', { sdk: devOps.sdk })).resolves.toBeNull();
    expect(devOps.getDocument).not.toHaveBeenCalled();
  });

  it('never keeps secrets in the tab’s storage', async () => {
    const devOps = fakeDevOps();
    const storage = memoryStorage();
    devOps.seed('configurations', configuration('c1', 'Customers', [AGILE]));
    await saveSecret('c1', secret, 'https://auth.contoso.com', { sdk: devOps.sdk });
    await listConfigurations({ sdk: devOps.sdk, storage });
    await loadSecret('c1', { sdk: devOps.sdk });
    expect(storage.map.size).toBe(1);
    expect([...storage.map.values()].join('\n')).not.toContain(PASSWORD);
  });

  it('refuses secrets, origins and ids that can’t be saved', async () => {
    const devOps = fakeDevOps();
    const options = { sdk: devOps.sdk };
    const cases: Array<[Promise<unknown>, RegExp]> = [
      [
        saveSecret('c1', { kind: 'token', value: '' }, 'https://a.example', options),
        /can’t be saved/,
      ],
      [
        saveSecret(
          'c1',
          { kind: 'apiKey', value: 'x'.repeat(16_385) },
          'https://a.example',
          options
        ),
        /can’t be saved/,
      ],
      [saveSecret('c1', secret, 'http://a.example', options), /HTTPS address/],
      [saveSecret('c1', secret, 'https://a.example/token', options), /HTTPS address/],
      [saveSecret('../c1', secret, 'https://a.example', options), /id isn’t valid/],
    ];
    for (const [promise, message] of cases) {
      const error = await failure(promise);
      expect(error.kind).toBe('config');
      expect(error.message).toMatch(message);
    }
    expect(devOps.setDocument).not.toHaveBeenCalled();
  });

  it('keeps secrets out of error messages and logs', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const devOps = fakeDevOps();
    const messages: string[] = [];
    devOps.setDocument.mockRejectedValueOnce(new Error(`Rejected ${PASSWORD}`));
    messages.push((await failure(saveSecret('c1', secret, 'https://a.example', devOps))).message);
    devOps.setDocument.mockRejectedValueOnce(hostError({ status: 403, message: PASSWORD }));
    messages.push((await failure(saveSecret('c1', secret, 'https://a.example', devOps))).message);
    devOps.getDocument.mockRejectedValueOnce(hostError({ status: 500, message: PASSWORD }));
    messages.push((await failure(loadSecret('c1', devOps))).message);
    devOps.getDocument.mockRejectedValueOnce(hostError({ status: 401 }));
    messages.push((await failure(loadSecret('c1', devOps))).message);
    expect(messages).toEqual([
      'Couldn’t save the secret. Try again in a moment.',
      'You don’t have permission to change this configuration’s secret.',
      'Couldn’t read this configuration’s secret. Try again in a moment.',
      'You don’t have permission to read this configuration’s secret.',
    ]);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(PASSWORD);
    }
  });

  it('removes a secret, even one that isn’t there', async () => {
    const devOps = fakeDevOps();
    await saveSecret('c1', secret, 'https://auth.contoso.com', { sdk: devOps.sdk });
    await deleteSecret('c1', { sdk: devOps.sdk });
    expect(devOps.deleteDocument).toHaveBeenCalledWith('secrets', 'c1', SCOPE);
    await expect(loadSecret('c1', { sdk: devOps.sdk })).resolves.toBeNull();
    await expect(deleteSecret('c1', { sdk: devOps.sdk })).resolves.toBeUndefined();
    devOps.deleteDocument.mockRejectedValueOnce(hostError({ status: 403 }));
    expect((await failure(deleteSecret('c1', { sdk: devOps.sdk }))).message).toBe(
      'You don’t have permission to remove this configuration’s secret.'
    );
  });

  it('copies a secret to a duplicate, still bound to the same origin', async () => {
    const devOps = fakeDevOps();
    await saveSecret('c1', secret, 'https://auth.contoso.com', { sdk: devOps.sdk });
    vi.setSystemTime(new Date('2026-10-24T08:00:00.000Z'));
    await expect(copySecret('c1', 'c2', { sdk: devOps.sdk })).resolves.toBe(true);
    await expect(loadSecret('c2', { sdk: devOps.sdk })).resolves.toEqual({
      id: 'c2',
      __etag: 1,
      version: 1,
      secret,
      boundOrigin: 'https://auth.contoso.com',
      updatedBy: 'Ana Díaz',
      updatedAt: NOW,
    });
    await expect(copySecret('missing', 'c3', { sdk: devOps.sdk })).resolves.toBe(false);
    expect(devOps.collections.get('secrets')?.has('c3')).toBe(false);
  });
});

const PROCESSES = {
  count: 2,
  value: [
    {
      typeId: AGILE,
      name: 'Contoso Agile',
      customizationType: 'Inherited',
      parentProcessTypeId: 'adcc42ab-9882-485e-a3ed-7678f01f66bc',
      projects: [{ id: '0a5a3a5d-6b3b-4a4f-9d0b-0c3b8a1c2d3e', name: 'Fabrikam Fiber' }],
    },
    {
      typeId: SCRUM,
      name: 'Fabrikam Scrum',
      customizationType: 'Inherited',
      projects: [{ id: 'b7d1f0c2-1111-2222-3333-444455556666', name: 'Mobile' }],
    },
  ],
};

function devOpsApi() {
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(PROCESSES), {
        headers: { 'Content-Type': 'application/json' },
      })
  );
  return { api: createDevOpsApiForTests(BASE, 'token-123', fetchImpl), fetchImpl };
}

describe('resolveConfiguration', () => {
  const summary = { kind: 'password' as const, boundOrigin: 'https://api.contoso.com' };

  function seeded() {
    const devOps = fakeDevOps();
    devOps.seed(
      'configurations',
      configuration('customers', 'Customers API', [AGILE], {
        aliases: ['Customers'],
        settings: { RestServiceAddress: 'https://api.contoso.com/customers', AuthMethod: 'Basic' },
        secret: summary,
      }),
      configuration('regions', 'Regions', [AGILE, SCRUM]),
      configuration('products', 'Products', [SCRUM])
    );
    return devOps;
  }

  it('finds the configuration shared with the project’s process', async () => {
    const devOps = seeded();
    const { api, fetchImpl } = devOpsApi();
    await expect(
      resolveConfiguration(api, 'fabrikam fiber', ' customers api ', {
        sdk: devOps.sdk,
        storage: null,
      })
    ).resolves.toEqual({
      id: 'customers',
      name: 'Customers API',
      processId: AGILE,
      processName: 'Contoso Agile',
      settings: { RestServiceAddress: 'https://api.contoso.com/customers', AuthMethod: 'Basic' },
      secret: summary,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(devOps.getDocuments).toHaveBeenCalledTimes(1);
    expect(devOps.getDocument).not.toHaveBeenCalled();
  });

  it('answers to a former name with the current one', async () => {
    const devOps = seeded();
    const { api } = devOpsApi();
    await expect(
      resolveConfiguration(api, 'Fabrikam Fiber', 'CUSTOMERS', { sdk: devOps.sdk, storage: null })
    ).resolves.toMatchObject({ id: 'customers', name: 'Customers API' });
  });

  it('explains names that don’t lead to a configuration', async () => {
    const devOps = seeded();
    const { api } = devOpsApi();
    const options = { sdk: devOps.sdk, storage: null };
    expect(
      (await failure(resolveConfiguration(api, 'Fabrikam Fiber', 'Products', options))).message
    ).toBe(
      'The configuration “Products” isn’t shared with the Contoso Agile process. Available: “Customers API”, “Regions”.'
    );
    expect(
      (await failure(resolveConfiguration(api, 'Mobile', 'Customers API', options))).message
    ).toBe(
      'The configuration “Customers API” isn’t shared with the Fabrikam Scrum process. Available: “Products”, “Regions”.'
    );
    expect((await failure(resolveConfiguration(api, 'Mobile', 'Vendors', options))).message).toBe(
      'No configuration named “Vendors” is shared with the Fabrikam Scrum process. Available: “Products”, “Regions”.'
    );
  });

  it('keeps the process and the list for five minutes', async () => {
    const devOps = seeded();
    const { api, fetchImpl } = devOpsApi();
    const storage = memoryStorage();
    const options = { sdk: devOps.sdk, storage };
    await resolveConfiguration(api, 'Fabrikam Fiber', 'Customers API', options);
    await resolveConfiguration(api, 'Fabrikam Fiber', 'Regions', options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(devOps.getDocuments).toHaveBeenCalledTimes(1);
    // Only what's shown about the secret is kept, never the secret.
    expect([...storage.map.values()].join('\n')).not.toContain(PASSWORD);

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await resolveConfiguration(api, 'Fabrikam Fiber', 'Regions', options);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(devOps.getDocuments).toHaveBeenCalledTimes(2);
  });

  it('looks again when a name isn’t in the kept list', async () => {
    const devOps = seeded();
    const { api } = devOpsApi();
    const storage = memoryStorage();
    const options = { sdk: devOps.sdk, storage };
    await resolveConfiguration(api, 'Fabrikam Fiber', 'Regions', options);
    devOps.seed('configurations', configuration('vendors', 'Vendors', [AGILE]));
    await expect(
      resolveConfiguration(api, 'Fabrikam Fiber', 'Vendors', options)
    ).resolves.toMatchObject({ id: 'vendors' });
    expect(devOps.getDocuments).toHaveBeenCalledTimes(2);

    // A name that really doesn't exist is looked up once more, then explained.
    devOps.getDocuments.mockClear();
    await failure(resolveConfiguration(api, 'Fabrikam Fiber', 'Unknown', options));
    expect(devOps.getDocuments).toHaveBeenCalledTimes(1);
    await failure(
      resolveConfiguration(api, 'Fabrikam Fiber', 'Unknown', { ...options, fresh: true })
    );
    expect(devOps.getDocuments).toHaveBeenCalledTimes(2);
  });

  it('explains unknown and missing projects, and asks for a name first', async () => {
    const devOps = seeded();
    const { api, fetchImpl } = devOpsApi();
    const options = { sdk: devOps.sdk, storage: null };
    expect((await failure(resolveConfiguration(api, 'Unknown', 'Regions', options))).message).toBe(
      'Couldn’t find the process of project “Unknown”, so the configuration “Regions” can’t be used.'
    );
    fetchImpl.mockClear();
    expect((await failure(resolveConfiguration(api, ' ', 'Regions', options))).message).toBe(
      'Couldn’t tell which project this work item is in, so the configuration “Regions” can’t be used.'
    );
    expect((await failure(resolveConfiguration(api, 'Mobile', '  ', options))).message).toBe(
      'Enter the name of a configuration.'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
