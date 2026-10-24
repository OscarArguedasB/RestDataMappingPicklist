import { PicklistError } from '../core/errors';
import type { SecurityPolicy } from '../core/policy';
import { DEFAULT_POLICY, POLICY_VERSION, parsePolicy } from '../core/policy';
import { isPlainObject } from '../core/values';
import type { SessionStore } from './extensionData';
import {
  COLLECTION_SCOPE,
  cacheKey,
  clearSessionCache,
  defaultSessionStore,
  getExtensionDataManager,
  readSessionCache,
  writeSessionCache,
} from './extensionData';
import type { DevOpsSdk } from './rest';
import { devOpsSdk } from './rest';

/** Extension data key (organization scope) that holds the security policy. */
export const POLICY_KEY = 'securityPolicy';

export interface PolicyStoreOptions {
  sdk?: DevOpsSdk;
  /** Defaults to sessionStorage; null turns the cache off. */
  storage?: SessionStore | null;
}

export interface LoadPolicyOptions extends PolicyStoreOptions {
  /** Skip the five-minute cache, for the settings page. */
  fresh?: boolean;
  /**
   * Throw when the policy can't be read instead of using the defaults. The settings page needs
   * this: showing the defaults there would invite an administrator to save over the real policy.
   */
  strict?: boolean;
}

function storeOf(options: PolicyStoreOptions): SessionStore | null {
  return options.storage === undefined ? defaultSessionStore() : options.storage;
}

/**
 * Null when the organization is unknown: then nothing is cached rather than risk mixing them up.
 * The key names the policy version, because a copy cached by 3.0 in the same tab is a version 1
 * policy that would gain OAuth 2.0 when read, even after an administrator turned it off.
 */
function policyCacheKey(sdk: DevOpsSdk): string | null {
  try {
    const { id } = sdk.getHost();
    return typeof id === 'string' && id ? cacheKey('policy', String(POLICY_VERSION), id) : null;
  } catch {
    return null;
  }
}

function validateCached(data: unknown): SecurityPolicy | null {
  return isPlainObject(data) ? parsePolicy(data) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : '';
}

function errorStatus(error: unknown): number | undefined {
  if (!isPlainObject(error)) {
    return undefined;
  }
  const status = error.status ?? error.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The organization's security policy. Missing: the built-in defaults. If it can't be read, the
 * built-in defaults apply too (with a console warning), so a storage outage never breaks forms.
 */
export async function loadPolicy(options: LoadPolicyOptions = {}): Promise<SecurityPolicy> {
  const sdk = options.sdk ?? devOpsSdk;
  const store = storeOf(options);
  const key = policyCacheKey(sdk);
  if (key && !options.fresh) {
    const cached = readSessionCache(store, key, validateCached);
    if (cached) {
      return cached;
    }
  }
  try {
    const manager = await getExtensionDataManager(sdk);
    const stored = await manager.getValue(POLICY_KEY, {
      ...COLLECTION_SCOPE,
      defaultValue: null,
    });
    const policy = stored === null || stored === undefined ? DEFAULT_POLICY : parsePolicy(stored);
    if (key) {
      writeSessionCache(store, key, policy);
    }
    return policy;
  } catch (error) {
    if (options.strict) {
      const status = errorStatus(error);
      throw new PicklistError(
        'network',
        status === 401 || status === 403
          ? 'You don’t have permission to read the organization’s security policy.'
          : 'Couldn’t read the organization’s security policy. Try again before changing it, so the saved policy isn’t replaced by the defaults.',
        status
      );
    }
    console.warn(
      'REST Picklist: couldn’t read the organization’s security policy, so the built-in rules apply.',
      errorText(error)
    );
    return DEFAULT_POLICY;
  }
}

/** Saves the policy for the whole organization, noting who changed it and when. */
export async function savePolicy(
  policy: SecurityPolicy,
  options: PolicyStoreOptions = {}
): Promise<SecurityPolicy> {
  const sdk = options.sdk ?? devOpsSdk;
  let changedBy: string | undefined;
  try {
    const user = sdk.getUser();
    changedBy = user.displayName || user.name || undefined;
  } catch {
    changedBy = undefined;
  }
  // parsePolicy keeps only known settings, so nothing unexpected is stored. Saving as version 2
  // keeps the sign-in methods exactly as chosen: version 1 lists may gain OAuth 2.0 when read.
  const stamped = parsePolicy({
    ...policy,
    version: POLICY_VERSION,
    changedBy,
    changedAt: new Date().toISOString(),
  });
  try {
    const manager = await getExtensionDataManager(sdk);
    await manager.setValue(POLICY_KEY, stamped, COLLECTION_SCOPE);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      throw new PicklistError(
        'http',
        'You don’t have permission to change the security policy.',
        status
      );
    }
    throw new PicklistError('network', 'Couldn’t save the security policy. Try again in a moment.');
  } finally {
    const key = policyCacheKey(sdk);
    if (key) {
      clearSessionCache(storeOf(options), key);
    }
  }
  return stamped;
}
