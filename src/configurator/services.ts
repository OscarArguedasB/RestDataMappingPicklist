import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import type { LayoutControl } from '../core/migration';
import type { SecurityPolicy } from '../core/policy';
import type { SecretDocument, StoredSecret } from '../core/secrets';
import type { ProcessSummary } from '../devops/processes';

export type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
export type { LayoutControl } from '../core/migration';
export type { SecretDocument, StoredSecret } from '../core/secrets';
export type { ProcessSummary } from '../devops/processes';

/** Someone the local demo can pretend to be, to try what each permission allows. */
export interface DemoPersona {
  id: string;
  label: string;
}

/** Local demo only. Switching persona changes what the next loadPermissions returns. */
export interface DemoControls {
  personas: readonly DemoPersona[];
  persona: () => string;
  setPersona: (id: string) => void;
}

/**
 * Everything the setup page needs from Azure DevOps, behind one small interface: the real
 * implementation (devopsServices.ts) calls the organization's REST API and extension data, and a
 * demo one (local development only) keeps sample data in memory. Tests pass their own. Members
 * are plain function properties, so they can be passed around without a `this`.
 */
export interface SetupServices {
  /** 'demo' outside Azure DevOps: nothing is saved anywhere. */
  readonly mode: 'devops' | 'demo';
  /** The signed-in person, for "changed by" before a save returns the stamped document. */
  currentUser: () => { displayName: string };
  listProcesses: () => Promise<ProcessSummary[]>;
  /** Never rejects: a failed check comes back with `error` set and nothing editable. */
  loadPermissions: (processes: readonly ProcessSummary[]) => Promise<PermissionSnapshot>;
  /** Always read fresh, never from the forms' five-minute cache. */
  listConfigurations: () => Promise<ConfigurationDocument[]>;
  /**
   * Creates the configuration when it has no `__etag`, otherwise updates it. Returns the stored
   * document with its new `__etag` and stamps. Doesn't check names: use findNameConflicts first.
   */
  saveConfiguration: (doc: ConfigurationDocument) => Promise<ConfigurationDocument>;
  /** Deletes the configuration, then its secret. */
  deleteConfiguration: (doc: Pick<ConfigurationDocument, 'id' | 'name'>) => Promise<void>;
  /** Only for test requests on this page. Never display any part of it. */
  loadSecret: (id: string) => Promise<SecretDocument | null>;
  /** `apiOrigin`: OAuth 2.0 only, where the secret's access tokens may go (see secrets.ts). */
  saveSecret: (
    id: string,
    secret: StoredSecret,
    boundOrigin: string,
    apiOrigin?: string
  ) => Promise<SecretDocument>;
  deleteSecret: (id: string) => Promise<void>;
  /** False when the source has no secret to copy. */
  copySecret: (fromId: string, toId: string) => Promise<boolean>;
  /** This extension's controls in the process's work item type layouts. */
  scanProcessControls: (process: { id: string; name: string }) => Promise<LayoutControl[]>;
  /** Replaces the control's inputs completely (Controls - Update). Azure DevOps checks Edit process. */
  updateControlInputs: (
    control: LayoutControl,
    inputs: Record<string, string>
  ) => Promise<LayoutControl>;
  loadPolicy: () => Promise<SecurityPolicy>;
  savePolicy: (policy: SecurityPolicy) => Promise<SecurityPolicy>;
  /** The host page's URL hash, since Azure DevOps shows this page in a frame. */
  getHash?: () => Promise<string>;
  replaceHash?: (hash: string) => void;
  /** Used for test requests instead of fetch; the demo serves sample endpoints from memory. */
  fetchImpl?: typeof fetch;
  /** Local demo only, never inside Azure DevOps: lets the page switch who you are. */
  demo?: DemoControls;
}
