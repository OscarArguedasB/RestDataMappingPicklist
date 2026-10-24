import { findArrays, listProperties } from './inspect';
import { getByPath, parsePath } from './path';
import { isPlainObject } from './values';

// Guesses what an administrator would otherwise have to type: where the list is in a response,
// which property holds the values and which one makes a good second line. Everything here is
// deterministic (the same response always gives the same answer) and looks at a bounded sample,
// so it stays fast on lists of 50,000 rows.

/** A list in a response that could hold the rows. */
export interface ListCandidate {
  /** Value for "JSON path to the list" ('' when the response itself is the list). */
  path: string;
  length: number;
  /** Higher is more likely to be the list of rows; only meaningful for ordering. */
  score: number;
}

/** A property that could supply the values (or the second lines), with why it's suggested. */
export interface PropertySuggestion {
  path: string;
  /** Higher is better; only meaningful for ordering. */
  score: number;
  /** Plain-language explanation for administrators, e.g. “Looks like a name, unique text in every item”. */
  reason: string;
  /** A value from the response, shortened. */
  sample: string;
}

/** Rows looked at when judging a list or a property. */
export const SAMPLE_SIZE = 200;

/**
 * Up to SAMPLE_SIZE rows, evenly spaced, so a list sorted by some property is still judged as a
 * whole rather than by its first page.
 */
function sampleRows(rows: readonly unknown[]): readonly unknown[] {
  if (rows.length <= SAMPLE_SIZE) {
    return rows;
  }
  const sample: unknown[] = [];
  for (let index = 0; index < SAMPLE_SIZE; index++) {
    sample.push(rows[Math.floor((index * rows.length) / SAMPLE_SIZE)]);
  }
  return sample;
}

/** The last property name in a path, as written and lowercased without punctuation. */
function lastName(path: string): { raw: string; compact: string } {
  const raw = parsePath(path).at(-1) ?? '';
  return { raw, compact: raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') };
}

// ---------------------------------------------------------------------------------------------
// Lists

/** Names APIs commonly give the list of results. */
const LIST_NAMES = new Set([
  'value',
  'values',
  'items',
  'data',
  'results',
  'result',
  'records',
  'rows',
  'list',
  'entries',
  'hits',
  'nodes',
]);

/** Arrays that sit next to the real list but never are it; matters when the real list is empty. */
const NOT_ROW_NAMES = new Set(['errors', 'error', 'warnings', 'links']);

interface RankedList extends ListCandidate {
  rows: unknown[];
  depth: number;
}

/**
 * Arrays of objects come first, then longer lists (on a log scale, so 20 versus 25 rows doesn't
 * outweigh everything else), then shallower paths, then common list names.
 */
function scoreList(rows: readonly unknown[], depth: number, name: string): number {
  const sample = sampleRows(rows);
  let objects = 0;
  let scalars = 0;
  for (const row of sample) {
    if (isPlainObject(row)) {
      objects++;
    } else if (typeof row === 'string' || typeof row === 'number') {
      scalars++;
    }
  }
  const size = Math.max(1, sample.length);
  const kind = objects / size >= 0.5 ? 100 : scalars / size >= 0.5 ? 50 : 0;
  const length = Math.min(40, 10 * Math.log10(rows.length + 1));
  if (depth === 0) {
    // The response itself is the list.
    return 1000 + kind + length;
  }
  return (
    kind +
    length -
    10 * (depth - 1) +
    (LIST_NAMES.has(name) ? 6 : 0) -
    (NOT_ROW_NAMES.has(name) ? 150 : 0)
  );
}

function compareLists(a: RankedList, b: RankedList): number {
  return (
    b.score - a.score ||
    b.length - a.length ||
    a.depth - b.depth ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

function rankArrays(data: unknown): RankedList[] {
  const ranked: RankedList[] = [];
  for (const candidate of findArrays(data)) {
    // Paths that can't be read back aren't usable as "JSON path to the list" either.
    const rows = getByPath(data, candidate.path);
    if (!Array.isArray(rows)) {
      continue;
    }
    const segments = parsePath(candidate.path);
    const depth = segments.length;
    const { compact } = lastName(candidate.path);
    ranked.push({
      path: candidate.path,
      length: rows.length,
      score: scoreList(rows, depth, compact),
      rows,
      depth,
    });
  }
  return ranked.toSorted(compareLists);
}

/** Arrays in a response that could hold the rows, most likely first. */
export function rankLists(data: unknown): ListCandidate[] {
  return rankArrays(data).map(({ path, length, score }) => ({
    path,
    length,
    score: Math.round(score),
  }));
}

/**
 * Finds the list of rows in a REST response when no path is configured: the response itself when
 * it's a list, otherwise the most likely array inside it. Null when there's no array at all.
 */
export function detectList(data: unknown): { path: string; rows: unknown[] } | null {
  const best = rankArrays(data)[0];
  return best ? { path: best.path, rows: best.rows } : null;
}

// ---------------------------------------------------------------------------------------------
// Properties

type Role = 'value' | 'detail';

interface NameRule {
  reason: string;
  /** Added to the score of a property with this name, as a value and as a second line. */
  value: number;
  detail: number;
  /** Exact names, lowercase without punctuation. */
  names?: ReadonlySet<string>;
  /** Other matches, given the lowercase name and the name as written. */
  matches?: (compact: string, raw: string) => boolean;
}

/** A set of the space-separated words in the lists. */
function words(...lists: string[]): ReadonlySet<string> {
  return new Set(lists.join(' ').split(' '));
}

// The first matching rule wins, so the specific ones come first (“userName” is a user name,
// not just a name; “customerId” is an ID).
const NAME_RULES: readonly NameRule[] = [
  {
    // Never suggest showing a secret to everyone who opens the form.
    reason: 'looks like a secret',
    value: -50,
    detail: -50,
    names: words('token hash salt'),
    matches: (compact) =>
      /password|passwd|secret|apikey|accesstoken|privatekey|credential/.test(compact),
  },
  {
    reason: 'looks like an ID',
    value: -30,
    detail: -25,
    names: words('uid oid objectid etag rev revision'),
    // “id”, “user_id”, “userId”, “UserID”, “externalGuid”; not “valid” or “paid”.
    matches: (compact, raw) =>
      /(?:^|[^a-z])id$/i.test(raw) || /[a-z0-9]I[dD]$/.test(raw) || /(?:guid|uuid)$/.test(compact),
  },
  {
    reason: 'looks like a web address',
    value: -30,
    detail: -25,
    names: words('self src icon image img avatar photo picture thumbnail website homepage logo'),
    matches: (compact) => /(?:url|uri|href|link)$/.test(compact),
  },
  {
    reason: 'looks like a date',
    value: -25,
    detail: -8,
    matches: (compact) =>
      /(?:date|time|timestamp)$/.test(compact) ||
      /^(?:created|updated|modified|deleted|changed|lastmodified)(?:at|on)?$/.test(compact),
  },
  {
    reason: 'looks like a user name',
    value: 22,
    detail: 18,
    names: words(
      'username userprincipalname upn login loginname',
      'samaccountname accountname uniquename alias handle'
    ),
  },
  {
    reason: 'looks like an email address',
    value: 10,
    detail: 30,
    names: words('mail'),
    matches: (compact) => /email(?:address)?$/.test(compact),
  },
  {
    reason: 'looks like a phone number',
    value: -5,
    detail: 10,
    names: words('phone mobile telephone phonenumber tel mobilephone businessphone'),
  },
  {
    reason: 'looks like a name',
    value: 30,
    detail: 12,
    matches: (compact) => compact.endsWith('name'),
  },
  {
    reason: 'looks like a title or label',
    value: 26,
    detail: 14,
    names: words('title label caption text value heading subject term displaytext displayvalue'),
  },
  {
    reason: 'looks like a code or key',
    value: 12,
    detail: 20,
    names: words('key sku symbol abbreviation abbr acronym number ref reference slug'),
    matches: (compact) => compact.endsWith('code'),
  },
  {
    reason: 'looks like a description',
    value: -12,
    detail: 22,
    names: words(
      'description desc summary details detail notes note',
      'comment comments remarks body content about bio'
    ),
  },
  {
    reason: 'looks like a team or organization',
    value: 0,
    detail: 22,
    names: words(
      'department dept team group division unit businessunit',
      'organization organisation org company employer tenant'
    ),
  },
  {
    reason: 'looks like a job title or role',
    value: 0,
    detail: 20,
    names: words('role jobtitle position occupation designation jobrole'),
  },
  {
    reason: 'looks like a place',
    value: 0,
    detail: 16,
    names: words(
      'city country location office officelocation region',
      'site address building town province'
    ),
  },
  {
    reason: 'looks like a category or status',
    value: -6,
    detail: 14,
    names: words(
      'category type kind status state class level',
      'priority severity stage phase tier'
    ),
  },
];

function nameRule(path: string): NameRule | undefined {
  const { raw, compact } = lastName(path);
  if (!compact) {
    return undefined;
  }
  return NAME_RULES.find((rule) => rule.names?.has(compact) || rule.matches?.(compact, raw));
}

interface Weights {
  /** Times the share of rows that have the property. */
  presence: number;
  text: number;
  number: number;
  boolean: number;
  /** Times the share of distinct values. */
  unique: number;
  /** Every row has the same value. */
  same: number;
  guid: number;
  url: number;
  date: number;
  email: number;
  /** Numbers too long to read, like timestamps in milliseconds. */
  bigNumber: number;
  /** Average length above which text counts as long, and the penalty for it. */
  longTextAt: number;
  longText: number;
  veryLongTextAt: number;
  veryLongText: number;
  multiline: number;
  /** A second line that repeats the value. */
  sameAsValue: number;
}

const WEIGHTS: Record<Role, Weights> = {
  // Values are searched, saved and read by people: short, unique, human-readable text.
  value: {
    presence: 40,
    text: 20,
    number: 4,
    boolean: -60,
    unique: 30,
    same: -30,
    guid: -35,
    url: -35,
    date: -30,
    email: 5,
    bigNumber: -20,
    longTextAt: 80,
    longText: -25,
    veryLongTextAt: 200,
    veryLongText: -45,
    multiline: -20,
    sameAsValue: 0,
  },
  // Second lines add context; they may repeat across rows, and they can be a little longer.
  detail: {
    presence: 30,
    text: 15,
    number: 0,
    boolean: -50,
    unique: 0,
    same: -30,
    guid: -30,
    url: -30,
    date: -10,
    email: 15,
    bigNumber: -15,
    longTextAt: 120,
    longText: -10,
    veryLongTextAt: 300,
    veryLongText: -25,
    multiline: -5,
    sameAsValue: -40,
  },
};

// Patterns only run on short strings, and none of them can backtrack badly.
const PATTERN_MAX_LENGTH = 256;
const GUID = /^[{(]?[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}[)}]?$|^[0-9a-f]{24}$/i;
const WEB_ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/i;
const DATE = /^\d{4}-\d{2}-\d{2}(?:$|[T ]\d{2}:\d{2})|^\/Date\(\d/;
const WHITESPACE = /\s/;

function isRelativePath(text: string): boolean {
  return text.startsWith('/') && text.indexOf('/', 1) > 0 && !WHITESPACE.test(text);
}

function isEmail(text: string): boolean {
  const at = text.indexOf('@');
  return (
    at > 0 &&
    text.lastIndexOf('@') === at &&
    text.indexOf('.', at + 2) > at + 1 &&
    !text.endsWith('.') &&
    !WHITESPACE.test(text)
  );
}

interface PropertyStats {
  path: string;
  /** Rows (in the sample) with a usable value: non-blank text, a number or true/false. */
  present: number;
  strings: number;
  numbers: number;
  booleans: number;
  distinct: Set<string>;
  textLength: number;
  multiline: number;
  guids: number;
  urls: number;
  emails: number;
  dates: number;
  bigNumbers: number;
  sample: string;
}

function shorten(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function record(stats: PropertyStats, value: unknown): void {
  let text: string;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    text = value;
    stats.strings++;
    if (trimmed.length <= PATTERN_MAX_LENGTH) {
      if (GUID.test(trimmed)) {
        stats.guids++;
      } else if (WEB_ADDRESS.test(trimmed) || isRelativePath(trimmed)) {
        stats.urls++;
      } else if (isEmail(trimmed)) {
        stats.emails++;
      } else if (DATE.test(trimmed)) {
        stats.dates++;
      }
    }
    if (value.includes('\n')) {
      stats.multiline++;
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    text = String(value);
    stats.numbers++;
    if (Math.abs(value) >= 1e11) {
      stats.bigNumbers++;
    }
  } else if (typeof value === 'boolean') {
    text = String(value);
    stats.booleans++;
  } else {
    return;
  }
  stats.present++;
  stats.textLength += text.length;
  stats.distinct.add(text);
  if (!stats.sample) {
    stats.sample = shorten(text);
  }
}

interface Analysis {
  /** The sampled rows that are objects. */
  rows: Record<string, unknown>[];
  /** In the order the properties first appear, which is the tie-breaker. */
  properties: PropertyStats[];
}

function analyze(rows: readonly unknown[]): Analysis {
  const objects = sampleRows(rows).filter(isPlainObject);
  const byPath = new Map<string, PropertyStats>();
  for (const row of objects) {
    for (const { path } of listProperties(row)) {
      let stats = byPath.get(path);
      if (!stats) {
        stats = {
          path,
          present: 0,
          strings: 0,
          numbers: 0,
          booleans: 0,
          distinct: new Set(),
          textLength: 0,
          multiline: 0,
          guids: 0,
          urls: 0,
          emails: 0,
          dates: 0,
          bigNumbers: 0,
          sample: '',
        };
        byPath.set(path, stats);
      }
      // Read through getByPath so the values judged are exactly the ones the picklist will use.
      record(stats, getByPath(row, path));
    }
  }
  return { rows: objects, properties: [...byPath.values()].filter((stats) => stats.present > 0) };
}

/** “unique text in every item”, “numbers in some items, often repeated”, … */
function describeData(stats: PropertyStats, rowCount: number, longText: boolean): string {
  const half = stats.present / 2;
  const noun =
    stats.strings >= half
      ? longText
        ? 'long text'
        : 'text'
      : stats.numbers >= half
        ? 'numbers'
        : stats.booleans >= half
          ? 'true/false values'
          : 'values';
  const presence =
    stats.present >= rowCount
      ? 'in every item'
      : stats.present >= rowCount * 0.8
        ? 'in most items'
        : 'in some items';
  if (stats.present < 2) {
    return `${noun} ${presence}`;
  }
  const distinct = stats.distinct.size;
  if (distinct === 1) {
    const single = noun === 'numbers' ? 'number' : noun.endsWith('text') ? noun : 'value';
    return `same ${single} ${presence}`;
  }
  const uniqueness = distinct / stats.present;
  if (uniqueness === 1) {
    return `unique ${noun} ${presence}`;
  }
  if (uniqueness >= 0.9) {
    return `mostly unique ${noun} ${presence}`;
  }
  return uniqueness < 0.5 ? `${noun} ${presence}, often repeated` : `${noun} ${presence}`;
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() ? value.trim() : null;
  }
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** Share of the rows having both properties where the second line just repeats the value. */
function sameAsValueShare(
  rows: readonly Record<string, unknown>[],
  path: string,
  valuePath: string
): number {
  let both = 0;
  let same = 0;
  for (const row of rows) {
    const detail = textOf(getByPath(row, path));
    const value = textOf(getByPath(row, valuePath));
    if (detail !== null && value !== null) {
      both++;
      if (detail === value) {
        same++;
      }
    }
  }
  return both > 0 ? same / both : 0;
}

interface Scored {
  stats: PropertyStats;
  score: number;
  reason: string;
}

function evaluate(stats: PropertyStats, rowCount: number, role: Role, sameAsValue: number): Scored {
  const weights = WEIGHTS[role];
  const hints: string[] = [];
  const hint = (reason: string) => {
    if (!hints.includes(reason)) {
      hints.push(reason);
    }
  };
  const present = stats.present;
  const half = present / 2;
  let score = weights.presence * (present / rowCount);

  const rule = nameRule(stats.path);
  if (rule) {
    score += rule[role];
    hint(rule.reason);
  }

  if (stats.strings >= half) {
    score += weights.text;
  } else if (stats.numbers >= half) {
    score += weights.number;
  } else if (stats.booleans >= half) {
    score += weights.boolean;
  }

  if (present >= 2) {
    const distinct = stats.distinct.size;
    score += distinct === 1 ? weights.same : weights.unique * (distinct / present);
  } else {
    score += weights.unique / 2;
  }

  if (stats.guids >= half) {
    score += weights.guid;
    hint('looks like an ID');
  }
  if (stats.bigNumbers >= half) {
    score += weights.bigNumber;
    hint('looks like an ID');
  }
  if (stats.urls >= half) {
    score += weights.url;
    hint('looks like a web address');
  }
  if (stats.dates >= half) {
    score += weights.date;
    hint('looks like a date');
  }
  if (stats.emails >= half) {
    score += weights.email;
    hint('looks like an email address');
  }

  const averageLength = stats.textLength / present;
  let longText = false;
  if (averageLength > weights.veryLongTextAt) {
    score += weights.veryLongText;
    longText = true;
  } else if (averageLength > weights.longTextAt) {
    score += weights.longText;
    longText = true;
  }
  if (stats.multiline >= half) {
    score += weights.multiline;
    longText = true;
  }

  if (sameAsValue >= 0.5) {
    score += weights.sameAsValue;
    // First, so the most telling reason survives the two-hint limit below.
    hints.unshift('same as the value');
  }

  const phrase = [...hints.slice(0, 2), describeData(stats, rowCount, longText)].join(', ');
  return { stats, score, reason: phrase.charAt(0).toUpperCase() + phrase.slice(1) };
}

function toSuggestions(scored: Scored[], limit: number): PropertySuggestion[] {
  // Sorting is stable, so ties keep the order the properties first appear in.
  return scored
    .toSorted((a, b) => b.score - a.score || b.stats.present - a.stats.present)
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(({ stats, score, reason }) => ({
      path: stats.path,
      score: Math.round(score),
      reason,
      sample: stats.sample,
    }));
}

/**
 * Properties that would make good values, best first: text that is present in every row, unique,
 * short and name-like. IDs, GUIDs, web addresses, dates, long text and true/false values rank low.
 * Empty when the rows aren't objects.
 */
export function suggestValueProperties(rows: readonly unknown[], limit = 5): PropertySuggestion[] {
  const analysis = analyze(rows);
  const rowCount = analysis.rows.length;
  return toSuggestions(
    analysis.properties.map((stats) => evaluate(stats, rowCount, 'value', 0)),
    limit
  );
}

/**
 * Properties that would make a good second line under each value, best first: an email address,
 * description, code, department, job title… Leaves out the value property (or, when that's empty,
 * the one that would be picked automatically) and ranks down text that repeats the value.
 */
export function suggestDetailProperties(
  rows: readonly unknown[],
  valueProperty: string,
  limit = 5
): PropertySuggestion[] {
  const analysis = analyze(rows);
  const rowCount = analysis.rows.length;
  const valuePath =
    valueProperty.trim() ||
    toSuggestions(
      analysis.properties.map((stats) => evaluate(stats, rowCount, 'value', 0)),
      1
    )[0]?.path ||
    '';
  return toSuggestions(
    analysis.properties
      .filter((stats) => stats.path !== valuePath)
      .map((stats) =>
        evaluate(
          stats,
          rowCount,
          'detail',
          valuePath ? sameAsValueShare(analysis.rows, stats.path, valuePath) : 0
        )
      ),
    limit
  );
}
