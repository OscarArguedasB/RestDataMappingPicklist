import { describe, expect, it } from 'vitest';
import {
  SAMPLE_SIZE,
  detectList,
  rankLists,
  suggestDetailProperties,
  suggestValueProperties,
} from './detect';

const objects = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index }));

describe('rankLists and detectList', () => {
  it('always takes a response that is itself a list', () => {
    const response = [{ id: 1 }];
    expect(detectList(response)).toEqual({ path: '', rows: response });
    expect(rankLists(response)).toEqual([{ path: '', length: 1, score: expect.any(Number) }]);
    expect(detectList([])).toEqual({ path: '', rows: [] });
  });

  it('prefers arrays of objects over longer arrays of plain values', () => {
    const response = { tags: ['a', 'b', 'c', 'd', 'e', 'f'], users: objects(2) };
    expect(detectList(response)?.path).toBe('users');
    expect(rankLists(response).map((list) => list.path)).toEqual(['users', 'tags']);
  });

  it('prefers much longer lists, even a little deeper', () => {
    const response = { recent: objects(3), page: { people: objects(300) } };
    expect(detectList(response)?.path).toBe('page.people');
  });

  it('breaks near-ties with the depth and common list names', () => {
    expect(detectList({ meta: { related: objects(25) }, data: objects(20) })?.path).toBe('data');
    expect(detectList({ related: objects(12), items: objects(10) })?.path).toBe('items');
    expect(detectList({ a: { list: objects(5) }, b: objects(5) })?.path).toBe('b');
  });

  it('doesn’t take an error list for the rows when the real list is empty', () => {
    const response = { value: [], errors: [{ message: 'Partial results' }] };
    expect(detectList(response)?.path).toBe('value');
  });

  it('falls back to lists of plain values, and to nothing', () => {
    expect(detectList({ result: { names: ['a', 'b'] } })).toEqual({
      path: 'result.names',
      rows: ['a', 'b'],
    });
    expect(detectList({ a: 1, b: { c: 'x' } })).toBeNull();
    expect(detectList('text')).toBeNull();
    expect(rankLists(null)).toEqual([]);
  });

  it('reports usable paths for odd keys', () => {
    const response = { 'odd key': objects(2) };
    expect(detectList(response)).toEqual({ path: '["odd key"]', rows: response['odd key'] });
  });

  it('is deterministic for equal candidates', () => {
    const response = { b: objects(4), a: objects(4) };
    expect(rankLists(response).map((list) => list.path)).toEqual(['a', 'b']);
    expect(rankLists(response)).toEqual(rankLists({ a: objects(4), b: objects(4) }));
  });
});

const customers = [
  {
    id: 101,
    guid: '0f8fad5b-d9cb-469f-a165-70867728950e',
    name: 'Contoso',
    email: 'hello@contoso.com',
    url: 'https://api.example.com/customers/101',
    active: true,
    created: '2024-01-05T10:00:00Z',
    description:
      'A large manufacturer of widgets and gadgets for companies around the world, since 1950.',
    department: 'Sales',
  },
  {
    id: 102,
    guid: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    name: 'Fabrikam',
    email: 'info@fabrikam.com',
    url: 'https://api.example.com/customers/102',
    active: false,
    created: '2024-02-11T08:30:00Z',
    description:
      'Builds bridges, tunnels, dams and other large structures in many countries and regions.',
    department: 'Sales',
  },
  {
    id: 103,
    guid: '16fd2706-8baf-433b-82eb-8c7fada847da',
    name: 'Northwind',
    email: 'contact@northwind.com',
    url: 'https://api.example.com/customers/103',
    active: true,
    created: '2024-03-20T14:15:00Z',
    description:
      'Imports and exports speciality foods from around the world to small shops and markets.',
    department: 'Support',
  },
];

describe('suggestValueProperties', () => {
  it('ranks the name first and explains why', () => {
    const [best] = suggestValueProperties(customers);
    expect(best).toEqual({
      path: 'name',
      score: expect.any(Number),
      reason: 'Looks like a name, unique text in every item',
      sample: 'Contoso',
    });
  });

  it('ranks IDs, GUIDs, web addresses, dates, long text and booleans low', () => {
    const paths = suggestValueProperties(customers, 20).map((suggestion) => suggestion.path);
    const rank = (path: string) => paths.indexOf(path);
    for (const poor of ['id', 'guid', 'url', 'created', 'description', 'active']) {
      expect(rank(poor)).toBeGreaterThan(rank('name'));
      expect(rank(poor)).toBeGreaterThan(rank('email'));
    }
    expect(paths.at(-1)).toBe('active');
  });

  it('writes plain-language reasons', () => {
    const reasons = Object.fromEntries(
      suggestValueProperties(customers, 20).map((suggestion) => [
        suggestion.path,
        suggestion.reason,
      ])
    );
    expect(reasons).toMatchObject({
      id: 'Looks like an ID, unique numbers in every item',
      guid: 'Looks like an ID, unique text in every item',
      url: 'Looks like a web address, unique text in every item',
      created: 'Looks like a date, unique text in every item',
      email: 'Looks like an email address, unique text in every item',
      description: 'Looks like a description, unique long text in every item',
      active: 'True/false values in every item',
      department: 'Looks like a team or organization, text in every item',
    });
  });

  it('notices values that repeat, are missing or never change', () => {
    const rows = [
      { status: 'Open', region: 'EU', kind: 'x', code: 'A1' },
      { status: 'Open', region: 'EU', kind: 'x' },
      { status: 'Closed', region: 'US', kind: 'x' },
      { status: 'Open', region: 'EU', kind: 'x' },
      { status: 'Open', kind: 'x', code: 'B2' },
    ];
    const reasons = Object.fromEntries(
      suggestValueProperties(rows, 10).map((suggestion) => [suggestion.path, suggestion.reason])
    );
    expect(reasons).toEqual({
      status: 'Looks like a category or status, text in every item, often repeated',
      region: 'Looks like a place, text in most items',
      kind: 'Looks like a category or status, same text in every item',
      code: 'Looks like a code or key, unique text in some items',
    });
  });

  it('suggests plain text properties without name hints by their data', () => {
    const rows = [
      { a: 'Alpha', b: 'x', c: 1 },
      { a: 'Beta', b: 'x', c: 2 },
    ];
    expect(suggestValueProperties(rows).map((suggestion) => suggestion.path)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(suggestValueProperties(rows)[0]?.reason).toBe('Unique text in every item');
  });

  it('looks one level into nested objects', () => {
    const rows = [
      { id: 1, profile: { displayName: 'Ana', photoUrl: 'https://x.test/a.png' } },
      { id: 2, profile: { displayName: 'Bo', photoUrl: 'https://x.test/b.png' } },
    ];
    expect(suggestValueProperties(rows)[0]?.path).toBe('profile.displayName');
  });

  it('never suggests secrets first', () => {
    const rows = [
      { title: 'One', token: 'abc123def', password: 'p1' },
      { title: 'Two', token: 'ghi456jkl', password: 'p2' },
    ];
    const suggestions = suggestValueProperties(rows);
    expect(suggestions[0]?.path).toBe('title');
    expect(suggestions.find((suggestion) => suggestion.path === 'token')?.reason).toMatch(
      /^Looks like a secret/
    );
  });

  it('shortens samples and respects the limit', () => {
    const rows = [{ name: 'x'.repeat(80) }, { name: 'y' }];
    expect(suggestValueProperties(rows)[0]?.sample).toBe(`${'x'.repeat(57)}…`);
    expect(suggestValueProperties(customers, 2)).toHaveLength(2);
    expect(suggestValueProperties(customers, 0)).toEqual([]);
  });

  it('returns nothing for lists of plain values', () => {
    expect(suggestValueProperties(['a', 'b'])).toEqual([]);
    expect(suggestValueProperties([])).toEqual([]);
    expect(suggestValueProperties([{ nothing: null }, { empty: '  ' }])).toEqual([]);
  });

  it('is deterministic', () => {
    expect(suggestValueProperties(customers, 20)).toEqual(suggestValueProperties(customers, 20));
  });

  it('reads at most SAMPLE_SIZE rows of a huge list', () => {
    const touched = new Set<number>();
    const rows = Array.from({ length: 50_000 }, (_, index) => {
      const row = { id: index };
      Object.defineProperty(row, 'name', {
        enumerable: true,
        get: () => {
          touched.add(index);
          return `Item ${index}`;
        },
      });
      return row;
    });
    const started = performance.now();
    expect(suggestValueProperties(rows)[0]?.path).toBe('name');
    expect(suggestDetailProperties(rows, '')[0]?.path).toBe('id');
    expect(rankLists({ value: rows })[0]?.path).toBe('value');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(touched.size).toBeLessThanOrEqual(SAMPLE_SIZE);
    // Spread over the whole list, not just its start.
    expect(Math.max(...touched)).toBeGreaterThan(49_000);
  });
});

describe('suggestDetailProperties', () => {
  it('suggests email, department and description, never the value property', () => {
    const suggestions = suggestDetailProperties(customers, 'name');
    const paths = suggestions.map((suggestion) => suggestion.path);
    expect(paths).not.toContain('name');
    expect(paths[0]).toBe('email');
    expect(paths).toEqual(expect.arrayContaining(['department', 'description']));
    expect(suggestions[0]?.reason).toBe('Looks like an email address, unique text in every item');
  });

  it('leaves out the automatically picked value property when none is set', () => {
    expect(
      suggestDetailProperties(customers, '').map((suggestion) => suggestion.path)
    ).not.toContain('name');
  });

  it('ranks the name as a second line when the value is a code', () => {
    const rows = [
      { code: 'CT', name: 'Contoso' },
      { code: 'FB', name: 'Fabrikam' },
    ];
    expect(suggestDetailProperties(rows, 'code')[0]?.path).toBe('name');
  });

  it('ranks down second lines that repeat the value', () => {
    const rows = [
      { name: 'Ana', label: 'Ana', team: 'Blue' },
      { name: 'Bo', label: 'Bo', team: 'Green' },
    ];
    const suggestions = suggestDetailProperties(rows, 'name');
    expect(suggestions[0]?.path).toBe('team');
    expect(suggestions.find((suggestion) => suggestion.path === 'label')?.reason).toBe(
      'Same as the value, looks like a title or label, unique text in every item'
    );
  });
});
