import type { DatasetSize, NetworkMode } from './mockApi';
import type { ThemeName } from './themes';

/**
 * Where the control's API settings come from: a configuration it names (signing in with an API
 * key, or with OAuth 2.0), the settings on its own Options tab as before 4.0, or nowhere.
 */
export type SettingsSource = 'configuration' | 'oauth' | 'legacy' | 'moved';

export const SETTINGS_SOURCES: readonly SettingsSource[] = [
  'configuration',
  'oauth',
  'legacy',
  'moved',
];

/** Everything the toolbar can change. Kept in the URL so a scenario can be shared or bookmarked. */
export interface Scenario {
  theme: ThemeName;
  load: 'open' | 'form';
  network: NetworkMode;
  size: DatasetSize;
  source: SettingsSource;
  /** The configuration signs in, but its secret was never entered. */
  secretMissing: boolean;
  /**
   * The configuration name in the control's Options; null for the one shared with the process.
   * For example "Customer list" (its former name) or "Contacts" (no such configuration).
   */
  configurationName: string | null;
  /** The “Allow multiple values” setting; the field becomes a multi-line text field. */
  multiple: boolean;
  /** Multiple values in a single-line text field, which holds 255 characters. */
  singleLine: boolean;
  /** Each customer's email as the second line. */
  secondLine: boolean;
  /** The service returns pages linked with "@odata.nextLink". */
  paging: boolean;
  /** The organization's policy doesn't allow the mock service's host. */
  policyBlocks: boolean;
  required: boolean;
  ruleRequired: boolean;
  readOnly: boolean;
  phone: boolean;
  empty: boolean;
  /** Overrides the field's starting text, for example "Zava" or "Contoso; Fabrikam". */
  value: string | null;
  /** Only the form card, at a fixed width, for screenshots and recordings. */
  clean: boolean;
}

type FlagName = {
  [K in keyof Scenario]: Scenario[K] extends boolean ? K : never;
}[keyof Scenario];

/** The URL parameter of each switch: `?multi=1&secondline=1` turns both on. */
export const FLAG_PARAMS: ReadonlyArray<readonly [FlagName, string]> = [
  ['secretMissing', 'nosecret'],
  ['multiple', 'multi'],
  ['singleLine', 'singleline'],
  ['secondLine', 'secondline'],
  ['paging', 'paging'],
  ['policyBlocks', 'policy'],
  ['required', 'required'],
  ['ruleRequired', 'rule'],
  ['readOnly', 'readonly'],
  ['phone', 'phone'],
  ['empty', 'empty'],
  ['clean', 'clean'],
];

export const DEFAULT_SCENARIO: Scenario = {
  theme: 'light',
  load: 'open',
  network: 'fast',
  size: 'small',
  source: 'configuration',
  secretMissing: false,
  configurationName: null,
  multiple: false,
  singleLine: false,
  secondLine: false,
  paging: false,
  policyBlocks: false,
  required: false,
  ruleRequired: false,
  readOnly: false,
  phone: false,
  empty: false,
  value: null,
  clean: false,
};

function pick<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = params.get(key);
  return allowed.find((option) => option === value) ?? fallback;
}

/** True when the control names a configuration, so it has one to sign in with. */
export function usesConfiguration(scenario: Pick<Scenario, 'source'>): boolean {
  return scenario.source === 'configuration' || scenario.source === 'oauth';
}

export function readScenario(search: string): Scenario {
  const params = new URLSearchParams(search);
  const scenario: Scenario = {
    ...DEFAULT_SCENARIO,
    theme: pick(params, 'theme', ['light', 'dark', 'contrast'], DEFAULT_SCENARIO.theme),
    load: pick(params, 'load', ['open', 'form'], DEFAULT_SCENARIO.load),
    network: pick(params, 'network', ['fast', 'slow', 'failing'], DEFAULT_SCENARIO.network),
    size: pick(params, 'size', ['small', 'large'], DEFAULT_SCENARIO.size),
    source: pick(params, 'source', SETTINGS_SOURCES, DEFAULT_SCENARIO.source),
    configurationName: params.get('name'),
    value: params.get('value'),
  };
  for (const [name, param] of FLAG_PARAMS) {
    const raw = params.get(param);
    scenario[name] = raw === '1' || raw === 'true';
  }
  return scenario;
}

/** The query string for a scenario; only settings that differ from the defaults are written. */
export function scenarioSearch(scenario: Scenario): string {
  const params = new URLSearchParams();
  for (const key of ['theme', 'load', 'network', 'size', 'source'] as const) {
    if (scenario[key] !== DEFAULT_SCENARIO[key]) {
      params.set(key, scenario[key]);
    }
  }
  for (const [name, param] of FLAG_PARAMS) {
    if (scenario[name]) {
      params.set(param, '1');
    }
  }
  if (scenario.configurationName !== null) {
    params.set('name', scenario.configurationName);
  }
  if (scenario.value !== null) {
    params.set('value', scenario.value);
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}

/**
 * The settings that need a new work item and control when they change. The theme and the view
 * don't, so switching them keeps what was picked.
 */
export function sessionKey(scenario: Scenario): string {
  return JSON.stringify({ ...scenario, theme: null, phone: null, clean: null });
}
