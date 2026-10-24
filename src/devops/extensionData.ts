import { isPlainObject } from '../core/values';
import type { DevOpsSdk } from './rest';

// Where the extension keeps data: Azure DevOps extension data (shared by the organization) and a
// short-lived cache in this browser tab.

export const EXTENSION_DATA_SERVICE_ID = 'ms.vss-features.extension-data-service';

/** Declared locally, like formService.ts, so the extension doesn't ship azure-devops-extension-api. */
export interface DocumentOptions {
  /** "Default" is the organization (project collection); "User" is the signed-in user. */
  scopeType?: 'Default' | 'User';
  scopeValue?: string;
  /** Returned by getValue when nothing is stored under the key. */
  defaultValue?: unknown;
}

/**
 * Values are `unknown`: anyone in the organization can write extension data, so check them. The
 * document methods are optional here only so that settings-only callers (and their tests) can
 * use a smaller object; the host's manager always has them, and getDocumentManager requires them.
 */
export interface ExtensionDataManager {
  getValue(key: string, options?: DocumentOptions): Promise<unknown>;
  setValue(key: string, value: unknown, options?: DocumentOptions): Promise<unknown>;
  /** Rejects (404) when the collection or the document doesn't exist. */
  getDocument?(collectionName: string, id: string, options?: DocumentOptions): Promise<unknown>;
  /** Rejects (404) when the collection doesn't exist yet. */
  getDocuments?(collectionName: string, options?: DocumentOptions): Promise<unknown>;
  /** Fails when a document with the same id exists. Creates the collection when needed. */
  createDocument?(
    collectionName: string,
    doc: unknown,
    options?: DocumentOptions
  ): Promise<unknown>;
  /** Creates or replaces. An `__etag` of -1 means the last write wins. */
  setDocument?(collectionName: string, doc: unknown, options?: DocumentOptions): Promise<unknown>;
  /** Fails when the document doesn't exist, or its `__etag` isn't the stored one. */
  updateDocument?(
    collectionName: string,
    doc: unknown,
    options?: DocumentOptions
  ): Promise<unknown>;
  /** Rejects (404) when the collection or the document doesn't exist. */
  deleteDocument?(collectionName: string, id: string, options?: DocumentOptions): Promise<unknown>;
}

/** A manager with every document method, as the host provides it. */
export type DocumentManager = Required<ExtensionDataManager>;

export interface ExtensionDataService {
  getExtensionDataManager(extensionId: string, accessToken: string): Promise<ExtensionDataManager>;
}

export const COLLECTION_SCOPE: DocumentOptions = { scopeType: 'Default' };

function isExtensionDataService(value: unknown): value is ExtensionDataService {
  return isPlainObject(value) && typeof value.getExtensionDataManager === 'function';
}

function isExtensionDataManager(value: unknown): value is ExtensionDataManager {
  return (
    isPlainObject(value) &&
    typeof value.getValue === 'function' &&
    typeof value.setValue === 'function'
  );
}

/** A manager for this extension's data. Made per use because the token inside it expires. */
export async function getExtensionDataManager(sdk: DevOpsSdk): Promise<ExtensionDataManager> {
  const [service, token] = await Promise.all([
    sdk.getService(EXTENSION_DATA_SERVICE_ID),
    sdk.getAccessToken(),
  ]);
  if (!isExtensionDataService(service)) {
    throw new Error('The extension data service isn’t available.');
  }
  const manager: unknown = await service.getExtensionDataManager(
    sdk.getExtensionContext().id,
    token
  );
  if (!isExtensionDataManager(manager)) {
    throw new Error('The extension data service isn’t available.');
  }
  return manager;
}

const DOCUMENT_METHODS = [
  'getDocument',
  'getDocuments',
  'createDocument',
  'setDocument',
  'updateDocument',
  'deleteDocument',
] as const;

export function hasDocumentMethods(manager: ExtensionDataManager): manager is DocumentManager {
  return DOCUMENT_METHODS.every((method) => typeof manager[method] === 'function');
}

/** Like getExtensionDataManager, for document collections. */
export async function getDocumentManager(sdk: DevOpsSdk): Promise<DocumentManager> {
  const manager = await getExtensionDataManager(sdk);
  if (!hasDocumentMethods(manager)) {
    throw new Error('The extension data service isn’t available.');
  }
  return manager;
}

export type SessionStore = Pick<Storage, 'getItem' | 'setItem'> &
  Partial<Pick<Storage, 'removeItem'>>;

export const SESSION_CACHE_TTL_MS = 5 * 60_000;
const CACHE_PREFIX = 'rest-picklist:v1:';
// Keeps one entry from crowding out everything else in the tab's storage.
const MAX_ENTRY_LENGTH = 1_000_000;

/**
 * sessionStorage when the browser allows it. Reading the property itself throws when storage is
 * blocked (for example third-party storage in the extension's iframe), so it's guarded.
 */
export function defaultSessionStore(): SessionStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The extension's iframe has the same origin in every organization, so keys must name the
 * organization: otherwise one organization's cached data could be used in another.
 */
export function cacheKey(...parts: string[]): string {
  return CACHE_PREFIX + parts.map((part) => encodeURIComponent(part)).join(':');
}

/**
 * Reads a cached value. Anything expired, malformed or rejected by `validate` counts as a miss:
 * the tab's storage can be edited by anyone who can run script on the extension's origin.
 */
export function readSessionCache<T>(
  store: SessionStore | null | undefined,
  key: string,
  validate: (data: unknown) => T | null,
  ttlMs: number = SESSION_CACHE_TTL_MS
): T | null {
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(key);
    if (!raw) {
      return null;
    }
    const entry: unknown = JSON.parse(raw);
    const now = Date.now();
    if (
      !isPlainObject(entry) ||
      typeof entry.expires !== 'number' ||
      entry.expires <= now ||
      // An expiry further away than the lifetime was not written by this code.
      entry.expires > now + ttlMs
    ) {
      return null;
    }
    return validate(entry.data);
  } catch {
    return null;
  }
}

export function writeSessionCache(
  store: SessionStore | null | undefined,
  key: string,
  data: unknown,
  ttlMs: number = SESSION_CACHE_TTL_MS
): void {
  if (!store) {
    return;
  }
  try {
    const raw = JSON.stringify({ expires: Date.now() + ttlMs, data });
    if (raw.length <= MAX_ENTRY_LENGTH) {
      store.setItem(key, raw);
    }
  } catch {
    // Storage full or blocked: the next read asks Azure DevOps again.
  }
}

export function clearSessionCache(store: SessionStore | null | undefined, key: string): void {
  if (!store) {
    return;
  }
  try {
    if (store.removeItem) {
      store.removeItem(key);
    } else {
      store.setItem(key, '');
    }
  } catch {
    // Nothing to do: an entry that can't be removed still expires.
  }
}
