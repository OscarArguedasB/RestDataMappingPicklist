import { detectList, suggestValueProperties } from './detect';
import { PicklistError } from './errors';
import { getByPath, isObjectLike } from './path';

/** One choice in the list. */
export interface PicklistItem {
  /** Unique within a list: the value, plus the second line when there is one. */
  key: string;
  value: string;
  /** Second line, shown smaller under the value. */
  detail?: string;
}

/**
 * Finds the rows in a response. With a path, the list must be there; without one, the list is
 * found automatically. Returns the path actually used ('' when the response itself is the list).
 */
export function locateRows(data: unknown, arrayPath: string): { rows: unknown[]; path: string } {
  const path = arrayPath.trim();
  if (path) {
    return { rows: resolveRows(data, path), path };
  }
  const detected = detectList(data);
  if (!detected) {
    throw new PicklistError(
      'shape',
      'No list was found in the response. Set “JSON path to the list”, for example data.result.'
    );
  }
  return detected;
}

export interface PicklistData {
  /** Distinct items, sorted for display by value, then by second line. */
  items: PicklistItem[];
  /** The first response row for each item key; used to fill mapped fields. */
  rows: Map<string, unknown>;
  /**
   * The property the values came from: the configured one, or the one picked automatically when
   * none is configured. '' when the rows are plain values rather than objects.
   */
  valueProperty: string;
  /** The property the second lines came from; '' when there are none. */
  detailProperty: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Joins value and second line in an item key. A control character, so it can't clash with the
 * text people see: the same value with different second lines gives different keys.
 */
const KEY_SEPARATOR = '\u001f';

/** Second lines are display text; very long ones (whole descriptions) are cut short. */
const DETAIL_MAX_LENGTH = 500;

/** Finds the array of rows in a REST response. */
export function resolveRows(data: unknown, arrayPath: string): unknown[] {
  const path = arrayPath.trim();
  const target = path ? getByPath(data, path) : data;
  if (Array.isArray(target)) {
    return target;
  }
  // Versions before 2.0 fell back to the whole response when the path didn't match.
  if (path && target === undefined && Array.isArray(data)) {
    return data;
  }
  if (path) {
    throw new PicklistError(
      'shape',
      target === undefined
        ? `No list was found at “${path}” in the response.`
        : `“${path}” in the response isn’t a list.`
    );
  }
  throw new PicklistError(
    'shape',
    'The response isn’t a list. Set “JSON path to the list” to where it is, for example data.result.'
  );
}

export function toItemValue(value: unknown): string | null {
  switch (typeof value) {
    case 'string':
      return value.trim() ? value : null;
    case 'number':
      return Number.isFinite(value) ? String(value) : null;
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      return null;
  }
}

/** A second line: one line of text (rows have a fixed height), at most DETAIL_MAX_LENGTH long. */
function toDetail(value: unknown): string | undefined {
  const text = toItemValue(value);
  if (text === null) {
    return undefined;
  }
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= DETAIL_MAX_LENGTH) {
    return line;
  }
  let end = DETAIL_MAX_LENGTH - 1;
  // Don't split a surrogate pair (an emoji, for example).
  const lastCode = line.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end--;
  }
  return `${line.slice(0, end)}…`;
}

function compareItems(a: PicklistItem, b: PicklistItem): number {
  return collator.compare(a.value, b.value) || collator.compare(a.detail ?? '', b.detail ?? '');
}

/**
 * Builds a `PicklistData` progressively, from one or more batches of rows (for example, pages of
 * a paged REST response), without re-sorting or re-scanning everything already added each time:
 *
 * - `add(rows)` only looks at the rows passed to it, so batch *b* costs O(|rows in *b*|), not
 *   O(everything added before it). Items are appended in the order they're first seen; `snapshot`
 *   reflects that order, so a view reading it while more batches are still coming doesn't have
 *   its rows reordered out from under it.
 * - `finish()` sorts once (the sort `buildPicklistData` also does), which is the only step whose
 *   cost depends on the total so far.
 *
 * The value and second-line properties are resolved from the first non-empty batch (as
 * `buildPicklistData` resolves them from all the rows given at once) and then kept for every
 * later batch, so items don't change shape mid-stream. Dedupe keeps the first row for a key,
 * exactly as `buildPicklistData` does.
 */
export class IncrementalPicklistBuilder {
  private readonly configuredValueProperty: string;
  private readonly configuredDetailProperty: string;
  private resolved = false;
  private valuePath = '';
  private detailPath = '';
  private readonly byKey = new Map<string, unknown>();
  private readonly items: PicklistItem[] = [];

  constructor(valueProperty: string, detailProperty = '') {
    this.configuredValueProperty = valueProperty.trim();
    this.configuredDetailProperty = detailProperty.trim();
  }

  /** Items in the order first seen (not sorted), and everything else `buildPicklistData` returns. */
  get snapshot(): PicklistData {
    return {
      items: this.items.slice(),
      rows: this.byKey,
      valueProperty: this.valuePath,
      detailProperty: this.detailPath,
    };
  }

  /** Adds one batch of rows; only these rows are scanned. Duplicate keys keep the earlier row. */
  add(rows: readonly unknown[]): void {
    // Resolved from the first call regardless of whether it happened to be empty, so a single
    // call (as buildPicklistData makes) with no rows still keeps the configured property, exactly
    // as it did before.
    if (!this.resolved) {
      this.resolved = true;
      const plainValues = rows.length > 0 && !rows.some(isObjectLike);
      let valuePath = plainValues ? '' : this.configuredValueProperty;
      if (!valuePath && !plainValues && rows.length > 0) {
        valuePath = suggestValueProperties(rows, 1)[0]?.path ?? '';
      }
      this.valuePath = valuePath;
      const detailPath = plainValues ? '' : this.configuredDetailProperty;
      // A second line repeating the value adds nothing.
      this.detailPath = detailPath && detailPath !== valuePath ? detailPath : '';
    }
    if (rows.length === 0) {
      return;
    }
    const { valuePath, detailPath } = this;
    for (const row of rows) {
      const isObject = isObjectLike(row);
      // With no value property an object row reads as itself, which isn't a value, so it's skipped.
      const value = toItemValue(isObject ? getByPath(row, valuePath) : row);
      if (value === null) {
        continue;
      }
      const detail = isObject && detailPath ? toDetail(getByPath(row, detailPath)) : undefined;
      const key = detail === undefined ? value : `${value}${KEY_SEPARATOR}${detail}`;
      if (this.byKey.has(key)) {
        continue;
      }
      this.byKey.set(key, row);
      this.items.push(detail === undefined ? { key, value } : { key, value, detail });
    }
  }

  /** The final, sorted result: the same items `buildPicklistData` would give for all the rows. */
  finish(): PicklistData {
    // Stable, so items that compare equal keep the order they were first seen in.
    const items = this.items.toSorted(compareItems);
    return {
      items,
      rows: this.byKey,
      valueProperty: this.valuePath,
      detailProperty: this.detailPath,
    };
  }
}

/**
 * Turns response rows into picklist items. Rows can be objects or plain strings/numbers. With no
 * value property, object rows use the most name-like property (see suggestValueProperties).
 * Items with the same value and second line are merged, keeping the first row.
 */
export function buildPicklistData(
  rows: readonly unknown[],
  valueProperty: string,
  detailProperty = ''
): PicklistData {
  const builder = new IncrementalPicklistBuilder(valueProperty, detailProperty);
  builder.add(rows);
  return builder.finish();
}

/**
 * The items whose value is `value`: one, or several when rows share a value but differ in their
 * second line. Values saved with surrounding spaces trimmed (multiple values are) still match.
 */
export function itemsWithValue(data: Pick<PicklistData, 'items'>, value: string): PicklistItem[] {
  const exact = data.items.filter((item) => item.value === value);
  const trimmed = value.trim();
  if (exact.length > 0 || !trimmed) {
    return exact;
  }
  return data.items.filter((item) => item.value.trim() === trimmed);
}
