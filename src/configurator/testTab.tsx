import { render } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { vi } from 'vitest';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import type { Loadable } from './ConfigurationsTab';
import { ConfigurationsTab } from './ConfigurationsTab';
import type { Notice } from './notices';
import { NoticeArea } from './notices';
import type { ProcessSummary, SetupServices } from './services';
import { useProcessScans } from './useProcessScans';

// The Configurations tab wired the way ConfiguratorApp wires it (data loading, scans, notices),
// for component tests that don't need the rest of the page or the configuration editor.

export interface TabCallbacks {
  onEdit: (doc: ConfigurationDocument, processId: string) => void;
  onNew: (processId: string) => void;
}

function TabHarness(props: { services: SetupServices; initialProcessId: string } & TabCallbacks) {
  const { services } = props;
  const [processes, setProcesses] = useState<Loadable<ProcessSummary[]>>({ status: 'loading' });
  const [configurations, setConfigurations] = useState<Loadable<ConfigurationDocument[]>>({
    status: 'loading',
  });
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [selected, setSelected] = useState(props.initialProcessId);
  const [notice, setNotice] = useState<Notice | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    void services.listProcesses().then((list) => {
      setProcesses({ status: 'ready', value: list });
      void services.loadPermissions(list).then(setPermissions);
    });
    void services.listConfigurations().then(
      (value) => setConfigurations({ status: 'ready', value }),
      (error: unknown) =>
        setConfigurations({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed',
        })
    );
  }, [services]);

  const scans = useProcessScans(
    services,
    processes.status === 'ready' ? processes.value : null,
    selected
  );

  return (
    <>
      <NoticeArea notice={notice} onDismiss={() => setNotice(null)} />
      <ConfigurationsTab
        services={services}
        processes={processes}
        configurations={configurations}
        permissions={permissions}
        scans={scans}
        selectedProcessId={selected}
        onSelectProcess={setSelected}
        onRetryProcesses={() => undefined}
        onRetryConfigurations={() => undefined}
        onConfigurationsChange={(update) =>
          setConfigurations((current) =>
            current.status === 'ready' ? { status: 'ready', value: update(current.value) } : current
          )
        }
        onEdit={props.onEdit}
        onNew={props.onNew}
        onNotice={setNotice}
        headingRef={headingRef}
      />
    </>
  );
}

/** Renders the tab for `services`, with spies for opening the editor. */
export function renderTab(services: SetupServices, initialProcessId = 'p-contoso') {
  const callbacks: TabCallbacks = {
    onEdit: vi.fn<TabCallbacks['onEdit']>(),
    onNew: vi.fn<TabCallbacks['onNew']>(),
  };
  const view = render(
    <TabHarness services={services} initialProcessId={initialProcessId} {...callbacks} />
  );
  return { ...view, ...callbacks };
}
