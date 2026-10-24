import type { ReactNode } from 'react';
import { useContext, useId, useState } from 'react';
import { AlertIcon, ChevronDownIcon, SuccessIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import type { ListCandidate, PropertySuggestion } from '../core/detect';
import type { PicklistData } from '../core/items';
import type { CountScope, LocatedRows } from './probe';
import type { Draft } from './settings';
import { LABELS, formatNumber } from './settings';
import { ReadOnlyContext, TextField } from './ui';

export interface ValuesSample {
  /** Lists in the first response, counted in that response. */
  lists: readonly ListCandidate[];
  located: LocatedRows;
  /** What the located rows' count covers. */
  counts: CountScope;
  picklist: PicklistData | null;
  valueSuggestions: readonly PropertySuggestion[];
  detailSuggestions: readonly PropertySuggestion[];
}

/** Suggestions shown before “More suggestions”; the rest wait behind it to keep the card short. */
const INLINE_SUGGESTIONS = 3;

function itemCount(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? 'item' : 'items'}`;
}

/** After the “Found” line's count: which part of the list it covers, when not simply all of it. */
function foundScope(located: LocatedRows, counts: CountScope): string {
  if (located.firstPageOnly || counts.firstPageOfMore) {
    return ' on the first page';
  }
  const pages = counts.pages > 1 ? ` from ${formatNumber(counts.pages)} pages` : '';
  return `${pages}${counts.limited ? ' (limit reached)' : ''}`;
}

function StateLine({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  return (
    <p className={`cf-state cf-state--${tone}`}>
      {tone === 'ok' ? <SuccessIcon /> : <AlertIcon />}
      <span>{children}</span>
    </p>
  );
}

/**
 * Suggestion chips: pressing one fills the setting; the first chip means “leave it empty”. The top
 * few show inline and the rest wait behind a “More suggestions” disclosure, so the card stays short.
 */
function Suggestions(props: {
  label: string;
  emptyLabel: string;
  value: string;
  suggestions: readonly PropertySuggestion[];
  onPick: (path: string) => void;
}) {
  const current = props.value.trim();
  const moreId = useId();
  const [expanded, setExpanded] = useState(false);
  const inline = props.suggestions.slice(0, INLINE_SUGGESTIONS);
  const rest = props.suggestions.slice(INLINE_SUGGESTIONS);
  // The chosen suggestion stays in view while the rest are folded. Once they're shown it stays
  // where it is, so pressing one never moves it (and the keyboard focus) somewhere else.
  const pinned = expanded ? undefined : rest.find((suggestion) => suggestion.path === current);
  const folded = rest.filter((suggestion) => suggestion !== pinned);

  const chip = (suggestion: PropertySuggestion) => (
    <button
      key={suggestion.path}
      type='button'
      className='cf-chip cf-chip--suggestion'
      aria-pressed={current === suggestion.path}
      title={suggestion.sample ? `Example: ${suggestion.sample}` : undefined}
      onClick={() => props.onPick(suggestion.path)}
    >
      <code className='cf-chip__main'>{suggestion.path}</code>
      {/* One line; a long reason ends in “…” and shows in full on hover (and in the name). */}
      <span className='cf-chip__meta' title={suggestion.reason}>
        {suggestion.reason}
      </span>
    </button>
  );

  return (
    <fieldset className='cf-suggestions'>
      <legend className='rp-sr-only'>{props.label}</legend>
      <button
        type='button'
        className='cf-chip cf-chip--suggestion'
        aria-pressed={!current}
        onClick={() => props.onPick('')}
      >
        <span className='cf-chip__main'>{props.emptyLabel}</span>
      </button>
      {inline.map(chip)}
      {pinned ? chip(pinned) : null}
      {folded.length > 0 ? (
        <>
          <button
            type='button'
            className='cf-chip cf-chip--quiet cf-chip--more'
            aria-expanded={expanded}
            aria-controls={moreId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Fewer suggestions' : `More suggestions (${folded.length})`}
            <span className='cf-chip__chevron'>
              <ChevronDownIcon />
            </span>
          </button>
          <div id={moreId} className='cf-suggestions__more' hidden={!expanded}>
            {expanded ? folded.map(chip) : null}
          </div>
        </>
      ) : null}
    </fieldset>
  );
}

/** Which list to read and what to show for each item. Always open. */
export function ValuesCard(props: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  sample: ValuesSample | null;
  canDetect: boolean;
  /** Why Detect can't run yet, when it's something other than the URL. */
  blocker?: string | null;
  detecting: boolean;
  /** Why the last Detect failed. */
  detectError: string | null;
  onDetect: () => void;
}) {
  const { draft, onChange, sample } = props;
  const id = useId();
  // Detect calls the service, which only people who may change the configuration do.
  const readOnly = useContext(ReadOnlyContext);
  const located = sample?.located ?? null;
  const picklist = sample?.picklist ?? null;
  const rows = located?.rows ?? null;
  const objectRows = rows?.some((row) => typeof row === 'object' && row !== null) ?? false;

  const detectButton = readOnly ? undefined : (
    <button
      type='button'
      className='cf-button cf-button--small'
      disabled={!props.canDetect || props.detecting}
      aria-describedby={`${id}-detect-help`}
      onClick={props.onDetect}
    >
      {props.detecting ? <Spinner /> : null}
      {props.detecting ? 'Detecting…' : 'Detect'}
    </button>
  );

  let listState: ReactNode = null;
  if (props.detectError) {
    listState = <StateLine tone='error'>{props.detectError}</StateLine>;
  } else if (located?.error) {
    listState = <StateLine tone='error'>{located.error}</StateLine>;
  } else if (located && rows) {
    const where = located.path ? (
      <code className='cf-code'>{located.path}</code>
    ) : (
      'the whole response'
    );
    listState = (
      <StateLine tone='ok'>
        {located.automatic ? 'Automatic: ' : 'Found: '}
        {where} · {itemCount(rows.length)}
        {sample ? foundScope(located, sample.counts) : ''}
      </StateLine>
    );
  }

  const otherLists = sample?.lists ?? [];
  // The chips count the first response; say so when that isn't the whole list.
  const listsFromFirstPage = sample
    ? sample.counts.pages > 1 || sample.counts.firstPageOfMore
    : false;

  return (
    <section className='cf-card' aria-labelledby={`${id}-title`}>
      <div className='cf-card__header'>
        <div>
          <h3 id={`${id}-title`} className='cf-card__title'>
            <span className='cf-step' aria-hidden='true'>
              2
            </span>
            Choose the values
          </h3>
          <p className='cf-card__description'>
            Which list to read and what to show for each item. Empty settings are found
            automatically.
          </p>
        </div>
      </div>

      <TextField
        label={LABELS.arrayPath}
        help={
          <>
            Dots for nesting, brackets for positions, like{' '}
            <code className='cf-code'>data.items[0]</code>. Leave empty to find it automatically.
          </>
        }
        value={draft.arrayPath}
        placeholder='Automatic'
        code
        action={detectButton}
        onChange={(arrayPath) => onChange({ arrayPath })}
        after={
          <>
            {readOnly ? null : (
              <p id={`${id}-detect-help`} className='rp-sr-only'>
                Calls the endpoint once and shows the list and properties it finds.
              </p>
            )}
            <div aria-live='polite'>{listState}</div>
            {!sample && !props.detectError && !readOnly ? (
              <p className='cf-hint'>
                {props.canDetect
                  ? 'Detect calls the endpoint once and suggests the list and properties to use.'
                  : (props.blocker ??
                    'Enter a REST endpoint URL, then use Detect to see what the response holds.')}
              </p>
            ) : null}
            {otherLists.length > 1 ? (
              <fieldset className='cf-suggestions'>
                <legend className='rp-sr-only'>Lists in the response</legend>
                <button
                  type='button'
                  className='cf-chip cf-chip--suggestion'
                  aria-pressed={!draft.arrayPath.trim()}
                  onClick={() => onChange({ arrayPath: '' })}
                >
                  <span className='cf-chip__main'>Automatic</span>
                </button>
                {otherLists.slice(0, 5).map((list) => (
                  <button
                    key={list.path || '(root)'}
                    type='button'
                    className='cf-chip cf-chip--suggestion'
                    aria-pressed={draft.arrayPath.trim() === list.path}
                    onClick={() => onChange({ arrayPath: list.path })}
                  >
                    <code className='cf-chip__main'>{list.path || '(whole response)'}</code>
                    <span className='cf-chip__meta'>
                      {itemCount(list.length)}
                      {listsFromFirstPage ? ' on the first page' : ''}
                    </span>
                  </button>
                ))}
              </fieldset>
            ) : null}
          </>
        }
      />

      <TextField
        label={LABELS.keyField}
        help='The property that is listed and saved in the field. Leave empty to pick the most name-like text; set it to keep the choice stable.'
        value={draft.keyField}
        placeholder='Automatic'
        code
        onChange={(keyField) => onChange({ keyField })}
        after={
          picklist && objectRows ? (
            <>
              {!draft.keyField.trim() && picklist.valueProperty ? (
                <StateLine tone='ok'>
                  Automatic: <code className='cf-code'>{picklist.valueProperty}</code>
                </StateLine>
              ) : null}
              {draft.keyField.trim() && picklist.items.length === 0 ? (
                <StateLine tone='error'>
                  No item has a value in <code className='cf-code'>{draft.keyField.trim()}</code>.
                </StateLine>
              ) : null}
              <Suggestions
                label={`Suggestions for ${LABELS.keyField}`}
                emptyLabel='Automatic'
                value={draft.keyField}
                suggestions={sample?.valueSuggestions ?? []}
                onPick={(keyField) => onChange({ keyField })}
              />
            </>
          ) : rows && !objectRows ? (
            <p className='cf-hint'>The list holds plain values, so no property is needed.</p>
          ) : null
        }
      />

      <TextField
        label={`${LABELS.secondLine} (optional)`}
        help='Shown smaller under each value and searched too. Tells apart equal names.'
        value={draft.secondLine}
        placeholder='None'
        code
        onChange={(secondLine) => onChange({ secondLine })}
        after={
          picklist && objectRows && (sample?.detailSuggestions.length ?? 0) > 0 ? (
            <Suggestions
              label={`Suggestions for ${LABELS.secondLine}`}
              emptyLabel='None'
              value={draft.secondLine}
              suggestions={sample?.detailSuggestions ?? []}
              onPick={(secondLine) => onChange({ secondLine })}
            />
          ) : null
        }
      />
    </section>
  );
}
