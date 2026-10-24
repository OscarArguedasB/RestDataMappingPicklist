import { useEffect, useId, useRef, useState } from 'react';
import { AlertIcon, SuccessIcon, WarningIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import { quoteName } from '../core/configurations';
import type { MigrationGroup, MigrationPlan } from '../core/migration';
import { describeControl } from '../core/migration';
import { countOf, joinNames, neededSecretKind, secretNoun } from './configurationStatus';
import { Dialog } from './Dialog';
import type { GroupOutcome, MigrationProgress, StepOutcome } from './migrationRun';
import { initialProgress, movableSecret, runMigration } from './migrationRun';
import type { SetupServices } from './services';
import { IssueMessage } from './ui';

type Phase = 'review' | 'running' | 'done';

function SecretNote({ group }: { group: MigrationGroup }) {
  const noun = secretNoun(neededSecretKind(group.settings));
  if (group.secret.status === 'none') {
    return null;
  }
  if (group.secret.status === 'kept') {
    return (
      <p className='cf-plan__note'>
        <SuccessIcon />
        <span>Keeps the {noun} already saved in it</span>
      </p>
    );
  }
  return movableSecret(group) ? (
    <p className='cf-plan__note'>
      <SuccessIcon />
      <span>Its {noun} moves too</span>
    </p>
  ) : (
    <p className='cf-plan__note cf-plan__note--warning'>
      <WarningIcon />
      <span>Needs the {noun} again</span>
    </p>
  );
}

function StepResult({ outcome }: { outcome: StepOutcome | undefined }) {
  switch (outcome?.status) {
    case 'running':
      return (
        <span className='cf-plan__result'>
          <Spinner /> Moving…
        </span>
      );
    case 'moved':
      return (
        <span className='cf-plan__result cf-plan__result--success'>
          <SuccessIcon /> Moved
        </span>
      );
    case 'partial':
      // It uses its configuration, but its old settings (maybe a password) weren't removed.
      return (
        <span className='cf-plan__result cf-plan__result--warning'>
          <WarningIcon />
          <span>
            <span className='rp-sr-only'>Warning: </span>
            Moved, but not fully. {outcome.message}
          </span>
        </span>
      );
    case 'failed':
    case 'skipped':
      return (
        <span className='cf-plan__result cf-plan__result--error'>
          <AlertIcon />
          <span>
            <span className='rp-sr-only'>Not moved: </span>
            {outcome.message}
          </span>
        </span>
      );
    default:
      return null;
  }
}

function GroupFailure({ outcome }: { outcome: GroupOutcome | undefined }) {
  return outcome?.status === 'failed' ? (
    <p className='cf-plan__note cf-plan__note--error'>
      <AlertIcon />
      <span>{outcome.message}</span>
    </p>
  ) : null;
}

/** A configuration an earlier run made was used instead of creating another one. */
function GroupReused(props: { group: MigrationGroup; outcome: GroupOutcome | undefined }) {
  const { group, outcome } = props;
  return outcome?.status === 'ready' && !outcome.created && !group.existing ? (
    <p className='cf-plan__note'>
      <SuccessIcon />
      <span>
        Used the existing {quoteName(outcome.configuration.name)} instead: it has the same settings
        and secret.
      </span>
    </p>
  ) : null;
}

function summary(plan: MigrationPlan, progress: MigrationProgress): string {
  const partial = progress.steps.filter((step) => step.status === 'partial').length;
  const moved = progress.steps.filter((step) => step.status === 'moved').length + partial;
  const total = plan.steps.length;
  const parts = [
    moved === total
      ? `Moved ${countOf(total, 'control')}.`
      : `Moved ${moved} of ${countOf(total, 'control')}. The others keep their settings and still work.`,
  ];
  if (partial > 0) {
    parts.push(
      `The old settings of ${countOf(partial, 'control')} are still stored in the process: see ${partial === 1 ? 'it' : 'them'} above.`
    );
  }
  const needed = plan.groups.filter((_group, index) => {
    const outcome = progress.groups[index];
    return outcome?.status === 'ready' && outcome.secret === 'needed';
  });
  if (needed.length > 0) {
    parts.push(
      `Enter the secret of ${joinNames(needed.map((group) => quoteName(group.name)))} in ${needed.length === 1 ? 'its configuration' : 'their configurations'}.`
    );
  }
  return parts.join(' ');
}

/**
 * Moves a process's controls that still keep their API settings on the Options tab into
 * configurations: the plan grouped by configuration (created or reused, which controls, whether
 * the secret can move), then progress and a result for every control.
 */
export function MigrationDialog(props: {
  plan: MigrationPlan;
  services: SetupServices;
  /** After the run, with what happened; the dialog stays open to show it. */
  onFinished: (progress: MigrationProgress) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { plan } = props;
  const [phase, setPhase] = useState<Phase>('review');
  const [progress, setProgress] = useState<MigrationProgress>(() => initialProgress(plan));
  const doneRef = useRef<HTMLButtonElement>(null);
  const introId = useId();
  const count = plan.steps.length;
  const stepIndex = new Map(plan.steps.map((step, index) => [step.control, index]));

  useEffect(() => {
    if (phase === 'done') {
      doneRef.current?.focus();
    }
  }, [phase]);

  const run = async () => {
    if (phase !== 'review') {
      return;
    }
    setPhase('running');
    const result = await runMigration(plan, props.services, setProgress);
    setProgress(result);
    setPhase('done');
    props.onFinished(result);
  };

  const finished = progress.steps.filter(
    (step) => step.status !== 'pending' && step.status !== 'running'
  ).length;

  return (
    <Dialog
      title={
        count > 0
          ? `Move ${countOf(count, 'control')} to configurations`
          : 'Move controls to configurations'
      }
      size='wide'
      busy={phase === 'running'}
      describedBy={introId}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      actions={
        phase === 'done' || count === 0 ? (
          <button
            ref={doneRef}
            type='button'
            className='cf-button cf-button--primary'
            onClick={props.onClose}
          >
            {phase === 'done' ? 'Done' : 'Close'}
          </button>
        ) : (
          <>
            {/* While it runs both stay focusable (aria-disabled), so focus never drops to the
                page behind the dialog. */}
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
              aria-disabled={phase === 'running' || undefined}
              onClick={phase === 'running' ? undefined : () => void run()}
            >
              {phase === 'running' ? <Spinner /> : null}
              {phase === 'running' ? 'Moving…' : `Move ${countOf(count, 'control')}`}
            </button>
          </>
        )
      }
    >
      {count > 0 ? (
        <p id={introId}>
          These controls in {plan.processName} keep their API settings in the process editor. Each
          one will use a configuration instead:
        </p>
      ) : (
        <p id={introId}>No control in {plan.processName} can move yet.</p>
      )}
      {plan.groups.length > 0 ? (
        <ul className='cf-plan'>
          {plan.groups.map((group, index) => (
            <li key={`${group.name}-${index}`} className='cf-plan__group'>
              <p className='cf-plan__title'>
                {group.existing
                  ? `Use the existing ${quoteName(group.name)}`
                  : `Create ${quoteName(group.name)}`}
              </p>
              <SecretNote group={group} />
              <GroupFailure outcome={progress.groups[index]} />
              <GroupReused group={group} outcome={progress.groups[index]} />
              <ul className='cf-plan__controls'>
                {group.controls.map((control) => {
                  const position = stepIndex.get(control);
                  const step = position === undefined ? undefined : plan.steps[position];
                  return (
                    <li key={`${control.workItemType.referenceName}/${control.controlId}`}>
                      <span className='cf-plan__control'>{describeControl(control)}</span>
                      {position === undefined ? null : (
                        <StepResult outcome={progress.steps[position]} />
                      )}
                      {phase === 'review'
                        ? step?.warnings.map((warning, warningIndex) => (
                            <IssueMessage
                              key={warning}
                              id={`plan-${index}-${position ?? 0}-${warningIndex}`}
                              issue={{ tone: 'warning', message: warning }}
                            />
                          ))
                        : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {plan.problems.length > 0 ? (
        <>
          <p className='cf-plan__heading'>Can’t move yet</p>
          <ul className='cf-plan__problems'>
            {plan.problems.map((problem, index) => (
              <li
                key={`${problem.control.workItemType.referenceName}/${problem.control.controlId}`}
              >
                <IssueMessage
                  id={`plan-problem-${index}`}
                  issue={{ tone: 'warning', message: problem.message }}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {phase === 'review' && count > 0 ? (
        <p>
          The process editor won’t show these settings anymore. Secrets Azure DevOps hides can’t be
          moved, so you’ll enter them again.
        </p>
      ) : null}
      <output className='cf-plan__status'>
        {phase === 'running'
          ? `Moving… ${finished} of ${countOf(count, 'control')} done.`
          : phase === 'done'
            ? summary(plan, progress)
            : ''}
      </output>
    </Dialog>
  );
}
