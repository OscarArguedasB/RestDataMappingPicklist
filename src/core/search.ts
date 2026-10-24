// Case- and accent-insensitive "contains" search, with prefix matches ranked first.
const COMBINING_MARKS = /[̀-ͯ]/g;

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

interface FoldedText {
  text: string;
  /** For each character of `text`, the index of the character it came from in the original. */
  origin: number[] | null;
}

function foldCharacter(character: string): string {
  return character.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

function foldWithOrigin(text: string): FoldedText {
  if (isAscii(text)) {
    return { text: text.toLowerCase(), origin: null };
  }
  // Folding character by character keeps a map back to the original for highlighting.
  let folded = '';
  const origin: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const piece = foldCharacter(text[index] ?? '');
    folded += piece;
    for (let repeat = 0; repeat < piece.length; repeat++) {
      origin.push(index);
    }
  }
  return { text: folded, origin };
}

export function foldText(text: string): string {
  return foldWithOrigin(text).text;
}

/** Something to search: a value and an optional second line, such as a `PicklistItem`. */
export interface Searchable {
  readonly value: string;
  readonly detail?: string | undefined;
}

export interface SearchIndex {
  /** The values, in the order given. */
  readonly items: readonly string[];
  readonly folded: readonly string[];
  /** Folded second lines ('' for items without one), or null when no item has one. */
  readonly foldedDetails: readonly string[] | null;
}

/** Indexes plain strings, or values with a second line (both lines are searched). */
export function createSearchIndex(items: readonly (string | Searchable)[]): SearchIndex {
  const values = items.map((item) => (typeof item === 'string' ? item : item.value));
  const details = items.map((item) => (typeof item === 'string' ? '' : (item.detail ?? '')));
  return {
    items: values,
    folded: values.map(foldText),
    foldedDetails: details.some(Boolean) ? details.map(foldText) : null,
  };
}

function queryWords(foldedQuery: string): string[] {
  return foldedQuery.split(/\s+/).filter(Boolean);
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function matchesAtWordStart(candidate: string, needle: string, from: number): boolean {
  for (let at = from; at > 0; at = candidate.indexOf(needle, at + 1)) {
    if (!WORD_CHARACTER.test(candidate[at - 1] ?? '')) {
      return true;
    }
  }
  return false;
}

// Match quality within one line: 0 starts with the query, 1 a word starts with it, 2 contains it.
function matchTier(candidate: string, needle: string): number {
  const at = candidate.indexOf(needle);
  if (at < 0) {
    return -1;
  }
  if (at === 0) {
    return 0;
  }
  return matchesAtWordStart(candidate, needle, at) ? 1 : 2;
}

const DETAIL_TIER_OFFSET = 3;
const ALL_WORDS_TIER = 6;

/**
 * Returns the indexes of matching items, best first: items starting with the query, items with
 * a word starting with it, items containing it anywhere, then the same three for the second
 * line, then (for multi-word queries) items containing every word in any order, in either line.
 * A match in the value always ranks above a match in the second line, because the value is what
 * people are looking for. Each group keeps the original order.
 */
export function searchItems(index: SearchIndex, query: string): number[] {
  const folded = foldText(query).trim();
  if (!folded) {
    return index.items.map((_item, position) => position);
  }
  const words = queryWords(folded);
  const details = index.foldedDetails;
  const groups: number[][] = Array.from({ length: ALL_WORDS_TIER + 1 }, () => []);
  index.folded.forEach((candidate, position) => {
    const detail = details?.[position] ?? '';
    let tier = matchTier(candidate, folded);
    if (tier < 0 && detail) {
      const detailTier = matchTier(detail, folded);
      tier = detailTier < 0 ? -1 : detailTier + DETAIL_TIER_OFFSET;
    }
    if (
      tier < 0 &&
      words.length > 1 &&
      words.every((word) => candidate.includes(word) || detail.includes(word))
    ) {
      tier = ALL_WORDS_TIER;
    }
    if (tier >= 0) {
      groups[tier]?.push(position);
    }
  });
  return groups.flat();
}

export type Range = readonly [start: number, end: number];

/** Character ranges of `text` that match `query`, for highlighting. */
export function matchRanges(text: string, query: string): Range[] {
  const needle = foldText(query).trim();
  if (!needle) {
    return [];
  }
  const { text: haystack, origin } = foldWithOrigin(text);
  const toOriginal = (start: number, end: number): Range =>
    origin ? [origin[start] ?? 0, (origin[end - 1] ?? text.length - 1) + 1] : [start, end];

  const whole = haystack.indexOf(needle);
  if (whole >= 0) {
    return [toOriginal(whole, whole + needle.length)];
  }
  const ranges: Range[] = [];
  for (const word of queryWords(needle)) {
    const at = haystack.indexOf(word);
    if (at >= 0) {
      ranges.push(toOriginal(at, at + word.length));
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])];
    } else {
      merged.push(range);
    }
  }
  return merged;
}
