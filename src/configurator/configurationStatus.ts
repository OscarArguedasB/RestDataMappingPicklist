import type { AuthMethod, ClientAuthentication } from '../core/config';
import {
  INPUT_IDS,
  configProblems,
  parseAuthMethod,
  parseConfig,
  parseOAuthSettings,
  secretBindingProblem,
  secretKindFor,
} from '../core/config';
import type { ConfigurationDocument } from '../core/configurations';
import {
  CONFIGURATION_LIMITS,
  findConfigurationForProcess,
  findNameConflicts,
  nameKey,
  quoteName,
  shortenName,
} from '../core/configurations';
import { toUserMessage } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { controlStatus } from '../core/migration';
import { ENTRA_REFUSES_BROWSER, isMicrosoftEntraTokenUrl } from '../core/oauth';
import type { SecretKind } from '../core/secrets';
import { formatDay as formatDate } from './settings';

// What the Configurations tab says about each configuration and control, as plain text built
// from the stored settings. Nothing here reads or describes a secret beyond its summary.

/** A certificate expiring within this many days gets a warning. */
export const EXPIRY_WARNING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Like “2 controls”. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

/** Names joined like “A, B and C”. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join('');
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function parseDate(iso: string | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * “22 Oct” this year, “22 Oct 2025” otherwise (or always, with `withYear`): the same words as the
 * editor and the policy use (settings.ts). Certificate dates are in UTC (`utc`), as everywhere.
 */
export function formatDay(
  iso: string | undefined,
  now: Date,
  withYear = false,
  utc = false
): string {
  const date = parseDate(iso);
  if (!date) {
    return '';
  }
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  return formatDate(iso, utc, withYear || year !== now.getFullYear());
}

// A `$(Field)` value in an address, swapped for a placeholder while the URL is parsed.
const FIELD_TOKEN = /\$\([^)]*\)/g;
const PLACEHOLDER = /rp-field-(\d+)-rp/g;

/**
 * The host of the endpoint URL, also when its address has `$(Field)` values in it. Read with the
 * URL parser fetch uses, so what's shown is where requests go: a backslash ends the host, tabs and
 * line breaks are dropped, and credentials in the address are never shown. Empty when the
 * address can't be parsed.
 */
export function endpointHost(settings: Record<string, string>): string {
  const url = (settings[INPUT_IDS.url] ?? '').trim();
  if (!url) {
    return '';
  }
  const tokens: string[] = [];
  const candidate = url.replace(FIELD_TOKEN, (token) => {
    tokens.push(token);
    return `rp-field-${tokens.length - 1}-rp`;
  });
  let host: string;
  try {
    host = new URL(candidate).host;
  } catch {
    return '';
  }
  return host.replace(
    PLACEHOLDER,
    (placeholder, index: string) => tokens[Number(index)] ?? placeholder
  );
}

export interface SignIn {
  method: AuthMethod;
  clientAuthentication: ClientAuthentication;
  /** Set when the stored method isn't one REST Picklist knows. */
  error: string | null;
}

export function signInOf(settings: Record<string, string>): SignIn {
  const auth = parseAuthMethod(
    settings[INPUT_IDS.authMethod] ?? '',
    settings[INPUT_IDS.username] ?? '',
    ''
  );
  return {
    method: auth.method,
    clientAuthentication: parseOAuthSettings(settings[INPUT_IDS.oauth]).settings
      .clientAuthentication,
    error: auth.error,
  };
}

/** The kind of secret the configuration's sign-in needs; null when none. */
export function neededSecretKind(settings: Record<string, string>): SecretKind | null {
  const signIn = signInOf(settings);
  return signIn.error ? null : secretKindFor(signIn.method, signIn.clientAuthentication);
}

/**
 * Basic sign-in with a user name works without a password: forms send the user name alone, as
 * before 4.0 (some APIs take a key as the user name).
 */
export function passwordOptional(settings: Record<string, string>): boolean {
  const signIn = signInOf(settings);
  return (
    !signIn.error && signIn.method === 'basic' && Boolean(settings[INPUT_IDS.username]?.trim())
  );
}

/** How it signs in, in a few words for the status line, like “OAuth 2.0 with a certificate”. */
export function describeSignIn(doc: Pick<ConfigurationDocument, 'settings' | 'secret'>): string {
  const signIn = signInOf(doc.settings);
  if (signIn.error) {
    return 'unknown sign-in method';
  }
  switch (signIn.method) {
    case 'none':
      return 'no sign-in';
    case 'basic':
      return 'Basic sign-in';
    case 'bearer':
      return 'bearer token';
    case 'apiKey':
      return 'API key';
    case 'oauth2':
      if (signIn.clientAuthentication !== 'privateKeyJwt') {
        return 'OAuth 2.0 with a client secret';
      }
      return doc.secret?.kind === 'signingKey' && !doc.secret.certificate
        ? 'OAuth 2.0 with a private key'
        : 'OAuth 2.0 with a certificate';
    default:
      return '';
  }
}

/** The noun for a secret in messages such as “Needs the API key again”. */
export function secretNoun(kind: SecretKind | null): string {
  switch (kind) {
    case 'password':
      return 'password';
    case 'token':
      return 'token';
    case 'apiKey':
      return 'API key';
    case 'clientSecret':
      return 'client secret';
    case 'signingKey':
      return 'certificate or key';
    default:
      return 'secret';
  }
}

export interface CertificateExpiry {
  notAfter: string;
  /** Whole days left, rounded up; 0 or less once it has expired. */
  daysLeft: number;
  expired: boolean;
  notYetValid: boolean;
}

export function certificateExpiry(
  doc: Pick<ConfigurationDocument, 'secret'>,
  now: Date
): CertificateExpiry | null {
  const certificate = doc.secret?.certificate;
  const notAfter = parseDate(certificate?.notAfter);
  if (!certificate || !notAfter) {
    return null;
  }
  const notBefore = parseDate(certificate.notBefore);
  const left = notAfter.getTime() - now.getTime();
  return {
    notAfter: certificate.notAfter,
    daysLeft: Math.ceil(left / DAY_MS),
    expired: left <= 0,
    notYetValid: notBefore !== null && notBefore.getTime() > now.getTime(),
  };
}

export interface Problem {
  tone: 'error' | 'warning';
  message: string;
}

/**
 * What would stop the configuration from working on a form, or soon will: missing or outdated
 * secrets, certificates near their end, settings that need fixing. Short, with no secrets.
 */
export function configurationProblems(doc: ConfigurationDocument, now: Date): Problem[] {
  const problems: Problem[] = [];
  if (!(doc.settings[INPUT_IDS.url] ?? '').trim()) {
    problems.push({ tone: 'error', message: 'No endpoint URL yet' });
  }
  for (const problem of configProblems(parseConfig(doc.settings)).slice(0, 2)) {
    problems.push({ tone: 'error', message: problem.replace(/\.$/, '') });
  }
  const signIn = signInOf(doc.settings);
  const kind = neededSecretKind(doc.settings);
  if (kind) {
    if (!doc.secret && passwordOptional(doc.settings)) {
      // It works: forms send the user name alone, as before 4.0. Said in case one is missing.
      problems.push({ tone: 'warning', message: 'Password not set: sends the user name only' });
    } else if (!doc.secret) {
      problems.push({ tone: 'error', message: 'Secret not set' });
    } else if (doc.secret.kind !== kind) {
      problems.push({ tone: 'error', message: 'Secret doesn’t fit the sign-in method' });
    } else if (secretBindingProblem(doc.secret.boundOrigin, doc.settings, doc.secret.apiOrigin)) {
      problems.push({ tone: 'error', message: 'Address changed: enter the secret again' });
    }
  }
  if (
    signIn.method === 'oauth2' &&
    isMicrosoftEntraTokenUrl(parseOAuthSettings(doc.settings[INPUT_IDS.oauth]).settings.tokenUrl)
  ) {
    // An error, as under the field: the editor won't save it, and forms can't get a token.
    problems.push({ tone: 'error', message: ENTRA_REFUSES_BROWSER });
  }
  const expiry = certificateExpiry(doc, now);
  if (expiry?.expired) {
    problems.push({ tone: 'error', message: 'Certificate expired' });
  } else if (expiry?.notYetValid) {
    problems.push({ tone: 'warning', message: 'Certificate isn’t valid yet' });
  } else if (expiry && expiry.daysLeft <= EXPIRY_WARNING_DAYS) {
    problems.push({
      tone: 'warning',
      message:
        expiry.daysLeft <= 1
          ? 'Certificate expires within a day'
          : `Certificate expires in ${countOf(expiry.daysLeft, 'day')}`,
    });
  }
  return problems;
}

/**
 * The status line, like “api.contoso.com · OAuth 2.0 with a certificate · expires 12 Mar 2027 ·
 * used by 3 controls”. `usage` is null while the controls are still being counted.
 */
export function statusSentence(
  doc: ConfigurationDocument,
  usage: number | null,
  now: Date
): string {
  const parts = [endpointHost(doc.settings) || 'no endpoint yet', describeSignIn(doc)];
  const expiry = certificateExpiry(doc, now);
  if (expiry) {
    parts.push(
      `${expiry.expired ? 'expired' : 'expires'} ${formatDay(expiry.notAfter, now, true, true)}`
    );
  }
  if (usage !== null) {
    parts.push(
      usage === 0 ? 'not used by any control yet' : `used by ${countOf(usage, 'control')}`
    );
  }
  return parts.filter(Boolean).join(' · ');
}

/** “Shared with Contoso Agile, Contoso Scrum · changed by Ana Díaz, 22 Oct”. */
export function sharingLine(
  doc: ConfigurationDocument,
  processName: (processId: string) => string | undefined,
  now: Date
): string {
  const names = doc.processIds
    .map((id) => processName(id))
    .filter((name): name is string => Boolean(name));
  const removed = doc.processIds.length - names.length;
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  if (removed > 0) {
    shown.push(countOf(removed, 'deleted process', 'deleted processes'));
  }
  const parts = [`Shared with ${joinNames(shown)}`];
  const when = formatDay(doc.updatedAt, now);
  if (doc.updatedBy && when) {
    parts.push(`changed by ${doc.updatedBy}, ${when}`);
  } else if (doc.updatedBy) {
    parts.push(`changed by ${doc.updatedBy}`);
  } else if (when) {
    parts.push(`changed ${when}`);
  }
  return parts.join(' · ');
}

/** What a control in a process layout uses, from its inputs and the configurations. */
export type Assignment =
  /** It uses `configuration`, maybe by one of its former names. */
  | {
      kind: 'assigned';
      configuration: ConfigurationDocument;
      formerName: string | null;
      leftovers: boolean;
    }
  /** It names a configuration this process doesn't have (or more than one answers to it). */
  | { kind: 'unknown'; name: string; message: string; leftovers: boolean }
  /** It keeps its settings in the process editor, as before 4.0. */
  | { kind: 'legacy' }
  | { kind: 'empty' };

export function assignmentOf(
  docs: readonly ConfigurationDocument[],
  control: LayoutControl
): Assignment {
  const status = controlStatus(control);
  if (status.kind !== 'configured') {
    return status;
  }
  try {
    const configuration = findConfigurationForProcess(
      docs,
      control.processId,
      control.processName,
      status.configuration
    );
    return {
      kind: 'assigned',
      configuration,
      formerName:
        nameKey(configuration.name) === nameKey(status.configuration) ? null : status.configuration,
      leftovers: status.leftovers,
    };
  } catch (error) {
    const reason = toUserMessage(error);
    const name = quoteName(status.configuration);
    return {
      kind: 'unknown',
      name: status.configuration,
      message: reason.startsWith('More than one')
        ? `More than one configuration answers to ${name}`
        : reason.startsWith('The configuration')
          ? `${name} isn’t shared with this process`
          : `No configuration named ${name}`,
      leftovers: status.leftovers,
    };
  }
}

/** How many scanned controls use each configuration, by configuration id. */
export function usageCounts(
  docs: readonly ConfigurationDocument[],
  controls: readonly LayoutControl[]
): Map<string, number> {
  const counts = new Map<string, number>();
  // Each process's configurations are picked out once, not once per control. Only what's shared
  // with the process can be assigned, so the others don't change the count.
  const shared = new Map<string, ConfigurationDocument[]>();
  for (const control of controls) {
    let here = shared.get(control.processId);
    if (!here) {
      here = docs.filter((doc) => doc.processIds.includes(control.processId));
      shared.set(control.processId, here);
    }
    const assignment = assignmentOf(here, control);
    if (assignment.kind === 'assigned') {
      const { id } = assignment.configuration;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** The scanned controls that use `doc`, by its name or a former one. */
export function controlsUsing(
  docs: readonly ConfigurationDocument[],
  controls: readonly LayoutControl[],
  doc: Pick<ConfigurationDocument, 'id'>
): LayoutControl[] {
  return controls.filter((control) => {
    const assignment = assignmentOf(docs, control);
    return assignment.kind === 'assigned' && assignment.configuration.id === doc.id;
  });
}

/**
 * A name for a copy that no configuration uses in those processes: “Customers copy”, then
 * “Customers copy 2”, “Customers copy 3” and so on.
 */
export function copyName(
  docs: readonly ConfigurationDocument[],
  name: string,
  processIds: readonly string[]
): string {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? ' copy' : ` copy ${attempt}`;
    const candidate = `${shortenName(name.trim(), CONFIGURATION_LIMITS.maxNameLength - suffix.length)}${suffix}`;
    if (findNameConflicts(docs, { name: candidate, processIds }).length === 0) {
      return candidate;
    }
  }
}

/** The scanned controls that name exactly `name` (ignoring case), such as a former name. */
export function controlsNaming(
  controls: readonly LayoutControl[],
  name: string,
  processIds: readonly string[]
): LayoutControl[] {
  const key = nameKey(name);
  return controls.filter((control) => {
    const status = controlStatus(control);
    return (
      status.kind === 'configured' &&
      processIds.includes(control.processId) &&
      nameKey(status.configuration) === key
    );
  });
}
