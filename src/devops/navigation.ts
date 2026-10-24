import * as SDK from 'azure-devops-extension-sdk';
import { isPlainObject } from '../core/values';

// The REST Picklist settings page is the extension's setup hub, under Organization settings ›
// Extensions. Form controls link there when what they need is managed on that page. The form
// control loads this module lazily, only when it shows such a link.

/** The setup hub's contribution id (see azure-devops-extension.json). */
export const SETTINGS_HUB_CONTRIBUTION = 'rest-picklist-setup';

export const HOST_NAVIGATION_SERVICE_ID = 'ms.vss-features.host-navigation-service';

/** The part of azure-devops-extension-api's IHostNavigationService used here. */
export interface HostNavigationService {
  openNewWindow(url: string, features: string): void;
}

/** What openSettingsPage uses; tests pass their own. */
export interface OpenSettingsPageOptions {
  getService?: (contributionId: string) => Promise<unknown>;
  open?: (url: string, target: string, features: string) => unknown;
}

function isHostNavigationService(value: unknown): value is HostNavigationService {
  return isPlainObject(value) && typeof value.openNewWindow === 'function';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The address of the REST Picklist settings page:
 * `{organization}_settings/{publisher}.{extension}.rest-picklist-setup`, where the organization's
 * address comes from the location service (https://dev.azure.com/contoso/, or
 * https://contoso.visualstudio.com/ for older organizations). Null when that isn't an HTTPS
 * address or the extension's ids are missing.
 */
export function settingsPageUrl(
  collectionUrl: string,
  extension: { publisherId: string; extensionId: string }
): string | null {
  let base: URL;
  try {
    base = new URL(text(collectionUrl));
  } catch {
    return null;
  }
  const publisherId = text(extension.publisherId);
  const extensionId = text(extension.extensionId);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    !publisherId ||
    !extensionId
  ) {
    return null;
  }
  const path = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const page = [publisherId, extensionId, SETTINGS_HUB_CONTRIBUTION].map(encodeURIComponent);
  return `${base.origin}${path}_settings/${page.join('.')}`;
}

/**
 * Opens the settings page in a new tab. Azure DevOps opens it through its navigation service,
 * because the control's frame may not be allowed to open windows; when that service isn't there,
 * the frame opens it itself, without giving the new tab access back to this one.
 */
export async function openSettingsPage(
  url: string,
  options: OpenSettingsPageOptions = {}
): Promise<void> {
  if (!isHttps(url)) {
    return;
  }
  const getService =
    options.getService ?? ((contributionId: string) => SDK.getService<unknown>(contributionId));
  try {
    const service = await getService(HOST_NAVIGATION_SERVICE_ID);
    if (isHostNavigationService(service)) {
      service.openNewWindow(url, '');
      return;
    }
  } catch {
    // Opened from this frame below instead.
  }
  const open =
    options.open ??
    ((target: string, name: string, features: string) => window.open(target, name, features));
  open(url, '_blank', 'noopener,noreferrer');
}
