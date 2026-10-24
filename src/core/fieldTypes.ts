import { SINGLE_LINE_TEXT_LIMIT } from './multi';

/**
 * FieldType of azure-devops-extension-api's WorkItemTracking module (checked against 5.276.0).
 * The work item form service reports these numbers; the REST API reports the names in camelCase
 * ("string", "plainText", "picklistString"…). Declared here so the extension doesn't ship that
 * package.
 */
export const FIELD_TYPE = {
  String: 0,
  Integer: 1,
  DateTime: 2,
  PlainText: 3,
  Html: 4,
  TreePath: 5,
  History: 6,
  Double: 7,
  Guid: 8,
  Boolean: 9,
  Identity: 10,
  PicklistString: 11,
  PicklistInteger: 12,
  PicklistDouble: 13,
} as const;

/**
 * What the control can do with a field: fill a single-line text field ('string'), a multi-line
 * one ('plainText', 'html'), or nothing ('picklist', 'other'). 'unknown' when the host didn't say,
 * which never blocks the control.
 */
export type FieldKind = 'string' | 'plainText' | 'html' | 'picklist' | 'other' | 'unknown';

const TYPE_BY_NAME: ReadonlyMap<string, number> = new Map(
  Object.entries(FIELD_TYPE).map(([name, type]) => [name.toLowerCase(), type])
);
const KNOWN_TYPES: ReadonlySet<number> = new Set(Object.values(FIELD_TYPE));

/** The FieldType number for a number or a name in any case; null when it isn't one. */
function toFieldType(type: unknown): number | null {
  if (typeof type === 'number') {
    return KNOWN_TYPES.has(type) ? type : null;
  }
  if (typeof type !== 'string') {
    return null;
  }
  const name = type.trim().toLowerCase();
  if (/^\d{1,3}$/.test(name)) {
    return toFieldType(Number(name));
  }
  return TYPE_BY_NAME.get(name.replace(/[^a-z]/g, '')) ?? null;
}

/**
 * Reads the kind of a work item field from its type (the FieldType number or name) and picklist
 * flags. A field with a picklist is a picklist whatever its type, unless people may enter their
 * own values (“suggested” values): then any text is accepted, just like a text field.
 */
export function fieldKind(
  field: { type?: unknown; isPicklist?: boolean; isPicklistSuggested?: boolean } | undefined
): FieldKind {
  if (!field) {
    return 'unknown';
  }
  const type = toFieldType(field.type);
  const picklist =
    field.isPicklist === true ||
    type === FIELD_TYPE.PicklistString ||
    type === FIELD_TYPE.PicklistInteger ||
    type === FIELD_TYPE.PicklistDouble;
  if (picklist) {
    if (field.isPicklistSuggested !== true) {
      return 'picklist';
    }
    if (type === null) {
      return 'unknown';
    }
    return type === FIELD_TYPE.String || type === FIELD_TYPE.PicklistString ? 'string' : 'other';
  }
  switch (type) {
    case null:
      return 'unknown';
    case FIELD_TYPE.String:
      return 'string';
    case FIELD_TYPE.PlainText:
      return 'plainText';
    case FIELD_TYPE.Html:
      return 'html';
    default:
      return 'other';
  }
}

/**
 * Why the control can't be used with this field, written for the administrator; null when it can.
 * Unknown fields pass, so a host that doesn't report types never blocks the control.
 */
export function fieldProblem(
  kind: FieldKind,
  allowMultiple: boolean,
  fieldLabel: string
): string | null {
  const label = fieldLabel.trim();
  const name = label ? `“${label}”` : 'This field';
  switch (kind) {
    case 'picklist':
      return `${name} is a picklist. This control only fills text fields, because only process admins can add values to a picklist.`;
    case 'other':
      return allowMultiple
        ? `${name} isn’t a text field, so it can’t hold multiple values. Use a Text (single line) or Text (multiple lines) field.`
        : `${name} isn’t a text field. This control only fills text fields: Text (single line) or Text (multiple lines).`;
    default:
      return null;
  }
}

/** The most characters the field holds, when there's a limit worth checking. */
export function valueLengthLimit(kind: FieldKind): number | null {
  return kind === 'string' ? SINGLE_LINE_TEXT_LIMIT : null;
}
