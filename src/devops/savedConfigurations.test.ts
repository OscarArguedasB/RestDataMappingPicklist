import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import { createDevOpsApiForTests } from './rest';
import type { SavedConfiguration } from './savedConfigurations';
import {
  findSavedConfiguration,
  resolveSavedInputs,
  scanSavedConfigurations,
} from './savedConfigurations';

// The real SDK talks to the parent window as soon as it's imported.
vi.mock('azure-devops-extension-sdk', () => ({}));

const BASE = 'https://dev.azure.com/contoso/';
const OUR_CONTRIBUTION = 'OscarArguedasBarboza.RestDataMappingPicklist.rest-data-mapping-picklist';
const DEV_CONTRIBUTION =
  'OscarArguedasBarboza.RestDataMappingPicklist-dev.REST-DATA-MAPPING-PICKLIST';
const PROCESS = { id: 'e31fd6e1-c6af-44bb-925e-dfa71f551463', name: 'Contoso Agile' };
const SECRET = 'p@ssw0rd-secret';
const USER = 'svc-picklist';

const CUSTOMER_INPUTS = {
  FieldName: 'Custom.Customer',
  SaveConfiguration: 'true',
  SavedConfigurationName: 'Customers',
  RestServiceAddress: 'https://api.contoso.com/customers?region=$(Custom.Region)',
  RestCallParameters: '{ "active": "true" }',
  AuthMethod: 'Basic',
  RestServiceUserName: USER,
  RestServicePassword: SECRET,
  PathToArray: 'data',
  RestServiceKeyField: 'name',
  SecondLineProperty: 'email',
  FieldMap: '{ "Custom.CustomerId": "id" }',
  AllowMultiple: 'true',
  LoadOnFormOpen: 'false',
  Required: 'true',
  ErrorMessage: '',
  AdvancedSettings: '{"paging":{"type":"nextLink"}}',
};

const CUSTOMER_SAVED = {
  RestServiceAddress: 'https://api.contoso.com/customers?region=$(Custom.Region)',
  RestCallParameters: '{ "active": "true" }',
  AuthMethod: 'Basic',
  PathToArray: 'data',
  RestServiceKeyField: 'name',
  SecondLineProperty: 'email',
  FieldMap: '{ "Custom.CustomerId": "id" }',
  AdvancedSettings: '{"paging":{"type":"nextLink"}}',
};

// Doesn't sign in, so it can be removed automatically.
const REGION_INPUTS = {
  FieldName: 'Custom.Region',
  SaveConfiguration: ' True ',
  AuthMethod: 'None',
  RestServiceAddress: 'https://api.contoso.com/regions',
};

// Shaped like the controls in GET …/workitemtypes?$expand=layout.
function picklistControl(
  id: string,
  label: string,
  inputs: Record<string, unknown>,
  contributionId = OUR_CONTRIBUTION
) {
  return {
    id,
    label,
    controlType: null,
    readOnly: false,
    visible: true,
    isContribution: true,
    order: null,
    inherited: null,
    overridden: null,
    watermark: null,
    metadata: null,
    height: null,
    contribution: { contributionId, inputs, height: 36, showOnDeletedWorkItem: false },
  };
}

function fieldControl(id: string, label: string) {
  return {
    id,
    label,
    controlType: 'FieldControl',
    readOnly: false,
    visible: true,
    isContribution: false,
    inherited: true,
  };
}

function workItemType(name: string, referenceName: string, groups: unknown[]) {
  return {
    referenceName,
    name,
    description: '',
    url: `${BASE}_apis/work/processes/${PROCESS.id}/workItemTypes/${referenceName}`,
    customization: 'inherited',
    color: 'CC293D',
    icon: 'icon_insect',
    isDisabled: false,
    inherits: `Microsoft.VSTS.WorkItemTypes.${name}`,
    layout: {
      pages: [
        {
          id: 'Details',
          label: 'Details',
          pageType: 'custom',
          visible: true,
          locked: false,
          isContribution: false,
          sections: [
            { id: 'Section1', groups },
            { id: 'Section2', groups: [] },
          ],
        },
        { id: 'History', label: 'History', pageType: 'history', sections: [] },
      ],
      extensions: [],
      systemControls: [fieldControl('System.Title', 'Title')],
    },
  };
}

function layoutResponse(extraTypes: unknown[] = []) {
  const bug = workItemType('Bug', 'ContosoAgile.Bug', [
    {
      id: 'Group.Customer.4f2a',
      label: 'Customer',
      visible: true,
      isContribution: false,
      controls: [
        fieldControl('Custom.Region', 'Region'),
        // Another extension, even with an input of the same name, is ignored.
        picklistControl(
          'c-toggle',
          'Done',
          { FieldName: 'Custom.Done', SaveConfiguration: 'true' },
          'ms-devlabs.toggle-control.toggle-control-contribution'
        ),
        picklistControl('c-customers', 'Customer', CUSTOMER_INPUTS),
        picklistControl('c-uses', 'Billing customer', {
          FieldName: 'Custom.BillingCustomer',
          SavedConfiguration: 'customers',
          SaveConfiguration: 'false',
        }),
      ],
    },
    {
      id: 'ms-devlabs.group-contribution',
      isContribution: true,
      contribution: { contributionId: 'ms-devlabs.some-group', inputs: {} },
      controls: null,
    },
  ]);
  const task = workItemType('Task', 'ContosoAgile.Task', [
    {
      id: 'Group.Planning',
      label: 'Planning',
      controls: [
        picklistControl(
          'c-product',
          'Product',
          {
            FieldName: 'Custom.Product',
            SaveConfiguration: true,
            RestServiceAddress: 'https://api.contoso.com/products',
          },
          DEV_CONTRIBUTION
        ),
        picklistControl('c-region', '', REGION_INPUTS),
      ],
    },
  ]);
  const epic = { referenceName: 'Microsoft.VSTS.WorkItemTypes.Epic', name: 'Epic' };
  return { count: 3 + extraTypes.length, value: [bug, task, epic, ...extraTypes] };
}

const PROCESSES = {
  count: 1,
  value: [
    {
      typeId: PROCESS.id,
      name: PROCESS.name,
      customizationType: 'Inherited',
      isEnabled: true,
      projects: [{ id: '0a5a3a5d-6b3b-4a4f-9d0b-0c3b8a1c2d3e', name: 'Fabrikam Fiber' }],
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function setup(base = BASE) {
  const state = {
    layout: layoutResponse() as unknown,
    patch: (body: unknown): Response => json(body),
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : '');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/[^/]+\//, '/');
    if (method === 'GET' && path === '/_apis/work/processes') {
      return json(PROCESSES);
    }
    if (method === 'GET' && path === `/_apis/work/processes/${PROCESS.id}/workitemtypes`) {
      return json(state.layout);
    }
    if (method === 'PATCH') {
      return state.patch(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    }
    return json({ message: 'Not found' }, 404);
  });
  const api = createDevOpsApiForTests(base, 'token-123', fetchImpl);
  return { api, fetchImpl, state };
}

function requested(fetchImpl: ReturnType<typeof setup>['fetchImpl']): string[] {
  return fetchImpl.mock.calls.map(([input, init]) => {
    const url = typeof input === 'string' ? input : '';
    return `${init?.method ?? 'GET'} ${url}`;
  });
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

async function scanned(): Promise<SavedConfiguration[]> {
  const { api } = setup();
  return (await scanSavedConfigurations(api, PROCESS)).configurations;
}

describe('scanSavedConfigurations', () => {
  it('reads the process layout', async () => {
    const { api, fetchImpl } = setup();
    await scanSavedConfigurations(api, PROCESS);
    expect(requested(fetchImpl)).toEqual([
      `GET ${BASE}_apis/work/processes/${PROCESS.id}/workitemtypes?$expand=layout&api-version=7.1`,
    ]);
  });

  it('finds this extension’s controls that save their settings', async () => {
    const { api } = setup();
    const scan = await scanSavedConfigurations(api, PROCESS);
    expect(scan.configurations.map((item) => [item.name, item.source])).toEqual([
      ['Custom.Region', 'Task › Custom.Region'],
      ['Customers', 'Bug › Customer'],
      ['Product', 'Task › Product'],
    ]);
  });

  it('keeps only the shared settings, never credentials', async () => {
    const [, customers] = await scanned();
    expect(customers).toMatchObject({
      name: 'Customers',
      processId: PROCESS.id,
      processName: 'Contoso Agile',
      workItemType: { name: 'Bug', referenceName: 'ContosoAgile.Bug' },
      groupId: 'Group.Customer.4f2a',
      controlId: 'c-customers',
      label: 'Customer',
      fieldName: 'Custom.Customer',
      inputs: CUSTOMER_SAVED,
    });
    expect(JSON.stringify(customers?.inputs)).not.toContain(SECRET);
    // The raw layout control is kept as Azure DevOps returned it.
    expect(customers?.control).toMatchObject({ id: 'c-customers', isContribution: true });
  });

  it('refuses a name saved by more than one control', async () => {
    const { api, state } = setup();
    state.layout = layoutResponse([
      workItemType('User Story', 'ContosoAgile.UserStory', [
        {
          id: 'Group.Account',
          controls: [
            picklistControl('c-account', 'Account', {
              FieldName: 'Custom.Account',
              SaveConfiguration: 'true',
              SavedConfigurationName: ' CUSTOMERS ',
            }),
          ],
        },
      ]),
    ]);
    const scan = await scanSavedConfigurations(api, PROCESS);
    expect(() => findSavedConfiguration(scan, 'customers')).toThrow(
      '“customers” is saved by more than one control: Bug › Customer, User Story › Account. Give each one a unique name.'
    );
    expect(findSavedConfiguration(scan, 'product').controlId).toBe('c-product');
  });

  it('rejects an unexpected response', async () => {
    const { api, state } = setup();
    state.layout = { message: 'odd' };
    await expect(scanSavedConfigurations(api, PROCESS)).rejects.toThrow(
      /unexpected list of work item types/
    );
  });
});

describe('findSavedConfiguration', () => {
  it('finds names in any case and explains what’s missing', async () => {
    const { api } = setup();
    const scan = await scanSavedConfigurations(api, PROCESS);
    expect(findSavedConfiguration(scan, '  CUSTOMERS ').controlId).toBe('c-customers');
    expect(() => findSavedConfiguration(scan, 'Vendors')).toThrow(
      'No saved configuration named “Vendors” in this process. Available: “Custom.Region”, “Customers”, “Product”.'
    );
    expect(() => findSavedConfiguration({ configurations: [] }, 'X')).toThrow(
      'No saved configuration named “X” in this process. This process has no saved configurations yet.'
    );
    expect(() => findSavedConfiguration(scan, ' ')).toThrow(PicklistError);
  });
});

describe('resolveSavedInputs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('finds the settings through the project’s process', async () => {
    const { api, fetchImpl } = setup();
    await expect(resolveSavedInputs(api, 'fabrikam fiber', 'customers', null)).resolves.toEqual(
      CUSTOMER_SAVED
    );
    expect(requested(fetchImpl)).toEqual([
      `GET ${BASE}_apis/work/processes?$expand=projects&api-version=7.1`,
      `GET ${BASE}_apis/work/processes/${PROCESS.id}/workitemtypes?$expand=layout&api-version=7.1`,
    ]);
  });

  it('caches the shared settings, and nothing else, for five minutes', async () => {
    const { api, fetchImpl } = setup();
    const storage = memoryStorage();
    await resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', storage);
    await expect(resolveSavedInputs(api, 'FABRIKAM FIBER', 'product', storage)).resolves.toEqual({
      RestServiceAddress: 'https://api.contoso.com/products',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const cached = [...storage.map.values()].join('\n');
    expect(cached).not.toContain(SECRET);
    expect(cached).not.toContain(USER);
    expect(cached).not.toContain('Custom.BillingCustomer');

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', storage);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('checks cached data before trusting it', async () => {
    const { api, fetchImpl } = setup();
    const storage = memoryStorage();
    await resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', storage);
    const savedKey = [...storage.map.keys()].find((key) => key.includes(':saved:'));
    if (!savedKey) {
      throw new Error('Expected a cache entry');
    }

    // Credentials planted in the cache are dropped.
    storage.setItem(
      savedKey,
      JSON.stringify({
        expires: Date.now() + 60_000,
        data: {
          configurations: [
            {
              name: 'Customers',
              source: 'Bug › Customer',
              inputs: {
                RestServiceAddress: 'https://api.contoso.com/v2',
                RestServicePassword: 'x',
              },
            },
          ],
        },
      })
    );
    await expect(resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', storage)).resolves.toEqual({
      RestServiceAddress: 'https://api.contoso.com/v2',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Malformed entries, or ones that expire too far ahead, are read again.
    for (const raw of [
      'not json',
      JSON.stringify({ expires: Date.now() + 60_000, data: { configurations: [{ name: 1 }] } }),
      JSON.stringify({ expires: Date.now() + 86_400_000, data: { configurations: [] } }),
    ]) {
      storage.setItem(savedKey, raw);
      fetchImpl.mockClear();
      await expect(
        resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', storage)
      ).resolves.toEqual(CUSTOMER_SAVED);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('reads again when a name isn’t in the cached copy', async () => {
    const { api, fetchImpl, state } = setup();
    const storage = memoryStorage();
    await resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', storage);
    state.layout = layoutResponse([
      workItemType('Issue', 'ContosoAgile.Issue', [
        {
          id: 'Group.Vendor',
          controls: [
            picklistControl('c-vendor', 'Vendor', {
              FieldName: 'Custom.Vendor',
              SaveConfiguration: 'true',
              RestServiceAddress: 'https://api.contoso.com/vendors',
            }),
          ],
        },
      ]),
    ]);
    await expect(resolveSavedInputs(api, 'Fabrikam Fiber', 'vendor', storage)).resolves.toEqual({
      RestServiceAddress: 'https://api.contoso.com/vendors',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps working when storage is blocked', async () => {
    const { api, fetchImpl } = setup();
    const blocked = {
      getItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('Full', 'QuotaExceededError');
      },
    };
    await expect(resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', blocked)).resolves.toEqual(
      CUSTOMER_SAVED
    );
    await resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', blocked);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('keeps organizations apart in the cache', async () => {
    const storage = memoryStorage();
    const first = setup('https://dev.azure.com/contoso');
    const second = setup('https://dev.azure.com/fabrikam');
    await resolveSavedInputs(first.api, 'Fabrikam Fiber', 'Customers', storage);
    await resolveSavedInputs(second.api, 'Fabrikam Fiber', 'Customers', storage);
    expect(second.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('explains unknown names, duplicates and projects', async () => {
    const { api, state } = setup();
    await expect(resolveSavedInputs(api, 'Fabrikam Fiber', 'Vendors', null)).rejects.toThrow(
      /^No saved configuration named “Vendors” in this process\./
    );
    await expect(resolveSavedInputs(api, 'Unknown', 'Customers', null)).rejects.toThrow(
      'Couldn’t find the process of project “Unknown”, so the saved configuration “Customers” can’t be used.'
    );
    state.layout = layoutResponse([
      workItemType('Issue', 'ContosoAgile.Issue', [
        {
          id: 'Group.Other',
          controls: [
            picklistControl('c-other', 'Customers', {
              FieldName: 'Custom.Other',
              SaveConfiguration: 'true',
            }),
          ],
        },
      ]),
    ]);
    await expect(resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', null)).rejects.toThrow(
      /saved by more than one control: Bug › Customer, Issue › Customers/
    );
  });

  it('does nothing without a name', async () => {
    const { api, fetchImpl } = setup();
    await expect(resolveSavedInputs(api, 'Fabrikam Fiber', '  ', null)).resolves.toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes on permission problems', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}, 403));
    const api = createDevOpsApiForTests(BASE, 'token-123', fetchImpl);
    await expect(resolveSavedInputs(api, 'Fabrikam Fiber', 'Customers', null)).rejects.toThrow(
      'You don’t have permission to read the organization’s processes (403).'
    );
  });
});
