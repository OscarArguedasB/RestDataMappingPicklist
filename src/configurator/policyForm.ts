import type { AuthMethod } from '../core/config';
import { AUTH_METHODS } from '../core/config';
import type { SecurityPolicy } from '../core/policy';
import { parsePolicy, validateHostPattern } from '../core/policy';

/**
 * The security policy as the form edits it: allowed hosts as text, one per line. The 3.0
 * “saved configurations” switch isn't edited anymore; saving keeps whatever is stored.
 */
export interface PolicyForm {
  allowedHosts: string;
  allowedAuthMethods: AuthMethod[];
  allowLocalhost: boolean;
  blockPrivateNetworks: boolean;
  maxPages: number;
  maxItems: number;
  timeoutSeconds: number;
}

export interface PolicyIssues {
  /** One message per bad line, like “Line 2: …”. */
  hosts: string[];
  methods: string | null;
}

export function policyToForm(policy: SecurityPolicy): PolicyForm {
  return {
    allowedHosts: policy.allowedHosts.join('\n'),
    allowedAuthMethods: [...policy.allowedAuthMethods],
    allowLocalhost: policy.allowLocalhost,
    blockPrivateNetworks: policy.blockPrivateNetworks,
    maxPages: policy.maxPages,
    maxItems: policy.maxItems,
    timeoutSeconds: policy.timeoutSeconds,
  };
}

function hostLines(text: string): Array<{ line: number; host: string }> {
  return text
    .split(/\r?\n/)
    .map((host, index) => ({ line: index + 1, host: host.trim() }))
    .filter((entry) => entry.host);
}

export function validatePolicyForm(form: PolicyForm): PolicyIssues {
  const hosts = hostLines(form.allowedHosts).flatMap(({ line, host }) => {
    const problem = validateHostPattern(host);
    return problem ? [`Line ${line}: ${problem}`] : [];
  });
  const methods =
    form.allowedAuthMethods.length === 0
      ? 'Allow at least one sign-in method, or every list stops loading.'
      : null;
  return { hosts, methods };
}

export function hasPolicyIssues(issues: PolicyIssues): boolean {
  return issues.hosts.length > 0 || issues.methods !== null;
}

/**
 * The policy to save, keeping what the form doesn't edit from `base`. parsePolicy normalizes it
 * exactly as readers will (case, duplicates).
 */
export function formToPolicy(form: PolicyForm, base: SecurityPolicy): SecurityPolicy {
  return parsePolicy({
    ...base,
    allowedHosts: hostLines(form.allowedHosts).map((entry) => entry.host),
    allowedAuthMethods: AUTH_METHODS.filter((method) => form.allowedAuthMethods.includes(method)),
    allowLocalhost: form.allowLocalhost,
    blockPrivateNetworks: form.blockPrivateNetworks,
    maxPages: form.maxPages,
    maxItems: form.maxItems,
    timeoutSeconds: form.timeoutSeconds,
  });
}

function rules(policy: SecurityPolicy): string {
  return JSON.stringify({
    ...policy,
    allowedAuthMethods: AUTH_METHODS.filter((method) => policy.allowedAuthMethods.includes(method)),
    changedBy: undefined,
    changedAt: undefined,
  });
}

/** Same rules, ignoring who changed them and when. */
export function samePolicy(a: SecurityPolicy, b: SecurityPolicy): boolean {
  return rules(a) === rules(b);
}
