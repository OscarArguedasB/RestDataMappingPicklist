import { isObjectLike } from './values';

export { isObjectLike, isPlainObject } from './values';

const BLOCKED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
// Quoted segments may escape their quote and backslashes (`["say \"hi\""]`), as inspect.ts writes them.
const SEGMENT_PATTERN = /\[\s*(?:(\d+)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\]|([^.[\]]+)/g;

/**
 * Only `\\`, `\"` and `\'` are escapes. Any other backslash stays as written, so paths typed
 * before escapes were read, like `["C:\data"]`, keep working.
 */
function unescapeQuoted(segment: string): string {
  return segment.replace(/\\(["'\\])/g, '$1');
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Splits `data.items[0].name` (a leading `$.` is accepted) into property names. */
export function parsePath(path: string): string[] {
  const trimmed = path.trim().replace(/^\$\.?/, '');
  const segments: string[] = [];
  for (const match of trimmed.matchAll(SEGMENT_PATTERN)) {
    const quoted = match[2] ?? match[3];
    const segment = (
      quoted === undefined ? (match[1] ?? match[4] ?? '') : unescapeQuoted(quoted)
    ).trim();
    if (segment) {
      segments.push(segment);
    }
  }
  return segments;
}

/**
 * Reads a value by path. Only own properties are followed, so a path can never reach
 * `__proto__` or other inherited members. A key that literally contains dots wins over
 * the dotted interpretation, matching lodash `get`, which earlier versions used.
 */
export function getByPath(source: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$') {
    return source;
  }
  if (isObjectLike(source) && !BLOCKED_SEGMENTS.has(trimmed) && hasOwn(source, trimmed)) {
    return Reflect.get(source, trimmed) as unknown;
  }
  let current: unknown = source;
  for (const segment of parsePath(trimmed)) {
    if (BLOCKED_SEGMENTS.has(segment) || !isObjectLike(current) || !hasOwn(current, segment)) {
      return undefined;
    }
    current = Reflect.get(current, segment) as unknown;
  }
  return current;
}
