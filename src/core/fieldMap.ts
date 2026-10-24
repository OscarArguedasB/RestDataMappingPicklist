import type { CopyMode } from './config';
import { formatMultiValue } from './multi';
import { getByPath, isPlainObject } from './path';

/** Work item field reference name → property (path) of the selected REST row. */
export type FieldMap = Record<string, string>;

export interface FieldMapParseResult {
  map: FieldMap | null;
  error: string | null;
}

export const FIELD_MAP_EXAMPLE = '{ "Custom.CustomerId": "id", "Custom.CustomerEmail": "email" }';

export function parseFieldMap(raw: string | undefined): FieldMapParseResult {
  if (!raw || !raw.trim()) {
    return { map: null, error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { map: null, error: `The field map isn’t valid JSON. Example: ${FIELD_MAP_EXAMPLE}` };
  }
  if (!isPlainObject(parsed)) {
    return {
      map: null,
      error: `The field map must be a JSON object, for example ${FIELD_MAP_EXAMPLE}`,
    };
  }
  const map: FieldMap = {};
  const invalid: string[] = [];
  for (const [field, source] of Object.entries(parsed)) {
    if (typeof source === 'string' && field.trim() && source.trim()) {
      map[field.trim()] = source.trim();
    } else {
      invalid.push(field || '(empty)');
    }
  }
  const usable = Object.keys(map).length > 0 ? map : null;
  if (invalid.length > 0) {
    return {
      map: usable,
      error: `Each entry needs a field name and a property name in quotes. Check: ${invalid.join(', ')}.`,
    };
  }
  return { map: usable, error: null };
}

/** Values to copy from the selected REST row into other work item fields. */
export function fieldMapUpdates(
  row: unknown,
  map: FieldMap | null
): Record<string, string | number | boolean> {
  const updates: Record<string, string | number | boolean> = {};
  if (!map || row === undefined) {
    return updates;
  }
  for (const [field, source] of Object.entries(map)) {
    const value = getByPath(row, source);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      updates[field] = value;
    }
  }
  return updates;
}

function copyableText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/**
 * Values to copy into other work item fields when several items can be picked. Every mapped field
 * gets an entry, so removing the last pick clears them. 'first' copies from the first picked row;
 * 'all' joins the values of every picked row that has one (“a; b”, each value once).
 */
export function fieldMapUpdatesForRows(
  rows: readonly unknown[],
  map: FieldMap | null,
  mode: CopyMode
): Record<string, string> {
  const updates: Record<string, string> = {};
  if (!map) {
    return updates;
  }
  const sources = mode === 'first' ? rows.slice(0, 1) : rows;
  for (const [field, source] of Object.entries(map)) {
    const values: string[] = [];
    for (const row of sources) {
      const text = copyableText(getByPath(row, source));
      if (text !== null) {
        values.push(text);
      }
    }
    updates[field] = mode === 'first' ? (values[0] ?? '') : formatMultiValue(values);
  }
  return updates;
}
