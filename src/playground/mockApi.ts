// A fake REST service so the playground works offline. Every company, address and host is
// fictional; ".example" domains are reserved and never resolve.

export type NetworkMode = 'fast' | 'slow' | 'failing';
export type DatasetSize = 'small' | 'large';

export const REGIONS = ['Americas', 'EMEA', 'APAC'] as const;
export type Region = (typeof REGIONS)[number];

export const MOCK_ORIGIN = 'https://api.contoso.example';
export const MOCK_ENDPOINT = `${MOCK_ORIGIN}/customers`;

/** The token service of the OAuth 2.0 scenario. */
export const MOCK_TOKEN_ORIGIN = 'https://login.contoso.example';
export const MOCK_TOKEN_URL = `${MOCK_TOKEN_ORIGIN}/oauth2/token`;

/**
 * What the fake services accept. They protect nothing: they only let the playground show that
 * the control sends what a configuration's secret holds, and only to where it belongs.
 */
export const MOCK_CREDENTIALS = {
  apiKey: 'playground-api-key',
  clientId: 'rest-picklist-playground',
  clientSecret: 'playground-client-secret',
} as const;

/** How the mock service checks who's calling. */
export type MockSignIn = 'none' | 'apiKey' | 'oauth2';

/**
 * One row per office. A few companies have offices in several regions, so the same name appears
 * more than once and only the second line (the email) tells the rows apart.
 */
const OFFICES: ReadonlyArray<readonly [name: string, region: Region]> = [
  ['Adventure Works', 'Americas'],
  ['Alpine Ski House', 'EMEA'],
  ['Bellows College', 'Americas'],
  ['Best For You Organics', 'Americas'],
  ['Blue Yonder Airlines', 'APAC'],
  ['City Power & Light', 'Americas'],
  ['Coho Winery', 'Americas'],
  ['Consolidated Messenger', 'EMEA'],
  ['Contoso', 'Americas'],
  ['Crème Brûlée Bakery', 'EMEA'],
  ['Fabrikam', 'Americas'],
  ['Fourth Coffee', 'APAC'],
  ['Graphic Design Institute', 'EMEA'],
  ['Humongous Insurance', 'Americas'],
  ['Litware', 'APAC'],
  ['Lucerne Publishing', 'EMEA'],
  ['Margie’s Travel', 'Americas'],
  ['Müller & Söhne Engineering', 'EMEA'],
  ['Northwind Traders', 'Americas'],
  ['Proseware', 'APAC'],
  ['Relecloud', 'Americas'],
  ['School of Fine Art', 'EMEA'],
  ['Southridge Video', 'Americas'],
  ['Tailspin Toys', 'APAC'],
  ['Trey Research', 'EMEA'],
  ['VanArsdel', 'APAC'],
  ['Wide World Importers', 'APAC'],
  ['Wingtip Toys', 'Americas'],
  ['Woodgrove Bank', 'EMEA'],
  ['Zava', 'APAC'],
  // Regional offices of companies listed above.
  ['Contoso', 'EMEA'],
  ['Contoso', 'APAC'],
  ['Fabrikam', 'EMEA'],
  ['Northwind Traders', 'APAC'],
  ['Tailspin Toys', 'EMEA'],
];

const LARGE_COUNT = 5000;

/** Rows per page when paging is on: several pages for either size. */
export const PAGE_SIZES: Record<DatasetSize, number> = { small: 10, large: 500 };

export interface Customer {
  id: number;
  name: string;
  region: Region;
  email: string;
}

function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function buildOffices(): Customer[] {
  const offices = new Map<string, number>();
  for (const [name] of OFFICES) {
    offices.set(name, (offices.get(name) ?? 0) + 1);
  }
  return OFFICES.map(([name, region], index) => ({
    id: 1000 + index,
    name,
    region,
    // Companies with several offices have one address per region.
    email: `${(offices.get(name) ?? 1) > 1 ? region.toLowerCase() : 'contact'}@${slug(name)}.example`,
  }));
}

export const CUSTOMERS: readonly Customer[] = buildOffices();

export const DATASET_SIZES: Record<DatasetSize, number> = {
  small: CUSTOMERS.length,
  large: LARGE_COUNT,
};

function buildCustomers(size: DatasetSize): readonly Customer[] {
  if (size === 'small') {
    return CUSTOMERS;
  }
  const companies = [...new Set(OFFICES.map(([name]) => name))];
  const extra = Array.from({ length: LARGE_COUNT - CUSTOMERS.length }, (_unused, index) => {
    const company = companies[index % companies.length] ?? 'Company';
    const branch = Math.floor(index / companies.length) + 2;
    return {
      id: 1000 + CUSTOMERS.length + index,
      name: `${company} ${String(branch).padStart(3, '0')}`,
      region: REGIONS[index % REGIONS.length] ?? 'EMEA',
      email: `branch${branch}@${slug(company)}.example`,
    };
  });
  return [...CUSTOMERS, ...extra];
}

interface Dataset {
  all: readonly Customer[];
  byRegion: ReadonlyMap<string, readonly Customer[]>;
}

const datasets = new Map<DatasetSize, Dataset>();

/** Each dataset is built once, with its regions split up front, and shared by every session. */
function dataset(size: DatasetSize): Dataset {
  let data = datasets.get(size);
  if (!data) {
    const all = buildCustomers(size);
    const byRegion = new Map<string, Customer[]>();
    for (const customer of all) {
      const rows = byRegion.get(customer.region) ?? [];
      rows.push(customer);
      byRegion.set(customer.region, rows);
    }
    data = { all, byRegion };
    datasets.set(size, data);
  }
  return data;
}

/** The first office with this name, for the work item's starting values. */
export function findCustomer(name: string): Customer | undefined {
  return CUSTOMERS.find((customer) => customer.name === name);
}

export interface MockServiceOptions {
  network: NetworkMode;
  size: DatasetSize;
  /** Serve pages linked with "@odata.nextLink" instead of the whole list at once. */
  paging: boolean;
  /** Nothing, the API key, or a token the token service handed out. Default: nothing. */
  signIn?: MockSignIn;
  /** Called for every request to the API, before the simulated delay. */
  onRequest?: (url: URL) => void;
  /** Called for every request to the token service, before the simulated delay. */
  onTokenRequest?: () => void;
}

const DELAY_MS: Record<NetworkMode, number> = { fast: 350, slow: 1600, failing: 600 };

function wait(milliseconds: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

/** Reads the OData-style skip token the service puts in its next links. */
function skipToken(url: URL): number {
  const skip = Number(url.searchParams.get('$skiptoken') ?? '0');
  return Number.isSafeInteger(skip) && skip > 0 ? skip : 0;
}

function unavailable(): Response {
  return new Response('Service unavailable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

/**
 * A fetch that answers GET /customers?region=… on the mock host, like a small customer API:
 * `{ data: { total, customers: [...] } }`. With paging, each response holds one page and, while
 * more rows exist, an "@odata.nextLink" to the next one; every page takes the network delay.
 * It also plays the token service of the OAuth 2.0 scenario (client credentials, with the client
 * secret in a Basic Authorization header), and the API only accepts tokens it handed out.
 */
export function createMockFetch(options: MockServiceOptions): typeof fetch {
  const pageSize = PAGE_SIZES[options.size];
  const issued = new Set<string>();

  const signedIn = (init: RequestInit | undefined): boolean => {
    const headers = new Headers(init?.headers);
    switch (options.signIn ?? 'none') {
      case 'apiKey':
        return headers.get('x-api-key') === MOCK_CREDENTIALS.apiKey;
      case 'oauth2': {
        const token = /^Bearer (\S+)$/.exec(headers.get('Authorization') ?? '')?.[1];
        return token !== undefined && issued.has(token);
      }
      default:
        return true;
    }
  };

  const tokenResponse = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    options.onTokenRequest?.();
    await wait(DELAY_MS[options.network] / 2, init?.signal);
    if (options.network === 'failing') {
      return unavailable();
    }
    if (url.pathname !== '/oauth2/token' || init?.method !== 'POST') {
      return json({ error: 'Not found' }, 404);
    }
    const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    if (body.get('grant_type') !== 'client_credentials') {
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    const client = `${MOCK_CREDENTIALS.clientId}:${MOCK_CREDENTIALS.clientSecret}`;
    if (new Headers(init.headers).get('Authorization') !== `Basic ${btoa(client)}`) {
      return json(
        { error: 'invalid_client', error_description: 'The client ID or secret is wrong.' },
        401
      );
    }
    const token = `playground-token-${crypto.randomUUID()}`;
    issued.add(token);
    return json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: body.get('scope') ?? undefined,
    });
  };

  return async (input, init) => {
    const url = requestUrl(input);
    if (url.origin === MOCK_TOKEN_ORIGIN) {
      return tokenResponse(url, init);
    }
    options.onRequest?.(url);
    await wait(DELAY_MS[options.network], init?.signal);
    if (options.network === 'failing') {
      return unavailable();
    }
    if (url.origin !== MOCK_ORIGIN || url.pathname !== '/customers') {
      return json({ error: 'Not found' }, 404);
    }
    if (!signedIn(init)) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const { all, byRegion } = dataset(options.size);
    const region = url.searchParams.get('region');
    const rows = region ? (byRegion.get(region) ?? []) : all;
    if (!options.paging) {
      return json({ data: { total: rows.length, customers: rows } });
    }
    const skip = skipToken(url);
    const body: Record<string, unknown> = {
      data: { total: rows.length, customers: rows.slice(skip, skip + pageSize) },
    };
    if (skip + pageSize < rows.length) {
      const next = new URL(url.href);
      next.searchParams.set('$skiptoken', String(skip + pageSize));
      body['@odata.nextLink'] = next.href;
    }
    return json(body);
  };
}
