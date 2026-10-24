/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import { ENTRA_BROWSER_WARNING } from '../core/oauth';
import { DEFAULT_POLICY } from '../core/policy';
import type { SecretDocument } from '../core/secrets';
import { ConfigurationEditor } from './ConfigurationEditor';
import type { SetupServices } from './services';
import { expiresIn } from './TestPanel';

vi.mock('azure-devops-extension-sdk', () => ({}));

/** jsdom has no matchMedia; the preview's combobox uses it to size rows for touch screens. */
function installMatchMedia(): void {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The form-encoded body a request was sent with. */
function sentForm(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
}

/** A token service and the API behind it; the API only answers with the right token. */
function oauthFetch(token: () => Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (urlOf(input) === TOKEN_URL) {
      return token();
    }
    return new Headers(init?.headers).get('authorization') === 'Bearer tok-123'
      ? jsonResponse({ value: [{ name: 'Contoso' }] })
      : jsonResponse({}, 401);
  });
}

beforeAll(installMatchMedia);

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(cleanup);

const ADMIN: PermissionSnapshot = {
  collectionAdmin: true,
  editableProcessIds: new Set(),
  error: null,
};

const CUSTOMERS = {
  data: {
    result: [
      { id: 1, name: 'Contoso', email: 'orders@contoso.example' },
      { id: 2, name: 'Contoso', email: 'billing@contoso.example' },
      { id: 3, name: 'Fabrikam', email: 'hello@fabrikam.example' },
    ],
    meta: { tags: ['a', 'b'] },
  },
};

const TOKEN_URL = 'https://auth.contoso.com/oauth2/token';

const OAUTH_CONFIGURATION: ConfigurationDocument = {
  id: 'c-oauth',
  __etag: 1,
  version: 1,
  name: 'Customers API',
  aliases: [],
  processIds: ['p-contoso'],
  settings: {
    RestServiceAddress: 'https://api.contoso.com/customers',
    AuthMethod: 'OAuth 2.0',
    OAuthSettings: JSON.stringify({ tokenUrl: TOKEN_URL, clientId: 'picklist' }),
  },
  secret: {
    kind: 'clientSecret',
    boundOrigin: 'https://auth.contoso.com',
    updatedBy: 'Ana Díaz',
    updatedAt: '2026-10-22T12:00:00.000Z',
  },
};

function fakeServices(overrides: Partial<SetupServices> = {}): SetupServices {
  const secrets = new Map<string, SecretDocument>([
    [
      'c-oauth',
      {
        id: 'c-oauth',
        version: 1,
        secret: { kind: 'clientSecret', value: 'saved-s3cret' },
        boundOrigin: 'https://auth.contoso.com',
      },
    ],
  ]);
  return {
    mode: 'devops',
    currentUser: () => ({ displayName: 'Ada Lovelace' }),
    listProcesses: vi.fn<SetupServices['listProcesses']>(async () => []),
    loadPermissions: vi.fn<SetupServices['loadPermissions']>(async () => ADMIN),
    listConfigurations: vi.fn<SetupServices['listConfigurations']>(async () => []),
    saveConfiguration: vi.fn<SetupServices['saveConfiguration']>(async (doc) => doc),
    deleteConfiguration: vi.fn<SetupServices['deleteConfiguration']>(async () => undefined),
    loadSecret: vi.fn<SetupServices['loadSecret']>(async (id) => secrets.get(id) ?? null),
    saveSecret: vi.fn<SetupServices['saveSecret']>(async (id, secret, boundOrigin) => ({
      id,
      version: 1,
      secret,
      boundOrigin,
    })),
    deleteSecret: vi.fn<SetupServices['deleteSecret']>(async () => undefined),
    copySecret: vi.fn<SetupServices['copySecret']>(async () => false),
    scanProcessControls: vi.fn<SetupServices['scanProcessControls']>(async () => []),
    updateControlInputs: vi.fn<SetupServices['updateControlInputs']>(async (control) => control),
    loadPolicy: vi.fn<SetupServices['loadPolicy']>(async () => DEFAULT_POLICY),
    savePolicy: vi.fn<SetupServices['savePolicy']>(async (policy) => policy),
    ...overrides,
  };
}

function renderEditor(
  services: SetupServices = fakeServices(),
  configuration: ConfigurationDocument | null = null
) {
  render(
    <ConfigurationEditor
      services={services}
      policy={DEFAULT_POLICY}
      permissions={ADMIN}
      processes={[]}
      configurations={[]}
      configuration={configuration}
      processId='p-contoso'
      onSaved={vi.fn<() => void>()}
      onClose={vi.fn<() => void>()}
    />
  );
  return services;
}

function stateLines(): string[] {
  return [...document.querySelectorAll('.cf-state')].map((line) => line.textContent ?? '');
}

// Typing whole addresses key by key re-renders the form on every keystroke, which is slow in
// jsdom and slower while the full suite runs in parallel.
describe('optional sections', { timeout: 15_000 }, () => {
  it('start closed, sum up their state and remember being opened', async () => {
    const user = userEvent.setup();
    renderEditor();
    const paging = screen.getByRole('button', { name: /^Paging/ });
    expect(paging.getAttribute('aria-expanded')).toBe('false');
    expect(paging.textContent).toContain('One request · up to 10,000 items');
    const panel = document.getElementById(paging.getAttribute('aria-controls') ?? '');
    expect(panel?.hidden).toBe(true);
    for (const title of ['Multiple values', 'Copy to other fields', 'Behavior']) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${title}`) }).getAttribute('aria-expanded')
      ).toBe('false');
    }
    // Saving moved to the editor's footer; there's no section for it any more.
    expect(screen.queryByRole('button', { name: /^Save and reuse/ })).toBeNull();

    await user.click(paging);
    expect(paging.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.hidden).toBe(false);
    await user.selectOptions(
      screen.getByLabelText('How the API returns long lists'),
      'Page number and size'
    );
    expect(paging.textContent).toContain('Page number · 100 per page · up to 10 pages');

    cleanup();
    renderEditor();
    expect(screen.getByRole('button', { name: /^Paging/ }).getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(
      screen.getByRole('button', { name: /^Multiple values/ }).getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('flag a section whose settings need fixing, numbers included', async () => {
    const user = userEvent.setup();
    renderEditor();
    const section = screen.getByRole('button', { name: /^Copy to other fields/ });
    await user.click(section);
    await user.type(screen.getByLabelText('Copy to other fields (JSON)'), '[[1]');
    expect(section.textContent).toContain('Needs attention: The JSON needs fixing');
    expect(section.querySelector('[data-attention]')).toBeTruthy();

    const behavior = screen.getByRole('button', { name: /^Behavior/ });
    await user.click(behavior);
    const timeout = screen.getByLabelText('Timeout');
    await user.clear(timeout);
    await user.type(timeout, '1');
    expect(screen.getByText('Enter a whole number from 5 to 120.')).toBeTruthy();
    expect(behavior.textContent).toContain('Needs attention');
  });
});

// Typing whole addresses key by key re-renders the form on every keystroke, which is slow in
// jsdom and slower while the full suite runs in parallel.
describe('Detect and the test', { timeout: 15_000 }, () => {
  it('fills the automatic state and suggestions from the response', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(CUSTOMERS));
    renderEditor(fakeServices({ fetchImpl }));
    const detect = screen.getByRole('button', { name: 'Detect' });
    expect(detect).toHaveProperty('disabled', true);
    await user.type(
      screen.getByLabelText('REST endpoint URL'),
      'https://api.contoso.com/customers'
    );
    await user.click(detect);

    await screen.findByText('data.result', { selector: '.cf-state code' });
    expect(stateLines()).toContain('Automatic: data.result · 3 items');
    expect(stateLines()).toContain('Automatic: name');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Other lists can be pinned; “Automatic” is pressed while the setting is empty.
    const lists = screen.getByRole('group', { name: 'Lists in the response' });
    expect(
      within(lists).getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')
    ).toBe('true');
    await user.click(within(lists).getByRole('button', { name: /data\.meta\.tags/ }));
    expect(screen.getByLabelText('JSON path to the list')).toHaveProperty(
      'value',
      'data.meta.tags'
    );
    expect(stateLines()).toContain('Found: data.meta.tags · 2 items');
    await user.click(within(lists).getByRole('button', { name: 'Automatic' }));

    const values = screen.getByRole('group', { name: 'Suggestions for Value property' });
    const email = within(values).getByRole('button', { name: /^email/ });
    expect(email.textContent).toMatch(/email address/i);
    await user.click(email);
    expect(screen.getByLabelText('Value property')).toHaveProperty('value', 'email');
    expect(email.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows three suggestions and folds the rest behind “More suggestions”', async () => {
    const user = userEvent.setup();
    const cities = ['Oslo', 'Lima', 'Oslo', 'Pune', 'Lima', 'Oslo'];
    const people = cities.map((city, index) => ({
      id: index + 1,
      name: `Person ${index + 1}`,
      email: `p${index + 1}@contoso.example`,
      code: `P-00${index + 1}`,
      title: index % 2 ? 'Engineer' : 'Designer',
      city,
    }));
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ people }));
    renderEditor(fakeServices({ fetchImpl }));
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/people');
    await user.click(screen.getByRole('button', { name: 'Detect' }));

    const values = await screen.findByRole('group', { name: 'Suggestions for Value property' });
    const more = within(values).getByRole('button', { name: 'More suggestions (2)' });
    const region = document.getElementById(more.getAttribute('aria-controls') ?? '');
    if (!region) {
      throw new Error('The disclosure controls nothing');
    }
    const chips = () =>
      within(values)
        .getAllByRole('button')
        .filter((button) => button.hasAttribute('aria-pressed'));
    // “Automatic” first, then the top three; the rest aren't rendered until asked for.
    expect(chips()[0]?.textContent).toBe('Automatic');
    expect(chips()).toHaveLength(4);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(region.hidden).toBe(true);

    await user.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.textContent).toBe('Fewer suggestions');
    expect(region.hidden).toBe(false);
    const extra = within(region).getAllByRole('button');
    expect(extra).toHaveLength(2);
    expect(chips()).toHaveLength(6);

    // Picking a folded one leaves it (and the focus) where it is…
    const last = extra.at(-1);
    if (!last) {
      throw new Error('No folded suggestion');
    }
    const path = last.querySelector('.cf-chip__main')?.textContent ?? '';
    await user.click(last);
    expect(screen.getByRole('textbox', { name: 'Value property' })).toHaveProperty('value', path);
    expect(last.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(last);

    // …and folding the rest again keeps the chosen one in view.
    await user.click(more);
    expect(region.hidden).toBe(true);
    expect(more.textContent).toBe('More suggestions (1)');
    const chosen = within(values).getByRole('button', { name: new RegExp(`^${path}`) });
    expect(chosen.getAttribute('aria-pressed')).toBe('true');
    expect(region.contains(chosen)).toBe(false);
    // Reasons stay in the chip (one line in the page, full text on hover and in the name).
    expect(chosen.querySelector('.cf-chip__meta')?.getAttribute('title')).toBeTruthy();
  });

  it('says what the counts cover when the list spans several pages', async () => {
    const user = userEvent.setup();
    const pages: Record<string, unknown> = {
      'https://api.contoso.com/items': {
        value: [{ name: 'A' }, { name: 'B' }],
        tags: ['x'],
        '@odata.nextLink': 'https://api.contoso.com/items?page=2',
      },
      'https://api.contoso.com/items?page=2': { value: [{ name: 'C' }] },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => jsonResponse(pages[urlOf(input)] ?? {}));
    renderEditor(fakeServices({ fetchImpl }));
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/items');
    await user.click(screen.getByRole('button', { name: /^Paging/ }));
    await user.selectOptions(screen.getByLabelText('How the API returns long lists'), 'Next link');

    await user.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText(/^200 OK · 3 values · 2 pages/);
    // The rows come from every page; the list chips count the first response, and say so.
    expect(stateLines()).toContain('Automatic: value · 3 items from 2 pages');
    const lists = screen.getByRole('group', { name: 'Lists in the response' });
    expect(within(lists).getByRole('button', { name: /^value/ }).textContent).toBe(
      'value2 items on the first page'
    );

    // Detect reads the first page only, and both readings say so.
    await user.click(screen.getByRole('button', { name: 'Detect' }));
    await screen.findByText(/^200 OK · 2 values · 1 page/);
    expect(stateLines()).toContain('Automatic: value · 2 items on the first page');
    expect(within(lists).getByRole('button', { name: /^tags/ }).textContent).toBe(
      'tags1 item on the first page'
    );
  });

  it('shows why Detect failed', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ message: 'nope' }, 404));
    renderEditor(fakeServices({ fetchImpl }));
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/missing');
    await user.click(screen.getByRole('button', { name: 'Detect' }));
    const messages = await screen.findAllByText('The endpoint wasn’t found (404). Check the URL.');
    // Next to Detect, and in the test panel.
    expect(messages.length).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('previews the list and copies from the exact row that was picked', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(CUSTOMERS));
    renderEditor(fakeServices({ fetchImpl }));
    await user.type(
      screen.getByLabelText('REST endpoint URL'),
      'https://api.contoso.com/customers'
    );
    await user.type(screen.getByLabelText('Second line (optional)'), 'email');
    await user.click(screen.getByRole('button', { name: /^Copy to other fields/ }));
    await user.type(
      screen.getByLabelText('Copy to other fields (JSON)'),
      '{{ "Custom.CustomerId": "id" }'
    );
    await user.click(screen.getByRole('button', { name: 'Run test' }));

    const status = await screen.findByText(/^200 OK · 3 values · 1 page/);
    expect(status).toBeTruthy();
    expect(document.body.textContent).toContain('Sign-in: None');

    const preview = screen.getByRole('combobox', { name: 'Preview' });
    await user.click(preview);
    const billing = screen
      .getAllByRole('option')
      .find((option) => option.textContent?.includes('billing@contoso.example'));
    if (!billing) {
      throw new Error('No billing option');
    }
    await user.click(billing);
    const mapped = screen.getByText('Custom.CustomerId').closest('.cf-mapped__row');
    expect(mapped?.querySelector('dd')?.textContent).toBe('2');
  });
});

// Typing whole addresses key by key re-renders the form on every keystroke, which is slow in
// jsdom and slower while the full suite runs in parallel.
describe('signing in for the test', { timeout: 15_000 }, () => {
  it('uses the saved secret, read only for the test, and shows the token step', async () => {
    const user = userEvent.setup();
    const fetchImpl = oauthFetch(() =>
      jsonResponse({ access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 })
    );
    const services = renderEditor(fakeServices({ fetchImpl }), OAUTH_CONFIGURATION);
    expect(services.loadSecret).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Run test' }));
    expect(await screen.findByText('Got a token · expires in 59 min')).toBeTruthy();
    expect(await screen.findByText(/^200 OK · 1 value · 1 page/)).toBeTruthy();
    expect(services.loadSecret).toHaveBeenCalledWith('c-oauth');
    expect(
      screen.getByText('Sign-in: OAuth 2.0 with a client secret (the saved secret)')
    ).toBeTruthy();
    expect(sentForm(fetchImpl.mock.calls[0]?.[1]).get('grant_type')).toBe('client_credentials');
    // Neither the token nor the secret is ever shown.
    expect(document.body.innerHTML).not.toContain('tok-123');
    expect(document.body.innerHTML).not.toContain('saved-s3cret');
  });

  it('tests with a secret typed here, before it’s saved', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(CUSTOMERS));
    const services = renderEditor(fakeServices({ fetchImpl }));
    await user.type(
      screen.getByLabelText('REST endpoint URL'),
      'https://api.contoso.com/customers'
    );
    await user.click(screen.getByRole('radio', { name: 'Bearer token' }));
    const run = screen.getByRole('button', { name: 'Run test' });
    expect(run).toHaveProperty('disabled', true);
    // Said in the test panel, and next to Detect.
    const panel = screen.getByRole('region', { name: 'Test and preview' });
    expect(within(panel).getByText('Enter the token in Credentials to test.')).toBeTruthy();
    expect(screen.getAllByText('Enter the token in Credentials to test.')).toHaveLength(2);

    await user.type(screen.getByLabelText('Token'), 't0ken');
    await user.click(run);
    expect(await screen.findByText('Sign-in: Bearer token (entered here)')).toBeTruthy();
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer t0ken'
    );
    expect(services.loadSecret).not.toHaveBeenCalled();
  });

  it('explains a token URL that can’t be reached, and asks its owner to allow CORS', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderEditor(fakeServices({ fetchImpl }), {
      ...OAUTH_CONFIGURATION,
      settings: {
        ...OAUTH_CONFIGURATION.settings,
        OAuthSettings: JSON.stringify({
          tokenUrl: 'https://login.microsoftonline.com/contoso/oauth2/v2.0/token',
          clientId: 'picklist',
        }),
      },
      secret: null,
    });
    // Entra can't work from a browser: saving waits, but the test shows the real answer.
    expect(
      screen.getByText(
        'Microsoft Entra ID refuses client credentials sent from a browser, so this token URL won’t work. Use a token service that accepts requests from Azure DevOps.'
      )
    ).toBeTruthy();
    const credentials = screen.getByRole('region', { name: 'Credentials' });
    await user.type(within(credentials).getByLabelText('Client secret'), 's3cret');
    await user.click(screen.getByRole('button', { name: 'Run test' }));
    // The field says the same, in the same words.
    const alert = await screen.findByText(
      `Couldn’t reach the token URL. It must allow requests from Azure DevOps (CORS). ${ENTRA_BROWSER_WARNING}`
    );
    expect(alert).toBeTruthy();
    expect(document.body.textContent).toContain('the token service may not accept calls');
    expect(screen.queryByText(/^Got a token/)).toBeNull();
  });
});

describe('expiresIn', () => {
  it('says how long the token lasts, to the nearest minute, never the token', () => {
    const now = Date.UTC(2026, 9, 22, 12);
    expect(expiresIn(now + 3_540_000 - 5, now)).toBe('expires in 59 min');
    expect(expiresIn(now + 20_000, now)).toBe('expires in less than a minute');
    expect(expiresIn(now + 3 * 3_600_000, now)).toBe('expires in 3 h');
  });
});
