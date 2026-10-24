import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDevOpsHost } from './host';

const sdk = vi.hoisted(() => ({
  getService: vi.fn<(contributionId: string) => Promise<unknown>>(),
  getAccessToken: vi.fn<() => Promise<string>>(async () => 'access-token'),
  getExtensionContext: vi.fn<
    () => { id: string; publisherId: string; extensionId: string; version: string }
  >(() => ({
    id: 'OscarArguedasBarboza.RestDataMappingPicklist',
    publisherId: 'OscarArguedasBarboza',
    extensionId: 'RestDataMappingPicklist',
    version: '4.0.0',
  })),
  getHost: vi.fn<() => { id: string; name: string }>(() => ({
    id: 'fabrikam-host',
    name: 'fabrikam',
  })),
  getUser: vi.fn<() => { displayName: string; name: string }>(() => ({
    displayName: 'Ana Díaz',
    name: 'ana@fabrikam.example',
  })),
  resize: vi.fn<(width?: number, height?: number) => void>(),
}));

vi.mock('azure-devops-extension-sdk', () => sdk);

const LOCATION_SERVICE = 'ms.vss-features.location-service';
const NAVIGATION_SERVICE = 'ms.vss-features.host-navigation-service';
const EXTENSION_DATA_SERVICE = 'ms.vss-features.extension-data-service';
const SETTINGS_URL =
  'https://dev.azure.com/fabrikam/_settings/OscarArguedasBarboza.RestDataMappingPicklist.rest-picklist-setup';
const AGILE = 'e31fd6e1-c6af-44bb-925e-dfa71f551463';
const CONFIGURATION_ID = '6f1c0f3e-3f0b-4c55-9a43-0d3a6c1e9b21';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

/** The host page's services, as the SDK hands them out. */
function services(overrides: Record<string, unknown> = {}) {
  const openNewWindow = vi.fn<(url: string, features: string) => void>();
  const documents: Record<string, unknown[]> = {
    configurations: [
      {
        id: CONFIGURATION_ID,
        version: 1,
        name: 'Customers API',
        aliases: ['Customers'],
        processIds: [AGILE],
        settings: { RestServiceAddress: 'https://api.example.com/customers' },
        secret: null,
      },
    ],
    secrets: [
      {
        id: CONFIGURATION_ID,
        version: 1,
        secret: { kind: 'token', value: 'secret-token' },
        boundOrigin: 'https://api.example.com',
      },
    ],
  };
  const manager = {
    getValue: async () => undefined,
    setValue: async (_key: string, value: unknown) => value,
    getDocument: async (collection: string, id: string) =>
      (documents[collection] ?? []).find(
        (doc) => typeof doc === 'object' && doc !== null && 'id' in doc && doc.id === id
      ),
    getDocuments: async (collection: string) => documents[collection] ?? [],
    createDocument: async (_collection: string, doc: unknown) => doc,
    setDocument: async (_collection: string, doc: unknown) => doc,
    updateDocument: async (_collection: string, doc: unknown) => doc,
    deleteDocument: async () => undefined,
  };
  const table: Record<string, unknown> = {
    [LOCATION_SERVICE]: { getServiceLocation: async () => 'https://dev.azure.com/fabrikam/' },
    [NAVIGATION_SERVICE]: { openNewWindow },
    [EXTENSION_DATA_SERVICE]: { getExtensionDataManager: async () => manager },
    ...overrides,
  };
  sdk.getService.mockImplementation(async (contributionId) => {
    if (contributionId in table) {
      return table[contributionId];
    }
    throw new Error(`No ${contributionId} here.`);
  });
  return { openNewWindow };
}

beforeEach(() => {
  // Lookups are kept for five minutes in the tab; every test starts without any.
  globalThis.sessionStorage?.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDevOpsHost', () => {
  it('builds the settings page’s address from the organization’s', async () => {
    services();
    await expect(createDevOpsHost().settingsPageUrl?.()).resolves.toBe(SETTINGS_URL);
  });

  it('has no address for the settings page when the organization’s can’t be told', async () => {
    services({ [LOCATION_SERVICE]: { getServiceLocation: async () => 'http://insecure/' } });
    await expect(createDevOpsHost().settingsPageUrl?.()).resolves.toBeNull();
    services({ [LOCATION_SERVICE]: undefined });
    await expect(createDevOpsHost().settingsPageUrl?.()).resolves.toBeNull();
  });

  it('opens the settings page through the host’s navigation service', async () => {
    const { openNewWindow } = services();
    createDevOpsHost().openSettingsPage?.(SETTINGS_URL);
    await vi.waitFor(() => expect(openNewWindow).toHaveBeenCalledWith(SETTINGS_URL, ''));
  });

  it('finds the configuration for the work item’s project, and its secret', async () => {
    services();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        count: 1,
        value: [
          {
            typeId: AGILE,
            name: 'Fabrikam Agile',
            customizationType: 'inherited',
            projects: [{ id: 'fabrikam-fiber-id', name: 'Fabrikam Fiber' }],
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchImpl);
    const host = createDevOpsHost();
    await expect(host.resolveConfiguration?.('Customers', 'Fabrikam Fiber')).resolves.toEqual({
      id: CONFIGURATION_ID,
      name: 'Customers API',
      processId: AGILE,
      processName: 'Fabrikam Agile',
      settings: { RestServiceAddress: 'https://api.example.com/customers' },
      secret: null,
    });
    const requested = fetchImpl.mock.calls[0]?.[0];
    expect(typeof requested === 'string' ? requested : '').toMatch(
      /^https:\/\/dev\.azure\.com\/fabrikam\/_apis\/work\/processes\?/
    );
    await expect(host.loadSecret?.(CONFIGURATION_ID)).resolves.toMatchObject({
      id: CONFIGURATION_ID,
      secret: { kind: 'token', value: 'secret-token' },
      boundOrigin: 'https://api.example.com',
    });
  });
});
