import { memo, useId, useMemo, useState } from 'react';
import { Combobox } from '../components/Combobox';
import { SuccessIcon, WarningIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import { fieldMapUpdates, fieldMapUpdatesForRows, parseFieldMap } from '../core/fieldMap';
import type { CopyMode } from '../core/config';
import type { PicklistData, PicklistItem } from '../core/items';
import type { LocatedRows, ProbeFailure, ProbeMode, ProbeResult } from './probe';
import type { Draft } from './settings';
import { formatNumber } from './settings';
import { Callout } from './ui';

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; mode: ProbeMode; rows: readonly unknown[] | null; pages: number }
  | { status: 'error'; mode: ProbeMode; failure: ProbeFailure }
  | { status: 'done'; mode: ProbeMode };

/** OAuth 2.0: the test's first step. The token itself is never kept or shown. */
export type TokenProgress =
  | { status: 'running' }
  | { status: 'done'; expiresAt: number; receivedAt: number }
  | { status: 'failed' };

/** “expires in 59 min”, from when the token arrived. */
export function expiresIn(expiresAt: number, now: number): string {
  // To the nearest minute: the token arrives a few milliseconds before this is worked out.
  const minutes = Math.round((expiresAt - now) / 60_000);
  if (minutes < 1) {
    return 'expires in less than a minute';
  }
  return minutes < 120
    ? `expires in ${formatNumber(minutes)} min`
    : `expires in ${formatNumber(Math.round(minutes / 60))} h`;
}

const MAX_PREVIEW_LINES = 160;

function previewJson(data: unknown): string {
  const text = JSON.stringify(data, null, 2) ?? 'null';
  const lines = text.split('\n');
  if (lines.length <= MAX_PREVIEW_LINES) {
    return text;
  }
  return `${lines.slice(0, MAX_PREVIEW_LINES).join('\n')}\n… ${formatNumber(lines.length - MAX_PREVIEW_LINES)} more lines`;
}

function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** The preview's picks, kept by item key so mapped fields use the exact row that was picked. */
function usePreviewSelection(picklist: PicklistData | null, multiple: boolean) {
  const [keys, setKeys] = useState<string[]>([]);
  const itemsByKey = useMemo(
    () => new Map(picklist?.items.map((item) => [item.key, item]) ?? []),
    [picklist]
  );
  const shown = useMemo(() => {
    const available = keys.filter((key) => itemsByKey.has(key));
    return multiple ? available : available.slice(0, 1);
  }, [keys, itemsByKey, multiple]);
  const values = useMemo(
    () => [...new Set(shown.map((key) => itemsByKey.get(key)?.value ?? '').filter(Boolean))],
    [shown, itemsByKey]
  );
  return {
    keys: shown,
    values,
    select: (item: PicklistItem) =>
      setKeys((current) =>
        multiple ? [...current.filter((key) => key !== item.key), item.key] : [item.key]
      ),
    remove: (value: string) =>
      setKeys((current) => current.filter((key) => itemsByKey.get(key)?.value !== value)),
    // Like the control: clearing the field also empties the fields it copied to.
    clear: () => setKeys([]),
  };
}

interface PreviewProps {
  picklist: PicklistData | null;
  running: boolean;
  multiple: boolean;
  required: boolean;
  fieldMap: string;
  copyMode: CopyMode;
  footerNote: string | null;
}

/**
 * The real combobox with the list the test loaded, plus what “Copy to other fields” would write.
 * Memoized: typing in unrelated settings doesn't re-render the list.
 */
const Preview = memo(function Preview(props: PreviewProps) {
  const { picklist, running, multiple, required } = props;
  const selection = usePreviewSelection(picklist, multiple);
  const fieldMap = useMemo(() => parseFieldMap(props.fieldMap).map, [props.fieldMap]);
  const mappedFields = Object.keys(fieldMap ?? {});
  const mapped = useMemo((): Record<string, string | number | boolean> => {
    const rows = selection.keys
      .map((key) => picklist?.rows.get(key))
      .filter((row) => row !== undefined);
    return multiple
      ? fieldMapUpdatesForRows(rows, fieldMap, props.copyMode)
      : fieldMapUpdates(rows[0], fieldMap);
  }, [selection.keys, picklist, multiple, fieldMap, props.copyMode]);

  if (picklist && picklist.items.length === 0 && !running) {
    return <p className='cf-hint'>No values found. Check “Value property” in Choose the values.</p>;
  }
  const picked = selection.values.length > 0;
  return (
    <>
      <p className='cf-hint'>
        {multiple
          ? 'This is how the list looks on the form, with multiple values. Try searching and picking a few.'
          : 'This is how the list looks on the form. Try searching.'}
      </p>
      <div className='cf-preview'>
        <Combobox
          label='Preview'
          items={picklist?.items ?? null}
          loading={running && !picklist}
          loadingMore={running ? 'Loading more…' : null}
          footerNote={props.footerNote}
          selected={selection.values}
          multiple={multiple}
          tone={required && !picked ? 'error' : picked ? 'dirty' : 'default'}
          required={required}
          clearable={!required || multiple}
          onSelect={selection.select}
          onRemove={selection.remove}
          onClear={selection.clear}
        />
      </div>
      {mappedFields.length > 0 ? (
        <>
          <dl className='cf-mapped' aria-label='Copied to other fields'>
            {mappedFields.map((field) => {
              const value = mapped[field];
              return (
                <div key={field} className='cf-mapped__row'>
                  <dt>
                    <code>{field}</code>
                  </dt>
                  <dd>
                    {!picked
                      ? '—'
                      : value === undefined || value === ''
                        ? 'Not in the picked item'
                        : String(value)}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className='cf-hint'>Clearing the field empties these fields too.</p>
        </>
      ) : null}
    </>
  );
});

/** Calls the endpoint like the control on the form does and shows the list it would offer. */
export function TestPanel(props: {
  draft: Draft;
  tokens: readonly string[];
  samples: Record<string, string>;
  onSampleChange: (field: string, value: string) => void;
  canRun: boolean;
  /** Why the test can't run yet, once the URL is there. */
  blocker: string | null;
  run: RunState;
  /** OAuth 2.0: getting the token, before the request. */
  token: TokenProgress | null;
  result: ProbeResult | null;
  located: LocatedRows | null;
  picklist: PicklistData | null;
  stale: boolean;
  onRun: () => void;
}) {
  const { draft, run, result, located, picklist } = props;
  const id = useId();
  const running = run.status === 'running';
  // A whole response can be large; it's formatted once per test, not on every keystroke.
  const responseText = useMemo(() => (result ? previewJson(result.firstResponse) : ''), [result]);

  const tokenLine = (() => {
    const { token } = props;
    if (token?.status === 'running') {
      return (
        <p className='cf-progress'>
          <Spinner />
          <span>Getting a token…</span>
        </p>
      );
    }
    if (token?.status === 'done') {
      return (
        <p className='cf-state cf-state--ok cf-token-line'>
          <SuccessIcon />
          <span>Got a token · {expiresIn(token.expiresAt, token.receivedAt)}</span>
        </p>
      );
    }
    return null;
  })();

  const status = (() => {
    if (running) {
      if (props.token?.status === 'running') {
        return null;
      }
      const loaded = run.rows ? ` · ${plural(run.rows.length, 'item', 'items')} so far` : '';
      return (
        <p className='cf-progress'>
          <Spinner />
          <span>
            {run.pages > 0 ? `Loading page ${run.pages + 1}…${loaded}` : 'Calling the service…'}
          </span>
        </p>
      );
    }
    if (run.status === 'error') {
      const { failure } = run;
      return (
        <Callout tone='error' title={failure.message}>
          {failure.network ? (
            <p>
              If the URL is right, the {failure.step === 'token' ? 'token service' : 'service'} may
              not accept calls from Azure DevOps. Ask its owner to allow this origin (CORS):{' '}
              <code className='cf-code'>{window.location.origin}</code>
            </p>
          ) : null}
        </Callout>
      );
    }
    if (!result) {
      return null;
    }
    const count = picklist?.items.length ?? 0;
    const pagingOn = draft.advanced.paging.type !== 'none';
    return (
      <Callout
        tone='success'
        title={[
          `${result.httpStatus || 200} OK`,
          plural(count, 'value', 'values'),
          plural(result.pages, 'page', 'pages'),
          `${formatNumber(result.ms)} ms`,
        ].join(' · ')}
      >
        <p className='cf-meta'>
          <span>GET</span> <code className='cf-code cf-code--wrap'>{result.url}</code>
        </p>
        <p className='cf-meta'>
          Sign-in: {result.signIn}
          {result.secretSource === 'saved'
            ? ' (the saved secret)'
            : result.secretSource === 'entered'
              ? ' (entered here)'
              : ''}
        </p>
        {located && !located.error ? (
          <p className='cf-meta'>
            List: <code className='cf-code'>{located.path || '(whole response)'}</code>
            {located.automatic ? ' (found automatically)' : ''}
          </p>
        ) : null}
        {picklist?.valueProperty ? (
          <p className='cf-meta'>
            Value: <code className='cf-code'>{picklist.valueProperty}</code>
            {draft.keyField.trim() ? '' : ' (picked automatically)'}
            {picklist.detailProperty ? (
              <>
                {' · '}Second line: <code className='cf-code'>{picklist.detailProperty}</code>
              </>
            ) : null}
          </p>
        ) : null}
        {result.truncated ? (
          <p className='cf-meta'>
            {result.mode === 'detect' && pagingOn
              ? 'Detect loads the first page only. Run the test to load every page.'
              : `Stopped at ${plural(result.rows.length, 'item', 'items')} (${plural(result.pages, 'page', 'pages')}): a limit was reached while more data existed.`}
          </p>
        ) : null}
        {result.mode === 'test' &&
        result.pages === 1 &&
        !result.truncated &&
        draft.advanced.paging.type === 'nextLink' &&
        !draft.advanced.paging.nextLink.trim() ? (
          <p className='cf-meta'>
            If the service sends a Link header, it must list Link in Access-Control-Expose-Headers
            so the browser can read it.
          </p>
        ) : null}
        {located?.firstPageOnly ? (
          <p className='cf-meta'>
            The list path changed, so this shows the first page. Run the test again for every page.
          </p>
        ) : null}
      </Callout>
    );
  })();

  return (
    <section className='cf-card cf-test' aria-labelledby={`${id}-title`}>
      <div className='cf-card__header'>
        <div>
          <h3 id={`${id}-title`} className='cf-card__title'>
            Test and preview
          </h3>
          <p className='cf-card__description'>
            Calls the service from your browser with your organization’s security policy, exactly
            like the control on the form.
          </p>
        </div>
        <button
          type='button'
          className='cf-button'
          disabled={!props.canRun || running}
          onClick={props.onRun}
        >
          {running ? <Spinner /> : null}
          {running ? 'Testing…' : 'Run test'}
        </button>
      </div>

      {props.tokens.length > 0 ? (
        <div className='cf-samples'>
          <p className='cf-subheading'>Sample work item values</p>
          {props.tokens.map((token) => (
            <label key={token} className='cf-sample'>
              <code className='cf-code'>{token}</code>
              <input
                className='cf-input'
                value={props.samples[token] ?? ''}
                placeholder='Value to test with'
                onChange={(event) => props.onSampleChange(token, event.target.value)}
              />
            </label>
          ))}
        </div>
      ) : null}

      {!draft.url.trim() ? (
        <p className='cf-empty'>Enter a REST endpoint URL to test it here.</p>
      ) : props.blocker && !running ? (
        <p className='cf-empty'>{props.blocker}</p>
      ) : null}

      <div className='cf-test__status' aria-live='polite'>
        {tokenLine}
        {status}
      </div>
      {props.stale && result && !running ? (
        <p className='cf-hint cf-hint--stale'>
          <WarningIcon />
          <span>Settings changed since this test. Run it again to check them.</span>
        </p>
      ) : null}

      {picklist || running ? (
        <div className='cf-block'>
          <p className='cf-subheading'>Preview</p>
          <Preview
            picklist={picklist}
            running={running}
            multiple={draft.allowMultiple}
            required={draft.required}
            fieldMap={draft.fieldMap}
            copyMode={draft.advanced.copyMode}
            footerNote={
              result?.truncated && !running
                ? `Showing the first ${formatNumber(result.rows.length)} items`
                : null
            }
          />
        </div>
      ) : null}

      {result ? (
        <details className='cf-raw'>
          <summary>Response{result.pages > 1 ? ' (first page)' : ''}</summary>
          <pre>{responseText}</pre>
        </details>
      ) : null}
    </section>
  );
}
