import { describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { controlStatus, migratedInputs } from '../core/migration';
import { isPlainObject } from '../core/values';
import {
  CONTROL_CONTRIBUTION,
  LeftoverInputsError,
  findPicklistControls,
  isPicklistContribution,
  savedConfigurationsCacheKey,
  scanProcessControls,
  updateControlInputs,
  workItemTypesPath,
} from './layout';
import { createDevOpsApiForTests } from './rest';

// The real SDK talks to the parent window as soon as it's imported.
vi.mock('azure-devops-extension-sdk', () => ({}));

const BASE = 'https://dev.azure.com/contoso/';
const OUR_CONTRIBUTION = 'OscarArguedasBarboza.RestDataMappingPicklist.rest-data-mapping-picklist';
const DEV_CONTRIBUTION =
  'OscarArguedasBarboza.RestDataMappingPicklist-dev.REST-DATA-MAPPING-PICKLIST';
const PROCESS = { id: 'e31fd6e1-c6af-44bb-925e-dfa71f551463', name: 'Contoso Agile' };
const PASSWORD = 'p@ssw0rd-secret';

const CUSTOMER_INPUTS = {
  FieldName: 'Custom.Customer',
  RestServiceAddress: 'https://api.contoso.com/customers',
  AuthMethod: 'Basic',
  RestServiceUserName: 'svc-picklist',
  RestServicePassword: PASSWORD,
};

// Shaped like the controls in GET …/workitemtypes?$expand=layout.
function picklistControl(
  id: string,
  label: string,
  inputs: Record<string, unknown>,
  contributionId = OUR_CONTRIBUTION
) {
  return {
    id,
    label,
    controlType: null,
    readOnly: false,
    visible: true,
    isContribution: true,
    contribution: { contributionId, inputs, height: 36, showOnDeletedWorkItem: false },
  };
}

function layoutResponse() {
  const bug = {
    referenceName: 'ContosoAgile.Bug',
    name: 'Bug',
    layout: {
      pages: [
        {
          id: 'Details',
          sections: [
            {
              id: 'Section1',
              groups: [
                {
                  id: 'Group.Customer',
                  controls: [
                    { id: 'System.Title', label: 'Title', isContribution: false },
                    picklistControl(
                      'c-toggle',
                      'Done',
                      { FieldName: 'Custom.Done' },
                      'ms-devlabs.toggle-control.toggle-control-contribution'
                    ),
                    picklistControl('c-customer', ' Customer ', CUSTOMER_INPUTS),
                    // The same control twice is listed once.
                    picklistControl('c-customer', 'Customer', CUSTOMER_INPUTS),
                    picklistControl('', 'No id', { FieldName: 'Custom.NoId' }),
                    { ...picklistControl('c-off', 'Off', {}), isContribution: false },
                    {
                      ...picklistControl('c-no-inputs', 'No inputs', {}),
                      contribution: { contributionId: OUR_CONTRIBUTION },
                    },
                  ],
                },
                { id: '', controls: [picklistControl('c-no-group', 'No group', {})] },
              ],
            },
          ],
        },
      ],
    },
  };
  const task = {
    referenceName: 'ContosoAgile.Task',
    name: '',
    layout: {
      pages: [
        {
          sections: [
            {
              groups: [
                {
                  id: 'Group.Planning',
                  controls: [
                    picklistControl(
                      'c-product',
                      'Product',
                      { FieldName: 'Custom.Product', Configuration: 'Products' },
                      DEV_CONTRIBUTION
                    ),
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const epic = { referenceName: 'Microsoft.VSTS.WorkItemTypes.Epic', name: 'Epic' };
  return { count: 3, value: [bug, epic, task, 'odd', { name: 'No reference', layout: {} }] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function setup() {
  const state = {
    layout: layoutResponse() as unknown,
    patch: (body: unknown): Response => json(body),
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    if ((init?.method ?? 'GET') === 'PATCH') {
      return state.patch(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    }
    // Layout - Get: one work item type's layout, read again just before an update.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const single = /\/workItemTypes\/([^/]+)\/layout\?/.exec(url);
    if (single) {
      const types =
        isPlainObject(state.layout) && Array.isArray(state.layout.value) ? state.layout.value : [];
      const type: unknown = types.find(
        (item: unknown) =>
          isPlainObject(item) && item.referenceName === decodeURIComponent(single[1] ?? '')
      );
      return isPlainObject(type) ? json(type.layout) : json({ message: 'Not found' }, 404);
    }
    return json(state.layout);
  });
  return { api: createDevOpsApiForTests(BASE, 'token-123', fetchImpl), fetchImpl, state };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<PicklistError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PicklistError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a failure');
}

/** The update's LeftoverInputsError; fails the test when it ends any other way. */
async function leftovers(promise: Promise<unknown>): Promise<LeftoverInputsError> {
  const error = await failure(promise);
  if (!(error instanceof LeftoverInputsError)) {
    throw new Error(`Expected leftover inputs, got: ${error.message}`);
  }
  return error;
}

/** The inputs a PATCH sent. */
function sentInputs(body: unknown): Record<string, unknown> {
  return isPlainObject(body) &&
    isPlainObject(body.contribution) &&
    isPlainObject(body.contribution.inputs)
    ? body.contribution.inputs
    : {};
}

async function customer(api: ReturnType<typeof setup>['api']): Promise<LayoutControl> {
  const found = (await scanProcessControls(api, PROCESS)).find(
    (control) => control.controlId === 'c-customer'
  );
  if (!found) {
    throw new Error('Expected the customer control');
  }
  return found;
}

describe('scanProcessControls', () => {
  it('reads the process layout', async () => {
    const { api, fetchImpl } = setup();
    await scanProcessControls(api, PROCESS);
    expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([
      `${BASE}_apis/work/processes/${PROCESS.id}/workitemtypes?$expand=layout&api-version=7.1`,
    ]);
    expect(workItemTypesPath('p#1')).toBe(
      '_apis/work/processes/p%231/workitemtypes?$expand=layout&api-version=7.1'
    );
  });

  it('finds this extension’s controls, in layout order', async () => {
    const { api } = setup();
    const controls = await scanProcessControls(api, PROCESS);
    expect(controls.map((control) => [control.workItemType.name, control.controlId])).toEqual([
      ['Bug', 'c-customer'],
      ['Bug', 'c-no-inputs'],
      ['ContosoAgile.Task', 'c-product'],
    ]);
    const [first, noInputs, product] = controls;
    expect(first).toEqual({
      processId: PROCESS.id,
      processName: 'Contoso Agile',
      workItemType: { name: 'Bug', referenceName: 'ContosoAgile.Bug' },
      groupId: 'Group.Customer',
      controlId: 'c-customer',
      label: 'Customer',
      fieldName: 'Custom.Customer',
      inputs: CUSTOMER_INPUTS,
      control: picklistControl('c-customer', ' Customer ', CUSTOMER_INPUTS),
    });
    expect(noInputs?.inputs).toEqual({});
    expect(product && controlStatus(product)).toEqual({
      kind: 'configured',
      configuration: 'Products',
      leftovers: false,
    });
  });

  it('copies the inputs, so the scanned control stays as Azure DevOps returned it', async () => {
    const { api } = setup();
    const found = await customer(api);
    const raw = isPlainObject(found.control.contribution)
      ? found.control.contribution.inputs
      : null;
    expect(found.inputs).not.toBe(raw);
    expect(found.inputs).toEqual(raw);
  });

  it('matches the contribution id by its suffix, ignoring case', () => {
    expect(isPicklistContribution(OUR_CONTRIBUTION)).toBe(true);
    expect(isPicklistContribution(DEV_CONTRIBUTION)).toBe(true);
    expect(isPicklistContribution(CONTROL_CONTRIBUTION)).toBe(false);
    expect(isPicklistContribution('evil.rest-data-mapping-picklist-copy')).toBe(false);
    expect(isPicklistContribution(42)).toBe(false);
  });

  it('rejects an unexpected response', async () => {
    const { api, state } = setup();
    state.layout = { message: 'odd' };
    await expect(scanProcessControls(api, PROCESS)).rejects.toThrow(
      'Azure DevOps returned an unexpected list of work item types.'
    );
    expect(findPicklistControls([], PROCESS)).toEqual([]);
    expect(findPicklistControls({ value: [] }, PROCESS)).toEqual([]);
  });

  it('explains a process the user can’t read', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}, 403));
    const api = createDevOpsApiForTests(BASE, 'token-123', fetchImpl);
    await expect(scanProcessControls(api, PROCESS)).rejects.toThrow(
      'You don’t have permission to read the “Contoso Agile” process (403).'
    );
  });
});

describe('updateControlInputs', () => {
  it('sends the control back with exactly the inputs given', async () => {
    const { api, fetchImpl } = setup();
    const found = await customer(api);
    fetchImpl.mockClear();
    const updated = await updateControlInputs(api, found, migratedInputs(found, 'Customers'), null);
    // The control is read again first, then sent back.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${BASE}_apis/work/processes/${PROCESS.id}/workItemTypes/ContosoAgile.Bug/layout?api-version=7.1`
    );
    const [input, init] = fetchImpl.mock.calls[1] ?? [];
    expect(init?.method).toBe('PATCH');
    expect(input).toBe(
      `${BASE}_apis/work/processes/${PROCESS.id}/workItemTypes/ContosoAgile.Bug/layout/groups/Group.Customer/controls/c-customer?api-version=7.1`
    );
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    expect(body).toEqual({
      id: 'c-customer',
      label: ' Customer ',
      readOnly: false,
      visible: true,
      contribution: {
        contributionId: OUR_CONTRIBUTION,
        inputs: { FieldName: 'Custom.Customer', Configuration: 'Customers' },
        height: 36,
        showOnDeletedWorkItem: false,
      },
      isContribution: true,
    });
    // The password never travels again.
    expect(typeof init?.body === 'string' ? init.body : '').not.toContain(PASSWORD);
    expect(updated).toMatchObject({
      controlId: 'c-customer',
      fieldName: 'Custom.Customer',
      inputs: { FieldName: 'Custom.Customer', Configuration: 'Customers' },
    });
    expect(controlStatus(updated)).toEqual({
      kind: 'configured',
      configuration: 'Customers',
      leftovers: false,
    });
    // The scanned control isn't changed.
    expect(found.inputs).toEqual(CUSTOMER_INPUTS);
  });

  it('sends the label, visibility and height the layout has now, not as first read', async () => {
    const { api, fetchImpl, state } = setup();
    const found = await customer(api);
    // Renamed, hidden, made taller and moved to another group after the page read the layout.
    const moved = {
      ...picklistControl('c-customer', 'Client', CUSTOMER_INPUTS),
      visible: false,
      contribution: {
        contributionId: OUR_CONTRIBUTION,
        inputs: CUSTOMER_INPUTS,
        height: 72,
        showOnDeletedWorkItem: true,
      },
    };
    state.layout = {
      value: [
        {
          referenceName: 'ContosoAgile.Bug',
          name: 'Bug',
          layout: {
            pages: [{ sections: [{ groups: [{ id: 'Group.Moved', controls: [moved] }] }] }],
          },
        },
      ],
    };
    await updateControlInputs(api, found, migratedInputs(found, 'Customers'), null);
    const [input, init] = fetchImpl.mock.calls.find(([, call]) => call?.method === 'PATCH') ?? [];
    expect(input).toBe(
      `${BASE}_apis/work/processes/${PROCESS.id}/workItemTypes/ContosoAgile.Bug/layout/groups/Group.Moved/controls/c-customer?api-version=7.1`
    );
    expect(typeof init?.body === 'string' ? JSON.parse(init.body) : null).toEqual({
      id: 'c-customer',
      label: 'Client',
      readOnly: false,
      visible: false,
      contribution: {
        contributionId: OUR_CONTRIBUTION,
        inputs: { FieldName: 'Custom.Customer', Configuration: 'Customers' },
        height: 72,
        showOnDeletedWorkItem: true,
      },
      isContribution: true,
    });
  });

  it('says so, and changes nothing, when the control was removed since the page read it', async () => {
    const { api, fetchImpl, state } = setup();
    const found = await customer(api);
    state.layout = JSON.parse(
      JSON.stringify(layoutResponse()).replaceAll('"c-customer"', '"c-gone"')
    );
    const message =
      'The control Bug › Customer wasn’t found. It may have been changed or removed: refresh the list.';
    await expect(
      updateControlInputs(api, found, migratedInputs(found, 'Customers'), null)
    ).rejects.toThrow(message);
    // The work item type itself is gone.
    state.layout = { value: [] };
    await expect(
      updateControlInputs(api, found, migratedInputs(found, 'Customers'), null)
    ).rejects.toThrow(message);
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('sends inputs Azure DevOps kept again, empty, so a merging update ends up clean', async () => {
    const { api, state, fetchImpl } = setup();
    const found = await customer(api);
    // As if Azure DevOps merged the inputs instead of replacing them.
    let stored: Record<string, unknown> = { ...CUSTOMER_INPUTS };
    state.patch = (body) => {
      stored = { ...stored, ...sentInputs(body) };
      return json(picklistControl('c-customer', 'Customer', stored));
    };
    const updated = await updateControlInputs(api, found, migratedInputs(found, 'Customers'), null);
    const patches = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches).toHaveLength(2);
    const second = patches[1]?.[1]?.body;
    expect(sentInputs(typeof second === 'string' ? JSON.parse(second) : null)).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Customers',
      RestServiceAddress: '',
      AuthMethod: '',
      RestServiceUserName: '',
      RestServicePassword: '',
    });
    expect(controlStatus(updated)).toEqual({
      kind: 'configured',
      configuration: 'Customers',
      leftovers: false,
    });
    expect(updated.control).toMatchObject({ id: 'c-customer', label: 'Customer' });
  });

  it('says so when old inputs, a password among them, stay even when sent empty', async () => {
    const { api, state } = setup();
    const found = await customer(api);
    state.patch = (body) =>
      json(picklistControl('c-customer', 'Customer', { ...sentInputs(body), ...CUSTOMER_INPUTS }));
    const error = await leftovers(
      updateControlInputs(api, found, migratedInputs(found, 'Customers'), null)
    );
    expect(error.message).toBe(
      'The old settings, including the password, are still stored on this control. Try again, or remove the control from the form and add it again.'
    );
    expect(error.message).not.toContain(PASSWORD);
    // It still names its configuration: the page shows it as moved, but not clean.
    const { control, inputIds } = error;
    expect(controlStatus(control)).toEqual({
      kind: 'configured',
      configuration: 'Customers',
      leftovers: true,
    });
    expect(inputIds).toEqual([
      'RestServiceAddress',
      'AuthMethod',
      'RestServiceUserName',
      'RestServicePassword',
    ]);
  });

  it('reports leftovers when sending them again empty is refused', async () => {
    const { api, state } = setup();
    const found = await customer(api);
    let calls = 0;
    state.patch = (body) => {
      calls += 1;
      return calls === 1
        ? json(
            picklistControl('c-customer', 'Customer', { ...CUSTOMER_INPUTS, ...sentInputs(body) })
          )
        : json({ message: 'Unknown input.' }, 400);
    };
    const error = await leftovers(
      updateControlInputs(
        api,
        found,
        {
          FieldName: 'Custom.Customer',
          Configuration: 'C',
          RestServiceAddress: 'https://api.contoso.com/customers',
          AuthMethod: 'Basic',
          RestServiceUserName: 'svc-picklist',
        },
        null
      )
    );
    expect(error.inputIds).toEqual(['RestServicePassword']);
    expect(controlStatus(error.control)).toMatchObject({
      configuration: 'C',
      leftovers: true,
    });
  });

  it('uses the inputs sent when Azure DevOps doesn’t answer with the control', async () => {
    const { api, state } = setup();
    const found = await customer(api);
    state.patch = () => new Response(null, { status: 200 });
    const updated = await updateControlInputs(
      api,
      found,
      { FieldName: 'Custom.Customer', Configuration: 'C' },
      null
    );
    expect(updated.inputs).toEqual({ FieldName: 'Custom.Customer', Configuration: 'C' });
    expect(updated.control).toMatchObject({
      id: 'c-customer',
      contribution: {
        contributionId: OUR_CONTRIBUTION,
        inputs: { FieldName: 'Custom.Customer', Configuration: 'C' },
      },
    });
  });

  it('reports a change Azure DevOps didn’t keep', async () => {
    const { api, state } = setup();
    const found = await customer(api);
    state.patch = () => json(picklistControl('c-customer', 'Customer', CUSTOMER_INPUTS));
    await expect(
      updateControlInputs(api, found, migratedInputs(found, 'Customers'), null)
    ).rejects.toThrow(
      'Azure DevOps didn’t save the change. Open the “Contoso Agile” process and check Bug › Customer.'
    );
  });

  it('explains a missing “Edit process” permission', async () => {
    const { api, state } = setup();
    const found = await customer(api);
    for (const status of [401, 403]) {
      state.patch = () =>
        json({ message: 'VS402375: Access Denied: Ada needs Edit process permission.' }, status);
      const error = await failure(updateControlInputs(api, found, { FieldName: 'F' }, null));
      expect(error).toMatchObject({ kind: 'http', status });
      expect(error.message).toBe(
        'You don’t have permission to edit the “Contoso Agile” process. Ask a process administrator to change Bug › Customer, or to give you the “Edit process” permission.'
      );
    }
  });

  it('explains a control that no longer exists, and passes other failures on', async () => {
    const { api, state } = setup();
    const found = await customer(api);
    state.patch = () => json({ message: 'VS402805: Control not found.' }, 404);
    await expect(updateControlInputs(api, found, { FieldName: 'F' }, null)).rejects.toThrow(
      'The control Bug › Customer wasn’t found. It may have been changed or removed: refresh the list.'
    );
    state.patch = () => json({}, 500);
    await expect(updateControlInputs(api, found, { FieldName: 'F' }, null)).rejects.toThrow(
      /^Azure DevOps had a problem \(500\)/
    );
  });

  it('encodes ids in the path', async () => {
    const { api, fetchImpl, state } = setup();
    const found = await customer(api);
    state.layout = JSON.parse(
      JSON.stringify(layoutResponse())
        .replaceAll('"c-customer"', '"c?1"')
        .replaceAll('"Group.Customer"', '"Group/odd id"')
    );
    await updateControlInputs(
      api,
      { ...found, processId: 'p#1', groupId: 'Group/odd id', controlId: 'c?1' },
      { FieldName: 'Custom.Customer' },
      null
    );
    expect(fetchImpl.mock.calls.at(-2)?.[0]).toBe(
      `${BASE}_apis/work/processes/p%231/workItemTypes/ContosoAgile.Bug/layout?api-version=7.1`
    );
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe(
      `${BASE}_apis/work/processes/p%231/workItemTypes/ContosoAgile.Bug/layout/groups/Group%2Fodd%20id/controls/c%3F1?api-version=7.1`
    );
  });

  it('forgets the process’s cached 3.0 saved configurations, even when it fails', async () => {
    const { api, state } = setup();
    const found = await customer(api);
    const storage = memoryStorage();
    const key = savedConfigurationsCacheKey(api, PROCESS.id);
    expect(key).toBe(
      `rest-picklist:v1:saved:${encodeURIComponent(BASE)}:${encodeURIComponent(PROCESS.id)}`
    );
    storage.setItem(key, '{}');
    storage.setItem('other', '{}');
    await updateControlInputs(api, found, migratedInputs(found, 'Customers'), storage);
    expect([...storage.map.keys()]).toEqual(['other']);

    storage.setItem(key, '{}');
    state.patch = () => json({}, 403);
    await failure(updateControlInputs(api, found, migratedInputs(found, 'Customers'), storage));
    expect(storage.map.has(key)).toBe(false);
  });
});
