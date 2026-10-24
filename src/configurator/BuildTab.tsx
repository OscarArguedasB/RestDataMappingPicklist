import type { ReactNode } from 'react';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PicklistError } from '../core/errors';
import { rankLists, suggestDetailProperties, suggestValueProperties } from '../core/detect';
import { listProperties } from '../core/inspect';
import { buildPicklistData } from '../core/items';
import type { SecurityPolicy } from '../core/policy';
import { requestFieldDependencies } from '../core/request';
import type { StoredSecret } from '../core/secrets';
import { isPlainObject } from '../core/values';
import { ConnectCard } from './ConnectCard';
import { OptionalSections } from './OptionalSections';
import type { ProbeCredential, ProbeMode, ProbeResult } from './probe';
import { countScope, describeFailure, locateCurrentRows, probeKey, runProbe } from './probe';
import type { Draft, Issues } from './settings';
import { REQUIRED_MESSAGES, blocksRequest, missingRequired } from './settings';
import type { RunState, TokenProgress } from './TestPanel';
import { TestPanel } from './TestPanel';
import type { ValuesSample } from './ValuesCard';
import { ValuesCard } from './ValuesCard';

/** Property suggestions computed per setting; ValuesCard shows three and folds the rest. */
const SUGGESTION_LIMIT = 5;

/**
 * What the test signs in with: what was typed or chosen on this page, else the configuration's
 * saved secret, read only when the test runs and kept for that run only.
 */
export type TestCredential =
  /** The sign-in method needs no secret. */
  | { source: 'none' }
  | { source: 'entered'; secret: StoredSecret }
  | { source: 'saved'; load: () => Promise<StoredSecret> }
  /** One is needed and there's none to use; the message says what to do. */
  | { source: 'missing'; message: string };

async function resolveCredential(credential: TestCredential): Promise<ProbeCredential | null> {
  switch (credential.source) {
    case 'none':
      return null;
    case 'entered':
      return { secret: credential.secret, source: 'entered' };
    case 'saved':
      return { secret: await credential.load(), source: 'saved' };
    default:
      throw new PicklistError('config', credential.message);
  }
}

/**
 * The configuration editor's settings and test: the settings cards on the left, the test and the
 * live preview (the real control) on the right, or below them on narrower screens.
 */
export function BuildTab(props: {
  draft: Draft;
  issues: Issues;
  policy: SecurityPolicy;
  /** Settings can be viewed but not changed, and there's no test. */
  readOnly: boolean;
  fetchImpl?: typeof fetch;
  onChange: (patch: Partial<Draft>) => void;
  /** Offered while the URL is empty. */
  onUseSample?: () => void;
  /** The Credentials card, between Connect and Values. */
  credentials?: ReactNode;
  /** After the optional sections, like “Use it on a form”. */
  after?: ReactNode;
  testCredential: TestCredential;
  /** Identifies the test's secret without revealing it, so a result can tell it changed. */
  credentialId: string;
  onValidityChange: (key: string, valid: boolean) => void;
  invalid: ReadonlySet<string>;
  /** Changes when Save is pressed with problems, to open the sections that have them. */
  reveal: number;
}) {
  const { draft, issues, policy, onChange, readOnly, testCredential } = props;
  const id = useId();
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const [token, setToken] = useState<TokenProgress | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const tokens = useMemo(
    () => requestFieldDependencies({ url: draft.url, params: draft.params }),
    [draft.url, draft.params]
  );
  const missing = missingRequired(draft).filter((key) => key !== 'url');
  const blocked = blocksRequest(issues);
  const blocker = blocked
    ? 'Fix the settings marked in Connect to test.'
    : missing[0]
      ? REQUIRED_MESSAGES[missing[0]]
      : testCredential.source === 'missing'
        ? testCredential.message
        : null;
  const canRun = !readOnly && Boolean(draft.url.trim()) && !blocker;

  const start = async (mode: ProbeMode) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRun({ status: 'running', mode, rows: null, pages: 0 });
    setToken(null);
    try {
      const credential = await resolveCredential(testCredential);
      if (controller.signal.aborted) {
        return;
      }
      const next = await runProbe({
        draft,
        samples,
        policy,
        mode,
        credential,
        credentialId: props.credentialId,
        fetchImpl: props.fetchImpl,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted && !progress.done) {
            setRun({ status: 'running', mode, rows: progress.rows, pages: progress.page });
          }
        },
        onToken: (received) => {
          if (!controller.signal.aborted) {
            setToken(
              received
                ? { status: 'done', expiresAt: received.expiresAt, receivedAt: Date.now() }
                : { status: 'running' }
            );
          }
        },
      });
      if (!controller.signal.aborted) {
        setResult(next);
        setRun({ status: 'done', mode });
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof PicklistError && error.kind === 'aborted')
      ) {
        return;
      }
      const failure = describeFailure(error);
      setResult(null);
      if (failure.step === 'token') {
        setToken({ status: 'failed' });
      }
      setRun({ status: 'error', mode, failure });
    }
  };

  // Lists can hold 50,000 rows, so the work that depends on what's being typed runs on deferred
  // values: typing stays responsive and the results catch up a moment later.
  const arrayPath = useDeferredValue(draft.arrayPath);
  const keyField = useDeferredValue(draft.keyField);
  const secondLine = useDeferredValue(draft.secondLine);

  const located = useMemo(
    () => (result ? locateCurrentRows(result, arrayPath) : null),
    [result, arrayPath]
  );
  const picklist = useMemo(
    () => (located?.rows ? buildPicklistData(located.rows, keyField, secondLine) : null),
    [located, keyField, secondLine]
  );
  // While pages stream in, the preview shows what has arrived so far.
  const progressRows = run.status === 'running' ? run.rows : null;
  const progressPicklist = useMemo(
    () => (progressRows ? buildPicklistData(progressRows, keyField, secondLine) : null),
    [progressRows, keyField, secondLine]
  );
  // Each piece is computed only when what it depends on changes.
  const lists = useMemo(() => (result ? rankLists(result.firstResponse) : []), [result]);
  // The card shows the top few and keeps the rest behind “More suggestions”.
  const valueSuggestions = useMemo(
    () => (located?.rows ? suggestValueProperties(located.rows, SUGGESTION_LIMIT) : []),
    [located]
  );
  const detailSuggestions = useMemo(
    () => (located?.rows ? suggestDetailProperties(located.rows, keyField, SUGGESTION_LIMIT) : []),
    [located, keyField]
  );
  const sample = useMemo(
    (): ValuesSample | null =>
      located && result
        ? {
            lists,
            located,
            counts: countScope(result),
            picklist,
            valueSuggestions,
            detailSuggestions,
          }
        : null,
    [lists, located, result, picklist, valueSuggestions, detailSuggestions]
  );
  const properties = useMemo(() => {
    const row = located?.rows?.find(isPlainObject);
    return row ? listProperties(row) : [];
  }, [located]);
  const stale =
    result !== null && result.key !== probeKey(draft, samples, policy, props.credentialId);
  const onValidityChange = props.onValidityChange;

  return (
    <div className='cf-editor__layout'>
      {/* Not a <form> element: browsers offer to save what's typed in a form's password
          fields, and the credentials card is in here. Nothing here is submitted anyway. */}
      <section className='cf-editor__form' aria-label='Settings'>
        <ConnectCard
          draft={draft}
          issues={issues}
          policy={policy}
          onChange={onChange}
          onUseSample={props.onUseSample}
          onValidityChange={onValidityChange}
          invalid={props.invalid}
          reveal={props.reveal}
        />
        {props.credentials}
        <ValuesCard
          draft={draft}
          onChange={onChange}
          sample={sample}
          canDetect={canRun}
          blocker={draft.url.trim() ? blocker : null}
          detecting={run.status === 'running' && run.mode === 'detect'}
          detectError={run.status === 'error' && run.mode === 'detect' ? run.failure.message : null}
          onDetect={() => void start('detect')}
        />
        <OptionalSections
          draft={draft}
          issues={issues}
          policy={policy}
          properties={properties}
          onChange={onChange}
          onValidityChange={onValidityChange}
          invalid={props.invalid}
          reveal={props.reveal}
        />
        {props.after}
      </section>

      <div className='cf-editor__side'>
        {readOnly ? (
          <section className='cf-card cf-test' aria-labelledby={`${id}-test`}>
            <h3 id={`${id}-test`} className='cf-card__title'>
              Test and preview
            </h3>
            <p className='cf-empty cf-empty--spaced'>
              Only people who can change this configuration can test it.
            </p>
          </section>
        ) : (
          <TestPanel
            draft={draft}
            tokens={tokens}
            samples={samples}
            onSampleChange={(field, value) =>
              setSamples((current) => ({ ...current, [field]: value }))
            }
            canRun={canRun}
            blocker={blocker}
            run={run}
            token={token}
            result={result}
            located={located}
            picklist={run.status === 'running' ? progressPicklist : picklist}
            stale={stale}
            onRun={() => void start('test')}
          />
        )}
      </div>
    </div>
  );
}
