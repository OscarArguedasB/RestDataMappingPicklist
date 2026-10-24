import type { FieldMap } from './fieldMap';
import { parseFieldMap } from './fieldMap';
import type { SecretKind } from './secrets';
import { parseOrigin } from './secrets';
import { isPlainObject, scalarToString } from './values';

/**
 * Input ids of the control's Options tab, current and from before 4.0. Changing one breaks
 * existing forms. Since 4.0 the Options tab only has the field and the configuration name; the
 * other ids name the settings a configuration keeps, and are still read from older controls.
 */
export const INPUT_IDS = {
  fieldName: 'FieldName',
  /** 4.0: the name of a configuration from Organization settings › Extensions › REST Picklist. */
  configuration: 'Configuration',
  savedConfiguration: 'SavedConfiguration',
  url: 'RestServiceAddress',
  params: 'RestCallParameters',
  authMethod: 'AuthMethod',
  username: 'RestServiceUserName',
  password: 'RestServicePassword',
  arrayPath: 'PathToArray',
  keyField: 'RestServiceKeyField',
  secondLine: 'SecondLineProperty',
  fieldMap: 'FieldMap',
  allowMultiple: 'AllowMultiple',
  loadOnFormOpen: 'LoadOnFormOpen',
  required: 'Required',
  notFoundMessage: 'ErrorMessage',
  advanced: 'AdvancedSettings',
  /** 4.0: OAuth 2.0 settings (JSON). Never an Options tab input; only kept in configurations. */
  oauth: 'OAuthSettings',
  saveConfiguration: 'SaveConfiguration',
  savedConfigurationName: 'SavedConfigurationName',
} as const;

/**
 * The settings a 4.0 configuration keeps, by the ids the Options tab used before 4.0, so files
 * exported by 3.0 still import. Never credentials: those are stored apart (see secrets.ts).
 */
export const CONFIGURATION_SETTING_IDS = [
  INPUT_IDS.url,
  INPUT_IDS.params,
  INPUT_IDS.authMethod,
  INPUT_IDS.username,
  INPUT_IDS.arrayPath,
  INPUT_IDS.keyField,
  INPUT_IDS.secondLine,
  INPUT_IDS.fieldMap,
  INPUT_IDS.allowMultiple,
  INPUT_IDS.loadOnFormOpen,
  INPUT_IDS.required,
  INPUT_IDS.notFoundMessage,
  INPUT_IDS.advanced,
  INPUT_IDS.oauth,
] as const;

const FLAG_SETTING_IDS: ReadonlySet<string> = new Set([
  INPUT_IDS.allowMultiple,
  INPUT_IDS.loadOnFormOpen,
  INPUT_IDS.required,
]);

/**
 * A configuration's settings taken from inputs, leaving out empty ones: text as entered, and
 * checkboxes as "true" when on.
 */
export function pickConfigurationSettings(inputs: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const id of CONFIGURATION_SETTING_IDS) {
    if (FLAG_SETTING_IDS.has(id)) {
      if (flag(inputs[id])) {
        picked[id] = 'true';
      }
      continue;
    }
    const value = text(inputs[id]);
    if (value.trim()) {
      picked[id] = value;
    }
  }
  return picked;
}

/**
 * The Options tab inputs from before 4.0. Since 4.0 a control only stores the field and the
 * configuration name (and OAuth 2.0 settings are never an Options tab input).
 */
const LEGACY_INPUT_IDS: readonly string[] = Object.values(INPUT_IDS).filter(
  (id) => id !== INPUT_IDS.fieldName && id !== INPUT_IDS.configuration && id !== INPUT_IDS.oauth
);

/**
 * True when a control still keeps its settings on its Options tab, as before 4.0: any input a
 * 3.0 control stored, even an empty one. A 3.0 control without an endpoint offers the values the
 * process allows, and keeps doing so. A control that stores nothing but its field can't be told
 * apart from a new 4.0 control, so it's treated as one.
 */
export function hasLegacySettings(inputs: Record<string, unknown> | undefined): boolean {
  if (!inputs) {
    return false;
  }
  return LEGACY_INPUT_IDS.some(
    (id) => Object.hasOwn(inputs, id) && inputs[id] !== undefined && inputs[id] !== null
  );
}

/**
 * The settings a saved configuration carries. Credentials, the field and per-control behavior
 * (multiple values, load on open, required) always come from the control that uses it.
 */
export const SAVED_INPUT_IDS = [
  INPUT_IDS.url,
  INPUT_IDS.params,
  INPUT_IDS.authMethod,
  INPUT_IDS.arrayPath,
  INPUT_IDS.keyField,
  INPUT_IDS.secondLine,
  INPUT_IDS.fieldMap,
  INPUT_IDS.notFoundMessage,
  INPUT_IDS.advanced,
] as const;

export type AuthMethod = 'none' | 'basic' | 'bearer' | 'apiKey' | 'oauth2';
export const AUTH_METHODS: readonly AuthMethod[] = ['none', 'basic', 'bearer', 'apiKey', 'oauth2'];
export const AUTH_METHOD_LABELS: Record<AuthMethod, string> = {
  none: 'None',
  basic: 'Basic',
  bearer: 'Bearer token',
  apiKey: 'API key',
  oauth2: 'OAuth 2.0',
};

/**
 * How an OAuth 2.0 client proves who it is to the token URL: its secret in a Basic Authorization
 * header (client_secret_basic), its secret in the request body (client_secret_post), or a JWT
 * signed with its private key (private_key_jwt).
 */
export type ClientAuthentication = 'basic' | 'body' | 'privateKeyJwt';
export const CLIENT_AUTHENTICATION_LABELS: Record<ClientAuthentication, string> = {
  basic: 'Send as Basic Auth header',
  body: 'Send client credentials in body',
  privateKeyJwt: 'Signed JWT (private key or certificate)',
};

/** OAuth 2.0 client credentials settings, kept as JSON in the OAuthSettings setting. */
export interface OAuthSettings {
  /** Where the access token comes from. Required. */
  tokenUrl: string;
  /** Required. */
  clientId: string;
  /** Space-separated. Not sent when empty. */
  scope: string;
  /** Sent when not empty, for services such as Auth0. */
  audience: string;
  /** Sent when not empty, for services such as AD FS. */
  resource: string;
  clientAuthentication: ClientAuthentication;
  /** The signed JWT's "aud" claim. Empty: the token URL without its query string. */
  assertionAudience: string;
  /** More form parameters for the token request, by name. */
  extraParams: Record<string, string>;
}

export const OAUTH_LIMITS = {
  maxExtraParams: 20,
  maxParamNameLength: 100,
} as const;

export const DEFAULT_OAUTH: OAuthSettings = {
  tokenUrl: '',
  clientId: '',
  scope: '',
  audience: '',
  resource: '',
  clientAuthentication: 'basic',
  assertionAudience: '',
  extraParams: {},
};

/** With multiple values, what other fields receive: every picked item's value, or the first. */
export type CopyMode = 'all' | 'first';

export type PagingConfig =
  | { type: 'none' }
  /** Follows a "next page" URL found at `nextLink` in the body, or in the Link header when empty. */
  | { type: 'nextLink'; nextLink: string; maxPages: number }
  | {
      type: 'page';
      pageParam: string;
      sizeParam: string;
      size: number;
      startPage: number;
      maxPages: number;
    }
  | { type: 'offset'; offsetParam: string; limitParam: string; limit: number; maxPages: number }
  | { type: 'cursor'; cursorPath: string; cursorParam: string; maxPages: number };

export type PagingType = PagingConfig['type'];

/** Settings kept in the "Advanced settings (JSON)" input. */
export interface AdvancedSettings {
  paging: PagingConfig;
  apiKeyHeader: string;
  copyMode: CopyMode;
  maxItems: number;
  timeoutSeconds: number;
}

export const LIMITS = {
  maxPages: { default: 10, min: 1, max: 100 },
  maxItems: { default: 10_000, min: 1, max: 50_000 },
  timeoutSeconds: { default: 30, min: 5, max: 120 },
  pageSize: { default: 100, min: 1, max: 10_000 },
} as const;

export const DEFAULT_API_KEY_HEADER = 'x-api-key';

export const DEFAULT_ADVANCED: AdvancedSettings = {
  paging: { type: 'none' },
  apiKeyHeader: DEFAULT_API_KEY_HEADER,
  copyMode: 'all',
  maxItems: LIMITS.maxItems.default,
  timeoutSeconds: LIMITS.timeoutSeconds.default,
};

/** The settings an administrator entered for one instance of the control. */
export interface PicklistConfig {
  fieldName: string;
  /** 4.0: name of the configuration (Organization settings › Extensions › REST Picklist). */
  configuration: string;
  /** Name of a saved configuration to use for the settings left empty here. */
  savedConfiguration: string;
  url: string;
  params: string;
  authMethod: AuthMethod;
  username: string;
  password: string;
  /** Empty: find the list in the response automatically. */
  arrayPath: string;
  /** Empty: pick the most name-like text property automatically. */
  keyField: string;
  /** Shown under each value, and searched too. */
  secondLineProperty: string;
  fieldMap: FieldMap | null;
  fieldMapError: string | null;
  allowMultiple: boolean;
  /** Checked: load items as soon as the form opens. Unchecked: wait until the list is opened. */
  loadOnFormOpen: boolean;
  /** Show the field as required (red outline) while it's empty. */
  required: boolean;
  notFoundMessage: string;
  advanced: AdvancedSettings;
  advancedError: string | null;
  authError: string | null;
  /** Used when the sign-in method is OAuth 2.0. */
  oauth: OAuthSettings;
  oauthError: string | null;
  saveConfiguration: boolean;
  savedConfigurationName: string;
}

function text(value: unknown): string {
  return scalarToString(value) ?? '';
}

function flag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function clamp(value: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

/**
 * Reads the sign-in method. It's typed free-form when the process editor shows a text box, so
 * common spellings are accepted. Older setups had no method: "Bearer" in the user name meant a
 * bearer token, and any other user name or password meant Basic.
 */
export function parseAuthMethod(
  explicit: string,
  username: string,
  password: string
): { method: AuthMethod; error: string | null } {
  const normalized = explicit
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  // "None" with credentials filled in is how an older control looks after the process editor
  // saves the dropdown's first choice, so it keeps the older automatic rules.
  const isNone = normalized === 'none' || normalized === 'public' || normalized === 'anonymous';
  if (!normalized || (isNone && (username.trim() || password))) {
    if (username.trim().toLowerCase() === 'bearer') {
      return { method: 'bearer', error: null };
    }
    return { method: username || password ? 'basic' : 'none', error: null };
  }
  switch (normalized) {
    case 'none':
    case 'public':
    case 'anonymous':
      return { method: 'none', error: null };
    case 'basic':
      return { method: 'basic', error: null };
    case 'bearer':
    case 'bearertoken':
    case 'token':
      return { method: 'bearer', error: null };
    case 'apikey':
    case 'key':
    case 'xapikey':
      return { method: 'apiKey', error: null };
    case 'oauth':
    case 'oauth2':
    case 'oauth2.0':
    case 'clientcredentials':
      return { method: 'oauth2', error: null };
    default:
      return {
        method: 'none',
        error: `“${explicit.trim()}” isn’t a sign-in method. Use None, Basic, Bearer token, API key or OAuth 2.0.`,
      };
  }
}

/**
 * The kind of secret a sign-in method needs, or null when it needs none. OAuth 2.0 needs a client
 * secret, or a private key when it signs a JWT.
 */
export function secretKindFor(
  method: AuthMethod,
  clientAuthentication: ClientAuthentication = DEFAULT_OAUTH.clientAuthentication
): SecretKind | null {
  switch (method) {
    case 'basic':
      return 'password';
    case 'bearer':
      return 'token';
    case 'apiKey':
      return 'apiKey';
    case 'oauth2':
      return clientAuthentication === 'privateKeyJwt' ? 'signingKey' : 'clientSecret';
    default:
      return null;
  }
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Headers the browser controls or that would change how the request is routed or cached.
const RESERVED_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function validateHeaderName(name: string): string | null {
  const trimmed = name.trim();
  if (!HEADER_NAME.test(trimmed)) {
    return `“${trimmed}” isn’t a valid header name.`;
  }
  const lower = trimmed.toLowerCase();
  if (RESERVED_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')) {
    return `The ${trimmed} header can’t be used for an API key.`;
  }
  return null;
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  limits: { default: number; min: number; max: number },
  problems: string[]
): number {
  const value = source[key];
  if (value === undefined) {
    return limits.default;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`“${key}” must be a number.`);
    return limits.default;
  }
  return clamp(value, limits);
}

function readString(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  problems: string[]
): string {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !value.trim()) {
    problems.push(`“${key}” must be text.`);
    return fallback;
  }
  return value.trim();
}

function parsePaging(value: unknown, problems: string[]): PagingConfig {
  if (value === undefined || value === null) {
    return { type: 'none' };
  }
  if (!isPlainObject(value)) {
    problems.push('“paging” must be an object, for example { "type": "nextLink" }.');
    return { type: 'none' };
  }
  const maxPages = readNumber(value, 'maxPages', LIMITS.maxPages, problems);
  switch (value.type) {
    case undefined:
    case 'none':
      return { type: 'none' };
    case 'nextLink':
      return {
        type: 'nextLink',
        nextLink: typeof value.nextLink === 'string' ? value.nextLink.trim() : '',
        maxPages,
      };
    case 'page':
      return {
        type: 'page',
        pageParam: readString(value, 'pageParam', 'page', problems),
        sizeParam: readString(value, 'sizeParam', 'pageSize', problems),
        size: readNumber(value, 'size', LIMITS.pageSize, problems),
        startPage: readNumber(value, 'startPage', { default: 1, min: 0, max: 1 }, problems),
        maxPages,
      };
    case 'offset':
      return {
        type: 'offset',
        offsetParam: readString(value, 'offsetParam', 'offset', problems),
        limitParam: readString(value, 'limitParam', 'limit', problems),
        limit: readNumber(value, 'limit', LIMITS.pageSize, problems),
        maxPages,
      };
    case 'cursor':
      if (typeof value.cursorPath !== 'string' || !value.cursorPath.trim()) {
        problems.push(
          'Cursor paging needs “cursorPath”: where the next cursor is in the response.'
        );
        return { type: 'none' };
      }
      return {
        type: 'cursor',
        cursorPath: value.cursorPath.trim(),
        cursorParam: readString(value, 'cursorParam', 'cursor', problems),
        maxPages,
      };
    default:
      problems.push('“paging.type” must be nextLink, page, offset or cursor.');
      return { type: 'none' };
  }
}

/** Parses the "Advanced settings (JSON)" input. Invalid parts fall back to their defaults. */
export function parseAdvancedSettings(raw: string | undefined): {
  settings: AdvancedSettings;
  error: string | null;
} {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { settings: DEFAULT_ADVANCED, error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { settings: DEFAULT_ADVANCED, error: 'Advanced settings aren’t valid JSON.' };
  }
  if (!isPlainObject(parsed)) {
    return { settings: DEFAULT_ADVANCED, error: 'Advanced settings must be a JSON object { … }.' };
  }
  const problems: string[] = [];
  let apiKeyHeader = DEFAULT_API_KEY_HEADER;
  if (parsed.apiKeyHeader !== undefined) {
    const headerError =
      typeof parsed.apiKeyHeader === 'string' ? validateHeaderName(parsed.apiKeyHeader) : null;
    if (typeof parsed.apiKeyHeader !== 'string' || headerError) {
      problems.push(headerError ?? '“apiKeyHeader” must be text.');
    } else {
      apiKeyHeader = parsed.apiKeyHeader.trim();
    }
  }
  let copyMode: CopyMode = 'all';
  if (parsed.copyMode !== undefined) {
    if (parsed.copyMode === 'all' || parsed.copyMode === 'first') {
      copyMode = parsed.copyMode;
    } else {
      problems.push('“copyMode” must be "all" or "first".');
    }
  }
  const settings: AdvancedSettings = {
    paging: parsePaging(parsed.paging, problems),
    apiKeyHeader,
    copyMode,
    maxItems: readNumber(parsed, 'maxItems', LIMITS.maxItems, problems),
    timeoutSeconds: readNumber(parsed, 'timeoutSeconds', LIMITS.timeoutSeconds, problems),
  };
  return {
    settings,
    error: problems.length > 0 ? `Advanced settings: ${problems.join(' ')}` : null,
  };
}

/** Writes advanced settings as compact JSON, leaving out defaults. Empty when nothing is set. */
export function formatAdvancedSettings(settings: AdvancedSettings): string {
  const output: Record<string, unknown> = {};
  if (settings.paging.type !== 'none') {
    const paging: Record<string, unknown> = { ...settings.paging };
    if (paging.maxPages === LIMITS.maxPages.default) {
      delete paging.maxPages;
    }
    if (paging.type === 'nextLink' && !paging.nextLink) {
      delete paging.nextLink;
    }
    output.paging = paging;
  }
  if (settings.apiKeyHeader !== DEFAULT_API_KEY_HEADER) {
    output.apiKeyHeader = settings.apiKeyHeader;
  }
  if (settings.copyMode !== 'all') {
    output.copyMode = settings.copyMode;
  }
  if (settings.maxItems !== LIMITS.maxItems.default) {
    output.maxItems = settings.maxItems;
  }
  if (settings.timeoutSeconds !== LIMITS.timeoutSeconds.default) {
    output.timeoutSeconds = settings.timeoutSeconds;
  }
  return Object.keys(output).length > 0 ? JSON.stringify(output) : '';
}

// RFC 6749 §8.2: token endpoint parameter names are letters, digits, ".", "-" and "_".
const PARAMETER_NAME = /^[A-Za-z0-9._-]+$/;

// Parameters REST Picklist sends itself, or from its own settings. Compared ignoring case, so a
// service that reads names loosely can't be handed a second client_secret or scope.
const RESERVED_TOKEN_PARAMETERS = new Map([
  ['grant_type', 'REST Picklist sets it.'],
  ['client_id', 'Use the Client ID setting instead.'],
  ['client_secret', 'REST Picklist sends the secret itself.'],
  ['client_assertion', 'REST Picklist sets it.'],
  ['client_assertion_type', 'REST Picklist sets it.'],
  ['scope', 'Use the Scope setting instead.'],
  ['audience', 'Use the Audience setting instead.'],
  ['resource', 'Use the Resource setting instead.'],
]);

/** Text from untrusted settings, safe to quote in a message: no control characters, and short. */
function quotable(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  cleaned = cleaned.trim();
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
}

/** Explains what's wrong with the name of an extra token parameter, or null. */
export function validateTokenParameterName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Enter a name for each extra token parameter.';
  }
  const reserved = RESERVED_TOKEN_PARAMETERS.get(trimmed.toLowerCase());
  if (reserved) {
    return `“${trimmed}” can’t be an extra token parameter. ${reserved}`;
  }
  // "__proto__" fits the pattern but would be lost or misread as a property of a plain object.
  if (!PARAMETER_NAME.test(trimmed) || trimmed === '__proto__') {
    return `“${quotable(trimmed)}” isn’t a valid parameter name. Use letters, digits, dots, hyphens and underscores.`;
  }
  if (trimmed.length > OAUTH_LIMITS.maxParamNameLength) {
    return `Parameter names can have at most ${OAUTH_LIMITS.maxParamNameLength} characters.`;
  }
  return null;
}

function defaultOAuth(): OAuthSettings {
  return { ...DEFAULT_OAUTH, extraParams: {} };
}

function readText(source: Record<string, unknown>, key: string, problems: string[]): string {
  const value = source[key];
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    problems.push(`“${key}” must be text.`);
    return '';
  }
  return value.trim();
}

function readClientAuthentication(value: unknown, problems: string[]): ClientAuthentication {
  switch (value) {
    case undefined:
    case null:
      return DEFAULT_OAUTH.clientAuthentication;
    // The names used in RFC 7591 and in identity providers' settings work too.
    case 'basic':
    case 'client_secret_basic':
      return 'basic';
    case 'body':
    case 'client_secret_post':
      return 'body';
    case 'privateKeyJwt':
    case 'private_key_jwt':
      return 'privateKeyJwt';
    default:
      problems.push('“clientAuthentication” must be "basic", "body" or "privateKeyJwt".');
      return DEFAULT_OAUTH.clientAuthentication;
  }
}

/** Checks extra token parameters; returns the usable ones, in order, and notes the rest. */
function readExtraParams(value: unknown, problems: string[]): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    problems.push('“extraParams” must be an object, for example { "tenant": "contoso" }.');
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > OAUTH_LIMITS.maxExtraParams) {
    problems.push(`Use at most ${OAUTH_LIMITS.maxExtraParams} extra token parameters.`);
  }
  const usable: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [rawName, rawValue] of entries.slice(0, OAUTH_LIMITS.maxExtraParams)) {
    const name = rawName.trim();
    const nameProblem = validateTokenParameterName(name);
    if (nameProblem) {
      problems.push(nameProblem);
    } else if (typeof rawValue !== 'string') {
      problems.push(`The extra token parameter “${name}” must be text.`);
    } else if (seen.has(name)) {
      problems.push(`“${name}” is listed twice in the extra token parameters.`);
    } else {
      seen.add(name);
      usable.push([name, rawValue]);
    }
  }
  // fromEntries defines own properties, so no name can reach the object's prototype.
  return Object.fromEntries(usable);
}

/**
 * Parses the OAuth 2.0 settings (JSON) of a configuration. Invalid parts fall back to their
 * defaults, with a problem written for the administrator. The settings are checked against the
 * security policy when a token is requested (validateOAuthSettings in oauth.ts).
 */
export function parseOAuthSettings(raw: string | undefined): {
  settings: OAuthSettings;
  error: string | null;
} {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { settings: defaultOAuth(), error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { settings: defaultOAuth(), error: 'OAuth 2.0 settings aren’t valid JSON.' };
  }
  if (!isPlainObject(parsed)) {
    return {
      settings: defaultOAuth(),
      error: 'OAuth 2.0 settings must be a JSON object { … }.',
    };
  }
  const problems: string[] = [];
  const settings: OAuthSettings = {
    tokenUrl: readText(parsed, 'tokenUrl', problems),
    clientId: readText(parsed, 'clientId', problems),
    scope: readText(parsed, 'scope', problems),
    audience: readText(parsed, 'audience', problems),
    resource: readText(parsed, 'resource', problems),
    clientAuthentication: readClientAuthentication(parsed.clientAuthentication, problems),
    assertionAudience: readText(parsed, 'assertionAudience', problems),
    extraParams: readExtraParams(parsed.extraParams, problems),
  };
  return {
    settings,
    error: problems.length > 0 ? `OAuth 2.0 settings: ${problems.join(' ')}` : null,
  };
}

/** Writes OAuth 2.0 settings as compact JSON, leaving out defaults. Empty when nothing is set. */
export function formatOAuthSettings(settings: OAuthSettings): string {
  const output: Record<string, unknown> = {};
  for (const key of ['tokenUrl', 'clientId', 'scope', 'audience', 'resource'] as const) {
    const value = settings[key].trim();
    if (value) {
      output[key] = value;
    }
  }
  if (settings.clientAuthentication !== DEFAULT_OAUTH.clientAuthentication) {
    output.clientAuthentication = settings.clientAuthentication;
  }
  const assertionAudience = settings.assertionAudience.trim();
  if (assertionAudience) {
    output.assertionAudience = assertionAudience;
  }
  const extraParams = Object.entries(settings.extraParams)
    .map(([name, value]): [string, string] => [name.trim(), value])
    .filter(([name]) => name);
  if (extraParams.length > 0) {
    output.extraParams = Object.fromEntries(extraParams);
  }
  return Object.keys(output).length > 0 ? JSON.stringify(output) : '';
}

/**
 * Problems with OAuth 2.0 settings that don't depend on the organization's policy: what's
 * missing, and extra parameters that can't be sent.
 */
export function oauthSettingsProblems(settings: OAuthSettings): string[] {
  const problems: string[] = [];
  if (!settings.tokenUrl.trim()) {
    problems.push('Add the access token URL for OAuth 2.0.');
  }
  if (!settings.clientId.trim()) {
    problems.push('Add the client ID for OAuth 2.0.');
  }
  // Settings built by hand rather than parsed get the same checks as parsed ones.
  readExtraParams(settings.extraParams, problems);
  return problems;
}

/**
 * Combines a control's own inputs with a saved configuration. The control's non-empty values win;
 * advanced settings are merged key by key. Only the inputs in SAVED_INPUT_IDS are taken from the
 * saved configuration.
 */
export function mergeSavedInputs(
  own: Record<string, unknown>,
  saved: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...own };
  for (const id of SAVED_INPUT_IDS) {
    let ownText = text(own[id]).trim();
    // The dropdown may store "None" without anyone choosing it; don't let it hide the saved method.
    if (id === INPUT_IDS.authMethod) {
      const ownMethod = parseAuthMethod(ownText, '', '');
      if (ownMethod.method === 'none' && !ownMethod.error) {
        ownText = '';
      }
    }
    const savedText = text(saved[id]).trim();
    if (id === INPUT_IDS.advanced && ownText && savedText) {
      try {
        const savedObject: unknown = JSON.parse(savedText);
        const ownObject: unknown = JSON.parse(ownText);
        if (isPlainObject(savedObject) && isPlainObject(ownObject)) {
          merged[id] = JSON.stringify({ ...savedObject, ...ownObject });
          continue;
        }
      } catch {
        // Keep the control's own text so its parse error is reported.
      }
    }
    merged[id] = ownText ? own[id] : saved[id];
  }
  return merged;
}

/** The inputs a saved configuration shares, taken from a control's inputs. */
export function pickSavedInputs(inputs: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const id of SAVED_INPUT_IDS) {
    const value = text(inputs[id]);
    if (value.trim()) {
      picked[id] = value;
    }
  }
  return picked;
}

export function parseConfig(inputs: Record<string, unknown> | undefined): PicklistConfig {
  const input = (id: string) => inputs?.[id];
  const { map, error } = parseFieldMap(text(input(INPUT_IDS.fieldMap)));
  const username = text(input(INPUT_IDS.username));
  const password = text(input(INPUT_IDS.password));
  const auth = parseAuthMethod(text(input(INPUT_IDS.authMethod)), username, password);
  const advanced = parseAdvancedSettings(text(input(INPUT_IDS.advanced)));
  const oauth = parseOAuthSettings(text(input(INPUT_IDS.oauth)));
  return {
    fieldName: text(input(INPUT_IDS.fieldName)).trim(),
    configuration: text(input(INPUT_IDS.configuration)).trim(),
    savedConfiguration: text(input(INPUT_IDS.savedConfiguration)).trim(),
    url: text(input(INPUT_IDS.url)).trim(),
    params: text(input(INPUT_IDS.params)),
    authMethod: auth.method,
    // In older setups the user name field held the word "Bearer".
    username: auth.method === 'basic' ? username : '',
    password,
    arrayPath: text(input(INPUT_IDS.arrayPath)).trim(),
    keyField: text(input(INPUT_IDS.keyField)).trim(),
    secondLineProperty: text(input(INPUT_IDS.secondLine)).trim(),
    fieldMap: map,
    fieldMapError: error,
    allowMultiple: flag(input(INPUT_IDS.allowMultiple)),
    loadOnFormOpen: flag(input(INPUT_IDS.loadOnFormOpen)),
    required: flag(input(INPUT_IDS.required)),
    notFoundMessage: text(input(INPUT_IDS.notFoundMessage)).trim(),
    advanced: advanced.settings,
    advancedError: advanced.error,
    authError: auth.error,
    oauth: oauth.settings,
    oauthError: oauth.error,
    saveConfiguration: flag(input(INPUT_IDS.saveConfiguration)),
    savedConfigurationName: text(input(INPUT_IDS.savedConfigurationName)).trim(),
  };
}

/** Problems with the settings themselves, written for the administrator. */
export function configProblems(config: PicklistConfig): string[] {
  const problems = [config.fieldMapError, config.advancedError, config.authError];
  // OAuth 2.0 settings only matter, and are only reported, when the configuration uses them.
  if (config.authMethod === 'oauth2') {
    problems.push(config.oauthError, ...oauthSettingsProblems(config.oauth));
  }
  return problems.filter((problem): problem is string => Boolean(problem));
}

// The scheme and host of a URL template, before any `$(Field)` value is added.
const TEMPLATE_ORIGIN = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)/i;

function templateOrigin(template: string): string | null {
  const match = TEMPLATE_ORIGIN.exec(template.trim());
  if (!match || match[0].includes('$(')) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    return null;
  }
  return url.username || url.password ? null : parseOrigin(url.origin);
}

/**
 * Where a configuration sends its secret: the API's origin for Basic, bearer tokens and API keys,
 * or the token URL's origin for OAuth 2.0. Null when it signs in with nothing, or when that
 * address isn't one a secret may go to (see parseOrigin in secrets.ts).
 */
export function secretDestinationOrigin(settings: Record<string, string>): string | null {
  const auth = parseAuthMethod(
    text(settings[INPUT_IDS.authMethod]),
    text(settings[INPUT_IDS.username]),
    ''
  );
  if (auth.error) {
    return null;
  }
  switch (auth.method) {
    case 'none':
      return null;
    case 'oauth2':
      return templateOrigin(parseOAuthSettings(text(settings[INPUT_IDS.oauth])).settings.tokenUrl);
    default:
      return templateOrigin(text(settings[INPUT_IDS.url]));
  }
}

/**
 * OAuth 2.0 only: the API's origin, where the access tokens a secret gets are sent. Null for
 * other sign-in methods (their secret goes to the API itself, see secretDestinationOrigin), and
 * when the address isn't one a secret's tokens may go to.
 */
export function secretApiOrigin(settings: Record<string, string>): string | null {
  const auth = parseAuthMethod(text(settings[INPUT_IDS.authMethod]), '', '');
  return !auth.error && auth.method === 'oauth2'
    ? templateOrigin(text(settings[INPUT_IDS.url]))
    : null;
}

/**
 * Null when a secret saved for `boundOrigin` may be sent with these settings. Otherwise the
 * address changed after the secret was saved, and the secret has to be entered again. For
 * OAuth 2.0, `apiOrigin` (when the secret was saved with one) binds where its tokens go too.
 */
export function secretBindingProblem(
  boundOrigin: string,
  settings: Record<string, string>,
  apiOrigin?: string
): string | null {
  const destination = secretDestinationOrigin(settings);
  const tokensStay = apiOrigin === undefined || secretApiOrigin(settings) === apiOrigin;
  return destination !== null && destination === boundOrigin && tokensStay
    ? null
    : 'This configuration’s address changed after its secret was saved. Ask an administrator to enter the secret again.';
}
