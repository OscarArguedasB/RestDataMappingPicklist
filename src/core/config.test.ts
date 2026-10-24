import { describe, expect, it } from 'vitest';
import type { OAuthSettings } from './config';
import {
  AUTH_METHODS,
  AUTH_METHOD_LABELS,
  DEFAULT_ADVANCED,
  DEFAULT_OAUTH,
  configProblems,
  formatAdvancedSettings,
  formatOAuthSettings,
  mergeSavedInputs,
  oauthSettingsProblems,
  parseAdvancedSettings,
  parseAuthMethod,
  parseConfig,
  parseOAuthSettings,
  pickSavedInputs,
  secretApiOrigin,
  secretBindingProblem,
  secretDestinationOrigin,
  secretKindFor,
  validateTokenParameterName,
} from './config';

function oauth(overrides: Partial<OAuthSettings>): OAuthSettings {
  return { ...DEFAULT_OAUTH, extraParams: {}, ...overrides };
}

function clientAuthenticationOf(value: string) {
  return parseOAuthSettings(JSON.stringify({ clientAuthentication: value })).settings
    .clientAuthentication;
}

/** Settings that send a secret to the API at `url`. */
function apiSettings(authMethod: string, url = 'https://api.contoso.com/items?q=$(Custom.Q)') {
  return { AuthMethod: authMethod, RestServiceAddress: url };
}

/** Settings that send a client secret to `tokenUrl`. */
function tokenSettings(tokenUrl: string) {
  return {
    AuthMethod: 'OAuth 2.0',
    RestServiceAddress: 'https://api.contoso.com/items',
    OAuthSettings: JSON.stringify({ tokenUrl, clientId: 'picklist' }),
  };
}

describe('parseAuthMethod', () => {
  it('reads the dropdown and common spellings', () => {
    expect(parseAuthMethod('Bearer token', '', 't').method).toBe('bearer');
    expect(parseAuthMethod('API key', '', 'k').method).toBe('apiKey');
    expect(parseAuthMethod('x-api-key', '', 'k').method).toBe('apiKey');
    expect(parseAuthMethod('basic', 'ana', 'p').method).toBe('basic');
    expect(parseAuthMethod('None', '', '').method).toBe('none');
  });

  it('reads OAuth 2.0 in the spellings people use', () => {
    for (const spelling of [
      'OAuth 2.0',
      'oauth2',
      'OAuth',
      'OAUTH 2',
      'oauth-2.0',
      'client_credentials',
      'Client credentials',
    ]) {
      expect({ spelling, ...parseAuthMethod(spelling, '', '') }).toEqual({
        spelling,
        method: 'oauth2',
        error: null,
      });
    }
    // Stored as its label, which reads back as the same method.
    expect(parseAuthMethod(AUTH_METHOD_LABELS.oauth2, '', '').method).toBe('oauth2');
    expect(AUTH_METHODS).toEqual(['none', 'basic', 'bearer', 'apiKey', 'oauth2']);
  });

  it('keeps the older rules when no method is set', () => {
    expect(parseAuthMethod('', 'Bearer', 't').method).toBe('bearer');
    expect(parseAuthMethod('', 'ana', 'p').method).toBe('basic');
    expect(parseAuthMethod('', '', '').method).toBe('none');
  });

  it('treats “None” next to filled-in credentials as an older control', () => {
    // The process editor may store the dropdown's first choice when an older control is saved.
    expect(parseAuthMethod('None', 'Bearer', 't').method).toBe('bearer');
    expect(parseAuthMethod('None', 'ana', 'p').method).toBe('basic');
  });

  it('reports unknown methods', () => {
    const result = parseAuthMethod('Kerberos', '', '');
    expect(result.method).toBe('none');
    expect(result.error).toBe(
      '“Kerberos” isn’t a sign-in method. Use None, Basic, Bearer token, API key or OAuth 2.0.'
    );
    expect(parseAuthMethod('OAuth 1.0a', '', '').error).toMatch(/isn’t a sign-in method/);
  });
});

describe('secretKindFor', () => {
  it('names the secret each sign-in method needs', () => {
    expect(secretKindFor('none', 'basic')).toBeNull();
    expect(secretKindFor('basic', 'basic')).toBe('password');
    expect(secretKindFor('bearer', 'privateKeyJwt')).toBe('token');
    expect(secretKindFor('apiKey')).toBe('apiKey');
    expect(secretKindFor('oauth2', 'basic')).toBe('clientSecret');
    expect(secretKindFor('oauth2', 'body')).toBe('clientSecret');
    expect(secretKindFor('oauth2', 'privateKeyJwt')).toBe('signingKey');
    expect(secretKindFor('oauth2')).toBe('clientSecret');
  });
});

describe('OAuth 2.0 settings', () => {
  it('parse every setting and trim text', () => {
    const { settings, error } = parseOAuthSettings(
      JSON.stringify({
        tokenUrl: ' https://auth.contoso.com/oauth2/token ',
        clientId: ' picklist ',
        scope: 'read write',
        audience: 'https://api.contoso.com',
        resource: 'urn:contoso:api',
        clientAuthentication: 'privateKeyJwt',
        assertionAudience: 'https://auth.contoso.com',
        extraParams: { tenant: 'contoso', 'x-region': 'eu' },
        unknownKey: 'ignored',
      })
    );
    expect(error).toBeNull();
    expect(settings).toEqual({
      tokenUrl: 'https://auth.contoso.com/oauth2/token',
      clientId: 'picklist',
      scope: 'read write',
      audience: 'https://api.contoso.com',
      resource: 'urn:contoso:api',
      clientAuthentication: 'privateKeyJwt',
      assertionAudience: 'https://auth.contoso.com',
      extraParams: { tenant: 'contoso', 'x-region': 'eu' },
    });
  });

  it('use the defaults when nothing is set', () => {
    for (const raw of [undefined, '', '  \n ']) {
      expect(parseOAuthSettings(raw)).toEqual({ settings: DEFAULT_OAUTH, error: null });
    }
    // Each parse gets its own object, so changing one never changes the defaults.
    const { settings } = parseOAuthSettings('');
    settings.extraParams.tenant = 'changed';
    expect(DEFAULT_OAUTH.extraParams).toEqual({});
  });

  it('report JSON that isn’t an object', () => {
    expect(parseOAuthSettings('{')).toEqual({
      settings: DEFAULT_OAUTH,
      error: 'OAuth 2.0 settings aren’t valid JSON.',
    });
    for (const raw of ['[]', '"https://auth.contoso.com"', '42', 'null']) {
      expect(parseOAuthSettings(raw).error).toBe('OAuth 2.0 settings must be a JSON object { … }.');
    }
  });

  it('fall back setting by setting, explaining each problem', () => {
    const { settings, error } = parseOAuthSettings(
      JSON.stringify({
        tokenUrl: 42,
        clientId: 'picklist',
        scope: ['read'],
        clientAuthentication: 'mtls',
        audience: null,
      })
    );
    expect(settings).toEqual({ ...DEFAULT_OAUTH, clientId: 'picklist' });
    expect(error).toBe(
      'OAuth 2.0 settings: “tokenUrl” must be text. “scope” must be text. “clientAuthentication” must be "basic", "body" or "privateKeyJwt".'
    );
  });

  it('accept the standard names for client authentication', () => {
    expect(clientAuthenticationOf('client_secret_basic')).toBe('basic');
    expect(clientAuthenticationOf('client_secret_post')).toBe('body');
    expect(clientAuthenticationOf('private_key_jwt')).toBe('privateKeyJwt');
    expect(clientAuthenticationOf('body')).toBe('body');
    expect(parseOAuthSettings('{"clientAuthentication":"client_secret_jwt"}').error).toMatch(
      /must be "basic", "body" or "privateKeyJwt"/
    );
  });

  it('keep only extra parameters that can be sent', () => {
    // Written out by hand: an object literal can't have a "__proto__" key.
    const { settings, error } = parseOAuthSettings(
      `{"extraParams":{"tenant":"contoso"," padded ":"kept","Client_Secret":"stolen?",` +
        `"scope":"admin","grant_type":"password","has space":"x","":"x","__proto__":"x",` +
        `"count":3,"flag":true}}`
    );
    expect(settings.extraParams).toEqual({ tenant: 'contoso', padded: 'kept' });
    expect(Object.getPrototypeOf(settings.extraParams)).toBe(Object.prototype);
    expect(error).toContain(
      '“Client_Secret” can’t be an extra token parameter. REST Picklist sends the secret itself.'
    );
    expect(error).toContain('“scope” can’t be an extra token parameter. Use the Scope setting');
    expect(error).toContain('“grant_type” can’t be an extra token parameter.');
    expect(error).toContain('“has space” isn’t a valid parameter name.');
    expect(error).toContain('Enter a name for each extra token parameter.');
    expect(error).toContain('“__proto__” isn’t a valid parameter name.');
    expect(error).toContain('The extra token parameter “count” must be text.');
    expect(error).toContain('The extra token parameter “flag” must be text.');
  });

  it('refuse extra parameters that aren’t an object, or too many of them', () => {
    expect(parseOAuthSettings('{"extraParams":["tenant"]}').error).toMatch(
      /“extraParams” must be an object/
    );
    expect(parseOAuthSettings('{"extraParams":"tenant=contoso"}').settings.extraParams).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`p${index}`, 'v']));
    const { settings, error } = parseOAuthSettings(JSON.stringify({ extraParams: many }));
    expect(Object.keys(settings.extraParams)).toHaveLength(20);
    expect(settings.extraParams).toHaveProperty('p19', 'v');
    expect(settings.extraParams).not.toHaveProperty('p20');
    expect(error).toBe('OAuth 2.0 settings: Use at most 20 extra token parameters.');
    // Trimming can make two names the same; the first one wins.
    expect(parseOAuthSettings('{"extraParams":{"a":"1"," a":"2"}}')).toMatchObject({
      settings: { extraParams: { a: '1' } },
      error: 'OAuth 2.0 settings: “a” is listed twice in the extra token parameters.',
    });
  });

  it('explain what’s wrong with a parameter name', () => {
    expect(validateTokenParameterName('tenant_id')).toBeNull();
    expect(validateTokenParameterName('x.region-1')).toBeNull();
    expect(validateTokenParameterName(' ')).toBe('Enter a name for each extra token parameter.');
    expect(validateTokenParameterName('RESOURCE')).toBe(
      '“RESOURCE” can’t be an extra token parameter. Use the Resource setting instead.'
    );
    expect(validateTokenParameterName('client_assertion_type')).toMatch(/REST Picklist sets it/);
    expect(validateTokenParameterName('a=b')).toMatch(/isn’t a valid parameter name/);
    expect(validateTokenParameterName('tenant[]')).toMatch(/isn’t a valid parameter name/);
    expect(validateTokenParameterName(`bad\u0000${'x'.repeat(100)}`)).toBe(
      `“bad ${'x'.repeat(36)}…” isn’t a valid parameter name. Use letters, digits, dots, hyphens and underscores.`
    );
    expect(validateTokenParameterName('a'.repeat(101))).toBe(
      'Parameter names can have at most 100 characters.'
    );
  });

  it('round-trip, leaving out defaults', () => {
    const settings = oauth({
      tokenUrl: 'https://auth.contoso.com/oauth2/token',
      clientId: 'picklist',
      scope: 'read',
      clientAuthentication: 'body',
      extraParams: { tenant: 'contoso' },
    });
    const formatted = formatOAuthSettings(settings);
    expect(formatted).toBe(
      '{"tokenUrl":"https://auth.contoso.com/oauth2/token","clientId":"picklist","scope":"read","clientAuthentication":"body","extraParams":{"tenant":"contoso"}}'
    );
    expect(parseOAuthSettings(formatted)).toEqual({ settings, error: null });
    expect(formatOAuthSettings(DEFAULT_OAUTH)).toBe('');
    expect(formatOAuthSettings(oauth({ scope: '  ', extraParams: { ' ': 'x' } }))).toBe('');
  });

  it('write the shape kept in configuration documents', () => {
    const stored =
      '{"tokenUrl":"https://auth.contoso.com/oauth2/token","clientId":"picklist","clientAuthentication":"privateKeyJwt"}';
    expect(formatOAuthSettings(parseOAuthSettings(stored).settings)).toBe(stored);
    expect(
      formatOAuthSettings(
        oauth({ tokenUrl: ' https://a.example/token ', assertionAudience: ' https://a.example ' })
      )
    ).toBe('{"tokenUrl":"https://a.example/token","assertionAudience":"https://a.example"}');
  });

  it('report what’s missing, and extra parameters set by hand', () => {
    expect(oauthSettingsProblems(DEFAULT_OAUTH)).toEqual([
      'Add the access token URL for OAuth 2.0.',
      'Add the client ID for OAuth 2.0.',
    ]);
    expect(
      oauthSettingsProblems(
        oauth({
          tokenUrl: 'https://auth.contoso.com/token',
          clientId: 'picklist',
          extraParams: { client_id: 'other' },
        })
      )
    ).toEqual([
      '“client_id” can’t be an extra token parameter. Use the Client ID setting instead.',
    ]);
  });
});

describe('where a secret is sent', () => {
  it('is the API’s origin for Basic, bearer tokens and API keys', () => {
    expect(secretDestinationOrigin(apiSettings('Basic'))).toBe('https://api.contoso.com');
    expect(secretDestinationOrigin(apiSettings('Bearer token'))).toBe('https://api.contoso.com');
    expect(
      secretDestinationOrigin(apiSettings('API key', 'https://API.Contoso.com:443/$(A)'))
    ).toBe('https://api.contoso.com');
    expect(secretDestinationOrigin(apiSettings('API key', 'https://api.contoso.com:8443/a'))).toBe(
      'https://api.contoso.com:8443'
    );
    expect(secretDestinationOrigin(apiSettings('Basic', 'https://bücher.example/a'))).toBe(
      'https://xn--bcher-kva.example'
    );
    expect(secretDestinationOrigin(apiSettings('Basic', 'http://localhost:3000/a'))).toBe(
      'http://localhost:3000'
    );
    // Older setups: no method, but a user name means Basic.
    expect(
      secretDestinationOrigin({
        RestServiceAddress: 'https://api.contoso.com/a',
        RestServiceUserName: 'svc',
      })
    ).toBe('https://api.contoso.com');
  });

  it('is the token URL’s origin for OAuth 2.0', () => {
    expect(secretDestinationOrigin(tokenSettings('https://auth.contoso.com/oauth2/token'))).toBe(
      'https://auth.contoso.com'
    );
    expect(secretDestinationOrigin(tokenSettings(''))).toBeNull();
    expect(secretDestinationOrigin(tokenSettings('https://$(Custom.Host)/token'))).toBeNull();
    expect(
      secretDestinationOrigin({ AuthMethod: 'OAuth 2.0', OAuthSettings: '{ not json' })
    ).toBeNull();
  });

  it('is nowhere when nothing is sent, or the address can’t receive a secret', () => {
    expect(secretDestinationOrigin(apiSettings('None'))).toBeNull();
    expect(secretDestinationOrigin(apiSettings('Kerberos'))).toBeNull();
    expect(secretDestinationOrigin(apiSettings('Basic', 'http://api.contoso.com/a'))).toBeNull();
    expect(secretDestinationOrigin(apiSettings('Basic', 'https://$(Custom.Host)/a'))).toBeNull();
    expect(
      secretDestinationOrigin(apiSettings('Basic', 'https://u:p@api.contoso.com/a'))
    ).toBeNull();
    expect(secretDestinationOrigin(apiSettings('Basic', 'api.contoso.com/a'))).toBeNull();
    expect(secretDestinationOrigin(apiSettings('Basic', ''))).toBeNull();
    expect(secretDestinationOrigin({})).toBeNull();
  });

  it('must still be where the secret was saved for', () => {
    const settings = apiSettings('Basic');
    expect(secretBindingProblem('https://api.contoso.com', settings)).toBeNull();
    expect(secretBindingProblem('https://old.contoso.com', settings)).toBe(
      'This configuration’s address changed after its secret was saved. Ask an administrator to enter the secret again.'
    );
    const oauthSettings = tokenSettings('https://auth.contoso.com/oauth2/token');
    expect(secretBindingProblem('https://auth.contoso.com', oauthSettings)).toBeNull();
    expect(secretBindingProblem('https://api.contoso.com', oauthSettings)).toMatch(
      /address changed/
    );
    expect(secretBindingProblem('https://api.contoso.com', apiSettings('None'))).toMatch(
      /address changed/
    );
  });

  it('binds an OAuth 2.0 secret to the API its tokens go to, when saved with one', () => {
    // The secret only goes to the token URL; the tokens it gets go to the API.
    const viaToken = tokenSettings('https://auth.contoso.com/oauth2/token');
    expect(secretApiOrigin(viaToken)).toBe('https://api.contoso.com');
    expect(secretApiOrigin(apiSettings('Basic'))).toBeNull();
    expect(
      secretBindingProblem('https://auth.contoso.com', viaToken, 'https://api.contoso.com')
    ).toBeNull();
    const repointed = {
      ...viaToken,
      RestServiceAddress: 'https://collector.example.net/customers',
    };
    expect(
      secretBindingProblem('https://auth.contoso.com', repointed, 'https://api.contoso.com')
    ).toMatch(/address changed/);
    // Secrets saved before the API was bound only check the token URL.
    expect(secretBindingProblem('https://auth.contoso.com', repointed)).toBeNull();
  });
});

describe('saved configurations', () => {
  const saved = {
    RestServiceAddress: 'https://api.example.com/customers',
    AuthMethod: 'Bearer token',
    RestServiceKeyField: 'name',
    AdvancedSettings: '{"copyMode":"first","maxItems":500}',
  };

  it('fill in what the control leaves empty; the control’s own values win', () => {
    const merged = mergeSavedInputs(
      {
        RestServiceKeyField: 'code',
        AdvancedSettings: '{"maxItems":50}',
        RestServicePassword: 't',
      },
      saved
    );
    expect(merged.RestServiceAddress).toBe(saved.RestServiceAddress);
    expect(merged.RestServiceKeyField).toBe('code');
    expect(JSON.parse(String(merged.AdvancedSettings))).toEqual({
      copyMode: 'first',
      maxItems: 50,
    });
    expect(merged.RestServicePassword).toBe('t');
  });

  it('don’t let a stored “None” hide the saved sign-in method', () => {
    expect(mergeSavedInputs({ AuthMethod: 'None' }, saved).AuthMethod).toBe('Bearer token');
    expect(mergeSavedInputs({ AuthMethod: 'API key' }, saved).AuthMethod).toBe('API key');
    expect(mergeSavedInputs({ AuthMethod: 'OAuth' }, saved).AuthMethod).toBe('OAuth');
  });

  it('never carry credentials', () => {
    expect(
      pickSavedInputs({ ...saved, RestServiceUserName: 'ana', RestServicePassword: 'secret' })
    ).toEqual(saved);
  });
});

describe('advanced settings', () => {
  it('round-trips and leaves out defaults', () => {
    const { settings, error } = parseAdvancedSettings(
      '{"paging":{"type":"offset","offsetParam":"sysparm_offset","limitParam":"sysparm_limit","limit":1000},"copyMode":"first"}'
    );
    expect(error).toBeNull();
    expect(parseAdvancedSettings(formatAdvancedSettings(settings)).settings).toEqual(settings);
    expect(formatAdvancedSettings(DEFAULT_ADVANCED)).toBe('');
  });

  it('reports problems and falls back to defaults', () => {
    expect(parseAdvancedSettings('{').error).toMatch(/valid JSON/);
    const { settings, error } = parseAdvancedSettings(
      '{"paging":{"type":"magic"},"apiKeyHeader":"Cookie","maxItems":999999}'
    );
    expect(error).toMatch(/paging\.type/);
    expect(error).toMatch(/Cookie header can’t be used/);
    expect(settings.paging.type).toBe('none');
    expect(settings.maxItems).toBe(50_000);
  });
});

describe('parseConfig', () => {
  it('hides the old “Bearer” user name and reads the new inputs', () => {
    const config = parseConfig({
      RestServiceUserName: 'Bearer',
      RestServicePassword: 't',
      AllowMultiple: 'true',
      SecondLineProperty: ' email ',
      SaveConfiguration: 'True',
    });
    expect(config.authMethod).toBe('bearer');
    expect(config.username).toBe('');
    expect(config.allowMultiple).toBe(true);
    expect(config.secondLineProperty).toBe('email');
    expect(config.saveConfiguration).toBe(true);
  });

  it('reads the configuration name and the OAuth 2.0 settings', () => {
    const config = parseConfig({
      FieldName: 'Custom.Customer',
      Configuration: ' Customers API ',
      AuthMethod: 'OAuth 2.0',
      OAuthSettings: '{"tokenUrl":"https://auth.contoso.com/token","clientId":"picklist"}',
    });
    expect(config).toMatchObject({
      fieldName: 'Custom.Customer',
      configuration: 'Customers API',
      authMethod: 'oauth2',
      username: '',
      oauth: { tokenUrl: 'https://auth.contoso.com/token', clientId: 'picklist' },
      oauthError: null,
    });
    expect(configProblems(config)).toEqual([]);
    expect(parseConfig(undefined)).toMatchObject({
      configuration: '',
      oauth: DEFAULT_OAUTH,
      oauthError: null,
    });
  });
});

describe('configProblems', () => {
  it('reports OAuth 2.0 problems only when the configuration uses OAuth 2.0', () => {
    const broken = { OAuthSettings: '{ broken' };
    expect(configProblems(parseConfig({ ...broken, AuthMethod: 'Bearer token' }))).toEqual([]);
    expect(configProblems(parseConfig({ ...broken, AuthMethod: 'OAuth 2.0' }))).toEqual([
      'OAuth 2.0 settings aren’t valid JSON.',
      'Add the access token URL for OAuth 2.0.',
      'Add the client ID for OAuth 2.0.',
    ]);
    expect(
      configProblems(
        parseConfig({
          AuthMethod: 'oauth2',
          OAuthSettings: '{"tokenUrl":"https://auth.contoso.com/token"}',
        })
      )
    ).toEqual(['Add the client ID for OAuth 2.0.']);
  });

  it('lists every problem with the settings', () => {
    expect(
      configProblems(
        parseConfig({ AuthMethod: 'Kerberos', FieldMap: '[1]', AdvancedSettings: '{' })
      )
    ).toHaveLength(3);
  });
});
