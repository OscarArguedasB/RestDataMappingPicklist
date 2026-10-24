import { describe, expect, it } from 'vitest';
import { DEFAULT_ADVANCED, DEFAULT_OAUTH } from '../core/config';
import { DEFAULT_POLICY, parsePolicy } from '../core/policy';
import type { CertificateInfo, SecretSummary } from '../core/secrets';
import type { CredentialState, Draft } from './settings';
import {
  EMPTY_DRAFT,
  ENTRA_TOKEN_URL_PROBLEM,
  KEY_MOVED,
  SECRET_MOVED,
  blocksRequest,
  certificateWarnings,
  describeSecretChange,
  describeSignIn,
  draftFromSettings,
  draftToSettings,
  effectiveOAuth,
  formatDay,
  keyIdProblem,
  missingRequired,
  pagingForType,
  planSecret,
  sameSettings,
  saveProblems,
  secretDestination,
  secretKindOf,
  summarizeBehavior,
  summarizeFieldMap,
  summarizeMultiple,
  summarizeOAuthAdvanced,
  summarizePaging,
  validateDraft,
} from './settings';

const FULL_SETTINGS = {
  RestServiceAddress: 'https://api.contoso.com/customers',
  RestCallParameters: '{ "region": "$(Custom.Region)" }',
  AuthMethod: 'API key',
  PathToArray: 'data.result',
  RestServiceKeyField: 'name',
  SecondLineProperty: 'email',
  FieldMap: '{ "Custom.CustomerId": "id" }',
  AllowMultiple: 'true',
  LoadOnFormOpen: 'true',
  Required: 'true',
  ErrorMessage: 'This customer is no longer active.',
  AdvancedSettings:
    '{"paging":{"type":"nextLink","nextLink":"@odata.nextLink"},"apiKeyHeader":"X-Api-Token","copyMode":"first","maxItems":500,"timeoutSeconds":10}',
};

const OAUTH_SETTINGS = {
  RestServiceAddress: 'https://api.contoso.com/customers',
  AuthMethod: 'OAuth 2.0',
  OAuthSettings:
    '{"tokenUrl":"https://auth.contoso.com/oauth2/token","clientId":"picklist","scope":"api://picklist/.default","clientAuthentication":"privateKeyJwt","assertionAudience":"https://auth.contoso.com","extraParams":{"tenant":"contoso"}}',
};

function draft(patch: Partial<Draft> = {}): Draft {
  return { ...EMPTY_DRAFT, url: 'https://api.contoso.com/items', ...patch };
}

function oauthDraft(patch: Partial<Draft['oauth']> = {}, rest: Partial<Draft> = {}): Draft {
  return draft({
    authMethod: 'oauth2',
    oauth: {
      ...DEFAULT_OAUTH,
      tokenUrl: 'https://auth.contoso.com/oauth2/token',
      clientId: 'picklist',
      extraParams: {},
      ...patch,
    },
    ...rest,
  });
}

function summary(patch: Partial<SecretSummary> = {}): SecretSummary {
  return { kind: 'password', boundOrigin: 'https://api.contoso.com', ...patch };
}

function credentials(patch: Partial<CredentialState> = {}): CredentialState {
  return { stored: null, entered: false, removing: false, ...patch };
}

describe('draftFromSettings and draftToSettings', () => {
  it('round-trips every setting, including the advanced settings', () => {
    const { draft: read, problems } = draftFromSettings(FULL_SETTINGS);
    expect(problems).toEqual([]);
    expect(read.authMethod).toBe('apiKey');
    expect(read.advanced.paging).toEqual({
      type: 'nextLink',
      nextLink: '@odata.nextLink',
      maxPages: 10,
    });
    expect(read.advanced.apiKeyHeader).toBe('X-Api-Token');
    expect(read.advanced.copyMode).toBe('first');
    expect(read.password).toBe('');
    expect(draftToSettings(read)).toEqual(FULL_SETTINGS);
  });

  it('reads OAuth 2.0 with a certificate as the certificate credential, and writes it back', () => {
    const { draft: read, problems } = draftFromSettings(OAUTH_SETTINGS);
    expect(problems).toEqual([]);
    expect(read.authMethod).toBe('oauth2');
    expect(read.credential).toBe('certificate');
    // The client secret's choice stays at its default while a certificate is used.
    expect(read.oauth.clientAuthentication).toBe('basic');
    expect(effectiveOAuth(read).clientAuthentication).toBe('privateKeyJwt');
    expect(secretKindOf(read)).toBe('signingKey');
    expect(draftToSettings(read)).toEqual(OAUTH_SETTINGS);
  });

  it('writes a client secret’s authentication and drops what only a certificate uses', () => {
    const { draft: read } = draftFromSettings(OAUTH_SETTINGS);
    const secret: Draft = {
      ...read,
      credential: 'secret',
      oauth: { ...read.oauth, clientAuthentication: 'body' },
    };
    expect(secretKindOf(secret)).toBe('clientSecret');
    expect(JSON.parse(draftToSettings(secret).OAuthSettings ?? '')).toEqual({
      tokenUrl: 'https://auth.contoso.com/oauth2/token',
      clientId: 'picklist',
      scope: 'api://picklist/.default',
      clientAuthentication: 'body',
      extraParams: { tenant: 'contoso' },
    });
  });

  it('leaves out the OAuth 2.0 settings when another sign-in method is used', () => {
    const { draft: read } = draftFromSettings(OAUTH_SETTINGS);
    expect(draftToSettings({ ...read, authMethod: 'bearer' })).toEqual({
      RestServiceAddress: 'https://api.contoso.com/customers',
      AuthMethod: 'Bearer token',
    });
  });

  it('reads settings from 3.0: “Bearer” in the user name means a bearer token', () => {
    const { draft: read } = draftFromSettings({
      RestServiceAddress: 'https://api.contoso.com/items',
      RestServiceUserName: 'Bearer',
    });
    expect(read.authMethod).toBe('bearer');
    expect(read.username).toBe('');
    expect(draftToSettings(read)).toEqual({
      RestServiceAddress: 'https://api.contoso.com/items',
      AuthMethod: 'Bearer token',
    });
  });

  it('reports settings it had to reset', () => {
    expect(draftFromSettings({ AdvancedSettings: '{ not json' }).problems).toEqual([
      'Advanced settings aren’t valid JSON.',
    ]);
    const oauth = draftFromSettings({ AuthMethod: 'OAuth 2.0', OAuthSettings: '[1]' });
    expect(oauth.draft.oauth).toEqual(DEFAULT_OAUTH);
    expect(oauth.problems).toEqual(['OAuth 2.0 settings must be a JSON object { … }.']);
  });

  it('never writes a secret, and never reads one back', () => {
    const settings = draftToSettings(
      draft({ authMethod: 'basic', username: 'ada', password: 's3cret' })
    );
    expect(JSON.stringify(settings)).not.toContain('s3cret');
    expect(
      draftFromSettings({ ...FULL_SETTINGS, RestServicePassword: 'leaked' }).draft.password
    ).toBe('');
  });

  it('leaves out hidden leftovers: the API key header and the copy mode', () => {
    const settings = draftToSettings(
      draft({
        authMethod: 'bearer',
        allowMultiple: false,
        advanced: { ...DEFAULT_ADVANCED, apiKeyHeader: 'X-Key', copyMode: 'first' },
      })
    );
    expect(settings.AdvancedSettings).toBeUndefined();
  });

  it('compares settings by value', () => {
    expect(sameSettings({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(sameSettings({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(sameSettings({ a: '1' }, { a: '2' })).toBe(false);
  });
});

describe('validateDraft', () => {
  it('checks the endpoint and sign-in method against the policy', () => {
    const policy = parsePolicy({
      allowedHosts: ['api.contoso.com'],
      allowedAuthMethods: ['bearer'],
    });
    const issues = validateDraft(
      draft({ url: 'https://api.fabrikam.com/x', authMethod: 'basic' }),
      policy
    );
    expect(issues.url?.message).toBe(
      'api.fabrikam.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(issues.authMethod?.message).toContain('doesn’t allow the “Basic” sign-in method');
    expect(blocksRequest(issues)).toBe(true);
    expect(saveProblems(issues)).toHaveLength(2);
  });

  it('blocks http://localhost unless the policy allows it', () => {
    const local = draft({ url: 'http://localhost:5000/items' });
    expect(validateDraft(local, DEFAULT_POLICY).url?.tone).toBe('error');
    expect(validateDraft(local, parsePolicy({ allowLocalhost: true })).url).toBeUndefined();
  });

  it('needs a cursor path and paging parameter names', () => {
    const cursor = pagingForType('cursor', { type: 'none' });
    expect(
      validateDraft(draft({ advanced: { ...DEFAULT_ADVANCED, paging: cursor } }), DEFAULT_POLICY)
        .paging?.message
    ).toContain('where the next cursor is');
    const page = pagingForType('page', { type: 'none' });
    if (page.type !== 'page') {
      throw new Error('Expected page paging');
    }
    expect(
      validateDraft(
        draft({ advanced: { ...DEFAULT_ADVANCED, paging: { ...page, pageParam: ' ' } } }),
        DEFAULT_POLICY
      ).paging?.message
    ).toBe('Enter a name for each paging parameter.');
  });

  it('reports invalid JSON in the parameters and the field map, whatever the field values', () => {
    const issues = validateDraft(draft({ params: '{', fieldMap: '[1]' }), DEFAULT_POLICY);
    expect(issues.params?.tone).toBe('error');
    expect(issues.fieldMap?.tone).toBe('error');
    expect(
      validateDraft(draft({ params: '{ "q": "$(System.Title)" }' }), DEFAULT_POLICY).params
    ).toBeUndefined();
  });

  it('checks the access token URL like the endpoint, and refuses field values in it', () => {
    expect(
      validateDraft(oauthDraft({ tokenUrl: 'http://auth.contoso.com/token' }), DEFAULT_POLICY)
        .tokenUrl?.message
    ).toBe('The access token URL must use https://.');
    expect(
      validateDraft(oauthDraft({ tokenUrl: 'https://$(Custom.Host)/token' }), DEFAULT_POLICY)
        .tokenUrl?.message
    ).toBe('Field values can’t be used in the access token URL.');
    const hosts = parsePolicy({ allowedHosts: ['api.contoso.com'] });
    const issues = validateDraft(oauthDraft(), hosts);
    expect(issues.tokenUrl?.message).toBe(
      'auth.contoso.com isn’t on your organization’s list of allowed hosts. Ask a Project Collection Administrator to add it under Security policy in Organization settings › Extensions › REST Picklist.'
    );
    expect(blocksRequest(issues)).toBe(true);
    expect(validateDraft(oauthDraft(), DEFAULT_POLICY)).toEqual({});
  });

  it('says Microsoft Entra ID won’t work: saving stops, but the test can still show why', () => {
    const issues = validateDraft(
      oauthDraft({ tokenUrl: 'https://login.microsoftonline.com/contoso/oauth2/v2.0/token' }),
      DEFAULT_POLICY
    );
    expect(issues.tokenUrl).toBeUndefined();
    expect(issues.entra).toEqual({ tone: 'error', message: ENTRA_TOKEN_URL_PROBLEM });
    expect(ENTRA_TOKEN_URL_PROBLEM).toBe(
      'Microsoft Entra ID refuses client credentials sent from a browser, so this token URL won’t work. Use a token service that accepts requests from Azure DevOps.'
    );
    expect(blocksRequest(issues)).toBe(false);
    expect(saveProblems(issues)).toHaveLength(1);
  });

  it('checks the extra token parameters that would be sent', () => {
    const issues = validateDraft(
      oauthDraft({ extraParams: { client_secret: 'x' } }),
      DEFAULT_POLICY
    );
    expect(issues.oauth?.message).toBe(
      '“client_secret” can’t be an extra token parameter. REST Picklist sends the secret itself.'
    );
  });

  it('asks for the secret again when it would be sent somewhere else', () => {
    const stored = summary();
    const moved = draft({ authMethod: 'basic', url: 'https://api.fabrikam.com/items' });
    expect(validateDraft(moved, DEFAULT_POLICY, credentials({ stored })).secret).toEqual({
      tone: 'error',
      message: SECRET_MOVED,
    });
    expect(SECRET_MOVED).toBe('You changed where the secret is sent, so enter it again.');
    // Entering it again is enough; so is removing it.
    expect(
      validateDraft(moved, DEFAULT_POLICY, credentials({ stored, entered: true })).secret
    ).toBeUndefined();
    expect(
      validateDraft(moved, DEFAULT_POLICY, credentials({ stored, removing: true })).secret
    ).toBeUndefined();
    const key = summary({ kind: 'signingKey', boundOrigin: 'https://auth.contoso.com' });
    const otherTokenUrl = oauthDraft(
      { tokenUrl: 'https://login.contoso.com/token' },
      { credential: 'certificate' }
    );
    expect(
      validateDraft(otherTokenUrl, DEFAULT_POLICY, credentials({ stored: key })).secret?.message
    ).toBe(KEY_MOVED);
  });
});

describe('planSecret', () => {
  const basic = draft({ authMethod: 'basic' });

  it('keeps, saves, removes or asks again, depending on what changed', () => {
    expect(planSecret(draft(), credentials())).toBe('none');
    expect(planSecret(basic, credentials())).toBe('missing');
    expect(planSecret(basic, credentials({ entered: true }))).toBe('save');
    expect(planSecret(basic, credentials({ stored: summary() }))).toBe('keep');
    expect(planSecret(basic, credentials({ stored: summary(), removing: true }))).toBe('remove');
    expect(planSecret(basic, credentials({ stored: summary(), entered: true }))).toBe('save');
    // Signing in with nothing, or with another kind of secret, can't use the saved one.
    expect(planSecret(draft(), credentials({ stored: summary() }))).toBe('remove');
    expect(planSecret(draft({ authMethod: 'bearer' }), credentials({ stored: summary() }))).toBe(
      'remove'
    );
    expect(
      planSecret(
        draft({ authMethod: 'basic', url: 'https://api.contoso.com:8443/items' }),
        credentials({ stored: summary() })
      )
    ).toBe('reenter');
  });

  it('binds an OAuth 2.0 secret to the token URL, not the API', () => {
    const stored = summary({ kind: 'clientSecret', boundOrigin: 'https://auth.contoso.com' });
    const oauth = oauthDraft();
    expect(secretDestination(oauth)).toBe('https://auth.contoso.com');
    expect(
      planSecret({ ...oauth, url: 'https://api.fabrikam.com/x' }, credentials({ stored }))
    ).toBe('keep');
    expect(planSecret(oauthDraft({}, { credential: 'certificate' }), credentials({ stored }))).toBe(
      'remove'
    );
  });
});

describe('required settings', () => {
  it('lists the URL, and for OAuth 2.0 the token URL and client ID, while they’re empty', () => {
    expect(missingRequired(draft())).toEqual([]);
    expect(missingRequired(draft({ url: ' ' }))).toEqual(['url']);
    expect(missingRequired(oauthDraft({ tokenUrl: '', clientId: '' }))).toEqual([
      'tokenUrl',
      'clientId',
    ]);
  });
});

describe('keyIdProblem', () => {
  it('refuses key IDs that can’t go in a JWT header', () => {
    expect(keyIdProblem('2026-key')).toBeNull();
    expect(keyIdProblem('a\nb')).toBe(
      'The key ID can’t contain line breaks or other control characters.'
    );
    expect(keyIdProblem('k'.repeat(401))).toBe('The key ID can have 400 characters at most.');
  });
});

describe('summaries', () => {
  it('sums up each optional section in one line', () => {
    expect(summarizeMultiple(draft())).toBe('Off · one value per field');
    expect(
      summarizeMultiple(
        draft({
          allowMultiple: true,
          fieldMap: '{ "A": "a" }',
          advanced: { ...DEFAULT_ADVANCED, copyMode: 'first' },
        })
      )
    ).toBe('On · copies only the first');
    expect(
      summarizeFieldMap(
        draft({ fieldMap: '{ "Custom.A": "a", "Custom.B": "b", "Custom.C": "c" }' })
      )
    ).toBe('3 fields: Custom.A, Custom.B and 1 more');
    expect(summarizeFieldMap(draft({ fieldMap: '{' }))).toBe('The JSON needs fixing');
    expect(summarizePaging(draft())).toBe('One request · up to 10,000 items');
    expect(
      summarizePaging(
        draft({
          advanced: { ...DEFAULT_ADVANCED, paging: pagingForType('page', { type: 'none' }) },
        })
      )
    ).toBe('Page number · 100 per page · up to 10 pages');
    expect(summarizeBehavior(draft({ loadOnFormOpen: true, required: true }))).toBe(
      'Loads with the work item · required'
    );
  });

  it('sums up the OAuth 2.0 advanced settings', () => {
    expect(summarizeOAuthAdvanced(oauthDraft())).toBe('Nothing extra');
    expect(
      summarizeOAuthAdvanced(
        oauthDraft({ audience: 'api', assertionAudience: 'x', extraParams: { a: '1', b: '2' } })
      )
    ).toBe('Audience · 2 extra parameters');
    expect(
      summarizeOAuthAdvanced(oauthDraft({ assertionAudience: 'x' }, { credential: 'certificate' }))
    ).toBe('Assertion audience');
  });

  it('describes sign-in without secrets', () => {
    expect(describeSignIn(draft({ authMethod: 'apiKey' }))).toBe('API key (x-api-key)');
    expect(describeSignIn(oauthDraft())).toBe('OAuth 2.0 with a client secret');
    expect(describeSignIn(oauthDraft({}, { credential: 'certificate' }))).toBe(
      'OAuth 2.0 with a certificate'
    );
  });

  it('describes a saved secret by who changed it and when', () => {
    expect(
      describeSecretChange({ updatedBy: 'Ana Díaz', updatedAt: '2026-10-22T12:00:00.000Z' })
    ).toBe('Set · changed by Ana Díaz on 22 Oct 2026');
    expect(describeSecretChange({ updatedAt: '2026-10-22T12:00:00.000Z' })).toBe(
      'Set · changed on 22 Oct 2026'
    );
    expect(describeSecretChange({})).toBe('Set');
    expect(formatDay('not a date')).toBe('');
    expect(formatDay('2027-03-12T23:30:00.000Z', true)).toBe('12 Mar 2027');
  });

  it('warns about certificates that expired, aren’t valid yet or expire soon', () => {
    const info: CertificateInfo = {
      subject: 'CN=picklist',
      issuer: 'CN=picklist',
      serialNumber: '01',
      notBefore: '2026-10-01T00:00:00.000Z',
      notAfter: '2026-12-01T00:00:00.000Z',
      sha1Thumbprint: 'A'.repeat(40),
      sha256Thumbprint: 'B'.repeat(64),
    };
    expect(certificateWarnings(info, new Date('2026-10-22T12:00:00.000Z'))).toEqual([]);
    expect(certificateWarnings(info, new Date('2026-11-15T12:00:00.000Z'))).toEqual([
      'The certificate expires on 1 Dec 2026 (in 15 days).',
    ]);
    expect(certificateWarnings(info, new Date('2026-12-02T00:00:00.000Z'))).toEqual([
      'The certificate expired on 1 Dec 2026.',
    ]);
    expect(certificateWarnings(info, new Date('2026-09-01T00:00:00.000Z'))).toEqual([
      'The certificate isn’t valid until 1 Oct 2026.',
    ]);
  });
});
