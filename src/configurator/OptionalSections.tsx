import { useContext, useId } from 'react';
import type { AdvancedSettings, CopyMode, PagingConfig, PagingType } from '../core/config';
import { LIMITS } from '../core/config';
import { parseFieldMap } from '../core/fieldMap';
import type { PropertyCandidate } from '../core/inspect';
import type { SecurityPolicy } from '../core/policy';
import { Collapsible } from './Collapsible';
import type { Draft, Issues } from './settings';
import {
  COPY_MODE_LABELS,
  LABELS,
  PAGING_LABELS,
  formatNumber,
  pagingForType,
  summarizeBehavior,
  summarizeFieldMap,
  summarizeMultiple,
  summarizePaging,
} from './settings';
import {
  CheckboxField,
  Field,
  IssueMessage,
  NumberField,
  RadioGroupField,
  ReadOnlyContext,
  TextField,
} from './ui';

const PAGING_TYPES: readonly PagingType[] = ['none', 'nextLink', 'page', 'offset', 'cursor'];

const PAGING_HELP: Record<PagingType, string> = {
  none: 'The endpoint returns the whole list at once.',
  nextLink:
    'Each response links to the next page, in the body (like @odata.nextLink) or in a Link header.',
  page: 'Pages are requested by number, like ?page=2&pageSize=100.',
  offset: 'Pages are requested by position, like ?offset=100&limit=100.',
  cursor: 'Each response has a cursor that is sent back to get the next page.',
};

/** Number fields by section, so a section with one that isn't valid is flagged. */
const PAGING_NUMBERS = ['pageSize', 'offsetLimit', 'maxPages', 'maxItems'] as const;
const BEHAVIOR_NUMBERS = ['timeout'] as const;

type NumberKey = (typeof PAGING_NUMBERS)[number] | (typeof BEHAVIOR_NUMBERS)[number];

function suggestedFieldName(property: string): string {
  const words = property.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `Custom.${words.map((word) => (word[0] ?? '').toUpperCase() + word.slice(1)).join('')}`;
}

/** Adds “Custom.X”: “x” to the field map, or null when the current text isn't valid. */
export function addToFieldMap(raw: string, property: string): string | null {
  const { map, error } = parseFieldMap(raw);
  if (error) {
    return null;
  }
  const next = { ...map };
  if (!Object.values(next).includes(property)) {
    const base = suggestedFieldName(property);
    let field = base;
    for (let suffix = 2; field in next; suffix++) {
      field = `${base}${suffix}`;
    }
    next[field] = property;
  }
  return JSON.stringify(next, null, 2);
}

function PagingFields(props: {
  paging: Exclude<PagingConfig, { type: 'none' }>;
  issueText: string | null;
  onChange: (paging: PagingConfig) => void;
  track: (key: NumberKey) => (valid: boolean) => void;
}) {
  const { paging, onChange, track } = props;
  const id = useId();
  const readOnly = useContext(ReadOnlyContext);
  return (
    <div className='cf-grid-2'>
      {paging.type === 'nextLink' ? (
        <TextField
          label='Where the next page link is'
          help='A property of the response, like @odata.nextLink or links.next. Leave empty to look in common places and the Link header.'
          value={paging.nextLink}
          placeholder='Automatic'
          code
          onChange={(nextLink) => onChange({ ...paging, nextLink })}
        />
      ) : null}
      {paging.type === 'page' ? (
        <>
          <TextField
            label='Page number parameter'
            value={paging.pageParam}
            code
            onChange={(pageParam) => onChange({ ...paging, pageParam })}
          />
          <TextField
            label='Page size parameter'
            value={paging.sizeParam}
            code
            onChange={(sizeParam) => onChange({ ...paging, sizeParam })}
          />
          <NumberField
            label='Items per page'
            value={paging.size}
            min={LIMITS.pageSize.min}
            max={LIMITS.pageSize.max}
            onChange={(size) => onChange({ ...paging, size })}
            onValidityChange={track('pageSize')}
          />
          <Field label='First page number'>
            {({ id: selectId, describedBy }) => (
              <select
                id={selectId}
                className='cf-input cf-select'
                aria-describedby={describedBy}
                disabled={readOnly}
                value={paging.startPage}
                onChange={(event) =>
                  onChange({ ...paging, startPage: Number(event.target.value) === 0 ? 0 : 1 })
                }
              >
                <option value={1}>1</option>
                <option value={0}>0</option>
              </select>
            )}
          </Field>
        </>
      ) : null}
      {paging.type === 'offset' ? (
        <>
          <TextField
            label='Offset parameter'
            value={paging.offsetParam}
            code
            onChange={(offsetParam) => onChange({ ...paging, offsetParam })}
          />
          <TextField
            label='Limit parameter'
            value={paging.limitParam}
            code
            onChange={(limitParam) => onChange({ ...paging, limitParam })}
          />
          <NumberField
            label='Items per request'
            value={paging.limit}
            min={LIMITS.pageSize.min}
            max={LIMITS.pageSize.max}
            onChange={(limit) => onChange({ ...paging, limit })}
            onValidityChange={track('offsetLimit')}
          />
        </>
      ) : null}
      {paging.type === 'cursor' ? (
        <>
          <TextField
            label='Where the next cursor is'
            help='A property of the response, like meta.nextCursor.'
            value={paging.cursorPath}
            code
            onChange={(cursorPath) => onChange({ ...paging, cursorPath })}
          />
          <TextField
            label='Cursor parameter'
            value={paging.cursorParam}
            code
            onChange={(cursorParam) => onChange({ ...paging, cursorParam })}
          />
        </>
      ) : null}
      {props.issueText ? (
        <IssueMessage id={`${id}-issue`} issue={{ tone: 'error', message: props.issueText }} />
      ) : null}
      <NumberField
        label='Maximum pages'
        value={paging.maxPages}
        min={LIMITS.maxPages.min}
        max={LIMITS.maxPages.max}
        onChange={(maxPages) => onChange({ ...paging, maxPages })}
        onValidityChange={track('maxPages')}
      />
    </div>
  );
}

function PolicyCap({ setting, cap, noun }: { setting: number; cap: number; noun: string }) {
  return setting > cap ? (
    <p className='cf-hint'>
      Your organization’s security policy allows up to {formatNumber(cap)} {noun}, so that’s where
      the list stops.
    </p>
  ) : null;
}

/** The optional features, each closed until needed, with its state summed up in the header. */
export function OptionalSections(props: {
  draft: Draft;
  issues: Issues;
  policy: SecurityPolicy;
  /** Properties of the first item from the last test, for the “Copy to field” helpers. */
  properties: readonly PropertyCandidate[];
  onChange: (patch: Partial<Draft>) => void;
  /** Number fields say whether what's typed is valid, under keys of their own. */
  onValidityChange: (key: string, valid: boolean) => void;
  /** Number fields that aren't valid, by key, to flag their section. */
  invalid: ReadonlySet<string>;
  /** Changes when Save is pressed with problems, to open the sections that have them. */
  reveal: number;
}) {
  const { draft, issues, policy, properties, onChange, invalid, reveal } = props;
  const readOnly = useContext(ReadOnlyContext);
  const setAdvanced = (patch: Partial<AdvancedSettings>) =>
    onChange({ advanced: { ...draft.advanced, ...patch } });
  const track = (key: NumberKey) => (valid: boolean) => props.onValidityChange(key, valid);
  const mapped = new Set(Object.values(parseFieldMap(draft.fieldMap).map ?? {}));
  const { paging } = draft.advanced;
  const copyChoices = (['all', 'first'] as const).map((value) => ({
    value,
    label: COPY_MODE_LABELS[value],
    help:
      value === 'all'
        ? 'Values are joined like the field: A; B; C.'
        : 'Other fields get the first picked item’s values.',
  }));
  const fieldMapAttention = issues.fieldMap?.tone === 'error';
  const pagingAttention =
    issues.paging?.tone === 'error' || PAGING_NUMBERS.some((key) => invalid.has(key));
  const behaviorAttention = BEHAVIOR_NUMBERS.some((key) => invalid.has(key));

  return (
    <div className='cf-sections'>
      <Collapsible id='multiple' title='Multiple values' summary={summarizeMultiple(draft)}>
        <CheckboxField
          label={LABELS.allowMultiple}
          help='Saved as A; B; C, so use a multi-line text field for long lists. Single-line text fields hold up to 255 characters.'
          checked={draft.allowMultiple}
          onChange={(allowMultiple) => onChange({ allowMultiple })}
        />
        {draft.allowMultiple ? (
          <RadioGroupField<CopyMode>
            legend='With several picks, Copy to other fields should'
            choices={copyChoices}
            value={draft.advanced.copyMode}
            onChange={(copyMode) => setAdvanced({ copyMode })}
          />
        ) : null}
      </Collapsible>

      <Collapsible
        id='fieldMap'
        title='Copy to other fields'
        summary={summarizeFieldMap(draft)}
        attention={fieldMapAttention}
        reveal={reveal}
      >
        <TextField
          label={LABELS.fieldMap}
          help={
            <>
              Work item field reference name → property of the picked item. Example:{' '}
              <code className='cf-code'>
                {'{ "Custom.CustomerId": "id", "Custom.Email": "contact.email" }'}
              </code>
            </>
          }
          value={draft.fieldMap}
          issue={issues.fieldMap}
          code
          multiline
          onChange={(fieldMap) => onChange({ fieldMap })}
        />
        {properties.length > 0 ? (
          <div className='cf-block'>
            <p className='cf-subheading'>Properties of the first item</p>
            <p className='cf-hint'>
              Adds a line to the JSON; rename the field to one in your process.
            </p>
            <ul className='cf-properties'>
              {properties.map((property) => {
                const isMapped = mapped.has(property.path);
                return (
                  <li key={property.path} className='cf-property'>
                    <div className='cf-property__text'>
                      <code>{property.path}</code>
                      <span className='cf-property__sample'>{property.sample}</span>
                    </div>
                    <button
                      type='button'
                      className='cf-chip cf-chip--small cf-chip--quiet'
                      disabled={isMapped || Boolean(issues.fieldMap) || readOnly}
                      aria-label={
                        isMapped ? `${property.path} is copied` : `Copy ${property.path} to a field`
                      }
                      onClick={() => {
                        const next = addToFieldMap(draft.fieldMap, property.path);
                        if (next !== null) {
                          onChange({ fieldMap: next });
                        }
                      }}
                    >
                      {isMapped ? 'Copied' : 'Copy to field'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : readOnly ? null : (
          <p className='cf-hint'>Run the test to pick properties from your data.</p>
        )}
      </Collapsible>

      <Collapsible
        id='paging'
        title='Paging'
        summary={summarizePaging(draft)}
        attention={pagingAttention}
        reveal={reveal}
      >
        <Field label='How the API returns long lists' help={PAGING_HELP[paging.type]}>
          {({ id, describedBy }) => (
            <select
              id={id}
              className='cf-input cf-select'
              aria-describedby={describedBy}
              disabled={readOnly}
              value={paging.type}
              onChange={(event) => {
                const type = PAGING_TYPES.find((option) => option === event.target.value) ?? 'none';
                setAdvanced({ paging: pagingForType(type, paging) });
              }}
            >
              {PAGING_TYPES.map((type) => (
                <option key={type} value={type}>
                  {PAGING_LABELS[type]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {paging.type !== 'none' ? (
          <>
            <PagingFields
              paging={paging}
              issueText={issues.paging?.message ?? null}
              onChange={(next) => setAdvanced({ paging: next })}
              track={track}
            />
            <PolicyCap setting={paging.maxPages} cap={policy.maxPages} noun='pages' />
          </>
        ) : null}
        <NumberField
          label='Maximum items'
          help='The list stops here, with or without paging.'
          value={draft.advanced.maxItems}
          min={LIMITS.maxItems.min}
          max={LIMITS.maxItems.max}
          onChange={(maxItems) => setAdvanced({ maxItems })}
          onValidityChange={track('maxItems')}
        />
        <PolicyCap setting={draft.advanced.maxItems} cap={policy.maxItems} noun='items' />
      </Collapsible>

      <Collapsible
        id='behavior'
        title='Behavior'
        summary={summarizeBehavior(draft)}
        attention={behaviorAttention}
        reveal={reveal}
      >
        <CheckboxField
          label={LABELS.loadOnFormOpen}
          help='Off: it loads when someone opens the list, so forms open faster. Turn it on for small, fast APIs so the list appears instantly.'
          checked={draft.loadOnFormOpen}
          onChange={(loadOnFormOpen) => onChange({ loadOnFormOpen })}
        />
        <CheckboxField
          label={LABELS.required}
          help='Fields required by work item rules are detected automatically. This adds a red outline only; to block saving, require the field on the work item type.'
          checked={draft.required}
          onChange={(required) => onChange({ required })}
        />
        <TextField
          label={LABELS.notFoundMessage}
          help='Shown under the field when its saved value is no longer offered by the service. Leave empty for a standard message.'
          value={draft.notFoundMessage}
          placeholder='This customer is no longer active.'
          onChange={(notFoundMessage) => onChange({ notFoundMessage })}
        />
        <NumberField
          label='Timeout'
          help='How long to wait for each response.'
          unit='seconds'
          value={draft.advanced.timeoutSeconds}
          min={LIMITS.timeoutSeconds.min}
          max={LIMITS.timeoutSeconds.max}
          onChange={(timeoutSeconds) => setAdvanced({ timeoutSeconds })}
          onValidityChange={track('timeout')}
        />
        <PolicyCap
          setting={draft.advanced.timeoutSeconds}
          cap={policy.timeoutSeconds}
          noun='seconds'
        />
      </Collapsible>
    </div>
  );
}
