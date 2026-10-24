import { describe, expect, it, vi } from 'vitest';
import { ResponseCache } from './cache';
import { parseConfig } from './config';
import { PicklistError } from './errors';
import { fieldMapUpdates, fieldMapUpdatesForRows, parseFieldMap } from './fieldMap';
import { findArrays, listProperties } from './inspect';
import { buildPicklistData, resolveRows } from './items';
import { getByPath, parsePath } from './path';
import { createSearchIndex, matchRanges, searchItems } from './search';
import { findFieldTokens, substituteForJson, substituteForUrl } from './tokens';

describe('getByPath', () => {
  const data = { data: { result: [{ name: 'a' }] }, 'odd.key': 1, list: [10, 20] };

  it('follows dotted and bracket paths', () => {
    expect(getByPath(data, 'data.result[0].name')).toBe('a');
    expect(getByPath(data, '$.data.result.0.name')).toBe('a');
    expect(getByPath(data, 'list[1]')).toBe(20);
    expect(getByPath(data, '')).toBe(data);
  });

  it('prefers a literal key that contains dots', () => {
    expect(getByPath(data, 'odd.key')).toBe(1);
  });

  it('never reaches inherited or prototype members', () => {
    expect(getByPath({}, '__proto__')).toBeUndefined();
    expect(getByPath({}, 'constructor.prototype')).toBeUndefined();
    expect(getByPath({ a: {} }, 'a.toString')).toBeUndefined();
  });

  it('parses quoted bracket segments', () => {
    expect(parsePath('a["b.c"][2]')).toEqual(['a', 'b.c', '2']);
  });
});

describe('field tokens', () => {
  it('finds each referenced field once, ignoring case', () => {
    expect(findFieldTokens('$(Custom.A)/x', '{"b":"$(custom.a)","c":"$( System.Id )"}')).toEqual([
      'Custom.A',
      'System.Id',
    ]);
  });

  it('escapes values so they cannot break out of a JSON string', () => {
    const json = substituteForJson('{ "q": "$(Custom.Q)" }', {
      'Custom.Q': 'x", "admin": "true',
    });
    expect(JSON.parse(json)).toEqual({ q: 'x", "admin": "true' });
  });

  it('does not expand tokens that appear inside inserted values', () => {
    expect(substituteForJson('"$(A)"', { A: '$(A)$(A)' })).toBe('"$(A)$(A)"');
  });

  it('URL-encodes values and treats missing fields as empty', () => {
    expect(substituteForUrl('/items/$(A)?b=$(B)', { a: 'x/y?z' })).toBe('/items/x%2Fy%3Fz?b=');
  });

  it('keeps zero instead of treating it as empty', () => {
    expect(substituteForJson('{"n": $(N)}', { N: 0 })).toBe('{"n": 0}');
  });
});

function values(rows: readonly unknown[], valueProperty: string): string[] {
  return buildPicklistData(rows, valueProperty).items.map((item) => item.value);
}

describe('buildPicklistData', () => {
  it('dedupes, skips blanks and sorts naturally', () => {
    const rows = [{ k: 'Item 10' }, { k: 'item 2' }, { k: 'Item 10' }, { k: '' }, { k: null }, {}];
    expect(values(rows, 'k')).toEqual(['item 2', 'Item 10']);
    expect(buildPicklistData(rows, 'k').items[0]).toEqual({ key: 'item 2', value: 'item 2' });
  });

  it('accepts arrays of plain values and numeric keys', () => {
    expect(values(['b', 'a', 3], '')).toEqual(['3', 'a', 'b']);
    expect(buildPicklistData(['b'], 'ignored').valueProperty).toBe('');
    expect(values([{ id: 5 }], 'id')).toEqual(['5']);
  });

  it('keeps the first row for each value for field mapping', () => {
    const { rows, valueProperty, detailProperty } = buildPicklistData(
      [
        { k: 'a', n: 1 },
        { k: 'a', n: 2 },
      ],
      'k'
    );
    expect(rows.get('a')).toEqual({ k: 'a', n: 1 });
    expect(valueProperty).toBe('k');
    expect(detailProperty).toBe('');
  });
});

describe('resolveRows', () => {
  it('finds the array at a path', () => {
    expect(resolveRows({ data: { items: [1] } }, 'data.items')).toEqual([1]);
  });

  it('falls back to a top-level array when the path is missing (pre-2.0 behavior)', () => {
    expect(resolveRows([1, 2], 'data')).toEqual([1, 2]);
  });

  it('explains what is wrong', () => {
    expect(() => resolveRows({ a: 1 }, 'data')).toThrow(/No list was found at “data”/);
    expect(() => resolveRows({ data: 1 }, 'data')).toThrow(/isn’t a list/);
    expect(() => resolveRows({ a: 1 }, '')).toThrow(PicklistError);
  });
});

const searchIndex = createSearchIndex([
  'Contoso',
  'Northwind Traders',
  'Tailspin Toys',
  'Crème Brûlée Co',
  'Tonga Imports',
]);

function searchNames(query: string): string[] {
  return searchItems(searchIndex, query).map((position) => searchIndex.items[position] ?? '');
}

describe('search', () => {
  it('matches anywhere in the text: prefix first, then word starts, then the rest', () => {
    expect(searchNames('to')).toEqual(['Tonga Imports', 'Tailspin Toys', 'Contoso']);
    expect(searchNames('TRADERS')).toEqual(['Northwind Traders']);
    expect(searchNames('')).toHaveLength(5);
  });

  it('ignores accents and matches all words in any order', () => {
    expect(searchNames('creme brulee')).toEqual(['Crème Brûlée Co']);
    expect(searchNames('toys tail')).toEqual(['Tailspin Toys']);
  });

  it('returns highlight ranges in the original text', () => {
    expect(matchRanges('Crème Brûlée', 'brulee')).toEqual([[6, 12]]);
    expect(matchRanges('Tailspin Toys', 'toys tail')).toEqual([
      [0, 4],
      [9, 13],
    ]);
  });
});

describe('field map', () => {
  it('parses valid maps and reports problems', () => {
    expect(parseFieldMap('{ "Custom.Id": "id" }')).toEqual({
      map: { 'Custom.Id': 'id' },
      error: null,
    });
    expect(parseFieldMap('not json').error).toMatch(/isn’t valid JSON/);
    expect(parseFieldMap('[1]').error).toMatch(/must be a JSON object/);
    expect(parseFieldMap('{ "A": 1, "B": "b" }')).toMatchObject({ map: { B: 'b' } });
    expect(parseFieldMap('   ')).toEqual({ map: null, error: null });
  });

  it('copies scalar values, including nested ones, and skips the rest', () => {
    const row = { id: 7, active: false, owner: { email: 'a@example.com' }, tags: ['x'] };
    expect(
      fieldMapUpdates(row, { A: 'id', B: 'active', C: 'owner.email', D: 'tags', E: 'missing' })
    ).toEqual({ A: 7, B: false, C: 'a@example.com' });
  });

  describe('with several picked rows', () => {
    const map = { Email: 'email', Team: 'team.name', Id: 'id' };
    const rows = [
      { id: 1, email: 'a@example.com', team: { name: 'Blue' } },
      { id: 2, team: { name: 'Blue' } },
      { id: 3, email: ' c@example.com ', team: { name: 'Green' } },
    ];

    it('joins every row’s value once with "all"', () => {
      expect(fieldMapUpdatesForRows(rows, map, 'all')).toEqual({
        Email: 'a@example.com; c@example.com',
        Team: 'Blue; Green',
        Id: '1; 2; 3',
      });
    });

    it('copies the first row with "first", clearing what it lacks', () => {
      expect(fieldMapUpdatesForRows(rows, map, 'first')).toEqual({
        Email: 'a@example.com',
        Team: 'Blue',
        Id: '1',
      });
      expect(fieldMapUpdatesForRows(rows.slice(1), map, 'first')).toMatchObject({ Email: '' });
    });

    it('clears every mapped field when nothing is picked', () => {
      expect(fieldMapUpdatesForRows([], map, 'all')).toEqual({ Email: '', Team: '', Id: '' });
      expect(fieldMapUpdatesForRows([], map, 'first')).toEqual({ Email: '', Team: '', Id: '' });
    });

    it('skips missing rows and non-text values, and handles no map', () => {
      expect(
        fieldMapUpdatesForRows(
          [undefined, { a: true, b: [1], c: { d: 1 } }],
          { A: 'a', B: 'b', C: 'c' },
          'all'
        )
      ).toEqual({ A: 'true', B: '', C: '' });
      expect(fieldMapUpdatesForRows(rows, null, 'all')).toEqual({});
    });
  });
});

describe('parseConfig', () => {
  it('reads inputs and checkbox values', () => {
    const config = parseConfig({
      FieldName: 'Custom.Customer',
      RestServiceAddress: ' https://api.example.com ',
      LoadOnFormOpen: 'true',
      Required: true,
      FieldMap: '{ "Custom.Id": "id" }',
    });
    expect(config).toMatchObject({
      fieldName: 'Custom.Customer',
      url: 'https://api.example.com',
      loadOnFormOpen: true,
      required: true,
      fieldMap: { 'Custom.Id': 'id' },
    });
    expect(parseConfig(undefined).loadOnFormOpen).toBe(false);
  });
});

describe('ResponseCache', () => {
  it('shares in-flight and recent requests, and forgets failures', async () => {
    let now = 0;
    const cache = new ResponseCache<number>(1000, 10, () => now);
    const load = vi.fn<() => Promise<number>>(async () => 1);
    await Promise.all([cache.get('k', load), cache.get('k', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 2000;
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
    await cache.get('k', load, { refresh: true });
    expect(load).toHaveBeenCalledTimes(3);

    const failing = vi.fn<() => Promise<number>>(async () => {
      throw new Error('boom');
    });
    await expect(cache.get('f', failing)).rejects.toThrow('boom');
    await expect(cache.get('f', failing)).rejects.toThrow('boom');
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('inspect', () => {
  it('lists arrays by size and properties with samples', () => {
    const response = {
      meta: { tags: ['a'] },
      data: { users: [{ id: 1, profile: { email: 'e' } }, {}] },
    };
    expect(findArrays(response)).toEqual([
      { path: 'data.users', length: 2 },
      { path: 'meta.tags', length: 1 },
    ]);
    expect(listProperties(response.data.users[0])).toEqual([
      { path: 'id', sample: '1' },
      { path: 'profile.email', sample: 'e' },
    ]);
  });
});
