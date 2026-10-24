/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { LeftoverInputsError } from '../devops/layout';
import type { SetupServices } from './services';
import { renderTab } from './testTab';
import type { FakeData } from './testUtils';
import { VIEWER, configuration, fakeServices, installMatchMedia, layoutControl } from './testUtils';

vi.mock('azure-devops-extension-sdk', () => ({}));

beforeAll(installMatchMedia);

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(cleanup);

const CUSTOMERS = configuration('Customers API', { id: 'cfg-customers', aliases: ['Customers'] });
const TICKETS = configuration('Tickets', { id: 'cfg-tickets' });

function control(type: string, label: string, inputs: Record<string, string>): LayoutControl {
  return layoutControl({
    controlId: `${type}-${label}`,
    label,
    workItemType: { name: type, referenceName: `Contoso.${type.replace(/\s+/g, '')}` },
    inputs: { FieldName: `Custom.${label.replace(/\s+/g, '')}`, ...inputs },
  });
}

const BUG_CUSTOMER = control('Bug', 'Customer', { Configuration: 'Customers API' });
const STORY_CUSTOMER = control('User Story', 'Customer', { Configuration: 'Customers' });
const FEATURE_OWNER = control('Feature', 'Owner', {});
const ISSUE_VENDOR = control('Issue', 'Vendor', { Configuration: 'Vendors' });
const TASK_CUSTOMER = control('Task', 'Customer', {
  Configuration: 'Customers API',
  RestServiceAddress: 'https://old.contoso.com/customers',
  SaveConfiguration: 'true',
  SavedConfigurationName: 'Old customers',
});
const EPIC_ACCOUNT = control('Epic', 'Account', { SavedConfiguration: 'Old customers' });
const BUG_SEVERITY = control('Bug', 'Severity', {
  Configuration: 'Tickets',
  RestServiceAddress: 'https://old.contoso.com/severity',
});

const ALL = [
  BUG_CUSTOMER,
  STORY_CUSTOMER,
  FEATURE_OWNER,
  ISSUE_VENDOR,
  TASK_CUSTOMER,
  EPIC_ACCOUNT,
  BUG_SEVERITY,
];

function services(data: Partial<FakeData> = {}, overrides: Partial<SetupServices> = {}) {
  return fakeServices(overrides, {
    configurations: [CUSTOMERS, TICKETS],
    controls: ALL,
    ...data,
  });
}

function rowOf(type: string, label: string): HTMLElement {
  const rows = screen
    .getAllByRole('row')
    .filter(
      (row) =>
        within(row).queryByRole('rowheader', { name: new RegExp(`^${label}`) }) &&
        within(row).queryByText(type, { selector: 'td' })
    );
  const [row] = rows;
  if (!row || rows.length > 1) {
    throw new Error(`No single row for ${type} › ${label}`);
  }
  return row;
}

function announcement(): string {
  return document.querySelector('.cf-controls [aria-live="polite"]')?.textContent ?? '';
}

describe('controls in this process', () => {
  it('lists every control with what it uses, in a table', async () => {
    renderTab(services());
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual(['Work item type', 'Control', 'Configuration']);
    expect(within(rowOf('Bug', 'Customer')).getByText('Custom.Customer')).toBeTruthy();
    expect(
      within(rowOf('Bug', 'Customer')).getByRole('combobox', {
        name: 'Configuration for Bug › Customer',
      })
    ).toHaveProperty('value', 'cfg-customers');
    expect(
      within(rowOf('Issue', 'Vendor')).getByText('No configuration named “Vendors”')
    ).toBeTruthy();
    expect(
      within(rowOf('Epic', 'Account')).getByText('Settings in the process editor')
    ).toBeTruthy();
    // The dialog moves every control of the process that can move, so the button says so.
    expect(
      within(rowOf('Epic', 'Account')).getByRole('button', { name: 'Review and move' })
    ).toBeTruthy();
    expect(
      within(rowOf('User Story', 'Customer')).getByText(/^Uses its former name “Customers”\./)
    ).toBeTruthy();
  });

  it('changes a control’s configuration with Apply, or puts it back with Cancel', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('table');
    const select = within(rowOf('Bug', 'Customer')).getByRole('combobox');
    expect(within(rowOf('Bug', 'Customer')).queryByRole('button', { name: 'Apply' })).toBeNull();

    await user.selectOptions(select, 'cfg-tickets');
    await user.click(within(rowOf('Bug', 'Customer')).getByRole('button', { name: 'Cancel' }));
    expect(select).toHaveProperty('value', 'cfg-customers');
    expect(fake.updateControlInputs).not.toHaveBeenCalled();

    await user.selectOptions(select, 'cfg-tickets');
    await user.click(within(rowOf('Bug', 'Customer')).getByRole('button', { name: 'Apply' }));
    expect(fake.updateControlInputs).toHaveBeenCalledWith(
      expect.objectContaining({ controlId: 'Bug-Customer' }),
      { FieldName: 'Custom.Customer', Configuration: 'Tickets' }
    );
    expect(await within(rowOf('Bug', 'Customer')).findByText('Saved')).toBeTruthy();
    expect(announcement()).toBe('Saved. Bug › Customer now uses “Tickets”.');
    expect(within(rowOf('Bug', 'Customer')).getByRole('combobox')).toHaveProperty(
      'value',
      'cfg-tickets'
    );
  });

  it('assigns a configuration to a control that has none, and reports refusals in the row', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('table');
    const owner = within(rowOf('Feature', 'Owner')).getByRole('combobox');
    expect(owner).toHaveProperty('value', '');
    vi.mocked(fake.updateControlInputs).mockRejectedValueOnce(
      new PicklistError(
        'http',
        'You don’t have permission to edit the “Contoso Agile” process.',
        403
      )
    );
    await user.selectOptions(owner, 'cfg-customers');
    await user.click(within(rowOf('Feature', 'Owner')).getByRole('button', { name: 'Apply' }));
    expect(
      await within(rowOf('Feature', 'Owner')).findByText(
        'You don’t have permission to edit the “Contoso Agile” process.'
      )
    ).toBeTruthy();
    expect(announcement()).toBe(
      'Couldn’t change Feature › Owner. You don’t have permission to edit the “Contoso Agile” process.'
    );
    await user.click(within(rowOf('Feature', 'Owner')).getByRole('button', { name: 'Apply' }));
    expect(await within(rowOf('Feature', 'Owner')).findByText('Saved')).toBeTruthy();
    expect(vi.mocked(fake.updateControlInputs).mock.calls.at(-1)?.[1]).toEqual({
      FieldName: 'Custom.Owner',
      Configuration: 'Customers API',
    });
  });

  it('moves a control off a former name', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('table');
    await user.click(
      within(rowOf('User Story', 'Customer')).getByRole('button', { name: 'Use “Customers API”' })
    );
    expect(await within(rowOf('User Story', 'Customer')).findByText('Saved')).toBeTruthy();
    expect(vi.mocked(fake.updateControlInputs).mock.calls[0]?.[1]).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Customers API',
    });
    expect(within(rowOf('User Story', 'Customer')).queryByText(/former name/)).toBeNull();
  });

  it('cleans up old settings, unless other controls still use them', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('table');
    await user.click(
      within(rowOf('Task', 'Customer')).getByRole('button', { name: 'Clean up old settings' })
    );
    expect(
      within(rowOf('Task', 'Customer')).getByText(
        'Epic › Account still uses the settings this control saves. Move it first.'
      )
    ).toBeTruthy();
    expect(fake.updateControlInputs).not.toHaveBeenCalled();

    await user.click(
      within(rowOf('Bug', 'Severity')).getByRole('button', { name: 'Clean up old settings' })
    );
    expect(await within(rowOf('Bug', 'Severity')).findByText('Cleaned up')).toBeTruthy();
    expect(fake.updateControlInputs).toHaveBeenCalledWith(
      expect.objectContaining({ controlId: 'Bug-Severity' }),
      { FieldName: 'Custom.Severity', Configuration: 'Tickets' }
    );
    expect(
      within(rowOf('Bug', 'Severity')).queryByRole('button', { name: 'Clean up old settings' })
    ).toBeNull();
  });

  it('lists controls by work item type, then by name', async () => {
    renderTab(services());
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((row) => {
        const [type] = within(row).getAllByRole('cell');
        const name = within(row).getByRole('rowheader').querySelector('.cf-table__name');
        return `${type?.textContent} › ${name?.textContent}`;
      })
    ).toEqual([
      'Bug › Customer',
      'Bug › Severity',
      'Epic › Account',
      'Feature › Owner',
      'Issue › Vendor',
      'Task › Customer',
      'User Story › Customer',
    ]);
  });

  it('keeps the 3.0 settings a control saves for others when it’s pointed elsewhere', async () => {
    // Task › Customer uses a configuration, but still saves “Old customers” for Epic › Account.
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('table');
    await user.selectOptions(
      within(rowOf('Task', 'Customer')).getByRole('combobox'),
      'cfg-tickets'
    );
    await user.click(within(rowOf('Task', 'Customer')).getByRole('button', { name: 'Apply' }));
    expect(await within(rowOf('Task', 'Customer')).findByText('Saved')).toBeTruthy();
    expect(vi.mocked(fake.updateControlInputs).mock.calls[0]?.[1]).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Tickets',
      RestServiceAddress: 'https://old.contoso.com/customers',
      SaveConfiguration: 'true',
      SavedConfigurationName: 'Old customers',
    });
  });

  it('says when Azure DevOps kept a control’s old settings, and shows what it uses now', async () => {
    const user = userEvent.setup();
    const fake = services();
    renderTab(fake);
    await screen.findByRole('table');
    vi.mocked(fake.updateControlInputs).mockImplementationOnce(async (target, inputs) => {
      throw new LeftoverInputsError(
        { ...target, inputs: { ...target.inputs, ...inputs, RestServicePassword: '***' } },
        ['RestServicePassword']
      );
    });
    await user.click(
      within(rowOf('Bug', 'Severity')).getByRole('button', { name: 'Clean up old settings' })
    );
    const message =
      'The old settings, including the password, are still stored on this control. Try again, or remove the control from the form and add it again.';
    expect(await within(rowOf('Bug', 'Severity')).findByText(message)).toBeTruthy();
    expect(within(rowOf('Bug', 'Severity')).queryByText('Cleaned up')).toBeNull();
    expect(announcement()).toBe(`Changed Bug › Severity, but not completely. ${message}`);
    // Still listed as having old settings, so it can be cleaned up again.
    expect(
      within(rowOf('Bug', 'Severity')).getByRole('button', { name: 'Clean up old settings' })
    ).toBeTruthy();
  });

  it('shows what each control uses as text to people who can’t edit the process', async () => {
    renderTab(services({ permissions: VIEWER }));
    const table = await screen.findByRole('table');
    expect(within(table).queryByRole('combobox')).toBeNull();
    expect(within(table).queryByRole('button')).toBeNull();
    expect(within(rowOf('Bug', 'Customer')).getByText('Customers API')).toBeTruthy();
    expect(within(rowOf('Feature', 'Owner')).getByText('Not set')).toBeTruthy();
  });

  it('explains a process that can’t be read, and tries again', async () => {
    const user = userEvent.setup();
    const scan = vi
      .fn<SetupServices['scanProcessControls']>()
      .mockRejectedValueOnce(
        new PicklistError(
          'http',
          'You don’t have permission to read the “Contoso Agile” process (403).',
          403
        )
      )
      .mockResolvedValue([BUG_CUSTOMER]);
    renderTab(services({}, { scanProcessControls: scan }));
    expect(await screen.findByText('Couldn’t read the controls of Contoso Agile.')).toBeTruthy();
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(3));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});

describe('moving older controls', () => {
  const SPONSOR = control('Epic', 'Sponsor', {
    RestServiceAddress: 'https://api.contoso.com/people',
    SaveConfiguration: 'true',
    SavedConfigurationName: 'People',
  });
  const REVIEWER = control('Bug', 'Reviewer', { SavedConfiguration: 'People' });
  const TICKET = control('Task', 'Ticket', {
    RestServiceAddress: 'https://tickets.contoso.com/api',
    AuthMethod: 'Bearer token',
    RestServicePassword: '********',
  });
  const BROKEN = control('Bug', 'Broken', { SavedConfiguration: 'Nowhere' });

  it('shows the plan by configuration, moves the controls and reports each one', async () => {
    const user = userEvent.setup();
    const fake = services({ configurations: [], controls: [SPONSOR, REVIEWER, TICKET, BROKEN] });
    renderTab(fake);
    expect(
      await screen.findByText(
        '4 controls still keep their API settings in the process editor. Move them here so they’re managed in one place.'
      )
    ).toBeTruthy();
    // The banner's button comes first; each row has one too.
    const [reviewAndMove] = screen.getAllByRole('button', { name: 'Review and move' });
    if (!reviewAndMove) {
      throw new Error('Expected Review and move');
    }
    await user.click(reviewAndMove);

    const dialog = screen.getByRole('dialog', { name: 'Move 3 controls to configurations' });
    expect(within(dialog).getByText('Create “People”')).toBeTruthy();
    expect(within(dialog).getByText('Create “Ticket”')).toBeTruthy();
    expect(within(dialog).getByText('Needs the token again')).toBeTruthy();
    expect(within(dialog).getByText('Bug › Reviewer')).toBeTruthy();
    expect(within(dialog).getByText('Can’t move yet')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Bug › Broken uses the saved configuration “Nowhere”, but no control in the Contoso Agile process saves it.'
      )
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        'The process editor won’t show these settings anymore. Secrets Azure DevOps hides can’t be moved, so you’ll enter them again.'
      )
    ).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Cancel', 'Move 3 controls']);

    await user.click(within(dialog).getByRole('button', { name: 'Move 3 controls' }));
    expect(
      await within(dialog).findByText(
        'Moved 3 controls. Enter the secret of “Ticket” in its configuration.'
      )
    ).toBeTruthy();
    expect(within(dialog).getAllByText('Moved')).toHaveLength(3);
    const done = within(dialog).getByRole('button', { name: 'Done' });
    expect(done).toBe(document.activeElement);
    await user.click(done);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'People', level: 3 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ticket', level: 3 })).toBeTruthy();
    const ticket = within(rowOf('Task', 'Ticket')).getByRole<HTMLSelectElement>('combobox');
    expect(ticket.selectedOptions[0]?.textContent).toBe('Ticket');
    expect(
      screen.getByText(
        '1 control still keeps its API settings in the process editor. Move it here so it’s managed in one place.'
      )
    ).toBeTruthy();
  });

  it('lets people back out, and says when nothing can move', async () => {
    const user = userEvent.setup();
    const fake = services({ configurations: [], controls: [BROKEN] });
    renderTab(fake);
    const [reviewAndMove] = await screen.findAllByRole('button', { name: 'Review and move' });
    if (!reviewAndMove) {
      throw new Error('Expected Review and move');
    }
    await user.click(reviewAndMove);
    const dialog = screen.getByRole('dialog', { name: 'Move controls to configurations' });
    expect(within(dialog).getByText('No control in Contoso Agile can move yet.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.saveConfiguration).not.toHaveBeenCalled();
  });
});
