import { describe, expect, it } from 'vitest';
import { FIELD_TYPE, fieldKind, fieldProblem, valueLengthLimit } from './fieldTypes';

describe('FIELD_TYPE', () => {
  it('matches azure-devops-extension-api’s WorkItemTracking FieldType', () => {
    expect(FIELD_TYPE).toEqual({
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
    });
  });
});

describe('fieldKind', () => {
  it('reads the numbers the form service reports', () => {
    expect(fieldKind({ type: 0 })).toBe('string');
    expect(fieldKind({ type: 3 })).toBe('plainText');
    expect(fieldKind({ type: 4 })).toBe('html');
    expect(fieldKind({ type: 11 })).toBe('picklist');
    expect(fieldKind({ type: 12 })).toBe('picklist');
    expect(fieldKind({ type: 13 })).toBe('picklist');
    for (const type of [1, 2, 5, 6, 7, 8, 9, 10]) {
      expect(fieldKind({ type })).toBe('other');
    }
  });

  it('reads type names in any case', () => {
    expect(fieldKind({ type: 'String' })).toBe('string');
    expect(fieldKind({ type: 'plainText' })).toBe('plainText');
    expect(fieldKind({ type: 'html' })).toBe('html');
    expect(fieldKind({ type: 'picklistString' })).toBe('picklist');
    expect(fieldKind({ type: 'PICKLIST_INTEGER' })).toBe('picklist');
    expect(fieldKind({ type: 'dateTime' })).toBe('other');
    expect(fieldKind({ type: 'identity' })).toBe('other');
    expect(fieldKind({ type: '4' })).toBe('html');
  });

  it('lets the picklist flag win over a text type', () => {
    expect(fieldKind({ type: 0, isPicklist: true })).toBe('picklist');
    expect(fieldKind({ isPicklist: true })).toBe('picklist');
    expect(fieldKind({ type: 0, isPicklist: false })).toBe('string');
  });

  it('treats picklists that accept people’s own values like text fields', () => {
    expect(fieldKind({ type: 0, isPicklist: true, isPicklistSuggested: true })).toBe('string');
    expect(fieldKind({ type: 11, isPicklistSuggested: true })).toBe('string');
    expect(fieldKind({ type: 12, isPicklistSuggested: true })).toBe('other');
    expect(fieldKind({ isPicklist: true, isPicklistSuggested: true })).toBe('unknown');
  });

  it('doesn’t guess when the host gives no usable type', () => {
    expect(fieldKind(undefined)).toBe('unknown');
    expect(fieldKind({})).toBe('unknown');
    expect(fieldKind({ type: null })).toBe('unknown');
    expect(fieldKind({ type: 99 })).toBe('unknown');
    expect(fieldKind({ type: 'somethingNew' })).toBe('unknown');
    expect(fieldKind({ type: { value: 0 } })).toBe('unknown');
  });
});

describe('fieldProblem', () => {
  it('explains why picklists can’t be used', () => {
    expect(fieldProblem('picklist', false, 'Customer')).toBe(
      '“Customer” is a picklist. This control only fills text fields, because only process admins can add values to a picklist.'
    );
  });

  it('asks for a text field for other types', () => {
    expect(fieldProblem('other', false, 'Due date')).toBe(
      '“Due date” isn’t a text field. This control only fills text fields: Text (single line) or Text (multiple lines).'
    );
    expect(fieldProblem('other', true, 'Count')).toBe(
      '“Count” isn’t a text field, so it can’t hold multiple values. Use a Text (single line) or Text (multiple lines) field.'
    );
  });

  it('accepts text fields and fields of unknown type', () => {
    for (const kind of ['string', 'plainText', 'html', 'unknown'] as const) {
      expect(fieldProblem(kind, false, 'X')).toBeNull();
      expect(fieldProblem(kind, true, 'X')).toBeNull();
    }
  });

  it('still reads well without a label', () => {
    expect(fieldProblem('picklist', false, '  ')).toMatch(/^This field is a picklist\./);
  });
});

describe('valueLengthLimit', () => {
  it('limits single-line text only', () => {
    expect(valueLengthLimit('string')).toBe(255);
    for (const kind of ['plainText', 'html', 'picklist', 'other', 'unknown'] as const) {
      expect(valueLengthLimit(kind)).toBeNull();
    }
  });
});
