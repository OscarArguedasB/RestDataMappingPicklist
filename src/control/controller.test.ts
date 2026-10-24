import { afterEach, describe, expect, it, vi } from 'vitest';
import { EC_P256 } from '../core/__fixtures__/credentials';
import { ResponseCache } from '../core/cache';
import type { ConfigurationDocument } from '../core/configurations';
import { findConfigurationForProcess } from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { PicklistItem } from '../core/items';
import { sharedTokenCache } from '../core/oauth';
import type { SecurityPolicy } from '../core/policy';
import { DEFAULT_POLICY } from '../core/policy';
import type { SecretDocument, StoredSecret } from '../core/secrets';
import type { WorkItemFieldInfo, WorkItemFormService } from '../devops/formService';
import type { LoadedList, PicklistHost } from './controller';
import { PicklistController } from './controller';

// Types as the work item form service reports them (FieldType numbers).
const FIELDS: WorkItemFieldInfo[] = [
  { referenceName: 'System.TeamProject', name: 'Team Project', type: 0 },
  { referenceName: 'Custom.Customer', name: 'Customer', type: 0 },
  { referenceName: 'Custom.Customers', name: 'Customers', type: 3 },
  { referenceName: 'Custom.Notes', name: 'Notes', type: 4 },
  { referenceName: 'Custom.Priority', name: 'Priority', type: 11, isPicklist: true },
  { referenceName: 'Custom.Count', name: 'Count', type: 1 },
  { referenceName: 'Custom.CustomerId', name: 'Customer ID', type: 0 },
  { referenceName: 'Custom.Region', name: 'Region', type: 0 },
  { referenceName: 'Custom.Contacts', name: 'Contacts', type: 4 },
];

const CUSTOMERS = {
  data: [
    { name: 'Contoso', id: 1, region: 'EU' },
    { name: 'Fabrikam', id: 2, region: 'US' },
    { name: 'Fabrikam', id: 3, region: 'APAC' },
    { name: 'Tailspin <Toys> & Co', id: 4, region: 'EU' },
    { name: 'Alpha;Beta', id: 5, region: 'US' },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createForm(
  values: Record<string, unknown>,
  required: string[] = [],
  fields: WorkItemFieldInfo[] = FIELDS
) {
  const current = { ...values };
  let saved = { ...values };
  const setFieldValues = vi.fn<WorkItemFormService['setFieldValues']>(async (updates) => {
    Object.assign(current, updates);
    return Object.fromEntries(Object.keys(updates).map((field) => [field, true]));
  });
  const getFields = vi.fn<WorkItemFormService['getFields']>(async () => fields);
  const service: WorkItemFormService = {
    getFields,
    getFieldValue: async (field, options) =>
      options?.returnOriginalValue ? saved[field] : current[field],
    getFieldValues: async (names) => Object.fromEntries(names.map((name) => [name, current[name]])),
    setFieldValues,
    getAllowedFieldValues: async () => ['Low', 'High'],
    getInvalidFields: async () =>
      required
        .filter((field) => !current[field])
        .map((field) => ({ referenceName: field, name: field })),
  };
  return {
    service,
    current,
    setFieldValues,
    getFields,
    save: () => {
      saved = { ...current };
    },
  };
}

interface SetupOptions {
  values?: Record<string, unknown>;
  required?: string[];
  host?: Partial<PicklistHost>;
  fetchImpl?: ReturnType<typeof vi.fn<typeof fetch>>;
  cache?: ResponseCache<LoadedList>;
}

function setup(inputs: Record<string, unknown>, options: SetupOptions = {}) {
  const form = createForm(
    { 'System.TeamProject': 'Fabrikam Fiber', 'Custom.Customer': '', ...options.values },
    options.required
  );
  const fetchImpl = options.fetchImpl ?? vi.fn<typeof fetch>(async () => json(CUSTOMERS));
  const host: PicklistHost = {
    getFormService: async () => form.service,
    fetch: fetchImpl,
    ...options.host,
  };
  const controller = new PicklistController(
    {
      FieldName: 'Custom.Customer',
      RestServiceAddress: 'https://api.example.com/customers',
      PathToArray: 'data',
      RestServiceKeyField: 'name',
      ...inputs,
    },
    host,
    options.cache ?? new ResponseCache<LoadedList>()
  );
  return { controller, form, fetchImpl, host };
}

function requestedUrl(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call: number): string {
  const input = fetchImpl.mock.calls[call]?.[0];
  return typeof input === 'string' ? input : '';
}

function requestHeaders(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call: number) {
  return fetchImpl.mock.calls[call]?.[1]?.headers;
}

/** Lets pending promises run, including response bodies that finish on a later tick. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (let tick = 0; tick < 50; tick += 1) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function loaded(inputs: Record<string, unknown>, options: SetupOptions = {}) {
  const context = setup({ LoadOnFormOpen: 'true', ...inputs }, options);
  await context.controller.onLoaded({ id: 1 });
  await settle();
  return context;
}

function item(controller: PicklistController, value: string, detail?: string): PicklistItem {
  const found = controller
    .getSnapshot()
    .items?.find(
      (entry) => entry.value === value && (detail === undefined || entry.detail === detail)
    );
  if (!found) {
    throw new Error(`No item ${value} ${detail ?? ''}`);
  }
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  // Tokens live in memory for the whole page; every test starts without one.
  sharedTokenCache.clear();
});

describe('loading', () => {
  it('waits for the list to be opened when preloading is off', async () => {
    const loadPolicy = vi.fn<() => Promise<SecurityPolicy>>(async () => DEFAULT_POLICY);
    const { controller, fetchImpl } = setup(
      {},
      { values: { 'Custom.Customer': 'Contoso' }, host: { loadPolicy } }
    );
    await controller.onLoaded({ id: 1 });
    expect(controller.getSnapshot()).toMatchObject({
      selected: ['Contoso'],
      items: null,
      ready: true,
      fieldLabel: 'Customer',
    });
    // Opening a work item costs no requests.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadPolicy).not.toHaveBeenCalled();

    controller.setListOpen(true);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(loadPolicy).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual([
      'Alpha;Beta',
      'Contoso',
      'Fabrikam',
      'Tailspin <Toys> & Co',
    ]);
  });

  it('loads as soon as the form opens when preloading is on', async () => {
    const { controller, fetchImpl } = await loaded({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      loadingMore: false,
      truncated: false,
      loadedCount: 5,
    });
  });

  it('keeps items with the same value apart by their second line', async () => {
    const { controller } = await loaded({ SecondLineProperty: 'region' });
    expect(
      controller
        .getSnapshot()
        .items?.filter((entry) => entry.value === 'Fabrikam')
        .map((entry) => entry.detail)
    ).toEqual(['APAC', 'US']);
  });

  it('reloads the list when a field used in the request changes', async () => {
    const { controller, form, fetchImpl } = await loaded(
      { RestCallParameters: '{ "region": "$(Custom.Region)" }' },
      { values: { 'Custom.Region': 'EU' } }
    );
    form.current['Custom.Region'] = 'US';
    controller.onFieldChanged({ id: 1, changedFields: { 'Custom.Region': 'US' } });
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requestedUrl(fetchImpl, 0)).toContain('region=EU');
    expect(requestedUrl(fetchImpl, 1)).toContain('region=US');
  });

  it('shows a readable error and recovers on retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(CUSTOMERS));
    fetchImpl.mockImplementationOnce(async () => new Response('', { status: 500 }));
    const { controller } = await loaded({}, { fetchImpl });
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', configError: null });
    expect(controller.getSnapshot().error).toMatch(/500/);
    controller.retry();
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ status: 'loaded', error: null });
  });

  it('uses the process allowed values when a saved configuration has no endpoint', async () => {
    const { controller } = await loaded(
      { RestServiceAddress: '', SavedConfiguration: 'Priorities' },
      {
        host: {
          resolveSavedInputs: async () => ({ PathToArray: 'data' }),
          loadPolicy: async () => DEFAULT_POLICY,
        },
      }
    );
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['High', 'Low']);
  });

  it('signs in with the configured method', async () => {
    const { fetchImpl } = await loaded({
      AuthMethod: 'API key',
      RestServicePassword: 'key-123',
      AdvancedSettings: '{ "apiKeyHeader": "X-Api-Token" }',
    });
    expect(requestHeaders(fetchImpl, 0)).toMatchObject({ 'X-Api-Token': 'key-123' });
  });
});

describe('paging', () => {
  const PAGE_ONE = {
    data: [{ name: 'Contoso' }, { name: 'Fabrikam' }],
    next: 'https://api.example.com/customers?page=2',
  };
  const PAGE_TWO = { data: [{ name: 'Northwind' }] };

  it('shows the first page at once and the rest as it arrives', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (typeof input === 'string' && input.includes('page=2')) {
        await gate;
        return json(PAGE_TWO);
      }
      return json(PAGE_ONE);
    });
    const { controller } = await loaded(
      { AdvancedSettings: '{ "paging": { "type": "nextLink", "nextLink": "next" } }' },
      { fetchImpl }
    );
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      loadingMore: true,
      loadedCount: 2,
    });
    expect(controller.getSnapshot().items).toHaveLength(2);

    release?.();
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      loadingMore: false,
      loadedCount: 3,
      truncated: false,
    });
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual([
      'Contoso',
      'Fabrikam',
      'Northwind',
    ]);
  });

  it('reports a list cut short by the page limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(PAGE_ONE));
    const { controller } = await loaded(
      {
        AdvancedSettings: '{ "paging": { "type": "nextLink", "nextLink": "next", "maxPages": 1 } }',
      },
      { fetchImpl }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ truncated: true, loadedCount: 2 });
  });

  it('applies the policy’s item limit', async () => {
    const { controller } = await loaded(
      {},
      { host: { loadPolicy: async () => ({ ...DEFAULT_POLICY, maxItems: 1 }) } }
    );
    expect(controller.getSnapshot()).toMatchObject({ truncated: true, loadedCount: 1 });
  });

  it('keeps lists with different paging apart in the cache', async () => {
    const cache = new ResponseCache<LoadedList>();
    const fetchImpl = vi.fn<typeof fetch>(async () => json(PAGE_ONE));
    await loaded({}, { fetchImpl, cache });
    await loaded({}, { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await loaded(
      {
        AdvancedSettings: '{ "paging": { "type": "nextLink", "nextLink": "next", "maxPages": 1 } }',
      },
      { fetchImpl, cache }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sorts whatever streamed in before a later page fails, instead of leaving it jumbled', async () => {
    const UNSORTED_PAGE_ONE = {
      data: [{ name: 'Zeta' }, { name: 'Alpha' }],
      next: 'https://api.example.com/customers?page=2',
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (typeof input === 'string' && input.includes('page=2')) {
        return new Response('', { status: 500 });
      }
      return json(UNSORTED_PAGE_ONE);
    });
    const { controller } = await loaded(
      { AdvancedSettings: '{ "paging": { "type": "nextLink", "nextLink": "next" } }' },
      { fetchImpl }
    );
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', loadingMore: false });
    expect(controller.getSnapshot().error).toMatch(/500/);
    // The page that did load is still shown, sorted as the finished list would be.
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('single value', () => {
  it('writes the value and the picked row’s mapped fields, then tracks saving', async () => {
    const { controller, form } = await loaded({
      FieldMap: '{ "Custom.CustomerId": "id", "Custom.Region": "region" }',
      SecondLineProperty: 'region',
    });
    await controller.select(item(controller, 'Fabrikam', 'APAC'));
    expect(form.setFieldValues).toHaveBeenCalledWith({
      'Custom.Customer': 'Fabrikam',
      'Custom.CustomerId': 3,
      'Custom.Region': 'APAC',
    });
    const unsaved = controller.getSnapshot();
    expect(unsaved.selected).toEqual(['Fabrikam']);
    expect(unsaved.savedSelected).toEqual([]);

    form.save();
    await controller.onSaved();
    expect(controller.getSnapshot().savedSelected).toEqual(['Fabrikam']);
  });

  it('remembers which row was picked, so a later duplicate value picks it out again', async () => {
    const { controller } = await loaded({ SecondLineProperty: 'region' });
    await controller.select(item(controller, 'Fabrikam', 'APAC'));
    expect(controller.getSnapshot().pickedKeys).toEqual([item(controller, 'Fabrikam', 'APAC').key]);

    await controller.select(item(controller, 'Fabrikam', 'US'));
    expect(controller.getSnapshot().pickedKeys).toEqual([item(controller, 'Fabrikam', 'US').key]);
  });

  it('clears its own field and the fields filled from it', async () => {
    const { controller, form } = await loaded(
      { FieldMap: '{ "Custom.CustomerId": "id" }' },
      { values: { 'Custom.Customer': 'Contoso', 'Custom.CustomerId': '1' } }
    );
    await controller.clear();
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customer': '',
      'Custom.CustomerId': '',
    });
    expect(controller.getSnapshot().selected).toEqual([]);
  });

  it('refuses values longer than a single-line field holds', async () => {
    const long = 'x'.repeat(256);
    const { controller, form } = await loaded(
      {},
      { fetchImpl: vi.fn<typeof fetch>(async () => json({ data: [{ name: long }] })) }
    );
    await controller.select(item(controller, long));
    expect(form.setFieldValues).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toMatch(/longer than the 255 characters/);
  });

  it('reports fields the work item rules consider invalid', async () => {
    const { controller } = setup({}, { required: ['Custom.Customer'] });
    await controller.onLoaded({ id: 1 });
    expect(controller.getSnapshot().ruleInvalid).toBe(true);
  });

  it('respects read-only work items', async () => {
    const { controller, form } = setup({});
    await controller.onLoaded({ id: 1, isReadOnly: true });
    await controller.select({ key: 'Contoso', value: 'Contoso' });
    await controller.clear();
    expect(form.setFieldValues).not.toHaveBeenCalled();
  });
});

describe('multiple values', () => {
  const MULTI = { FieldName: 'Custom.Customers', AllowMultiple: 'true' };

  it('reads, adds, removes and clears values', async () => {
    const { controller, form } = await loaded(MULTI, {
      values: { 'Custom.Customers': 'Contoso;  Fabrikam ; Contoso' },
    });
    expect(controller.getSnapshot()).toMatchObject({
      multiple: true,
      selected: ['Contoso', 'Fabrikam'],
    });

    await controller.select(item(controller, 'Tailspin <Toys> & Co'));
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': 'Contoso; Fabrikam; Tailspin <Toys> & Co',
    });
    await controller.remove('Contoso');
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': 'Fabrikam; Tailspin <Toys> & Co',
    });
    expect(controller.getSnapshot().selected).toEqual(['Fabrikam', 'Tailspin <Toys> & Co']);
    await controller.clear();
    expect(form.setFieldValues).toHaveBeenLastCalledWith({ 'Custom.Customers': '' });
  });

  it('ignores values already picked', async () => {
    const { controller, form } = await loaded(MULTI, {
      values: { 'Custom.Customers': 'Contoso' },
    });
    await controller.add(item(controller, 'Contoso'));
    await controller.remove('Northwind');
    expect(form.setFieldValues).not.toHaveBeenCalled();
  });

  it('does nothing when the row already picked for a value is added again', async () => {
    const { controller, form } = await loaded({ ...MULTI, SecondLineProperty: 'region' });
    await controller.add(item(controller, 'Fabrikam', 'APAC'));
    form.setFieldValues.mockClear();
    await controller.add(item(controller, 'Fabrikam', 'APAC'));
    expect(form.setFieldValues).not.toHaveBeenCalled();
  });

  it('switches to a different row for a value that’s already picked, and updates mapped fields', async () => {
    const { controller, form } = await loaded({
      ...MULTI,
      SecondLineProperty: 'region',
      FieldMap: '{ "Custom.Region": "region" }',
    });
    await controller.add(item(controller, 'Fabrikam', 'APAC'));
    expect(controller.getSnapshot().pickedKeys).toContain(item(controller, 'Fabrikam', 'APAC').key);

    await controller.add(item(controller, 'Fabrikam', 'US'));
    // Still one value — the row behind it changed, not the field itself.
    expect(controller.getSnapshot().selected).toEqual(['Fabrikam']);
    expect(controller.getSnapshot().pickedKeys).toEqual([item(controller, 'Fabrikam', 'US').key]);
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': 'Fabrikam',
      'Custom.Region': 'US',
    });
  });

  it('refuses values containing a semicolon', async () => {
    const { controller, form } = await loaded(MULTI);
    await controller.select(item(controller, 'Alpha;Beta'));
    expect(form.setFieldValues).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toBe(
      '“Alpha;Beta” contains a semicolon, which separates the values in this field, so it can’t be added.'
    );
    controller.setListOpen(false);
    expect(controller.getSnapshot().notice).toBeNull();
  });

  it('stops at 255 characters in a single-line text field', async () => {
    const [a, b, c, d] = ['a'.repeat(120), 'b'.repeat(120), 'c'.repeat(10), 'd'.repeat(20)];
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ data: [a, b, c, d].map((name) => ({ name })) })
    );
    const { controller, form } = await loaded(
      { ...MULTI, FieldName: 'Custom.Customer' },
      { fetchImpl, values: { 'Custom.Customer': `${a}; ${b}` } }
    );
    // 242 characters used: the 10-character value still fits.
    expect(controller.getSnapshot().limitReached).toBe(false);

    await controller.add(item(controller, d));
    expect(form.setFieldValues).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toMatch(/doesn’t fit: this field holds up to 255/);

    await controller.add(item(controller, c));
    expect(form.setFieldValues).toHaveBeenCalledWith({ 'Custom.Customer': `${a}; ${b}; ${c}` });
    expect(controller.getSnapshot()).toMatchObject({ limitReached: true, notice: null });

    await controller.remove(a);
    expect(controller.getSnapshot().limitReached).toBe(false);
  });

  it('has no length limit in a multi-line text field', async () => {
    const long = 'x'.repeat(300);
    const { controller, form } = await loaded(MULTI, {
      fetchImpl: vi.fn<typeof fetch>(async () => json({ data: [{ name: long }] })),
    });
    await controller.add(item(controller, long));
    expect(form.setFieldValues).toHaveBeenCalledWith({ 'Custom.Customers': long });
    expect(controller.getSnapshot().limitReached).toBe(false);
  });

  it('copies every picked row’s values, from the row that was picked', async () => {
    const { controller, form } = await loaded({
      ...MULTI,
      SecondLineProperty: 'region',
      FieldMap: '{ "Custom.CustomerId": "id", "Custom.Region": "region" }',
    });
    await controller.add(item(controller, 'Contoso'));
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': 'Contoso',
      'Custom.CustomerId': '1',
      'Custom.Region': 'EU',
    });
    await controller.add(item(controller, 'Fabrikam', 'US'));
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': 'Contoso; Fabrikam',
      'Custom.CustomerId': '1; 2',
      'Custom.Region': 'EU; US',
    });
    await controller.remove('Contoso');
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': 'Fabrikam',
      'Custom.CustomerId': '2',
      'Custom.Region': 'US',
    });
    await controller.remove('Fabrikam');
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': '',
      'Custom.CustomerId': '',
      'Custom.Region': '',
    });
  });

  it('copies only the first picked row’s values when set to', async () => {
    const { controller, form } = await loaded(
      {
        ...MULTI,
        SecondLineProperty: 'region',
        FieldMap: '{ "Custom.CustomerId": "id" }',
        AdvancedSettings: '{ "copyMode": "first" }',
      },
      // Picked before this session: the first row with that value is used.
      { values: { 'Custom.Customers': 'Fabrikam' } }
    );
    await controller.add(item(controller, 'Contoso'));
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customers': 'Fabrikam; Contoso',
      'Custom.CustomerId': '3',
    });
  });

  it('leaves mapped fields alone while the list isn’t loaded', async () => {
    const { controller, form } = setup(
      { ...MULTI, FieldMap: '{ "Custom.CustomerId": "id" }' },
      { values: { 'Custom.Customers': 'Contoso; Fabrikam', 'Custom.CustomerId': '1; 2' } }
    );
    await controller.onLoaded({ id: 1 });
    await controller.remove('Fabrikam');
    expect(form.setFieldValues).toHaveBeenCalledWith({ 'Custom.Customers': 'Contoso' });
  });
});

describe('HTML fields', () => {
  it('reads plain text and writes escaped text', async () => {
    const { controller, form } = await loaded(
      { FieldName: 'Custom.Notes' },
      { values: { 'Custom.Notes': '<div>Tailspin &lt;Toys&gt; &amp; Co</div>' } }
    );
    expect(controller.getSnapshot().selected).toEqual(['Tailspin <Toys> & Co']);
    await controller.select(item(controller, 'Tailspin <Toys> & Co'));
    expect(form.setFieldValues).toHaveBeenCalledWith({
      'Custom.Notes': 'Tailspin &lt;Toys&gt; &amp; Co',
    });
  });

  it('escapes multiple values too', async () => {
    const { controller, form } = await loaded(
      { FieldName: 'Custom.Notes', AllowMultiple: 'true' },
      { values: { 'Custom.Notes': '<p>Contoso;&nbsp;Fabrikam</p>' } }
    );
    expect(controller.getSnapshot().selected).toEqual(['Contoso', 'Fabrikam']);
    await controller.add(item(controller, 'Tailspin <Toys> & Co'));
    expect(form.setFieldValues).toHaveBeenCalledWith({
      'Custom.Notes': 'Contoso; Fabrikam; Tailspin &lt;Toys&gt; &amp; Co',
    });
  });

  it('escapes values copied into HTML fields', async () => {
    const { controller, form } = await loaded({
      FieldMap: '{ "Custom.Contacts": "name", "Custom.CustomerId": "id" }',
    });
    await controller.select(item(controller, 'Tailspin <Toys> & Co'));
    expect(form.setFieldValues).toHaveBeenCalledWith({
      'Custom.Customer': 'Tailspin <Toys> & Co',
      'Custom.Contacts': 'Tailspin &lt;Toys&gt; &amp; Co',
      'Custom.CustomerId': 4,
    });
  });
});

describe('field checks', () => {
  it('refuses picklist fields without loading anything', async () => {
    const { controller, form, fetchImpl } = setup({
      FieldName: 'Custom.Priority',
      LoadOnFormOpen: 'true',
    });
    await controller.onLoaded({ id: 1 });
    controller.setListOpen(true);
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      readOnly: true,
      configError:
        '“Priority” is a picklist. This control only fills text fields, because only process admins can add values to a picklist.',
    });
    await controller.select({ key: 'Low', value: 'Low' });
    controller.retry();
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(form.setFieldValues).not.toHaveBeenCalled();
  });

  it('needs a text field for multiple values', async () => {
    const { controller } = setup({ FieldName: 'Custom.Count', AllowMultiple: 'true' });
    await controller.onLoaded({ id: 1 });
    expect(controller.getSnapshot().configError).toMatch(
      /“Count” isn’t a text field, so it can’t hold multiple values/
    );
  });

  it('reports a field that isn’t on the work item type', async () => {
    const { controller } = setup({ FieldName: 'Custom.Missing' });
    await controller.onLoaded({ id: 1 });
    expect(controller.getSnapshot().configError).toMatch(
      /“Custom.Missing” isn’t a field of this work item type/
    );
  });

  it('reads the field list only once', async () => {
    const { controller, form } = await loaded({});
    await controller.onLoaded({ id: 2 });
    await settle();
    await controller.select(item(controller, 'Contoso'));
    expect(form.getFields).toHaveBeenCalledTimes(1);
  });
});

describe('saved configurations', () => {
  const SAVED = {
    RestServiceAddress: 'https://saved.example.com/customers',
    RestCallParameters: '{ "region": "$(Custom.Region)" }',
    AuthMethod: 'Bearer token',
    PathToArray: 'result',
    RestServiceKeyField: 'name',
    FieldMap: '{ "Custom.CustomerId": "id" }',
    ErrorMessage: 'This customer is no longer active.',
  };
  const USES_SAVED = {
    SavedConfiguration: 'Customers',
    RestServiceAddress: '',
    RestServiceKeyField: '',
    RestServicePassword: 'own-token',
    SecondLineProperty: 'region',
  };

  function savedHost(resolve: PicklistHost['resolveSavedInputs'] = async () => SAVED) {
    const resolveSavedInputs = vi.fn<NonNullable<PicklistHost['resolveSavedInputs']>>(resolve);
    return { resolveSavedInputs, loadPolicy: async () => DEFAULT_POLICY };
  }

  it('merges the saved settings when the list is first loaded', async () => {
    const host = savedHost();
    const { controller, fetchImpl, form } = setup(USES_SAVED, {
      host,
      values: { 'Custom.Region': 'EU' },
    });
    await controller.onLoaded({ id: 1 });
    expect(host.resolveSavedInputs).not.toHaveBeenCalled();

    controller.setListOpen(true);
    await settle();
    expect(host.resolveSavedInputs).toHaveBeenCalledWith('Customers', 'Fabrikam Fiber');
    // The saved endpoint and its field dependency, with this control's own path and password.
    expect(requestedUrl(fetchImpl, 0)).toBe('https://saved.example.com/customers?region=EU');
    expect(requestHeaders(fetchImpl, 0)).toMatchObject({ Authorization: 'Bearer own-token' });
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      notFoundMessage: 'This customer is no longer active.',
    });
    expect(controller.getSnapshot().items?.some((entry) => entry.detail === 'APAC')).toBe(true);

    await controller.select(item(controller, 'Contoso'));
    expect(form.setFieldValues).toHaveBeenCalledWith({
      'Custom.Customer': 'Contoso',
      'Custom.CustomerId': 1,
    });

    form.current['Custom.Region'] = 'US';
    controller.onFieldChanged({ id: 1, changedFields: { 'Custom.Region': 'US' } });
    await settle();
    expect(requestedUrl(fetchImpl, 1)).toBe('https://saved.example.com/customers?region=US');
    expect(host.resolveSavedInputs).toHaveBeenCalledTimes(1);
  });

  it('empties the saved configuration’s mapped fields when cleared before the list loads', async () => {
    const host = savedHost();
    const { controller, fetchImpl, form } = setup(USES_SAVED, {
      host,
      values: { 'Custom.Customer': 'Contoso', 'Custom.CustomerId': '1' },
    });
    await controller.onLoaded({ id: 1 });
    await controller.clear();
    expect(host.resolveSavedInputs).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(form.setFieldValues).toHaveBeenLastCalledWith({
      'Custom.Customer': '',
      'Custom.CustomerId': '',
    });
  });

  it('reports a missing saved configuration as a setup problem', async () => {
    const host = savedHost(async () => {
      throw new PicklistError(
        'config',
        'No saved configuration named “Customers” in this process.'
      );
    });
    const { controller, fetchImpl } = await loaded(USES_SAVED, { host });
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: null,
      configError: 'No saved configuration named “Customers” in this process.',
    });
    controller.retry();
    await settle();
    expect(host.resolveSavedInputs).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets people retry when Azure DevOps can’t be reached', async () => {
    const host = savedHost();
    host.resolveSavedInputs.mockRejectedValueOnce(
      new PicklistError(
        'network',
        'Couldn’t reach Azure DevOps. Check your connection and try again.'
      )
    );
    const { controller } = await loaded(USES_SAVED, { host });
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError: null,
      error: 'Couldn’t reach Azure DevOps. Check your connection and try again.',
    });
    controller.retry();
    await settle();
    expect(host.resolveSavedInputs).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().status).toBe('loaded');
  });

  it('follows the policy on saved configurations', async () => {
    const host = {
      ...savedHost(),
      loadPolicy: async () => ({ ...DEFAULT_POLICY, allowSavedConfigurations: false }),
    };
    const { controller, fetchImpl } = await loaded(USES_SAVED, { host });
    expect(controller.getSnapshot().configError).toMatch(
      /security policy doesn’t allow saved configurations, so “Customers” can’t be used/
    );
    expect(host.resolveSavedInputs).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('needs a host that can look them up', async () => {
    const { controller } = await loaded(USES_SAVED);
    expect(controller.getSnapshot().configError).toMatch(/aren’t available here/);
  });

  it('looks them up again after the work item is refreshed', async () => {
    const host = savedHost();
    const { controller } = await loaded(USES_SAVED, { host });
    await controller.onRefreshed();
    await settle();
    expect(host.resolveSavedInputs).toHaveBeenCalledTimes(2);
  });
});

describe('security policy', () => {
  it('blocks hosts the organization doesn’t allow', async () => {
    const { controller, fetchImpl } = await loaded(
      {},
      {
        host: {
          loadPolicy: async () => ({ ...DEFAULT_POLICY, allowedHosts: ['api.contoso.com'] }),
        },
      }
    );
    expect(controller.getSnapshot().configError).toBe(
      'api.example.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks sign-in methods the organization doesn’t allow', async () => {
    const { controller, fetchImpl } = await loaded(
      { AuthMethod: 'Bearer token', RestServicePassword: 'token' },
      { host: { loadPolicy: async () => ({ ...DEFAULT_POLICY, allowedAuthMethods: ['none'] }) } }
    );
    expect(controller.getSnapshot().configError).toMatch(
      /doesn’t allow the “Bearer token” sign-in method/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the built-in rules when the policy can’t be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { controller } = await loaded(
      {},
      {
        host: {
          loadPolicy: async () => {
            throw new Error('offline');
          },
        },
      }
    );
    expect(controller.getSnapshot().status).toBe('loaded');
    expect(warn).toHaveBeenCalled();
  });

  it('reports settings that can’t be used', async () => {
    const { controller, fetchImpl } = await loaded({ FieldMap: '{ nope' });
    expect(controller.getSnapshot().configError).toMatch(/field map isn’t valid JSON/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- 4.0: configurations from Organization settings › Extensions › REST Picklist ----

const AGILE = { id: 'e31fd6e1-c6af-44bb-925e-dfa71f551463', name: 'Fabrikam Agile' };
const SCRUM_ID = '6b724908-ef14-45cf-84f8-768b5384da45';
const CONFIGURATION_ID = '6f1c0f3e-3f0b-4c55-9a43-0d3a6c1e9b21';
const SETTINGS_URL =
  'https://dev.azure.com/fabrikam/_settings/OscarArguedasBarboza.RestDataMappingPicklist.rest-picklist-setup';
const API_ORIGIN = 'https://api.example.com';
const API_KEY = 'key-123-from-the-secret';
const SETTINGS = {
  RestServiceAddress: `${API_ORIGIN}/customers`,
  PathToArray: 'data',
  RestServiceKeyField: 'name',
};
const MISSING_SECRET =
  'This configuration signs in, but its secret isn’t set. Ask an administrator to set it in Organization settings › Extensions › REST Picklist.';

function configurationDoc(fields: Partial<ConfigurationDocument> = {}): ConfigurationDocument {
  return {
    id: CONFIGURATION_ID,
    version: 1,
    name: 'Customers',
    aliases: [],
    processIds: [AGILE.id],
    settings: SETTINGS,
    secret: null,
    ...fields,
  };
}

function secretDoc(secret: StoredSecret, boundOrigin = API_ORIGIN): SecretDocument {
  return { id: CONFIGURATION_ID, version: 1, secret, boundOrigin };
}

interface ConfiguredOptions {
  docs?: ConfigurationDocument[];
  secret?: SecretDocument | null;
  inputs?: Record<string, unknown>;
  values?: Record<string, unknown>;
  fetchImpl?: ReturnType<typeof vi.fn<typeof fetch>>;
  policy?: SecurityPolicy;
}

/** A control that names a configuration, with a host that finds it the way the store does. */
function configured(options: ConfiguredOptions = {}) {
  const docs = options.docs ?? [configurationDoc()];
  const form = createForm({
    'System.TeamProject': 'Fabrikam Fiber',
    'Custom.Customer': '',
    ...options.values,
  });
  const fetchImpl = options.fetchImpl ?? vi.fn<typeof fetch>(async () => json(CUSTOMERS));
  const resolveConfiguration = vi.fn<NonNullable<PicklistHost['resolveConfiguration']>>(
    async (name) => {
      // Every project here uses Fabrikam Agile.
      const doc = findConfigurationForProcess(docs, AGILE.id, AGILE.name, name);
      return {
        id: doc.id,
        name: doc.name,
        processId: AGILE.id,
        processName: AGILE.name,
        settings: { ...doc.settings },
        secret: doc.secret,
      };
    }
  );
  const loadSecret = vi.fn<NonNullable<PicklistHost['loadSecret']>>(
    async () => options.secret ?? null
  );
  const loadPolicy = vi.fn<() => Promise<SecurityPolicy>>(
    async () => options.policy ?? DEFAULT_POLICY
  );
  const settingsPageUrl = vi.fn<NonNullable<PicklistHost['settingsPageUrl']>>(
    async () => SETTINGS_URL
  );
  const openSettingsPage = vi.fn<NonNullable<PicklistHost['openSettingsPage']>>();
  const host: PicklistHost = {
    getFormService: async () => form.service,
    fetch: fetchImpl,
    resolveConfiguration,
    loadSecret,
    loadPolicy,
    settingsPageUrl,
    openSettingsPage,
  };
  const controller = new PicklistController(
    { FieldName: 'Custom.Customer', Configuration: 'Customers', ...options.inputs },
    host,
    new ResponseCache<LoadedList>()
  );
  return {
    controller,
    form,
    fetchImpl,
    resolveConfiguration,
    loadSecret,
    loadPolicy,
    settingsPageUrl,
    openSettingsPage,
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/** A request's form-encoded body. */
function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

/** Opens the work item and the list, then waits for the list or its error. */
async function opened(context: ReturnType<typeof configured>): Promise<void> {
  await context.controller.onLoaded({ id: 1 });
  context.controller.setListOpen(true);
  await vi.waitFor(() =>
    expect(['loaded', 'error']).toContain(context.controller.getSnapshot().status)
  );
}

describe('configurations', () => {
  it('finds the configuration when the work item opens, and reads its secret when the list loads', async () => {
    const context = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'API key' } })],
      secret: secretDoc({ kind: 'apiKey', value: API_KEY }),
    });
    const { controller, fetchImpl, resolveConfiguration, loadSecret, loadPolicy } = context;
    await controller.onLoaded({ id: 1 });
    expect(resolveConfiguration).toHaveBeenCalledWith('Customers', 'Fabrikam Fiber');
    expect(controller.getSnapshot()).toMatchObject({
      ready: true,
      status: 'idle',
      readOnly: false,
      configError: null,
      moved: false,
    });
    // Opening a work item calls no API and reads no secret.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadSecret).not.toHaveBeenCalled();
    expect(loadPolicy).not.toHaveBeenCalled();

    controller.setListOpen(true);
    await settle();
    expect(loadSecret).toHaveBeenCalledWith(CONFIGURATION_ID);
    expect(requestedUrl(fetchImpl, 0)).toBe('https://api.example.com/customers');
    expect(requestHeaders(fetchImpl, 0)).toMatchObject({ 'x-api-key': API_KEY });
    expect(controller.getSnapshot().status).toBe('loaded');
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toContain('Contoso');
    expect(resolveConfiguration).toHaveBeenCalledTimes(1);
  });

  it('never falls back to the built-in rules when the policy can’t be read, and tries again', async () => {
    // The policy guards where a configuration's secret may go, so it must be read first.
    const context = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'API key' } })],
      secret: secretDoc({ kind: 'apiKey', value: API_KEY }),
    });
    const { controller, fetchImpl, loadSecret, loadPolicy } = context;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadPolicy.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    await opened(context);
    expect(loadPolicy).toHaveBeenCalledWith({ strict: true });
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'The organization’s security policy couldn’t be read. Try again.',
      configError: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('429');

    controller.retry();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('loaded'));
    expect(requestHeaders(fetchImpl, 0)).toMatchObject({ 'x-api-key': API_KEY });
    expect(loadSecret).toHaveBeenCalledTimes(1);
  });

  it('ignores settings and passwords the control still keeps on its own Options', async () => {
    const { controller, fetchImpl } = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'Bearer token' } })],
      secret: secretDoc({ kind: 'token', value: 'token-from-the-secret' }),
      inputs: {
        RestServiceAddress: 'https://old.example.com/customers',
        AuthMethod: 'Basic',
        RestServiceUserName: 'old-user',
        RestServicePassword: 'old-inline-password',
        AllowMultiple: 'true',
        LoadOnFormOpen: 'true',
      },
    });
    await controller.onLoaded({ id: 1 });
    // Only the configuration says when to load.
    expect(fetchImpl).not.toHaveBeenCalled();
    controller.setListOpen(true);
    await settle();
    expect(requestedUrl(fetchImpl, 0)).toBe('https://api.example.com/customers');
    expect(requestHeaders(fetchImpl, 0)).toMatchObject({
      Authorization: 'Bearer token-from-the-secret',
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('old-inline-password');
    expect(controller.getSnapshot().multiple).toBe(false);
  });

  it('takes how the field behaves from the configuration', async () => {
    const { controller, fetchImpl } = configured({
      docs: [
        configurationDoc({
          settings: {
            ...SETTINGS,
            AllowMultiple: 'true',
            Required: 'true',
            LoadOnFormOpen: 'true',
            ErrorMessage: 'This customer is no longer active.',
          },
        }),
      ],
      inputs: { FieldName: 'Custom.Customers' },
      values: { 'Custom.Customers': 'Contoso; Northwind' },
    });
    await controller.onLoaded({ id: 1 });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      multiple: true,
      required: true,
      selected: ['Contoso', 'Northwind'],
      notFoundMessage: 'This customer is no longer active.',
      status: 'loaded',
    });
    // Loaded with the form, as the configuration says.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('finds a configuration by a former name', async () => {
    const { controller, fetchImpl } = configured({
      docs: [configurationDoc({ name: 'Customers API', aliases: ['Customers'] })],
    });
    await controller.onLoaded({ id: 1 });
    controller.setListOpen(true);
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ status: 'loaded', configError: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('explains a configuration that isn’t shared with the process, and links to the settings', async () => {
    const context = configured({ docs: [configurationDoc({ processIds: [SCRUM_ID] })] });
    const { controller, form, fetchImpl, loadSecret, loadPolicy } = context;
    await controller.onLoaded({ id: 1 });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: null,
      configError:
        'The configuration “Customers” isn’t shared with the Fabrikam Agile process. No configurations are shared with it yet.',
      // Spelled out under the field, where its link can be reached.
      readOnly: true,
      settingsUrl: SETTINGS_URL,
    });
    controller.retry();
    await controller.select({ key: 'Contoso', value: 'Contoso' });
    await controller.clear();
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadSecret).not.toHaveBeenCalled();
    expect(loadPolicy).not.toHaveBeenCalled();
    expect(form.setFieldValues).not.toHaveBeenCalled();
  });

  it('lists the configurations shared with the process when none has the name', async () => {
    const { controller } = configured({
      docs: [
        configurationDoc({ id: 'countries', name: 'Countries' }),
        configurationDoc({ id: 'contacts', name: 'Contacts' }),
      ],
    });
    await controller.onLoaded({ id: 1 });
    expect(controller.getSnapshot().configError).toBe(
      'No configuration named “Customers” is shared with the Fabrikam Agile process. Available: “Contacts”, “Countries”.'
    );
  });

  it('reports a configuration whose settings can’t be used', async () => {
    const { controller, fetchImpl } = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, FieldMap: '{ nope' } })],
    });
    await controller.onLoaded({ id: 1 });
    expect(controller.getSnapshot().configError).toMatch(/field map isn’t valid JSON/);
    expect(controller.getSnapshot().readOnly).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets people retry when the configurations can’t be read', async () => {
    const context = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AllowMultiple: 'true' } })],
      inputs: { FieldName: 'Custom.Customers' },
      values: { 'Custom.Customers': 'Contoso; Fabrikam' },
    });
    const { controller, form, resolveConfiguration } = context;
    resolveConfiguration.mockRejectedValueOnce(
      new PicklistError(
        'network',
        'Couldn’t read the REST Picklist configurations. Try again in a moment.'
      )
    );
    await controller.onLoaded({ id: 1 });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError: null,
      readOnly: false,
      settingsUrl: null,
      error: 'Couldn’t read the REST Picklist configurations. Try again in a moment.',
    });
    // Until the configuration says how the field holds its values, the field isn't changed.
    await controller.clear();
    expect(form.setFieldValues).not.toHaveBeenCalled();

    controller.retry();
    await settle();
    expect(resolveConfiguration).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      multiple: true,
      selected: ['Contoso', 'Fabrikam'],
    });
  });

  it('needs the configuration’s secret', async () => {
    const context = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'Bearer token' } })],
      secret: null,
    });
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError: MISSING_SECRET,
      settingsUrl: SETTINGS_URL,
      // Shown in the open list first…
      readOnly: false,
    });
    expect(context.fetchImpl).not.toHaveBeenCalled();
    // …then spelled out under the field once the list closes.
    context.controller.setListOpen(false);
    expect(context.controller.getSnapshot().readOnly).toBe(true);
  });

  it('never sends a secret saved for another address', async () => {
    const context = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'API key' } })],
      secret: secretDoc({ kind: 'apiKey', value: API_KEY }, 'https://old.example.com'),
    });
    await opened(context);
    expect(context.controller.getSnapshot().configError).toBe(
      'This configuration’s address changed after its secret was saved. Ask an administrator to enter the secret again.'
    );
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });

  it('never sends a secret meant for another sign-in method', async () => {
    const context = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'API key' } })],
      secret: secretDoc({ kind: 'password', value: 'a-password' }),
    });
    await opened(context);
    expect(context.controller.getSnapshot().configError).toBe(
      'This configuration’s secret doesn’t match how it signs in. Ask an administrator to enter it again in Organization settings › Extensions › REST Picklist.'
    );
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });

  it('checks the request against the policy before reading the secret', async () => {
    const blocked = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'API key' } })],
      secret: secretDoc({ kind: 'apiKey', value: API_KEY }),
      policy: { ...DEFAULT_POLICY, allowedHosts: ['api.contoso.com'] },
    });
    await opened(blocked);
    expect(blocked.controller.getSnapshot().configError).toBe(
      'api.example.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(blocked.loadSecret).not.toHaveBeenCalled();
    expect(blocked.fetchImpl).not.toHaveBeenCalled();

    const method = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'API key' } })],
      secret: secretDoc({ kind: 'apiKey', value: API_KEY }),
      policy: { ...DEFAULT_POLICY, allowedAuthMethods: ['none', 'oauth2'] },
    });
    await opened(method);
    expect(method.controller.getSnapshot().configError).toMatch(
      /doesn’t allow the “API key” sign-in method/
    );
    expect(method.loadSecret).not.toHaveBeenCalled();
  });

  it('offers the process allowed values when the configuration has no endpoint', async () => {
    const context = configured({ docs: [configurationDoc({ settings: {} })] });
    await opened(context);
    expect(context.controller.getSnapshot().items?.map((entry) => entry.value)).toEqual([
      'High',
      'Low',
    ]);
    expect(context.loadSecret).not.toHaveBeenCalled();
  });

  it('reads the secret once, and looks everything up again after a refresh', async () => {
    const context = configured({
      docs: [
        configurationDoc({
          settings: {
            ...SETTINGS,
            AuthMethod: 'API key',
            RestCallParameters: '{ "region": "$(Custom.Region)" }',
          },
        }),
      ],
      secret: secretDoc({ kind: 'apiKey', value: API_KEY }),
      values: { 'Custom.Region': 'EU' },
    });
    const { controller, form, fetchImpl, loadSecret, resolveConfiguration } = context;
    await opened(context);
    form.current['Custom.Region'] = 'US';
    controller.onFieldChanged({ id: 1, changedFields: { 'Custom.Region': 'US' } });
    await settle();
    expect(requestedUrl(fetchImpl, 1)).toBe('https://api.example.com/customers?region=US');
    expect(loadSecret).toHaveBeenCalledTimes(1);

    await controller.onRefreshed();
    await settle();
    expect(resolveConfiguration).toHaveBeenCalledTimes(2);
    expect(loadSecret).toHaveBeenCalledTimes(2);
  });

  it('needs a host that can find configurations', async () => {
    const form = createForm({ 'System.TeamProject': 'Fabrikam Fiber' });
    const controller = new PicklistController(
      { FieldName: 'Custom.Customer', Configuration: 'Customers' },
      { getFormService: async () => form.service },
      new ResponseCache<LoadedList>()
    );
    await controller.onLoaded({ id: 1 });
    expect(controller.getSnapshot()).toMatchObject({
      configError: 'Configurations aren’t available here, so “Customers” can’t be used.',
      settingsUrl: null,
    });
  });

  it('opens the settings page through the host, when it can', () => {
    const { controller, openSettingsPage } = configured();
    expect(controller.openSettingsPage(SETTINGS_URL)).toBe(true);
    expect(openSettingsPage).toHaveBeenCalledWith(SETTINGS_URL);
    const bare = new PicklistController(
      { FieldName: 'Custom.Customer' },
      { getFormService: async () => createForm({}).service }
    );
    expect(bare.openSettingsPage(SETTINGS_URL)).toBe(false);
  });
});

describe('OAuth 2.0', () => {
  const TOKEN_URL = 'https://login.example.com/oauth2/token';
  const TOKEN_ORIGIN = 'https://login.example.com';
  const CLIENT_SECRET = 'client-secret-value-123';
  const OAUTH = {
    ...SETTINGS,
    AuthMethod: 'OAuth 2.0',
    OAuthSettings: JSON.stringify({
      tokenUrl: TOKEN_URL,
      clientId: 'picklist',
      scope: 'customers.read',
    }),
  };
  const WITH_SECRET = secretDoc({ kind: 'clientSecret', value: CLIENT_SECRET }, TOKEN_ORIGIN);

  /** The token service, then the API; tokens are numbered in the order they're handed out. */
  function services(
    options: {
      token?: (count: number) => Response;
      api?: (authorization: string) => Response;
    } = {}
  ) {
    let tokens = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (urlOf(input).startsWith(TOKEN_URL)) {
        tokens += 1;
        return (
          options.token?.(tokens) ??
          json({ access_token: `token-${tokens}`, token_type: 'Bearer', expires_in: 3600 })
        );
      }
      const authorization = new Headers(init?.headers).get('Authorization') ?? '';
      return options.api?.(authorization) ?? json(CUSTOMERS);
    });
    const tokenCalls = () =>
      fetchImpl.mock.calls.filter(([input]) => urlOf(input).startsWith(TOKEN_URL));
    const apiCalls = () =>
      fetchImpl.mock.calls.filter(([input]) => !urlOf(input).startsWith(TOKEN_URL));
    const sentAuthorization = () =>
      apiCalls().map(([, init]) => new Headers(init?.headers).get('Authorization'));
    return { fetchImpl, tokenCalls, apiCalls, sentAuthorization };
  }

  it('gets an access token with the client secret, and calls the API with the token', async () => {
    const service = services();
    const context = configured({
      docs: [configurationDoc({ settings: OAUTH })],
      secret: WITH_SECRET,
      fetchImpl: service.fetchImpl,
    });
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      error: null,
      configError: null,
    });
    const token = service.tokenCalls()[0];
    expect(token?.[0]).toBe(TOKEN_URL);
    expect(token?.[1]?.method).toBe('POST');
    expect(new Headers(token?.[1]?.headers).get('Authorization')).toBe(
      `Basic ${btoa(`picklist:${CLIENT_SECRET}`)}`
    );
    expect(bodyOf(token?.[1])).toBe('grant_type=client_credentials&scope=customers.read');
    expect(urlOf(service.apiCalls()[0]?.[0] ?? '')).toBe('https://api.example.com/customers');
    expect(service.sentAuthorization()).toEqual(['Bearer token-1']);
    // The client secret only ever goes to the token URL.
    expect(JSON.stringify(service.apiCalls())).not.toContain(CLIENT_SECRET);
  });

  it('keeps the token for later loads', async () => {
    const service = services();
    const context = configured({
      docs: [
        configurationDoc({
          settings: { ...OAUTH, RestCallParameters: '{ "region": "$(Custom.Region)" }' },
        }),
      ],
      secret: WITH_SECRET,
      fetchImpl: service.fetchImpl,
      values: { 'Custom.Region': 'EU' },
    });
    await opened(context);
    context.form.current['Custom.Region'] = 'US';
    context.controller.onFieldChanged({ id: 1, changedFields: { 'Custom.Region': 'US' } });
    await vi.waitFor(() => expect(service.apiCalls()).toHaveLength(2));
    expect(service.tokenCalls()).toHaveLength(1);
    expect(service.sentAuthorization()).toEqual(['Bearer token-1', 'Bearer token-1']);
  });

  it('gets a new token and tries once more when the API refuses the token', async () => {
    const service = services({
      api: (authorization) =>
        authorization === 'Bearer token-1' ? new Response('', { status: 401 }) : json(CUSTOMERS),
    });
    const context = configured({
      docs: [configurationDoc({ settings: OAUTH })],
      secret: WITH_SECRET,
      fetchImpl: service.fetchImpl,
    });
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({ status: 'loaded', error: null });
    expect(service.tokenCalls()).toHaveLength(2);
    expect(service.sentAuthorization()).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('tries only once more', async () => {
    const service = services({ api: () => new Response('', { status: 401 }) });
    const context = configured({
      docs: [configurationDoc({ settings: OAUTH })],
      secret: WITH_SECRET,
      fetchImpl: service.fetchImpl,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError: null,
      error: 'The service refused access (401). Check the sign-in settings.',
    });
    expect(service.tokenCalls()).toHaveLength(2);
    expect(service.apiCalls()).toHaveLength(2);
  });

  it('never sends tokens to an API the secret wasn’t saved for', async () => {
    // Pointing the API elsewhere would collect live access tokens: the secret has to be
    // entered again first, like when the token URL changes.
    const service = services();
    const context = configured({
      docs: [
        configurationDoc({
          settings: { ...OAUTH, RestServiceAddress: 'https://collector.example.net/customers' },
        }),
      ],
      secret: { ...WITH_SECRET, apiOrigin: API_ORIGIN },
      fetchImpl: service.fetchImpl,
    });
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError:
        'This configuration’s address changed after its secret was saved. Ask an administrator to enter the secret again.',
    });
    expect(service.fetchImpl).not.toHaveBeenCalled();
  });

  it('doesn’t get another token when the API fails for another reason', async () => {
    // Only a 401 means the token was refused; anything else isn't the token's fault.
    const service = services({ api: () => new Response('', { status: 500 }) });
    const context = configured({
      docs: [configurationDoc({ settings: OAUTH })],
      secret: WITH_SECRET,
      fetchImpl: service.fetchImpl,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError: null,
      error: 'The service had a problem (500).',
    });
    expect(service.tokenCalls()).toHaveLength(1);
    expect(service.apiCalls()).toHaveLength(1);
  });

  it('doesn’t ask again when the token service refuses', async () => {
    const service = services({
      token: () =>
        json({ error: 'invalid_client', error_description: 'Client authentication failed.' }, 401),
    });
    const context = configured({
      docs: [configurationDoc({ settings: OAUTH })],
      secret: WITH_SECRET,
      fetchImpl: service.fetchImpl,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError: null,
      error:
        'The token service refused the request (invalid_client: Client authentication failed.).',
    });
    expect(service.tokenCalls()).toHaveLength(1);
    expect(service.apiCalls()).toHaveLength(0);
    expect(context.controller.getSnapshot().error).not.toContain(CLIENT_SECRET);
  });

  it('signs a client assertion with a private key', async () => {
    const service = services();
    const key: StoredSecret = {
      kind: 'signingKey',
      key: { pkcs8: EC_P256.pkcs8.replace(/\s+/g, ''), algorithm: 'ES256', kid: 'key-1' },
    };
    const context = configured({
      docs: [
        configurationDoc({
          settings: {
            ...OAUTH,
            OAuthSettings: JSON.stringify({
              tokenUrl: TOKEN_URL,
              clientId: 'picklist',
              clientAuthentication: 'privateKeyJwt',
            }),
          },
        }),
      ],
      secret: secretDoc(key, TOKEN_ORIGIN),
      fetchImpl: service.fetchImpl,
    });
    await opened(context);
    expect(context.controller.getSnapshot().status).toBe('loaded');
    const init = service.tokenCalls()[0]?.[1];
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    const body = new URLSearchParams(bodyOf(init));
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    );
    expect(body.get('client_assertion')?.split('.')).toHaveLength(3);
    expect(body.has('client_secret')).toBe(false);
    expect(service.sentAuthorization()).toEqual(['Bearer token-1']);
  });

  it('checks the token URL against the policy before sending the secret', async () => {
    const service = services();
    const context = configured({
      docs: [configurationDoc({ settings: OAUTH })],
      secret: WITH_SECRET,
      fetchImpl: service.fetchImpl,
      policy: { ...DEFAULT_POLICY, allowedHosts: ['api.example.com'] },
    });
    await opened(context);
    expect(context.controller.getSnapshot().configError).toBe(
      'login.example.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(service.fetchImpl).not.toHaveBeenCalled();
  });

  it('never sends the client secret to a token URL it wasn’t saved for', async () => {
    const service = services();
    const context = configured({
      docs: [configurationDoc({ settings: OAUTH })],
      secret: secretDoc({ kind: 'clientSecret', value: CLIENT_SECRET }, 'https://old.example.com'),
      fetchImpl: service.fetchImpl,
    });
    await opened(context);
    expect(context.controller.getSnapshot().configError).toMatch(
      /address changed after its secret was saved/
    );
    expect(service.fetchImpl).not.toHaveBeenCalled();
  });
});

/** A control with neither a configuration nor settings of its own, and a host that has it all. */
function moved(inputs: Record<string, unknown> = {}) {
  const form = createForm({
    'System.TeamProject': 'Fabrikam Fiber',
    'Custom.Customer': 'Contoso',
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => json(CUSTOMERS));
  const host = {
    getFormService: async () => form.service,
    fetch: fetchImpl,
    loadPolicy: vi.fn<() => Promise<SecurityPolicy>>(async () => DEFAULT_POLICY),
    resolveSavedInputs: vi.fn<NonNullable<PicklistHost['resolveSavedInputs']>>(async () => ({})),
    resolveConfiguration: vi.fn<NonNullable<PicklistHost['resolveConfiguration']>>(),
    loadSecret: vi.fn<NonNullable<PicklistHost['loadSecret']>>(async () => null),
    settingsPageUrl: vi.fn<NonNullable<PicklistHost['settingsPageUrl']>>(async () => SETTINGS_URL),
  };
  const controller = new PicklistController(
    { FieldName: 'Custom.Customer', ...inputs },
    host,
    new ResponseCache<LoadedList>()
  );
  return { controller, form, fetchImpl, host };
}

describe('without a configuration', () => {
  it('keeps offering the process’s allowed values on a 3.0 control that had no endpoint', async () => {
    // 3.0 stored the control's other options, so it's still a 3.0 control: not “moved”.
    for (const inputs of [
      { AllowMultiple: 'true', ErrorMessage: 'Not allowed' },
      { RestServiceAddress: '', LoadOnFormOpen: 'true', Required: 'false' },
    ]) {
      const { controller, fetchImpl, host } = moved(inputs);
      await controller.onLoaded({ id: 1 });
      controller.setListOpen(true);
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('loaded'));
      expect(controller.getSnapshot()).toMatchObject({ moved: false, readOnly: false });
      expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['High', 'Low']);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(host.resolveConfiguration).not.toHaveBeenCalled();
    }
  });

  it('says where API settings are managed now, and asks no API for anything', async () => {
    // Only the field, and an empty configuration name: like a new 4.0 control.
    const { controller, form, fetchImpl, host } = moved({ Configuration: '  ' });
    await controller.onLoaded({ id: 1 });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      moved: true,
      ready: true,
      readOnly: true,
      required: false,
      status: 'idle',
      error: null,
      configError: null,
      settingsUrl: SETTINGS_URL,
      selected: ['Contoso'],
    });

    controller.setListOpen(true);
    controller.retry();
    await controller.select({ key: 'Fabrikam', value: 'Fabrikam' });
    await controller.clear();
    await controller.onRefreshed();
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(host.loadPolicy).not.toHaveBeenCalled();
    expect(host.resolveConfiguration).not.toHaveBeenCalled();
    expect(host.resolveSavedInputs).not.toHaveBeenCalled();
    expect(host.loadSecret).not.toHaveBeenCalled();
    expect(form.setFieldValues).not.toHaveBeenCalled();
  });

  it('still says so when the settings page can’t be found', async () => {
    const { controller, host } = moved();
    host.settingsPageUrl.mockRejectedValueOnce(new Error('No location service'));
    await controller.onLoaded({ id: 1 });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ moved: true, settingsUrl: null });
  });
});

describe('settings kept on the control’s own Options (before 4.0)', () => {
  it('keep working as before, without looking for a configuration', async () => {
    const resolveConfiguration = vi.fn<NonNullable<PicklistHost['resolveConfiguration']>>();
    const loadSecret = vi.fn<NonNullable<PicklistHost['loadSecret']>>();
    const settingsPageUrl = vi.fn<NonNullable<PicklistHost['settingsPageUrl']>>(
      async () => SETTINGS_URL
    );
    const { controller, fetchImpl } = await loaded(
      { AuthMethod: 'Basic', RestServiceUserName: 'svc', RestServicePassword: 'inline-password' },
      { host: { resolveConfiguration, loadSecret, settingsPageUrl } }
    );
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      moved: false,
      settingsUrl: null,
    });
    expect(requestHeaders(fetchImpl, 0)).toMatchObject({
      Authorization: `Basic ${btoa('svc:inline-password')}`,
    });
    expect(resolveConfiguration).not.toHaveBeenCalled();
    expect(loadSecret).not.toHaveBeenCalled();
    expect(settingsPageUrl).not.toHaveBeenCalled();
  });

  it('keep their messages, which don’t link to the settings page', async () => {
    const { controller } = await loaded(
      {},
      {
        host: {
          loadPolicy: async () => ({ ...DEFAULT_POLICY, allowedHosts: ['api.contoso.com'] }),
          settingsPageUrl: async () => SETTINGS_URL,
        },
      }
    );
    expect(controller.getSnapshot()).toMatchObject({
      configError:
        'api.example.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.',
      settingsUrl: null,
      readOnly: false,
    });
  });

  it('can’t sign in with OAuth 2.0, which needs a configuration', async () => {
    const { controller, fetchImpl } = await loaded({
      AuthMethod: 'OAuth 2.0',
      RestServicePassword: 'inline-password',
      OAuthSettings: '{ "tokenUrl": "https://login.example.com/token", "clientId": "x" }',
    });
    expect(controller.getSnapshot().configError).toBe(
      'OAuth 2.0 sign-in needs a configuration. Set one up in Organization settings › Extensions › REST Picklist.'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- Review fixes: work items from different projects, retries, Basic without a password ----

/** A control whose configuration differs per project, the way it does across processes. */
function perProject(settingsFor: (project: string) => Record<string, string>) {
  const form = createForm({ 'System.TeamProject': 'Project A', 'Custom.Customer': '' });
  const fetchImpl = vi.fn<typeof fetch>(async () => json(CUSTOMERS));
  const host: PicklistHost = {
    getFormService: async () => form.service,
    fetch: fetchImpl,
    resolveConfiguration: async (name, project) => ({
      id: CONFIGURATION_ID,
      name,
      processId: project,
      processName: project,
      settings: settingsFor(project),
      secret: null,
    }),
    loadSecret: async () => null,
  };
  const controller = new PicklistController(
    { FieldName: 'Custom.Customer', Configuration: 'Customers' },
    host,
    new ResponseCache<LoadedList>()
  );
  return { controller, form, fetchImpl };
}

describe('work items from different projects', () => {
  it('empties the fields of the configuration in use, not the last work item’s', async () => {
    const { controller, form } = perProject((project) =>
      project === 'Project A'
        ? { ...SETTINGS, FieldMap: '{ "Custom.CustomerId": "id" }', LoadOnFormOpen: 'true' }
        : { ...SETTINGS, FieldMap: '{ "Custom.Region": "region" }' }
    );
    await controller.onLoaded({ id: 1 });
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('loaded'));
    // Work item 2 is in project B, whose configuration fills another field; nothing loaded yet.
    form.current['System.TeamProject'] = 'Project B';
    form.current['Custom.Customer'] = 'Contoso';
    await controller.onLoaded({ id: 2 });
    form.setFieldValues.mockClear();
    await controller.clear();
    expect(form.setFieldValues).toHaveBeenCalledWith({
      'Custom.Region': '',
      'Custom.Customer': '',
    });
    expect(form.current['Custom.CustomerId']).toBeUndefined();
  });

  it('ignores a list that arrives after another work item opened', async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    const { controller, form, fetchImpl } = perProject((project) => ({
      ...SETTINGS,
      RestServiceAddress: `${API_ORIGIN}/${project === 'Project A' ? 'first' : 'second'}`,
      LoadOnFormOpen: 'true',
    }));
    fetchImpl.mockImplementation(async (input) =>
      urlOf(input).endsWith('/first')
        ? new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          })
        : json({ data: [{ name: 'B-1' }] })
    );
    await controller.onLoaded({ id: 1 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    form.current['System.TeamProject'] = 'Project B';
    await controller.onLoaded({ id: 2 });
    await vi.waitFor(() =>
      expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['B-1'])
    );
    expect(releaseFirst).toBeDefined();
    releaseFirst?.(json({ data: [{ name: 'A-1' }] }));
    await settle();
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['B-1']);
    expect(controller.getSnapshot().status).toBe('loaded');
  });
});

/** A promise settled from outside. */
function deferred<T>() {
  const handlers: { resolve?: (value: T) => void; reject?: (error: unknown) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });
  return {
    promise,
    resolve: (value: T) => handlers.resolve?.(value),
    reject: (error: unknown) => handlers.reject?.(error),
  };
}

/** What project A's or B's configuration lookup answers in slowFirstProject. */
function projectConfiguration(project: string) {
  return {
    id: CONFIGURATION_ID,
    name: 'Customers',
    processId: project,
    processName: project,
    settings: {
      ...SETTINGS,
      RestServiceAddress: `${API_ORIGIN}/${project === 'Project A' ? 'first' : 'second'}`,
      ErrorMessage: `Not in ${project}`,
      LoadOnFormOpen: 'true',
    },
    secret: null,
  };
}

/**
 * Work items in two projects, A and B, each with its own configuration. `hold` makes the first
 * configuration lookup or the first policy read for project A wait until released.
 */
function slowFirstProject(hold: 'configuration' | 'policy') {
  const form = createForm({ 'System.TeamProject': 'Project A', 'Custom.Customer': '' });
  const fetchImpl = vi.fn<typeof fetch>(async (input) =>
    json({ data: [{ name: urlOf(input).endsWith('/first') ? 'A-1' : 'B-1' }] })
  );
  const configurationA =
    deferred<Awaited<ReturnType<NonNullable<PicklistHost['resolveConfiguration']>>>>();
  const policyA = deferred<SecurityPolicy>();
  /** The projects asked about, in order: lookups for configurations, reads of the policy. */
  const lookups: string[] = [];
  let policyCalls = 0;
  const host: PicklistHost = {
    getFormService: async () => form.service,
    fetch: fetchImpl,
    resolveConfiguration: async (_name, project) => {
      lookups.push(project);
      return hold === 'configuration' && project === 'Project A'
        ? configurationA.promise
        : projectConfiguration(project);
    },
    loadPolicy: async () => {
      policyCalls += 1;
      return hold === 'policy' && policyCalls === 1 ? policyA.promise : DEFAULT_POLICY;
    },
    loadSecret: async () => null,
  };
  const controller = new PicklistController(
    { FieldName: 'Custom.Customer', Configuration: 'Customers' },
    host,
    new ResponseCache<LoadedList>()
  );
  /** Opens work item 1 in project A, waits until what's held is being asked for, then opens 2. */
  const openBoth = async (): Promise<{ first: Promise<void> }> => {
    const first = controller.onLoaded({ id: 1 });
    await vi.waitFor(() => expect(hold === 'configuration' ? lookups.length : policyCalls).toBe(1));
    expect(lookups).toEqual(['Project A']);
    form.current['System.TeamProject'] = 'Project B';
    await controller.onLoaded({ id: 2 });
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('loaded'));
    return { first };
  };
  return { controller, fetchImpl, configurationA, policyA, openBoth };
}

describe('a slow first work item', () => {
  it('ignores its configuration lookup failing after another work item opened', async () => {
    const { controller, configurationA, openBoth } = slowFirstProject('configuration');
    const { first } = await openBoth();
    configurationA.reject(new PicklistError('config', 'No configuration named “Customers”.'));
    await first;
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      ready: true,
      status: 'loaded',
      error: null,
      configError: null,
    });
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['B-1']);
  });

  it('ignores its configuration arriving after another work item opened', async () => {
    const { controller, fetchImpl, configurationA, openBoth } = slowFirstProject('configuration');
    const { first } = await openBoth();
    configurationA.resolve(projectConfiguration('Project A'));
    await first;
    await settle();
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['B-1']);
    expect(fetchImpl.mock.calls.map(([input]) => urlOf(input))).toEqual([`${API_ORIGIN}/second`]);
  });

  it('ignores its settings resolving after another work item opened', async () => {
    const { controller, fetchImpl, policyA, openBoth } = slowFirstProject('policy');
    await openBoth();
    policyA.resolve(DEFAULT_POLICY);
    await settle();
    // The first work item's list is never asked for, and its settings never take over.
    expect(fetchImpl.mock.calls.map(([input]) => urlOf(input))).toEqual([`${API_ORIGIN}/second`]);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      notFoundMessage: 'Not in Project B',
    });
  });

  it('ignores its settings failing after another work item opened', async () => {
    const { controller, policyA, openBoth } = slowFirstProject('policy');
    await openBoth();
    policyA.reject(new Error('offline'));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ status: 'loaded', error: null });
    expect(controller.getSnapshot().items?.map((entry) => entry.value)).toEqual(['B-1']);
  });
});

describe('trying again from the keyboard', () => {
  it('loads again when the list opens again after a load error', async () => {
    // The open list's “Try again” can't be reached with Tab, which closes the list.
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));
    const { controller } = setup({}, { fetchImpl });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await controller.onLoaded({ id: 1 });
    controller.setListOpen(true);
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('error'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.setListOpen(false);
    fetchImpl.mockImplementation(async () => json(CUSTOMERS));
    controller.setListOpen(true);
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('loaded'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('doesn’t when the problem is the setup, which trying again can’t fix', async () => {
    const { controller, fetchImpl } = setup({ AdvancedSettings: '{ nope' });
    await controller.onLoaded({ id: 1 });
    controller.setListOpen(true);
    await vi.waitFor(() => expect(controller.getSnapshot().configError).not.toBeNull());
    controller.setListOpen(false);
    controller.setListOpen(true);
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe('error');
  });
});

describe('Basic sign-in without a password', () => {
  it('sends the user name alone when no password is stored, as before 4.0', async () => {
    // Some APIs take a key as the user name, with an empty password.
    const context = configured({
      docs: [
        configurationDoc({
          settings: { ...SETTINGS, AuthMethod: 'Basic', RestServiceUserName: 'sk_live' },
        }),
      ],
      secret: null,
    });
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'loaded',
      configError: null,
    });
    expect(new Headers(requestHeaders(context.fetchImpl, 0)).get('Authorization')).toBe(
      `Basic ${btoa('sk_live:')}`
    );
  });

  it('still needs the secret without a user name', async () => {
    const context = configured({
      docs: [configurationDoc({ settings: { ...SETTINGS, AuthMethod: 'Basic' } })],
      secret: null,
    });
    await opened(context);
    expect(context.controller.getSnapshot()).toMatchObject({
      status: 'error',
      configError: MISSING_SECRET,
    });
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });
});
