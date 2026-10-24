import * as SDK from 'azure-devops-extension-sdk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/control.css';
import '../styles/configurator.css';
import '../styles/editor.css';
import { ConfiguratorApp } from './ConfiguratorApp';
import { createDevOpsServices } from './devopsServices';
import type { SetupServices } from './services';

// webpack replaces process.env.NODE_ENV with the build mode; nothing else from Node exists here.
declare const process: { env: { NODE_ENV?: string } };

async function createServices(hosted: boolean): Promise<SetupServices> {
  if (hosted) {
    return createDevOpsServices();
  }
  // Production builds drop this branch, and with it the demo module and its sample data.
  if (process.env.NODE_ENV !== 'production') {
    const { createDemoServices } = await import('./demoServices');
    return createDemoServices();
  }
  throw new Error('Open REST Picklist from Organization settings in Azure DevOps.');
}

async function start(): Promise<void> {
  // Outside Azure DevOps (local development) there is no host to talk to.
  const hosted = window.parent !== window;
  if (hosted) {
    await SDK.init({ loaded: false, applyTheme: true });
  }
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('The #root element is missing from configurator.html.');
  }
  const services = await createServices(hosted);
  createRoot(container).render(
    <StrictMode>
      <ConfiguratorApp services={services} />
    </StrictMode>
  );
  if (hosted) {
    await SDK.notifyLoadSucceeded();
  }
}

start().catch((error: unknown) => {
  console.error('[REST picklist] The setup page failed to start:', error);
  void SDK.notifyLoadFailed(error instanceof Error ? error : String(error));
});
