import type { ConfigurationDocument } from '../core/configurations';
import {
  CONFIGURATIONS_COLLECTION,
  CONFIGURATION_LIMITS,
  findConfigurationForProcess,
  isConfigurationId,
  nameKey,
  parseConfigurationDocument,
  quoteName,
  sortConfigurations,
  validateConfigurationName,
} from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { SecretDocument, SecretSummary, StoredSecret } from '../core/secrets';
import {
  SECRETS_COLLECTION,
  parseOrigin,
  parseSecretDocument,
  parseStoredSecret,
} from '../core/secrets';
import { isPlainObject } from '../core/values';
import type { DocumentManager, SessionStore } from './extensionData';
import {
  COLLECTION_SCOPE,
  cacheKey,
  clearSessionCache,
  defaultSessionStore,
  getDocumentManager,
  readSessionCache,
  writeSessionCache,
} from './extensionData';
import { processForProject } from './processes';
import type { DevOpsApi, DevOpsSdk } from './rest';
import { devOpsSdk } from './rest';

// Configurations and their secrets in the organization's extension data. The configuration list
// is kept for five minutes in the tab's sessionStorage, so forms don't ask for it on every work
// item; secrets never are, and they're never logged or put in an error message. The form control
// loads this module lazily, so it has no React and no hub-only code.

/** Like policyStore's options. Secrets ignore `storage` and `fresh`: they're never cached. */
export interface ConfigurationStoreOptions {
  sdk?: DevOpsSdk;
  /** Defaults to sessionStorage; null turns the cache off. */
  storage?: SessionStore | null;
  /** Skip the five-minute cache, for the setup page. */
  fresh?: boolean;
}

/** What the form control needs to use a configuration. */
export interface ResolvedConfiguration {
  id: string;
  /** Its current name, even when the control uses a former one. */
  name: string;
  processId: string;
  processName: string;
  settings: Record<string, string>;
  secret: SecretSummary | null;
}

// Far more than any organization has; a larger cached list is treated as tampered with.
const MAX_CACHED_CONFIGURATIONS = 5000;
const MAX_LOGGED_IDS = 10;

function storeOf(options: ConfigurationStoreOptions): SessionStore | null {
  return options.storage === undefined ? defaultSessionStore() : options.storage;
}

/** Null when the organization is unknown: then nothing is cached rather than risk mixing them up. */
function listCacheKey(sdk: DevOpsSdk): string | null {
  try {
    const { id } = sdk.getHost();
    return typeof id === 'string' && id ? cacheKey('configurations', id) : null;
  } catch {
    return null;
  }
}

function parseCachedList(data: unknown): ConfigurationDocument[] | null {
  if (
    !isPlainObject(data) ||
    !Array.isArray(data.configurations) ||
    data.configurations.length > MAX_CACHED_CONFIGURATIONS
  ) {
    return null;
  }
  const docs: ConfigurationDocument[] = [];
  for (const entry of data.configurations) {
    const doc = parseConfigurationDocument(entry);
    if (!doc) {
      return null;
    }
    docs.push(doc);
  }
  return docs;
}

// Errors from the extension data service come through the host frame, often as plain objects
// rather than Error instances, so they're read field by field.
function errorStatus(error: unknown): number | undefined {
  if (!isPlainObject(error)) {
    return undefined;
  }
  const response = isPlainObject(error.response) ? error.response : {};
  const status = error.status ?? error.statusCode ?? response.status;
  return typeof status === 'number' ? status : undefined;
}

function errorNames(error: unknown): string {
  if (!isPlainObject(error)) {
    return '';
  }
  const server = isPlainObject(error.serverError) ? error.serverError : {};
  return [error.typeKey, error.typeName, error.name, error.message, server.typeKey, server.typeName]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

function isNotFound(error: unknown): boolean {
  return (
    errorStatus(error) === 404 ||
    /DocumentCollectionDoesNotExist|DocumentDoesNotExist/i.test(errorNames(error))
  );
}

function isConflict(error: unknown): boolean {
  const status = errorStatus(error);
  return (
    status === 409 ||
    status === 412 ||
    /InvalidDocumentVersion|DocumentExists/i.test(errorNames(error))
  );
}

function isRefused(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 401 || status === 403;
}

function currentUser(sdk: DevOpsSdk): string | undefined {
  try {
    const user = sdk.getUser();
    const name = (user.displayName || user.name || '').trim();
    return name ? name.slice(0, CONFIGURATION_LIMITS.maxStampLength) : undefined;
  } catch {
    return undefined;
  }
}

function documentLabel(item: unknown): string {
  return isPlainObject(item) && typeof item.id === 'string'
    ? JSON.stringify(item.id.slice(0, 60))
    : '(no id)';
}

async function readList(
  sdk: DevOpsSdk,
  store: SessionStore | null,
  fresh: boolean
): Promise<{ docs: ConfigurationDocument[]; cached: boolean }> {
  const key = listCacheKey(sdk);
  if (key && !fresh) {
    const cached = readSessionCache(store, key, parseCachedList);
    if (cached) {
      return { docs: cached, cached: true };
    }
  }
  let data: unknown;
  try {
    const manager = await getDocumentManager(sdk);
    data = await manager.getDocuments(CONFIGURATIONS_COLLECTION, COLLECTION_SCOPE);
  } catch (error) {
    if (!isNotFound(error)) {
      const status = errorStatus(error);
      throw isRefused(error)
        ? new PicklistError(
            'http',
            'You don’t have permission to read the REST Picklist configurations.',
            status
          )
        : new PicklistError(
            'network',
            'Couldn’t read the REST Picklist configurations. Try again in a moment.',
            status
          );
    }
    // Nothing saved yet: the collection is created with the first configuration.
    data = [];
  }
  if (!Array.isArray(data)) {
    throw new PicklistError(
      'shape',
      'Azure DevOps returned an unexpected list of REST Picklist configurations.'
    );
  }
  const docs: ConfigurationDocument[] = [];
  // Any member can write documents here, so a long list mustn't take long to read.
  const seen = new Set<string>();
  const skipped: string[] = [];
  for (const item of data) {
    const doc = parseConfigurationDocument(item);
    if (!doc) {
      skipped.push(documentLabel(item));
    } else if (!seen.has(doc.id)) {
      seen.add(doc.id);
      docs.push(doc);
    }
  }
  if (skipped.length > 0) {
    // Only ids: a document can't be trusted to contain nothing private.
    console.warn(
      `REST Picklist: skipped ${skipped.length} configuration document(s) that aren’t valid:`,
      skipped.slice(0, MAX_LOGGED_IDS).join(', ')
    );
  }
  const sorted = sortConfigurations(docs);
  if (key) {
    writeSessionCache(store, key, { configurations: sorted });
  }
  return { docs: sorted, cached: false };
}

/**
 * Every configuration in the organization, sorted by name. Documents that aren't valid are
 * skipped (with a console warning naming their ids). Kept for five minutes in this tab unless
 * `fresh`.
 */
export async function listConfigurations(
  options: ConfigurationStoreOptions = {}
): Promise<ConfigurationDocument[]> {
  const { docs } = await readList(
    options.sdk ?? devOpsSdk,
    storeOf(options),
    options.fresh === true
  );
  return docs;
}

function clearListCache(sdk: DevOpsSdk, options: ConfigurationStoreOptions): void {
  const key = listCacheKey(sdk);
  if (key) {
    clearSessionCache(storeOf(options), key);
  }
}

function checkId(id: string): void {
  if (!isConfigurationId(id)) {
    throw new PicklistError('config', 'This configuration’s id isn’t valid.');
  }
}

/**
 * Creates the configuration (no `__etag`) or updates it (with the `__etag` it was read with),
 * noting who changed it and when. Only what parseConfigurationDocument understands is stored.
 * Someone else's change in between is refused with a 409 PicklistError.
 */
export async function saveConfiguration(
  doc: ConfigurationDocument,
  options: ConfigurationStoreOptions = {}
): Promise<ConfigurationDocument> {
  const sdk = options.sdk ?? devOpsSdk;
  const problem = validateConfigurationName(doc.name);
  if (problem) {
    throw new PicklistError('config', problem);
  }
  if (doc.processIds.length === 0) {
    throw new PicklistError('config', 'Share the configuration with at least one process.');
  }
  checkId(doc.id);
  const creating = doc.__etag === undefined;
  const user = currentUser(sdk);
  const now = new Date().toISOString();
  const clean = parseConfigurationDocument({
    ...doc,
    version: 1,
    ...(creating ? { createdBy: user, createdAt: now } : {}),
    updatedBy: user,
    updatedAt: now,
  });
  if (!clean) {
    throw new PicklistError(
      'config',
      'This configuration can’t be saved: some of its settings aren’t valid.'
    );
  }
  try {
    const manager = await getDocumentManager(sdk);
    const result = creating
      ? await manager.createDocument(CONFIGURATIONS_COLLECTION, clean, COLLECTION_SCOPE)
      : await manager.updateDocument(CONFIGURATIONS_COLLECTION, clean, COLLECTION_SCOPE);
    const saved = parseConfigurationDocument(result);
    if (saved && saved.id === clean.id) {
      return saved;
    }
    const etag =
      isPlainObject(result) && typeof result.__etag === 'number' ? result.__etag : undefined;
    return etag === undefined ? clean : { ...clean, __etag: etag };
  } catch (error) {
    const status = errorStatus(error);
    if (isConflict(error)) {
      throw new PicklistError(
        'http',
        `Someone changed ${quoteName(clean.name)} since you opened it. Reload to see their changes.`,
        409
      );
    }
    if (!creating && isNotFound(error)) {
      throw new PicklistError(
        'http',
        `${quoteName(clean.name)} was deleted since you opened it. Reload to see the current configurations.`,
        404
      );
    }
    if (isRefused(error)) {
      throw new PicklistError(
        'http',
        'You don’t have permission to change REST Picklist configurations.',
        status
      );
    }
    throw new PicklistError(
      'network',
      `Couldn’t save ${quoteName(clean.name)}. Try again in a moment.`,
      status
    );
  } finally {
    // Cleared even when saving fails, so the next read shows what's really stored.
    clearListCache(sdk, options);
  }
}

async function removeSecretDocument(manager: DocumentManager, id: string): Promise<void> {
  try {
    await manager.deleteDocument(SECRETS_COLLECTION, id, COLLECTION_SCOPE);
  } catch (error) {
    // Already gone, or never set.
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

/** Deletes the configuration, then its secret. */
export async function deleteConfiguration(
  doc: Pick<ConfigurationDocument, 'id' | 'name'>,
  options: ConfigurationStoreOptions = {}
): Promise<void> {
  const sdk = options.sdk ?? devOpsSdk;
  checkId(doc.id);
  const failure = (error: unknown): PicklistError => {
    const status = errorStatus(error);
    return isRefused(error)
      ? new PicklistError(
          'http',
          `You don’t have permission to delete ${quoteName(doc.name)}.`,
          status
        )
      : new PicklistError(
          'network',
          `Couldn’t delete ${quoteName(doc.name)}. Try again in a moment.`,
          status
        );
  };
  const manager = await getDocumentManager(sdk).catch((error: unknown) => {
    throw failure(error);
  });
  try {
    await manager.deleteDocument(CONFIGURATIONS_COLLECTION, doc.id, COLLECTION_SCOPE);
  } catch (error) {
    // Someone deleted it already; its secret may still be there.
    if (!isNotFound(error)) {
      throw failure(error);
    }
  } finally {
    clearListCache(sdk, options);
  }
  try {
    await removeSecretDocument(manager, doc.id);
  } catch (error) {
    throw new PicklistError(
      'network',
      `${quoteName(doc.name)} was deleted, but its secret couldn’t be removed. Try removing it again.`,
      errorStatus(error)
    );
  }
}

/**
 * The secret of a configuration, checked; null when none is stored or it isn't valid. For the
 * form control and the setup page's test only: keep it in memory, never show or cache it.
 */
export async function loadSecret(
  id: string,
  options: ConfigurationStoreOptions = {}
): Promise<SecretDocument | null> {
  if (!isConfigurationId(id)) {
    return null;
  }
  let data: unknown;
  try {
    const manager = await getDocumentManager(options.sdk ?? devOpsSdk);
    data = await manager.getDocument(SECRETS_COLLECTION, id, COLLECTION_SCOPE);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    const status = errorStatus(error);
    throw isRefused(error)
      ? new PicklistError(
          'http',
          'You don’t have permission to read this configuration’s secret.',
          status
        )
      : new PicklistError(
          'network',
          'Couldn’t read this configuration’s secret. Try again in a moment.',
          status
        );
  }
  if (data === null || data === undefined) {
    return null;
  }
  const secret = parseSecretDocument(data);
  if (!secret || secret.id !== id) {
    console.warn(
      'REST Picklist: ignored the secret of configuration',
      JSON.stringify(id),
      'because it isn’t valid.'
    );
    return null;
  }
  return secret;
}

function secretError(error: unknown, refused: string, failed: string): PicklistError {
  const status = errorStatus(error);
  return isRefused(error)
    ? new PicklistError('http', refused, status)
    : new PicklistError('network', failed, status);
}

/**
 * Stores a configuration's secret, replacing any earlier one (the last write wins), bound to the
 * origin it may be sent to. Update the configuration's summary too (summarizeSecret).
 */
export async function saveSecret(
  id: string,
  secret: StoredSecret,
  boundOrigin: string,
  options: ConfigurationStoreOptions & {
    /** OAuth 2.0: the API's origin, where the secret's tokens may go (SecretDocument.apiOrigin). */
    apiOrigin?: string;
  } = {}
): Promise<SecretDocument> {
  const sdk = options.sdk ?? devOpsSdk;
  checkId(id);
  const checked = parseStoredSecret(secret);
  if (!checked) {
    throw new PicklistError(
      'config',
      'This secret can’t be saved: it’s empty, too long or not in a format REST Picklist knows.'
    );
  }
  const origin = parseOrigin(boundOrigin);
  const apiOrigin = options.apiOrigin === undefined ? undefined : parseOrigin(options.apiOrigin);
  if (!origin || apiOrigin === null) {
    throw new PicklistError(
      'config',
      'A secret can only be saved for an HTTPS address (or localhost for testing).'
    );
  }
  const document: SecretDocument = { id, version: 1, secret: checked, boundOrigin: origin };
  if (apiOrigin) {
    document.apiOrigin = apiOrigin;
  }
  const user = currentUser(sdk);
  if (user) {
    document.updatedBy = user;
  }
  document.updatedAt = new Date().toISOString();
  try {
    const manager = await getDocumentManager(sdk);
    // -1 tells the service the last write wins: a secret is only ever replaced as a whole.
    const result = await manager.setDocument(
      SECRETS_COLLECTION,
      { ...document, __etag: -1 },
      COLLECTION_SCOPE
    );
    const saved = parseSecretDocument(result);
    return saved && saved.id === id ? saved : document;
  } catch (error) {
    throw secretError(
      error,
      'You don’t have permission to change this configuration’s secret.',
      'Couldn’t save the secret. Try again in a moment.'
    );
  }
}

/** Removes a configuration's secret; nothing happens when none is stored. */
export async function deleteSecret(
  id: string,
  options: ConfigurationStoreOptions = {}
): Promise<void> {
  checkId(id);
  try {
    await removeSecretDocument(await getDocumentManager(options.sdk ?? devOpsSdk), id);
  } catch (error) {
    throw secretError(
      error,
      'You don’t have permission to remove this configuration’s secret.',
      'Couldn’t remove the secret. Try again in a moment.'
    );
  }
}

/**
 * Copies a configuration's secret to another configuration (for a duplicate) without anyone
 * seeing it. It stays bound to the same origin. Returns false when there was none to copy.
 */
export async function copySecret(
  fromId: string,
  toId: string,
  options: ConfigurationStoreOptions = {}
): Promise<boolean> {
  checkId(toId);
  const source = await loadSecret(fromId, options);
  if (!source) {
    return false;
  }
  try {
    const manager = await getDocumentManager(options.sdk ?? devOpsSdk);
    await manager.setDocument(
      SECRETS_COLLECTION,
      { ...source, id: toId, __etag: -1 },
      COLLECTION_SCOPE
    );
    return true;
  } catch (error) {
    throw secretError(
      error,
      'You don’t have permission to change this configuration’s secret.',
      'Couldn’t copy the secret. Try again in a moment.'
    );
  }
}

/**
 * The configuration named `name` (or formerly named so) that's shared with the process of
 * `projectName`, for the form control. The project's process and the configuration list are
 * kept for five minutes in this tab; a name that isn't in the kept list is looked up again.
 */
export async function resolveConfiguration(
  api: DevOpsApi,
  projectName: string,
  name: string,
  options: ConfigurationStoreOptions = {}
): Promise<ResolvedConfiguration> {
  if (!nameKey(name)) {
    throw new PicklistError('config', 'Enter the name of a configuration.');
  }
  if (!projectName.trim()) {
    throw new PicklistError(
      'config',
      `Couldn’t tell which project this work item is in, so the configuration ${quoteName(name)} can’t be used.`
    );
  }
  const sdk = options.sdk ?? devOpsSdk;
  const store = storeOf(options);
  const process = await processForProject(api, projectName, store);
  if (!process) {
    throw new PicklistError(
      'config',
      `Couldn’t find the process of project ${quoteName(projectName)}, so the configuration ${quoteName(name)} can’t be used.`
    );
  }
  const list = await readList(sdk, store, options.fresh === true);
  let doc: ConfigurationDocument;
  try {
    doc = findConfigurationForProcess(list.docs, process.id, process.name, name);
  } catch (error) {
    if (!list.cached) {
      throw error;
    }
    // It may have been created, renamed or shared since the list was kept: ask again.
    const fresh = await readList(sdk, store, true);
    doc = findConfigurationForProcess(fresh.docs, process.id, process.name, name);
  }
  return {
    id: doc.id,
    name: doc.name,
    processId: process.id,
    processName: process.name,
    settings: { ...doc.settings },
    secret: doc.secret ? { ...doc.secret } : null,
  };
}
