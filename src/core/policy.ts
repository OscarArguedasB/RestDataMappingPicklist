import type { AdvancedSettings, AuthMethod } from './config';
import { AUTH_METHOD_LABELS, AUTH_METHODS, LIMITS } from './config';
import { isPlainObject } from './values';

/** Version 2 (4.0) added OAuth 2.0. Version 1 policies are still read: see parsePolicy. */
export const POLICY_VERSION = 2;

/**
 * The organization's security policy, set by an administrator in Organization settings ›
 * REST Picklist. It can only tighten the protections built into the control, never loosen them.
 */
export interface SecurityPolicy {
  version: typeof POLICY_VERSION;
  /** Host names the control may call, such as api.contoso.com or *.service-now.com. Empty: any. */
  allowedHosts: string[];
  allowedAuthMethods: AuthMethod[];
  /** Allows http://localhost and http://127.0.0.1 for testing. */
  allowLocalhost: boolean;
  /** Blocks loopback, private and link-local addresses and names like *.local. */
  blockPrivateNetworks: boolean;
  maxPages: number;
  maxItems: number;
  timeoutSeconds: number;
  /**
   * Whether controls set up before 4.0 may use 3.0 saved configurations. Kept for those controls
   * only: 4.0 has no setting for it, so it stays on unless a 3.0 policy turned it off.
   */
  allowSavedConfigurations: boolean;
  /** Informational: who saved the policy last and when (ISO 8601). */
  changedBy?: string;
  changedAt?: string;
}

export const DEFAULT_POLICY: SecurityPolicy = {
  version: POLICY_VERSION,
  allowedHosts: [],
  allowedAuthMethods: [...AUTH_METHODS],
  allowLocalhost: false,
  blockPrivateNetworks: false,
  maxPages: LIMITS.maxPages.max,
  maxItems: LIMITS.maxItems.max,
  timeoutSeconds: LIMITS.timeoutSeconds.max,
  allowSavedConfigurations: true,
};

function clampNumber(value: unknown, limits: { min: number; max: number }, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(limits.max, Math.max(limits.min, Math.round(value)))
    : fallback;
}

function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === 'string' && (AUTH_METHODS as readonly string[]).includes(value);
}

/** The sign-in methods REST Picklist had before OAuth 2.0 (policy version 1). */
const VERSION_1_METHODS: readonly AuthMethod[] = ['none', 'basic', 'bearer', 'apiKey'];

/**
 * Reads a stored policy. Anything missing or malformed falls back to the default for that key.
 * A version 1 policy that allowed every sign-in method of its time also allows OAuth 2.0, since
 * it restricted nothing; any other version 1 list stays as it was saved.
 */
export function parsePolicy(value: unknown): SecurityPolicy {
  if (!isPlainObject(value)) {
    return DEFAULT_POLICY;
  }
  const hosts = Array.isArray(value.allowedHosts)
    ? value.allowedHosts
        .filter((host): host is string => typeof host === 'string')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const stored = Array.isArray(value.allowedAuthMethods)
    ? value.allowedAuthMethods.filter(isAuthMethod)
    : DEFAULT_POLICY.allowedAuthMethods;
  const version1 = typeof value.version !== 'number' || value.version < POLICY_VERSION;
  const methods: AuthMethod[] =
    version1 && VERSION_1_METHODS.every((method) => stored.includes(method))
      ? [...stored, 'oauth2']
      : stored;
  return {
    version: POLICY_VERSION,
    allowedHosts: [...new Set(hosts)],
    allowedAuthMethods: [...new Set(methods)],
    allowLocalhost: value.allowLocalhost === true,
    blockPrivateNetworks: value.blockPrivateNetworks === true,
    maxPages: clampNumber(value.maxPages, LIMITS.maxPages, DEFAULT_POLICY.maxPages),
    maxItems: clampNumber(value.maxItems, LIMITS.maxItems, DEFAULT_POLICY.maxItems),
    timeoutSeconds: clampNumber(
      value.timeoutSeconds,
      LIMITS.timeoutSeconds,
      DEFAULT_POLICY.timeoutSeconds
    ),
    allowSavedConfigurations: value.allowSavedConfigurations !== false,
    changedBy: typeof value.changedBy === 'string' ? value.changedBy.slice(0, 200) : undefined,
    changedAt: typeof value.changedAt === 'string' ? value.changedAt.slice(0, 40) : undefined,
  };
}

// Enforcement. Host names are compared the way the browser will use them: every name goes through
// the URL parser first, so case, trailing dots, internationalized names, IPv6 spellings and
// numeric IPv4 forms such as 0x7f.1 all reach one canonical form before any comparison.

/** Hosts that http:// may reach when the policy allows local testing. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Name suffixes that only resolve inside a private network. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * The canonical host (IPv6 in brackets) and port, as the browser reads `text` in a URL. Null when
 * `text` is anything more than a host with an optional port.
 */
function parseHost(text: string): { host: string; port: string } | null {
  let candidate = text.trim().toLowerCase();
  if (!candidate) {
    return null;
  }
  // A bare IPv6 address has several colons; a single colon starts a port.
  if (!candidate.startsWith('[') && candidate.indexOf(':') !== candidate.lastIndexOf(':')) {
    candidate = `[${candidate}]`;
  }
  let url: URL;
  try {
    url = new URL(`https://${candidate}/`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return null;
  }
  const host = stripTrailingDot(url.hostname);
  return host ? { host, port: url.port } : null;
}

/** The four numbers of a dotted-decimal IPv4 address, or null. Plain loops, no regex. */
function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) {
      return null;
    }
    for (const char of part) {
      if (char < '0' || char > '9') {
        return null;
      }
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

function parseHexGroup(text: string): number | null {
  if (text.length === 0 || text.length > 4) {
    return null;
  }
  let value = 0;
  for (const char of text.toLowerCase()) {
    const digit = '0123456789abcdef'.indexOf(char);
    if (digit === -1) {
      return null;
    }
    value = value * 16 + digit;
  }
  return value;
}

/** Parses colon-separated hex groups; a dotted IPv4 tail counts as two groups. */
function parseGroups(parts: readonly string[], allowIPv4Tail: boolean): number[] | null {
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (allowIPv4Tail && index === parts.length - 1 && part.includes('.')) {
      const octets = parseIPv4(part);
      if (!octets) {
        return null;
      }
      const [a = 0, b = 0, c = 0, d = 0] = octets;
      groups.push(a * 256 + b, c * 256 + d);
      continue;
    }
    const group = parseHexGroup(part);
    if (group === null) {
      return null;
    }
    groups.push(group);
  }
  return groups;
}

/** The eight 16-bit groups of an IPv6 address written without brackets, or null. */
function parseIPv6(text: string): number[] | null {
  if (text.length < 2 || text.length > 45) {
    return null;
  }
  const gap = text.indexOf('::');
  if (gap === -1) {
    const groups = parseGroups(text.split(':'), true);
    return groups?.length === 8 ? groups : null;
  }
  if (text.includes('::', gap + 1)) {
    return null;
  }
  const headText = text.slice(0, gap);
  const tailText = text.slice(gap + 2);
  const head = headText ? parseGroups(headText.split(':'), false) : [];
  const tail = tailText ? parseGroups(tailText.split(':'), true) : [];
  if (!head || !tail || head.length + tail.length > 7) {
    return null;
  }
  const zeros = Array.from({ length: 8 - head.length - tail.length }, () => 0);
  return [...head, ...zeros, ...tail];
}

function isPrivateIPv4([a = 0, b = 0]: readonly number[]): boolean {
  return (
    a === 0 || // "this network", including 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier-grade NAT, VPNs)
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) {
    return true; // unique local, link-local and the deprecated site-local range
  }
  // ::a.b.c.d (which covers :: and ::1), ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d
  // (IPv4-translated) reach the embedded IPv4 address.
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (zeroPrefix && ((g4 === 0 && (g5 === 0 || g5 === 0xffff)) || (g4 === 0xffff && g5 === 0))) {
    return isPrivateIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return false;
}

function isIPLiteral(host: string): boolean {
  return host.startsWith('[') || parseIPv4(host) !== null;
}

/**
 * True when `hostname` matches an allowed-host pattern, ignoring case. "*.contoso.com" matches
 * subdomains at any depth (a.contoso.com, a.b.contoso.com) but not contoso.com itself; any other
 * pattern must match exactly. Patterns with a port or a misplaced wildcard never match.
 */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = parseHost(hostname)?.host;
  const trimmed = pattern.trim();
  if (!host || !trimmed) {
    return false;
  }
  if (trimmed.startsWith('*.')) {
    const suffix = parseHost(trimmed.slice(2));
    if (!suffix || suffix.port || suffix.host.includes('*') || isIPLiteral(suffix.host)) {
      return false;
    }
    return (
      !isIPLiteral(host) && host.length > suffix.host.length + 1 && host.endsWith(`.${suffix.host}`)
    );
  }
  const exact = parseHost(trimmed);
  return Boolean(exact && !exact.port && !exact.host.includes('*') && exact.host === host);
}

/** Explains what's wrong with an allowed-host pattern typed in the policy editor, or null. */
export function validateHostPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return 'Enter a host name, for example api.contoso.com.';
  }
  if (trimmed.includes('/')) {
    return `Enter just the host name, without https:// or a path, for example api.contoso.com.`;
  }
  const wildcard = trimmed.startsWith('*.');
  const name = wildcard ? trimmed.slice(2) : trimmed;
  if (name.includes('*')) {
    return 'A wildcard can only start the name, for example *.contoso.com.';
  }
  const parsed = parseHost(name);
  if (!parsed) {
    return `“${trimmed}” isn’t a valid host name.`;
  }
  if (parsed.port) {
    return `Leave out the port in “${trimmed}”. Any port on an allowed host can be used.`;
  }
  if (wildcard && isIPLiteral(parsed.host)) {
    return 'Wildcards work with names only, not with IP addresses.';
  }
  if (wildcard && !parsed.host.includes('.')) {
    return `“${trimmed}” would allow too many sites. Add at least one more part, for example *.contoso.com.`;
  }
  return null;
}

/**
 * True for names and addresses that only exist inside a private network: localhost, single-label
 * intranet names, *.localhost, *.local, *.internal, *.home.arpa, the loopback, private,
 * link-local and shared (CGNAT) IPv4 ranges, 0.0.0.0/8, ::, ::1, fc00::/7, fe80::/10, fec0::/10,
 * and IPv4-mapped IPv6 forms of those. A public name that resolves to a private address can't be
 * detected in the browser.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = parseHost(hostname)?.host ?? stripTrailingDot(hostname.trim().toLowerCase());
  if (!host) {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIPv6(host.slice(1, -1));
    return groups !== null && isPrivateIPv6(groups);
  }
  const octets = parseIPv4(host);
  if (octets) {
    return isPrivateIPv4(octets);
  }
  if (host.includes(':')) {
    const groups = parseIPv6(host);
    return groups !== null && isPrivateIPv6(groups);
  }
  // Single-label names such as "intranet" resolve through the local network's DNS suffix.
  if (host === 'localhost' || !host.includes('.')) {
    return true;
  }
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Checks a URL against the built-in rules and the organization's policy. Returns null when the
 * control may call it, otherwise a reason written for the person who set it up.
 */
export function checkEndpoint(url: string | URL, policy: SecurityPolicy): string | null {
  return checkUrl(url, policy, { url: 'The endpoint URL', https: 'The endpoint' });
}

/**
 * Checks an OAuth 2.0 access token URL with the same rules as checkEndpoint, since the client's
 * secret is sent there. The messages name the token URL.
 */
export function checkTokenUrl(url: string | URL, policy: SecurityPolicy): string | null {
  return checkUrl(url, policy, { url: 'The access token URL', https: 'The access token URL' });
}

function checkUrl(
  url: string | URL,
  policy: SecurityPolicy,
  names: { url: string; https: string }
): string | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return `${names.url} isn’t valid.`;
  }
  if (parsed.username || parsed.password) {
    return 'Remove the user name and password from the URL and use the sign-in settings instead.';
  }
  const host = parsed.hostname;
  const loopback = LOOPBACK_HOSTS.has(host);
  // Allowing localhost is an explicit choice for testing, so the host list and the private
  // network block don't undo it.
  if (loopback && policy.allowLocalhost && ['http:', 'https:'].includes(parsed.protocol)) {
    return null;
  }
  if (parsed.protocol === 'http:' && loopback) {
    return 'Your organization’s security policy doesn’t allow http://localhost. Use https://, or ask an administrator to allow localhost for testing.';
  }
  if (parsed.protocol !== 'https:') {
    return `${names.https} must use https://.`;
  }
  if (
    policy.allowedHosts.length > 0 &&
    !policy.allowedHosts.some((pattern) => hostMatches(host, pattern))
  ) {
    // Said with the way out: on the setup page the policy is one tab away, but only for
    // collection administrators, and on a form nobody can change it.
    return `${host} isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.`;
  }
  if (policy.blockPrivateNetworks && isPrivateHost(host)) {
    return `${host} is a private network address, and your organization’s security policy blocks those.`;
  }
  return null;
}

function listWithOr(items: readonly string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`
    : (items[0] ?? '');
}

/** Null when the organization allows the sign-in method, otherwise why it can't be used. */
export function checkAuthMethod(method: AuthMethod, policy: SecurityPolicy): string | null {
  if (policy.allowedAuthMethods.includes(method)) {
    return null;
  }
  const allowed = AUTH_METHODS.filter((item) => policy.allowedAuthMethods.includes(item)).map(
    (item) => AUTH_METHOD_LABELS[item]
  );
  if (allowed.length === 0) {
    return 'Your organization’s security policy doesn’t allow any sign-in method, so the list can’t load. Ask an administrator to update the policy.';
  }
  if (method === 'none') {
    return `Your organization’s security policy requires signing in to the API. Use ${listWithOr(allowed)}.`;
  }
  return `Your organization’s security policy doesn’t allow the “${AUTH_METHOD_LABELS[method]}” sign-in method. Use ${listWithOr(allowed)}.`;
}

// A malformed setting falls back to its default; a malformed policy value to the built-in cap.
function capped(
  own: number,
  organization: number,
  limits: { default: number; min: number; max: number }
): number {
  return Math.min(
    clampNumber(own, limits, limits.default),
    clampNumber(organization, limits, limits.max)
  );
}

/** The limits one control works with: its own settings, capped by the organization's policy. */
export function effectiveLimits(
  advanced: AdvancedSettings,
  policy: SecurityPolicy
): { maxPages: number; maxItems: number; timeoutMs: number } {
  const pagesSetting =
    advanced.paging.type === 'none' ? LIMITS.maxPages.default : advanced.paging.maxPages;
  return {
    maxPages: capped(pagesSetting, policy.maxPages, LIMITS.maxPages),
    maxItems: capped(advanced.maxItems, policy.maxItems, LIMITS.maxItems),
    timeoutMs: capped(advanced.timeoutSeconds, policy.timeoutSeconds, LIMITS.timeoutSeconds) * 1000,
  };
}
