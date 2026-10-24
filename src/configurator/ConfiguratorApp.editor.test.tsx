/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationDocument } from '../core/configurations';
import { ConfiguratorApp } from './ConfiguratorApp';
import type { SetupServices } from './services';
import { configuration, fakeServices, installMatchMedia } from './testUtils';

// The page with the real configuration editor (ConfiguratorApp.test.tsx uses a stand-in), for
// what only the two together do: saving, renaming, and leaving while a save is under way.

vi.mock('azure-devops-extension-sdk', () => ({}));

beforeAll(installMatchMedia);

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
});

afterEach(cleanup);

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save configuration' });
}

describe('the page with the real editor', { timeout: 20_000 }, () => {
  it('creates, saves and renames a configuration, and the list follows', async () => {
    const user = userEvent.setup();
    const fake = fakeServices({}, { configurations: [] });
    render(<ConfiguratorApp services={fake} />);
    await user.click(await screen.findByRole('button', { name: 'New configuration' }));
    expect(
      await screen.findByRole('heading', { name: 'New configuration', level: 2 })
    ).toBeTruthy();

    await user.type(screen.getByLabelText('Name'), 'Tickets');
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/t');
    await user.click(saveButton());
    expect(await screen.findByText('Saved “Tickets”.')).toBeTruthy();
    const [created] = await fake.listConfigurations();
    await waitFor(() => expect(window.location.hash).toBe(`#edit=${created?.id}`));

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Tickets v2');
    await user.click(saveButton());
    expect(await screen.findByText('Saved “Tickets v2”.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tickets v2', level: 2 })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back to Configurations' }));
    expect(await screen.findByRole('heading', { name: 'Tickets v2', level: 3 })).toBeTruthy();
    expect(screen.getByText('Also answers to “Tickets”')).toBeTruthy();
  });

  it('doesn’t walk back into the editor when a first save finishes after leaving it', async () => {
    const user = userEvent.setup();
    const fake = fakeServices({}, { configurations: [configuration('Tickets')] });
    let finish: (() => void) | undefined;
    const save = fake.saveConfiguration;
    fake.saveConfiguration = vi.fn<SetupServices['saveConfiguration']>(
      (doc) =>
        new Promise<ConfigurationDocument>((resolve, reject) => {
          finish = () => {
            save(doc).then(resolve, reject);
          };
        })
    );
    render(<ConfiguratorApp services={fake} />);
    await user.click(await screen.findByRole('button', { name: 'New configuration' }));
    await user.type(await screen.findByLabelText('Name'), 'Regions');
    await user.type(screen.getByLabelText('REST endpoint URL'), 'https://api.contoso.com/r');
    await user.click(saveButton());
    // The back link waits for the save; another tab doesn't, after asking.
    await waitFor(() => expect(fake.saveConfiguration).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Back to Configurations' })).toHaveProperty(
      'disabled',
      true
    );
    await user.click(screen.getByRole('tab', { name: 'Security policy' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' })
    );
    expect(screen.getByRole('tab', { name: 'Security policy', selected: true })).toBeTruthy();

    expect(finish).toBeDefined();
    finish?.();
    // The save went through: say so, but stay where the person went.
    expect(await screen.findByText('Saved “Regions”.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Security policy', selected: true })).toBeTruthy();
    expect(window.location.hash).toBe('#policy');
    expect(screen.queryByRole('button', { name: 'Save configuration' })).toBeNull();
  });
});
