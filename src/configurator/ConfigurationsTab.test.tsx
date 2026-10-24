/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RSA_2048 } from '../core/__fixtures__/credentials';
import { PicklistError } from '../core/errors';
import type * as FilesModule from './files';
import type { SetupServices } from './services';
import { renderTab } from './testTab';
import {
  ADMIN,
  PERMISSION_CHECK_FAILED,
  VIEWER,
  configuration,
  editorOf,
  fakeServices,
  installMatchMedia,
  layoutControl,
} from './testUtils';
import type { FakeData } from './testUtils';

vi.mock('azure-devops-extension-sdk', () => ({}));

const downloads = vi.hoisted(() => [] as Array<{ fileName: string; content: string }>);
vi.mock('./files', async (importOriginal) => {
  const actual = await importOriginal<typeof FilesModule>();
  return {
    ...actual,
    downloadText: (fileName: string, content: string) => {
      downloads.push({ fileName, content });
      return true;
    },
  };
});

beforeAll(installMatchMedia);

beforeEach(() => {
  sessionStorage.clear();
  downloads.length = 0;
});

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const inTwelveDays = new Date(Date.now() + 12 * DAY - 60_000);

const CUSTOMERS = configuration('Customers API', {
  id: 'cfg-customers',
  aliases: ['Customers'],
  processIds: ['p-contoso', 'p-fabrikam'],
  settings: {
    RestServiceAddress: 'https://api.contoso.com/customers',
    AuthMethod: 'OAuth 2.0',
    OAuthSettings:
      '{"tokenUrl":"https://auth.contoso.com/oauth2/token","clientId":"picklist","clientAuthentication":"privateKeyJwt"}',
    RestServiceUserName: 'never-exported',
  },
  secret: {
    kind: 'signingKey',
    boundOrigin: 'https://auth.contoso.com',
    algorithm: 'RS256',
    certificate: { ...RSA_2048.info, notAfter: inTwelveDays.toISOString() },
  },
  updatedBy: 'Ana Díaz',
});
const TICKETS = configuration('Tickets', {
  id: 'cfg-tickets',
  settings: { RestServiceAddress: 'https://tickets.contoso.com/api', AuthMethod: 'Bearer token' },
});
const REGIONS = configuration('Regions', { id: 'cfg-regions', processIds: ['p-fabrikam'] });
const ORPHAN = configuration('Old CRM', { id: 'cfg-old', processIds: ['p-deleted'] });

const BUG_CUSTOMER = layoutControl({
  controlId: 'c1',
  inputs: { FieldName: 'Custom.Customer', Configuration: 'Customers API' },
});
const STORY_CUSTOMER = layoutControl({
  controlId: 'c2',
  workItemType: { name: 'User Story', referenceName: 'Contoso.Story' },
  inputs: { FieldName: 'Custom.Customer', Configuration: 'customers' },
});
const TASK_TICKET = layoutControl({
  controlId: 'c3',
  label: 'Ticket',
  workItemType: { name: 'Task', referenceName: 'Contoso.Task' },
  inputs: {
    FieldName: 'Custom.Ticket',
    RestServiceAddress: 'https://tickets.contoso.com/api',
    AuthMethod: 'Bearer token',
    RestServicePassword: '********',
  },
});
const PBI_CUSTOMER = layoutControl({
  processId: 'p-fabrikam',
  processName: 'Fabrikam Scrum',
  controlId: 'f1',
  workItemType: { name: 'Product Backlog Item', referenceName: 'Fabrikam.PBI' },
  inputs: { FieldName: 'Custom.Customer', Configuration: 'Customers API' },
});
const PBI_REGION = layoutControl({
  processId: 'p-fabrikam',
  processName: 'Fabrikam Scrum',
  controlId: 'f2',
  label: 'Region',
  workItemType: { name: 'Product Backlog Item', referenceName: 'Fabrikam.PBI' },
  inputs: { FieldName: 'Custom.Region', RestServiceAddress: 'https://api.contoso.com/regions' },
});

function services(data: Partial<FakeData> = {}, overrides: Partial<SetupServices> = {}) {
  return fakeServices(overrides, {
    configurations: [CUSTOMERS, TICKETS, REGIONS, ORPHAN],
    controls: [BUG_CUSTOMER, STORY_CUSTOMER, TASK_TICKET, PBI_CUSTOMER, PBI_REGION],
    ...data,
  });
}

function row(name: string): HTMLElement {
  const item = screen.getByRole('heading', { name, level: 3 }).closest('li');
  if (!item) {
    throw new Error(`No row for ${name}`);
  }
  return item;
}

async function menuItems(name: string): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: `More actions for ${name}` }));
  const items = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  await user.keyboard('{Escape}');
  return items;
}

describe('processes', () => {
  it('lists processes with the chosen one highlighted and system processes apart', async () => {
    const user = userEvent.setup();
    renderTab(services());
    const contoso = await screen.findByRole('button', {
      name: 'Contoso Agile, Inherited, 2 configurations',
    });
    expect(contoso.getAttribute('aria-current')).toBe('true');
    // Within the process list: once other processes are read, the legacy banner can link to
    // Fabrikam Scrum as well (“Fabrikam Scrum (1)”).
    const fabrikam = within(screen.getByRole('navigation', { name: 'Processes' })).getByRole(
      'button',
      { name: 'Fabrikam Scrum, Inherited, 2 configurations' }
    );
    expect(fabrikam.getAttribute('aria-current')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Northwind Field Service, Hosted XML, 0 configurations' })
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Can’t hold custom controls' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Agile/ })).toBeNull();
    // Narrow screens get a native select with the same choices.
    const select = screen.getByLabelText('Process');
    expect(select.querySelector('optgroup')?.getAttribute('label')).toBe(
      'Can’t hold custom controls'
    );

    await user.click(fabrikam);
    expect(fabrikam.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Fabrikam Scrum', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Regions', level: 3 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Tickets', level: 3 })).toBeNull();
  });

  it('says what the person may do, with words and an icon', async () => {
    const view = renderTab(services());
    expect(await screen.findByText('You can edit this process’s configurations.')).toBeTruthy();
    view.unmount();

    renderTab(services({ permissions: VIEWER }));
    expect(
      await screen.findByText('View only: you need Edit process permission on Contoso Agile.')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New configuration' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    cleanup();

    renderTab(services({ permissions: PERMISSION_CHECK_FAILED }));
    expect(
      await screen.findByText('View only: your permissions couldn’t be checked.')
    ).toBeTruthy();
  });
});

describe('configuration rows', () => {
  it('reads each configuration as a sentence, with its problems in words', async () => {
    renderTab(services());
    await screen.findByRole('heading', { name: 'Customers API' });
    const customers = row('Customers API');
    expect(within(customers).getByText('Also answers to “Customers”')).toBeTruthy();
    // Once every process it's shared with has been read, the controls are counted.
    expect(
      await within(customers).findByText(
        /^api\.contoso\.com · OAuth 2\.0 with a certificate · expires \d+ \w+ \d{4} · used by 3 controls$/
      )
    ).toBeTruthy();
    expect(within(customers).getByText('Certificate expires in 12 days')).toBeTruthy();
    expect(
      within(customers).getByText(
        /^Shared with Contoso Agile and Fabrikam Scrum · changed by Ana Díaz/
      )
    ).toBeTruthy();
    expect(within(customers).getByRole('button', { name: 'Edit Customers API' })).toBeTruthy();

    const tickets = row('Tickets');
    expect(within(tickets).getByText('Secret not set')).toBeTruthy();
    expect(
      within(tickets).getByText('tickets.contoso.com · bearer token · not used by any control yet')
    ).toBeTruthy();
  });

  it('opens the editor from Edit, View and New configuration', async () => {
    const user = userEvent.setup();
    const view = renderTab(services());
    await user.click(await screen.findByRole('button', { name: 'Edit Tickets' }));
    expect(view.onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cfg-tickets' }),
      'p-contoso'
    );
    await user.click(screen.getByRole('button', { name: 'New configuration' }));
    expect(view.onNew).toHaveBeenCalledWith('p-contoso');
    view.unmount();

    const viewer = renderTab(services({ permissions: VIEWER }));
    await user.click(await screen.findByRole('button', { name: 'View Tickets' }));
    expect(viewer.onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cfg-tickets' }),
      'p-contoso'
    );
  });

  it('offers only what the permissions allow in More actions', async () => {
    renderTab(services());
    await screen.findByRole('heading', { name: 'Customers API' });
    expect(await menuItems('Customers API')).toEqual(['Duplicate', 'Share…', 'Export', 'Delete']);
    cleanup();

    renderTab(services({ permissions: editorOf('p-contoso') }));
    await screen.findByRole('heading', { name: 'Customers API' });
    await waitFor(() =>
      expect(screen.getByText('You can edit this process’s configurations.')).toBeTruthy()
    );
    // Shared with Fabrikam Scrum too, which this person can't edit: no Delete.
    expect(await menuItems('Customers API')).toEqual(['Duplicate', 'Share…', 'Export']);
    expect(await menuItems('Tickets')).toEqual(['Duplicate', 'Export', 'Delete']);
    cleanup();

    renderTab(services({ permissions: VIEWER }));
    await screen.findByRole('heading', { name: 'Customers API' });
    expect(await menuItems('Customers API')).toEqual(['Export']);
  });

  it('shows an empty state with the next steps', async () => {
    const user = userEvent.setup();
    const view = renderTab(services(), 'p-northwind');
    expect(
      await screen.findByText('No configurations for Northwind Field Service yet.')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New configuration' }));
    expect(view.onNew).toHaveBeenCalledWith('p-northwind');
    expect(screen.getByRole('button', { name: 'import a file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export all' })).toHaveProperty('disabled', true);
    view.unmount();

    renderTab(services({ permissions: VIEWER }), 'p-northwind');
    expect(
      await screen.findByText(
        'Someone with Edit process permission on Northwind Field Service can add one.'
      )
    ).toBeTruthy();
  });

  it('lists configurations no process uses for collection administrators only', async () => {
    renderTab(services());
    const section = (
      await screen.findByRole('heading', { name: 'Not used by any process' })
    ).closest('section');
    expect(section && within(section).getByRole('heading', { name: 'Old CRM' })).toBeTruthy();
    expect(section && within(section).queryByRole('button', { name: 'Edit Old CRM' })).toBeNull();
    expect(await menuItems('Old CRM')).toEqual(['Share…', 'Export', 'Delete']);
    cleanup();

    renderTab(services({ permissions: editorOf('p-contoso') }));
    await screen.findByRole('heading', { name: 'Customers API' });
    expect(screen.queryByRole('heading', { name: 'Not used by any process' })).toBeNull();
  });
});

describe('row actions', () => {
  it('duplicates with a unique name and the secret, then opens the copy', async () => {
    const user = userEvent.setup();
    const fake = services({
      permissions: editorOf('p-contoso'),
      secrets: [
        {
          id: 'cfg-customers',
          version: 1,
          secret: { kind: 'signingKey', key: { pkcs8: 'AAAA', algorithm: 'RS256' } },
          boundOrigin: 'https://auth.contoso.com',
        },
      ],
    });
    const view = renderTab(fake);
    await screen.findByRole('heading', { name: 'Customers API' });
    await user.click(screen.getByRole('button', { name: 'More actions for Customers API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() => expect(view.onEdit).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(fake.saveConfiguration).mock.calls[0]?.[0];
    expect(saved).toEqual(
      expect.objectContaining({
        name: 'Customers API copy',
        aliases: [],
        // Only where this person may create configurations.
        processIds: ['p-contoso'],
        secret: CUSTOMERS.secret,
      })
    );
    expect(saved?.__etag).toBeUndefined();
    expect(fake.copySecret).toHaveBeenCalledWith('cfg-customers', saved?.id);
    expect(view.onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Customers API copy', __etag: 1 }),
      'p-contoso'
    );
    expect(
      await screen.findByText('Made “Customers API copy”, a copy of “Customers API”.')
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Customers API copy' })).toBeTruthy();
  });

  it('drops the secret summary when there was no secret to copy, and cleans up after a failure', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('heading', { name: 'Customers API' });
    await user.click(screen.getByRole('button', { name: 'More actions for Customers API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(fake.saveConfiguration).toHaveBeenCalledTimes(1));
    // The fake store has no secret document for it.
    expect(vi.mocked(fake.saveConfiguration).mock.calls[0]?.[0].secret).toBeNull();

    vi.mocked(fake.copySecret).mockResolvedValueOnce(true);
    vi.mocked(fake.saveConfiguration).mockRejectedValueOnce(
      new PicklistError('network', 'Couldn’t save “Customers API copy 2”. Try again in a moment.')
    );
    await user.click(screen.getByRole('button', { name: 'More actions for Customers API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(await screen.findByText('Couldn’t duplicate “Customers API”.')).toBeTruthy();
    expect(
      screen.getByText('Couldn’t save “Customers API copy 2”. Try again in a moment.')
    ).toBeTruthy();
    const failedId = vi.mocked(fake.saveConfiguration).mock.calls[1]?.[0].id;
    expect(fake.deleteSecret).toHaveBeenCalledWith(failedId);
  });

  it('deletes after a confirmation that says what happens', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByText(/used by 3 controls$/);
    const more = screen.getByRole('button', { name: 'More actions for Customers API' });
    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Customers API”?' });
    expect(dialog.textContent).toContain(
      '3 controls use it and will show “Configuration not found” until you choose another. Its secret is deleted too.'
    );
    expect(dialog.textContent).toContain(
      'It’s shared with Contoso Agile and Fabrikam Scrum, and is deleted from all of them.'
    );
    // The safe choice has focus and comes first; Escape backs out.
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel', 'Delete']);
    expect(buttons[0]).toBe(document.activeElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(more).toBe(document.activeElement);
    expect(fake.deleteConfiguration).not.toHaveBeenCalled();

    vi.mocked(fake.deleteConfiguration).mockRejectedValueOnce(
      new PicklistError('http', 'You don’t have permission to delete “Customers API”.', 403)
    );
    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    expect(
      await within(screen.getByRole('alertdialog')).findByText(
        'You don’t have permission to delete “Customers API”.'
      )
    ).toBeTruthy();
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    expect(await screen.findByText('Deleted “Customers API”.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Customers API' })).toBeNull();
    expect(fake.deleteConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'cfg-customers' })
    );
  });

  it('shares with another process when no configuration there answers to the name', async () => {
    const user = userEvent.setup();
    const clash = configuration('Tickets', {
      id: 'cfg-other-tickets',
      processIds: ['p-northwind'],
    });
    const fake = fakeServices({}, { configurations: [TICKETS, clash], permissions: ADMIN });
    renderTab(fake);
    await screen.findByRole('heading', { name: 'Tickets' });
    await user.click(screen.getByRole('button', { name: 'More actions for Tickets' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    const dialog = screen.getByRole('dialog', { name: 'Share “Tickets”' });
    const save = within(dialog).getByRole('button', { name: 'Save sharing' });
    expect(save).toHaveProperty('disabled', true);
    expect(within(dialog).getByLabelText('Contoso Agile')).toHaveProperty('checked', true);

    await user.click(within(dialog).getByLabelText('Northwind Field Service'));
    expect(
      within(dialog).getByText(
        '“Tickets” is already the name of another configuration in the Northwind Field Service process. Choose another name.'
      )
    ).toBeTruthy();
    expect(save).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByLabelText('Northwind Field Service'));

    await user.click(within(dialog).getByLabelText('Contoso Agile'));
    expect(
      within(dialog).getByText('Keep it shared with at least one process, or delete it instead.')
    ).toBeTruthy();
    await user.click(within(dialog).getByLabelText('Fabrikam Scrum'));
    expect(
      within(dialog).getByText(/^Controls in Contoso Agile that use “Tickets” will show/)
    ).toBeTruthy();
    await user.click(save);

    expect(fake.saveConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cfg-tickets', processIds: ['p-fabrikam'] })
    );
    expect(await screen.findByText('“Tickets” is shared with Fabrikam Scrum.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('No configurations for Contoso Agile yet.')).toBeTruthy();
  });

  it('shares a configuration no process uses with one again', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('heading', { name: 'Old CRM' });
    await user.click(screen.getByRole('button', { name: 'More actions for Old CRM' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    const dialog = screen.getByRole('dialog', { name: 'Share “Old CRM”' });
    // Nothing is wrong yet: it just needs a process.
    expect(within(dialog).queryByText(/^Keep it shared/)).toBeNull();
    const save = within(dialog).getByRole('button', { name: 'Save sharing' });
    expect(save).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByLabelText('Contoso Agile'));
    await user.click(save);
    expect(fake.saveConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cfg-old', processIds: ['p-deleted', 'p-contoso'] })
    );
    expect(await screen.findByText('“Old CRM” is shared with Contoso Agile.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Not used by any process' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Old CRM' })).toBeTruthy();
  });

  it('keeps processes the person can’t edit as they are when sharing', async () => {
    const user = userEvent.setup();
    renderTab(services({ permissions: editorOf('p-contoso') }));
    await screen.findByRole('heading', { name: 'Customers API' });
    await waitFor(() =>
      expect(screen.getByText('You can edit this process’s configurations.')).toBeTruthy()
    );
    await user.click(screen.getByRole('button', { name: 'More actions for Customers API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    const dialog = screen.getByRole('dialog', { name: 'Share “Customers API”' });
    expect(within(dialog).getByLabelText('Fabrikam Scrum')).toHaveProperty('disabled', true);
    expect(within(dialog).getByLabelText('Northwind Field Service')).toHaveProperty(
      'disabled',
      true
    );
    expect(within(dialog).getByLabelText('Contoso Agile')).toHaveProperty('disabled', false);
  });
});

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error('No file input');
  }
  return input;
}

function jsonFile(content: unknown, name = 'config.json'): File {
  return new File([typeof content === 'string' ? content : JSON.stringify(content)], name, {
    type: 'application/json',
  });
}

describe('files', () => {
  it('exports one configuration or all of a process, never credentials or user names', async () => {
    const user = userEvent.setup();
    renderTab(services());
    await screen.findByRole('heading', { name: 'Customers API' });
    await user.click(screen.getByRole('button', { name: 'More actions for Customers API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export' }));
    expect(downloads[0]?.fileName).toBe('rest-picklist-customers-api.json');
    const one: unknown = JSON.parse(downloads[0]?.content ?? '{}');
    expect(one).toMatchObject({
      format: 'rest-picklist-configurations',
      version: 2,
      configurations: [
        {
          name: 'Customers API',
          source: 'Contoso Agile, Fabrikam Scrum',
          settings: { RestServiceAddress: 'https://api.contoso.com/customers' },
        },
      ],
    });
    expect(downloads[0]?.content).not.toContain('RestServiceUserName');
    expect(downloads[0]?.content).not.toContain('signingKey');
    expect(downloads[0]?.content).not.toContain(RSA_2048.info.sha1Thumbprint);
    expect(
      await screen.findByText('Exported “Customers API” as rest-picklist-customers-api.json.')
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Export all' }));
    expect(downloads[1]?.fileName).toBe('rest-picklist-contoso-agile.json');
    const all: unknown = JSON.parse(downloads[1]?.content ?? '{}');
    expect(all).toMatchObject({
      configurations: [{ name: 'Customers API' }, { name: 'Tickets' }],
    });
  });

  it('imports 3.0 and 4.0 files into the process, choosing and renaming entries', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('heading', { name: 'Customers API' });
    await user.upload(
      fileInput(),
      jsonFile(
        {
          format: 'rest-picklist-configurations',
          version: 1,
          exportedAt: '2026-09-01T00:00:00Z',
          configurations: [
            {
              name: 'Tickets',
              inputs: { RestServiceAddress: 'https://t.contoso.com', RestServicePassword: 'leak' },
            },
            {
              name: 'People',
              source: 'Feature › Owner',
              inputs: { RestServiceAddress: 'https://api.contoso.com/people' },
            },
            { name: 'Skipped', inputs: { RestServiceAddress: 'https://api.contoso.com/skip' } },
          ],
        },
        'old.json'
      )
    );
    const dialog = await screen.findByRole('dialog', { name: 'Import into Contoso Agile' });
    expect(within(dialog).getByText(/^old\.json has 3 configurations\./)).toBeTruthy();
    expect(within(dialog).getByText('Feature › Owner · api.contoso.com · no sign-in')).toBeTruthy();
    expect(
      within(dialog).getByText(
        '“Tickets” is already the name of another configuration in the Contoso Agile process. Choose another name.'
      )
    ).toBeTruthy();
    const importButton = within(dialog).getByRole('button', { name: 'Import 3 configurations' });
    expect(importButton).toHaveProperty('disabled', true);

    const [firstName] = within(dialog).getAllByLabelText('Name');
    if (!firstName) {
      throw new Error('No name field');
    }
    await user.clear(firstName);
    await user.type(firstName, 'Tickets (3.0)');
    await user.click(within(dialog).getByLabelText('Import Skipped'));
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 configurations' }));

    expect(
      await within(dialog).findByText('Imported 2 of 2 configurations into Contoso Agile.')
    ).toBeTruthy();
    expect(within(dialog).getAllByText('Imported')).toHaveLength(2);
    const saved = vi.mocked(fake.saveConfiguration).mock.calls.map(([doc]) => doc);
    expect(saved.map((doc) => [doc.name, doc.processIds])).toEqual([
      ['Tickets (3.0)', ['p-contoso']],
      ['People', ['p-contoso']],
    ]);
    expect(JSON.stringify(saved)).not.toContain('leak');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('heading', { name: 'Tickets (3.0)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'People' })).toBeTruthy();
  });

  it('explains why a file can’t be imported', async () => {
    const user = userEvent.setup();
    renderTab(services());
    await screen.findByRole('heading', { name: 'Customers API' });
    await user.upload(fileInput(), jsonFile('{ not json', 'broken.json'));
    expect(await screen.findByText('Couldn’t import broken.json.')).toBeTruthy();
    expect(screen.getByText('This file isn’t valid JSON.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('older controls', () => {
  it('counts controls still set up in the process editor, everywhere', async () => {
    const user = userEvent.setup();
    renderTab(services());
    expect(
      await screen.findByText(
        '2 controls still keep their API settings in the process editor. Move them here so they’re managed in one place.'
      )
    ).toBeTruthy();
    expect(screen.getByText('1 control in Contoso Agile')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Fabrikam Scrum (1)' }));
    expect(screen.getByRole('heading', { name: 'Fabrikam Scrum', level: 2 })).toBeTruthy();
  });

  it('shows progress while processes are read, without blocking the page', async () => {
    const gate: { open?: () => void } = {};
    const slow = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const fake = services(
      {},
      {
        scanProcessControls: vi.fn<SetupServices['scanProcessControls']>(async (process) => {
          if (process.id === 'p-northwind') {
            await slow;
          }
          return [];
        }),
      }
    );
    renderTab(fake);
    expect(await screen.findByText(/Looking for controls in every process… 2 of 3/)).toBeTruthy();
    // The configurations are usable meanwhile.
    expect(screen.getByRole('button', { name: 'Edit Customers API' })).toBeTruthy();
    gate.open?.();
    await waitFor(() =>
      expect(screen.queryByText(/Looking for controls in every process/)).toBeNull()
    );
  });

  it('opens the configuration list even when reading them fails', async () => {
    renderTab(
      services(
        {},
        {
          listConfigurations: vi.fn<SetupServices['listConfigurations']>(async () => {
            throw new PicklistError('network', 'Couldn’t read the REST Picklist configurations.');
          }),
        }
      )
    );
    expect(await screen.findByText('Couldn’t read the REST Picklist configurations.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

/** Saves a configuration behind the page's back, as another browser tab would. */
async function addedElsewhere(fake: SetupServices, name: string, processIds: string[]) {
  await fake.saveConfiguration({
    ...configuration(name, { id: `cfg-elsewhere-${name.length}`, processIds }),
    __etag: undefined,
  });
  vi.mocked(fake.saveConfiguration).mockClear();
}

describe('names checked against what’s stored now', () => {
  it('before sharing', async () => {
    const user = userEvent.setup();
    const fake = fakeServices({}, { configurations: [TICKETS], permissions: ADMIN });
    renderTab(fake);
    await screen.findByRole('heading', { name: 'Tickets' });
    await addedElsewhere(fake, 'Tickets', ['p-fabrikam']);
    await user.click(screen.getByRole('button', { name: 'More actions for Tickets' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    const dialog = screen.getByRole('dialog', { name: 'Share “Tickets”' });
    await user.click(within(dialog).getByLabelText('Fabrikam Scrum'));
    await user.click(within(dialog).getByRole('button', { name: 'Save sharing' }));
    expect(
      await within(dialog).findByText(
        '“Tickets” is already the name of another configuration in the Fabrikam Scrum process. Choose another name.',
        { selector: '.cf-callout__title' }
      )
    ).toBeTruthy();
    expect(fake.saveConfiguration).not.toHaveBeenCalled();
  });

  it('before duplicating', async () => {
    const user = userEvent.setup();
    const fake = fakeServices({}, { configurations: [TICKETS], permissions: ADMIN });
    const view = renderTab(fake);
    await screen.findByRole('heading', { name: 'Tickets' });
    await addedElsewhere(fake, 'Tickets copy', ['p-contoso']);
    await user.click(screen.getByRole('button', { name: 'More actions for Tickets' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(view.onEdit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fake.saveConfiguration).mock.calls[0]?.[0].name).toBe('Tickets copy 2');
    // The page's list follows what was read.
    expect(screen.getByRole('heading', { name: 'Tickets copy' })).toBeTruthy();
  });

  it('before importing', async () => {
    const user = userEvent.setup();
    const fake = fakeServices({}, { configurations: [TICKETS], permissions: ADMIN });
    renderTab(fake);
    await screen.findByRole('heading', { name: 'Tickets' });
    await addedElsewhere(fake, 'Billing', ['p-contoso']);
    await user.upload(
      fileInput(),
      jsonFile({ name: 'Billing', settings: { RestServiceAddress: 'https://b.contoso.com' } })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Import into Contoso Agile' });
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 configuration' }));
    expect(
      await within(dialog).findByText(
        '“Billing” is already the name of another configuration in the Contoso Agile process. Choose another name.'
      )
    ).toBeTruthy();
    expect(fake.saveConfiguration).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText('Imported 0 of 1 configuration into Contoso Agile.')
    ).toBeTruthy();
  });
});
