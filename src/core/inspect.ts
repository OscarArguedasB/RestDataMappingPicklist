import { isObjectLike, isPlainObject, scalarToString } from './values';

export interface ArrayCandidate {
  /** Value for "JSON path to the list" (empty when the response itself is the list). */
  path: string;
  length: number;
}

export interface PropertyCandidate {
  path: string;
  sample: string;
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? parent
      ? `${parent}.${key}`
      : key
    : `${parent}["${key.replace(/"/g, '\\"')}"]`;
}

/** Lists arrays in a response so an administrator can pick the one holding the rows. */
export function findArrays(data: unknown, maxDepth = 4): ArrayCandidate[] {
  const found: ArrayCandidate[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (Array.isArray(value)) {
      found.push({ path, length: value.length });
      return;
    }
    if (!isPlainObject(value) || depth >= maxDepth) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, childPath(path, key), depth + 1);
    }
  };
  visit(data, '', 0);
  return found.toSorted((a, b) => b.length - a.length);
}

function describeSample(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  }
  if (value === null) {
    return 'null';
  }
  return scalarToString(value) ?? '';
}

/** Lists the scalar properties of a row (one level of nesting deep) with sample values. */
export function listProperties(row: unknown, maxDepth = 2): PropertyCandidate[] {
  const found: PropertyCandidate[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (isPlainObject(value)) {
      if (depth >= maxDepth) {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        visit(child, childPath(path, key), depth + 1);
      }
      return;
    }
    if (path && !isObjectLike(value)) {
      found.push({ path, sample: describeSample(value) });
    }
  };
  visit(row, '', 0);
  return found;
}
