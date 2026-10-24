import { describe, expect, it } from 'vitest';
import { RSA_2048 } from '../core/__fixtures__/credentials';
import type { SecretSummary } from '../core/secrets';
import {
  assignmentOf,
  configurationProblems,
  controlsNaming,
  controlsUsing,
  copyName,
  countOf,
  describeSignIn,
  endpointHost,
  formatDay,
  joinNames,
  sharingLine,
  statusSentence,
  usageCounts,
} from './configurationStatus';
import { configuration, layoutControl } from './testUtils';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const OAUTH_CERTIFICATE = {
  RestServiceAddress: 'https://api.contoso.com/customers',
  AuthMethod: 'OAuth 2.0',
  OAuthSettings:
    '{"tokenUrl":"https://auth.contoso.com/oauth2/token","clientId":"picklist","clientAuthentication":"privateKeyJwt"}',
};

function certificateSecret(notAfter: Date, notBefore = new Date(NOW.getTime() - 300 * DAY)) {
  return {
    kind: 'signingKey',
    boundOrigin: 'https://auth.contoso.com',
    algorithm: 'RS256',
    certificate: {
      ...RSA_2048.info,
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
    },
  } satisfies SecretSummary;
}

function withSettings(settings: Record<string, string>, secret: SecretSummary | null = null) {
  return configuration('X', { settings, secret });
}

function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function withCertificate(notAfter: Date, notBefore?: Date) {
  return configuration('Cert', {
    settings: OAUTH_CERTIFICATE,
    secret: certificateSecret(notAfter, notBefore),
  });
}

function messages(doc: Parameters<typeof configurationProblems>[0]): string[] {
  return configurationProblems(doc, NOW).map((problem) => `${problem.tone}: ${problem.message}`);
}

/** A Contoso Agile control that names a configuration. */
function uses(name: string, extra: Record<string, string> = {}, controlId = name) {
  return layoutControl({
    controlId,
    inputs: { FieldName: 'Custom.Customer', Configuration: name, ...extra },
  });
}

/** A control in a process that names “Customers”. */
function inProcess(processId: string, controlId: string) {
  return layoutControl({
    processId,
    controlId,
    inputs: { FieldName: 'F', Configuration: 'Customers' },
  });
}

describe('status text', () => {
  it('counts and joins like a sentence', () => {
    expect(countOf(1, 'control')).toBe('1 control');
    expect(countOf(1200, 'control')).toBe('1,200 controls');
    expect(countOf(2, 'process', 'processes')).toBe('2 processes');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('formats days without the year when it’s this year', () => {
    expect(formatDay('2026-10-22T14:03:00.000Z', NOW)).toBe('22 Oct');
    expect(formatDay('2025-03-12T10:00:00.000Z', NOW)).toBe('12 Mar 2025');
    expect(formatDay('2026-03-12T10:00:00.000Z', NOW, true)).toBe('12 Mar 2026');
    expect(formatDay('not a date', NOW)).toBe('');
  });

  it('shows the endpoint host, never credentials in it', () => {
    expect(endpointHost({ RestServiceAddress: 'https://api.contoso.com/customers?q=1' })).toBe(
      'api.contoso.com'
    );
    expect(endpointHost({ RestServiceAddress: 'https://$(Custom.Region).contoso.com/x' })).toBe(
      '$(Custom.Region).contoso.com'
    );
    expect(endpointHost({ RestServiceAddress: 'https://ada:secret@api.contoso.com/' })).toBe(
      'api.contoso.com'
    );
    expect(endpointHost({})).toBe('');
  });

  it('shows the host requests actually go to, as the browser’s URL parser reads it', () => {
    // A backslash ends the host for https, so this calls evil.example, not good.example.
    expect(endpointHost({ RestServiceAddress: 'https://evil.example\\@good.example/items' })).toBe(
      'evil.example'
    );
    // Tabs and line breaks are dropped by the parser.
    expect(endpointHost({ RestServiceAddress: 'https://good.exa\tmple/items' })).toBe(
      'good.example'
    );
    expect(endpointHost({ RestServiceAddress: 'https://api.\ncontoso.com/' })).toBe(
      'api.contoso.com'
    );
    expect(endpointHost({ RestServiceAddress: 'https://API.Contoso.com:8443/x' })).toBe(
      'api.contoso.com:8443'
    );
    expect(
      endpointHost({ RestServiceAddress: 'https://$(Custom.Region).$(Custom.Zone).contoso.com/' })
    ).toBe('$(Custom.Region).$(Custom.Zone).contoso.com');
    // What can't be parsed shows nothing rather than a guess.
    expect(endpointHost({ RestServiceAddress: 'api.contoso.com/items' })).toBe('');
    expect(endpointHost({ RestServiceAddress: 'https://exa mple.com/' })).toBe('');
  });

  it('names the sign-in in a few words', () => {
    expect(describeSignIn(withSettings({}))).toBe('no sign-in');
    expect(describeSignIn(withSettings({ AuthMethod: 'Basic' }))).toBe('Basic sign-in');
    expect(describeSignIn(withSettings({ AuthMethod: 'Bearer token' }))).toBe('bearer token');
    expect(describeSignIn(withSettings({ AuthMethod: 'API key' }))).toBe('API key');
    expect(describeSignIn(withSettings({ AuthMethod: 'OAuth 2.0' }))).toBe(
      'OAuth 2.0 with a client secret'
    );
    expect(describeSignIn(withSettings(OAUTH_CERTIFICATE))).toBe('OAuth 2.0 with a certificate');
    expect(
      describeSignIn(
        withSettings(OAUTH_CERTIFICATE, {
          kind: 'signingKey',
          boundOrigin: 'https://auth.contoso.com',
          keyId: 'k1',
        })
      )
    ).toBe('OAuth 2.0 with a private key');
    expect(describeSignIn(withSettings({ AuthMethod: 'Kerberos' }))).toBe('unknown sign-in method');
  });

  it('reads like the design’s status line', () => {
    const doc = configuration('Customers API', {
      settings: OAUTH_CERTIFICATE,
      secret: certificateSecret(new Date('2027-03-12T12:00:00.000Z')),
    });
    expect(statusSentence(doc, 3, NOW)).toBe(
      'api.contoso.com · OAuth 2.0 with a certificate · expires 12 Mar 2027 · used by 3 controls'
    );
    expect(statusSentence(configuration('Plain', { settings: {} }), null, NOW)).toBe(
      'no endpoint yet · no sign-in'
    );
    expect(statusSentence(configuration('Unused'), 0, NOW)).toMatch(
      /· not used by any control yet$/
    );
    expect(statusSentence(configuration('One'), 1, NOW)).toMatch(/· used by 1 control$/);
  });

  it('says who it’s shared with and who changed it', () => {
    const names: Record<string, string> = {
      'p-contoso': 'Contoso Agile',
      'p-fabrikam': 'Fabrikam',
    };
    const doc = configuration('Customers', {
      processIds: ['p-contoso', 'p-fabrikam', 'p-gone'],
      updatedBy: 'Ana Díaz',
      updatedAt: '2026-10-22T14:03:00.000Z',
    });
    expect(sharingLine(doc, (id) => names[id], NOW)).toBe(
      'Shared with Contoso Agile, Fabrikam and 1 deleted process · changed by Ana Díaz, 22 Oct'
    );
    expect(
      sharingLine(
        configuration('X', { updatedBy: undefined, updatedAt: '2025-01-05T12:00:00.000Z' }),
        (id) => names[id],
        NOW
      )
    ).toBe('Shared with Contoso Agile · changed 5 Jan 2025');
  });
});

describe('problems', () => {
  it('finds nothing wrong with a working configuration', () => {
    expect(messages(configuration('Fine'))).toEqual([]);
  });

  it('reports missing, mismatched and outdated secrets', () => {
    expect(messages(configuration('A', { settings: { RestServiceAddress: '' } }))).toEqual([
      'error: No endpoint URL yet',
    ]);
    const bearer = { RestServiceAddress: 'https://api.contoso.com/x', AuthMethod: 'Bearer token' };
    expect(messages(configuration('B', { settings: bearer }))).toEqual(['error: Secret not set']);
    expect(
      messages(
        configuration('C', {
          settings: bearer,
          secret: { kind: 'apiKey', boundOrigin: 'https://api.contoso.com' },
        })
      )
    ).toEqual(['error: Secret doesn’t fit the sign-in method']);
    expect(
      messages(
        configuration('D', {
          settings: bearer,
          secret: { kind: 'token', boundOrigin: 'https://old.contoso.com' },
        })
      )
    ).toEqual(['error: Address changed: enter the secret again']);
    expect(
      messages(
        configuration('E', {
          settings: bearer,
          secret: { kind: 'token', boundOrigin: 'https://api.contoso.com' },
        })
      )
    ).toEqual([]);
  });

  it('warns about certificates that expire soon, or did', () => {
    expect(messages(withCertificate(after(12 * DAY - 1000)))).toEqual([
      'warning: Certificate expires in 12 days',
    ]);
    expect(messages(withCertificate(after(3600_000)))).toEqual([
      'warning: Certificate expires within a day',
    ]);
    expect(messages(withCertificate(after(31 * DAY)))).toEqual([]);
    expect(messages(withCertificate(after(-DAY)))).toEqual(['error: Certificate expired']);
    expect(messages(withCertificate(after(300 * DAY), after(DAY)))).toEqual([
      'warning: Certificate isn’t valid yet',
    ]);
  });

  it('takes Basic with a user name and no password as working, with a note', () => {
    // Forms send the user name alone, as before 4.0 (some APIs take a key as the user name).
    const userOnly = configuration('U', {
      settings: {
        RestServiceAddress: 'https://api.contoso.com/x',
        AuthMethod: 'Basic',
        RestServiceUserName: 'sk_live',
      },
    });
    expect(messages(userOnly)).toEqual(['warning: Password not set: sends the user name only']);
    expect(
      messages(
        configuration('B', {
          settings: { RestServiceAddress: 'https://api.contoso.com/x', AuthMethod: 'Basic' },
        })
      )
    ).toEqual(['error: Secret not set']);
  });

  it('writes dates like the editor does, with certificate dates in UTC', () => {
    const now = new Date('2026-10-22T12:00:00.000Z');
    expect(formatDay('2027-10-01T00:00:00.000Z', now, true, true)).toBe('1 Oct 2027');
    expect(formatDay('2026-09-30T12:00:00.000Z', now)).toBe('30 Sep');
  });

  it('flags OAuth settings that need fixing and Microsoft Entra token URLs', () => {
    expect(
      messages(
        configuration('O', {
          settings: { RestServiceAddress: 'https://api.contoso.com/x', AuthMethod: 'OAuth 2.0' },
        })
      )
    ).toEqual([
      'error: Add the access token URL for OAuth 2.0',
      'error: Add the client ID for OAuth 2.0',
      'error: Secret not set',
    ]);
    const entra = configuration('Entra', {
      settings: {
        RestServiceAddress: 'https://api.contoso.com/x',
        AuthMethod: 'OAuth 2.0',
        OAuthSettings:
          '{"tokenUrl":"https://login.microsoftonline.com/contoso/oauth2/v2.0/token","clientId":"app"}',
      },
      secret: { kind: 'clientSecret', boundOrigin: 'https://login.microsoftonline.com' },
    });
    expect(messages(entra)).toEqual([
      // An error, as under the field: it can't be saved and can't work.
      'error: Microsoft Entra ID refuses client credentials sent from a browser',
    ]);
  });
});

describe('controls', () => {
  const customers = configuration('Customers API', { aliases: ['Customers'] });
  const tickets = configuration('Tickets');
  const elsewhere = configuration('Regions', { processIds: ['p-fabrikam'] });
  const docs = [customers, tickets, elsewhere];

  it('tells what each control uses', () => {
    expect(assignmentOf(docs, uses('customers api'))).toEqual(
      expect.objectContaining({ kind: 'assigned', configuration: customers, formerName: null })
    );
    expect(assignmentOf(docs, uses('Customers'))).toEqual(
      expect.objectContaining({ kind: 'assigned', formerName: 'Customers', leftovers: false })
    );
    expect(assignmentOf(docs, uses('Vendors'))).toEqual({
      kind: 'unknown',
      name: 'Vendors',
      message: 'No configuration named “Vendors”',
      leftovers: false,
    });
    expect(assignmentOf(docs, uses('Regions'))).toEqual(
      expect.objectContaining({
        kind: 'unknown',
        message: '“Regions” isn’t shared with this process',
      })
    );
    expect(
      assignmentOf(docs, uses('Tickets', { RestServiceAddress: 'https://old.example.com' }))
    ).toEqual(expect.objectContaining({ kind: 'assigned', leftovers: true }));
    expect(
      assignmentOf(docs, layoutControl({ inputs: { RestServiceAddress: 'https://x.example' } }))
    ).toEqual({ kind: 'legacy' });
    expect(assignmentOf(docs, layoutControl())).toEqual({ kind: 'empty' });
  });

  it('counts the controls that use each configuration, by any of its names', () => {
    const controls = [
      uses('Customers API', {}, 'a'),
      uses('customers', {}, 'b'),
      uses('Tickets', {}, 'c'),
    ];
    expect(usageCounts(docs, controls)).toEqual(
      new Map([
        [customers.id, 2],
        [tickets.id, 1],
      ])
    );
    expect(controlsUsing(docs, controls, customers).map((control) => control.controlId)).toEqual([
      'a',
      'b',
    ]);
    expect(
      controlsNaming(controls, 'CUSTOMERS', ['p-contoso']).map((control) => control.controlId)
    ).toEqual(['b']);
    expect(controlsNaming(controls, 'Customers', ['p-fabrikam'])).toEqual([]);
  });

  it('counts each process’s controls against what’s shared with that process', () => {
    const agile = configuration('Customers', { id: 'c-agile', processIds: ['p-contoso'] });
    const scrum = configuration('Customers', { id: 'c-scrum', processIds: ['p-fabrikam'] });
    const controls = [
      inProcess('p-contoso', 'a'),
      inProcess('p-fabrikam', 'b'),
      inProcess('p-fabrikam', 'c'),
      inProcess('p-gone', 'd'),
    ];
    expect(usageCounts([agile, scrum], controls)).toEqual(
      new Map([
        ['c-agile', 1],
        ['c-scrum', 2],
      ])
    );
  });

  it('names copies so they’re unique in their processes', () => {
    const existing = [
      configuration('Customers'),
      configuration('Customers copy'),
      configuration('Other copy', { aliases: ['Customers copy 2'] }),
    ];
    expect(copyName(existing, 'Customers', ['p-contoso'])).toBe('Customers copy 3');
    expect(copyName(existing, 'Customers', ['p-fabrikam'])).toBe('Customers copy');
    expect(copyName([], 'x'.repeat(100), ['p-contoso'])).toHaveLength(100);
  });
});
