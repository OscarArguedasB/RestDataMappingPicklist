import type { ChangeEvent, RefObject } from 'react';
import { useId, useRef, useState } from 'react';
import { CheckIcon, WarningIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import type {
  ConfigurationDocument,
  ConfigurationFileEntry,
  PermissionSnapshot,
} from '../core/configurations';
import {
  READ_ONLY_PERMISSIONS,
  canCreateIn,
  canDeleteConfiguration,
  canEditConfiguration,
  canEditProcess,
  canManageAll,
  canShareWith,
  canUnshareFrom,
  configurationsForProcess,
  duplicateConfiguration,
  exportConfigurationFile,
  parseConfigurationFile,
  permissionsUnverified,
  quoteName,
} from '../core/configurations';
import { toUserMessage } from '../core/errors';
import type { LayoutControl, MigrationPlan } from '../core/migration';
import { controlStatus, planMigration } from '../core/migration';
import { canHoldControls } from '../devops/processes';
import { ConfigurationList } from './ConfigurationList';
import { controlsUsing, copyName, countOf, joinNames, usageCounts } from './configurationStatus';
import { ConfirmDialog } from './ConfirmDialog';
import { ControlsSection } from './ControlsSection';
import { fileNameFor, readConfigurationFile } from './files';
import { LockIcon } from './icons';
import { ImportDialog } from './ImportDialog';
import type { MenuItem } from './MenuButton';
import { MigrationDialog } from './MigrationDialog';
import type { MigrationProgress } from './migrationRun';
import type { Notice } from './notices';
import { offerDownload } from './notices';
import { ProcessList } from './ProcessList';
import type { ProcessSummary, SetupServices } from './services';
import { ShareDialog } from './ShareDialog';
import { Callout } from './ui';
import type { ProcessScans } from './useProcessScans';

/** Something read from Azure DevOps: still coming, failed with a message to show, or there. */
export type Loadable<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

type TabDialog =
  | { kind: 'delete'; doc: ConfigurationDocument }
  | { kind: 'share'; doc: ConfigurationDocument }
  | { kind: 'import'; fileName: string; entries: ConfigurationFileEntry[] }
  | { kind: 'move'; plan: MigrationPlan }
  | null;

/** Replaces the configuration with the same id, or adds it. */
export function upsertConfiguration(
  docs: readonly ConfigurationDocument[],
  doc: ConfigurationDocument
): ConfigurationDocument[] {
  return docs.some((existing) => existing.id === doc.id)
    ? docs.map((existing) => (existing.id === doc.id ? doc : existing))
    : [...docs, doc];
}

function PermissionLine(props: {
  permissions: PermissionSnapshot | null;
  process: ProcessSummary;
}) {
  const { permissions, process } = props;
  if (!permissions) {
    return (
      <p className='cf-permission'>
        <Spinner /> Checking your permissions…
      </p>
    );
  }
  if (permissions.error) {
    return (
      <p className='cf-permission'>
        <LockIcon />
        <span>View only: your permissions couldn’t be checked.</span>
      </p>
    );
  }
  if (permissionsUnverified(permissions)) {
    return (
      <p className='cf-permission cf-permission--unverified'>
        <WarningIcon />
        <span>
          Your permissions couldn’t be verified, so editing isn’t limited. Azure DevOps still checks
          Edit process on {process.name} when its controls change.
        </span>
      </p>
    );
  }
  return canEditProcess(permissions, process.id) ? (
    <p className='cf-permission cf-permission--editable'>
      <CheckIcon />
      <span>You can edit this process’s configurations.</span>
    </p>
  ) : (
    <p className='cf-permission'>
      <LockIcon />
      <span>View only: you need Edit process permission on {process.name}.</span>
    </p>
  );
}

function legacyCount(controls: readonly LayoutControl[]): number {
  return controls.filter((control) => controlStatus(control).kind === 'legacy').length;
}

/**
 * The “Configurations” tab: processes on the left, and for the chosen one its configurations and
 * the REST Picklist controls on its forms. Everything here follows the permission rules in
 * core/configurations; while the check is pending (or failed), nothing can be changed.
 */
export function ConfigurationsTab(props: {
  services: SetupServices;
  processes: Loadable<ProcessSummary[]>;
  configurations: Loadable<ConfigurationDocument[]>;
  /** Null while the permission check runs. */
  permissions: PermissionSnapshot | null;
  scans: ProcessScans;
  selectedProcessId: string;
  onSelectProcess: (processId: string) => void;
  onRetryProcesses: () => void;
  onRetryConfigurations: () => void;
  onConfigurationsChange: (
    update: (docs: ConfigurationDocument[]) => ConfigurationDocument[]
  ) => void;
  /** Opens the editor; `processId` is the process it was opened from. */
  onEdit: (doc: ConfigurationDocument, processId: string) => void;
  onNew: (processId: string) => void;
  onNotice: (notice: Notice | null) => void;
  /** The chosen process's heading, which takes focus when coming back from the editor. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** “Controls in this process”, for the editor's link to it. */
  controlsHeadingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const { services, scans, onNotice, onConfigurationsChange, headingRef, controlsHeadingRef } =
    props;
  const id = useId();
  const permissions = props.permissions ?? READ_ONLY_PERMISSIONS;
  const [dialog, setDialog] = useState<TabDialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);

  if (props.processes.status === 'loading') {
    return (
      <output className='cf-loading'>
        <Spinner /> Loading processes…
      </output>
    );
  }
  if (props.processes.status === 'error') {
    return (
      <Callout tone='error' role='alert' title={props.processes.message}>
        <p>
          <button type='button' className='cf-link' onClick={props.onRetryProcesses}>
            Try again
          </button>
        </p>
      </Callout>
    );
  }

  const processes = props.processes.value;
  const usable = processes.filter(canHoldControls);
  const usableIds = new Set(usable.map((process) => process.id));
  const knownIds = new Set(processes.map((process) => process.id));
  const processName = (processId: string) =>
    processes.find((process) => process.id === processId)?.name;

  if (usable.length === 0) {
    return (
      <Callout tone='info' title='No inherited processes yet.'>
        <p>
          Custom controls live in inherited processes. Create one from a system process in
          Organization settings › Boards › Process, then add the control to it.
        </p>
      </Callout>
    );
  }

  const process = usable.find((item) => item.id === props.selectedProcessId) ?? usable[0];
  if (!process) {
    return null;
  }
  const docs = props.configurations.status === 'ready' ? props.configurations.value : [];
  const listed = configurationsForProcess(docs, process.id);
  const counts = new Map(
    usable.map((item) => [item.id, configurationsForProcess(docs, item.id).length])
  );
  const canCreate = canCreateIn(permissions, process.id);
  const canEditHere = canEditProcess(permissions, process.id);
  const scan = scans.states.get(process.id);
  const controlsHere = scan?.status === 'ready' ? scan.controls : [];
  const usage = usageCounts(docs, scans.controls);
  const counted = (doc: ConfigurationDocument) =>
    doc.processIds.every((processId) =>
      usableIds.has(processId) ? scans.states.get(processId)?.status === 'ready' : true
    );
  const usageOf = (doc: ConfigurationDocument) => (counted(doc) ? (usage.get(doc.id) ?? 0) : null);
  const sharedNames = (doc: ConfigurationDocument) =>
    doc.processIds
      .map((processId) => processName(processId))
      .filter((name): name is string => Boolean(name))
      .join(', ');

  const closeDialog = () => {
    if (!busy) {
      setDialog(null);
      setDialogError(null);
    }
  };

  const exportOne = (doc: ConfigurationDocument) =>
    offerDownload(
      fileNameFor(doc.name),
      exportConfigurationFile([
        { name: doc.name, source: sharedNames(doc), settings: doc.settings },
      ]),
      quoteName(doc.name),
      onNotice
    );

  const exportAll = () => {
    try {
      offerDownload(
        fileNameFor(process.name),
        exportConfigurationFile(
          listed.map((doc) => ({
            name: doc.name,
            source: sharedNames(doc),
            settings: doc.settings,
          }))
        ),
        countOf(listed.length, 'configuration'),
        onNotice
      );
    } catch (error) {
      onNotice({ tone: 'error', title: 'Couldn’t export.', detail: toUserMessage(error) });
    }
  };

  const duplicate = async (doc: ConfigurationDocument) => {
    // The copy is only shared where the person may create configurations.
    const processIds = doc.processIds.filter((processId) => canEditProcess(permissions, processId));
    setDuplicating(doc.id);
    onNotice(null);
    let copied = false;
    let copy: ConfigurationDocument | null = null;
    try {
      // Named against what's stored now, not what the page read when it opened.
      const latest = await services.listConfigurations();
      onConfigurationsChange(() => latest);
      copy = { ...duplicateConfiguration(doc, copyName(latest, doc.name, processIds)), processIds };
      if (doc.secret) {
        copied = await services.copySecret(doc.id, copy.id);
      }
      if (!copied) {
        copy = { ...copy, secret: null };
      }
      const saved = await services.saveConfiguration(copy);
      onConfigurationsChange((current) => upsertConfiguration(current, saved));
      onNotice({
        tone: 'success',
        title: `Made ${quoteName(saved.name)}, a copy of ${quoteName(doc.name)}.`,
        detail: 'Rename it and change what it needs.',
      });
      props.onEdit(saved, process.id);
    } catch (error) {
      if (copied && copy) {
        await services.deleteSecret(copy.id).catch(() => undefined);
      }
      onNotice({
        tone: 'error',
        title: `Couldn’t duplicate ${quoteName(doc.name)}.`,
        detail: toUserMessage(error),
      });
    } finally {
      setDuplicating(null);
    }
  };

  const confirmDelete = async (doc: ConfigurationDocument) => {
    setBusy(true);
    setDialogError(null);
    try {
      await services.deleteConfiguration(doc);
      onConfigurationsChange((current) => current.filter((existing) => existing.id !== doc.id));
      setDialog(null);
      onNotice({ tone: 'success', title: `Deleted ${quoteName(doc.name)}.` });
    } catch (error) {
      setDialogError(toUserMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const canShareAny = (doc: ConfigurationDocument) =>
    canEditConfiguration(permissions, doc) &&
    usable.some((item) =>
      doc.processIds.includes(item.id)
        ? canUnshareFrom(permissions, doc, item.id, knownIds)
        : canShareWith(permissions, doc, item.id)
    );

  const menuFor = (doc: ConfigurationDocument, here: boolean): MenuItem[] => {
    const items: MenuItem[] = [];
    if (here && canCreate && duplicating === null) {
      items.push({ id: 'duplicate', label: 'Duplicate', onSelect: () => void duplicate(doc) });
    }
    if (canShareAny(doc)) {
      items.push({
        id: 'share',
        label: 'Share…',
        opensDialog: true,
        onSelect: () => setDialog({ kind: 'share', doc }),
      });
    }
    items.push({ id: 'export', label: 'Export', onSelect: () => exportOne(doc) });
    if (canDeleteConfiguration(permissions, doc, knownIds)) {
      items.push({
        id: 'delete',
        label: 'Delete',
        opensDialog: true,
        onSelect: () => {
          setDialogError(null);
          setDialog({ kind: 'delete', doc });
        },
      });
    }
    return items;
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Picking the same file again should still work.
    event.target.value = '';
    if (!file) {
      return;
    }
    const read = await readConfigurationFile(file);
    const parsed = read.error
      ? { configurations: [], error: read.error }
      : parseConfigurationFile(read.text);
    if (parsed.error || parsed.configurations.length === 0) {
      onNotice({
        tone: 'error',
        title: `Couldn’t import ${file.name}.`,
        detail: parsed.error ?? 'This file has no configurations.',
      });
      return;
    }
    onNotice(null);
    setDialog({ kind: 'import', fileName: file.name, entries: parsed.configurations });
  };

  const openMove = () => {
    if (scan?.status === 'ready') {
      setDialog({ kind: 'move', plan: planMigration(process, scan.controls, docs) });
    }
  };

  const moveFinished = (progress: MigrationProgress) => {
    const created = progress.groups.flatMap((group) =>
      group.status === 'ready' ? [group.configuration] : []
    );
    // The run read every configuration first; that's newer than what the page had.
    onConfigurationsChange((current) =>
      created.reduce(upsertConfiguration, progress.latest ?? current)
    );
    for (const step of progress.steps) {
      if (step.status === 'moved' || step.status === 'partial') {
        scans.replaceControl(step.control);
      }
    }
  };

  // Older controls anywhere in the organization, for the banner.
  const legacyHere = legacyCount(controlsHere);
  const legacyElsewhere = usable.flatMap((item) => {
    const state = scans.states.get(item.id);
    const count =
      item.id !== process.id && state?.status === 'ready' ? legacyCount(state.controls) : 0;
    return count > 0 ? [{ process: item, count }] : [];
  });
  const legacyTotal = legacyHere + legacyElsewhere.reduce((total, item) => total + item.count, 0);
  const scanning = scans.done < scans.total;

  const orphans = canManageAll(permissions)
    ? docs.filter((doc) => !doc.processIds.some((processId) => knownIds.has(processId)))
    : [];

  const deleting = dialog?.kind === 'delete' ? dialog.doc : null;
  const deleteUsers = deleting ? controlsUsing(docs, scans.controls, deleting) : [];

  return (
    <div className='cf-configs-tab'>
      <p className='cf-intro'>
        Configurations are listed under the processes that use them. People who can edit a process
        can edit its configurations; Project Collection Administrators can edit all of them.
      </p>
      <div className='cf-configs'>
        <ProcessList
          processes={processes}
          selectedId={process.id}
          counts={counts}
          onSelect={props.onSelectProcess}
        />

        <section className='cf-process-view' aria-labelledby={`${id}-process`}>
          <div className='cf-process-header'>
            <div className='cf-process-header__text'>
              <h2 id={`${id}-process`} ref={headingRef} tabIndex={-1} className='cf-process-title'>
                {process.name}
              </h2>
              <PermissionLine permissions={props.permissions} process={process} />
            </div>
            <div className='cf-process-header__actions'>
              {canCreate ? (
                <button
                  ref={importButton}
                  type='button'
                  className='cf-button cf-button--quiet'
                  onClick={() => fileInput.current?.click()}
                >
                  Import
                </button>
              ) : null}
              <button
                type='button'
                className='cf-button cf-button--quiet'
                disabled={listed.length === 0}
                onClick={exportAll}
              >
                Export all
              </button>
              {canCreate && listed.length > 0 ? (
                <button
                  type='button'
                  className='cf-button cf-button--primary'
                  onClick={() => props.onNew(process.id)}
                >
                  New configuration
                </button>
              ) : null}
            </div>
          </div>

          {legacyTotal > 0 ? (
            <Callout
              tone='warning'
              className='cf-legacy'
              title={
                legacyTotal === 1
                  ? '1 control still keeps its API settings in the process editor. Move it here so it’s managed in one place.'
                  : `${countOf(legacyTotal, 'control')} still keep their API settings in the process editor. Move them here so they’re managed in one place.`
              }
            >
              {legacyHere > 0 ? (
                canEditHere ? (
                  <p className='cf-legacy__actions'>
                    <button
                      type='button'
                      className='cf-button'
                      aria-haspopup='dialog'
                      onClick={openMove}
                    >
                      Review and move
                    </button>
                    <span>
                      {countOf(legacyHere, 'control')} in {process.name}
                    </span>
                  </p>
                ) : (
                  <p>
                    {countOf(legacyHere, 'control')} in {process.name}. Someone with Edit process
                    permission on it can move them.
                  </p>
                )
              ) : null}
              {legacyElsewhere.length > 0 ? (
                <p className='cf-legacy__elsewhere'>
                  {legacyHere > 0 ? 'Also in ' : 'In '}
                  {legacyElsewhere.map((item, index) => (
                    <span key={item.process.id}>
                      {index > 0 ? ', ' : ''}
                      <button
                        type='button'
                        className='cf-link'
                        onClick={() => props.onSelectProcess(item.process.id)}
                      >
                        {item.process.name} ({item.count})
                      </button>
                    </span>
                  ))}
                  .
                </p>
              ) : null}
            </Callout>
          ) : null}
          <output className='cf-scan-progress'>
            {scanning ? (
              <span className='cf-progress'>
                <Spinner /> Looking for controls in every process… {scans.done} of {scans.total}
              </span>
            ) : null}
          </output>

          {props.configurations.status === 'loading' ? (
            <output className='cf-loading'>
              <Spinner /> Loading configurations…
            </output>
          ) : props.configurations.status === 'error' ? (
            <Callout tone='error' role='alert' title={props.configurations.message}>
              <p>
                <button type='button' className='cf-link' onClick={props.onRetryConfigurations}>
                  Try again
                </button>
              </p>
            </Callout>
          ) : listed.length === 0 ? (
            <div className='cf-empty-state'>
              <p className='cf-empty-state__title'>No configurations for {process.name} yet.</p>
              {canCreate ? (
                <p className='cf-empty-state__actions'>
                  <button
                    type='button'
                    className='cf-button cf-button--primary'
                    onClick={() => props.onNew(process.id)}
                  >
                    New configuration
                  </button>
                  <span>
                    or{' '}
                    <button
                      type='button'
                      className='cf-link'
                      onClick={() => fileInput.current?.click()}
                    >
                      import a file
                    </button>
                  </span>
                </p>
              ) : (
                <p className='cf-hint'>
                  Someone with Edit process permission on {process.name} can add one.
                </p>
              )}
            </div>
          ) : (
            <ConfigurationList
              label={`Configurations in ${process.name}`}
              configurations={listed}
              processName={processName}
              usage={usageOf}
              canEdit={(doc) => canEditConfiguration(permissions, doc)}
              onEdit={(doc) => props.onEdit(doc, process.id)}
              menu={(doc) => menuFor(doc, true)}
            />
          )}

          <ControlsSection
            key={process.id}
            process={process}
            scan={scan}
            configurations={docs}
            canEdit={canEditHere}
            services={services}
            headingRef={controlsHeadingRef}
            onControlUpdated={scans.replaceControl}
            onRescan={() => scans.rescan(process)}
            onMove={openMove}
          />

          {orphans.length > 0 ? (
            <section className='cf-orphans' aria-labelledby={`${id}-orphans`}>
              <h2 id={`${id}-orphans`} className='cf-section-title'>
                Not used by any process
              </h2>
              <p className='cf-section-description'>
                These configurations aren’t shared with any process that still exists. Share them
                with a process, or delete them.
              </p>
              <ConfigurationList
                label='Configurations not used by any process'
                configurations={orphans}
                processName={processName}
                usage={() => 0}
                canEdit={() => true}
                menu={(doc) => menuFor(doc, false)}
              />
            </section>
          ) : null}
        </section>
      </div>

      <input
        ref={fileInput}
        type='file'
        accept='.json,application/json'
        className='cf-file-input'
        tabIndex={-1}
        aria-label='Configuration file to import'
        onChange={(event) => void onFile(event)}
      />

      {deleting ? (
        <ConfirmDialog
          title={`Delete ${quoteName(deleting.name)}?`}
          confirmLabel='Delete'
          busyLabel='Deleting…'
          danger
          busy={busy}
          error={dialogError}
          returnFocus={() => headingRef.current}
          onCancel={closeDialog}
          onConfirm={() => void confirmDelete(deleting)}
        >
          <p>
            {deleteUsers.length > 0
              ? `${countOf(deleteUsers.length, 'control')} ${deleteUsers.length === 1 ? 'uses' : 'use'} it and will show “Configuration not found” until you choose another.`
              : counted(deleting)
                ? 'No control uses it.'
                : 'Controls that use it will show “Configuration not found” until you choose another.'}
            {deleting.secret ? ' Its secret is deleted too.' : ''}
          </p>
          {deleting.processIds.filter((processId) => knownIds.has(processId)).length > 1 ? (
            <p>
              It’s shared with{' '}
              {joinNames(
                deleting.processIds
                  .map((processId) => processName(processId))
                  .filter((name): name is string => Boolean(name))
              )}
              , and is deleted from all of them.
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {dialog?.kind === 'share' ? (
        <ShareDialog
          doc={dialog.doc}
          processes={processes}
          configurations={docs}
          permissions={permissions}
          services={services}
          returnFocus={() => headingRef.current}
          onClose={closeDialog}
          onLatest={(latest) => onConfigurationsChange(() => latest)}
          onSaved={(saved) => {
            onConfigurationsChange((current) => upsertConfiguration(current, saved));
            setDialog(null);
            onNotice({
              tone: 'success',
              title: `${quoteName(saved.name)} is shared with ${joinNames(
                saved.processIds
                  .map((processId) => processName(processId))
                  .filter((name): name is string => Boolean(name))
              )}.`,
            });
          }}
        />
      ) : null}

      {dialog?.kind === 'import' ? (
        <ImportDialog
          process={process}
          fileName={dialog.fileName}
          entries={dialog.entries}
          configurations={docs}
          services={services}
          processName={processName}
          returnFocus={() => importButton.current ?? headingRef.current}
          onImported={(saved) =>
            onConfigurationsChange((current) => upsertConfiguration(current, saved))
          }
          onLatest={(latest) => onConfigurationsChange(() => latest)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'move' ? (
        <MigrationDialog
          plan={dialog.plan}
          services={services}
          returnFocus={() => headingRef.current}
          onFinished={moveFinished}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
