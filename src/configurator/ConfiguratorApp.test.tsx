/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfiguratorApp } from './ConfiguratorApp';
import type { DemoControls, SetupServices } from './services';
import type { FakeData } from './testUtils';
import {
  PERMISSION_CHECK_FAILED,
  PERMISSION_CHECK_REFUSED,
  VIEWER,
  configuration,
  editorOf,
  fakeServices,
  installMatchMedia,
  layoutControl,
} from './testUtils';

vi.mock('azure-devops-extension-sdk', () => ({}));
// The page's part of the editor contract is tested with a stand-in that has the same props.
vi.mock('./ConfigurationEditor', () => import('./testEditor'));

beforeAll(installMatchMedia);

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
});

afterEach(cleanup);

const TICKETS = configuration('Tickets', { id: 'cfg-tickets' });
const SHARED = configuration('Customers', {
  id: 'cfg-customers',
  processIds: ['p-contoso', 'p-fabrikam'],
});

function services(data: Partial<FakeData> = {}, overrides: Partial<SetupServices> = {}) {
  return fakeServices(overrides, { configurations: [TICKETS, SHARED], ...data });
}

/** A control that still names the configuration by its former name, “customers”. */
function usingCustomers(id: string, processId: string, processName: string) {
  return layoutControl({
    controlId: id,
    processId,
    processName,
    inputs: { FieldName: 'Custom.Customer', Configuration: 'customers' },
  });
}

function renderApp(fake = services()) {
  render(<ConfiguratorApp services={fake} />);
  return fake;
}

describe('tabs and the address', () => {
  it('opens Configurations, moves between tabs with the keyboard and keeps the hash in sync', async () => {
    const user = userEvent.setup();
    const fake = renderApp();
    const configurations = screen.getByRole('tab', { name: 'Configurations' });
    expect(configurations.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Configurations',
      'Security policy',
    ]);
    expect(await screen.findByRole('heading', { name: 'Contoso Agile', level: 2 })).toBeTruthy();
    // Nothing is written to the address on load, so the host page's own hash still counts.
    expect(fake.replaceHash).not.toHaveBeenCalled();

    configurations.focus();
    await user.keyboard('{ArrowRight}');
    const policy = screen.getByRole('tab', { name: 'Security policy' });
    expect(policy).toBe(document.activeElement);
    expect(policy.getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#policy');
    expect(fake.replaceHash).toHaveBeenLastCalledWith('policy');
    expect(await screen.findByRole('button', { name: 'Save policy' })).toBeTruthy();

    await user.keyboard('{Home}');
    expect(window.location.hash).toBe('#configurations');
    expect(screen.getByRole('tabpanel', { name: 'Configurations' }).hidden).toBe(false);
  });

  it('opens the tab named in the URL hash, or the host page’s', async () => {
    window.history.replaceState(null, '', '/#policy');
    renderApp();
    expect(screen.getByRole('tab', { name: 'Security policy' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(await screen.findByRole('button', { name: 'Save policy' })).toHaveProperty(
      'disabled',
      true
    );
    cleanup();
    window.history.replaceState(null, '', '/');

    renderApp(services({}, { getHash: vi.fn<() => Promise<string>>(async () => '#policy') }));
    expect(
      await screen.findByRole('tab', { name: 'Security policy', selected: true })
    ).toBeTruthy();
  });

  it('turns editing off with an explanation when permissions can’t be checked', async () => {
    const user = userEvent.setup();
    const loadPermissions = vi
      .fn<SetupServices['loadPermissions']>()
      .mockResolvedValueOnce(PERMISSION_CHECK_FAILED)
      .mockResolvedValue(editorOf('p-contoso'));
    renderApp(services({}, { loadPermissions }));
    expect(
      await screen.findByText(
        'Couldn’t check your permissions (Azure DevOps answered 500). Editing is turned off until it works.'
      )
    ).toBeTruthy();
    expect(screen.getByText('View only: your permissions couldn’t be checked.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View Tickets' })).toBeTruthy();
    expect(loadPermissions).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'p-contoso' })])
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Edit Tickets' })).toBeTruthy();
    expect(screen.queryByText(/^Couldn’t check your permissions/)).toBeNull();
  });

  it('keeps editing on, and says so, when Azure DevOps refuses the permission check', async () => {
    // Refused for everyone (the extension's token may not be allowed to ask), Project
    // Collection Administrators included: a read-only page would lock everyone out.
    renderApp(services({}, { loadPermissions: async () => PERMISSION_CHECK_REFUSED }));
    expect(await screen.findByText('Couldn’t verify your permissions')).toBeTruthy();
    expect(
      screen.getByText(
        /^Couldn’t verify your permissions \(Azure DevOps answered 403\), so editing/
      )
    ).toBeTruthy();
    expect(
      screen.getByText(/^Your permissions couldn’t be verified, so editing isn’t limited\./)
    ).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Edit Tickets' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New configuration' }).length).toBeGreaterThan(0);
  });
});

describe('the configuration editor', () => {
  it('replaces the list, moves focus to its heading and comes back to the list', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Edit Tickets' }));
    const heading = screen.getByRole('heading', { name: 'Tickets', level: 2 });
    expect(heading).toBe(document.activeElement);
    expect(window.location.hash).toBe('#edit=cfg-tickets');
    expect(screen.getByText(/^Editable · opened from p-contoso · 2 configurations/)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Processes' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '‹ Configurations' }));
    expect(window.location.hash).toBe('#configurations');
    expect(screen.getByRole('heading', { name: 'Contoso Agile', level: 2 })).toBe(
      document.activeElement
    );
  });

  it('opens the configuration or the new one named in the address', async () => {
    window.history.replaceState(null, '', '/#edit=cfg-customers');
    sessionStorage.setItem('rest-picklist:setup:process', 'p-fabrikam');
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Customers', level: 2 })).toBeTruthy();
    expect(screen.getByText(/opened from p-fabrikam/)).toBeTruthy();
    cleanup();

    window.history.replaceState(null, '', '/#edit=cfg-gone');
    renderApp();
    expect(
      await screen.findByText('That configuration doesn’t exist anymore. It may have been deleted.')
    ).toBeTruthy();
    // The address is written by an effect after the notice shows, outside any user event.
    await waitFor(() => expect(window.location.hash).toBe('#configurations'));
    cleanup();

    window.history.replaceState(null, '', '/#new=p-agile');
    renderApp();
    expect(
      await screen.findByText(
        'That process can’t hold REST Picklist controls, so the editor didn’t open.'
      )
    ).toBeTruthy();
  });

  it('keeps editing a new configuration after its first save, under its own address', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/#new=p-fabrikam');
    const fake = renderApp();
    expect(await screen.findByRole('heading', { name: 'New configuration' })).toBeTruthy();
    expect(screen.getByText(/opened from p-fabrikam/)).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Regions');
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    const saved = await vi.mocked(fake.saveConfiguration).mock.results[0]?.value;
    expect(saved).toEqual(expect.objectContaining({ name: 'Regions', processIds: ['p-fabrikam'] }));
    await waitFor(() => expect(window.location.hash).toBe(`#edit=${saved?.id}`));
    // The same editor goes on, now with the stored configuration.
    expect(screen.getByRole('heading', { name: 'Regions', level: 2 })).toBeTruthy();
    expect(screen.getByText(/· 3 configurations ·/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '‹ Configurations' }));
    expect(screen.getByRole('heading', { name: 'Fabrikam Scrum', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Regions', level: 3 })).toBeTruthy();
  });

  it('asks before a tab switch would lose unsaved changes', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Edit Tickets' }));
    await user.type(screen.getByLabelText('Name'), ' 2');
    await user.click(screen.getByRole('tab', { name: 'Security policy' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Discard changes to “Tickets”?' });
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Keep editing', 'Discard']);
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toBe(
      document.activeElement
    );
    await user.keyboard('{Escape}');
    expect(screen.getByRole('tab', { name: 'Configurations', selected: true })).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Tickets 2');
    expect(window.location.hash).toBe('#edit=cfg-tickets');

    await user.click(screen.getByRole('tab', { name: 'Security policy' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('tab', { name: 'Security policy', selected: true })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Configurations' }));
    // The editor closed: the list is back.
    expect(screen.getByRole('heading', { name: 'Contoso Agile', level: 2 })).toBeTruthy();
  });

  it('switches tabs without asking when nothing changed', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Edit Tickets' }));
    await user.click(screen.getByRole('tab', { name: 'Security policy' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(window.location.hash).toBe('#policy');
  });

  it('offers to update the controls that still use a former name', async () => {
    const user = userEvent.setup();
    const fake = services({
      permissions: editorOf('p-contoso'),
      controls: [
        usingCustomers('c1', 'p-contoso', 'Contoso Agile'),
        usingCustomers('c2', 'p-contoso', 'Contoso Agile'),
        usingCustomers('f1', 'p-fabrikam', 'Fabrikam Scrum'),
      ],
    });
    renderApp(fake);
    await screen.findByText(/used by 3 controls$/);
    await user.click(screen.getByRole('button', { name: 'Edit Customers' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Customers API');
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Update 2 controls to “Customers API”?',
    });
    expect(dialog.textContent).toContain(
      'These controls still use the former name “Customers”. They keep working either way, because “Customers API” still answers to it.'
    );
    expect(dialog.textContent).toContain(
      '1 more control is in processes you can’t edit, and keep using the former name.'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Update 2 controls' }));
    expect(await within(dialog).findByText('Updated 2 of 2 controls.')).toBeTruthy();
    expect(
      vi
        .mocked(fake.updateControlInputs)
        .mock.calls.map(([updated, inputs]) => [updated.controlId, inputs])
    ).toEqual([
      ['c1', { FieldName: 'Custom.Customer', Configuration: 'Customers API' }],
      ['c2', { FieldName: 'Custom.Customer', Configuration: 'Customers API' }],
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens Controls in this process from the editor', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Edit Tickets' }));
    await user.click(
      screen.getByRole('button', { name: 'Assign it under Controls in this process' })
    );
    expect(screen.getByRole('heading', { name: 'Controls in this process' })).toBe(
      document.activeElement
    );
  });

  it('opens the editor read-only for people who may only look', async () => {
    const user = userEvent.setup();
    renderApp(services({ permissions: VIEWER }));
    await user.click(await screen.findByRole('button', { name: 'View Tickets' }));
    expect(screen.getByText(/^Read only/)).toBeTruthy();
  });
});

describe('the local demo', () => {
  it('switches who you are and checks permissions again', async () => {
    const user = userEvent.setup();
    let persona = 'admin';
    const demo: DemoControls = {
      personas: [
        { id: 'admin', label: 'Project Collection Administrator' },
        { id: 'viewer', label: 'Viewer' },
      ],
      persona: () => persona,
      setPersona: vi.fn<(id: string) => void>((id) => {
        persona = id;
      }),
    };
    const loadPermissions = vi.fn<SetupServices['loadPermissions']>(async () =>
      persona === 'viewer' ? VIEWER : editorOf('p-contoso')
    );
    renderApp(services({}, { mode: 'demo', demo, loadPermissions }));
    expect(await screen.findByRole('button', { name: 'Edit Tickets' })).toBeTruthy();
    expect(screen.getByText('Local demo')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Signed in as'), 'viewer');
    expect(demo.setPersona).toHaveBeenCalledWith('viewer');
    expect(await screen.findByRole('button', { name: 'View Tickets' })).toBeTruthy();
    expect(loadPermissions).toHaveBeenCalledTimes(2);
  });

  it('isn’t shown inside Azure DevOps', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Contoso Agile', level: 2 });
    expect(screen.queryByLabelText('Signed in as')).toBeNull();
  });
});
