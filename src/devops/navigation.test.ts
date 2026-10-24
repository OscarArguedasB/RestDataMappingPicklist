import { describe, expect, it, vi } from 'vitest';
import {
  HOST_NAVIGATION_SERVICE_ID,
  SETTINGS_HUB_CONTRIBUTION,
  openSettingsPage,
  settingsPageUrl,
} from './navigation';

vi.mock('azure-devops-extension-sdk', () => ({}));

const EXTENSION = { publisherId: 'OscarArguedasBarboza', extensionId: 'RestDataMappingPicklist' };
const PAGE =
  'https://dev.azure.com/contoso/_settings/OscarArguedasBarboza.RestDataMappingPicklist.rest-picklist-setup';

describe('settingsPageUrl', () => {
  it('points at the setup hub under the organization’s settings', () => {
    expect(SETTINGS_HUB_CONTRIBUTION).toBe('rest-picklist-setup');
    expect(settingsPageUrl('https://dev.azure.com/contoso/', EXTENSION)).toBe(PAGE);
  });

  it('works for older organization addresses and the development extension', () => {
    expect(
      settingsPageUrl('https://contoso.visualstudio.com/', {
        publisherId: 'OscarArguedasBarboza',
        extensionId: 'RestDataMappingPicklistDev',
      })
    ).toBe(
      'https://contoso.visualstudio.com/_settings/OscarArguedasBarboza.RestDataMappingPicklistDev.rest-picklist-setup'
    );
  });

  it('adds the slash the organization’s address should end with, and drops any query', () => {
    expect(settingsPageUrl('https://dev.azure.com/contoso', EXTENSION)).toBe(PAGE);
    expect(settingsPageUrl(' https://dev.azure.com/contoso/?a=1#top ', EXTENSION)).toBe(PAGE);
  });

  it('refuses addresses that aren’t HTTPS, and missing ids', () => {
    expect(settingsPageUrl('http://dev.azure.com/contoso/', EXTENSION)).toBeNull();
    expect(settingsPageUrl('javascript:alert(1)//', EXTENSION)).toBeNull();
    expect(settingsPageUrl('https://user:secret@dev.azure.com/contoso/', EXTENSION)).toBeNull();
    expect(settingsPageUrl('not a URL', EXTENSION)).toBeNull();
    expect(settingsPageUrl('', EXTENSION)).toBeNull();
    expect(
      settingsPageUrl('https://dev.azure.com/contoso/', { publisherId: '', extensionId: 'x' })
    ).toBeNull();
  });

  it('keeps the ids from changing the path', () => {
    expect(
      settingsPageUrl('https://dev.azure.com/contoso/', {
        publisherId: '../other',
        extensionId: 'a/b',
      })
    ).toBe('https://dev.azure.com/contoso/_settings/..%2Fother.a%2Fb.rest-picklist-setup');
  });
});

describe('openSettingsPage', () => {
  it('opens a new tab through the host’s navigation service', async () => {
    const openNewWindow = vi.fn<(url: string, features: string) => void>();
    const getService = vi.fn<(id: string) => Promise<unknown>>(async () => ({ openNewWindow }));
    const open = vi.fn<(url: string, target: string, features: string) => unknown>();
    await openSettingsPage(PAGE, { getService, open });
    expect(getService).toHaveBeenCalledWith(HOST_NAVIGATION_SERVICE_ID);
    expect(HOST_NAVIGATION_SERVICE_ID).toBe('ms.vss-features.host-navigation-service');
    expect(openNewWindow).toHaveBeenCalledWith(PAGE, '');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens it from the frame, without access back to it, when the service isn’t there', async () => {
    const open = vi.fn<(url: string, target: string, features: string) => unknown>();
    await openSettingsPage(PAGE, {
      getService: async () => {
        throw new Error('No service');
      },
      open,
    });
    expect(open).toHaveBeenCalledWith(PAGE, '_blank', 'noopener,noreferrer');

    open.mockClear();
    await openSettingsPage(PAGE, { getService: async () => ({}), open });
    expect(open).toHaveBeenCalledWith(PAGE, '_blank', 'noopener,noreferrer');
  });

  it('falls back when the service fails to open it', async () => {
    const open = vi.fn<(url: string, target: string, features: string) => unknown>();
    await openSettingsPage(PAGE, {
      getService: async () => ({
        openNewWindow: () => {
          throw new Error('Refused');
        },
      }),
      open,
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('only opens HTTPS addresses', async () => {
    const openNewWindow = vi.fn<(url: string, features: string) => void>();
    const open = vi.fn<(url: string, target: string, features: string) => unknown>();
    for (const url of ['javascript:alert(1)', 'http://dev.azure.com/contoso/', 'nonsense']) {
      await openSettingsPage(url, { getService: async () => ({ openNewWindow }), open });
    }
    expect(openNewWindow).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
