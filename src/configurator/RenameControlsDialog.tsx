import { useEffect, useRef, useState } from 'react';
import { AlertIcon, SuccessIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import type { ConfigurationDocument } from '../core/configurations';
import { quoteName } from '../core/configurations';
import { toUserMessage } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { assignmentInputs, describeControl } from '../core/migration';
import { LeftoverInputsError } from '../devops/layout';
import { countOf } from './configurationStatus';
import { Dialog } from './Dialog';
import type { SetupServices } from './services';

type Result = { ok: true } | { ok: false; message: string };

/**
 * After a rename: offers to point the controls that still use the former name at the new one.
 * Nothing breaks if people say no, because the configuration keeps answering to its former
 * names, so “Not now” is the safe choice.
 */
export function RenameControlsDialog(props: {
  configuration: ConfigurationDocument;
  previousName: string;
  /** Controls using the former name in processes the person can edit. */
  controls: readonly LayoutControl[];
  /** How many more use it in processes the person can't edit. */
  others: number;
  /**
   * Every control read from the processes' layouts: a control that still saves 3.0 settings for
   * others keeps them (see assignmentInputs).
   */
  scanned: readonly LayoutControl[];
  services: SetupServices;
  onUpdated: (control: LayoutControl) => void;
  onClose: () => void;
}) {
  const { configuration, previousName, controls } = props;
  const [phase, setPhase] = useState<'review' | 'running' | 'done'>('review');
  const [results, setResults] = useState<Array<Result | null>>(() => controls.map(() => null));
  const doneRef = useRef<HTMLButtonElement>(null);
  const count = controls.length;
  const several = new Set(controls.map((control) => control.processId)).size > 1;

  useEffect(() => {
    if (phase === 'done') {
      doneRef.current?.focus();
    }
  }, [phase]);

  const run = async () => {
    setPhase('running');
    for (const [index, control] of controls.entries()) {
      let result: Result;
      try {
        props.onUpdated(
          await props.services.updateControlInputs(
            control,
            assignmentInputs(control, configuration.name, props.scanned)
          )
        );
        result = { ok: true };
      } catch (error) {
        if (error instanceof LeftoverInputsError) {
          // It uses the new name, but its old settings weren't removed.
          props.onUpdated(error.control);
        }
        result = { ok: false, message: toUserMessage(error) };
      }
      setResults((current) =>
        current.map((item, position) => (position === index ? result : item))
      );
    }
    setPhase('done');
  };

  const updated = results.filter((result) => result?.ok).length;

  return (
    <Dialog
      title={`Update ${countOf(count, 'control')} to ${quoteName(configuration.name)}?`}
      busy={phase === 'running'}
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
              Not now
            </button>
            <button
              type='button'
              className='cf-button cf-button--primary cf-button--busy'
              aria-disabled={phase === 'running' || undefined}
              onClick={phase === 'running' ? undefined : () => void run()}
            >
              {phase === 'running' ? <Spinner /> : null}
              {phase === 'running' ? 'Updating…' : `Update ${countOf(count, 'control')}`}
            </button>
          </>
        )
      }
    >
      <p>
        {count === 1 ? 'This control still uses' : 'These controls still use'} the former name{' '}
        {quoteName(previousName)}. {count === 1 ? 'It keeps' : 'They keep'} working either way,
        because {quoteName(configuration.name)} still answers to it.
      </p>
      <ul className='cf-plan__controls'>
        {controls.map((control, index) => {
          const result = results[index];
          return (
            <li
              key={`${control.processId}/${control.workItemType.referenceName}/${control.controlId}`}
            >
              <span className='cf-plan__control'>
                {describeControl(control)}
                {several ? ` (${control.processName})` : ''}
              </span>
              {result ? (
                <span
                  className={`cf-plan__result cf-plan__result--${result.ok ? 'success' : 'error'}`}
                >
                  {result.ok ? <SuccessIcon /> : <AlertIcon />}
                  <span>{result.ok ? 'Updated' : result.message}</span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {props.others > 0 ? (
        <p>
          {countOf(props.others, 'more control')} {props.others === 1 ? 'is' : 'are'} in processes
          you can’t edit, and keep using the former name.
        </p>
      ) : null}
      <output className='cf-plan__status'>
        {phase === 'done' ? `Updated ${updated} of ${countOf(count, 'control')}.` : ''}
      </output>
    </Dialog>
  );
}
