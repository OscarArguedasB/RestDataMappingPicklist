import * as SDK from 'azure-devops-extension-sdk';
import { createRoot } from 'react-dom/client';
import { isPlainObject } from '../core/values';
import type { WorkItemNotificationListener } from '../devops/formService';
import '../styles/theme.css';
import '../styles/control.css';
import { ControlApp } from './ControlApp';
import { PicklistController } from './controller';
import { createDevOpsHost, createFrameResizer } from './host';

async function start(): Promise<void> {
  await SDK.init({ loaded: false, applyTheme: true });

  const inputs: unknown = SDK.getConfiguration().witInputs;
  const controller = new PicklistController(
    isPlainObject(inputs) ? inputs : {},
    createDevOpsHost()
  );
  const listener: WorkItemNotificationListener = {
    onLoaded: (args) => void controller.onLoaded(args),
    onFieldChanged: (args) => controller.onFieldChanged(args),
    onSaved: () => void controller.onSaved(),
    onRefreshed: () => void controller.onRefreshed(),
    onReset: () => void controller.onReset(),
    onUnloaded: () => controller.onUnloaded(),
  };
  SDK.register(SDK.getContributionId(), () => listener);

  const container = document.getElementById('root');
  if (!container) {
    throw new Error('The #root element is missing from selector.html.');
  }
  createRoot(container).render(
    <ControlApp controller={controller} onResize={createFrameResizer()} />
  );
  await SDK.notifyLoadSucceeded();
}

start().catch((error: unknown) => {
  console.error('[REST picklist] The control failed to start:', error);
  void SDK.notifyLoadFailed(error instanceof Error ? error : String(error));
});
