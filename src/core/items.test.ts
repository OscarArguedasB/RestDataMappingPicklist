import { describe, expect, it } from 'vitest';
import { PicklistError } from './errors';
import { IncrementalPicklistBuilder, buildPicklistData, itemsWithValue, locateRows } from './items';

const people = [
  { id: 1, name: 'Ana Pérez', email: 'ana@example.com', team: 'Blue' },
  { id: 2, name: 'Bo Chen', email: 'bo@example.com', team: 'Green' },
  { id: 3, name: 'Ana Pérez', email: 'ana.p@example.com', team: 'Blue' },
  { id: 4, name: 'Ana Pérez', email: 'ana@example.com', team: 'Red' },
];

describe('buildPicklistData with a second line', () => {
  it('keeps items with the same value but different second lines apart', () => {
    const data = buildPicklistData(people, 'name', 'email');
    expect(data.items).toEqual([
      { key: 'Ana Pérez\u001fana.p@example.com', value: 'Ana Pérez', detail: 'ana.p@example.com' },
      { key: 'Ana Pérez\u001fana@example.com', value: 'Ana Pérez', detail: 'ana@example.com' },
      { key: 'Bo Chen\u001fbo@example.com', value: 'Bo Chen', detail: 'bo@example.com' },
    ]);
    expect(data.detailProperty).toBe('email');
  });

  it('maps each key to the first row that has it', () => {
    const data = buildPicklistData(people, 'name', 'email');
    expect(data.rows.get('Ana Pérez\u001fana@example.com')).toBe(people[0]);
    expect(data.rows.size).toBe(3);
  });

  it('uses the plain value as the key when a row has no second line', () => {
    const data = buildPicklistData([{ n: 'A', d: 'x' }, { n: 'A' }, { n: 'A', d: '  ' }], 'n', 'd');
    expect(data.items).toEqual([
      { key: 'A', value: 'A' },
      { key: 'A\u001fx', value: 'A', detail: 'x' },
    ]);
  });

  it('makes second lines a single line and cuts very long ones', () => {
    const long = 'word '.repeat(200);
    const data = buildPicklistData(
      [
        { n: 'A', d: 'first\n  second' },
        { n: 'B', d: long },
      ],
      'n',
      'd'
    );
    expect(data.items[0]?.detail).toBe('first second');
    const cut = data.items[1]?.detail ?? '';
    expect(cut.length).toBe(500);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('never splits an emoji when cutting', () => {
    const detail = `${'a'.repeat(498)}😀tail`;
    const cut = buildPicklistData([{ n: 'A', d: detail }], 'n', 'd').items[0]?.detail ?? '';
    expect(cut).toBe(`${'a'.repeat(498)}…`);
  });

  it('ignores a second line that is the value property itself', () => {
    const data = buildPicklistData(people, 'name', 'name');
    expect(data.detailProperty).toBe('');
    expect(data.items.map((item) => item.value)).toEqual(['Ana Pérez', 'Bo Chen']);
  });

  it('sorts by value, then second line, keeping the response order for ties', () => {
    const rows = [
      { n: 'b', d: '2' },
      { n: 'B', d: '1' },
      { n: 'a', d: '10' },
      { n: 'a', d: '9' },
      { n: 'b', d: '1' },
    ];
    expect(
      buildPicklistData(rows, 'n', 'd').items.map((item) => `${item.value}/${item.detail}`)
    ).toEqual(['a/9', 'a/10', 'B/1', 'b/1', 'b/2']);
  });

  it('shows no second line for plain values', () => {
    const data = buildPicklistData(['x', 'y'], '', 'd');
    expect(data.items).toEqual([
      { key: 'x', value: 'x' },
      { key: 'y', value: 'y' },
    ]);
    expect(data.detailProperty).toBe('');
  });
});

describe('buildPicklistData without a value property', () => {
  it('picks the most name-like property automatically', () => {
    const data = buildPicklistData(people, '');
    expect(data.valueProperty).toBe('name');
    expect(data.items.map((item) => item.value)).toEqual(['Ana Pérez', 'Bo Chen']);
  });

  it('prefers a readable name over an ID or a GUID', () => {
    const rows = [
      { guid: '0f8fad5b-d9cb-469f-a165-70867728950e', code: 7, displayName: 'Contoso' },
      { guid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', code: 8, displayName: 'Fabrikam' },
    ];
    expect(buildPicklistData(rows, '').valueProperty).toBe('displayName');
  });

  it('keeps the configured property, even when rows are empty', () => {
    expect(buildPicklistData([], ' name ').valueProperty).toBe('name');
    expect(buildPicklistData([], '').valueProperty).toBe('');
    expect(buildPicklistData(people, 'email').valueProperty).toBe('email');
  });

  it('takes plain values as they are in a mixed list', () => {
    const data = buildPicklistData(['Loose', { name: 'Ana' }], '');
    expect(data.valueProperty).toBe('name');
    expect(data.items.map((item) => item.value)).toEqual(['Ana', 'Loose']);
  });

  it('builds 50,000 items quickly', () => {
    const rows = Array.from({ length: 50_000 }, (_, index) => ({
      id: index,
      name: `Customer ${index}`,
      email: `c${index}@example.com`,
    }));
    const started = performance.now();
    const data = buildPicklistData(rows, '', 'email');
    const elapsed = performance.now() - started;
    expect(data.valueProperty).toBe('name');
    expect(data.items).toHaveLength(50_000);
    expect(data.items[0]?.value).toBe('Customer 0');
    expect(data.items[49_999]?.value).toBe('Customer 49999');
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('IncrementalPicklistBuilder', () => {
  it('gives the same result as buildPicklistData, added in one batch or several', () => {
    const rows = [
      { n: 'b', d: '2' },
      { n: 'B', d: '1' },
      { n: 'a', d: '10' },
      { n: 'a', d: '9' },
      { n: 'b', d: '1' },
    ];
    const whole = buildPicklistData(rows, 'n', 'd');

    const builder = new IncrementalPicklistBuilder('n', 'd');
    builder.add(rows.slice(0, 2));
    builder.add(rows.slice(2, 4));
    builder.add(rows.slice(4));
    const finished = builder.finish();

    expect(finished.items).toEqual(whole.items);
    expect(finished.valueProperty).toBe(whole.valueProperty);
    expect(finished.detailProperty).toBe(whole.detailProperty);
    expect([...finished.rows.keys()]).toEqual([...whole.rows.keys()]);
  });

  it('keeps items in the order first seen until finish() sorts them once', () => {
    const builder = new IncrementalPicklistBuilder('n');
    builder.add([{ n: 'z' }, { n: 'a' }]);
    expect(builder.snapshot.items.map((item) => item.value)).toEqual(['z', 'a']);
    builder.add([{ n: 'm' }]);
    // Still first-seen order: the list an open popup shows hasn't been reordered mid-stream.
    expect(builder.snapshot.items.map((item) => item.value)).toEqual(['z', 'a', 'm']);
    expect(builder.finish().items.map((item) => item.value)).toEqual(['a', 'm', 'z']);
  });

  it('drops a duplicate key seen in a later batch, keeping the earlier row', () => {
    const first = { n: 'Ana', tag: 'first' };
    const second = { n: 'Ana', tag: 'second' };
    const builder = new IncrementalPicklistBuilder('n');
    builder.add([first]);
    builder.add([second]);
    const data = builder.finish();
    expect(data.items).toHaveLength(1);
    expect(data.rows.get('Ana')).toBe(first);
  });

  it('resolves the value and second-line property once, from the first batch', () => {
    const builder = new IncrementalPicklistBuilder('', '');
    // The first batch has no obviously name-like property besides "label"; later batches (which
    // alone might suggest something else) don't change what was already decided.
    builder.add([{ id: 1, label: 'One' }]);
    builder.add([{ id: 2, label: 'Two', title: 'Second title-ish field' }]);
    const data = builder.finish();
    expect(data.valueProperty).toBe('label');
    expect(data.items.map((item) => item.value)).toEqual(['One', 'Two']);
  });

  it('snapshot returns a fresh array each time, so callers relying on reference equality see a change', () => {
    const builder = new IncrementalPicklistBuilder('n');
    builder.add([{ n: 'a' }]);
    const first = builder.snapshot.items;
    builder.add([{ n: 'b' }]);
    const second = builder.snapshot.items;
    expect(first).not.toBe(second);
    expect(first).toEqual([{ key: 'a', value: 'a' }]);
  });

  it('does no more work than its own batch, batch after batch', () => {
    const batches = Array.from({ length: 100 }, (_page, page) =>
      Array.from({ length: 500 }, (_row, row) => ({
        id: page * 500 + row,
        name: `Customer ${page * 500 + row}`,
      }))
    );
    const builder = new IncrementalPicklistBuilder('name');
    const started = performance.now();
    for (const batch of batches) {
      builder.add(batch);
    }
    const finished = builder.finish();
    const elapsed = performance.now() - started;
    expect(finished.items).toHaveLength(50_000);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('itemsWithValue', () => {
  const data = buildPicklistData(
    [
      { n: 'Ana', d: 'Blue' },
      { n: 'Ana', d: 'Red' },
      { n: ' Bo ', d: 'Green' },
    ],
    'n',
    'd'
  );

  it('finds every item with the value', () => {
    expect(itemsWithValue(data, 'Ana').map((item) => item.detail)).toEqual(['Blue', 'Red']);
    expect(itemsWithValue(data, 'ana')).toEqual([]);
  });

  it('matches values saved without their surrounding spaces', () => {
    expect(itemsWithValue(data, 'Bo').map((item) => item.value)).toEqual([' Bo ']);
    expect(itemsWithValue(data, ' Bo ')).toHaveLength(1);
    expect(itemsWithValue(data, '  ')).toEqual([]);
  });
});

describe('locateRows', () => {
  it('uses the configured path', () => {
    expect(locateRows({ data: { items: [1] } }, ' data.items ')).toEqual({
      rows: [1],
      path: 'data.items',
    });
  });

  it('finds the list automatically without a path', () => {
    const response = { count: 2, value: [{ name: 'a' }, { name: 'b' }] };
    expect(locateRows(response, '')).toEqual({ rows: response.value, path: 'value' });
    expect(locateRows(['x'], '')).toEqual({ rows: ['x'], path: '' });
  });

  it('explains when there is no list at all', () => {
    expect(() => locateRows({ a: 1 }, '')).toThrow(PicklistError);
    expect(() => locateRows({ a: 1 }, '')).toThrow(/No list was found in the response/);
  });
});
