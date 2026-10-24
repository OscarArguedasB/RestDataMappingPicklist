import * as SDK from 'azure-devops-extension-sdk';
import { permissionErrorMessage } from '../core/configurations';
import { isPlainObject } from '../core/values';
import {
  copySecret,
  deleteConfiguration,
  deleteSecret,
  listConfigurations,
  loadSecret,
  saveConfiguration,
  saveSecret,
} from '../devops/configurationStore';
import { scanProcessControls, updateControlInputs } from '../devops/layout';
import { loadPermissions } from '../devops/permissions';
import { loadPolicy, savePolicy } from '../devops/policyStore';
import { listProcesses } from '../devops/processes';
import type { DevOpsApi } from '../devops/rest';
import { createDevOpsApi } from '../devops/rest';
import type { SetupServices } from './services';

/** The host's navigation service (azure-devops-extension-api's IHostNavigationService, in part). */
interface HostNavigationService {
  getHash(): Promise<string>;
  replaceHash(hash: string): void;
}

const HOST_NAVIGATION_SERVICE_ID = 'ms.vss-features.host-navigation-service';

function isHostNavigationService(value: unknown): value is HostNavigationService {
  return (
    isPlainObject(value) &&
    typeof value.getHash === 'function' &&
    typeof value.replaceHash === 'function'
  );
}

/** The setup page's services inside Azure DevOps. Call after SDK.init. */
export function createDevOpsServices(): SetupServices {
  let api: Promise<DevOpsApi> | null = null;
  const getApi = () => {
    api ??= createDevOpsApi().catch((error: unknown) => {
      // Let the next action try again instead of repeating the same failure forever.
      api = null;
      throw error;
    });
    return api;
  };

  let navigation: Promise<HostNavigationService | null> | null = null;
  const getNavigation = () => {
    navigation ??= SDK.getService<unknown>(HOST_NAVIGATION_SERVICE_ID).then(
      (service) => (isHostNavigationService(service) ? service : null),
      () => null
    );
    return navigation;
  };

  return {
    mode: 'devops',
    currentUser: () => {
      try {
        const user = SDK.getUser();
        return { displayName: (user.displayName || user.name || '').trim() };
      } catch {
        return { displayName: '' };
      }
    },
    listProcesses: async () => listProcesses(await getApi()),
    loadPermissions: async (processes) => {
      let client: DevOpsApi;
      try {
        client = await getApi();
      } catch {
        // Never rejects, like loadPermissions itself: the page turns editing off instead.
        return {
          collectionAdmin: false,
          editableProcessIds: new Set<string>(),
          error: permissionErrorMessage('Azure DevOps couldn’t be reached'),
        };
      }
      return loadPermissions(client, processes);
    },
    // The setup page always reads what's stored, never the forms' five-minute copy.
    listConfigurations: () => listConfigurations({ fresh: true }),
    saveConfiguration: (doc) => saveConfiguration(doc),
    deleteConfiguration: (doc) => deleteConfiguration(doc),
    loadSecret: (id) => loadSecret(id),
    saveSecret: (id, secret, boundOrigin, apiOrigin) =>
      saveSecret(id, secret, boundOrigin, apiOrigin === undefined ? {} : { apiOrigin }),
    deleteSecret: (id) => deleteSecret(id),
    copySecret: (fromId, toId) => copySecret(fromId, toId),
    scanProcessControls: async (process) => scanProcessControls(await getApi(), process),
    updateControlInputs: async (control, inputs) =>
      updateControlInputs(await getApi(), control, inputs),
    loadPolicy: () => loadPolicy({ fresh: true, strict: true }),
    savePolicy: (policy) => savePolicy(policy),
    getHash: async () => {
      try {
        return (await (await getNavigation())?.getHash()) ?? '';
      } catch {
        return '';
      }
    },
    replaceHash: (hash) => {
      void getNavigation().then((service) => {
        try {
          service?.replaceHash(hash);
        } catch {
          // The address bar just doesn't follow the tabs.
        }
      });
    },
  };
}
