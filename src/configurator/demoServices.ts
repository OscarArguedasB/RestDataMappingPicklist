import { INPUT_IDS, formatOAuthSettings, DEFAULT_OAUTH } from '../core/config';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import {
  canEditProcess,
  permissionErrorMessage,
  permissionUnverifiedMessage,
  sortConfigurations,
} from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import type { SecurityPolicy } from '../core/policy';
import { parsePolicy } from '../core/policy';
import type { CertificateInfo, SecretDocument, SigningKey, StoredSecret } from '../core/secrets';
import type { DemoPersona, ProcessSummary, SetupServices } from './services';

// Sample data for running the setup page outside Azure DevOps (local development, screenshots).
// index.tsx only loads this module when process.env.NODE_ENV isn't 'production', so none of it
// ships in the extension package. Everything is kept in memory: reload the page to start over.

/** A reserved domain (RFC 2606) the demo answers itself, so testing works offline too. */
export const DEMO_API_ORIGIN = 'https://api.contoso.example';
/** The demo's OAuth 2.0 token service, answered by demoFetch too. */
export const DEMO_AUTH_ORIGIN = 'https://login.contoso.example';

const CONTRIBUTION_ID = 'OscarArguedasBarboza.RestDataMappingPicklist.rest-data-mapping-picklist';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_USER = 'Megan Bowen';

const CONTOSO = 'demo-contoso-agile';
const FABRIKAM = 'demo-fabrikam-scrum';
const NORTHWIND = 'demo-northwind';

const PROCESSES: ProcessSummary[] = [
  {
    id: 'demo-agile',
    name: 'Agile',
    customizationType: 'system',
    isEnabled: true,
    projectNames: [],
    projectIds: [],
    parentProcessTypeId: '',
  },
  {
    id: CONTOSO,
    name: 'Contoso Agile',
    customizationType: 'inherited',
    isEnabled: true,
    projectNames: ['Contoso Web', 'Fabrikam Fiber'],
    projectIds: ['p-1', 'p-2'],
    parentProcessTypeId: 'demo-agile',
  },
  {
    id: FABRIKAM,
    name: 'Fabrikam Scrum',
    customizationType: 'inherited',
    isEnabled: true,
    projectNames: ['Fabrikam Mobile'],
    projectIds: ['p-3'],
    parentProcessTypeId: 'demo-scrum',
  },
  {
    id: NORTHWIND,
    name: 'Northwind Field Service',
    customizationType: 'custom',
    isEnabled: true,
    projectNames: ['Northwind Traders'],
    projectIds: ['p-4'],
    parentProcessTypeId: '',
  },
  {
    id: 'demo-scrum',
    name: 'Scrum',
    customizationType: 'system',
    isEnabled: true,
    projectNames: [],
    projectIds: [],
    parentProcessTypeId: '',
  },
];

const PERSONAS: readonly DemoPersona[] = [
  { id: 'admin', label: 'Project Collection Administrator' },
  { id: 'editor', label: 'Editor of Contoso Agile only' },
  { id: 'viewer', label: 'Viewer without Edit process permission' },
  { id: 'failed', label: 'Someone whose permission check fails' },
  { id: 'refused', label: 'Someone whose permission check is refused (403)' },
];

function permissionsOf(persona: string): PermissionSnapshot {
  switch (persona) {
    case 'admin':
      return { collectionAdmin: true, editableProcessIds: new Set(), error: null };
    case 'editor':
      return { collectionAdmin: false, editableProcessIds: new Set([CONTOSO]), error: null };
    case 'failed':
      return {
        collectionAdmin: false,
        editableProcessIds: new Set(),
        error: permissionErrorMessage('Azure DevOps answered 500'),
      };
    case 'refused':
      return {
        collectionAdmin: false,
        editableProcessIds: new Set(),
        error: null,
        unverified: permissionUnverifiedMessage('Azure DevOps answered 403'),
      };
    default:
      return { collectionAdmin: false, editableProcessIds: new Set(), error: null };
  }
}

// What the test certificates in src/core/__fixtures__/credentials.ts say about themselves (only
// the public description, never a key), so the demo shows realistic details.
const SERVICE_DESK_CERTIFICATE: CertificateInfo = {
  subject:
    'emailAddress=picklist@example.com,CN=picklist-rsa,OU=Integration,O=Contoso\\, Ltd.,L=San José,ST=San José,C=CR',
  issuer: 'CN=REST Picklist Test CA,O=Contoso\\, Ltd.,C=US',
  serialNumber: '01',
  notBefore: '2026-10-01T00:00:00.000Z',
  notAfter: '2027-10-01T00:00:00.000Z',
  sha1Thumbprint: 'E2B5B2341C93DA46FAC956390D5CD17814B5DD65',
  sha256Thumbprint: '869C7DC0F7F6194D6998EDB7CF96115514F94AD3D466CA2220AF4147120E4077',
};

/** A certificate that runs out 12 days after the demo starts, whenever that is. */
function expiringCertificate(now: number): CertificateInfo {
  return {
    subject: 'CN=picklist-ec-256,O=Contoso',
    issuer: 'CN=picklist-ec-256,O=Contoso',
    serialNumber: '0A',
    notBefore: new Date(now - 353 * DAY_MS).toISOString(),
    notAfter: new Date(now + 12 * DAY_MS).toISOString(),
    sha1Thumbprint: 'EC767577B8C62AFF833D963B1DC9463F1B325ED2',
    sha256Thumbprint: '0D6217E46A6883D4A59D1943524F1205FB85552166C453C7168F834E20994053',
  };
}

function oauthSettings(clientId: string, scope: string): string {
  return formatOAuthSettings({
    ...DEFAULT_OAUTH,
    tokenUrl: `${DEMO_AUTH_ORIGIN}/oauth2/token`,
    clientId,
    scope,
    clientAuthentication: 'privateKeyJwt',
  });
}

function sampleConfigurations(now: number): ConfigurationDocument[] {
  const stamp = (daysAgo: number, by = 'Ana Díaz') => ({
    createdBy: by,
    createdAt: new Date(now - (daysAgo + 30) * DAY_MS).toISOString(),
    updatedBy: by,
    updatedAt: new Date(now - daysAgo * DAY_MS).toISOString(),
  });
  return [
    {
      id: 'demo-customers',
      __etag: 3,
      version: 1,
      name: 'Customers API',
      aliases: ['Customers'],
      processIds: [CONTOSO, FABRIKAM],
      settings: {
        [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/customers`,
        [INPUT_IDS.arrayPath]: 'data.result',
        [INPUT_IDS.keyField]: 'name',
        [INPUT_IDS.secondLine]: 'email',
        [INPUT_IDS.fieldMap]: '{ "Custom.CustomerId": "id", "Custom.CustomerEmail": "email" }',
        [INPUT_IDS.notFoundMessage]: 'This customer is no longer active.',
        [INPUT_IDS.advanced]: '{"paging":{"type":"nextLink"}}',
      },
      secret: null,
      ...stamp(2),
    },
    {
      id: 'demo-service-desk',
      __etag: 1,
      version: 1,
      name: 'Service desk',
      aliases: [],
      processIds: [CONTOSO],
      settings: {
        [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/tickets`,
        [INPUT_IDS.params]: '{ "state": "open" }',
        [INPUT_IDS.authMethod]: 'OAuth 2.0',
        [INPUT_IDS.oauth]: oauthSettings('picklist-service-desk', 'tickets.read'),
        [INPUT_IDS.arrayPath]: 'items',
        [INPUT_IDS.keyField]: 'number',
        [INPUT_IDS.secondLine]: 'title',
      },
      secret: {
        kind: 'signingKey',
        boundOrigin: DEMO_AUTH_ORIGIN,
        algorithm: 'RS256',
        updatedBy: 'Ana Díaz',
        updatedAt: new Date(now - 9 * DAY_MS).toISOString(),
        certificate: SERVICE_DESK_CERTIFICATE,
      },
      ...stamp(9),
    },
    {
      id: 'demo-people',
      __etag: 2,
      version: 1,
      name: 'People directory',
      aliases: [],
      processIds: [CONTOSO],
      settings: {
        [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/people`,
        [INPUT_IDS.authMethod]: 'Bearer token',
        [INPUT_IDS.secondLine]: 'mail',
      },
      // Signs in, but nobody has entered the token yet.
      secret: null,
      ...stamp(20, DEMO_USER),
    },
    {
      id: 'demo-regions',
      __etag: 1,
      version: 1,
      name: 'Regions',
      aliases: [],
      processIds: [FABRIKAM],
      settings: {
        [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/regions`,
        [INPUT_IDS.authMethod]: 'API key',
      },
      secret: {
        kind: 'apiKey',
        boundOrigin: DEMO_API_ORIGIN,
        updatedBy: DEMO_USER,
        updatedAt: new Date(now - 40 * DAY_MS).toISOString(),
      },
      ...stamp(40, DEMO_USER),
    },
    {
      id: 'demo-partners',
      __etag: 4,
      version: 1,
      name: 'Partner portal',
      aliases: [],
      processIds: [NORTHWIND],
      settings: {
        [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/customers`,
        [INPUT_IDS.authMethod]: 'OAuth 2.0',
        [INPUT_IDS.oauth]: oauthSettings('picklist-partners', 'partners.read'),
        [INPUT_IDS.arrayPath]: 'data.result',
      },
      secret: {
        kind: 'signingKey',
        boundOrigin: DEMO_AUTH_ORIGIN,
        algorithm: 'ES256',
        updatedBy: 'Ana Díaz',
        updatedAt: new Date(now - 353 * DAY_MS).toISOString(),
        certificate: expiringCertificate(now),
      },
      ...stamp(60),
    },
    {
      id: 'demo-old-crm',
      __etag: 7,
      version: 1,
      name: 'Old CRM',
      aliases: [],
      // A process that was deleted since.
      processIds: ['demo-retired-process'],
      settings: { [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/customers` },
      secret: null,
      ...stamp(200, DEMO_USER),
    },
  ];
}

interface DemoControl {
  processId: string;
  workItemType: string;
  label: string;
  inputs: Record<string, string>;
}

const CONTROLS: DemoControl[] = [
  {
    processId: CONTOSO,
    workItemType: 'Bug',
    label: 'Customer',
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Customer',
      [INPUT_IDS.configuration]: 'Customers API',
    },
  },
  {
    processId: CONTOSO,
    workItemType: 'User Story',
    label: 'Customer',
    // The configuration's former name, which still works.
    inputs: { [INPUT_IDS.fieldName]: 'Custom.Customer', [INPUT_IDS.configuration]: 'Customers' },
  },
  {
    processId: CONTOSO,
    workItemType: 'Task',
    label: 'Customer',
    // Uses a configuration, but its 3.0 settings are still stored, and another control uses them.
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Customer',
      [INPUT_IDS.configuration]: 'Customers API',
      [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/customers`,
      [INPUT_IDS.keyField]: 'name',
      [INPUT_IDS.saveConfiguration]: 'true',
      [INPUT_IDS.savedConfigurationName]: 'Old customers',
    },
  },
  {
    processId: CONTOSO,
    workItemType: 'Epic',
    label: 'Account',
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Account',
      [INPUT_IDS.savedConfiguration]: 'Old customers',
    },
  },
  {
    processId: CONTOSO,
    workItemType: 'Feature',
    label: 'Owner',
    // Not set up yet.
    inputs: { [INPUT_IDS.fieldName]: 'Custom.Owner' },
  },
  {
    processId: CONTOSO,
    workItemType: 'Task',
    label: 'Service desk ticket',
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Ticket',
      [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/tickets`,
      [INPUT_IDS.params]: '{ "state": "open" }',
      [INPUT_IDS.authMethod]: 'Bearer token',
      // Azure DevOps returns confidential inputs masked, if at all.
      [INPUT_IDS.password]: '********',
      [INPUT_IDS.arrayPath]: 'items',
      [INPUT_IDS.keyField]: 'number',
      [INPUT_IDS.secondLine]: 'title',
    },
  },
  {
    processId: CONTOSO,
    workItemType: 'Epic',
    label: 'Sponsor',
    // A 3.0 control that saves its settings for others.
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Sponsor',
      [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/people`,
      [INPUT_IDS.authMethod]: 'None',
      [INPUT_IDS.secondLine]: 'mail',
      [INPUT_IDS.saveConfiguration]: 'true',
      [INPUT_IDS.savedConfigurationName]: 'People',
    },
  },
  {
    processId: CONTOSO,
    workItemType: 'Bug',
    label: 'Reviewer',
    inputs: { [INPUT_IDS.fieldName]: 'Custom.Reviewer', [INPUT_IDS.savedConfiguration]: 'People' },
  },
  {
    processId: CONTOSO,
    workItemType: 'Issue',
    label: 'Vendor',
    inputs: { [INPUT_IDS.fieldName]: 'Custom.Vendor', [INPUT_IDS.configuration]: 'Vendors' },
  },
  {
    processId: FABRIKAM,
    workItemType: 'Product Backlog Item',
    label: 'Customer',
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Customer',
      [INPUT_IDS.configuration]: 'Customers API',
    },
  },
  {
    processId: FABRIKAM,
    workItemType: 'Product Backlog Item',
    label: 'Region',
    // Same settings as the Regions configuration: moving it reuses that one.
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Region',
      [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/regions`,
      [INPUT_IDS.authMethod]: 'API key',
      [INPUT_IDS.password]: 'demo-key-123',
    },
  },
  {
    processId: FABRIKAM,
    workItemType: 'Bug',
    label: 'Escalation contact',
    // A readable password (some layouts return them), which moves with the control.
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Escalation',
      [INPUT_IDS.url]: `${DEMO_API_ORIGIN}/people?team=escalation`,
      [INPUT_IDS.authMethod]: 'Basic',
      [INPUT_IDS.username]: 'svc-picklist',
      [INPUT_IDS.password]: 'demo-password',
      [INPUT_IDS.secondLine]: 'mail',
    },
  },
  {
    processId: NORTHWIND,
    workItemType: 'Work Order',
    label: 'Partner',
    inputs: {
      [INPUT_IDS.fieldName]: 'Custom.Partner',
      [INPUT_IDS.configuration]: 'Partner portal',
    },
  },
];

function layoutControls(): LayoutControl[] {
  return CONTROLS.map((control, index) => {
    const process = PROCESSES.find((item) => item.id === control.processId);
    const controlId = `${CONTRIBUTION_ID}-${index}`;
    return {
      processId: control.processId,
      processName: process?.name ?? control.processId,
      workItemType: {
        name: control.workItemType,
        referenceName: `Demo.${control.workItemType.replace(/\s+/g, '')}`,
      },
      groupId: `group-${index}`,
      controlId,
      label: control.label,
      fieldName: control.inputs[INPUT_IDS.fieldName] ?? '',
      inputs: { ...control.inputs },
      control: {
        id: controlId,
        label: control.label,
        isContribution: true,
        contribution: { contributionId: CONTRIBUTION_ID, inputs: { ...control.inputs } },
      },
    };
  });
}

const DEMO_POLICY: SecurityPolicy = parsePolicy({
  version: 2,
  allowedHosts: ['*.contoso.example', 'jsonplaceholder.typicode.com', '*.service-now.com'],
  allowedAuthMethods: ['none', 'basic', 'bearer', 'apiKey', 'oauth2'],
  allowLocalhost: false,
  blockPrivateNetworks: true,
  maxPages: 20,
  maxItems: 10_000,
  timeoutSeconds: 30,
  changedBy: DEMO_USER,
  changedAt: '2026-09-14T15:32:00.000Z',
});

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('The request was cancelled.', 'AbortError'));
      },
      { once: true }
    );
  });
}

function base64(bytes: ArrayBuffer): string {
  let text = '';
  for (const byte of new Uint8Array(bytes)) {
    text += String.fromCharCode(byte);
  }
  return btoa(text);
}

/** A throwaway key made in this browser, so the demo's signed client assertions really sign. */
async function demoSigningKey(algorithm: 'RS256' | 'ES256'): Promise<SigningKey> {
  const pair =
    algorithm === 'RS256'
      ? await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
          },
          true,
          ['sign', 'verify']
        )
      : await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
          'sign',
          'verify',
        ]);
  return { pkcs8: base64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), algorithm };
}

// ---- A small sample REST API ----

const COMPANIES = [
  'Adventure Works',
  'Alpine Ski House',
  'Bellows College',
  'Blue Yonder Airlines',
  'City Power & Light',
  'Coho Winery',
  'Contoso',
  'Fabrikam',
  'Fourth Coffee',
  'Humongous Insurance',
  'Litware',
  'Lucerne Publishing',
  'Margie’s Travel',
  'Northwind Traders',
  'Proseware',
  'Relecloud',
  'Southridge Video',
  'Tailspin Toys',
  'Trey Research',
  'Wide World Importers',
  'Wingtip Toys',
  'Woodgrove Bank',
];
const REGIONS = ['Americas', 'EMEA', 'APAC'];

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const CUSTOMERS = Array.from({ length: 60 }, (_unused, index) => {
  const company = COMPANIES[index % COMPANIES.length] ?? 'Company';
  const round = Math.floor(index / COMPANIES.length);
  const name = round === 0 ? company : `${company} ${round === 1 ? 'East' : 'West'}`;
  return {
    id: 1001 + index,
    name,
    email: `orders@${slug(name)}.example`,
    region: REGIONS[index % REGIONS.length],
    accountManager: { name: index % 2 ? 'Diego Siciliani' : 'Isaiah Langer' },
    active: true,
  };
});

const PEOPLE = [
  ['Adele Vance', 'Retail'],
  ['Alex Wilber', 'Marketing'],
  ['Diego Siciliani', 'Human resources'],
  ['Grady Archie', 'Research and development'],
  ['Isaiah Langer', 'Sales'],
  ['Johanna Lorenz', 'Engineering'],
  ['Lee Gu', 'Manufacturing'],
  ['Lidia Holloway', 'Engineering'],
  ['Megan Bowen', 'Marketing'],
  ['Miriam Graham', 'Executive management'],
  ['Nestor Wilke', 'Operations'],
  ['Patti Fernandez', 'Executive management'],
  ['Pradeep Gupta', 'Finance'],
  ['Lee Gu', 'Sales'],
].map(([displayName = '', department = ''], index) => ({
  id: `2b1c${String(index).padStart(4, '0')}-9c1e-4f36-8d5a-0e4bb2f1a7c3`,
  displayName,
  mail: `${slug(displayName)}${index === 13 ? '2' : ''}@contoso.example`,
  department,
  jobTitle: index % 3 ? 'Specialist' : 'Manager',
}));

const TICKETS = Array.from({ length: 12 }, (_unused, index) => ({
  number: `INC00${4100 + index * 7}`,
  title: [
    'VPN drops every hour',
    'New laptop for onboarding',
    'Printer on floor 3 offline',
    'Password reset',
    'Teams calls echo',
    'Access to the finance share',
  ][index % 6],
  state: 'open',
}));

const PAGE_SIZE = 25;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function headerValue(init: RequestInit | undefined, name: string): string {
  const headers = new Headers(init?.headers);
  return headers.get(name) ?? '';
}

/** The demo token service: any client credentials or signed assertion gets a token. */
function tokenResponse(init: RequestInit | undefined): Response {
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') {
    return json({ error: 'invalid_request', error_description: 'Use POST.' }, 405);
  }
  const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
  if (body.get('grant_type') !== 'client_credentials') {
    return json(
      { error: 'unsupported_grant_type', error_description: 'Only client credentials work here.' },
      400
    );
  }
  const signedIn =
    body.has('client_assertion') ||
    body.has('client_secret') ||
    headerValue(init, 'authorization').toLowerCase().startsWith('basic ');
  if (!signedIn) {
    return json(
      { error: 'invalid_client', error_description: 'Send a client secret or a signed assertion.' },
      401
    );
  }
  return json({
    access_token: `demo-${crypto.randomUUID()}`,
    token_type: 'Bearer',
    expires_in: 3600,
  });
}

/** Answers requests to DEMO_API_ORIGIN and DEMO_AUTH_ORIGIN; everything else goes to the network. */
export async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === DEMO_AUTH_ORIGIN) {
    await delay(300, init?.signal);
    return url.pathname === '/oauth2/token'
      ? tokenResponse(init)
      : json({ message: 'Not found' }, 404);
  }
  if (url.origin !== DEMO_API_ORIGIN) {
    return globalThis.fetch(input, init);
  }
  await delay(250 + Math.round(Math.random() * 250), init?.signal);
  switch (url.pathname) {
    case '/customers': {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const start = (page - 1) * PAGE_SIZE;
      const rows = CUSTOMERS.slice(start, start + PAGE_SIZE);
      const next = start + PAGE_SIZE < CUSTOMERS.length ? new URL(url) : null;
      next?.searchParams.set('page', String(page + 1));
      return json({
        data: { result: rows, total: CUSTOMERS.length },
        errors: [],
        ...(next ? { '@odata.nextLink': next.href } : {}),
      });
    }
    case '/people':
      return json(PEOPLE);
    case '/regions':
      return json(REGIONS);
    case '/tickets':
      if (!headerValue(init, 'authorization').toLowerCase().startsWith('bearer ')) {
        return json({ message: 'Sign in with a bearer token.' }, 401);
      }
      return json({ items: TICKETS, count: TICKETS.length });
    default:
      return json({ message: 'Not found' }, 404);
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Who changed something in the demo, and when. */
function changeStamp() {
  return { updatedBy: DEMO_USER, updatedAt: new Date().toISOString() };
}

function sameControl(a: LayoutControl, b: LayoutControl): boolean {
  return (
    a.processId === b.processId &&
    a.workItemType.referenceName === b.workItemType.referenceName &&
    a.controlId === b.controlId
  );
}

/**
 * The setup page's services with sample data kept in memory. Answers take a moment, like the
 * real ones, so loading states show; `instant` skips that (tests).
 */
export function createDemoServices(options: { instant?: boolean } = {}): SetupServices {
  const wait = (ms: number) => (options.instant ? Promise.resolve() : delay(ms));
  const started = Date.now();
  let persona = 'admin';
  let policy = DEMO_POLICY;
  let controls = layoutControls();
  const configurations = new Map(
    sampleConfigurations(started).map((doc) => [doc.id, doc] as const)
  );
  const secrets = new Map<string, SecretDocument>();
  const secretOf = (id: string, secret: StoredSecret, boundOrigin: string): SecretDocument => ({
    id,
    version: 1,
    secret,
    boundOrigin,
    updatedBy: DEMO_USER,
    updatedAt: new Date(started - 9 * DAY_MS).toISOString(),
  });
  secrets.set(
    'demo-regions',
    secretOf('demo-regions', { kind: 'apiKey', value: 'demo-key-123' }, DEMO_API_ORIGIN)
  );
  // Keys are made the first time they're needed, since generating one takes a moment.
  const pendingKeys = new Map<string, 'RS256' | 'ES256'>([
    ['demo-service-desk', 'RS256'],
    ['demo-partners', 'ES256'],
  ]);

  return {
    mode: 'demo',
    currentUser: () => ({ displayName: DEMO_USER }),
    async listProcesses() {
      await wait(300);
      return PROCESSES.map((process) => ({ ...process }));
    },
    async loadPermissions() {
      await wait(250);
      return permissionsOf(persona);
    },
    async listConfigurations() {
      await wait(350);
      return sortConfigurations([...configurations.values()].map(copy));
    },
    async saveConfiguration(doc) {
      await wait(400);
      const stored = configurations.get(doc.id);
      if (doc.__etag === undefined ? stored !== undefined : stored?.__etag !== doc.__etag) {
        throw new PicklistError(
          'http',
          `Someone changed “${doc.name}” since you opened it. Reload to see their changes.`,
          409
        );
      }
      const saved: ConfigurationDocument = {
        ...copy(doc),
        __etag: (stored?.__etag ?? 0) + 1,
        createdBy: stored ? stored.createdBy : DEMO_USER,
        createdAt: stored ? stored.createdAt : new Date().toISOString(),
        ...changeStamp(),
      };
      configurations.set(saved.id, saved);
      return copy(saved);
    },
    async deleteConfiguration(doc) {
      await wait(400);
      configurations.delete(doc.id);
      secrets.delete(doc.id);
      pendingKeys.delete(doc.id);
    },
    async loadSecret(id) {
      await wait(200);
      const algorithm = pendingKeys.get(id);
      const doc = configurations.get(id);
      if (algorithm && doc?.secret) {
        pendingKeys.delete(id);
        secrets.set(
          id,
          secretOf(
            id,
            { kind: 'signingKey', key: await demoSigningKey(algorithm) },
            doc.secret.boundOrigin
          )
        );
      }
      const secret = secrets.get(id);
      return secret ? copy(secret) : null;
    },
    async saveSecret(id, secret, boundOrigin, apiOrigin) {
      await wait(300);
      pendingKeys.delete(id);
      const saved: SecretDocument = {
        id,
        version: 1,
        secret: copy(secret),
        boundOrigin,
        ...(apiOrigin ? { apiOrigin } : {}),
        ...changeStamp(),
      };
      secrets.set(id, saved);
      return copy(saved);
    },
    async deleteSecret(id) {
      await wait(250);
      pendingKeys.delete(id);
      secrets.delete(id);
    },
    async copySecret(fromId, toId) {
      await wait(300);
      const pending = pendingKeys.get(fromId);
      if (pending) {
        pendingKeys.set(toId, pending);
        return true;
      }
      const source = secrets.get(fromId);
      if (!source) {
        return false;
      }
      secrets.set(toId, { ...copy(source), id: toId });
      return true;
    },
    async scanProcessControls(process) {
      // Different speeds, so the page's progress shows.
      await wait(400 + (process.id.length % 4) * 250);
      return controls.filter((control) => control.processId === process.id).map(copy);
    },
    async updateControlInputs(control, inputs) {
      await wait(450);
      if (!canEditProcess(permissionsOf(persona), control.processId)) {
        throw new PicklistError(
          'http',
          `You don’t have permission to edit the “${control.processName}” process. Ask a process administrator to change it, or to give you the “Edit process” permission.`,
          403
        );
      }
      const current = controls.find((existing) => sameControl(existing, control));
      if (!current) {
        throw new PicklistError(
          'http',
          'The control wasn’t found. It may have been changed or removed: refresh the list.',
          404
        );
      }
      const contribution = current.control.contribution;
      const updated: LayoutControl = {
        ...copy(current),
        fieldName: inputs[INPUT_IDS.fieldName] ?? '',
        inputs: { ...inputs },
        control: {
          ...copy(current.control),
          contribution: {
            ...(typeof contribution === 'object' && contribution ? contribution : {}),
            inputs: { ...inputs },
          },
        },
      };
      controls = controls.map((existing) => (sameControl(existing, control) ? updated : existing));
      return copy(updated);
    },
    async loadPolicy() {
      await wait(250);
      return policy;
    },
    async savePolicy(next) {
      await wait(400);
      policy = parsePolicy({ ...next, changedBy: DEMO_USER, changedAt: new Date().toISOString() });
      return policy;
    },
    fetchImpl: demoFetch,
    demo: {
      personas: PERSONAS,
      persona: () => persona,
      setPersona: (id) => {
        if (PERSONAS.some((item) => item.id === id)) {
          persona = id;
        }
      },
    },
  };
}
