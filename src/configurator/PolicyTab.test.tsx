/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import { parsePolicy } from '../core/policy';
import type { SecurityPolicy } from '../core/policy';
import type { SetupServices } from './services';
import { ConfiguratorApp } from './ConfiguratorApp';
import {
  PERMISSION_CHECK_FAILED,
  PERMISSION_CHECK_REFUSED,
  VIEWER,
  editorOf,
  fakeServices,
  installMatchMedia,
} from './testUtils';

vi.mock('azure-devops-extension-sdk', () => ({}));
vi.mock('./ConfigurationEditor', () => import('./testEditor'));

beforeAll(installMatchMedia);

beforeEach(() => {
  window.history.replaceState(null, '', '/#policy');
  sessionStorage.clear();
});

afterEach(cleanup);

const STORED = parsePolicy({
  allowedHosts: ['api.contoso.com'],
  changedBy: 'Megan Bowen',
  changedAt: '2026-09-14T15:32:00.000Z',
});

/** The value written out next to a term of the read-only policy. */
function term(name: string): string | null | undefined {
  return screen.getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
}

describe('security policy', () => {
  it('shows the stored policy, the honest note and who changed it', async () => {
    render(<ConfiguratorApp services={fakeServices({ loadPolicy: async () => STORED })} />);
    const hosts = await screen.findByLabelText('Allowed hosts');
    expect(hosts).toHaveProperty('value', 'api.contoso.com');
    expect(screen.getByText('A guard rail for process editors, not a lock.')).toBeTruthy();
    expect(screen.getByText(/lets any member of the organization change through its/)).toBeTruthy();
    expect(screen.getByText(/can’t be detected in the browser/)).toBeTruthy();
    expect(screen.getByText('Recommended')).toBeTruthy();
    // Written like every other date on the page (changed at 15:32 UTC on 14 Sep).
    expect(screen.getByText(/^Last changed by Megan Bowen on \d{1,2} Sep 2026\.$/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save policy' });
    expect(save).toHaveProperty('disabled', true);
    // Like the editor's footer: the state first, the actions last, Save trailing.
    const bar = save.closest('.cf-actionbar');
    expect(bar?.firstElementChild?.className).toBe('cf-actionbar__state');
    expect(bar?.lastElementChild?.lastElementChild).toBe(save);
  });

  it('never offers the defaults for editing when the saved policy can’t be read', async () => {
    const loadPolicy = vi
      .fn<() => Promise<SecurityPolicy>>()
      .mockRejectedValueOnce(new PicklistError('network', 'Couldn’t read the policy.'))
      .mockResolvedValueOnce(STORED);
    render(<ConfiguratorApp services={fakeServices({ loadPolicy })} />);
    expect(await screen.findByText('Couldn’t read the policy.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Allowed hosts')).toHaveProperty(
      'value',
      'api.contoso.com'
    );
  });

  // It types into most of the form, one keystroke at a time.
  it('validates hosts, sign-in methods and limits before saving', { timeout: 15_000 }, async () => {
    const user = userEvent.setup();
    const services = fakeServices({ loadPolicy: async () => STORED });
    render(<ConfiguratorApp services={services} />);
    const hosts = await screen.findByLabelText('Allowed hosts');
    await user.type(hosts, '{Enter}*.com');
    expect(screen.getByText(/^Line 2: “\*\.com” would allow too many sites/)).toBeTruthy();
    expect(hosts.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Unsaved changes: fix the problems above to save/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save policy' });
    expect(save).toHaveProperty('disabled', true);
    await user.clear(hosts);
    await user.type(hosts, 'api.contoso.com');

    for (const method of ['None', 'Basic', 'Bearer token', 'API key', 'OAuth 2.0']) {
      await user.click(screen.getByLabelText(method));
    }
    expect(
      screen.getByText('Allow at least one sign-in method, or every list stops loading.')
    ).toBeTruthy();
    await user.click(screen.getByLabelText('Bearer token'));

    const pages = screen.getByLabelText('Maximum pages');
    await user.clear(pages);
    await user.type(pages, '500');
    expect(screen.getByText('Enter a whole number from 1 to 100.')).toBeTruthy();
    expect(save).toHaveProperty('disabled', true);
    await user.clear(pages);
    await user.type(pages, '20');
    expect(save).toHaveProperty('disabled', false);
    expect(services.savePolicy).not.toHaveBeenCalled();
  });

  it('saves the policy and shows the new state', async () => {
    const user = userEvent.setup();
    const services = fakeServices({ loadPolicy: async () => STORED });
    render(<ConfiguratorApp services={services} />);
    await user.click(await screen.findByLabelText(/^Block private network addresses/));
    await user.click(screen.getByLabelText('OAuth 2.0'));
    // The 3.0 switch is gone; the stored value is kept for older controls.
    expect(screen.queryByLabelText('Allow saved configurations')).toBeNull();
    expect(screen.queryByText('Saved configurations')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(services.savePolicy).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(services.savePolicy).mock.calls[0]?.[0];
    expect(saved?.blockPrivateNetworks).toBe(true);
    expect(saved?.allowSavedConfigurations).toBe(true);
    expect(saved?.allowedAuthMethods).toEqual(['none', 'basic', 'bearer', 'apiKey']);
    expect(saved?.allowedHosts).toEqual(['api.contoso.com']);
    expect(
      await screen.findByText('Policy saved. Controls pick it up within five minutes.')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save policy' })).toHaveProperty('disabled', true);
  });

  it('shows the policy as text to people who can’t change it', async () => {
    render(
      <ConfiguratorApp
        services={fakeServices(
          {
            loadPolicy: async () =>
              parsePolicy({
                ...STORED,
                allowedAuthMethods: ['none', 'oauth2'],
                maxItems: 5000,
                timeoutSeconds: 30,
              }),
          },
          { permissions: editorOf('p-contoso') }
        )}
      />
    );
    expect(
      await screen.findByText('Only Project Collection Administrators can change the policy.')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(term('Allowed hosts')).toBe('api.contoso.com');
    expect(term('Private network addresses')).toBe('Allowed');
    expect(term('OAuth 2.0')).toBe('Allowed');
    expect(term('API key')).toBe('Not allowed');
    expect(term('Maximum items')).toBe('5,000');
    expect(term('Timeout')).toBe('30 seconds');
    expect(screen.getByText(/^Last changed by Megan Bowen on /)).toBeTruthy();
  });

  it('is read-only for everyone while permissions can’t be checked', async () => {
    const loadPermissions = vi
      .fn<SetupServices['loadPermissions']>()
      .mockResolvedValueOnce(PERMISSION_CHECK_FAILED)
      .mockResolvedValue(VIEWER);
    render(
      <ConfiguratorApp
        services={fakeServices({ loadPolicy: async () => STORED, loadPermissions })}
      />
    );
    expect(
      await screen.findByText(
        'Couldn’t check your permissions (Azure DevOps answered 500). Editing is turned off until it works.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText('Only Project Collection Administrators can change the policy.')
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loadPermissions).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText(/^Couldn’t check your permissions/)).toBeNull());
  });

  it('stays read-only, and says why, when Azure DevOps refuses the permission check itself', async () => {
    // A refused check can't tell administrators apart, so it never grants what's theirs only.
    render(
      <ConfiguratorApp
        services={fakeServices({
          loadPolicy: async () => STORED,
          loadPermissions: async () => PERMISSION_CHECK_REFUSED,
        })}
      />
    );
    expect(
      await screen.findByText('Only Project Collection Administrators can change the policy.')
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Your permissions couldn’t be verified, so the policy stays read-only until the check works.'
      )
    ).toBeTruthy();
    // The page-wide notice stays: it can't be dismissed.
    expect(screen.getByText('Couldn’t verify your permissions')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('discards changes and reports a refused save', async () => {
    const user = userEvent.setup();
    const services = fakeServices({
      loadPolicy: async () => STORED,
      savePolicy: vi.fn<(policy: SecurityPolicy) => Promise<SecurityPolicy>>(async () => {
        throw new PicklistError(
          'http',
          'You don’t have permission to change the security policy.',
          403
        );
      }),
    });
    render(<ConfiguratorApp services={services} />);
    const localhost = await screen.findByLabelText('Allow http://localhost for testing');
    await user.click(localhost);
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You don’t have permission to change the security policy.'
    );
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(localhost).toHaveProperty('checked', false);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('keeps focused fields clear of the pinned Save bar', async () => {
    // jsdom has no layout: the bar reports 57 px and the observer reports once, on observe.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          this.callback();
        }
        unobserve() {}
        disconnect() {}
      }
    );
    const height = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('cf-actionbar') ? 57 : 0;
      });
    const root = document.documentElement;
    try {
      const { unmount } = render(
        <ConfiguratorApp services={fakeServices({ loadPolicy: async () => STORED })} />
      );
      // The whole page loads first, which can take more than findBy's default second while
      // every test file runs at once.
      await screen.findByRole('button', { name: 'Save policy' }, { timeout: 5000 });
      // The page's bottom scroll padding (see configurator.css) is the bar plus a little room.
      expect(root.style.getPropertyValue('--cf-actionbar-space')).toBe('65px');
      unmount();
      expect(root.style.getPropertyValue('--cf-actionbar-space')).toBe('');
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
