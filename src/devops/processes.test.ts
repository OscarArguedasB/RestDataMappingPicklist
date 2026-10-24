import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import {
  PROCESSES_PATH,
  canHoldControls,
  findProcessForProject,
  listProcesses,
  parseProcesses,
  processForProject,
} from './processes';
import type { DevOpsApi } from './rest';

// Shaped like GET _apis/work/processes?$expand=projects&api-version=7.1
const PROCESSES_RESPONSE = {
  count: 3,
  value: [
    {
      typeId: 'adcc42ab-9882-485e-a3ed-7678f01f66bc',
      referenceName: null,
      name: 'Agile',
      description: 'This template is flexible and will work great for most teams.',
      parentProcessTypeId: '00000000-0000-0000-0000-000000000000',
      isEnabled: true,
      isDefault: true,
      customizationType: 'System',
    },
    {
      typeId: 'e31fd6e1-c6af-44bb-925e-dfa71f551463',
      referenceName: 'Inherited.e31fd6e1c6af44bb925edfa71f551463',
      name: 'Contoso Agile',
      description: '',
      parentProcessTypeId: 'adcc42ab-9882-485e-a3ed-7678f01f66bc',
      isEnabled: true,
      isDefault: false,
      customizationType: 'Inherited',
      projects: [
        {
          id: '0a5a3a5d-6b3b-4a4f-9d0b-0c3b8a1c2d3e',
          name: 'Fabrikam Fiber',
          description: '',
          url: 'https://dev.azure.com/contoso/_apis/projects/0a5a3a5d-6b3b-4a4f-9d0b-0c3b8a1c2d3e',
        },
        { id: 'b7d1f0c2-1111-2222-3333-444455556666', name: 'Payments' },
      ],
    },
    {
      typeId: '27450541-8e31-4150-9947-dc59f998fc01',
      name: 'Basic Retired',
      isEnabled: false,
      customizationType: 'Inherited',
      projects: [{ id: 'c0ffee00-0000-0000-0000-000000000001', name: 'Archive' }],
    },
    { name: 'No id' },
    'not an object',
  ],
};

function fakeApi(response: unknown, collectionUrl = 'https://dev.azure.com/contoso/') {
  const get = vi.fn<DevOpsApi['get']>(async () => response);
  const api: DevOpsApi = {
    collectionUrl,
    get,
    patch: async () => undefined,
    post: async () => undefined,
  };
  return { api, get };
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

describe('listProcesses', () => {
  it('reads processes with their projects', async () => {
    const { api, get } = fakeApi(PROCESSES_RESPONSE);
    const processes = await listProcesses(api);
    expect(get).toHaveBeenCalledWith(
      '_apis/work/processes?$expand=projects&api-version=7.1',
      expect.objectContaining({ action: 'read the organization’s processes' })
    );
    expect(PROCESSES_PATH).toBe('_apis/work/processes?$expand=projects&api-version=7.1');
    expect(processes.map((process) => process.name)).toEqual([
      'Agile',
      'Basic Retired',
      'Contoso Agile',
    ]);
    expect(processes[2]).toEqual({
      id: 'e31fd6e1-c6af-44bb-925e-dfa71f551463',
      name: 'Contoso Agile',
      customizationType: 'inherited',
      isEnabled: true,
      projectNames: ['Fabrikam Fiber', 'Payments'],
      projectIds: ['0a5a3a5d-6b3b-4a4f-9d0b-0c3b8a1c2d3e', 'b7d1f0c2-1111-2222-3333-444455556666'],
      parentProcessTypeId: 'adcc42ab-9882-485e-a3ed-7678f01f66bc',
    });
    expect(processes[0]).toMatchObject({ customizationType: 'system', projectNames: [] });
    expect(processes[1]).toMatchObject({ isEnabled: false });
  });

  it('notes the parent process, or none', async () => {
    const processes = await listProcesses(fakeApi(PROCESSES_RESPONSE).api);
    expect(processes.map((process) => process.parentProcessTypeId)).toEqual([
      // System processes have an empty parent.
      '',
      // Missing.
      '',
      'adcc42ab-9882-485e-a3ed-7678f01f66bc',
    ]);
    expect(parseProcesses([{ typeId: 'p', name: 'P', parentProcessTypeId: 42 }])).toMatchObject([
      { parentProcessTypeId: '' },
    ]);
  });

  it('tells which processes can hold the control', async () => {
    const processes = await listProcesses(fakeApi(PROCESSES_RESPONSE).api);
    expect(processes.map((process) => [process.name, canHoldControls(process)])).toEqual([
      ['Agile', false],
      ['Basic Retired', true],
      ['Contoso Agile', true],
    ]);
    expect(canHoldControls({ customizationType: 'custom' })).toBe(true);
    expect(canHoldControls({ customizationType: '' })).toBe(false);
  });

  it('rejects an unexpected response', async () => {
    await expect(listProcesses(fakeApi({ message: 'nope' }).api)).rejects.toThrow(PicklistError);
    expect(() => parseProcesses(null)).toThrow(/unexpected list of processes/);
    expect(parseProcesses([])).toEqual([]);
  });
});

describe('findProcessForProject', () => {
  it('finds the process by project name, ignoring case', async () => {
    const { api } = fakeApi(PROCESSES_RESPONSE);
    await expect(findProcessForProject(api, 'fabrikam fiber')).resolves.toMatchObject({
      name: 'Contoso Agile',
    });
    await expect(findProcessForProject(api, ' PAYMENTS ')).resolves.toMatchObject({
      id: 'e31fd6e1-c6af-44bb-925e-dfa71f551463',
    });
    // Disabled processes still serve their existing projects.
    await expect(findProcessForProject(api, 'Archive')).resolves.toMatchObject({
      name: 'Basic Retired',
    });
  });

  it('also accepts a project id', async () => {
    const { api } = fakeApi(PROCESSES_RESPONSE);
    await expect(
      findProcessForProject(api, 'B7D1F0C2-1111-2222-3333-444455556666')
    ).resolves.toMatchObject({ name: 'Contoso Agile' });
  });

  it('returns null for unknown or empty project names', async () => {
    const { api, get } = fakeApi(PROCESSES_RESPONSE);
    await expect(findProcessForProject(api, 'Unknown')).resolves.toBeNull();
    get.mockClear();
    await expect(findProcessForProject(api, '  ')).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('processForProject', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the answer for five minutes, per organization', async () => {
    const storage = memoryStorage();
    const { api, get } = fakeApi(PROCESSES_RESPONSE);
    const expected = { id: 'e31fd6e1-c6af-44bb-925e-dfa71f551463', name: 'Contoso Agile' };
    await expect(processForProject(api, 'Fabrikam Fiber', storage)).resolves.toEqual(expected);
    await expect(processForProject(api, ' fabrikam fiber ', storage)).resolves.toEqual(expected);
    expect(get).toHaveBeenCalledTimes(1);

    const other = fakeApi(PROCESSES_RESPONSE, 'https://dev.azure.com/fabrikam/');
    await processForProject(other.api, 'Fabrikam Fiber', storage);
    expect(other.get).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await processForProject(api, 'Fabrikam Fiber', storage);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('doesn’t keep unknown projects, and checks what it kept', async () => {
    const storage = memoryStorage();
    const { api, get } = fakeApi(PROCESSES_RESPONSE);
    await expect(processForProject(api, 'Unknown', storage)).resolves.toBeNull();
    expect(storage.map.size).toBe(0);

    await processForProject(api, 'Payments', storage);
    const [key] = [...storage.map.keys()];
    if (!key) {
      throw new Error('Expected a cache entry');
    }
    storage.setItem(key, JSON.stringify({ expires: Date.now() + 1000, data: { id: 5 } }));
    await expect(processForProject(api, 'Payments', storage)).resolves.toMatchObject({
      name: 'Contoso Agile',
    });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('works without storage', async () => {
    const { api, get } = fakeApi(PROCESSES_RESPONSE);
    await processForProject(api, 'Payments', null);
    await processForProject(api, 'Payments', null);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
