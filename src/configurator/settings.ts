import type {
  AdvancedSettings,
  AuthMethod,
  CopyMode,
  OAuthSettings,
  PagingConfig,
  PagingType,
} from '../core/config';
import {
  AUTH_METHOD_LABELS,
  DEFAULT_ADVANCED,
  DEFAULT_API_KEY_HEADER,
  DEFAULT_OAUTH,
  INPUT_IDS,
  LIMITS,
  formatAdvancedSettings,
  formatOAuthSettings,
  oauthSettingsProblems,
  parseConfig,
  pickConfigurationSettings,
  secretApiOrigin,
  secretDestinationOrigin,
  secretKindFor,
  validateHeaderName,
} from '../core/config';
import { toUserMessage } from '../core/errors';
import { parseFieldMap } from '../core/fieldMap';
import {
  ENTRA_TOKEN_URL_PROBLEM,
  isMicrosoftEntraTokenUrl,
  validateOAuthSettings,
} from '../core/oauth';
import type { SecurityPolicy } from '../core/policy';
import { checkAuthMethod } from '../core/policy';
import { parseParameters, validateEndpoint } from '../core/request';
import type { CertificateInfo, SecretKind, SecretSummary } from '../core/secrets';
import { SECRET_LIMITS } from '../core/secrets';
import { scalarToString } from '../core/values';

/** OAuth 2.0: what the client proves itself with. A certificate, or a key, signs a JWT. */
export type OAuthCredential = 'secret' | 'certificate';

/**
 * A configuration's settings in the shape the editor edits. Advanced and OAuth 2.0 settings are
 * edited as structured values and written back as their JSON settings.
 */
export interface Draft {
  url: string;
  params: string;
  authMethod: AuthMethod;
  username: string;
  /**
   * The password, token, API key or client secret typed on this page. Memory only: saving sends it
   * to the configuration's write-only secret, and it's never read back into a draft.
   */
  password: string;
  /**
   * OAuth 2.0 settings. Here `clientAuthentication` says how a client secret is sent (basic or
   * body); with a certificate the client always signs a JWT (see effectiveOAuth).
   */
  oauth: OAuthSettings;
  credential: OAuthCredential;
  arrayPath: string;
  keyField: string;
  secondLine: string;
  fieldMap: string;
  allowMultiple: boolean;
  loadOnFormOpen: boolean;
  required: boolean;
  notFoundMessage: string;
  advanced: AdvancedSettings;
}

/** Setting labels, kept from the 3.0 Options tab so people who set controls up there know them. */
export const LABELS = {
  url: 'REST endpoint URL',
  params: 'URL parameters (JSON)',
  authMethod: 'Sign-in method',
  username: 'User name',
  arrayPath: 'JSON path to the list',
  keyField: 'Value property',
  secondLine: 'Second line',
  fieldMap: 'Copy to other fields (JSON)',
  allowMultiple: 'Allow multiple values',
  loadOnFormOpen: 'Load the list when the work item opens',
  required: 'Mark as required when empty',
  notFoundMessage: 'Message when the value isn’t in the list',
} as const;

export const EMPTY_DRAFT: Draft = {
  url: '',
  params: '',
  authMethod: 'none',
  username: '',
  password: '',
  oauth: { ...DEFAULT_OAUTH, extraParams: {} },
  credential: 'secret',
  arrayPath: '',
  keyField: '',
  secondLine: '',
  fieldMap: '',
  allowMultiple: false,
  loadOnFormOpen: false,
  required: false,
  notFoundMessage: '',
  advanced: DEFAULT_ADVANCED,
};

/** A public, CORS-enabled API so the whole flow can be tried without credentials. */
export const SAMPLE_DRAFT: Draft = {
  ...EMPTY_DRAFT,
  url: 'https://jsonplaceholder.typicode.com/users',
  secondLine: 'email',
  fieldMap: '{ "Custom.ContactEmail": "email", "Custom.City": "address.city" }',
};

/** The sign-in methods, in the order the editor offers them. */
export const SIGN_IN_METHODS: readonly AuthMethod[] = [
  'none',
  'basic',
  'bearer',
  'apiKey',
  'oauth2',
];

export const PAGING_LABELS: Record<PagingType, string> = {
  none: 'No paging',
  nextLink: 'Next link',
  page: 'Page number and size',
  offset: 'Offset and limit',
  cursor: 'Cursor',
};

export const COPY_MODE_LABELS: Record<CopyMode, string> = {
  all: 'Copy every picked item’s value',
  first: 'Copy only the first',
};

/** What each kind of secret is called in sentences. */
export const SECRET_NOUNS: Record<SecretKind, string> = {
  password: 'password',
  token: 'token',
  apiKey: 'API key',
  clientSecret: 'client secret',
  signingKey: 'certificate or key',
};

/** The grant type OAuth 2.0 uses here, shown as text: there's no other choice. */
export const GRANT_TYPE_LABEL = 'Client credentials (application permissions)';

/** Under the access token URL when it's Microsoft Entra ID's: see isMicrosoftEntraTokenUrl. */
export { ENTRA_TOKEN_URL_PROBLEM };

export const SECRET_MOVED = 'You changed where the secret is sent, so enter it again.';

export const KEY_MOVED =
  'You changed the access token URL, so choose the certificate or key again.';

/** OAuth 2.0: the tokens a saved secret gets would go to another API. */
export const API_MOVED =
  'You changed the API’s address, and the access tokens go there, so enter the client secret again.';

export const API_MOVED_KEY =
  'You changed the API’s address, and the access tokens go there, so choose the certificate or key again.';

const numberFormat = new Intl.NumberFormat('en-US');

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** “A, B or C”. */
export function listWithOr(items: readonly string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`
    : (items[0] ?? '');
}

function text(value: unknown): string {
  return scalarToString(value) ?? '';
}

/** Paging settings for a newly chosen type, keeping the page limit already set. */
export function pagingForType(type: PagingType, current: PagingConfig): PagingConfig {
  const maxPages = current.type === 'none' ? LIMITS.maxPages.default : current.maxPages;
  switch (type) {
    case 'nextLink':
      return { type, nextLink: '', maxPages };
    case 'page':
      return {
        type,
        pageParam: 'page',
        sizeParam: 'pageSize',
        size: LIMITS.pageSize.default,
        startPage: 1,
        maxPages,
      };
    case 'offset':
      return {
        type,
        offsetParam: 'offset',
        limitParam: 'limit',
        limit: LIMITS.pageSize.default,
        maxPages,
      };
    case 'cursor':
      return { type, cursorPath: '', cursorParam: 'cursor', maxPages };
    default:
      return { type: 'none' };
  }
}

/**
 * Reads a configuration's settings into a draft. Settings imported from 3.0 work too: "Bearer" in
 * the user name means a bearer token. Problems are returned so the editor can say what was reset.
 */
export function draftFromSettings(settings: Record<string, unknown>): {
  draft: Draft;
  problems: string[];
} {
  const config = parseConfig(settings);
  const signsJwt = config.oauth.clientAuthentication === 'privateKeyJwt';
  const draft: Draft = {
    url: config.url,
    params: text(settings[INPUT_IDS.params]).trim(),
    authMethod: config.authMethod,
    username: config.username,
    // Secrets are never part of the settings, and never read back.
    password: '',
    oauth: {
      ...config.oauth,
      clientAuthentication: signsJwt
        ? DEFAULT_OAUTH.clientAuthentication
        : config.oauth.clientAuthentication,
    },
    credential: signsJwt ? 'certificate' : 'secret',
    arrayPath: config.arrayPath,
    keyField: config.keyField,
    secondLine: config.secondLineProperty,
    fieldMap: text(settings[INPUT_IDS.fieldMap]).trim(),
    allowMultiple: config.allowMultiple,
    loadOnFormOpen: config.loadOnFormOpen,
    required: config.required,
    notFoundMessage: config.notFoundMessage,
    advanced: config.advanced,
  };
  const problems = [
    config.authError,
    config.advancedError,
    config.authMethod === 'oauth2' ? config.oauthError : null,
  ].filter((problem): problem is string => Boolean(problem));
  return { draft, problems };
}

/**
 * The advanced settings the draft really uses: the API key header only matters for API keys, and
 * the copy mode only with multiple values, so hidden leftovers aren't written out.
 */
export function effectiveAdvanced(draft: Draft): AdvancedSettings {
  return {
    ...draft.advanced,
    apiKeyHeader:
      draft.authMethod === 'apiKey'
        ? draft.advanced.apiKeyHeader.trim() || DEFAULT_API_KEY_HEADER
        : DEFAULT_API_KEY_HEADER,
    copyMode: draft.allowMultiple ? draft.advanced.copyMode : 'all',
  };
}

/** The generated “Advanced settings (JSON)” value; empty when every advanced setting is default. */
export function advancedJson(draft: Draft): string {
  return formatAdvancedSettings(effectiveAdvanced(draft));
}

/**
 * The OAuth 2.0 settings the draft really uses: a certificate always signs a JWT, and the
 * assertion's audience only matters then.
 */
export function effectiveOAuth(draft: Pick<Draft, 'oauth' | 'credential'>): OAuthSettings {
  const certificate = draft.credential === 'certificate';
  return {
    ...draft.oauth,
    clientAuthentication: certificate
      ? 'privateKeyJwt'
      : draft.oauth.clientAuthentication === 'body'
        ? 'body'
        : 'basic',
    assertionAudience: certificate ? draft.oauth.assertionAudience : '',
  };
}

/**
 * A configuration's settings for a draft, keyed by the setting ids, leaving out empty ones and
 * settings the sign-in method doesn't use. Never the secret: it's saved apart, write-only.
 */
export function draftToSettings(draft: Draft): Record<string, string> {
  const settings: Record<string, string> = {};
  const put = (id: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      settings[id] = trimmed;
    }
  };
  const flag = (id: string, value: boolean) => {
    if (value) {
      settings[id] = 'true';
    }
  };
  put(INPUT_IDS.url, draft.url);
  put(INPUT_IDS.params, draft.params);
  if (draft.authMethod !== 'none') {
    settings[INPUT_IDS.authMethod] = AUTH_METHOD_LABELS[draft.authMethod];
  }
  if (draft.authMethod === 'basic') {
    put(INPUT_IDS.username, draft.username);
  }
  put(INPUT_IDS.arrayPath, draft.arrayPath);
  put(INPUT_IDS.keyField, draft.keyField);
  put(INPUT_IDS.secondLine, draft.secondLine);
  put(INPUT_IDS.fieldMap, draft.fieldMap);
  flag(INPUT_IDS.allowMultiple, draft.allowMultiple);
  flag(INPUT_IDS.loadOnFormOpen, draft.loadOnFormOpen);
  flag(INPUT_IDS.required, draft.required);
  put(INPUT_IDS.notFoundMessage, draft.notFoundMessage);
  put(INPUT_IDS.advanced, advancedJson(draft));
  if (draft.authMethod === 'oauth2') {
    put(INPUT_IDS.oauth, formatOAuthSettings(effectiveOAuth(draft)));
  }
  return pickConfigurationSettings(settings);
}

/** True when both hold the same settings. */
export function sameSettings(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** The kind of secret the draft's sign-in needs, or null when it signs in with nothing. */
export function secretKindOf(draft: Draft): SecretKind | null {
  return secretKindFor(draft.authMethod, effectiveOAuth(draft).clientAuthentication);
}

/**
 * Where the draft's secret is sent: the API's origin, or the token URL's for OAuth 2.0. Null when
 * it signs in with nothing, or the address can't take a secret.
 */
export function secretDestination(draft: Draft): string | null {
  return secretDestinationOrigin(draftToSettings(draft));
}

/** OAuth 2.0: where the access tokens the secret gets are sent, the API's origin; else null. */
export function secretApiDestination(draft: Draft): string | null {
  return secretApiOrigin(draftToSettings(draft));
}

/** Whether a saved secret's tokens would now go to another API (OAuth 2.0 only). */
export function apiMoved(draft: Draft, stored: SecretSummary): boolean {
  return stored.apiOrigin !== undefined && secretApiDestination(draft) !== stored.apiOrigin;
}

// ---- The write-only secret ----

/** What the editor knows about a configuration's secret, never the secret itself. */
export interface CredentialState {
  /** What the configuration says about its saved secret; null when none is saved. */
  stored: SecretSummary | null;
  /** A new secret was typed, or a certificate or key was read, on this page. */
  entered: boolean;
  /** Remove was chosen for the saved secret. */
  removing: boolean;
}

/**
 * What saving does with the secret:
 * - none: the sign-in method needs none, and none is saved.
 * - missing: the method needs one, but none is saved or entered (it can be set later).
 * - keep: the saved secret stays.
 * - save: the one entered here is saved, replacing any saved one.
 * - remove: the saved secret is deleted, because it was removed or the method can't use it.
 * - reenter: the saved secret would now go somewhere else, so it has to be entered again.
 */
export type SecretPlan = 'none' | 'missing' | 'keep' | 'save' | 'remove' | 'reenter';

export function planSecret(draft: Draft, credentials: CredentialState): SecretPlan {
  const kind = secretKindOf(draft);
  const { stored, entered, removing } = credentials;
  if (kind === null) {
    return stored ? 'remove' : 'none';
  }
  if (entered) {
    return 'save';
  }
  if (!stored) {
    return 'missing';
  }
  if (removing || stored.kind !== kind) {
    return 'remove';
  }
  // A secret is only ever sent where it was saved for, and for OAuth 2.0 its tokens too (see
  // secretBindingProblem).
  return secretDestination(draft) === stored.boundOrigin && !apiMoved(draft, stored)
    ? 'keep'
    : 'reenter';
}

/** Why a key ID can't be sent in a JWT header, or null. */
export function keyIdProblem(keyId: string): string | null {
  const trimmed = keyId.trim();
  if (trimmed.length > SECRET_LIMITS.maxTextLength) {
    return `The key ID can have ${SECRET_LIMITS.maxTextLength} characters at most.`;
  }
  return /\p{Cc}/u.test(trimmed)
    ? 'The key ID can’t contain line breaks or other control characters.'
    : null;
}

// ---- Validation ----

export interface Issue {
  tone: 'error' | 'warning';
  message: string;
}

export type IssueKey =
  | 'url'
  | 'params'
  | 'authMethod'
  | 'username'
  | 'apiKeyHeader'
  | 'tokenUrl'
  /** The token URL is Microsoft Entra ID's: saving is blocked, but the test may show why. */
  | 'entra'
  | 'oauth'
  | 'secret'
  | 'fieldMap'
  | 'paging';

export type Issues = Partial<Record<IssueKey, Issue>>;

/** Problems that stop the test request from being built. */
const REQUEST_ISSUES: readonly IssueKey[] = [
  'url',
  'params',
  'authMethod',
  'username',
  'apiKeyHeader',
  'tokenUrl',
  'oauth',
  'paging',
];

/** Empty names would be dropped from the Advanced settings JSON, silently changing the paging. */
function validatePaging(paging: PagingConfig): string | null {
  const names: string[] = [];
  switch (paging.type) {
    case 'page':
      names.push(paging.pageParam, paging.sizeParam);
      break;
    case 'offset':
      names.push(paging.offsetParam, paging.limitParam);
      break;
    case 'cursor':
      if (!paging.cursorPath.trim()) {
        return 'Enter where the next cursor is in the response, for example meta.nextCursor.';
      }
      names.push(paging.cursorParam);
      break;
    default:
      return null;
  }
  return names.some((name) => !name.trim()) ? 'Enter a name for each paging parameter.' : null;
}

function validateOAuth(draft: Draft, policy: SecurityPolicy, issues: Issues): void {
  const oauth = effectiveOAuth(draft);
  const tokenUrl = oauth.tokenUrl.trim();
  if (tokenUrl) {
    // With a client ID and no extra parameters, only the token URL's own problem can be left.
    const [problem] = validateOAuthSettings(
      { ...oauth, clientId: oauth.clientId.trim() || 'client', extraParams: {} },
      policy
    );
    if (problem) {
      issues.tokenUrl = { tone: 'error', message: problem };
    } else if (isMicrosoftEntraTokenUrl(tokenUrl)) {
      issues.entra = { tone: 'error', message: ENTRA_TOKEN_URL_PROBLEM };
    }
  }
  // The same check, for what's left: the extra token parameters.
  const [extraProblem] = oauthSettingsProblems({ ...oauth, tokenUrl: 'x', clientId: 'x' });
  if (extraProblem) {
    issues.oauth = { tone: 'error', message: extraProblem };
  }
}

/**
 * Problems that can be found without calling the service, checked against the policy. Required
 * settings that are still empty aren't listed here: see missingRequired. With `credentials`, the
 * secret is checked too.
 */
export function validateDraft(
  draft: Draft,
  policy: SecurityPolicy,
  credentials?: CredentialState
): Issues {
  const issues: Issues = {};
  if (draft.url.trim()) {
    const problem = validateEndpoint(draft.url, policy);
    if (problem) {
      issues.url = { tone: 'error', message: problem };
    }
  }
  if (draft.params.trim()) {
    // Field values go inside JSON strings, so the JSON is valid whatever they are.
    try {
      parseParameters(draft.params);
    } catch (error) {
      issues.params = { tone: 'error', message: toUserMessage(error) };
    }
  }
  const authProblem = checkAuthMethod(draft.authMethod, policy);
  if (authProblem) {
    issues.authMethod = { tone: 'error', message: authProblem };
  }
  if (draft.authMethod === 'basic' && draft.username.includes(':')) {
    issues.username = { tone: 'error', message: 'The user name can’t contain a colon (:).' };
  }
  if (draft.authMethod === 'apiKey') {
    const headerProblem = validateHeaderName(
      draft.advanced.apiKeyHeader.trim() || DEFAULT_API_KEY_HEADER
    );
    if (headerProblem) {
      issues.apiKeyHeader = { tone: 'error', message: headerProblem };
    }
  }
  if (draft.authMethod === 'oauth2') {
    validateOAuth(draft, policy, issues);
  }
  if (credentials && planSecret(draft, credentials) === 'reenter') {
    const key = secretKindOf(draft) === 'signingKey';
    // Said for what changed: where the secret goes, or (OAuth 2.0) where its tokens go.
    const tokensMoved =
      credentials.stored !== null &&
      secretDestination(draft) === credentials.stored.boundOrigin &&
      apiMoved(draft, credentials.stored);
    issues.secret = {
      tone: 'error',
      message: tokensMoved ? (key ? API_MOVED_KEY : API_MOVED) : key ? KEY_MOVED : SECRET_MOVED,
    };
  }
  const fieldMap = parseFieldMap(draft.fieldMap);
  if (fieldMap.error) {
    issues.fieldMap = { tone: 'error', message: fieldMap.error };
  }
  const pagingProblem = validatePaging(draft.advanced.paging);
  if (pagingProblem) {
    issues.paging = { tone: 'error', message: pagingProblem };
  }
  return issues;
}

/** Required settings and what each says while it's empty, in the order the editor shows them. */
export const REQUIRED_MESSAGES = {
  name: 'Enter a name for the configuration.',
  url: 'Add the REST endpoint URL.',
  tokenUrl: 'Add the access token URL for OAuth 2.0.',
  clientId: 'Add the client ID for OAuth 2.0.',
} as const;

export type RequiredKey = keyof typeof REQUIRED_MESSAGES;

/** The draft's required settings that are still empty (the name is the editor's). */
export function missingRequired(draft: Draft): RequiredKey[] {
  const missing: RequiredKey[] = [];
  if (!draft.url.trim()) {
    missing.push('url');
  }
  if (draft.authMethod === 'oauth2') {
    if (!draft.oauth.tokenUrl.trim()) {
      missing.push('tokenUrl');
    }
    if (!draft.oauth.clientId.trim()) {
      missing.push('clientId');
    }
  }
  return missing;
}

/** True when the test request can't be built from the draft. */
export function blocksRequest(issues: Issues): boolean {
  return REQUEST_ISSUES.some((key) => issues[key]?.tone === 'error');
}

/** The problems that stop the draft from being saved. */
export function saveProblems(issues: Issues): Issue[] {
  return Object.values(issues).filter((issue) => issue.tone === 'error');
}

// ---- Dates and certificates ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

/**
 * Such as “22 Oct 2026”, or “22 Oct” without the year; '' when it isn't a date. Every date on the
 * setup page is written this way. Certificate dates are shown in UTC, like the warnings written
 * when the certificate is read; other dates in the viewer's time zone.
 */
export function formatDay(iso: string | undefined, utc = false, withYear = true): string {
  const date = new Date(iso ?? '');
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const day = utc ? date.getUTCDate() : date.getDate();
  const month = MONTHS[utc ? date.getUTCMonth() : date.getMonth()];
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  return withYear ? `${day} ${month} ${year}` : `${day} ${month}`;
}

/** “Set · changed by Ana Díaz on 22 Oct 2026”, from what's known about the change. */
export function describeSecretChange(
  summary: Pick<SecretSummary, 'updatedBy' | 'updatedAt'>
): string {
  const day = formatDay(summary.updatedAt);
  const who = summary.updatedBy ? ` by ${summary.updatedBy}` : '';
  return who || day ? `Set · changed${who}${day ? ` on ${day}` : ''}` : 'Set';
}

/** Expired, not valid yet, or expiring within 30 days, in the words used when it's read. */
export function certificateWarnings(info: CertificateInfo, now: Date): string[] {
  const time = now.getTime();
  const notBefore = new Date(info.notBefore).getTime();
  const notAfter = new Date(info.notAfter).getTime();
  if (time < notBefore) {
    return [`The certificate isn’t valid until ${formatDay(info.notBefore, true)}.`];
  }
  const left = notAfter - time;
  if (left < 0) {
    return [`The certificate expired on ${formatDay(info.notAfter, true)}.`];
  }
  if (left <= 30 * DAY_MS) {
    const days = Math.floor(left / DAY_MS);
    const when = days === 0 ? 'in less than a day' : days === 1 ? 'in 1 day' : `in ${days} days`;
    return [`The certificate expires on ${formatDay(info.notAfter, true)} (${when}).`];
  }
  return [];
}

// ---- One-line summaries for the collapsible sections ----

function listNames(names: readonly string[], max = 2): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

export function summarizeMultiple(draft: Draft): string {
  if (!draft.allowMultiple) {
    return 'Off · one value per field';
  }
  const hasFieldMap = Boolean(parseFieldMap(draft.fieldMap).map);
  return hasFieldMap
    ? `On · ${draft.advanced.copyMode === 'first' ? 'copies only the first' : 'copies every picked item’s value'}`
    : 'On · saved as A; B; C';
}

export function summarizeFieldMap(draft: Draft): string {
  const { map, error } = parseFieldMap(draft.fieldMap);
  if (error) {
    return 'The JSON needs fixing';
  }
  if (!map) {
    return 'Off';
  }
  const fields = Object.keys(map);
  return `${fields.length} ${fields.length === 1 ? 'field' : 'fields'}: ${listNames(fields)}`;
}

export function summarizePaging(draft: Draft): string {
  const { paging, maxItems } = draft.advanced;
  const items = `up to ${formatNumber(maxItems)} items`;
  switch (paging.type) {
    case 'none':
      return `One request · ${items}`;
    case 'nextLink':
      return `Next link (${paging.nextLink || 'found automatically'}) · up to ${paging.maxPages} pages`;
    case 'page':
      return `Page number · ${formatNumber(paging.size)} per page · up to ${paging.maxPages} pages`;
    case 'offset':
      return `Offset · ${formatNumber(paging.limit)} per request · up to ${paging.maxPages} pages`;
    case 'cursor':
      return paging.cursorPath.trim()
        ? `Cursor (${paging.cursorPath}) · up to ${paging.maxPages} pages`
        : 'Cursor · where is the next cursor?';
    default:
      return items;
  }
}

export function summarizeBehavior(draft: Draft): string {
  const parts = [
    draft.loadOnFormOpen ? 'Loads with the work item' : 'Loads when the list opens',
    draft.required ? 'required' : 'optional',
  ];
  if (draft.notFoundMessage.trim()) {
    parts.push('custom message');
  }
  if (draft.advanced.timeoutSeconds !== LIMITS.timeoutSeconds.default) {
    parts.push(`${draft.advanced.timeoutSeconds} s timeout`);
  }
  return parts.join(' · ');
}

/** The OAuth 2.0 “Advanced” section: what's set, or that nothing is. */
export function summarizeOAuthAdvanced(draft: Pick<Draft, 'oauth' | 'credential'>): string {
  const oauth = effectiveOAuth(draft);
  const parts: string[] = [];
  if (oauth.audience.trim()) {
    parts.push('Audience');
  }
  if (oauth.resource.trim()) {
    parts.push('Resource');
  }
  if (oauth.assertionAudience.trim()) {
    parts.push('Assertion audience');
  }
  const extra = Object.keys(oauth.extraParams).length;
  if (extra > 0) {
    parts.push(`${extra} extra ${extra === 1 ? 'parameter' : 'parameters'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Nothing extra';
}

/** How the test signs in, without revealing anything secret. */
export function describeSignIn(
  draft: Pick<Draft, 'authMethod' | 'advanced' | 'credential'>
): string {
  switch (draft.authMethod) {
    case 'apiKey':
      return `API key (${draft.advanced.apiKeyHeader.trim() || DEFAULT_API_KEY_HEADER})`;
    case 'oauth2':
      return draft.credential === 'certificate'
        ? 'OAuth 2.0 with a certificate'
        : 'OAuth 2.0 with a client secret';
    default:
      return AUTH_METHOD_LABELS[draft.authMethod];
  }
}
