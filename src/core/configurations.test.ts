import { describe, expect, it } from 'vitest';
import type { ConfigurationDocument, PermissionSnapshot } from './configurations';
import {
  CONFIGURATION_LIMITS,
  FILE_FORMAT,
  READ_ONLY_PERMISSIONS,
  canCreateIn,
  canDeleteConfiguration,
  canEditConfiguration,
  canEditPolicy,
  canEditProcess,
  canManageAll,
  canShareWith,
  canUnshareFrom,
  cleanConfigurationName,
  configurationsForProcess,
  createConfigurationDocument,
  duplicateConfiguration,
  exportConfigurationFile,
  findConfigurationForProcess,
  findNameConflicts,
  forgetAlias,
  nameConflictMessage,
  nameKey,
  newConfigurationId,
  parseConfigurationDocument,
  parseConfigurationFile,
  permissionErrorMessage,
  permissionUnverifiedMessage,
  permissionsUnverified,
  quoteName,
  renameConfiguration,
  shortenName,
  validateConfigurationName,
} from './configurations';
import { PicklistError } from './errors';

const char = (code: number) => String.fromCodePoint(code);
const NEWLINE = char(0x0a);
const BOM = char(0xfeff);
const COMBINING_ACUTE = char(0x301);

const AGILE = 'e31fd6e1-c6af-44bb-925e-dfa71f551463';
const SCRUM = '6b724908-ef14-45cf-84f8-768b5384da45';
const BASIC = 'b8a3a935-7e91-48b8-a94c-606d37c3e9f2';
const ID = '6f1c0f3e-3f0b-4c55-9a43-0d3a6c1e9b21';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CERTIFICATE = {
  subject: 'CN=picklist',
  issuer: 'CN=picklist',
  serialNumber: '01',
  notBefore: '2026-10-01T00:00:00.000Z',
  notAfter: '2027-10-01T00:00:00.000Z',
  sha1Thumbprint: 'A1'.repeat(20),
  sha256Thumbprint: 'B2'.repeat(32),
};

const OAUTH =
  '{"tokenUrl":"https://auth.contoso.com/oauth2/token","clientId":"picklist","clientAuthentication":"privateKeyJwt"}';

// The example from the spec, as the extension data service returns it.
const STORED = {
  id: ID,
  __etag: 3,
  version: 1,
  name: 'Customers API',
  aliases: ['Customers'],
  processIds: [AGILE],
  settings: {
    RestServiceAddress: 'https://api.contoso.com/customers',
    AuthMethod: 'OAuth 2.0',
    OAuthSettings: OAUTH,
    SecondLineProperty: 'email',
    AllowMultiple: 'true',
  },
  secret: {
    kind: 'signingKey',
    boundOrigin: 'https://auth.contoso.com',
    algorithm: 'RS256',
    updatedBy: 'Ana Díaz',
    updatedAt: '2026-10-22T14:03:00.000Z',
    certificate: CERTIFICATE,
  },
  createdBy: 'Ana Díaz',
  createdAt: '2026-10-22T14:03:00.000Z',
  updatedBy: 'Ana Díaz',
  updatedAt: '2026-10-22T14:03:00.000Z',
};

function doc(
  name: string,
  processIds: string[],
  extra: Partial<ConfigurationDocument> = {}
): ConfigurationDocument {
  return {
    id: `id-${nameKey(name).replace(/[^a-z0-9]+/g, '-')}-${processIds.length}`,
    version: 1,
    name,
    aliases: [],
    processIds,
    settings: { RestServiceAddress: `https://api.contoso.com/${encodeURIComponent(name)}` },
    secret: null,
    ...extra,
  };
}

function withStored(changes: Record<string, unknown>): unknown {
  return { ...STORED, ...changes };
}

describe('parseConfigurationDocument', () => {
  it('reads a stored configuration', () => {
    expect(parseConfigurationDocument(STORED)).toEqual(STORED);
  });

  it('reads one that went through JSON, as the host sends it', () => {
    expect(parseConfigurationDocument(JSON.parse(JSON.stringify(STORED)))).toEqual(STORED);
  });

  it('rejects anything that can’t be a configuration', () => {
    const rejected: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [STORED],
      withStored({ id: undefined }),
      withStored({ id: '' }),
      withStored({ id: 7 }),
      withStored({ id: 'x'.repeat(51) }),
      withStored({ id: '../secrets/other' }),
      withStored({ id: 'a b' }),
      withStored({ version: 2 }),
      withStored({ version: '1' }),
      withStored({ version: undefined }),
      withStored({ name: undefined }),
      withStored({ name: '   ' }),
      withStored({ name: 5 }),
      withStored({ name: 'x'.repeat(101) }),
      withStored({ name: `Two${NEWLINE}lines` }),
      withStored({ name: `Invoice${char(0x202e)}fdp.exe` }),
      withStored({ processIds: undefined }),
      withStored({ processIds: AGILE }),
      withStored({ processIds: [] }),
      withStored({ processIds: [5, null, '', '../p', 'a b', { id: AGILE }] }),
      withStored({ processIds: Array.from({ length: 1001 }, (_, index) => `p${index}`) }),
      withStored({ settings: undefined }),
      withStored({ settings: null }),
      withStored({ settings: ['RestServiceAddress'] }),
      withStored({ settings: 'RestServiceAddress=https://evil.example' }),
    ];
    for (const value of rejected) {
      expect(parseConfigurationDocument(value)).toBeNull();
    }
  });

  it('keeps only known settings with text values', () => {
    const parsed = parseConfigurationDocument(
      withStored({
        settings: {
          RestServiceAddress: 'https://api.contoso.com/customers',
          RestServicePassword: 'p@ssw0rd',
          SavedConfiguration: 'Other',
          FieldName: 'Custom.Customer',
          Evil: '<script>',
          PathToArray: 5,
          RestServiceKeyField: { name: 'x' },
          SecondLineProperty: true,
          ErrorMessage: '   ',
          AllowMultiple: ' TRUE ',
          Required: 'false',
          LoadOnFormOpen: 'yes',
          FieldMap: 'x'.repeat(CONFIGURATION_LIMITS.maxSettingLength),
          AdvancedSettings: 'x'.repeat(CONFIGURATION_LIMITS.maxSettingLength + 1),
        },
      })
    );
    expect(parsed?.settings).toEqual({
      RestServiceAddress: 'https://api.contoso.com/customers',
      AllowMultiple: 'true',
      FieldMap: 'x'.repeat(CONFIGURATION_LIMITS.maxSettingLength),
    });
  });

  it('isn’t fooled by __proto__ keys', () => {
    const parsed = parseConfigurationDocument(
      JSON.parse(
        `{ "id": "c1", "version": 1, "name": "A", "processIds": ["${AGILE}"], "__proto__": { "secret": { "kind": "token" } }, "settings": { "__proto__": { "RestServiceAddress": "https://evil.example" }, "PathToArray": "data" } }`
      )
    );
    expect(parsed?.settings).toEqual({ PathToArray: 'data' });
    expect(Object.getPrototypeOf(parsed?.settings)).toBe(Object.prototype);
    expect(parsed?.secret).toBeNull();
    // Inherited settings don't count either.
    const inherited = parseConfigurationDocument(
      withStored({ settings: Object.create({ RestServiceAddress: 'https://evil.example' }) })
    );
    expect(inherited?.settings).toEqual({});
  });

  it('keeps valid former names: no duplicates, at most five', () => {
    const many = [
      'customers api',
      'Old',
      ' old ',
      7,
      '',
      `Bad${NEWLINE}name`,
      'B',
      'C',
      'D',
      'E',
      'F',
    ];
    expect(parseConfigurationDocument(withStored({ aliases: many }))?.aliases).toEqual([
      'Old',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(parseConfigurationDocument(withStored({ aliases: 'Old' }))?.aliases).toEqual([]);
    // Junk doesn't take long to skip.
    const junk = Array.from({ length: 100_000 }, () => 1);
    expect(parseConfigurationDocument(withStored({ aliases: junk }))?.aliases).toEqual([]);
  });

  it('cleans up process ids', () => {
    expect(
      parseConfigurationDocument(withStored({ processIds: [` ${AGILE} `, AGILE, '../x', SCRUM] }))
        ?.processIds
    ).toEqual([AGILE, SCRUM]);
  });

  it('composes names and trims them', () => {
    const parsed = parseConfigurationDocument(
      withStored({ name: `  Cafe${COMBINING_ACUTE} API `, aliases: [`Cafe${COMBINING_ACUTE}`] })
    );
    expect(parsed?.name).toBe('Café API');
    expect(parsed?.aliases).toEqual(['Café']);
  });

  it('drops a secret summary that doesn’t check out', () => {
    for (const secret of [
      { kind: 'signingKey', boundOrigin: 'http://auth.contoso.com' },
      { kind: 'magic', boundOrigin: 'https://auth.contoso.com' },
      'set',
      undefined,
      null,
    ]) {
      expect(parseConfigurationDocument(withStored({ secret }))?.secret).toBeNull();
    }
    expect(
      parseConfigurationDocument(
        withStored({
          secret: { kind: 'password', boundOrigin: 'https://api.contoso.com', value: 'x' },
        })
      )?.secret
    ).toEqual({ kind: 'password', boundOrigin: 'https://api.contoso.com' });
  });

  it('drops stamps and versions that aren’t valid', () => {
    const parsed = parseConfigurationDocument(
      withStored({
        __etag: Number.POSITIVE_INFINITY,
        createdBy: `Ana${NEWLINE}Díaz`,
        createdAt: 'yesterday',
        updatedBy: 'x'.repeat(201),
        updatedAt: 1_760_000_000_000,
      })
    );
    expect(parsed).not.toHaveProperty('__etag');
    expect(parsed).not.toHaveProperty('createdBy');
    expect(parsed).not.toHaveProperty('createdAt');
    expect(parsed).not.toHaveProperty('updatedBy');
    expect(parsed).not.toHaveProperty('updatedAt');
    expect(parseConfigurationDocument(withStored({ __etag: '3' }))).not.toHaveProperty('__etag');
  });

  it('accepts the longest valid name and id', () => {
    const parsed = parseConfigurationDocument(
      withStored({ id: 'x'.repeat(50), name: 'n'.repeat(100) })
    );
    expect(parsed).toMatchObject({ id: 'x'.repeat(50), name: 'n'.repeat(100) });
  });
});

describe('names', () => {
  it('compares names ignoring case, spaces around them and composition', () => {
    expect(nameKey('  Café API ')).toBe(nameKey(`cafe${COMBINING_ACUTE} api`));
    expect(nameKey('A  B')).not.toBe(nameKey('A B'));
  });

  it('explains names that can’t be used', () => {
    expect(validateConfigurationName('Customers API')).toBeNull();
    expect(validateConfigurationName('Kunden 🧾')).toBeNull();
    expect(validateConfigurationName('n'.repeat(100))).toBeNull();
    expect(validateConfigurationName('  ')).toBe('Enter a name for the configuration.');
    expect(validateConfigurationName('n'.repeat(101))).toBe('A name can be up to 100 characters.');
    for (const code of [0x0a, 0x09, 0x00, 0x7f, 0x85, 0x2028, 0x2029, 0x200f, 0x202e, 0x2066]) {
      expect(validateConfigurationName(`A${char(code)}B`)).toBe(
        'A name can’t contain line breaks or other control characters.'
      );
    }
  });

  it('quotes names for messages', () => {
    expect(quoteName(' Customers ')).toBe('“Customers”');
    expect(quoteName('x'.repeat(150))).toBe(`“${'x'.repeat(99)}…”`);
  });

  it('turns any text into a usable name', () => {
    expect(cleanConfigurationName(`  Bill${NEWLINE}to${char(0x202e)}  customer `)).toBe(
      'Bill to customer'
    );
    expect(cleanConfigurationName('x'.repeat(150))).toHaveLength(100);
    expect(cleanConfigurationName(NEWLINE)).toBe('');
    // A character outside the Basic Multilingual Plane isn't cut in half.
    expect(shortenName(`${'x'.repeat(99)}🧾`, 100)).toBe('x'.repeat(99));
    expect(shortenName('short', 100)).toBe('short');
  });
});

describe('renameConfiguration', () => {
  const original = doc('Customers', [AGILE]);

  it('keeps former names, newest first', () => {
    const once = renameConfiguration(original, ' Customers API ');
    expect(once).toMatchObject({ name: 'Customers API', aliases: ['Customers'] });
    const twice = renameConfiguration(once, 'Clients');
    expect(twice.aliases).toEqual(['Customers API', 'Customers']);
    // The original isn't changed.
    expect(original).toMatchObject({ name: 'Customers', aliases: [] });
  });

  it('takes a name off the list when it’s used again', () => {
    const renamed = renameConfiguration(
      renameConfiguration(renameConfiguration(original, 'Customers API'), 'Clients'),
      'customers'
    );
    expect(renamed).toMatchObject({ name: 'customers', aliases: ['Clients', 'Customers API'] });
  });

  it('keeps the list when only the capitalization changes', () => {
    const renamed = renameConfiguration({ ...original, aliases: ['Old'] }, 'CUSTOMERS');
    expect(renamed).toMatchObject({ name: 'CUSTOMERS', aliases: ['Old'] });
  });

  it('keeps at most five, dropping the oldest', () => {
    let renamed = original;
    for (const name of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7']) {
      renamed = renameConfiguration(renamed, name);
    }
    expect(renamed.aliases).toEqual(['N6', 'N5', 'N4', 'N3', 'N2']);
  });

  it('refuses names that can’t be used', () => {
    expect(() => renameConfiguration(original, ' ')).toThrow(PicklistError);
    expect(() => renameConfiguration(original, `A${NEWLINE}B`)).toThrow(/control characters/);
  });

  it('forgets a former name, ignoring case', () => {
    const renamed = { ...original, aliases: ['Old', 'Older'] };
    expect(forgetAlias(renamed, ' OLD ').aliases).toEqual(['Older']);
    expect(forgetAlias(renamed, 'Unknown').aliases).toEqual(['Old', 'Older']);
    expect(renamed.aliases).toEqual(['Old', 'Older']);
  });
});

describe('findNameConflicts', () => {
  const customers = doc('Customers', [AGILE], { id: 'customers', aliases: ['Clients'] });
  const vendors = doc('Vendors', [AGILE, SCRUM], { id: 'vendors', aliases: ['Suppliers'] });
  const elsewhere = doc('Customers', [BASIC], { id: 'basic-customers' });
  const docs = [customers, vendors, elsewhere];

  it('finds names and former names taken in the same process', () => {
    expect(findNameConflicts(docs, { name: ' customers ', processIds: [AGILE] })).toEqual([
      { name: ' customers ', configuration: customers, formerName: false, processIds: [AGILE] },
    ]);
    expect(findNameConflicts(docs, { name: 'CLIENTS', processIds: [AGILE] })).toEqual([
      { name: 'CLIENTS', configuration: customers, formerName: true, processIds: [AGILE] },
    ]);
    expect(findNameConflicts(docs, { name: 'Vendors', processIds: [SCRUM, BASIC] })).toEqual([
      { name: 'Vendors', configuration: vendors, formerName: false, processIds: [SCRUM] },
    ]);
  });

  it('allows the same name in other processes', () => {
    expect(findNameConflicts(docs, { name: 'Vendors', processIds: [BASIC] })).toEqual([]);
    expect(findNameConflicts(docs, { name: 'Brand new', processIds: [AGILE, SCRUM] })).toEqual([]);
  });

  it('doesn’t compare a configuration with itself', () => {
    expect(
      findNameConflicts(docs, {
        id: 'customers',
        name: 'Customers',
        aliases: ['Clients'],
        processIds: [AGILE],
      })
    ).toEqual([]);
  });

  it('checks former names too when sharing with another process', () => {
    const conflicts = findNameConflicts(docs, {
      id: 'vendors',
      name: 'Vendors',
      aliases: ['Customers'],
      processIds: [AGILE, SCRUM, BASIC],
    });
    expect(conflicts.map((conflict) => [conflict.name, conflict.configuration.id])).toEqual([
      ['Customers', 'customers'],
      ['Customers', 'basic-customers'],
    ]);
  });

  it('explains conflicts', () => {
    const names: Record<string, string> = { [AGILE]: 'Contoso Agile', [SCRUM]: 'Fabrikam Scrum' };
    const lookup = (id: string) => names[id];
    const [name] = findNameConflicts(docs, { name: 'customers', processIds: [AGILE] });
    const [former] = findNameConflicts(docs, { name: 'Suppliers', processIds: [AGILE, SCRUM] });
    if (!name || !former) {
      throw new Error('Expected conflicts');
    }
    expect(nameConflictMessage(name, lookup)).toBe(
      '“customers” is already the name of another configuration in the Contoso Agile process. Choose another name.'
    );
    expect(nameConflictMessage(former, lookup)).toBe(
      '“Suppliers” is a former name of “Vendors” in the Contoso Agile and Fabrikam Scrum processes, and controls may still use it. Choose another name, or have “Vendors” forget it.'
    );
    expect(nameConflictMessage(name, () => undefined)).toMatch(/in a process they share\./);
  });
});

describe('configurationsForProcess', () => {
  it('lists what’s shared with the process, sorted by name', () => {
    const docs = [
      doc('API 10', [AGILE]),
      doc('api 9', [AGILE, SCRUM]),
      doc('Other', [SCRUM]),
      doc('API 1', [AGILE]),
    ];
    expect(configurationsForProcess(docs, AGILE).map((item) => item.name)).toEqual([
      'API 1',
      'api 9',
      'API 10',
    ]);
    expect(configurationsForProcess(docs, BASIC)).toEqual([]);
  });
});

describe('findConfigurationForProcess', () => {
  const customers = doc('Customers API', [AGILE], { aliases: ['Customers'] });
  const regions = doc('Regions', [AGILE, SCRUM]);
  const scrumOnly = doc('Products', [SCRUM]);
  const docs = [customers, regions, scrumOnly];

  it('finds a configuration by name, ignoring case', () => {
    expect(findConfigurationForProcess(docs, AGILE, 'Contoso Agile', ' customers api ')).toBe(
      customers
    );
    expect(findConfigurationForProcess(docs, SCRUM, 'Fabrikam Scrum', 'REGIONS')).toBe(regions);
  });

  it('finds it by a former name', () => {
    expect(findConfigurationForProcess(docs, AGILE, 'Contoso Agile', 'customers')).toBe(customers);
  });

  it('prefers a name over another configuration’s former name', () => {
    const renamed = doc('New', [AGILE], { aliases: ['Regions'] });
    expect(findConfigurationForProcess([renamed, regions], AGILE, 'Contoso Agile', 'Regions')).toBe(
      regions
    );
  });

  it('lists the available names when none matches', () => {
    expect(() => findConfigurationForProcess(docs, AGILE, 'Contoso Agile', 'Vendors')).toThrow(
      'No configuration named “Vendors” is shared with the Contoso Agile process. Available: “Customers API”, “Regions”.'
    );
    expect(() => findConfigurationForProcess(docs, BASIC, 'Contoso Basic', 'Vendors')).toThrow(
      'No configuration named “Vendors” is shared with the Contoso Basic process. No configurations are shared with it yet.'
    );
    expect(() => findConfigurationForProcess(docs, AGILE, ' ', 'Vendors')).toThrow(
      /^No configuration named “Vendors” is shared with this process\./
    );
  });

  it('lists up to ten names', () => {
    const many = Array.from({ length: 12 }, (_, index) => doc(`API ${index + 1}`, [AGILE]));
    expect(() => findConfigurationForProcess(many, AGILE, 'Contoso Agile', 'Vendors')).toThrow(
      'No configuration named “Vendors” is shared with the Contoso Agile process. Available: “API 1”, “API 2”, “API 3”, “API 4”, “API 5”, “API 6”, “API 7”, “API 8”, “API 9”, “API 10” and 2 more.'
    );
  });

  it('says when the configuration isn’t shared with the process', () => {
    expect(() => findConfigurationForProcess(docs, AGILE, 'Contoso Agile', 'products')).toThrow(
      'The configuration “products” isn’t shared with the Contoso Agile process. Available: “Customers API”, “Regions”.'
    );
  });

  it('refuses a name more than one configuration answers to', () => {
    const twin = doc('Regions', [AGILE], { id: 'twin' });
    expect(() =>
      findConfigurationForProcess([regions, twin], AGILE, 'Contoso Agile', 'regions')
    ).toThrow(
      'More than one configuration shared with the Contoso Agile process answers to “regions”: “Regions”, “Regions”. Rename one of them in Organization settings › Extensions › REST Picklist.'
    );
  });

  it('asks for a name', () => {
    let error: unknown;
    try {
      findConfigurationForProcess(docs, AGILE, 'Contoso Agile', '  ');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PicklistError);
    expect(error).toMatchObject({ kind: 'config', message: 'Enter the name of a configuration.' });
  });
});

function snapshot(changes: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return { collectionAdmin: false, editableProcessIds: new Set(), error: null, ...changes };
}

describe('permissions', () => {
  const agileOnly = doc('Agile only', [AGILE]);
  const shared = doc('Shared', [AGILE, SCRUM]);
  const scrumOnly = doc('Scrum only', [SCRUM]);
  const orphaned = doc('Orphaned', [AGILE, 'deleted-process']);

  it('lets collection administrators do everything', () => {
    const admin = snapshot({ collectionAdmin: true });
    expect(canEditProcess(admin, BASIC)).toBe(true);
    expect(canCreateIn(admin, BASIC)).toBe(true);
    for (const item of [agileOnly, shared, scrumOnly, orphaned]) {
      expect(canEditConfiguration(admin, item)).toBe(true);
      expect(canDeleteConfiguration(admin, item)).toBe(true);
      expect(canShareWith(admin, item, BASIC)).toBe(true);
    }
    expect(canUnshareFrom(admin, shared, AGILE)).toBe(true);
    // Taking the last process away is deleting.
    expect(canUnshareFrom(admin, agileOnly, AGILE)).toBe(false);
    expect(canUnshareFrom(admin, agileOnly, SCRUM)).toBe(false);
    expect(canEditPolicy(admin)).toBe(true);
  });

  it('lets process editors change what’s shared with their processes', () => {
    const editor = snapshot({ editableProcessIds: new Set([AGILE]) });
    expect(canCreateIn(editor, AGILE)).toBe(true);
    expect(canCreateIn(editor, SCRUM)).toBe(false);

    // Any shared process is enough to edit.
    expect(canEditConfiguration(editor, agileOnly)).toBe(true);
    expect(canEditConfiguration(editor, shared)).toBe(true);
    expect(canEditConfiguration(editor, scrumOnly)).toBe(false);

    // Sharing needs the configuration and the other process.
    expect(canShareWith(editor, scrumOnly, AGILE)).toBe(false);
    expect(canShareWith(editor, agileOnly, SCRUM)).toBe(false);
    expect(
      canShareWith(snapshot({ editableProcessIds: new Set([AGILE, BASIC]) }), agileOnly, BASIC)
    ).toBe(true);

    // Stopping needs that process, and another one left.
    expect(canUnshareFrom(editor, shared, AGILE)).toBe(true);
    expect(canUnshareFrom(editor, shared, SCRUM)).toBe(false);
    expect(canUnshareFrom(editor, agileOnly, AGILE)).toBe(false);

    // Deleting needs every process it's shared with, including ones that no longer exist.
    expect(canDeleteConfiguration(editor, agileOnly)).toBe(true);
    expect(canDeleteConfiguration(editor, shared)).toBe(false);
    expect(canDeleteConfiguration(editor, orphaned)).toBe(false);
    expect(canDeleteConfiguration(editor, { processIds: [] })).toBe(false);

    expect(canEditPolicy(editor)).toBe(false);
  });

  it('lets everyone else only look', () => {
    for (const viewer of [snapshot(), READ_ONLY_PERMISSIONS]) {
      expect(canCreateIn(viewer, AGILE)).toBe(false);
      expect(canEditConfiguration(viewer, shared)).toBe(false);
      expect(canShareWith(viewer, shared, BASIC)).toBe(false);
      expect(canUnshareFrom(viewer, shared, AGILE)).toBe(false);
      expect(canDeleteConfiguration(viewer, shared)).toBe(false);
      expect(canEditPolicy(viewer)).toBe(false);
    }
  });

  it('turns everything off when the check failed', () => {
    const failed = snapshot({
      collectionAdmin: true,
      editableProcessIds: new Set([AGILE, SCRUM]),
      error: permissionErrorMessage('Azure DevOps answered 500'),
    });
    expect(failed.error).toBe(
      'Couldn’t check your permissions (Azure DevOps answered 500). Editing is turned off until it works.'
    );
    expect(canEditProcess(failed, AGILE)).toBe(false);
    expect(canCreateIn(failed, AGILE)).toBe(false);
    expect(canEditConfiguration(failed, shared)).toBe(false);
    expect(canShareWith(failed, agileOnly, SCRUM)).toBe(false);
    expect(canUnshareFrom(failed, shared, AGILE)).toBe(false);
    expect(canDeleteConfiguration(failed, agileOnly)).toBe(false);
    expect(canEditPolicy(failed)).toBe(false);
  });

  it('lets process editors clean up after a deleted process, when the known processes are given', () => {
    const editor = snapshot({ editableProcessIds: new Set([AGILE]) });
    const known = new Set([AGILE, SCRUM, BASIC]);
    // Nobody has Edit process on a deleted process, so it doesn't count against deleting.
    expect(canDeleteConfiguration(editor, orphaned, known)).toBe(true);
    expect(canDeleteConfiguration(editor, shared, known)).toBe(false);
    // Shared with deleted processes only: for administrators to clean up.
    expect(canDeleteConfiguration(editor, doc('Gone', ['deleted-process']), known)).toBe(false);
    expect(canDeleteConfiguration(editor, { processIds: [] }, known)).toBe(false);
    // The deleted process can be dropped by whoever may edit the configuration…
    expect(canUnshareFrom(editor, orphaned, 'deleted-process', known)).toBe(true);
    expect(canUnshareFrom(snapshot(), orphaned, 'deleted-process', known)).toBe(false);
    // …but the last process that exists can't be: that would leave only a deleted one.
    expect(canUnshareFrom(editor, orphaned, AGILE, known)).toBe(false);
    expect(canUnshareFrom(editor, shared, AGILE, known)).toBe(true);
  });

  it('keeps process editing on, but not administrators’ things, when Azure DevOps refused the check', () => {
    // Refused for everyone, administrators included; Azure DevOps still guards layout changes.
    const refused = snapshot({
      unverified: permissionUnverifiedMessage('Azure DevOps answered 403'),
    });
    expect(refused.unverified).toBe(
      'Couldn’t verify your permissions (Azure DevOps answered 403), so editing configurations isn’t limited here. Azure DevOps still checks Edit process permission when a process’s controls change, so only change what you’re responsible for. The security policy and configurations no process uses stay read-only until the check works.'
    );
    expect(permissionsUnverified(refused)).toBe(true);
    // Never granted from a refused check: the policy and configurations no process uses.
    expect(canManageAll(refused)).toBe(false);
    expect(canEditPolicy(refused)).toBe(false);
    expect(canDeleteConfiguration(refused, { processIds: [] })).toBe(false);
    expect(canEditConfiguration(refused, { processIds: [] })).toBe(false);
    expect(
      canDeleteConfiguration(refused, doc('Gone', ['deleted-process']), new Set([AGILE]))
    ).toBe(false);
    expect(canEditProcess(refused, AGILE)).toBe(true);
    expect(canCreateIn(refused, SCRUM)).toBe(true);
    expect(canEditConfiguration(refused, scrumOnly)).toBe(true);
    expect(canShareWith(refused, agileOnly, SCRUM)).toBe(true);
    expect(canUnshareFrom(refused, shared, AGILE)).toBe(true);
    // Taking the last process away is still deleting.
    expect(canUnshareFrom(refused, agileOnly, AGILE)).toBe(false);
    expect(canDeleteConfiguration(refused, orphaned)).toBe(true);
    // A check that failed outright still turns editing off.
    const both = { ...refused, error: permissionErrorMessage('Azure DevOps answered 500') };
    expect(permissionsUnverified(both)).toBe(false);
    expect(canEditProcess(both, AGILE)).toBe(false);
    expect(canEditPolicy(both)).toBe(false);
  });
});

describe('new configurations', () => {
  it('makes random ids', () => {
    const first = newConfigurationId();
    expect(first).toMatch(UUID);
    expect(newConfigurationId()).not.toBe(first);
  });

  it('creates a document with only the settings a configuration keeps', () => {
    const created = createConfigurationDocument({
      name: ' Customers ',
      processIds: [AGILE, AGILE, '../bad'],
      settings: {
        RestServiceAddress: 'https://api.contoso.com/customers',
        RestServicePassword: 'p@ssw0rd',
        AllowMultiple: true,
        Required: 'false',
      },
    });
    expect(created).toEqual({
      id: expect.stringMatching(UUID),
      version: 1,
      name: 'Customers',
      aliases: [],
      processIds: [AGILE],
      settings: { RestServiceAddress: 'https://api.contoso.com/customers', AllowMultiple: 'true' },
      secret: null,
    });
    expect(parseConfigurationDocument(created)).toEqual(created);
    expect(createConfigurationDocument({ name: 'A', processIds: [AGILE], id: 'fixed' }).id).toBe(
      'fixed'
    );
  });

  it('refuses names, processes and ids that can’t be used', () => {
    expect(() => createConfigurationDocument({ name: '', processIds: [AGILE] })).toThrow(
      'Enter a name for the configuration.'
    );
    expect(() => createConfigurationDocument({ name: 'A', processIds: [] })).toThrow(
      'Share the configuration with at least one process.'
    );
    expect(() =>
      createConfigurationDocument({ name: 'A', processIds: [AGILE], id: '../x' })
    ).toThrow(/id isn’t valid/);
  });

  it('duplicates under a new name, keeping the secret summary', () => {
    const original = parseConfigurationDocument(STORED);
    if (!original) {
      throw new Error('Expected a document');
    }
    const copy = duplicateConfiguration(original, 'Customers API (copy)');
    expect(copy).toEqual({
      id: expect.stringMatching(UUID),
      version: 1,
      name: 'Customers API (copy)',
      aliases: [],
      processIds: [AGILE],
      settings: original.settings,
      secret: original.secret,
    });
    expect(copy.id).not.toBe(original.id);
    expect(copy.settings).not.toBe(original.settings);
    expect(copy.secret).not.toBe(original.secret);
    expect(() => duplicateConfiguration(original, '')).toThrow(PicklistError);
  });
});

describe('exportConfigurationFile', () => {
  const customers = parseConfigurationDocument({
    ...STORED,
    settings: {
      ...STORED.settings,
      AuthMethod: 'Basic',
      RestServiceUserName: 'svc-picklist',
      Required: 'true',
    },
  });

  it('writes version 2 with settings, never credentials or user names', () => {
    if (!customers) {
      throw new Error('Expected a document');
    }
    const text = exportConfigurationFile(
      [{ ...customers, source: 'Contoso Agile' }],
      new Date('2026-10-22T12:00:00Z')
    );
    expect(text).not.toContain('svc-picklist');
    expect(text).not.toContain('signingKey');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      format: FILE_FORMAT,
      version: 2,
      exportedAt: '2026-10-22T12:00:00.000Z',
      configurations: [
        {
          name: 'Customers API',
          source: 'Contoso Agile',
          settings: {
            RestServiceAddress: 'https://api.contoso.com/customers',
            AuthMethod: 'Basic',
            SecondLineProperty: 'email',
            AllowMultiple: 'true',
            Required: 'true',
            OAuthSettings: OAUTH,
          },
        },
      ],
    });
  });

  it('can be imported again', () => {
    const items = [
      {
        name: 'Customers',
        source: 'Contoso Agile',
        settings: { RestServiceAddress: 'https://a.example' },
      },
      {
        name: 'Regions',
        settings: { RestServiceAddress: 'https://b.example', AllowMultiple: 'true' },
      },
    ];
    expect(parseConfigurationFile(exportConfigurationFile(items))).toEqual({
      configurations: items,
      error: null,
    });
  });

  it('limits the number of configurations', () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      name: `C${index}`,
      settings: { RestServiceAddress: 'https://a.example' },
    }));
    expect(() => exportConfigurationFile(many)).toThrow(/up to 200/);
  });
});

function file(configurations: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: FILE_FORMAT,
    version: 2,
    exportedAt: '2026-10-22T12:00:00.000Z',
    configurations,
    ...extra,
  });
}

describe('parseConfigurationFile', () => {
  it('reads files exported by 3.0', () => {
    const v1 = JSON.stringify({
      format: FILE_FORMAT,
      version: 1,
      exportedAt: '2026-09-28T12:00:00.000Z',
      configurations: [
        {
          name: 'Customers',
          source: 'Bug › Customer',
          inputs: {
            RestServiceAddress: 'https://api.contoso.com/customers?region=$(Custom.Region)',
            AuthMethod: 'Basic',
            RestServiceUserName: 'svc-picklist',
            RestServicePassword: 'p@ssw0rd',
            FieldName: 'Custom.Customer',
            AdvancedSettings: '{"paging":{"type":"nextLink"}}',
          },
        },
      ],
    });
    expect(parseConfigurationFile(v1)).toEqual({
      configurations: [
        {
          name: 'Customers',
          source: 'Bug › Customer',
          settings: {
            RestServiceAddress: 'https://api.contoso.com/customers?region=$(Custom.Region)',
            AuthMethod: 'Basic',
            AdvancedSettings: '{"paging":{"type":"nextLink"}}',
          },
        },
      ],
      error: null,
    });
  });

  it('accepts a single configuration object, from 3.0 or 4.0', () => {
    expect(
      parseConfigurationFile(
        `${BOM}{ "name": "Customers", "inputs": { "RestServiceAddress": "https://a.example" } }`
      )
    ).toEqual({
      configurations: [
        { name: 'Customers', settings: { RestServiceAddress: 'https://a.example' } },
      ],
      error: null,
    });
    expect(
      parseConfigurationFile('{ "settings": { "PathToArray": "data", "AllowMultiple": true } }')
        .configurations
    ).toEqual([{ name: '', settings: { PathToArray: 'data', AllowMultiple: 'true' } }]);
  });

  it('ignores credentials, user names and unknown settings', () => {
    const result = parseConfigurationFile(
      file([
        {
          name: 'Customers',
          settings: {
            RestServiceAddress: 'https://a.example',
            RestServicePassword: 'p@ssw0rd',
            RestServiceUserName: 'svc-picklist',
            Unknown: 1,
            ErrorMessage: '   ',
            Required: false,
          },
        },
      ])
    );
    expect(result).toEqual({
      configurations: [
        { name: 'Customers', settings: { RestServiceAddress: 'https://a.example' } },
      ],
      error: null,
    });
  });

  it('isn’t fooled by __proto__ keys', () => {
    const result = parseConfigurationFile(
      '{ "name": "A", "settings": { "__proto__": { "RestServiceAddress": "https://evil.example" }, "PathToArray": "data" } }'
    );
    expect(result.configurations).toEqual([{ name: 'A', settings: { PathToArray: 'data' } }]);
    expect(Object.getPrototypeOf(result.configurations[0]?.settings)).toBe(Object.prototype);
  });

  it('explains what’s wrong with a file', () => {
    const valid = { name: 'A', settings: { RestServiceAddress: 'https://a.example' } };
    const cases: Array<[string, RegExp]> = [
      ['{ nope', /isn’t valid JSON/],
      ['[1, 2]', /isn’t a REST Picklist configuration file/],
      ['{ "hello": "world" }', /isn’t a REST Picklist configuration file/],
      [JSON.stringify({ format: 'something-else', configurations: [] }), /isn’t a REST Picklist/],
      [file([valid], { version: 3 }), /newer version of REST Picklist/],
      [file([valid], { version: '2' }), /isn’t a REST Picklist configuration file/],
      [file({}), /isn’t a REST Picklist configuration file/],
      [file([]), /has no configurations/],
      [file(['text']), /^Configuration 1 isn’t an object\.$/],
      [file([{ settings: valid.settings }]), /^Configuration 1 has no name\.$/],
      [file([{ ...valid, name: 5 }]), /“name” must be text/],
      [file([{ ...valid, name: 'x'.repeat(101) }]), /up to 100 characters/],
      [file([{ ...valid, name: `Two${NEWLINE}lines` }]), /line breaks or control characters/],
      [file([valid, { ...valid, name: ' a ' }]), /^“a” appears more than once in this file\.$/],
      [file([{ name: 'A' }]), /^“A” has no “settings” object\.$/],
      [file([{ name: 'A', inputs: valid.settings }]), /^“A” has no “settings” object\.$/],
      [file([{ ...valid }], { version: 1 }), /^“A” has no “inputs” object\.$/],
      [file([{ name: 'A', settings: { PathToArray: 3 } }]), /^“A”: “PathToArray” must be text\.$/],
      [
        file([{ name: 'A', settings: { PathToArray: true } }]),
        /^“A”: “PathToArray” must be text\.$/,
      ],
      [
        file([{ name: 'A', settings: { ErrorMessage: 'x'.repeat(20_001) } }]),
        /^“A”: “ErrorMessage” can be up to 20,000 characters\.$/,
      ],
      [
        file([{ name: 'A', settings: { RestServicePassword: 'x' } }]),
        /^“A” has no settings to import\.$/,
      ],
    ];
    for (const [text, message] of cases) {
      const result = parseConfigurationFile(text);
      expect(result.configurations).toEqual([]);
      expect(result.error).toMatch(message);
    }
  });

  it('enforces size limits', () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      name: `C${index}`,
      settings: { RestServiceAddress: 'https://a.example' },
    }));
    expect(parseConfigurationFile(file(many)).error).toMatch(
      /201 configurations\. Import up to 200/
    );
    expect(parseConfigurationFile(' '.repeat(1024 * 1024 + 1)).error).toMatch(/larger than 1 MB/);
    // Multi-byte characters count as bytes.
    const wide = file([{ name: 'A', settings: { ErrorMessage: 'é'.repeat(600_000) } }]);
    expect(parseConfigurationFile(wide).error).toMatch(/larger than 1 MB/);
  });
});
