import type { PicklistHost } from '../control/controller';
import { PicklistController } from '../control/controller';
import { ResponseCache } from '../core/cache';
import { AUTH_METHOD_LABELS, DEFAULT_OAUTH, INPUT_IDS, formatOAuthSettings } from '../core/config';
import type { ConfigurationDocument } from '../core/configurations';
import { findConfigurationForProcess } from '../core/configurations';
import { FIELD_TYPE } from '../core/fieldTypes';
import { formatMultiValue, parseMultiValue } from '../core/multi';
import type { SecurityPolicy } from '../core/policy';
import { DEFAULT_POLICY } from '../core/policy';
import type { StoredSecret } from '../core/secrets';
import { summarizeSecret } from '../core/secrets';
import type { WorkItemFieldInfo } from '../devops/formService';
import type { Customer, MockSignIn } from './mockApi';
import {
  MOCK_CREDENTIALS,
  MOCK_ENDPOINT,
  MOCK_ORIGIN,
  MOCK_TOKEN_ORIGIN,
  MOCK_TOKEN_URL,
  createMockFetch,
  findCustomer,
} from './mockApi';
import { MockWorkItem } from './mockWorkItem';
import type { Scenario } from './scenario';
import { Store } from './store';

export const FIELDS = {
  title: 'System.Title',
  project: 'System.TeamProject',
  region: 'Custom.Region',
  customer: 'Custom.Customer',
  customerId: 'Custom.CustomerId',
  customerEmail: 'Custom.CustomerEmail',
} as const;

export const PROJECT = 'Fabrikam Fiber';

/** The configuration the configuration and OAuth 2.0 scenarios use, and where it's shared. */
export const CONFIGURATION = {
  id: '3f6c2a1e-8b4d-4e5f-9a7b-2c1d0e9f8a7b',
  name: 'Customers',
  formerName: 'Customer list',
  process: 'Fabrikam Agile',
  processId: 'e31fd6e1-c6af-44bb-925e-dfa71f551463',
} as const;

/** What the “Policy blocks host” scenario allows: anything but the mock service. */
export const BLOCKING_POLICY: SecurityPolicy = {
  ...DEFAULT_POLICY,
  allowedHosts: ['api.fabrikam.example', '*.northwind.example'],
};

/** Starting values that leave room for about three more in a 255-character field. */
const NEAR_LIMIT = [
  'Adventure Works',
  'Blue Yonder Airlines',
  'City Power & Light',
  'Consolidated Messenger',
  'Contoso',
  'Fabrikam',
  'Graphic Design Institute',
  'Humongous Insurance',
  'Müller & Söhne Engineering',
  'Northwind Traders',
];

export type LookupState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'done'; project: string }
  | { status: 'failed'; message: string };

export interface Session {
  /** Changes with every new session, so the form's own state starts over too. */
  id: number;
  workItem: MockWorkItem;
  controller: PicklistController;
  /** Requests the mock API received. */
  requests: Store<number>;
  /** Requests the mock token service received. */
  tokenRequests: Store<number>;
  /** The host's configuration lookup. */
  lookup: Store<LookupState>;
  start: () => () => void;
  save: () => void;
  discard: () => void;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function fieldsFor(scenario: Scenario): WorkItemFieldInfo[] {
  const { multiple } = scenario;
  const lines = multiple && !scenario.singleLine ? FIELD_TYPE.PlainText : FIELD_TYPE.String;
  // Several IDs or emails joined with “; ” can outgrow a single-line field.
  const mapped = multiple ? FIELD_TYPE.PlainText : FIELD_TYPE.String;
  return [
    { referenceName: FIELDS.title, name: 'Title', type: FIELD_TYPE.String },
    { referenceName: FIELDS.project, name: 'Team Project', type: FIELD_TYPE.String },
    { referenceName: FIELDS.region, name: 'Region', type: FIELD_TYPE.String, isPicklist: true },
    { referenceName: FIELDS.customer, name: multiple ? 'Customers' : 'Customer', type: lines },
    {
      referenceName: FIELDS.customerId,
      name: multiple ? 'Customer IDs' : 'Customer ID',
      type: mapped,
    },
    {
      referenceName: FIELDS.customerEmail,
      name: multiple ? 'Customer emails' : 'Customer email',
      type: mapped,
    },
  ];
}

function startingNames(scenario: Scenario): string[] {
  if (scenario.empty) {
    return [];
  }
  if (scenario.value !== null) {
    const text = scenario.value.trim();
    return scenario.multiple ? parseMultiValue(text) : [text].filter(Boolean);
  }
  if (!scenario.multiple) {
    return ['Contoso'];
  }
  return scenario.singleLine ? NEAR_LIMIT : ['Contoso', 'Fabrikam', 'Northwind Traders'];
}

/** The picked customers and what the field map copied from them when the item was last saved. */
function startingValues(scenario: Scenario): Record<string, unknown> {
  const names = startingNames(scenario);
  const customers = names
    .map((name) => findCustomer(name))
    .filter((customer): customer is Customer => customer !== undefined);
  if (!scenario.multiple) {
    const [first] = customers;
    return {
      [FIELDS.customer]: names[0] ?? '',
      [FIELDS.customerId]: first?.id ?? '',
      [FIELDS.customerEmail]: first?.email ?? '',
    };
  }
  return {
    [FIELDS.customer]: formatMultiValue(names),
    [FIELDS.customerId]: formatMultiValue(customers.map((customer) => String(customer.id))),
    [FIELDS.customerEmail]: formatMultiValue(customers.map((customer) => customer.email)),
  };
}

/** Where the list comes from. */
export function dataSourceInputs(scenario: Scenario): Record<string, string> {
  const inputs: Record<string, string> = {
    [INPUT_IDS.url]: MOCK_ENDPOINT,
    [INPUT_IDS.params]: '{ "region": "$(Custom.Region)" }',
    [INPUT_IDS.arrayPath]: 'data.customers',
    [INPUT_IDS.keyField]: 'name',
    [INPUT_IDS.fieldMap]: '{ "Custom.CustomerId": "id", "Custom.CustomerEmail": "email" }',
  };
  if (scenario.secondLine) {
    inputs[INPUT_IDS.secondLine] = 'email';
  }
  if (scenario.paging) {
    // No path: the control finds "@odata.nextLink" by itself.
    inputs[INPUT_IDS.advanced] = '{ "paging": { "type": "nextLink" } }';
  }
  return inputs;
}

/** How the field behaves, as text settings (flags are "true" or left out). */
function behaviorSettings(scenario: Scenario): Record<string, string> {
  const settings: Record<string, string> = {};
  if (scenario.multiple) {
    settings[INPUT_IDS.allowMultiple] = 'true';
  }
  if (scenario.load === 'form') {
    settings[INPUT_IDS.loadOnFormOpen] = 'true';
  }
  if (scenario.required) {
    settings[INPUT_IDS.required] = 'true';
  }
  return settings;
}

/** The secret the configuration signs in with, and the only origin it may be sent to. */
function configurationSecret(scenario: Scenario): { secret: StoredSecret; boundOrigin: string } {
  return scenario.source === 'oauth'
    ? {
        secret: { kind: 'clientSecret', value: MOCK_CREDENTIALS.clientSecret },
        boundOrigin: MOCK_TOKEN_ORIGIN,
      }
    : { secret: { kind: 'apiKey', value: MOCK_CREDENTIALS.apiKey }, boundOrigin: MOCK_ORIGIN };
}

/** The configuration as Organization settings › Extensions › REST Picklist would keep it. */
function configurationDocument(scenario: Scenario): ConfigurationDocument {
  const settings = { ...dataSourceInputs(scenario), ...behaviorSettings(scenario) };
  if (scenario.source === 'oauth') {
    settings[INPUT_IDS.authMethod] = AUTH_METHOD_LABELS.oauth2;
    settings[INPUT_IDS.oauth] = formatOAuthSettings({
      ...DEFAULT_OAUTH,
      tokenUrl: MOCK_TOKEN_URL,
      clientId: MOCK_CREDENTIALS.clientId,
      scope: 'customers.read',
      extraParams: {},
    });
  } else {
    settings[INPUT_IDS.authMethod] = AUTH_METHOD_LABELS.apiKey;
  }
  const { secret, boundOrigin } = configurationSecret(scenario);
  return {
    id: CONFIGURATION.id,
    version: 1,
    name: CONFIGURATION.name,
    aliases: [CONFIGURATION.formerName],
    processIds: [CONFIGURATION.processId],
    settings,
    secret: scenario.secretMissing
      ? null
      : summarizeSecret(secret, boundOrigin, {
          updatedBy: 'Ana Díaz',
          updatedAt: '2026-10-22T14:03:00.000Z',
        }),
  };
}

/** The control's Options, as the work item form passes them (booleans arrive as text). */
function controlInputs(scenario: Scenario): Record<string, string> {
  const field = { [INPUT_IDS.fieldName]: FIELDS.customer };
  switch (scenario.source) {
    case 'configuration':
    case 'oauth':
      return {
        ...field,
        [INPUT_IDS.configuration]: scenario.configurationName ?? CONFIGURATION.name,
      };
    case 'legacy':
      return {
        ...field,
        [INPUT_IDS.allowMultiple]: String(scenario.multiple),
        [INPUT_IDS.loadOnFormOpen]: String(scenario.load === 'form'),
        [INPUT_IDS.required]: String(scenario.required),
        ...dataSourceInputs(scenario),
      };
    default:
      // Only the field: everything else moved to the settings page.
      return field;
  }
}

function signInFor(scenario: Scenario): MockSignIn {
  switch (scenario.source) {
    case 'configuration':
      return 'apiKey';
    case 'oauth':
      return 'oauth2';
    default:
      return 'none';
  }
}

let sessions = 0;

/** A fresh work item and control, as if the form had just been opened. */
export function createSession(scenario: Scenario): Session {
  const workItem = new MockWorkItem(fieldsFor(scenario), {
    [FIELDS.title]: 'Replace pressure transmitters on line 4',
    [FIELDS.project]: PROJECT,
    [FIELDS.region]: '',
    ...startingValues(scenario),
  });
  workItem.setRequired(FIELDS.customer, scenario.ruleRequired);
  const requests = new Store(0);
  const tokenRequests = new Store(0);
  const lookup = new Store<LookupState>({ status: 'idle' });
  const slow = scenario.network === 'slow';

  const host: PicklistHost = {
    getFormService: async () => workItem,
    fetch: createMockFetch({
      network: scenario.network,
      size: scenario.size,
      paging: scenario.paging,
      signIn: signInFor(scenario),
      onRequest: () => requests.set(requests.get() + 1),
      onTokenRequest: () => tokenRequests.set(tokenRequests.get() + 1),
    }),
    loadPolicy: async () => {
      await pause(120);
      return scenario.policyBlocks ? BLOCKING_POLICY : DEFAULT_POLICY;
    },
    // Found the way the store finds it: by name or former name, among those shared with the
    // work item's process.
    resolveConfiguration: async (name, project) => {
      lookup.set({ status: 'pending' });
      await pause(slow ? 1200 : 300);
      try {
        const doc = findConfigurationForProcess(
          [configurationDocument(scenario)],
          CONFIGURATION.processId,
          CONFIGURATION.process,
          name
        );
        lookup.set({ status: 'done', project });
        return {
          id: doc.id,
          name: doc.name,
          processId: CONFIGURATION.processId,
          processName: CONFIGURATION.process,
          settings: { ...doc.settings },
          secret: doc.secret,
        };
      } catch (error) {
        lookup.set({
          status: 'failed',
          message: error instanceof Error ? error.message : 'It couldn’t be found.',
        });
        throw error;
      }
    },
    loadSecret: async (id) => {
      await pause(slow ? 600 : 150);
      if (scenario.secretMissing || id !== CONFIGURATION.id) {
        return null;
      }
      return { id, version: 1, ...configurationSecret(scenario) };
    },
    // The setup page's demo, which the development server serves next to this page.
    settingsPageUrl: async () => new URL('configurator.html', window.location.href).href,
    openSettingsPage: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };
  const controller = new PicklistController(controlInputs(scenario), host, new ResponseCache());

  return {
    id: ++sessions,
    workItem,
    controller,
    requests,
    tokenRequests,
    lookup,
    start: () => {
      const stop = workItem.onChange((changed) =>
        controller.onFieldChanged({ id: 42, changedFields: changed })
      );
      void controller.onLoaded({ id: 42, isNew: false, isReadOnly: scenario.readOnly });
      return () => {
        stop();
        controller.onUnloaded();
      };
    },
    save: () => {
      workItem.save();
      void controller.onSaved();
    },
    discard: () => {
      workItem.reset();
      void controller.onReset();
    },
  };
}
