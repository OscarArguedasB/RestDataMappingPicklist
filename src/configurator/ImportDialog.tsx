import { useEffect, useId, useRef, useState } from 'react';
import { AlertIcon, SuccessIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import type { ConfigurationDocument, ConfigurationFileEntry } from '../core/configurations';
import {
  cleanConfigurationName,
  createConfigurationDocument,
  findNameConflicts,
  nameConflictMessage,
  nameKey,
  validateConfigurationName,
} from '../core/configurations';
import { PicklistError, toUserMessage } from '../core/errors';
import { countOf, describeSignIn, endpointHost } from './configurationStatus';
import { Dialog } from './Dialog';
import type { ProcessSummary, SetupServices } from './services';

interface Row {
  include: boolean;
  name: string;
}

type Result = { ok: true } | { ok: false; message: string };

/** A starting name for an entry that has none (single-configuration files may not). */
function fallbackName(fileName: string, index: number): string {
  const base = cleanConfigurationName(fileName.replace(/\.json$/i, ''));
  return base
    ? index === 0
      ? base
      : `${base} ${index + 1}`
    : `Imported configuration ${index + 1}`;
}

/**
 * Imports configurations from a file into one process: choose which, rename any whose name is
 * taken, then each is created with a result. Files never hold secrets or user names, so
 * configurations that sign in need theirs entered afterwards.
 */
export function ImportDialog(props: {
  process: ProcessSummary;
  fileName: string;
  entries: readonly ConfigurationFileEntry[];
  configurations: readonly ConfigurationDocument[];
  services: SetupServices;
  processName: (processId: string) => string | undefined;
  onImported: (doc: ConfigurationDocument) => void;
  /** Every configuration as read just before importing, newer than `configurations`. */
  onLatest?: (docs: ConfigurationDocument[]) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { process, entries } = props;
  const id = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    entries.map((entry, index) => ({
      include: true,
      name: entry.name || fallbackName(props.fileName, index),
    }))
  );
  const [phase, setPhase] = useState<'review' | 'running' | 'done'>('review');
  const [results, setResults] = useState<Array<Result | null>>(() => entries.map(() => null));
  // What existed when the dialog opened: names are checked against these, not the ones it adds.
  const [existing] = useState(() => props.configurations);
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (phase === 'done') {
      doneRef.current?.focus();
    }
  }, [phase]);

  const problems = rows.map((row, index): string | null => {
    if (!row.include) {
      return null;
    }
    const invalid = validateConfigurationName(row.name);
    if (invalid) {
      return invalid;
    }
    const [conflict] = findNameConflicts(existing, { name: row.name, processIds: [process.id] });
    if (conflict) {
      return nameConflictMessage(conflict, props.processName);
    }
    const twice = rows.some(
      (other, otherIndex) =>
        otherIndex !== index && other.include && nameKey(other.name) === nameKey(row.name)
    );
    return twice ? 'Another configuration in this file would get the same name.' : null;
  });
  const included = rows.filter((row) => row.include).length;
  const blocked = included === 0 || problems.some(Boolean);

  const run = async () => {
    setPhase('running');
    // Names are checked again against what's stored now: the page's list may be hours old, and
    // the store doesn't check names.
    let latest: ConfigurationDocument[] | null = null;
    let unchecked: string | null = null;
    try {
      latest = await props.services.listConfigurations();
      props.onLatest?.(latest);
    } catch (error) {
      unchecked = `Couldn’t check the names first. ${toUserMessage(error)}`;
    }
    for (const [index, row] of rows.entries()) {
      const entry = entries[index];
      if (!row.include || !entry) {
        continue;
      }
      let result: Result;
      try {
        if (unchecked) {
          throw new PicklistError('network', unchecked);
        }
        const [conflict] = findNameConflicts(latest ?? [], {
          name: row.name,
          processIds: [process.id],
        });
        if (conflict) {
          throw new PicklistError('config', nameConflictMessage(conflict, props.processName));
        }
        const saved = await props.services.saveConfiguration(
          createConfigurationDocument({
            name: row.name,
            processIds: [process.id],
            settings: entry.settings,
          })
        );
        props.onImported(saved);
        result = { ok: true };
      } catch (error) {
        result = { ok: false, message: toUserMessage(error) };
      }
      setResults((current) =>
        current.map((item, position) => (position === index ? result : item))
      );
    }
    setPhase('done');
  };

  const imported = results.filter((result) => result?.ok).length;

  return (
    <Dialog
      title={`Import into ${process.name}`}
      size='wide'
      busy={phase === 'running'}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      actions={
        phase === 'done' ? (
          <button
            ref={doneRef}
            type='button'
            className='cf-button cf-button--primary'
            onClick={props.onClose}
          >
            Done
          </button>
        ) : (
          <>
            <button
              type='button'
              className='cf-button cf-button--busy'
              aria-disabled={phase === 'running' || undefined}
              onClick={phase === 'running' ? undefined : props.onClose}
            >
              Cancel
            </button>
            <button
              type='button'
              className='cf-button cf-button--primary cf-button--busy'
              disabled={blocked && phase !== 'running'}
              aria-disabled={phase === 'running' || undefined}
              onClick={phase === 'running' ? undefined : () => void run()}
            >
              {phase === 'running' ? <Spinner /> : null}
              {phase === 'running' ? 'Importing…' : `Import ${countOf(included, 'configuration')}`}
            </button>
          </>
        )
      }
    >
      <p>
        {props.fileName} has {countOf(entries.length, 'configuration')}. Choose which to import into{' '}
        {process.name}. Files never include secrets or user names, so enter those afterwards in each
        configuration that signs in.
      </p>
      <ul className='cf-import'>
        {entries.map((entry, index) => {
          const row = rows[index] ?? { include: false, name: '' };
          const problem = problems[index];
          const result = results[index];
          const label = entry.name || `Configuration ${index + 1}`;
          const meta = [
            entry.source,
            endpointHost(entry.settings),
            describeSignIn({ settings: entry.settings, secret: null }),
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={`${label}-${index}`} className='cf-import__row'>
              <input
                id={`${id}-include-${index}`}
                type='checkbox'
                className='cf-checkbox'
                checked={row.include}
                disabled={phase !== 'review'}
                aria-describedby={`${id}-meta-${index}`}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item, position) =>
                      position === index ? { ...item, include: event.target.checked } : item
                    )
                  )
                }
              />
              <div className='cf-import__body'>
                <label className='cf-label' htmlFor={`${id}-include-${index}`}>
                  Import {label}
                </label>
                <p id={`${id}-meta-${index}`} className='cf-import__meta'>
                  {meta}
                </p>
                {row.include ? (
                  <div className='cf-setting' data-issue={problem ? 'error' : undefined}>
                    <label className='cf-label' htmlFor={`${id}-name-${index}`}>
                      Name
                    </label>
                    <input
                      id={`${id}-name-${index}`}
                      className='cf-input'
                      value={row.name}
                      disabled={phase !== 'review'}
                      aria-invalid={problem ? true : undefined}
                      aria-describedby={problem ? `${id}-problem-${index}` : undefined}
                      spellCheck={false}
                      autoComplete='off'
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item, position) =>
                            position === index ? { ...item, name: event.target.value } : item
                          )
                        )
                      }
                    />
                    {problem ? (
                      <p id={`${id}-problem-${index}`} className='cf-issue cf-issue--error'>
                        <AlertIcon />
                        <span>
                          <span className='rp-sr-only'>Error: </span>
                          {problem}
                        </span>
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {result ? (
                  <p className={`cf-row-result cf-row-result--${result.ok ? 'success' : 'error'}`}>
                    {result.ok ? <SuccessIcon /> : <AlertIcon />}
                    <span>{result.ok ? 'Imported' : result.message}</span>
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <output className='cf-plan__status'>
        {phase === 'done'
          ? `Imported ${imported} of ${countOf(included, 'configuration')} into ${process.name}.`
          : ''}
      </output>
    </Dialog>
  );
}
