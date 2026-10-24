import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import { DEFAULT_POLICY } from '../core/policy';
import type * as Store from '../devops/configurationStore';
import type * as Layout from '../devops/layout';
import type * as Permissions from '../devops/permissions';
import type * as PolicyStore from '../devops/policyStore';
import type * as Processes from '../devops/processes';
import type { DevOpsApi } from '../devops/rest';
import { createDevOpsServices } from './devopsServices';
import { ADMIN, PROCESSES, layoutControl } from './testUtils';

const sdk = vi.hoisted(() => ({
  replaceHash: vi.fn<(hash: string) => void>(),
  getUser: vi.fn<() => { displayName: string; name: string }>(() => ({
    displayName: ' Ada Lovelace ',
    name: 'ada',
  })),
}));
vi.mock('azure-devops-extension-sdk', () => ({
  getUser: sdk.getUser,
  getService: vi.fn<() => Promise<unknown>>(async () => ({
    getHash: async () => 'policy',
    replaceHash: sdk.replaceHash,
  })),
}));

const api = vi.hoisted((): DevOpsApi => ({
  collectionUrl: 'https://dev.azure.com/contoso/',
  get: vi.fn<DevOpsApi['get']>(),
  patch: vi.fn<DevOpsApi['patch']>(),
  post: vi.fn<DevOpsApi['post']>(),
}));
const rest = vi.hoisted(() => ({ createDevOpsApi: vi.fn<() => Promise<DevOpsApi>>() }));
vi.mock('../devops/rest', () => rest);

const store = vi.hoisted(() => ({
  listConfigurations: vi.fn<typeof Store.listConfigurations>(async () => []),
  saveConfiguration: vi.fn<typeof Store.saveConfiguration>(async (doc) => doc),
  deleteConfiguration: vi.fn<typeof Store.deleteConfiguration>(async () => undefined),
  loadSecret: vi.fn<typeof Store.loadSecret>(async () => null),
  saveSecret: vi.fn<typeof Store.saveSecret>(async (id, secret, boundOrigin) => ({
    id,
    version: 1,
    secret,
    boundOrigin,
  })),
  deleteSecret: vi.fn<typeof Store.deleteSecret>(async () => undefined),
  copySecret: vi.fn<typeof Store.copySecret>(async () => true),
}));
vi.mock('../devops/configurationStore', () => store);

const layout = vi.hoisted(() => ({
  scanProcessControls: vi.fn<typeof Layout.scanProcessControls>(async () => []),
  updateControlInputs: vi.fn<typeof Layout.updateControlInputs>(async (_api, control) => control),
}));
vi.mock('../devops/layout', () => layout);

const permissions = vi.hoisted(() => ({
  loadPermissions: vi.fn<typeof Permissions.loadPermissions>(),
}));
vi.mock('../devops/permissions', () => permissions);

const processes = vi.hoisted(() => ({
  listProcesses: vi.fn<typeof Processes.listProcesses>(async () => []),
}));
vi.mock('../devops/processes', () => processes);

const policyStore = vi.hoisted(() => ({
  loadPolicy: vi.fn<typeof PolicyStore.loadPolicy>(),
  savePolicy: vi.fn<typeof PolicyStore.savePolicy>(async (policy) => policy),
}));
vi.mock('../devops/policyStore', () => policyStore);

beforeEach(() => {
  vi.clearAllMocks();
  rest.createDevOpsApi.mockResolvedValue(api);
  permissions.loadPermissions.mockResolvedValue(ADMIN);
  policyStore.loadPolicy.mockResolvedValue(DEFAULT_POLICY);
});

describe('the Azure DevOps services', () => {
  it('reads configurations fresh and passes the organization’s API on', async () => {
    const services = createDevOpsServices();
    expect(services.mode).toBe('devops');
    expect(services.currentUser()).toEqual({ displayName: 'Ada Lovelace' });
    await services.listConfigurations();
    expect(store.listConfigurations).toHaveBeenCalledWith({ fresh: true });
    await services.listProcesses();
    expect(processes.listProcesses).toHaveBeenCalledWith(api);
    await services.loadPermissions(PROCESSES);
    expect(permissions.loadPermissions).toHaveBeenCalledWith(api, PROCESSES);
    const control = layoutControl();
    await services.scanProcessControls({ id: 'p-contoso', name: 'Contoso Agile' });
    expect(layout.scanProcessControls).toHaveBeenCalledWith(api, {
      id: 'p-contoso',
      name: 'Contoso Agile',
    });
    await services.updateControlInputs(control, {
      FieldName: 'Custom.Customer',
      Configuration: 'X',
    });
    expect(layout.updateControlInputs).toHaveBeenCalledWith(api, control, {
      FieldName: 'Custom.Customer',
      Configuration: 'X',
    });
    await services.copySecret('a', 'b');
    expect(store.copySecret).toHaveBeenCalledWith('a', 'b');
    await services.loadPolicy();
    expect(policyStore.loadPolicy).toHaveBeenCalledWith({ fresh: true, strict: true });
    // One API client for everything.
    expect(rest.createDevOpsApi).toHaveBeenCalledTimes(1);
  });

  it('never fails the permission check outright, and tries the API again later', async () => {
    rest.createDevOpsApi.mockRejectedValueOnce(
      new PicklistError('config', 'Azure DevOps didn’t provide a valid organization address.')
    );
    const services = createDevOpsServices();
    expect(await services.loadPermissions(PROCESSES)).toEqual({
      collectionAdmin: false,
      editableProcessIds: new Set(),
      error:
        'Couldn’t check your permissions (Azure DevOps couldn’t be reached). Editing is turned off until it works.',
    });
    expect(permissions.loadPermissions).not.toHaveBeenCalled();
    await services.loadPermissions(PROCESSES);
    expect(permissions.loadPermissions).toHaveBeenCalledTimes(1);
  });

  it('follows the host page’s address', async () => {
    const services = createDevOpsServices();
    expect(await services.getHash?.()).toBe('policy');
    services.replaceHash?.('configurations');
    await vi.waitFor(() => expect(sdk.replaceHash).toHaveBeenCalledWith('configurations'));
  });
});
