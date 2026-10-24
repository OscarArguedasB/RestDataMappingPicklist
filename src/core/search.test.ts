import { describe, expect, it } from 'vitest';
import { createSearchIndex, matchRanges, searchItems } from './search';

const PEOPLE = [
  { value: 'Ana Silva', detail: 'Sales, Lisbon' },
  { value: 'Ben Ortiz', detail: 'Support' },
  { value: 'Support desk', detail: 'Shared mailbox' },
  { value: 'Zoë Adams' },
  { value: 'Chloé Martin', detail: 'Crème team' },
];

function search(query: string): string[] {
  const index = createSearchIndex(PEOPLE);
  return searchItems(index, query).map((position) => PEOPLE[position]?.value ?? '');
}

describe('search with a second line', () => {
  it('indexes values and second lines, and skips second lines when there are none', () => {
    const index = createSearchIndex(PEOPLE);
    expect(index.items).toEqual(PEOPLE.map((person) => person.value));
    expect(index.foldedDetails?.[3]).toBe('');
    expect(index.foldedDetails?.[4]).toBe('creme team');
    expect(createSearchIndex([{ value: 'A' }, 'B']).foldedDetails).toBeNull();
    expect(createSearchIndex(['A', 'B']).foldedDetails).toBeNull();
  });

  it('returns everything, in order, for an empty query', () => {
    expect(search('  ')).toEqual(PEOPLE.map((person) => person.value));
  });

  it('finds items by their second line, case- and accent-insensitively', () => {
    expect(search('lisbon')).toEqual(['Ana Silva']);
    expect(search('CREME')).toEqual(['Chloé Martin']);
  });

  it('ranks value matches above second-line matches', () => {
    // "Support desk" starts with it; "Ben Ortiz" only has it in the second line.
    expect(search('support')).toEqual(['Support desk', 'Ben Ortiz']);
    // Starts with, word start, contains (all in the value), then the second line.
    expect(search('s')).toEqual(['Support desk', 'Ana Silva', 'Zoë Adams', 'Ben Ortiz']);
  });

  it('ranks second-line matches by quality too', () => {
    const index = createSearchIndex([
      { value: 'A', detail: 'Mailbox for sales' },
      { value: 'B', detail: 'Salesforce' },
      { value: 'C', detail: 'Presales' },
    ]);
    expect(searchItems(index, 'sales')).toEqual([1, 0, 2]);
  });

  it('matches every word of a multi-word query across both lines', () => {
    expect(search('ana lisbon')).toEqual(['Ana Silva']);
    expect(search('ben support')).toEqual(['Ben Ortiz']);
    expect(search('ana support')).toEqual([]);
  });

  it('keeps plain string lists working', () => {
    const index = createSearchIndex(['Tailspin Toys', 'Toys R Us', 'Contoso']);
    expect(searchItems(index, 'toys')).toEqual([1, 0]);
  });

  it('highlights the second line on its own', () => {
    expect(matchRanges('Crème team', 'creme')).toEqual([[0, 5]]);
    expect(matchRanges('Sales, Lisbon', 'ana lisbon')).toEqual([[7, 13]]);
  });
});
