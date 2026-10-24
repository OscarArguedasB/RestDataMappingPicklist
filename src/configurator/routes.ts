import { isConfigurationId } from '../core/configurations';

// Where the setup page is, kept in the URL hash so a reload (or a shared link) opens the same tab
// or configuration. Inside Azure DevOps the hash belongs to the host page (see services.ts).

export type TabId = 'configurations' | 'policy';

/** The configuration editor: an existing configuration, or a new one for a process. */
export type EditorRoute = { kind: 'edit'; id: string } | { kind: 'new'; processId: string };

export interface Route {
  tab: TabId;
  /** Only on the Configurations tab: the editor replaces the list. */
  editor: EditorRoute | null;
}

export const DEFAULT_ROUTE: Route = { tab: 'configurations', editor: null };

const PROCESS_ID = /^[A-Za-z0-9_-]{1,64}$/;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return '';
  }
}

/**
 * Reads #configurations, #policy, #edit=<configuration id> and #new=<process id>. The 3.0 tabs
 * (#build, #saved) open Configurations, which replaced them. Null for anything else.
 */
export function routeFromHash(hash: string): Route | null {
  const text = hash.replace(/^#/, '').trim();
  const separator = text.indexOf('=');
  const key = (separator < 0 ? text : text.slice(0, separator)).toLowerCase();
  const value = separator < 0 ? null : decoded(text.slice(separator + 1)).trim();
  switch (key) {
    case 'configurations':
    case 'build':
    case 'saved':
      return value === null ? DEFAULT_ROUTE : null;
    case 'policy':
      return value === null ? { tab: 'policy', editor: null } : null;
    case 'edit':
      return value !== null && isConfigurationId(value)
        ? { tab: 'configurations', editor: { kind: 'edit', id: value } }
        : null;
    case 'new':
      return value !== null && PROCESS_ID.test(value)
        ? { tab: 'configurations', editor: { kind: 'new', processId: value } }
        : null;
    default:
      return null;
  }
}

/** The hash for a route, without the “#”. */
export function hashForRoute(route: Route): string {
  if (route.tab === 'policy') {
    return 'policy';
  }
  if (!route.editor) {
    return 'configurations';
  }
  return route.editor.kind === 'edit'
    ? `edit=${encodeURIComponent(route.editor.id)}`
    : `new=${encodeURIComponent(route.editor.processId)}`;
}

/** Tells editor routes apart: the same key is the same editing session. */
export function editorKey(editor: EditorRoute): string {
  return editor.kind === 'edit' ? `edit:${editor.id}` : `new:${editor.processId}`;
}
