import * as SDK from 'azure-devops-extension-sdk';
import type { WorkItemFormService } from '../devops/formService';
import { WORK_ITEM_FORM_SERVICE_ID } from '../devops/formService';
import type { DevOpsApi } from '../devops/rest';
import type { PicklistHost } from './controller';

const navigation = () => import('../devops/navigation');
const configurationStore = () => import('../devops/configurationStore');

/**
 * `rest.ts`, `policyStore.ts`, `configurationStore.ts`, `savedConfigurations.ts` and
 * `navigation.ts` call the Azure DevOps REST APIs and services; a work item that never opens this
 * control's list (or opens it without a configuration) never runs most of that code, so it's
 * imported lazily here instead of bundled into the control's startup script. This never adds a
 * request on its own: each module only downloads once something that needs it is called (finding
 * the configuration, its secret, the policy, or the address of the settings page), and the
 * secret and policy only when the list is loaded. `getFormService` and resizing use the SDK
 * directly and stay eager: every work item needs them.
 */
export function createDevOpsHost(): PicklistHost {
  // Created on first use, then reused.
  let api: Promise<DevOpsApi> | null = null;
  const devOpsApi = (): Promise<DevOpsApi> => {
    api ??= import('../devops/rest')
      .then(({ createDevOpsApi }) => createDevOpsApi())
      .catch((error: unknown) => {
        api = null;
        throw error;
      });
    return api;
  };
  return {
    getFormService: () => SDK.getService<WorkItemFormService>(WORK_ITEM_FORM_SERVICE_ID),
    loadPolicy: async (options) =>
      (await import('../devops/policyStore')).loadPolicy(options?.strict ? { strict: true } : {}),
    resolveSavedInputs: async (name, projectName) => {
      const [resolvedApi, { resolveSavedInputs }] = await Promise.all([
        devOpsApi(),
        import('../devops/savedConfigurations'),
      ]);
      return resolveSavedInputs(resolvedApi, projectName, name);
    },
    resolveConfiguration: async (name, projectName) => {
      const [resolvedApi, { resolveConfiguration }] = await Promise.all([
        devOpsApi(),
        configurationStore(),
      ]);
      return resolveConfiguration(resolvedApi, projectName, name);
    },
    // Kept in memory by the controller only: never cached, logged or shown.
    loadSecret: async (configurationId) => (await configurationStore()).loadSecret(configurationId),
    settingsPageUrl: async () => {
      try {
        // The organization's address comes from the location service, which makes no request.
        const [resolvedApi, { settingsPageUrl }] = await Promise.all([devOpsApi(), navigation()]);
        return settingsPageUrl(resolvedApi.collectionUrl, SDK.getExtensionContext());
      } catch {
        return null;
      }
    },
    openSettingsPage: (url) => {
      void navigation().then(
        ({ openSettingsPage }) => openSettingsPage(url),
        () => {
          // The module couldn't be downloaded; the address was checked when it was made.
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      );
    },
  };
}

/** Resizes the control's iframe, skipping calls that wouldn't change anything. */
export function createFrameResizer(): (height: number) => void {
  let lastHeight = -1;
  return (height) => {
    if (height !== lastHeight) {
      lastHeight = height;
      SDK.resize(undefined, height);
    }
  };
}
