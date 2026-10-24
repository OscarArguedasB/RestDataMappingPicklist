import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../core/policy';
import {
  formToPolicy,
  hasPolicyIssues,
  policyToForm,
  samePolicy,
  validatePolicyForm,
} from './policyForm';

describe('policy form', () => {
  it('round-trips a policy', () => {
    const form = policyToForm(DEFAULT_POLICY);
    expect(samePolicy(formToPolicy(form, DEFAULT_POLICY), DEFAULT_POLICY)).toBe(true);
  });

  it('validates each allowed host line with its line number', () => {
    const form = {
      ...policyToForm(DEFAULT_POLICY),
      allowedHosts: 'api.contoso.com\n\n*.com\nhttps://x.example/path',
    };
    const issues = validatePolicyForm(form);
    expect(issues.hosts).toHaveLength(2);
    expect(issues.hosts[0]).toMatch(/^Line 3: “\*\.com” would allow too many sites/);
    expect(issues.hosts[1]).toMatch(/^Line 4: Enter just the host name/);
    expect(hasPolicyIssues(issues)).toBe(true);
  });

  it('requires at least one sign-in method', () => {
    const issues = validatePolicyForm({ ...policyToForm(DEFAULT_POLICY), allowedAuthMethods: [] });
    expect(issues.methods).toBe('Allow at least one sign-in method, or every list stops loading.');
  });

  it('normalizes hosts and method order like readers do', () => {
    const policy = formToPolicy(
      {
        ...policyToForm(DEFAULT_POLICY),
        allowedHosts: ' API.Contoso.com \napi.contoso.com\n*.service-now.com',
        allowedAuthMethods: ['apiKey', 'none'],
      },
      DEFAULT_POLICY
    );
    expect(policy.allowedHosts).toEqual(['api.contoso.com', '*.service-now.com']);
    expect(policy.allowedAuthMethods).toEqual(['none', 'apiKey']);
  });

  it('keeps the 3.0 saved configurations setting as stored, since the form no longer shows it', () => {
    const stored = { ...DEFAULT_POLICY, allowSavedConfigurations: false };
    const form = policyToForm(stored);
    expect(form).not.toHaveProperty('allowSavedConfigurations');
    expect(formToPolicy({ ...form, maxPages: 5 }, stored).allowSavedConfigurations).toBe(false);
    expect(samePolicy(formToPolicy(form, stored), stored)).toBe(true);
  });

  it('offers OAuth 2.0 with the other sign-in methods', () => {
    const form = policyToForm(DEFAULT_POLICY);
    expect(form.allowedAuthMethods).toContain('oauth2');
    expect(
      formToPolicy({ ...form, allowedAuthMethods: ['oauth2'] }, DEFAULT_POLICY).allowedAuthMethods
    ).toEqual(['oauth2']);
  });

  it('ignores who changed the policy when comparing', () => {
    expect(
      samePolicy(DEFAULT_POLICY, { ...DEFAULT_POLICY, changedBy: 'Ada', changedAt: '2026-01-01' })
    ).toBe(true);
    expect(samePolicy(DEFAULT_POLICY, { ...DEFAULT_POLICY, maxPages: 5 })).toBe(false);
  });
});
