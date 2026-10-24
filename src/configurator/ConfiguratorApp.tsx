import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Spinner } from '../components/Spinner';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import {
  READ_ONLY_PERMISSIONS,
  canEditProcess,
  permissionErrorMessage,
  permissionsUnverified,
  quoteName,
} from '../core/configurations';
import { toUserMessage } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import type { SecurityPolicy } from '../core/policy';
import { DEFAULT_POLICY } from '../core/policy';
import { canHoldControls } from '../devops/processes';
import { ConfigurationEditor } from './ConfigurationEditor';
import type { Loadable } from './ConfigurationsTab';
import { ConfigurationsTab, upsertConfiguration } from './ConfigurationsTab';
import { controlsNaming } from './configurationStatus';
import { ConfirmDialog } from './ConfirmDialog';
import type { Notice } from './notices';
import { NoticeArea } from './notices';
import { PolicyTab } from './PolicyTab';
import { RenameControlsDialog } from './RenameControlsDialog';
import type { EditorRoute, Route, TabId } from './routes';
import { DEFAULT_ROUTE, editorKey, hashForRoute, routeFromHash } from './routes';
import type { ProcessSummary, SetupServices } from './services';
import type { TabDefinition } from './Tabs';
import { TabList, TabPanel } from './Tabs';
import { Callout } from './ui';
import { useProcessScans } from './useProcessScans';

export type { TabId } from './routes';

export const TABS: readonly TabDefinition<TabId>[] = [
  { id: 'configurations', label: 'Configurations' },
  { id: 'policy', label: 'Security policy' },
];

const ID_PREFIX = 'cf';

/** The process last chosen in this browser tab, like 3.0's Saved configurations tab. */
const PROCESS_KEY = 'rest-picklist:setup:process';

function rememberedProcess(): string {
  try {
    return sessionStorage.getItem(PROCESS_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberProcess(id: string): void {
  try {
    sessionStorage.setItem(PROCESS_KEY, id);
  } catch {
    // Not remembered; nothing else changes.
  }
}

/** The remembered process, else the first enabled one that can hold controls. */
function initialProcessId(processes: readonly ProcessSummary[]): string {
  const usable = processes.filter(canHoldControls);
  const remembered = rememberedProcess();
  return (
    (
      usable.find((process) => process.id === remembered) ??
      usable.find((process) => process.isEnabled) ??
      usable[0]
    )?.id ?? ''
  );
}

function sameView(a: Route, b: Route): boolean {
  if (a.tab !== b.tab) {
    return false;
  }
  return a.editor && b.editor ? editorKey(a.editor) === editorKey(b.editor) : a.editor === b.editor;
}

/** One opening of the editor. It keeps its key (and state) when a new configuration is saved. */
interface EditorSession {
  key: string;
  /** editorKey() of the route it belongs to. */
  target: string;
  /** As stored; null until a new configuration is saved for the first time. */
  configuration: ConfigurationDocument | null;
  /** The process it was opened from. */
  processId: string;
}

interface RenameOffer {
  configuration: ConfigurationDocument;
  previousName: string;
  controls: LayoutControl[];
  others: number;
}

/** Where an editor route leads once everything is loaded, or why it can't open. */
function resolveEditor(
  editor: EditorRoute,
  processes: readonly ProcessSummary[],
  docs: readonly ConfigurationDocument[],
  selectedProcessId: string
): { configuration: ConfigurationDocument | null; processId: string } | { problem: string } {
  const usable = processes.filter(canHoldControls);
  if (editor.kind === 'new') {
    return usable.some((process) => process.id === editor.processId)
      ? { configuration: null, processId: editor.processId }
      : { problem: 'That process can’t hold REST Picklist controls, so the editor didn’t open.' };
  }
  const doc = docs.find((item) => item.id === editor.id);
  if (!doc) {
    return { problem: 'That configuration doesn’t exist anymore. It may have been deleted.' };
  }
  const processId = doc.processIds.includes(selectedProcessId)
    ? selectedProcessId
    : (doc.processIds.find((id) => usable.some((process) => process.id === id)) ??
      doc.processIds[0] ??
      '');
  return { configuration: doc, processId };
}

/**
 * The REST Picklist page under Organization settings › Extensions: the Configurations tab (with
 * the configuration editor in place of the list while editing) and the Security policy tab. The
 * view follows the URL hash: #configurations, #policy, #edit=<id> and #new=<process id>.
 */
export function ConfiguratorApp({ services }: { services: SetupServices }) {
  const demoId = useId();
  const [route, setRoute] = useState<Route>(
    () => routeFromHash(window.location.hash) ?? DEFAULT_ROUTE
  );
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set([route.tab]));
  const [processes, setProcesses] = useState<Loadable<ProcessSummary[]>>({ status: 'loading' });
  const [configurations, setConfigurations] = useState<Loadable<ConfigurationDocument[]>>({
    status: 'loading',
  });
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [selectedProcessId, setSelectedProcessId] = useState('');
  const [session, setSession] = useState<EditorSession | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<Route | null>(null);
  const [renameOffer, setRenameOffer] = useState<RenameOffer | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [persona, setPersona] = useState(() => services.demo?.persona() ?? '');
  // Editor sessions opened so far: part of each one's key, so a new one never reuses the last.
  const [sessions, setSessions] = useState(0);
  const requests = useRef({ processes: 0, permissions: 0, configurations: 0 });
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const controlsHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // Set when the view changes because of something the person did; that view's heading then
  // takes focus.
  const focusView = useRef<'list' | 'controls' | 'editor' | null>(null);
  const writtenHash = useRef(hashForRoute(route));
  // The latest route handler, for the hashchange listener set up once.
  const latest = useRef<{ request: (next: Route) => void }>({ request: () => undefined });
  // What's shown now, for a save that finishes after the person left the editor.
  const latestSession = useRef<EditorSession | null>(session);
  const latestRoute = useRef<Route>(route);

  const processList = processes.status === 'ready' ? processes.value : null;
  const scans = useProcessScans(services, processList, selectedProcessId);

  const writeHash = useCallback(
    (next: Route) => {
      const hash = hashForRoute(next);
      writtenHash.current = hash;
      try {
        window.history.replaceState(null, '', `#${hash}`);
      } catch {
        // Some frames don't allow it; the view still changes.
      }
      services.replaceHash?.(hash);
    },
    [services]
  );

  // The address follows the view (but isn't written on the first render, so the host page's own
  // hash can still be read).
  useEffect(() => {
    if (hashForRoute(route) !== writtenHash.current) {
      writeHash(route);
    }
  }, [route, writeHash]);

  const fetchPermissions = useCallback(
    (list: readonly ProcessSummary[]) => {
      requests.current.permissions += 1;
      const request = requests.current.permissions;
      setPermissions(null);
      void services.loadPermissions(list).then(
        (snapshot) => {
          if (request === requests.current.permissions) {
            setPermissions(snapshot);
          }
        },
        () => {
          // loadPermissions doesn't reject; this is only a safety net.
          if (request === requests.current.permissions) {
            setPermissions({
              ...READ_ONLY_PERMISSIONS,
              error: permissionErrorMessage('something went wrong'),
            });
          }
        }
      );
    },
    [services]
  );

  /** Reads the processes, then the permissions for them. The caller shows the loading state. */
  const fetchProcesses = useCallback(() => {
    requests.current.processes += 1;
    const request = requests.current.processes;
    void services.listProcesses().then(
      (list) => {
        if (request !== requests.current.processes) {
          return;
        }
        setProcesses({ status: 'ready', value: list });
        setSelectedProcessId((current) =>
          list.some((process) => process.id === current && canHoldControls(process))
            ? current
            : initialProcessId(list)
        );
        fetchPermissions(list);
      },
      (error: unknown) => {
        if (request !== requests.current.processes) {
          return;
        }
        setProcesses({ status: 'error', message: toUserMessage(error) });
        // Whether the policy can be changed doesn't depend on the processes.
        fetchPermissions([]);
      }
    );
  }, [services, fetchPermissions]);

  /** Reads every configuration. The caller shows the loading state. */
  const fetchConfigurations = useCallback(() => {
    requests.current.configurations += 1;
    const request = requests.current.configurations;
    void services.listConfigurations().then(
      (list) => {
        if (request === requests.current.configurations) {
          setConfigurations({ status: 'ready', value: list });
        }
      },
      (error: unknown) => {
        if (request === requests.current.configurations) {
          setConfigurations({ status: 'error', message: toUserMessage(error) });
        }
      }
    );
  }, [services]);

  /** Reads the saved policy; the returned function ignores a response that arrives too late. */
  const fetchPolicy = useCallback(() => {
    let active = true;
    services.loadPolicy().then(
      (loaded) => active && setPolicy(loaded),
      // Never fall back to the defaults here: saving them would replace the real policy.
      (error: unknown) => active && setPolicyError(toUserMessage(error))
    );
    return () => {
      active = false;
    };
  }, [services]);

  const retryPolicy = useCallback(() => {
    setPolicy(null);
    setPolicyError(null);
    fetchPolicy();
  }, [fetchPolicy]);

  const retryProcesses = () => {
    setProcesses({ status: 'loading' });
    fetchProcesses();
  };

  const retryConfigurations = () => {
    setConfigurations({ status: 'loading' });
    fetchConfigurations();
  };

  useEffect(() => {
    let cancelled = false;
    fetchProcesses();
    fetchConfigurations();
    const cancelPolicy = fetchPolicy();
    // Inside Azure DevOps the address bar belongs to the host page.
    if (!routeFromHash(window.location.hash) && services.getHash) {
      void services.getHash().then((hash) => {
        const fromHost = routeFromHash(hash);
        if (!cancelled && fromHost) {
          writtenHash.current = hashForRoute(fromHost);
          setRoute(fromHost);
          setVisited((current) => new Set([...current, fromHost.tab]));
        }
      });
    }
    const onHashChange = () => {
      const next = routeFromHash(window.location.hash);
      if (next) {
        latest.current.request(next);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      cancelled = true;
      cancelPolicy();
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [services, fetchProcesses, fetchConfigurations, fetchPolicy]);

  /** Shows `next`. Leaving the editor drops its session; the new view's heading gets focus. */
  const commit = (next: Route) => {
    const leaving =
      route.editor !== null && !(next.editor && editorKey(next.editor) === editorKey(route.editor));
    setRoute(next);
    setVisited((current) => (current.has(next.tab) ? current : new Set([...current, next.tab])));
    if (leaving) {
      setSession(null);
      setDirty(false);
    }
    focusView.current =
      next.tab !== 'configurations' ? null : next.editor ? 'editor' : leaving ? 'list' : null;
  };

  /** Like commit, but asks first when that would leave an editor with unsaved changes. */
  const request = (next: Route) => {
    if (sameView(route, next)) {
      return;
    }
    if (route.editor && dirty) {
      setPendingRoute(next);
      return;
    }
    commit(next);
  };

  useEffect(() => {
    latest.current = { request };
    latestSession.current = session;
    latestRoute.current = route;
  });

  const selectProcess = (processId: string) => {
    setSelectedProcessId(processId);
    rememberProcess(processId);
  };

  const openEditor = (doc: ConfigurationDocument | null, processId: string) => {
    const editor: EditorRoute = doc ? { kind: 'edit', id: doc.id } : { kind: 'new', processId };
    setSessions((count) => count + 1);
    setSession({
      key: `${editorKey(editor)}#${sessions}`,
      target: editorKey(editor),
      configuration: doc,
      processId,
    });
    commit({ tab: 'configurations', editor });
  };

  // An editor named by the address (a reload, a link, the host's hash) opens once the
  // processes, configurations and permissions are known. Worked out while rendering, so the
  // editor shows in the same pass; the editor moves focus to its heading itself.
  const routeEditor = route.tab === 'configurations' ? route.editor : null;
  if (
    routeEditor &&
    session?.target !== editorKey(routeEditor) &&
    processes.status === 'ready' &&
    configurations.status === 'ready' &&
    permissions !== null
  ) {
    const resolved = resolveEditor(
      routeEditor,
      processes.value,
      configurations.value,
      selectedProcessId
    );
    if ('problem' in resolved) {
      setNotice({ tone: 'warning', title: resolved.problem });
      setRoute(DEFAULT_ROUTE);
    } else {
      setSessions((count) => count + 1);
      setSession({
        key: `${editorKey(routeEditor)}#${sessions}`,
        target: editorKey(routeEditor),
        configuration: resolved.configuration,
        processId: resolved.processId,
      });
      if (
        resolved.processId !== selectedProcessId &&
        processes.value.some(
          (process) => process.id === resolved.processId && canHoldControls(process)
        )
      ) {
        setSelectedProcessId(resolved.processId);
      }
    }
  }

  // Moves focus to the heading of a view the person just opened.
  useEffect(() => {
    if (focusView.current === 'list' || focusView.current === 'controls') {
      const heading =
        focusView.current === 'controls' ? controlsHeadingRef.current : listHeadingRef.current;
      if (heading) {
        focusView.current = null;
        heading.focus();
        heading.scrollIntoView?.({ block: 'start' });
      }
      return;
    }
    const container = editorRef.current;
    if (focusView.current !== 'editor' || !container) {
      return;
    }
    focusView.current = null;
    if (container.contains(document.activeElement)) {
      // The editor already put focus where it wants it.
      return;
    }
    const heading = container.querySelector<HTMLElement>('h1, h2, h3');
    const target = heading ?? container;
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    target.focus();
  });

  const updateConfigurations = (
    update: (docs: ConfigurationDocument[]) => ConfigurationDocument[]
  ) =>
    setConfigurations((current) =>
      current.status === 'ready' ? { status: 'ready', value: update(current.value) } : current
    );

  const onSaved = (
    sessionKey: string,
    saved: ConfigurationDocument,
    previousName: string | null
  ) => {
    updateConfigurations((current) => upsertConfiguration(current, saved));
    if (latestSession.current?.key !== sessionKey) {
      // The editor was left while it saved: the save went through, but it doesn't reopen.
      setNotice({ tone: 'success', title: `Saved ${quoteName(saved.name)}.` });
      return;
    }
    const editor: EditorRoute = { kind: 'edit', id: saved.id };
    // The same session goes on with the stored document, so the editor isn't reset.
    setSession((current) =>
      current?.key === sessionKey
        ? { ...current, target: editorKey(editor), configuration: saved }
        : current
    );
    if (latestRoute.current.editor?.kind === 'new') {
      setRoute({ tab: 'configurations', editor });
    }
    if (previousName) {
      const using = controlsNaming(scans.controls, previousName, saved.processIds);
      const editable = using.filter((control) =>
        canEditProcess(permissions ?? READ_ONLY_PERMISSIONS, control.processId)
      );
      if (editable.length > 0) {
        setRenameOffer({
          configuration: saved,
          previousName,
          controls: editable,
          others: using.length - editable.length,
        });
      }
    }
  };

  const tabRoute = (tab: TabId): Route =>
    tab === 'policy'
      ? { tab: 'policy', editor: null }
      : route.tab === 'configurations'
        ? route
        : DEFAULT_ROUTE;

  const editor = route.tab === 'configurations' ? route.editor : null;
  const editorShown =
    editor !== null &&
    session !== null &&
    session.target === editorKey(editor) &&
    processes.status === 'ready' &&
    configurations.status === 'ready';

  const tab = (
    <ConfigurationsTab
      services={services}
      processes={processes}
      configurations={configurations}
      permissions={permissions}
      scans={scans}
      selectedProcessId={selectedProcessId}
      onSelectProcess={selectProcess}
      onRetryProcesses={retryProcesses}
      onRetryConfigurations={retryConfigurations}
      onConfigurationsChange={updateConfigurations}
      onEdit={(doc, processId) => openEditor(doc, processId)}
      onNew={(processId) => openEditor(null, processId)}
      onNotice={setNotice}
      headingRef={listHeadingRef}
      controlsHeadingRef={controlsHeadingRef}
    />
  );

  return (
    <div className='cf-page'>
      <header className='cf-header'>
        <div>
          <h1 className='cf-title'>REST Picklist</h1>
          <p className='cf-subtitle'>
            The APIs your REST Picklist controls call, and the rules they follow.
          </p>
        </div>
        {services.demo ? (
          <div className='cf-demo'>
            <span className='cf-badge'>Local demo</span>
            <label className='cf-label' htmlFor={`${demoId}-persona`}>
              Signed in as
            </label>
            <select
              id={`${demoId}-persona`}
              className='cf-input cf-select cf-demo__select'
              value={persona}
              aria-describedby={`${demoId}-note`}
              onChange={(event) => {
                services.demo?.setPersona(event.target.value);
                setPersona(event.target.value);
                fetchPermissions(processList ?? []);
              }}
            >
              {services.demo.personas.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <span id={`${demoId}-note`} className='cf-hint'>
              Sample data. Nothing is saved anywhere.
            </span>
          </div>
        ) : null}
      </header>

      {/* A status region: the check finishes after the page shows, so it's announced. */}
      <output className='cf-permission-error'>
        {permissions?.error ? (
          <Callout tone='warning' title={permissions.error}>
            <p>
              <button
                type='button'
                className='cf-link'
                onClick={() => fetchPermissions(processList ?? [])}
              >
                Try again
              </button>
            </p>
          </Callout>
        ) : permissions && permissionsUnverified(permissions) ? (
          <Callout tone='warning' title='Couldn’t verify your permissions'>
            <p>{permissions.unverified}</p>
            <p>
              <button
                type='button'
                className='cf-link'
                onClick={() => fetchPermissions(processList ?? [])}
              >
                Check again
              </button>
            </p>
          </Callout>
        ) : null}
      </output>

      <TabList
        label='REST Picklist settings'
        tabs={TABS}
        selected={route.tab}
        idPrefix={ID_PREFIX}
        onSelect={(next) => request(tabRoute(next))}
      />

      <NoticeArea notice={notice} onDismiss={() => setNotice(null)} />

      <TabPanel id='configurations' idPrefix={ID_PREFIX} selected={route.tab === 'configurations'}>
        {editor ? (
          editorShown && session ? (
            <div ref={editorRef} className='cf-editor-view'>
              {policyError ? (
                <Callout
                  tone='warning'
                  title='The security policy couldn’t be loaded, so the built-in rules are checked here.'
                />
              ) : null}
              <ConfigurationEditor
                key={session.key}
                services={services}
                policy={policy ?? DEFAULT_POLICY}
                permissions={permissions ?? READ_ONLY_PERMISSIONS}
                processes={processList ?? []}
                configurations={configurations.status === 'ready' ? configurations.value : []}
                configuration={session.configuration}
                processId={session.processId}
                onSaved={(saved, previousName) => onSaved(session.key, saved, previousName)}
                onConfigurationsLoaded={(docs) => updateConfigurations(() => docs)}
                scanned={scans.controls}
                scansComplete={scans.done >= scans.total}
                onClose={() => commit({ tab: 'configurations', editor: null })}
                onShowControls={() => {
                  commit({ tab: 'configurations', editor: null });
                  focusView.current = 'controls';
                }}
                onDirtyChange={setDirty}
              />
            </div>
          ) : processes.status === 'error' || configurations.status === 'error' ? (
            tab
          ) : (
            <output className='cf-loading'>
              <Spinner /> Opening the configuration…
            </output>
          )
        ) : visited.has('configurations') ? (
          tab
        ) : null}
      </TabPanel>
      <TabPanel id='policy' idPrefix={ID_PREFIX} selected={route.tab === 'policy'}>
        {visited.has('policy') ? (
          <PolicyTab
            policy={policy}
            error={policyError}
            onRetry={retryPolicy}
            permissions={permissions}
            demo={services.mode === 'demo'}
            onSave={async (next) => {
              const stored = await services.savePolicy(next);
              setPolicy(stored);
              return stored;
            }}
          />
        ) : null}
      </TabPanel>

      {pendingRoute ? (
        <ConfirmDialog
          title={
            session?.configuration
              ? `Discard changes to ${quoteName(session.configuration.name)}?`
              : 'Discard the new configuration?'
          }
          confirmLabel='Discard'
          busyLabel='Discarding…'
          cancelLabel='Keep editing'
          danger
          onCancel={() => {
            setPendingRoute(null);
            // The address may already show where they wanted to go.
            writeHash(route);
          }}
          onConfirm={() => {
            setPendingRoute(null);
            commit(pendingRoute);
          }}
        >
          <p>Your changes haven’t been saved.</p>
        </ConfirmDialog>
      ) : null}

      {renameOffer ? (
        <RenameControlsDialog
          configuration={renameOffer.configuration}
          previousName={renameOffer.previousName}
          controls={renameOffer.controls}
          others={renameOffer.others}
          scanned={scans.controls}
          services={services}
          onUpdated={scans.replaceControl}
          onClose={() => setRenameOffer(null)}
        />
      ) : null}
    </div>
  );
}
