/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { DEFAULT_POLICY } from '../core/policy';
import type { SecretDocument, SecretSummary } from '../core/secrets';
import type { ProcessSummary } from '../devops/processes';
import type { ConfigurationEditorProps } from './ConfigurationEditor';
import { ConfigurationEditor } from './ConfigurationEditor';
import type { SetupServices } from './services';

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

beforeAll(installMatchMedia);

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(cleanup);

const STAMP = '2026-10-22T12:00:00.000Z';

function process(id: string, name: string, customizationType = 'inherited'): ProcessSummary {
  return {
    id,
    name,
    customizationType,
    isEnabled: true,
    projectNames: [],
    projectIds: [],
    parentProcessTypeId: '',
  };
}

const PROCESSES: ProcessSummary[] = [
  process('p-agile', 'Agile', 'system'),
  process('p-contoso', 'Contoso Agile'),
  process('p-scrum', 'Contoso Scrum'),
  process('p-field', 'Field Service'),
];

const ADMIN: PermissionSnapshot = {
  collectionAdmin: true,
  editableProcessIds: new Set(),
  error: null,
};

const CONTOSO_EDITOR: PermissionSnapshot = {
  collectionAdmin: false,
  editableProcessIds: new Set(['p-contoso', 'p-scrum']),
  error: null,
};

const VIEWER: PermissionSnapshot = {
  collectionAdmin: false,
  editableProcessIds: new Set(),
  error: null,
};

const PASSWORD_SUMMARY: SecretSummary = {
  kind: 'password',
  boundOrigin: 'https://api.contoso.com',
  updatedBy: 'Ana Díaz',
  updatedAt: STAMP,
};

function configuration(patch: Partial<ConfigurationDocument> = {}): ConfigurationDocument {
  return {
    id: 'c-customers',
    __etag: 3,
    version: 1,
    name: 'Customers API',
    aliases: [],
    processIds: ['p-contoso'],
    settings: {
      RestServiceAddress: 'https://api.contoso.com/customers',
      AuthMethod: 'Basic',
      RestServiceUserName: 'ada',
    },
    secret: null,
    ...patch,
  };
}

/**
 * Services that keep what's saved in memory and note the order of every write (and of secret
 * reads). `stored` is what listConfigurations returns; renderEditor puts the configurations it
 * shows there, unless they're already in it.
 */
function fakeServices(overrides: Partial<SetupServices> = {}) {
  const calls: string[] = [];
  const secrets = new Map<string, SecretDocument>();
  const stored = new Map<string, ConfigurationDocument>();
  let etag = 10;
  const services: SetupServices = {
    mode: 'devops',
    currentUser: () => ({ displayName: 'Ada Lovelace' }),
    listProcesses: vi.fn<SetupServices['listProcesses']>(async () => PROCESSES),
    loadPermissions: vi.fn<SetupServices['loadPermissions']>(async () => ADMIN),
    listConfigurations: vi.fn<SetupServices['listConfigurations']>(async () => [
      ...stored.values(),
    ]),
    saveConfiguration: vi.fn<SetupServices['saveConfiguration']>(async (doc) => {
      calls.push(`saveConfiguration:${doc.id}`);
      const saved = { ...doc, __etag: ++etag, updatedBy: 'Ada Lovelace', updatedAt: STAMP };
      stored.set(saved.id, saved);
      return saved;
    }),
    deleteConfiguration: vi.fn<SetupServices['deleteConfiguration']>(async () => undefined),
    loadSecret: vi.fn<SetupServices['loadSecret']>(async (id) => {
      calls.push(`loadSecret:${id}`);
      return secrets.get(id) ?? null;
    }),
    saveSecret: vi.fn<SetupServices['saveSecret']>(async (id, secret, boundOrigin) => {
      calls.push(`saveSecret:${id}`);
      const saved: SecretDocument = {
        id,
        version: 1,
        secret,
        boundOrigin,
        updatedBy: 'Ada Lovelace',
        updatedAt: STAMP,
      };
      secrets.set(id, saved);
      return saved;
    }),
    deleteSecret: vi.fn<SetupServices['deleteSecret']>(async (id) => {
      calls.push(`deleteSecret:${id}`);
      secrets.delete(id);
    }),
    copySecret: vi.fn<SetupServices['copySecret']>(async () => false),
    scanProcessControls: vi.fn<SetupServices['scanProcessControls']>(async () => []),
    updateControlInputs: vi.fn<SetupServices['updateControlInputs']>(async (control) => control),
    loadPolicy: vi.fn<SetupServices['loadPolicy']>(async () => DEFAULT_POLICY),
    savePolicy: vi.fn<SetupServices['savePolicy']>(async (policy) => policy),
    ...overrides,
  };
  return { services, calls, secrets, stored };
}

function renderEditor(props: Partial<ConfigurationEditorProps> = {}, harness = fakeServices()) {
  for (const doc of [...(props.configurations ?? []), props.configuration ?? null]) {
    if (doc && !harness.stored.has(doc.id)) {
      harness.stored.set(doc.id, doc);
    }
  }
  const all: ConfigurationEditorProps = {
    services: harness.services,
    policy: DEFAULT_POLICY,
    permissions: ADMIN,
    processes: PROCESSES,
    configurations: [],
    configuration: null,
    processId: 'p-contoso',
    onSaved: vi.fn<ConfigurationEditorProps['onSaved']>(),
    onClose: vi.fn<() => void>(),
    onDirtyChange: vi.fn<(dirty: boolean) => void>(),
    now: () => new Date(STAMP),
    ...props,
  };
  render(<ConfigurationEditor {...all} />);
  return { ...harness, props: all };
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save configuration' });
}

function status(): string {
  return document.querySelector('.cf-editor__status')?.textContent ?? '';
}

function credentialsCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Credentials' });
}

/** The configuration passed to the n-th saveConfiguration call. */
function savedDoc(services: SetupServices, index = 0): ConfigurationDocument {
  const call = vi.mocked(services.saveConfiguration).mock.calls[index];
  if (!call) {
    throw new Error(`saveConfiguration wasn’t called ${index + 1} times`);
  }
  return call[0];
}

// Typing whole addresses key by key re-renders the form on every keystroke, which is slow in
// jsdom and slower while the full suite runs in parallel.
describe('creating and saving', { timeout: 15_000 }, () => {
  it('creates a configuration shared with the process it was opened from', async () => {
    const user = userEvent.setup();
    const { services, props } = renderEditor();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'New configuration' }));
    expect(saveButton()).toHaveProperty('disabled', true);

    await user.type(screen.getByLabelText('Name'), 'Customers API');
    await user.type(
      screen.getByLabelText('REST endpoint URL'),
      'https://api.contoso.com/customers'
    );
    expect(status()).toBe('Unsaved changes');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);

    await user.click(saveButton());
    const doc = savedDoc(services);
    expect(doc).toMatchObject({
      name: 'Customers API',
      aliases: [],
      processIds: ['p-contoso'],
      settings: { RestServiceAddress: 'https://api.contoso.com/customers' },
      secret: null,
    });
    expect(doc.__etag).toBeUndefined();
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ __etag: 11 }), null);
    expect(await screen.findByText('Saved “Customers API”.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Customers API' })).toBeTruthy();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(services.saveSecret).not.toHaveBeenCalled();
  });

  it('updates a configuration and keeps its former name when it’s renamed', async () => {
    const user = userEvent.setup();
    const { services, props } = renderEditor({ configuration: configuration() });
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(status()).toBe('');
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Customers v2');
    await user.click(saveButton());
    expect(savedDoc(services)).toMatchObject({
      id: 'c-customers',
      __etag: 3,
      name: 'Customers v2',
      aliases: ['Customers API'],
    });
    expect(props.onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Customers v2' }),
      'Customers API'
    );
  });

  it('checks the name as it’s typed: unique in each process, former names included', async () => {
    const user = userEvent.setup();
    const other = configuration({ id: 'c-other', name: 'Customers', aliases: ['Clients'] });
    const { services } = renderEditor({ configurations: [other] });
    const name = screen.getByLabelText('Name');
    await user.type(name, 'customers');
    expect(
      screen.getByText(
        '“customers” is already the name of another configuration in the Contoso Agile process. Choose another name.'
      )
    ).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    await user.clear(name);
    await user.type(name, 'Clients');
    expect(screen.getByText(/^“Clients” is a former name of “Customers”/)).toBeTruthy();

    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/x');
    expect(status()).toBe('Unsaved changes: fix 1 problem to save.');
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    await user.click(saveButton());
    expect(document.activeElement).toBe(name);
    expect(services.saveConfiguration).not.toHaveBeenCalled();
  });

  it('shows required settings once Save is pressed, and focuses the first problem', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/x');
    expect(screen.queryByText('Enter a name for the configuration.')).toBeNull();
    await user.click(saveButton());
    expect(screen.getByText('Enter a name for the configuration.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('opens a closed section to show a problem inside it', async () => {
    const user = userEvent.setup();
    const { services } = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Customers API');
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/x');
    const section = screen.getByRole('button', { name: /^Copy to other fields/ });
    await user.click(section);
    await user.type(screen.getByLabelText('Copy to other fields (JSON)'), '[[1]');
    await user.click(section);
    expect(section.getAttribute('aria-expanded')).toBe('false');
    await user.click(saveButton());
    expect(section.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Copy to other fields (JSON)'));
    expect(services.saveConfiguration).not.toHaveBeenCalled();
  });
});

// Typing whole addresses key by key re-renders the form on every keystroke, which is slow in
// jsdom and slower while the full suite runs in parallel.
describe('the write-only secret', { timeout: 15_000 }, () => {
  it('saves a new secret first, bound to the API’s origin, and never shows it again', async () => {
    const user = userEvent.setup();
    const { services, calls } = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Customers API');
    await user.type(
      screen.getByLabelText('REST endpoint URL'),
      'https://api.contoso.com/customers'
    );
    await user.click(screen.getByRole('radio', { name: 'Basic' }));
    expect(within(credentialsCard()).getByText('Not set')).toBeTruthy();
    await user.type(screen.getByLabelText('User name'), 'ada');
    // With a user name, Basic works without a password, as before 4.0.
    expect(
      within(credentialsCard()).getByText('Not set: forms send the user name without a password.')
    ).toBeTruthy();
    const password = within(credentialsCard()).getByLabelText('Password');
    expect(password).toHaveProperty('type', 'password');
    // No <form> around it, so browsers don't offer to save it as a password.
    expect(password.closest('form')).toBeNull();
    expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy();
    expect(password).toHaveProperty('value', '');
    await user.type(password, 'p4ss w0rd');
    await user.click(saveButton());

    const doc = savedDoc(services);
    expect(calls).toEqual([`saveSecret:${doc.id}`, `saveConfiguration:${doc.id}`]);
    expect(services.saveSecret).toHaveBeenCalledWith(
      doc.id,
      { kind: 'password', value: 'p4ss w0rd' },
      'https://api.contoso.com'
    );
    expect(doc.secret).toEqual({
      kind: 'password',
      boundOrigin: 'https://api.contoso.com',
      updatedBy: 'Ada Lovelace',
      updatedAt: STAMP,
    });
    expect(JSON.stringify(doc)).not.toContain('p4ss');
    expect(
      await within(credentialsCard()).findByText('Set · changed by Ada Lovelace on 22 Oct 2026')
    ).toBeTruthy();
    expect(within(credentialsCard()).queryByLabelText('Password')).toBeNull();
    expect(document.body.innerHTML).not.toContain('p4ss');
  });

  it('deletes the new secret when the new configuration can’t be saved', async () => {
    const user = userEvent.setup();
    const harness = fakeServices({
      saveConfiguration: vi.fn<SetupServices['saveConfiguration']>(async () => {
        harness.calls.push('saveConfiguration');
        throw new PicklistError('network', 'Couldn’t save “Customers API”. Try again in a moment.');
      }),
    });
    const { calls, props } = renderEditor({}, harness);
    await user.type(screen.getByLabelText('Name'), 'Customers API');
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/x');
    await user.click(screen.getByRole('radio', { name: 'Bearer token' }));
    await user.type(within(credentialsCard()).getByLabelText('Token'), 't0ken');
    await user.click(saveButton());

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Couldn’t save “Customers API”. Try again in a moment.'
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/^saveSecret:/);
    expect(calls[1]).toBe('saveConfiguration');
    expect(calls[2]).toBe(`deleteSecret:${calls[0]?.slice('saveSecret:'.length)}`);
    expect(props.onSaved).not.toHaveBeenCalled();
    // Still there to try again.
    expect(status()).toBe('Unsaved changes');
  });

  it('replaces a saved secret: the secret first, then the configuration', async () => {
    const user = userEvent.setup();
    const { services, calls } = renderEditor({
      configuration: configuration({ secret: PASSWORD_SUMMARY }),
    });
    const card = credentialsCard();
    expect(within(card).getByText('Set · changed by Ana Díaz on 22 Oct 2026')).toBeTruthy();
    expect(within(card).getByText('Sent only to api.contoso.com.')).toBeTruthy();
    expect(within(card).queryByLabelText('Password')).toBeNull();

    await user.click(within(card).getByRole('button', { name: 'Replace' }));
    const input = within(card).getByLabelText('New password');
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value', '');
    // Cancel keeps the saved one; Replace again starts empty.
    await user.type(input, 'abc');
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByLabelText('New password')).toBeNull();
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Replace' }));
    expect(saveButton()).toHaveProperty('disabled', true);

    await user.click(within(card).getByRole('button', { name: 'Replace' }));
    await user.type(within(card).getByLabelText('New password'), 'n3w');
    await user.click(saveButton());
    // The saved secret is read first (into memory only), to put back if the save fails.
    expect(calls).toEqual([
      'loadSecret:c-customers',
      'saveSecret:c-customers',
      'saveConfiguration:c-customers',
    ]);
    expect(services.saveSecret).toHaveBeenCalledWith(
      'c-customers',
      { kind: 'password', value: 'n3w' },
      'https://api.contoso.com'
    );
    expect(savedDoc(services).secret?.updatedBy).toBe('Ada Lovelace');
  });

  it('puts the old secret back when the configuration then can’t be saved', async () => {
    const user = userEvent.setup();
    const harness = fakeServices();
    const old: SecretDocument = {
      id: 'c-customers',
      version: 1,
      secret: { kind: 'password', value: 'old-pass' },
      boundOrigin: 'https://api.contoso.com',
    };
    harness.secrets.set('c-customers', old);
    vi.mocked(harness.services.saveConfiguration).mockImplementationOnce(async () => {
      harness.calls.push('saveConfiguration');
      throw new PicklistError('network', 'Couldn’t save “Customers API”. Try again in a moment.');
    });
    const { services, calls, secrets } = renderEditor(
      { configuration: configuration({ secret: PASSWORD_SUMMARY }) },
      harness
    );
    const card = credentialsCard();
    await user.click(within(card).getByRole('button', { name: 'Replace' }));
    await user.type(within(card).getByLabelText('New password'), 'n3w');
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Couldn’t save “Customers API”. Try again in a moment.');
    // Forms keep the configuration as stored, with the secret it describes.
    expect(calls).toEqual([
      'loadSecret:c-customers',
      'saveSecret:c-customers',
      'saveConfiguration',
      'saveSecret:c-customers',
    ]);
    expect(vi.mocked(services.saveSecret).mock.calls[1]).toEqual([
      'c-customers',
      { kind: 'password', value: 'old-pass' },
      'https://api.contoso.com',
    ]);
    expect(secrets.get('c-customers')?.secret).toEqual({ kind: 'password', value: 'old-pass' });
    // The new one is still typed, ready to save again.
    expect(within(card).getByLabelText('New password')).toHaveProperty('value', 'n3w');
    expect(document.body.innerHTML).not.toContain('old-pass');
  });

  it('says so when the old secret couldn’t be put back', async () => {
    const user = userEvent.setup();
    const harness = fakeServices({
      // The saved one can't be read, so it can't be put back either.
      loadSecret: vi.fn<SetupServices['loadSecret']>(async () => {
        throw new PicklistError('network', 'Couldn’t reach Azure DevOps.');
      }),
    });
    vi.mocked(harness.services.saveConfiguration).mockRejectedValueOnce(
      new PicklistError('http', 'Someone changed “Customers API” since you opened it.', 409)
    );
    const { calls } = renderEditor(
      { configuration: configuration({ secret: PASSWORD_SUMMARY }) },
      harness
    );
    await user.click(within(credentialsCard()).getByRole('button', { name: 'Replace' }));
    await user.type(within(credentialsCard()).getByLabelText('New password'), 'n3w');
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Someone changed “Customers API” since you opened it. Its new secret was already saved, though: forms may not be able to sign in until you save it again.'
    );
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(calls).toEqual(['saveSecret:c-customers']);
  });

  it('removes a saved secret after asking: the configuration first, then the secret', async () => {
    const user = userEvent.setup();
    const { services, calls } = renderEditor({
      configuration: configuration({ secret: PASSWORD_SUMMARY }),
    });
    await user.click(within(credentialsCard()).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove the saved password?' });
    expect(dialog.textContent).toContain('Forms that use “Customers API” can’t sign in');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(within(credentialsCard()).getByText(/^Removed when you save\./)).toBeTruthy();

    await user.click(saveButton());
    expect(calls).toEqual(['saveConfiguration:c-customers', 'deleteSecret:c-customers']);
    expect(savedDoc(services).secret).toBeNull();
    // Saved, with a user name: forms now send it alone.
    expect(
      await within(credentialsCard()).findByText(
        'Not set: forms send the user name without a password.'
      )
    ).toBeTruthy();
  });

  it('offers to remove the old secret again when deleting it failed after the save', async () => {
    const user = userEvent.setup();
    const harness = fakeServices();
    vi.mocked(harness.services.deleteSecret).mockRejectedValueOnce(
      new PicklistError('network', 'Azure DevOps couldn’t be reached.')
    );
    const { calls } = renderEditor(
      { configuration: configuration({ secret: PASSWORD_SUMMARY }) },
      harness
    );
    await user.click(within(credentialsCard()).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove the saved password?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await user.click(saveButton());
    expect(
      await screen.findByText('Saved “Customers API”, but its old secret couldn’t be deleted.')
    ).toBeTruthy();
    // The card no longer shows it, so the warning is the only way to get rid of it.
    await user.click(screen.getByRole('button', { name: 'Remove the old secret' }));
    expect(await screen.findByText('Removed the old secret of “Customers API”.')).toBeTruthy();
    expect(harness.services.deleteSecret).toHaveBeenCalledTimes(2);
    expect(harness.services.deleteSecret).toHaveBeenLastCalledWith('c-customers');
    expect(calls).toEqual(['saveConfiguration:c-customers', 'deleteSecret:c-customers']);
    expect(harness.secrets.has('c-customers')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Remove the old secret' })).toBeNull();
  });

  it('asks for the secret again when the address it’s sent to changes', async () => {
    const user = userEvent.setup();
    const { services, calls } = renderEditor({
      configuration: configuration({ secret: PASSWORD_SUMMARY }),
    });
    const url = screen.getByLabelText('REST endpoint URL');
    await user.clear(url);
    await user.type(url, 'https://api.fabrikam.com/customers');
    const card = credentialsCard();
    expect(
      within(card).getByText('You changed where the secret is sent, so enter it again.')
    ).toBeTruthy();
    await user.click(saveButton());
    const password = within(card).getByLabelText('Password');
    expect(document.activeElement).toBe(password);
    expect(services.saveConfiguration).not.toHaveBeenCalled();

    await user.type(password, 'for-fabrikam');
    await user.click(saveButton());
    expect(calls).toEqual([
      'loadSecret:c-customers',
      'saveSecret:c-customers',
      'saveConfiguration:c-customers',
    ]);
    expect(services.saveSecret).toHaveBeenCalledWith(
      'c-customers',
      { kind: 'password', value: 'for-fabrikam' },
      'https://api.fabrikam.com'
    );
  });

  it('asks before a sign-in change that can’t use the saved secret', async () => {
    const user = userEvent.setup();
    const { services, calls } = renderEditor({
      configuration: configuration({ secret: PASSWORD_SUMMARY }),
    });
    await user.click(screen.getByRole('radio', { name: 'Bearer token' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Switch to Bearer token?' });
    expect(dialog.textContent).toContain(
      'The saved password can’t be used with Bearer token, so it’s removed when you save.'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('radio', { name: 'Basic' })).toHaveProperty('checked', true);

    await user.click(screen.getByRole('radio', { name: 'None' }));
    const stop = screen.getByRole('alertdialog', { name: 'Stop signing in?' });
    await user.click(within(stop).getByRole('button', { name: 'Stop signing in' }));
    expect(screen.getByRole('radio', { name: 'None' })).toHaveProperty('checked', true);
    expect(
      within(credentialsCard()).getByText(
        'The saved password is removed when you save, because the API no longer signs in.'
      )
    ).toBeTruthy();

    // Back to Basic, the saved password fits again: nothing to ask, nothing to remove.
    await user.click(screen.getByRole('radio', { name: 'Basic' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(saveButton()).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('radio', { name: 'None' }));
    await user.click(screen.getByRole('button', { name: 'Stop signing in' }));
    await user.click(saveButton());
    expect(calls).toEqual(['saveConfiguration:c-customers', 'deleteSecret:c-customers']);
    expect(savedDoc(services)).toMatchObject({
      secret: null,
      settings: { RestServiceAddress: 'https://api.contoso.com/customers' },
    });
  });
});

describe('sharing and permissions', () => {
  it('shares with processes the person may edit, and never with none', async () => {
    const user = userEvent.setup();
    const { services } = renderEditor({
      permissions: CONTOSO_EDITOR,
      configuration: configuration(),
    });
    const chips = screen.getByRole('list', { name: 'Shared with' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Contoso Agile']);
    // The last process can't be taken away: that would be deleting it.
    expect(within(chips).queryByRole('button')).toBeNull();

    const add = screen.getByRole('button', { name: 'Add process' });
    await user.click(add);
    expect(add.getAttribute('aria-expanded')).toBe('true');
    const options = screen.getAllByRole('button', { name: /^Share with / });
    expect(options.map((option) => option.textContent)).toEqual(['Contoso Scrum']);
    const [scrum] = options;
    if (!scrum) {
      throw new Error('No process to share with');
    }
    await user.click(scrum);
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Contoso Agile', 'Contoso Scrum']);
    expect(screen.queryByRole('button', { name: 'Add process' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Stop sharing with Contoso Agile' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Stop sharing with Contoso Agile?' });
    expect(dialog.textContent).toContain(
      'Controls in Contoso Agile that use “Customers API” will show “Configuration not found” after you save'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Stop sharing' }));
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Contoso Scrum']);
    await user.click(saveButton());
    expect(savedDoc(services).processIds).toEqual(['p-scrum']);
  });

  it('finds former names that clash in a process it’s newly shared with', async () => {
    const user = userEvent.setup();
    const scrum = configuration({ id: 'c-scrum', name: 'Customers API', processIds: ['p-scrum'] });
    const { services } = renderEditor({
      configuration: configuration({ name: 'Customers', aliases: ['Customers API'] }),
      configurations: [scrum],
    });
    expect(
      within(screen.getByRole('list', { name: /^Also answers to its former names/ }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['“Customers API”Forget']);
    await user.click(screen.getByRole('button', { name: 'Add process' }));
    await user.click(screen.getByRole('button', { name: 'Share with Contoso Scrum' }));
    expect(
      screen.getByText(
        /^“Customers API” is already the name of another configuration in the Contoso Scrum process/
      )
    ).toBeTruthy();
    // Save shows where: the list of processes it's shared with.
    await user.click(saveButton());
    expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Shared with' }));
    expect(services.saveConfiguration).not.toHaveBeenCalled();
  });

  it('shows people who can’t edit it the settings as text, with no test and no save', async () => {
    const user = userEvent.setup();
    const { services } = renderEditor({
      permissions: VIEWER,
      configuration: configuration({ secret: PASSWORD_SUMMARY }),
    });
    expect(screen.getByText('View only')).toBeTruthy();
    expect(
      screen.getByText(
        'You can view this configuration. To change it, you need Edit process permission on Contoso Agile.'
      )
    ).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('readOnly', true);
    expect(screen.getByLabelText('REST endpoint URL')).toHaveProperty('readOnly', true);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Sign-in method').closest('dl')?.textContent).toBe(
      'Sign-in methodBasic'
    );
    expect(screen.queryByRole('button', { name: 'Save configuration' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run test' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Detect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add process' })).toBeNull();
    const card = credentialsCard();
    expect(within(card).getByText('Set · changed by Ana Díaz on 22 Oct 2026')).toBeTruthy();
    expect(within(card).queryByRole('button')).toBeNull();
    expect(
      screen.getByText('Only people who can change this configuration can test it.')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(services.loadSecret).not.toHaveBeenCalled();
  });

  it('turns editing off when the permission check failed', () => {
    renderEditor({
      permissions: {
        ...ADMIN,
        error:
          'Couldn’t check your permissions (Azure DevOps answered 403). Editing is turned off until it works.',
      },
      configuration: configuration(),
    });
    expect(
      screen.getByText(
        'Couldn’t check your permissions (Azure DevOps answered 403). Editing is turned off until it works.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save configuration' })).toBeNull();
  });
});

describe('leaving and conflicts', () => {
  it('asks before discarding unsaved changes', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ configuration: configuration() });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText('REST endpoint URL'), '/v2');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Discard changes to “Customers API”?' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep editing' })
    );
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Back to Configurations' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' })
    );
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('offers to reload when someone else changed it meanwhile', async () => {
    const user = userEvent.setup();
    const theirs = configuration({
      __etag: 4,
      settings: { RestServiceAddress: 'https://api.contoso.com/v3/customers' },
    });
    const { services } = renderEditor(
      { configuration: configuration() },
      fakeServices({
        saveConfiguration: vi.fn<SetupServices['saveConfiguration']>(async () => {
          throw new PicklistError(
            'http',
            'Someone changed “Customers API” since you opened it. Reload to see their changes.',
            409
          );
        }),
        listConfigurations: vi.fn<SetupServices['listConfigurations']>(async () => [theirs]),
      })
    );
    await user.type(screen.getByLabelText('REST endpoint URL'), '/v2');
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Someone changed “Customers API” since you opened it. Reload to see their changes.'
    );
    // Found by reading what's stored before writing anything.
    expect(services.saveConfiguration).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(services.listConfigurations).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Loaded the latest version of “Customers API”.')).toBeTruthy();
    expect(screen.getByLabelText('REST endpoint URL')).toHaveProperty(
      'value',
      'https://api.contoso.com/v3/customers'
    );
    expect(saveButton()).toHaveProperty('disabled', true);
  });
});

describe('OAuth 2.0 secrets and the API', { timeout: 15_000 }, () => {
  const OAUTH_SETTINGS = {
    RestServiceAddress: 'https://api.contoso.com/customers',
    AuthMethod: 'OAuth 2.0',
    OAuthSettings: '{"tokenUrl":"https://auth.contoso.com/oauth2/token","clientId":"picklist"}',
  };

  it('binds a new client secret to the API its tokens go to', async () => {
    const user = userEvent.setup();
    const { services } = renderEditor({
      configuration: configuration({ settings: OAUTH_SETTINGS }),
    });
    await user.type(within(credentialsCard()).getByLabelText('Client secret'), 's3cret');
    await user.click(saveButton());
    expect(services.saveSecret).toHaveBeenCalledWith(
      'c-customers',
      { kind: 'clientSecret', value: 's3cret' },
      'https://auth.contoso.com',
      'https://api.contoso.com'
    );
    expect(savedDoc(services).secret).toMatchObject({
      boundOrigin: 'https://auth.contoso.com',
      apiOrigin: 'https://api.contoso.com',
    });
  });

  it('asks for the secret again when the API moves to another host', async () => {
    const user = userEvent.setup();
    const { services } = renderEditor({
      configuration: configuration({
        settings: OAUTH_SETTINGS,
        secret: {
          kind: 'clientSecret',
          boundOrigin: 'https://auth.contoso.com',
          apiOrigin: 'https://api.contoso.com',
        },
      }),
    });
    const url = screen.getByLabelText('REST endpoint URL');
    // Another path on the same host keeps it.
    await user.type(url, '/v2');
    expect(within(credentialsCard()).getByRole('button', { name: 'Replace' })).toBeTruthy();
    await user.clear(url);
    await user.type(url, 'https://collector.example.net/customers');
    expect(
      within(credentialsCard()).getByText(
        'You changed the API’s address, and the access tokens go there, so enter the client secret again.'
      )
    ).toBeTruthy();
    await user.click(saveButton());
    expect(services.saveConfiguration).not.toHaveBeenCalled();
  });
});

describe('what’s stored now', { timeout: 15_000 }, () => {
  it('checks names against what’s stored now, not what the page read when it opened', async () => {
    const user = userEvent.setup();
    const harness = fakeServices();
    // Added in another tab after this page read the list.
    harness.stored.set(
      'c-theirs',
      configuration({ id: 'c-theirs', name: 'Tickets', processIds: ['p-contoso'] })
    );
    const onConfigurationsLoaded = vi.fn<(docs: ConfigurationDocument[]) => void>();
    const { services } = renderEditor({ configurations: [], onConfigurationsLoaded }, harness);
    await user.type(screen.getByLabelText('Name'), 'Tickets');
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/t');
    await user.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain(
      '“Tickets” is already the name of another configuration in the Contoso Agile process.'
    );
    expect(services.saveConfiguration).not.toHaveBeenCalled();
    // The page's list follows what was read.
    expect(onConfigurationsLoaded).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'c-theirs' }),
    ]);
  });

  it('reloads into the page’s list too, so the next Edit opens the newer copy', async () => {
    const user = userEvent.setup();
    const theirs = configuration({ __etag: 9, name: 'Renamed by Ana' });
    const harness = fakeServices();
    harness.stored.set(theirs.id, theirs);
    const onConfigurationsLoaded = vi.fn<(docs: ConfigurationDocument[]) => void>();
    renderEditor({ configuration: configuration(), onConfigurationsLoaded }, harness);
    await user.type(screen.getByLabelText('REST endpoint URL'), '/v2');
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Loaded the latest version of “Renamed by Ana”.')).toBeTruthy();
    expect(onConfigurationsLoaded).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'Renamed by Ana', __etag: 9 }),
    ]);
  });

  it('can’t be left while it saves', async () => {
    const user = userEvent.setup();
    let finish: (() => void) | undefined;
    const harness = fakeServices({
      saveConfiguration: vi.fn<SetupServices['saveConfiguration']>(
        (doc) =>
          new Promise((resolve) => {
            finish = () => resolve({ ...doc, __etag: 1 });
          })
      ),
    });
    const { props } = renderEditor({}, harness);
    await user.type(screen.getByLabelText('Name'), 'Tickets');
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/t');
    await user.click(saveButton());
    const back = await screen.findByRole('button', { name: 'Back to Configurations' });
    await vi.waitFor(() => expect(back).toHaveProperty('disabled', true));
    expect(finish).toBeDefined();
    finish?.();
    await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
    expect(back).toHaveProperty('disabled', false);
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

/** A control on a Bug form that names the configuration `name`. */
function namingControl(id: string, name: string, processId = 'p-contoso'): LayoutControl {
  return {
    processId,
    processName: processId,
    workItemType: { name: 'Bug', referenceName: 'Custom.Bug' },
    groupId: 'g',
    controlId: id,
    label: id,
    fieldName: 'Custom.Customer',
    inputs: { FieldName: 'Custom.Customer', Configuration: name },
    control: {},
  };
}

describe('former names', { timeout: 15_000 }, () => {
  it('forgets a former name after saying which controls still use it', async () => {
    const user = userEvent.setup();
    const { services } = renderEditor({
      configuration: configuration({ aliases: ['Customers', 'Old customers'] }),
      scanned: [
        namingControl('Account', 'customers'),
        namingControl('Owner', 'Customers'),
        // Another process: not one it's shared with, so it doesn't count.
        namingControl('Other', 'Customers', 'p-field'),
      ],
      scansComplete: true,
    });
    await user.click(screen.getByRole('button', { name: 'Forget the former name Customers' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Forget the former name “Customers”?' });
    expect(dialog.textContent).toContain(
      '2 controls still use it and will show “Configuration not found” until they use “Customers API”.'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Forget' }));
    expect(screen.getByText('Forgotten when you save.')).toBeTruthy();
    expect(status()).toBe('Unsaved changes');

    // Undo, then forget again.
    await user.click(screen.getByRole('button', { name: 'Keep the former name Customers' }));
    expect(saveButton()).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Forget the former name Customers' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Forget' })
    );
    await user.click(saveButton());
    expect(savedDoc(services).aliases).toEqual(['Old customers']);
  });

  it('warns before a rename drops the oldest of five former names', async () => {
    const user = userEvent.setup();
    renderEditor({
      configuration: configuration({ aliases: ['E', 'D', 'C', 'B', 'A'] }),
      scanned: [namingControl('Account', 'A')],
    });
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Customers v2');
    expect(
      screen.getByText(
        'Renaming drops the oldest former name, “A”: a configuration keeps five. 1 control still uses it. Forget another one first to keep it.'
      )
    ).toBeTruthy();
    // A warning: saving isn't blocked.
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
    // Forgetting another one makes room.
    await user.click(screen.getByRole('button', { name: 'Forget the former name E' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Forget' })
    );
    expect(screen.queryByText(/^Renaming drops/)).toBeNull();
  });
});

describe('sharing with deleted processes', () => {
  it('keeps the last process that still exists, even when a deleted one is listed', () => {
    renderEditor({
      permissions: CONTOSO_EDITOR,
      configuration: configuration({ processIds: ['p-contoso', 'p-deleted'] }),
    });
    // Removing Contoso Agile would leave only a process that no longer exists.
    expect(screen.queryByRole('button', { name: 'Stop sharing with Contoso Agile' })).toBeNull();
    // Nobody has Edit process on the deleted one, so whoever may edit the configuration can drop it.
    expect(screen.getByRole('button', { name: 'Stop sharing with Unknown process' })).toBeTruthy();
  });

  it('never lets someone who can’t edit the configuration drop a deleted process', () => {
    renderEditor({
      permissions: VIEWER,
      configuration: configuration({ processIds: ['p-contoso', 'p-deleted'] }),
    });
    expect(screen.queryByRole('button', { name: /^Stop sharing with/ })).toBeNull();
  });
});

describe('saved configurations without their secret', () => {
  it('says forms can’t sign in until it’s entered', () => {
    renderEditor({
      configuration: configuration({
        settings: { RestServiceAddress: 'https://api.contoso.com/x', AuthMethod: 'Bearer token' },
      }),
    });
    expect(
      within(credentialsCard()).getByText(
        'Not set: forms that use it can’t sign in until it’s entered.'
      )
    ).toBeTruthy();
  });

  it('tests Basic with a user name and no password, as forms send it', () => {
    renderEditor({ configuration: configuration() });
    expect(screen.queryByText('Enter the password in Credentials to test.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run test' })).toHaveProperty('disabled', false);
  });
});

describe('use it on a form', () => {
  it('gives the name to enter, and links to the process’s controls after asking', async () => {
    const user = userEvent.setup();
    const onShowControls = vi.fn<() => void>();
    renderEditor({ configuration: configuration(), onShowControls });
    const card = screen.getByRole('region', { name: 'Use it on a form' });
    // The product's name, with the name the process editor lists the control under.
    expect(
      within(card).getByText(
        'In the process editor, add the REST Picklist control (listed as “Rest Data Mapping Picklist”), choose the field and enter this configuration name:'
      )
    ).toBeTruthy();
    expect(within(card).getByText('Customers API', { selector: 'code' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Copy configuration name' })).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), ' 2');
    expect(within(card).getByText('Customers API 2', { selector: 'code' })).toBeTruthy();
    expect(within(card).getByText('Forms find it by this name once you save.')).toBeTruthy();
    await user.click(
      within(card).getByRole('button', { name: 'assign it under Controls in this process' })
    );
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' })
    );
    expect(onShowControls).toHaveBeenCalledTimes(1);
  });

  it('only mentions the controls when the page can’t open them', () => {
    renderEditor({ configuration: configuration() });
    const card = screen.getByRole('region', { name: 'Use it on a form' });
    expect(within(card).getByText('Or assign it under Controls in this process.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /assign it/ })).toBeNull();
  });
});
