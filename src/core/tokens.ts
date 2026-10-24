import { scalarToString } from './values';

// `$(Field.ReferenceName)` placeholders let the REST call depend on other work item fields.
const TOKEN_PATTERN = /\$\(([^()]*)\)/g;

/** Field reference names used as `$(Field)` tokens, in order of first use (case-insensitive). */
export function findFieldTokens(...templates: Array<string | undefined>): string[] {
  const names = new Map<string, string>();
  for (const template of templates) {
    if (!template) {
      continue;
    }
    for (const match of template.matchAll(TOKEN_PATTERN)) {
      const name = (match[1] ?? '').trim();
      if (name && !names.has(name.toLowerCase())) {
        names.set(name.toLowerCase(), name);
      }
    }
  }
  return [...names.values()];
}

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(formatFieldValue).join(',');
  }
  if (typeof value === 'object') {
    const identity = value as { displayName?: unknown };
    if (typeof identity.displayName === 'string') {
      return identity.displayName;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return scalarToString(value) ?? '';
}

function substitute(
  template: string,
  values: Record<string, unknown>,
  encode: (value: string) => string
): string {
  const lookup = new Map(
    Object.entries(values).map(([name, value]) => [name.toLowerCase(), value] as const)
  );
  // A single pass: text inserted for one token is never scanned for further tokens.
  return template.replace(TOKEN_PATTERN, (_token, name: string) =>
    encode(formatFieldValue(lookup.get(name.trim().toLowerCase())))
  );
}

/** Inserts field values into a JSON template, escaped so a value can't break out of its string. */
export function substituteForJson(template: string, values: Record<string, unknown>): string {
  return substitute(template, values, (value) => JSON.stringify(value).slice(1, -1));
}

/** Inserts URL-encoded field values into a URL path or query string. */
export function substituteForUrl(template: string, values: Record<string, unknown>): string {
  return substitute(template, values, encodeURIComponent);
}
