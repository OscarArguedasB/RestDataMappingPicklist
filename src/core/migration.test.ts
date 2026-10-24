import { describe, expect, it } from 'vitest';
import type { ConfigurationDocument } from './configurations';
import type { LayoutControl, MigrationPlan } from './migration';
import {
  assignmentInputs,
  controlStatus,
  controlsUsingSavedConfiguration,
  describeControl,
  migratedInputs,
  planMigration,
} from './migration';

const AGILE = 'e31fd6e1-c6af-44bb-925e-dfa71f551463';
const SCRUM = '6b724908-ef14-45cf-84f8-768b5384da45';
const PROCESS = { id: AGILE, name: 'Contoso Agile' };
const CONTRIBUTION = 'OscarArguedasBarboza.RestDataMappingPicklist.rest-data-mapping-picklist';
const CUSTOMERS_URL = 'https://api.contoso.com/customers';
const REGIONS_URL = 'https://api.contoso.com/regions';
const PASSWORD = 'p@ssw0rd-secret';

function control(
  controlId: string,
  workItemType: string,
  label: string,
  inputs: Record<string, unknown>
): LayoutControl {
  return {
    processId: AGILE,
    processName: 'Contoso Agile',
    workItemType: {
      name: workItemType,
      referenceName: `Contoso.${workItemType.replace(/ /g, '')}`,
    },
    groupId: 'Group.Details',
    controlId,
    label,
    fieldName: typeof inputs.FieldName === 'string' ? inputs.FieldName.trim() : '',
    inputs,
    control: { id: controlId, label, contribution: { contributionId: CONTRIBUTION, inputs } },
  };
}

function configuration(
  name: string,
  settings: Record<string, string>,
  extra: Partial<ConfigurationDocument> = {}
): ConfigurationDocument {
  return {
    id: `existing-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    version: 1,
    name,
    aliases: [],
    processIds: [AGILE],
    settings,
    secret: null,
    ...extra,
  };
}

function ids(controls: readonly LayoutControl[]): string[] {
  return controls.map((item) => item.controlId);
}

/** A plan without object identities, to compare plans. */
function outline(plan: MigrationPlan) {
  return {
    groups: plan.groups.map((group) => ({
      name: group.name,
      existing: group.existing?.id ?? null,
      settings: group.settings,
      secret: group.secret,
      savedConfigurationName: group.savedConfigurationName,
      controls: ids(group.controls),
    })),
    steps: plan.steps.map((step) => ({
      control: step.control.controlId,
      group: step.group,
      usedBy: ids(step.usedBy),
      warnings: step.warnings,
    })),
    problems: plan.problems.map((problem) => [problem.control.controlId, problem.message]),
  };
}

// A 3.0 control that saves its settings as “Customers” for the process.
const HOLDER = control('c-holder', 'Bug', 'Customer', {
  FieldName: 'Custom.Customer',
  SaveConfiguration: 'true',
  SavedConfigurationName: 'Customers',
  RestServiceAddress: CUSTOMERS_URL,
  AuthMethod: 'Basic',
  RestServiceUserName: 'svc-picklist',
  RestServicePassword: PASSWORD,
  SecondLineProperty: 'email',
  AllowMultiple: 'true',
});

// Uses “Customers” with the same credentials and options: the same settings in the end.
const USER = control('c-billing', 'Task', 'Billing customer', {
  FieldName: 'Custom.BillingCustomer',
  SavedConfiguration: 'customers',
  AuthMethod: 'None',
  RestServiceUserName: 'svc-picklist',
  RestServicePassword: PASSWORD,
  AllowMultiple: 'true',
});

const CUSTOMER_SETTINGS = {
  RestServiceAddress: CUSTOMERS_URL,
  AuthMethod: 'Basic',
  RestServiceUserName: 'svc-picklist',
  SecondLineProperty: 'email',
  AllowMultiple: 'true',
};

function leftovers(inputs: Record<string, unknown>) {
  return controlStatus({ inputs: { FieldName: 'F', Configuration: 'C', ...inputs } });
}

describe('controlStatus', () => {
  it('tells configured, legacy and empty controls apart', () => {
    expect(controlStatus({ inputs: { FieldName: 'F', Configuration: ' Customers ' } })).toEqual({
      kind: 'configured',
      configuration: 'Customers',
      leftovers: false,
    });
    for (const inputs of [
      { RestServiceAddress: CUSTOMERS_URL },
      { SavedConfiguration: 'Customers' },
      { SaveConfiguration: 'true', SavedConfigurationName: 'Customers' },
      { SaveConfiguration: true },
      // 3.0 controls without an endpoint, which offer the values the process allows.
      { FieldName: 'Custom.Customer', AllowMultiple: 'true', SaveConfiguration: 'false' },
      { FieldName: 'Custom.Customer', AllowMultiple: 'true', ErrorMessage: 'Not allowed' },
      { RestServiceAddress: '   ', Configuration: '' },
      { FieldName: 'Custom.Customer', LoadOnFormOpen: 'false' },
    ]) {
      expect(controlStatus({ inputs })).toEqual({ kind: 'legacy' });
    }
    for (const inputs of [
      {},
      // Only the field: just like a 4.0 control that has no configuration yet.
      { FieldName: 'Custom.Customer' },
      { FieldName: 'Custom.Customer', Configuration: '  ' },
      { FieldName: 'Custom.Customer', RestServiceAddress: undefined, AllowMultiple: null },
    ]) {
      expect(controlStatus({ inputs })).toEqual({ kind: 'empty' });
    }
  });

  it('notices settings left over on a configured control', () => {
    expect(leftovers({ RestServicePassword: '********' })).toMatchObject({ leftovers: true });
    expect(leftovers({ RestServiceAddress: CUSTOMERS_URL })).toMatchObject({ leftovers: true });
    expect(leftovers({ AuthMethod: 'None' })).toMatchObject({ leftovers: true });
    expect(leftovers({ AllowMultiple: 'false', ErrorMessage: ' ', Required: false })).toMatchObject(
      {
        leftovers: false,
      }
    );
  });
});

describe('migratedInputs', () => {
  it('keeps only the field and the configuration name', () => {
    expect(migratedInputs(HOLDER, ' Customers ')).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Customers',
    });
    expect(
      migratedInputs({ inputs: { FieldName: ' Custom.Region ' }, fieldName: '' }, 'Regions')
    ).toEqual({ FieldName: 'Custom.Region', Configuration: 'Regions' });
  });

  it('describes where a control is', () => {
    expect(describeControl(HOLDER)).toBe('Bug › Customer');
    expect(describeControl({ ...HOLDER, label: '' })).toBe('Bug › Custom.Customer');
    expect(describeControl({ ...HOLDER, label: '', fieldName: '' })).toBe('Bug › c-holder');
  });
});

describe('planMigration', () => {
  it('groups controls that keep the same settings themselves', () => {
    const first = control('c-region-bug', 'Bug', 'Region', {
      FieldName: 'Custom.Region',
      RestServiceAddress: REGIONS_URL,
      AuthMethod: 'None',
      RestServicePassword: '',
    });
    const second = control('c-region-task', 'Task', 'Region', {
      FieldName: 'Custom.Region',
      RestServiceAddress: REGIONS_URL,
      AuthMethod: 'None',
    });
    const configured = control('c-product', 'Bug', 'Product', {
      FieldName: 'Custom.Product',
      Configuration: 'Products',
    });
    const empty = control('c-empty', 'Bug', 'Empty', { FieldName: 'Custom.Empty' });
    const plan = planMigration(PROCESS, [second, configured, first, empty], []);
    expect(plan.processId).toBe(AGILE);
    expect(plan.processName).toBe('Contoso Agile');
    expect(outline(plan)).toEqual({
      groups: [
        {
          name: 'Region',
          existing: null,
          settings: { RestServiceAddress: REGIONS_URL },
          secret: { status: 'none' },
          savedConfigurationName: null,
          controls: ['c-region-bug', 'c-region-task'],
        },
      ],
      steps: [
        { control: 'c-region-bug', group: 0, usedBy: [], warnings: [] },
        { control: 'c-region-task', group: 0, usedBy: [], warnings: [] },
      ],
      problems: [],
    });
    expect(planMigration(PROCESS, [configured, empty], [])).toEqual({
      processId: AGILE,
      processName: 'Contoso Agile',
      groups: [],
      steps: [],
      problems: [],
    });
  });

  it('splits controls whose options differ', () => {
    const single = control('c-1', 'Bug', 'Region', { RestServiceAddress: REGIONS_URL });
    const multiple = control('c-2', 'Bug', 'Region', {
      RestServiceAddress: REGIONS_URL,
      AllowMultiple: 'true',
    });
    const required = control('c-3', 'Bug', 'Region', {
      RestServiceAddress: REGIONS_URL,
      Required: 'True',
    });
    const plan = planMigration(PROCESS, [single, multiple, required], []);
    expect(plan.groups.map((group) => [group.name, ids(group.controls), group.settings])).toEqual([
      ['Region', ['c-1'], { RestServiceAddress: REGIONS_URL }],
      ['Region (Bug)', ['c-2'], { RestServiceAddress: REGIONS_URL, AllowMultiple: 'true' }],
      ['Region (Bug) 2', ['c-3'], { RestServiceAddress: REGIONS_URL, Required: 'true' }],
    ]);
  });

  it('moves a 3.0 saved configuration with the controls that use it', () => {
    const plan = planMigration(PROCESS, [HOLDER, USER], []);
    expect(outline(plan)).toEqual({
      groups: [
        {
          name: 'Customers',
          existing: null,
          settings: CUSTOMER_SETTINGS,
          secret: { status: 'ready', secret: { kind: 'password', value: PASSWORD } },
          savedConfigurationName: 'Customers',
          controls: ['c-holder', 'c-billing'],
        },
      ],
      // The control that saves the settings moves last, once the one using them has.
      steps: [
        { control: 'c-billing', group: 0, usedBy: [], warnings: [] },
        { control: 'c-holder', group: 0, usedBy: ['c-billing'], warnings: [] },
      ],
      problems: [],
    });
    // Settings never carry the password.
    expect(JSON.stringify(plan.groups.map((group) => group.settings))).not.toContain(PASSWORD);
  });

  it('keeps settings a control overrides, and its own options, apart', () => {
    const overrides = control('c-shipping', 'Task', 'Shipping customer', {
      FieldName: 'Custom.ShippingCustomer',
      SavedConfiguration: 'Customers',
      SecondLineProperty: 'phone',
      RestServiceUserName: 'svc-picklist',
      RestServicePassword: PASSWORD,
      AllowMultiple: 'true',
    });
    const single = control('c-other', 'Task', 'Other customer', {
      FieldName: 'Custom.OtherCustomer',
      SavedConfiguration: 'Customers',
      RestServiceUserName: 'svc-picklist',
      RestServicePassword: PASSWORD,
    });
    const plan = planMigration(PROCESS, [overrides, single, USER, HOLDER], []);
    expect(
      plan.groups.map((group) => [
        group.name,
        group.savedConfigurationName,
        ids(group.controls),
        group.settings,
      ])
    ).toEqual([
      ['Customers', 'Customers', ['c-holder', 'c-billing'], CUSTOMER_SETTINGS],
      [
        'Customers (Task)',
        'Customers',
        ['c-other'],
        {
          RestServiceAddress: CUSTOMERS_URL,
          AuthMethod: 'Basic',
          RestServiceUserName: 'svc-picklist',
          SecondLineProperty: 'email',
        },
      ],
      [
        'Customers (Task) 2',
        'Customers',
        ['c-shipping'],
        { ...CUSTOMER_SETTINGS, SecondLineProperty: 'phone' },
      ],
    ]);
    const holderStep = plan.steps.find((step) => step.control === HOLDER);
    expect(ids(holderStep?.usedBy ?? [])).toEqual(['c-billing', 'c-other', 'c-shipping']);
    expect(plan.steps.at(-1)?.control).toBe(HOLDER);
  });

  it('needs the secret again when Azure DevOps hides it or leaves it out', () => {
    const masked = control('c-masked', 'Bug', 'Masked', {
      RestServiceAddress: CUSTOMERS_URL,
      AuthMethod: 'Bearer token',
      RestServicePassword: '********',
    });
    const missing = control('c-missing', 'Bug', 'Missing', {
      RestServiceAddress: CUSTOMERS_URL,
      AuthMethod: 'Bearer token',
    });
    const dotted = control('c-dotted', 'Bug', 'Dotted', {
      RestServiceAddress: CUSTOMERS_URL,
      AuthMethod: 'Bearer token',
      RestServicePassword: ' ••• ',
    });
    const readable = control('c-readable', 'Bug', 'Readable', {
      RestServiceAddress: CUSTOMERS_URL,
      AuthMethod: 'Bearer token',
      RestServicePassword: 'token-123',
    });
    const tooLong = control('c-long', 'Bug', 'Long', {
      RestServiceAddress: CUSTOMERS_URL,
      AuthMethod: 'Bearer token',
      RestServicePassword: 'x'.repeat(16_385),
    });
    const plan = planMigration(PROCESS, [masked, missing, dotted, readable, tooLong], []);
    // Unreadable secrets group together; a readable one is kept apart.
    expect(plan.groups.map((group) => [ids(group.controls), group.secret])).toEqual([
      [['c-dotted', 'c-long', 'c-masked', 'c-missing'], { status: 'needed' }],
      [['c-readable'], { status: 'ready', secret: { kind: 'token', value: 'token-123' } }],
    ]);
    expect(plan.groups[0]?.settings).toEqual({
      RestServiceAddress: CUSTOMERS_URL,
      AuthMethod: 'Bearer token',
    });
  });

  it('reads the sign-in method the way 3.0 did, and spells it out', () => {
    const bearerUser = control('c-1', 'Bug', 'One', {
      RestServiceAddress: 'https://one.example',
      RestServiceUserName: 'Bearer',
      RestServicePassword: 'token-1',
    });
    const passwordOnly = control('c-2', 'Bug', 'Two', {
      RestServiceAddress: 'https://two.example',
      RestServicePassword: 'pw-2',
    });
    const noneWithCredentials = control('c-3', 'Bug', 'Three', {
      RestServiceAddress: 'https://three.example',
      AuthMethod: 'None',
      RestServiceUserName: 'svc',
      RestServicePassword: 'pw-3',
    });
    const apiKey = control('c-4', 'Bug', 'Four', {
      RestServiceAddress: 'https://four.example',
      AuthMethod: 'x-api-key',
      RestServiceUserName: 'unused',
      RestServicePassword: 'key-4',
    });
    const plan = planMigration(
      PROCESS,
      [bearerUser, passwordOnly, noneWithCredentials, apiKey],
      []
    );
    expect(plan.groups.map((group) => [group.name, group.settings, group.secret])).toEqual([
      [
        'Four',
        { RestServiceAddress: 'https://four.example', AuthMethod: 'API key' },
        { status: 'ready', secret: { kind: 'apiKey', value: 'key-4' } },
      ],
      [
        'One',
        { RestServiceAddress: 'https://one.example', AuthMethod: 'Bearer token' },
        { status: 'ready', secret: { kind: 'token', value: 'token-1' } },
      ],
      [
        'Three',
        {
          RestServiceAddress: 'https://three.example',
          AuthMethod: 'Basic',
          RestServiceUserName: 'svc',
        },
        { status: 'ready', secret: { kind: 'password', value: 'pw-3' } },
      ],
      [
        'Two',
        { RestServiceAddress: 'https://two.example', AuthMethod: 'Basic' },
        { status: 'ready', secret: { kind: 'password', value: 'pw-2' } },
      ],
    ]);
  });

  it('warns about sign-ins it can’t tell', () => {
    const unknownSignIn = control('c-1', 'Bug', 'Unknown', {
      RestServiceAddress: 'https://one.example',
    });
    const unknownMethod = control('c-2', 'Bug', 'Kerberos', {
      RestServiceAddress: 'https://two.example',
      AuthMethod: 'Kerberos',
      RestServicePassword: 'pw',
    });
    const plan = planMigration(PROCESS, [unknownSignIn, unknownMethod], []);
    expect(plan.groups.map((group) => [group.name, group.settings, group.secret])).toEqual([
      [
        'Kerberos',
        { RestServiceAddress: 'https://two.example', AuthMethod: 'Kerberos' },
        { status: 'needed' },
      ],
      ['Unknown', { RestServiceAddress: 'https://one.example' }, { status: 'none' }],
    ]);
    const [kerberos, unknown] = plan.steps;
    expect(kerberos?.warnings).toEqual([
      expect.stringMatching(
        /^“Kerberos” isn’t a sign-in method\. .*Choose the sign-in method after moving, then enter the secret\.$/
      ),
    ]);
    expect(unknown?.warnings).toEqual([
      'Azure DevOps doesn’t show whether this control signs in to its API, so it moves without signing in. If it did, choose its sign-in method and enter the secret after moving.',
    ]);
  });

  it('lists controls that can’t move, and keeps the settings they rely on', () => {
    const lost = control('c-lost', 'Bug', 'Lost', {
      FieldName: 'Custom.Lost',
      SavedConfiguration: 'Vendors',
    });
    const first = control('c-shared-1', 'Bug', 'Shared one', {
      SaveConfiguration: 'true',
      SavedConfigurationName: 'Shared',
      RestServiceAddress: 'https://one.example',
    });
    const second = control('c-shared-2', 'Task', 'Shared two', {
      SaveConfiguration: 'true',
      SavedConfigurationName: ' shared ',
      RestServiceAddress: 'https://two.example',
    });
    const ambiguous = control('c-uses-shared', 'User Story', 'Uses shared', {
      SavedConfiguration: 'SHARED',
    });
    const plan = planMigration(PROCESS, [ambiguous, second, lost, first, HOLDER], []);
    expect(outline(plan).problems).toEqual([
      [
        'c-lost',
        'Bug › Lost uses the saved configuration “Vendors”, but no control in the Contoso Agile process saves it.',
      ],
      [
        'c-shared-1',
        'Bug › Shared one saves “Shared” for controls that can’t move yet (User Story › Uses shared), so it stays until they can.',
      ],
      [
        'c-shared-2',
        'Task › Shared two saves “shared” for controls that can’t move yet (User Story › Uses shared), so it stays until they can.',
      ],
      [
        'c-uses-shared',
        'User Story › Uses shared uses the saved configuration “SHARED”, which more than one control saves: Bug › Shared one, Task › Shared two.',
      ],
    ]);
    // Everything else still moves.
    expect(plan.groups.map((group) => group.name)).toEqual(['Customers']);
  });

  it('serves controls that use a configured control’s old saved settings', () => {
    const configuredHolder = control('c-configured', 'Bug', 'Customer', {
      ...HOLDER.inputs,
      Configuration: 'Customers API',
    });
    const user = { ...USER, inputs: { ...USER.inputs } };
    const plan = planMigration(PROCESS, [configuredHolder, user], []);
    expect(outline(plan).steps).toEqual([
      { control: 'c-billing', group: 0, usedBy: [], warnings: [] },
    ]);
    expect(plan.groups[0]).toMatchObject({ name: 'Customers', settings: CUSTOMER_SETTINGS });
    // Cleaning up the configured control would take its settings away from that one.
    expect(
      ids(controlsUsingSavedConfiguration([configuredHolder, user], configuredHolder))
    ).toEqual(['c-billing']);
    expect(controlsUsingSavedConfiguration([configuredHolder, user], user)).toEqual([]);
  });

  it('moves controls along a chain of saved configurations in order', () => {
    const alpha = control('c-alpha', 'Bug', 'A', {
      SaveConfiguration: 'true',
      SavedConfigurationName: 'Alpha',
      RestServiceAddress: 'https://alpha.example',
    });
    const beta = control('c-beta', 'Bug', 'B', {
      SaveConfiguration: 'true',
      SavedConfigurationName: 'Beta',
      SavedConfiguration: 'Alpha',
      PathToArray: 'items',
    });
    const user = control('c-user', 'Task', 'C', { SavedConfiguration: 'Beta' });
    const plan = planMigration(PROCESS, [alpha, beta, user], []);
    expect(outline(plan).steps.map((step) => [step.control, step.usedBy])).toEqual([
      ['c-user', []],
      ['c-beta', ['c-user']],
      ['c-alpha', ['c-beta']],
    ]);
    // The user gets what Beta saves, not what Beta gets from Alpha, as in 3.0.
    expect(plan.groups.map((group) => [group.name, ids(group.controls), group.settings])).toEqual([
      ['Alpha', ['c-alpha'], { RestServiceAddress: 'https://alpha.example' }],
      ['Beta', ['c-beta'], { RestServiceAddress: 'https://alpha.example', PathToArray: 'items' }],
      ['Beta (Task)', ['c-user'], { PathToArray: 'items' }],
    ]);
  });

  it('takes controls that use each other’s settings in order', () => {
    const one = control('c-1', 'Bug', 'One', {
      SaveConfiguration: 'true',
      SavedConfigurationName: 'One',
      SavedConfiguration: 'Two',
      RestServiceAddress: 'https://one.example',
    });
    const two = control('c-2', 'Bug', 'Two', {
      SaveConfiguration: 'true',
      SavedConfigurationName: 'Two',
      SavedConfiguration: 'One',
      RestServiceAddress: 'https://two.example',
    });
    const plan = planMigration(PROCESS, [two, one], []);
    expect(outline(plan).steps.map((step) => [step.control, step.usedBy])).toEqual([
      ['c-1', []],
      ['c-2', ['c-1']],
    ]);
  });

  it('reuses a configuration of this process with the same settings', () => {
    const region = control('c-region', 'Bug', 'Region', {
      RestServiceAddress: REGIONS_URL,
      AuthMethod: 'None',
    });
    const regions = configuration('Regions API', { RestServiceAddress: REGIONS_URL });
    const elsewhere = configuration(
      'Scrum regions',
      { RestServiceAddress: REGIONS_URL },
      { processIds: [SCRUM] }
    );
    const plan = planMigration(PROCESS, [region], [elsewhere, regions]);
    expect(outline(plan).groups).toEqual([
      {
        name: 'Regions API',
        existing: regions.id,
        settings: { RestServiceAddress: REGIONS_URL },
        secret: { status: 'none' },
        savedConfigurationName: null,
        controls: ['c-region'],
      },
    ]);
    expect(planMigration(PROCESS, [region], [elsewhere]).groups[0]).toMatchObject({
      name: 'Region',
      existing: null,
    });
  });

  it('keeps a reused configuration’s secret, or sets one it lacks', () => {
    const summary = {
      kind: 'password' as const,
      boundOrigin: 'https://api.contoso.com',
      updatedBy: 'Ana Díaz',
    };
    // The control's own password can't be read, so the configuration's is kept.
    const hidden = {
      ...HOLDER,
      inputs: { ...HOLDER.inputs, RestServicePassword: '********' },
    };
    const hiddenUser = { ...USER, inputs: { ...USER.inputs, RestServicePassword: '********' } };
    const withSecret = configuration('Customers API', CUSTOMER_SETTINGS, { secret: summary });
    expect(planMigration(PROCESS, [hidden, hiddenUser], [withSecret]).groups[0]).toMatchObject({
      name: 'Customers API',
      existing: withSecret,
      secret: { status: 'kept' },
    });
    const withoutSecret = configuration('Customers API', CUSTOMER_SETTINGS);
    expect(planMigration(PROCESS, [HOLDER], [withoutSecret]).groups[0]).toMatchObject({
      existing: withoutSecret,
      secret: { status: 'ready', secret: { kind: 'password', value: PASSWORD } },
    });
  });

  it('never swaps a control’s own readable secret for the one a configuration keeps', () => {
    // They may differ: the control would sign in as someone else, or fail with 401.
    const summary = { kind: 'password' as const, boundOrigin: 'https://api.contoso.com' };
    const withSecret = configuration('Customers API', CUSTOMER_SETTINGS, { secret: summary });
    const plan = planMigration(PROCESS, [HOLDER, USER], [withSecret]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      name: 'Customers',
      existing: null,
      secret: { status: 'ready', secret: { kind: 'password', value: PASSWORD } },
    });
    const wrongKind = configuration('Customers API', CUSTOMER_SETTINGS, {
      secret: { ...summary, kind: 'token' },
    });
    expect(planMigration(PROCESS, [HOLDER], [wrongKind]).groups[0]).toMatchObject({
      existing: null,
      secret: { status: 'ready', secret: { kind: 'password', value: PASSWORD } },
    });
  });

  it('reuses each configuration once', () => {
    const one = control('c-1', 'Bug', 'Region', {
      RestServiceAddress: REGIONS_URL,
      AuthMethod: 'Bearer token',
      RestServicePassword: 'token-1',
    });
    const two = control('c-2', 'Task', 'Region', {
      RestServiceAddress: REGIONS_URL,
      AuthMethod: 'Bearer token',
      RestServicePassword: 'token-2',
    });
    const regions = configuration('Regions API', {
      RestServiceAddress: REGIONS_URL,
      AuthMethod: 'Bearer token',
    });
    const plan = planMigration(PROCESS, [one, two], [regions]);
    expect(
      plan.groups.map((group) => [group.name, group.existing?.id ?? null, ids(group.controls)])
    ).toEqual([
      ['Regions API', regions.id, ['c-1']],
      ['Region', null, ['c-2']],
    ]);
  });

  it('makes new names unique in the process, former names included', () => {
    const region = control('c-region', 'Bug', 'Region', { RestServiceAddress: REGIONS_URL });
    const taken = [
      configuration('region', { RestServiceAddress: 'https://other.example' }),
      configuration(
        'Other',
        { RestServiceAddress: 'https://other2.example' },
        { aliases: ['Region (Bug)'] }
      ),
      configuration(
        'Region (Bug) 2',
        { RestServiceAddress: 'https://other3.example' },
        { processIds: [SCRUM] }
      ),
    ];
    expect(planMigration(PROCESS, [region], taken).groups[0]?.name).toBe('Region (Bug) 2');

    const long = 'L'.repeat(100);
    const longLabel = control('c-long', 'Bug', long, { RestServiceAddress: REGIONS_URL });
    const name = planMigration(
      PROCESS,
      [longLabel],
      [configuration(long, { RestServiceAddress: 'https://other.example' })]
    ).groups[0]?.name;
    expect(name).toBe(`${'L'.repeat(94)} (Bug)`);
  });

  it('names groups after the label, else the field, cleaning them up', () => {
    const noLabel = control('c-1', 'Bug', '', {
      FieldName: 'Custom.Region',
      RestServiceAddress: REGIONS_URL,
    });
    const odd = control('c-2', 'Task', `Bill${String.fromCharCode(10)}to`, {
      RestServiceAddress: CUSTOMERS_URL,
    });
    const bare = control('c-3', 'Epic', '', { RestServiceAddress: 'https://three.example' });
    const plan = planMigration(PROCESS, [noLabel, odd, bare], []);
    expect(plan.groups.map((group) => group.name)).toEqual(['Custom.Region', 'c-3', 'Bill to']);
  });

  it('gives the same plan whatever the order of the controls', () => {
    const controls = [
      HOLDER,
      USER,
      control('c-region-1', 'Bug', 'Region', { RestServiceAddress: REGIONS_URL }),
      control('c-region-2', 'Task', 'Region', {
        RestServiceAddress: REGIONS_URL,
        Required: 'true',
      }),
      control('c-lost', 'Feature', 'Lost', { SavedConfiguration: 'Vendors' }),
    ];
    const existing = [configuration('Region', { RestServiceAddress: 'https://other.example' })];
    const forward = outline(planMigration(PROCESS, controls, existing));
    expect(outline(planMigration(PROCESS, controls.toReversed(), existing))).toEqual(forward);
    expect(forward.groups.map((group) => group.name)).toEqual([
      'Customers',
      'Region (Bug)',
      'Region (Task)',
    ]);
  });
});

describe('assignmentInputs', () => {
  // A control that uses a configuration now, but still saves “Customers” for USER (3.0).
  const configuredHolder = {
    ...HOLDER,
    inputs: { ...HOLDER.inputs, Configuration: 'Customers v1' },
  };

  it('sends only the field and the name for most controls', () => {
    expect(assignmentInputs(USER, 'Customers API', [configuredHolder, USER])).toEqual({
      FieldName: 'Custom.BillingCustomer',
      Configuration: 'Customers API',
    });
    // Nobody uses what it saves any more: it can go.
    expect(assignmentInputs(configuredHolder, 'Customers v2', [configuredHolder])).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Customers v2',
    });
  });

  it('keeps what a 3.0 holder shares while legacy controls still use it, never its password', () => {
    const inputs = assignmentInputs(configuredHolder, 'Customers v2', [configuredHolder, USER]);
    expect(inputs).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Customers v2',
      SaveConfiguration: 'true',
      SavedConfigurationName: 'Customers',
      RestServiceAddress: CUSTOMERS_URL,
      AuthMethod: 'Basic',
      SecondLineProperty: 'email',
    });
    expect(JSON.stringify(inputs)).not.toContain(PASSWORD);
    // Controls of another process with the same saved name don't count.
    const elsewhere = { ...USER, processId: 'another-process' };
    expect(
      assignmentInputs(configuredHolder, 'Customers v2', [configuredHolder, elsewhere])
    ).toEqual({ FieldName: 'Custom.Customer', Configuration: 'Customers v2' });
    expect(
      controlsUsingSavedConfiguration([configuredHolder, elsewhere], configuredHolder)
    ).toEqual([]);
  });
});
