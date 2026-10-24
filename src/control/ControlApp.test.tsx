/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResponseCache } from '../core/cache';
import { PicklistError } from '../core/errors';
import type { WorkItemFieldInfo, WorkItemFormService } from '../devops/formService';
import { ControlApp, MOVED_MESSAGE } from './ControlApp';
import type { LoadedList, PicklistHost } from './controller';
import { LIMIT_MESSAGE, PicklistController } from './controller';

const FIELDS: WorkItemFieldInfo[] = [
  { referenceName: 'Custom.Customer', name: 'Customer', type: 0 },
  { referenceName: 'Custom.Customers', name: 'Customers', type: 3 },
  { referenceName: 'Custom.Priority', name: 'Priority', type: 11, isPicklist: true },
];

beforeAll(() => {
  // jsdom has neither; the control uses them for touch sizing and to resize its frame.
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
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

async function renderControl(
  inputs: Record<string, unknown>,
  values: Record<string, unknown>,
  body: unknown = { data: [{ name: 'Contoso' }, { name: 'Fabrikam' }] }
) {
  const service: WorkItemFormService = {
    getFields: async () => FIELDS,
    getFieldValue: async (field) => values[field],
    getFieldValues: async (names) => Object.fromEntries(names.map((name) => [name, values[name]])),
    setFieldValues: async (updates) =>
      Object.fromEntries(Object.keys(updates).map((name) => [name, true])),
    getAllowedFieldValues: async () => [],
    getInvalidFields: async () => [],
  };
  const controller = new PicklistController(
    {
      FieldName: 'Custom.Customer',
      RestServiceAddress: 'https://api.example.com/customers',
      PathToArray: 'data',
      RestServiceKeyField: 'name',
      LoadOnFormOpen: 'true',
      ...inputs,
    },
    { getFormService: async () => service, fetch: async () => json(body) },
    new ResponseCache<LoadedList>()
  );
  const onResize = vi.fn<(height: number) => void>();
  render(<ControlApp controller={controller} onResize={onResize} />);
  await act(async () => {
    await controller.onLoaded({ id: 1 });
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  return { controller, onResize };
}

describe('ControlApp', () => {
  it('says when the value isn’t in the list', async () => {
    const { onResize } = await renderControl({}, { 'Custom.Customer': 'Northwind' });
    expect(screen.getByText('“Northwind” isn’t in the list anymore.')).toBeTruthy();
    expect(onResize).toHaveBeenCalled();
  });

  it('lists every picked value that isn’t in the list', async () => {
    await renderControl(
      { FieldName: 'Custom.Customers', AllowMultiple: 'true' },
      { 'Custom.Customers': 'Contoso; Northwind; Wingtip' }
    );
    expect(
      screen.getByText('These values aren’t in the list anymore: “Northwind”, “Wingtip”.')
    ).toBeTruthy();
  });

  it('adds the values to a custom message', async () => {
    await renderControl(
      { FieldName: 'Custom.Customers', AllowMultiple: 'true', ErrorMessage: 'Inactive.' },
      { 'Custom.Customers': 'Northwind' }
    );
    expect(screen.getByText('Inactive. (“Northwind”)')).toBeTruthy();
  });

  it('spells out a field it can’t fill, and points a form user to an administrator', async () => {
    await renderControl({ FieldName: 'Custom.Priority' }, {});
    expect(
      screen.getByText(
        '“Priority” is a picklist. This control only fills text fields, because only process admins can add values to a picklist. Ask your Azure DevOps administrator to update this field’s settings.'
      )
    ).toBeTruthy();
  });

  it('points a form user to an administrator for a bad setting too, not just a field problem', async () => {
    await renderControl({ AdvancedSettings: '{ not json' }, {});
    // This configError doesn't make the control read-only, so it shows as the list's own alert
    // (rather than the notice under the field, as the picklist-field case above does).
    await userEvent.click(screen.getByRole('button', { name: 'Open list' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Advanced settings aren’t valid JSON.');
    expect(alert.textContent).toContain(
      'Ask your Azure DevOps administrator to update this field’s settings.'
    );
  });

  it('shows how many rows have loaded while more pages are still coming', async () => {
    let releasePageTwo: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePageTwo = resolve;
    });
    const service: WorkItemFormService = {
      getFields: async () => FIELDS,
      getFieldValue: async () => undefined,
      getFieldValues: async () => ({}),
      setFieldValues: async (updates) =>
        Object.fromEntries(Object.keys(updates).map((name) => [name, true])),
      getAllowedFieldValues: async () => [],
      getInvalidFields: async () => [],
    };
    const controller = new PicklistController(
      {
        FieldName: 'Custom.Customer',
        RestServiceAddress: 'https://api.example.com/customers',
        PathToArray: 'data',
        RestServiceKeyField: 'name',
        LoadOnFormOpen: 'true',
        AdvancedSettings: '{ "paging": { "type": "nextLink", "nextLink": "next" } }',
      },
      {
        getFormService: async () => service,
        fetch: async (input) => {
          if (typeof input === 'string' && input.includes('page=2')) {
            await gate;
            return json({ data: [{ name: 'Northwind' }] });
          }
          return json({
            data: [{ name: 'Contoso' }, { name: 'Fabrikam' }],
            next: 'https://api.example.com/customers?page=2',
          });
        },
      },
      new ResponseCache<LoadedList>()
    );
    render(<ControlApp controller={controller} onResize={() => {}} />);
    await act(async () => {
      await controller.onLoaded({ id: 1 });
      for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    await userEvent.click(screen.getByRole('button', { name: 'Open list' }));
    expect(screen.getByText('Loading more… 2 so far')).toBeTruthy();

    releasePageTwo?.();
    await act(async () => {
      for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(screen.queryByText(/Loading more…/)).toBeNull();
  });

  it('says when the list was cut short', async () => {
    await renderControl(
      {
        AdvancedSettings: '{ "paging": { "type": "nextLink", "nextLink": "next", "maxPages": 1 } }',
      },
      {},
      { data: [{ name: 'Contoso' }, { name: 'Fabrikam' }], next: '/customers?page=2' }
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open list' }));
    expect(screen.getByText('Showing the first 2 items')).toBeTruthy();
  });

  it('shows the length limit once nothing else fits', async () => {
    const long = 'x'.repeat(250);
    await renderControl(
      { AllowMultiple: 'true' },
      { 'Custom.Customer': long },
      { data: [{ name: long }, { name: 'Contoso' }] }
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open list' }));
    expect(screen.getByText(LIMIT_MESSAGE)).toBeTruthy();
  });
});

const SETTINGS_URL =
  'https://dev.azure.com/fabrikam/_settings/OscarArguedasBarboza.RestDataMappingPicklist.rest-picklist-setup';
const MOVED_TEXT =
  'API configuration has moved. You can find it under Organization settings › Extensions › REST Picklist, or click here.';

/** The text a sighted person reads: without what only screen readers hear. */
function visibleText(element: Element | null): string {
  const copy = element?.cloneNode(true);
  if (!(copy instanceof Element)) {
    return '';
  }
  for (const hidden of copy.querySelectorAll('.rp-sr-only')) {
    hidden.remove();
  }
  return copy.textContent ?? '';
}

/** A control with only the given Options, on a form where the field holds “Contoso”. */
async function renderWithHost(inputs: Record<string, unknown>, host: Partial<PicklistHost>) {
  const values: Record<string, unknown> = {
    'System.TeamProject': 'Fabrikam Fiber',
    'Custom.Customer': 'Contoso',
  };
  const service: WorkItemFormService = {
    getFields: async () => FIELDS,
    getFieldValue: async (field) => values[field],
    getFieldValues: async (names) => Object.fromEntries(names.map((name) => [name, values[name]])),
    setFieldValues: async (updates) =>
      Object.fromEntries(Object.keys(updates).map((name) => [name, true])),
    getAllowedFieldValues: async () => [],
    getInvalidFields: async () => [],
  };
  const controller = new PicklistController(
    { FieldName: 'Custom.Customer', ...inputs },
    { getFormService: async () => service, ...host },
    new ResponseCache<LoadedList>()
  );
  render(<ControlApp controller={controller} onResize={() => {}} />);
  await act(async () => {
    await controller.onLoaded({ id: 1 });
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  return controller;
}

describe('ControlApp without a configuration', () => {
  it('says where API settings are managed now, with a link to them', async () => {
    const openSettingsPage = vi.fn<(url: string) => void>();
    const fetchImpl = vi.fn<typeof fetch>();
    await renderWithHost(
      {},
      { settingsPageUrl: async () => SETTINGS_URL, openSettingsPage, fetch: fetchImpl }
    );
    // The name starts with the visible words, so speech input finds it too.
    const link = screen.getByRole('link', {
      name: 'click here to open REST Picklist settings in a new tab',
    });
    expect(link.getAttribute('href')).toBe(SETTINGS_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(visibleText(link)).toBe('click here');

    const notice = link.closest('.rp-notice');
    expect(notice).toBeTruthy();
    expect(visibleText(notice)).toBe(MOVED_TEXT);
    expect(MOVED_TEXT.startsWith(MOVED_MESSAGE)).toBe(true);
    // Information, not an error: no red, no “ask your administrator”, nothing to retry.
    expect(notice?.getAttribute('data-tone')).toBe('info');
    expect(notice?.textContent).not.toMatch(/administrator/i);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveProperty('readOnly', true);
    expect(screen.getByRole('combobox').getAttribute('aria-describedby')).toContain(
      notice?.id ?? 'missing'
    );

    // A plain click opens it through Azure DevOps instead of following the link.
    expect(fireEvent.click(link)).toBe(false);
    expect(openSettingsPage).toHaveBeenCalledWith(SETTINGS_URL);
    // Clicks with a modifier key are left to the browser.
    openSettingsPage.mockClear();
    link.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(openSettingsPage).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still says where they are when the settings page’s address isn’t known', async () => {
    await renderWithHost({}, {});
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      screen.getByText(
        'API configuration has moved. You can find it under Organization settings › Extensions › REST Picklist.'
      )
    ).toBeTruthy();
  });
});

describe('ControlApp with a configuration', () => {
  it('spells out a configuration that can’t be found, with a link to the settings', async () => {
    await renderWithHost(
      { Configuration: 'Customers' },
      {
        resolveConfiguration: async () => {
          throw new PicklistError(
            'config',
            'No configuration named “Customers” is shared with the Fabrikam Agile process. Available: “Contacts”.'
          );
        },
        settingsPageUrl: async () => SETTINGS_URL,
      }
    );
    const link = screen.getByRole('link', { name: 'Open REST Picklist settings in a new tab' });
    expect(link.getAttribute('href')).toBe(SETTINGS_URL);
    const notice = link.closest('.rp-notice');
    // An error, as in the open list and on the setup page, with the error icon (a circle).
    expect(notice?.getAttribute('data-tone')).toBe('error');
    expect(notice?.querySelector('path[d^="M7.13"]')).toBeNull();
    expect(visibleText(notice)).toBe(
      'No configuration named “Customers” is shared with the Fabrikam Agile process. Available: “Contacts”. Ask your Azure DevOps administrator to update this field’s settings. Open REST Picklist settings'
    );
    expect(screen.getByRole('combobox')).toHaveProperty('readOnly', true);
  });

  it('doesn’t ask twice for an administrator, and links from the open list too', async () => {
    await renderWithHost(
      { Configuration: 'Customers' },
      {
        resolveConfiguration: async () => ({
          id: 'customers',
          name: 'Customers',
          processId: 'agile',
          processName: 'Fabrikam Agile',
          settings: {
            RestServiceAddress: 'https://api.example.com/customers',
            AuthMethod: 'Bearer token',
          },
          secret: null,
        }),
        loadSecret: async () => null,
        settingsPageUrl: async () => SETTINGS_URL,
      }
    );
    const missing =
      'This configuration signs in, but its secret isn’t set. Ask an administrator to set it in Organization settings › Extensions › REST Picklist.';
    await userEvent.click(screen.getByRole('button', { name: 'Open list' }));
    const alert = await screen.findByRole('alert');
    expect(visibleText(alert)).toBe(`${missing} Open REST Picklist settings`);
    expect(
      within(alert).getByRole('link', { name: 'Open REST Picklist settings in a new tab' })
    ).toBeTruthy();

    // Once the list closes, the problem stays in view under the field, where Tab reaches the link.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alert')).toBeNull();
    const link = screen.getByRole('link', { name: 'Open REST Picklist settings in a new tab' });
    expect(visibleText(link.closest('.rp-notice'))).toBe(`${missing} Open REST Picklist settings`);
    await userEvent.tab();
    expect(document.activeElement).toBe(link);
  });

  it('says who can allow a host once, in the same words as the setup page', async () => {
    const hostProblem =
      'api.example.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.';
    await renderWithHost(
      { Configuration: 'Customers' },
      {
        resolveConfiguration: async () => {
          throw new PicklistError('config', hostProblem);
        },
        settingsPageUrl: async () => SETTINGS_URL,
      }
    );
    const link = screen.getByRole('link', { name: 'Open REST Picklist settings in a new tab' });
    expect(visibleText(link.closest('.rp-notice'))).toBe(
      `${hostProblem} Open REST Picklist settings`
    );
  });
});
