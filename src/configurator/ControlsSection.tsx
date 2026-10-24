import type { RefObject } from 'react';
import { useId, useState } from 'react';
import { AlertIcon, SuccessIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import type { ConfigurationDocument } from '../core/configurations';
import { configurationsForProcess, quoteName } from '../core/configurations';
import { toUserMessage } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import {
  assignmentInputs,
  controlStatus,
  controlsUsingSavedConfiguration,
  describeControl,
} from '../core/migration';
import { LeftoverInputsError } from '../devops/layout';
import type { Assignment } from './configurationStatus';
import { assignmentOf, joinNames } from './configurationStatus';
import type { ProcessSummary, SetupServices } from './services';
import { Callout, IssueMessage } from './ui';
import type { ScanState } from './useProcessScans';

interface RowResult {
  tone: 'success' | 'error';
  text: string;
}

interface RowState {
  /** The configuration id picked in the row's select, while it differs from what's saved. */
  choice?: string;
  busy?: boolean;
  result?: RowResult;
}

function controlKey(control: LayoutControl): string {
  return `${control.workItemType.referenceName}\n${control.controlId}`;
}

function currentChoice(assignment: Assignment): string {
  return assignment.kind === 'assigned' ? assignment.configuration.id : '';
}

function controlName(control: LayoutControl): string {
  return control.label || control.fieldName || control.controlId;
}

/** By work item type, then by the control's name, like people look for them. */
function sortControls(controls: readonly LayoutControl[]): LayoutControl[] {
  const options = { sensitivity: 'base', numeric: true } as const;
  return controls.toSorted(
    (a, b) =>
      a.workItemType.name.localeCompare(b.workItemType.name, undefined, options) ||
      controlName(a).localeCompare(controlName(b), undefined, options)
  );
}

/**
 * “Controls in this process”: every REST Picklist control on the process's work item forms, what
 * it uses, and a way to change it. Changing a row's configuration shows that row's Apply and
 * Cancel; results appear in the row and are announced. Writes replace the control's inputs with
 * just the field and the configuration name (migratedInputs).
 */
export function ControlsSection(props: {
  process: ProcessSummary;
  scan: ScanState | undefined;
  configurations: readonly ConfigurationDocument[];
  canEdit: boolean;
  services: SetupServices;
  /** The section's heading, which takes focus when the editor sends people here. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  onControlUpdated: (control: LayoutControl) => void;
  onRescan: () => void;
  onMove: () => void;
}) {
  const { process, scan, configurations, canEdit, headingRef } = props;
  const id = useId();
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(() => new Map());
  const [announcement, setAnnouncement] = useState('');
  const shared = configurationsForProcess(configurations, process.id);

  const patchRow = (key: string, patch: RowState | null) =>
    setRows((current) => {
      const next = new Map(current);
      if (patch === null) {
        next.delete(key);
      } else {
        next.set(key, { ...current.get(key), ...patch });
      }
      return next;
    });

  const write = async (
    control: LayoutControl,
    controls: readonly LayoutControl[],
    name: string,
    success: string,
    said: string
  ) => {
    const key = controlKey(control);
    patchRow(key, { busy: true, result: undefined });
    try {
      // A control that still saves 3.0 settings for others keeps those until they move.
      const updated = await props.services.updateControlInputs(
        control,
        assignmentInputs(control, name, controls)
      );
      props.onControlUpdated(updated);
      setRows((current) =>
        new Map(current).set(key, { result: { tone: 'success', text: success } })
      );
      setAnnouncement(said);
    } catch (error) {
      const message = toUserMessage(error);
      if (error instanceof LeftoverInputsError) {
        // It uses the configuration now, but its old settings weren't removed: not a success.
        props.onControlUpdated(error.control);
        setRows((current) =>
          new Map(current).set(key, { result: { tone: 'error', text: message } })
        );
        setAnnouncement(`Changed ${describeControl(control)}, but not completely. ${message}`);
        return;
      }
      patchRow(key, { busy: false, result: { tone: 'error', text: message } });
      setAnnouncement(`Couldn’t change ${describeControl(control)}. ${message}`);
    }
  };

  const cleanUp = (control: LayoutControl, controls: readonly LayoutControl[]) => {
    const status = controlStatus(control);
    if (status.kind !== 'configured') {
      return;
    }
    // A control that saves 3.0 settings for others must keep them until those controls move.
    const users = controlsUsingSavedConfiguration(controls, control);
    if (users.length > 0) {
      const text = `${joinNames(users.map(describeControl))} still ${users.length === 1 ? 'uses' : 'use'} the settings this control saves. Move ${users.length === 1 ? 'it' : 'them'} first.`;
      patchRow(controlKey(control), { result: { tone: 'error', text } });
      setAnnouncement(text);
      return;
    }
    void write(
      control,
      controls,
      status.configuration,
      'Cleaned up',
      `Cleaned up the old settings of ${describeControl(control)}.`
    );
  };

  const renderConfiguration = (control: LayoutControl, controls: readonly LayoutControl[]) => {
    const assignment = assignmentOf(configurations, control);
    const key = controlKey(control);
    const row = rows.get(key) ?? {};
    const where = describeControl(control);

    if (assignment.kind === 'legacy') {
      // The dialog moves every control of the process that can move (controls that borrow
      // another's 3.0 settings have to move together), so the button says what the banner says.
      return (
        <div className='cf-assign'>
          <span className='cf-assign__state'>Settings in the process editor</span>
          {canEdit ? (
            <button
              type='button'
              className='cf-button cf-button--small'
              aria-haspopup='dialog'
              onClick={props.onMove}
            >
              Review and move
            </button>
          ) : null}
        </div>
      );
    }

    const saved = currentChoice(assignment);
    const choice = row.choice ?? saved;
    const dirty = choice !== saved && choice !== '';
    const chosen = shared.find((doc) => doc.id === choice);
    const notes = (
      <>
        {assignment.kind === 'unknown' ? (
          <IssueMessage
            id={`${id}-${key.replace(/[^A-Za-z0-9_-]/g, '_')}-unknown`}
            issue={{ tone: 'warning', message: assignment.message }}
          />
        ) : null}
        {assignment.kind === 'assigned' && assignment.formerName ? (
          <p className='cf-assign__note'>
            Uses its former name {quoteName(assignment.formerName)}.{' '}
            {canEdit && !row.busy ? (
              <button
                type='button'
                className='cf-link'
                onClick={() =>
                  void write(
                    control,
                    controls,
                    assignment.configuration.name,
                    'Saved',
                    `Saved. ${where} now uses ${quoteName(assignment.configuration.name)}.`
                  )
                }
              >
                Use {quoteName(assignment.configuration.name)}
              </button>
            ) : null}
          </p>
        ) : null}
        {(assignment.kind === 'assigned' || assignment.kind === 'unknown') &&
        assignment.leftovers ? (
          <p className='cf-assign__note'>
            Old settings are still stored on this control.{' '}
            {canEdit && !row.busy ? (
              <button type='button' className='cf-link' onClick={() => cleanUp(control, controls)}>
                Clean up old settings
              </button>
            ) : null}
          </p>
        ) : null}
      </>
    );

    if (!canEdit) {
      return (
        <div>
          <span className='cf-assign__state'>
            {assignment.kind === 'assigned'
              ? assignment.configuration.name
              : assignment.kind === 'unknown'
                ? assignment.name
                : 'Not set'}
          </span>
          {notes}
        </div>
      );
    }

    if (shared.length === 0) {
      return (
        <div>
          <span className='cf-assign__state'>
            {assignment.kind === 'unknown' ? assignment.name : 'Not set'}
          </span>
          {notes}
          <p className='cf-assign__note'>No configurations are shared with this process yet.</p>
        </div>
      );
    }

    return (
      <div>
        <div className='cf-assign'>
          <select
            className='cf-input cf-select cf-assign__select'
            aria-label={`Configuration for ${where}`}
            value={choice}
            disabled={row.busy}
            onChange={(event) =>
              patchRow(key, {
                choice: event.target.value === saved ? undefined : event.target.value,
                result: undefined,
              })
            }
          >
            {assignment.kind === 'assigned' ? null : (
              <option value='' disabled>
                {assignment.kind === 'unknown'
                  ? `${quoteName(assignment.name)} (not found)`
                  : 'Choose a configuration'}
              </option>
            )}
            {shared.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name}
              </option>
            ))}
          </select>
          {dirty && chosen ? (
            <span className='cf-assign__actions'>
              <button
                type='button'
                className='cf-button cf-button--small'
                disabled={row.busy}
                onClick={() =>
                  void write(
                    control,
                    controls,
                    chosen.name,
                    'Saved',
                    `Saved. ${where} now uses ${quoteName(chosen.name)}.`
                  )
                }
              >
                {row.busy ? <Spinner /> : null}
                {row.busy ? 'Applying…' : 'Apply'}
              </button>
              <button
                type='button'
                className='cf-button cf-button--small cf-button--quiet'
                disabled={row.busy}
                onClick={() => patchRow(key, { choice: undefined, result: undefined })}
              >
                Cancel
              </button>
            </span>
          ) : null}
        </div>
        {notes}
      </div>
    );
  };

  const renderTable = (controls: readonly LayoutControl[]) => (
    <table className='cf-table cf-controls__table'>
      <thead>
        <tr>
          <th scope='col'>Work item type</th>
          <th scope='col'>Control</th>
          <th scope='col'>Configuration</th>
        </tr>
      </thead>
      <tbody>
        {/* By work item type, then control, so one type's rows stay together. */}
        {sortControls(controls).map((control) => {
          const row = rows.get(controlKey(control));
          return (
            <tr key={controlKey(control)}>
              <td data-label='Work item type'>{control.workItemType.name}</td>
              <th scope='row'>
                <span className='cf-table__name'>
                  {control.label || control.fieldName || control.controlId}
                </span>
                {control.fieldName ? (
                  <span className='cf-table__meta'>
                    <code className='cf-code'>{control.fieldName}</code>
                  </span>
                ) : null}
              </th>
              <td data-label='Configuration'>
                {renderConfiguration(control, controls)}
                {row?.result ? (
                  <p className={`cf-row-result cf-row-result--${row.result.tone}`}>
                    {row.result.tone === 'success' ? <SuccessIcon /> : <AlertIcon />}
                    <span>
                      {row.result.tone === 'error' ? (
                        <span className='rp-sr-only'>Error: </span>
                      ) : null}
                      {row.result.text}
                    </span>
                  </p>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <section className='cf-controls' aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} ref={headingRef} tabIndex={-1} className='cf-section-title'>
        Controls in this process
      </h3>
      {!scan || scan.status === 'loading' ? (
        <output className='cf-loading'>
          <Spinner /> Looking for REST Picklist controls in {process.name}…
        </output>
      ) : scan.status === 'error' ? (
        <Callout tone='error' title={`Couldn’t read the controls of ${process.name}.`}>
          <p>{scan.message}</p>
          <p>
            <button type='button' className='cf-link' onClick={props.onRescan}>
              Try again
            </button>
          </p>
        </Callout>
      ) : scan.controls.length === 0 ? (
        <p className='cf-section-description'>
          No work item form in {process.name} has a REST Picklist control yet. In the process
          editor, add the REST Picklist control (listed as “Rest Data Mapping Picklist”) to a form,
          then choose its configuration here.
        </p>
      ) : (
        <>
          <p className='cf-section-description'>
            {canEdit
              ? 'Choose the configuration each control uses. Changes apply to the process right away.'
              : 'The configuration each control uses.'}
          </p>
          {renderTable(scan.controls)}
        </>
      )}
      <p className='rp-sr-only' aria-live='polite'>
        {announcement}
      </p>
    </section>
  );
}
