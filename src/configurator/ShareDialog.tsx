import { useState } from 'react';
import { Spinner } from '../components/Spinner';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import {
  canEditProcess,
  canShareWith,
  findNameConflicts,
  nameConflictMessage,
  quoteName,
} from '../core/configurations';
import { PicklistError, toUserMessage } from '../core/errors';
import { canHoldControls } from '../devops/processes';
import { joinNames } from './configurationStatus';
import { Dialog } from './Dialog';
import { processKind } from './ProcessList';
import type { ProcessSummary, SetupServices } from './services';
import { Callout, CheckboxField, IssueMessage } from './ui';

/**
 * Chooses the processes a configuration is shared with. Adding one needs Edit process on it (and
 * a name no configuration of that process answers to); taking one away needs Edit process on it,
 * and at least one has to stay: removing the last is deleting.
 */
export function ShareDialog(props: {
  doc: ConfigurationDocument;
  processes: readonly ProcessSummary[];
  configurations: readonly ConfigurationDocument[];
  permissions: PermissionSnapshot;
  services: SetupServices;
  onSaved: (doc: ConfigurationDocument) => void;
  /** Every configuration as read just before saving, newer than `configurations`. */
  onLatest?: (docs: ConfigurationDocument[]) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { doc, permissions } = props;
  const usable = props.processes.filter(canHoldControls);
  const usableIds = new Set(usable.map((process) => process.id));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(doc.processIds.filter((id) => usableIds.has(id)))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOf = (id: string) => props.processes.find((process) => process.id === id)?.name;
  const added = usable.filter(
    (process) => chosen.has(process.id) && !doc.processIds.includes(process.id)
  );
  const removed = usable.filter(
    (process) => !chosen.has(process.id) && doc.processIds.includes(process.id)
  );
  // Ids of processes that no longer exist stay as they are.
  const processIds = [
    ...doc.processIds.filter((id) => !usableIds.has(id) || chosen.has(id)),
    ...added.map((process) => process.id),
  ];
  const remaining = processIds.filter((id) => usableIds.has(id));
  const conflicts =
    added.length > 0
      ? findNameConflicts(props.configurations, {
          id: doc.id,
          name: doc.name,
          aliases: doc.aliases,
          processIds: added.map((process) => process.id),
        })
      : [];
  const changed = added.length > 0 || removed.length > 0;
  const blocked = remaining.length === 0 || conflicts.length > 0;

  const toggle = (id: string, on: boolean) => {
    setError(null);
    setChosen((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Names are checked against what's stored now, not what the page read when it opened.
      if (added.length > 0) {
        const latest = await props.services.listConfigurations();
        props.onLatest?.(latest);
        const [conflict] = findNameConflicts(latest, {
          id: doc.id,
          name: doc.name,
          aliases: doc.aliases,
          processIds: added.map((process) => process.id),
        });
        if (conflict) {
          throw new PicklistError('config', nameConflictMessage(conflict, nameOf));
        }
      }
      props.onSaved(await props.services.saveConfiguration({ ...doc, processIds }));
    } catch (failure) {
      setError(toUserMessage(failure));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={`Share ${quoteName(doc.name)}`}
      busy={saving}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      actions={
        <>
          <button
            type='button'
            className='cf-button cf-button--busy'
            aria-disabled={saving || undefined}
            onClick={saving ? undefined : props.onClose}
          >
            Cancel
          </button>
          <button
            type='button'
            className='cf-button cf-button--primary cf-button--busy'
            disabled={(!changed || blocked) && !saving}
            aria-disabled={saving || undefined}
            onClick={saving ? undefined : () => void save()}
          >
            {saving ? <Spinner /> : null}
            {saving ? 'Saving…' : 'Save sharing'}
          </button>
        </>
      }
    >
      <p>
        Controls in the processes you choose can use it by name. Processes you can’t edit are shown
        as they are.
      </p>
      <fieldset className='cf-share'>
        <legend className='rp-sr-only'>Processes</legend>
        {usable.map((process) => {
          const shared = doc.processIds.includes(process.id);
          const allowed = shared
            ? canEditProcess(permissions, process.id)
            : canShareWith(permissions, doc, process.id);
          return (
            <CheckboxField
              key={process.id}
              label={process.name}
              help={
                allowed
                  ? processKind(process)
                  : `${processKind(process)} · You need Edit process permission on it.`
              }
              checked={chosen.has(process.id)}
              disabled={!allowed || saving}
              onChange={(on) => toggle(process.id, on)}
            />
          );
        })}
      </fieldset>
      {conflicts.map((conflict) => (
        <IssueMessage
          key={`${conflict.configuration.id}-${conflict.name}`}
          id={`share-conflict-${conflict.configuration.id}`}
          issue={{ tone: 'error', message: nameConflictMessage(conflict, nameOf) }}
        />
      ))}
      {/* Only once the last one is taken away; one that has none yet just waits for a choice. */}
      {remaining.length === 0 && removed.length > 0 ? (
        <IssueMessage
          id='share-none'
          issue={{
            tone: 'error',
            message: 'Keep it shared with at least one process, or delete it instead.',
          }}
        />
      ) : null}
      {removed.length > 0 && remaining.length > 0 ? (
        <p className='cf-share__consequence'>
          Controls in {joinNames(removed.map((process) => process.name))} that use{' '}
          {quoteName(doc.name)} will show “Configuration not found” until they’re given another.
        </p>
      ) : null}
      {error ? <Callout tone='error' role='alert' title={error} /> : null}
    </Dialog>
  );
}
