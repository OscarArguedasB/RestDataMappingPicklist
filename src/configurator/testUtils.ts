import { vi } from 'vitest';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import {
  permissionErrorMessage,
  permissionUnverifiedMessage,
  sortConfigurations,
} from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { DEFAULT_POLICY } from '../core/policy';
import type { SecurityPolicy } from '../core/policy';
import type { SecretDocument } from '../core/secrets';
import type { ProcessSummary, SetupServices } from './services';

// Shared helpers for the setup page's component tests (jsdom only).

/** jsdom has no matchMedia; the combobox uses it to size rows for touch screens. */
export function installMatchMedia(): void {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A system process, two inherited ones and a Hosted XML one, sorted by name like the API. */
export const PROCESSES: ProcessSummary[] = [
  {
    id: 'p-agile',
    name: 'Agile',
    customizationType: 'system',
    isEnabled: true,
    projectNames: [],
    projectIds: [],
    parentProcessTypeId: '',
  },
  {
    id: 'p-contoso',
    name: 'Contoso Agile',
    customizationType: 'inherited',
    isEnabled: true,
    projectNames: ['Contoso Web'],
    projectIds: ['1'],
    parentProcessTypeId: 'p-agile',
  },
  {
    id: 'p-fabrikam',
    name: 'Fabrikam Scrum',
    customizationType: 'inherited',
    isEnabled: true,
    projectNames: ['Fabrikam Mobile'],
    projectIds: ['2'],
    parentProcessTypeId: 'p-scrum',
  },
  {
    id: 'p-northwind',
    name: 'Northwind Field Service',
    customizationType: 'custom',
    isEnabled: true,
    projectNames: ['Northwind Traders'],
    projectIds: ['3'],
    parentProcessTypeId: '',
  },
];

/** A Project Collection Administrator: may change everything. */
export const ADMIN: PermissionSnapshot = {
  collectionAdmin: true,
  editableProcessIds: new Set(),
  error: null,
};

/** Someone with “Edit process” permission on the given processes only. */
export function editorOf(...processIds: string[]): PermissionSnapshot {
  return { collectionAdmin: false, editableProcessIds: new Set(processIds), error: null };
}

/** Someone who may only look. */
export const VIEWER: PermissionSnapshot = editorOf();

/** The permission check failed: everything is read-only. */
export const PERMISSION_CHECK_FAILED: PermissionSnapshot = {
  collectionAdmin: false,
  editableProcessIds: new Set(),
  error: permissionErrorMessage('Azure DevOps answered 500'),
};

/** Azure DevOps refused the permission check: editing stays on, with a note. */
export const PERMISSION_CHECK_REFUSED: PermissionSnapshot = {
  collectionAdmin: false,
  editableProcessIds: new Set(),
  error: null,
  unverified: permissionUnverifiedMessage('Azure DevOps answered 403'),
};

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'config'
  );
}

/** A stored configuration, shared with Contoso Agile unless overridden. */
export function configuration(
  name: string,
  overrides: Partial<ConfigurationDocument> = {}
): ConfigurationDocument {
  return {
    id: `cfg-${slug(name)}`,
    __etag: 1,
    version: 1,
    name,
    aliases: [],
    processIds: ['p-contoso'],
    settings: { RestServiceAddress: `https://api.contoso.com/${slug(name)}` },
    secret: null,
    createdBy: 'Megan Bowen',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedBy: 'Megan Bowen',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

/** A REST Picklist control in Contoso Agile's Bug form unless overridden. */
export function layoutControl(overrides: Partial<LayoutControl> = {}): LayoutControl {
  const inputs = overrides.inputs ?? { FieldName: overrides.fieldName ?? 'Custom.Customer' };
  const controlId = overrides.controlId ?? 'rp-1';
  const label = overrides.label ?? 'Customer';
  return {
    processId: 'p-contoso',
    processName: 'Contoso Agile',
    workItemType: { name: 'Bug', referenceName: 'Contoso.Bug' },
    groupId: 'group-1',
    controlId,
    label,
    fieldName: typeof inputs.FieldName === 'string' ? inputs.FieldName : '',
    inputs,
    control: {
      id: controlId,
      label,
      isContribution: true,
      contribution: {
        contributionId: 'OscarArguedasBarboza.RestDataMappingPicklist.rest-data-mapping-picklist',
        inputs,
      },
    },
    ...overrides,
  };
}

/** What the fake services start with; every list is copied, so tests can reuse their constants. */
export interface FakeData {
  processes: ProcessSummary[];
  permissions: PermissionSnapshot;
  configurations: ConfigurationDocument[];
  secrets: SecretDocument[];
  controls: LayoutControl[];
  policy: SecurityPolicy;
}

const STAMP = '2026-10-22T14:03:00.000Z';

/**
 * Setup services kept in memory, for component tests. Every member is a vi.fn, so tests can check
 * calls or replace one answer (mockRejectedValueOnce and friends); `overrides` replaces members
 * outright. Saving works like extension data: a new configuration gets __etag 1, an update with
 * an older __etag is refused with a 409, and the stamps name “Ada Lovelace”.
 */
export function fakeServices(
  overrides: Partial<SetupServices> = {},
  data: Partial<FakeData> = {}
): SetupServices {
  const user = 'Ada Lovelace';
  const processes = (data.processes ?? PROCESSES).map((process) => ({ ...process }));
  const permissions = data.permissions ?? ADMIN;
  const configurations = new Map(
    (data.configurations ?? []).map((doc) => [doc.id, structuredClone(doc)])
  );
  const secrets = new Map((data.secrets ?? []).map((doc) => [doc.id, structuredClone(doc)]));
  let controls = (data.controls ?? []).map((control) => structuredClone(control));
  let policy: SecurityPolicy = data.policy ?? DEFAULT_POLICY;

  const services: SetupServices = {
    mode: 'devops',
    currentUser: vi.fn<SetupServices['currentUser']>(() => ({ displayName: user })),
    listProcesses: vi.fn<SetupServices['listProcesses']>(async () =>
      processes.map((process) => ({ ...process }))
    ),
    loadPermissions: vi.fn<SetupServices['loadPermissions']>(async () => permissions),
    listConfigurations: vi.fn<SetupServices['listConfigurations']>(async () =>
      sortConfigurations([...configurations.values()].map((doc) => structuredClone(doc)))
    ),
    saveConfiguration: vi.fn<SetupServices['saveConfiguration']>(async (doc) => {
      const stored = configurations.get(doc.id);
      if (doc.__etag === undefined ? stored !== undefined : stored?.__etag !== doc.__etag) {
        throw new PicklistError(
          'http',
          `Someone changed “${doc.name}” since you opened it. Reload to see their changes.`,
          409
        );
      }
      const saved: ConfigurationDocument = {
        ...structuredClone(doc),
        __etag: (stored?.__etag ?? 0) + 1,
        createdBy: stored ? stored.createdBy : user,
        createdAt: stored ? stored.createdAt : STAMP,
        updatedBy: user,
        updatedAt: STAMP,
      };
      configurations.set(saved.id, saved);
      return structuredClone(saved);
    }),
    deleteConfiguration: vi.fn<SetupServices['deleteConfiguration']>(async (doc) => {
      configurations.delete(doc.id);
      secrets.delete(doc.id);
    }),
    loadSecret: vi.fn<SetupServices['loadSecret']>(async (id) => {
      const secret = secrets.get(id);
      return secret ? structuredClone(secret) : null;
    }),
    saveSecret: vi.fn<SetupServices['saveSecret']>(async (id, secret, boundOrigin, apiOrigin) => {
      const saved: SecretDocument = {
        id,
        version: 1,
        secret: structuredClone(secret),
        boundOrigin,
        ...(apiOrigin ? { apiOrigin } : {}),
        updatedBy: user,
        updatedAt: STAMP,
      };
      secrets.set(id, saved);
      return structuredClone(saved);
    }),
    deleteSecret: vi.fn<SetupServices['deleteSecret']>(async (id) => {
      secrets.delete(id);
    }),
    copySecret: vi.fn<SetupServices['copySecret']>(async (fromId, toId) => {
      const source = secrets.get(fromId);
      if (!source) {
        return false;
      }
      secrets.set(toId, { ...structuredClone(source), id: toId });
      return true;
    }),
    scanProcessControls: vi.fn<SetupServices['scanProcessControls']>(async (process) =>
      controls
        .filter((control) => control.processId === process.id)
        .map((control) => structuredClone(control))
    ),
    updateControlInputs: vi.fn<SetupServices['updateControlInputs']>(async (control, inputs) => {
      // Like Azure DevOps: the control comes back with exactly the inputs sent.
      const contribution = control.control.contribution;
      const updated: LayoutControl = {
        ...structuredClone(control),
        fieldName: inputs.FieldName ?? '',
        inputs: { ...inputs },
        control: {
          ...structuredClone(control.control),
          contribution: {
            ...(typeof contribution === 'object' && contribution
              ? structuredClone(contribution)
              : {}),
            inputs: { ...inputs },
          },
        },
      };
      controls = controls.map((existing) =>
        existing.processId === control.processId &&
        existing.workItemType.referenceName === control.workItemType.referenceName &&
        existing.controlId === control.controlId
          ? updated
          : existing
      );
      return structuredClone(updated);
    }),
    loadPolicy: vi.fn<SetupServices['loadPolicy']>(async () => policy),
    savePolicy: vi.fn<SetupServices['savePolicy']>(async (next: SecurityPolicy) => {
      policy = { ...next, changedBy: user, changedAt: '2026-09-20T10:00:00.000Z' };
      return policy;
    }),
    replaceHash: vi.fn<(hash: string) => void>(),
    ...overrides,
  };
  return services;
}
