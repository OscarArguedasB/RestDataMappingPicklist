import { describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { planMigration } from '../core/migration';
import { LeftoverInputsError } from '../devops/layout';
import type { MigrationProgress } from './migrationRun';
import { movableSecret, runMigration } from './migrationRun';
import type { SetupServices } from './services';
import { configuration, fakeServices, layoutControl } from './testUtils';

const PROCESS = { id: 'p-contoso', name: 'Contoso Agile' };

function control(
  type: string,
  label: string,
  inputs: Record<string, string>,
  controlId = `${type}-${label}`
): LayoutControl {
  return layoutControl({
    controlId,
    label,
    workItemType: { name: type, referenceName: `Contoso.${type}` },
    inputs: { FieldName: `Custom.${label}`, ...inputs },
  });
}

const SPONSOR = control('Epic', 'Sponsor', {
  RestServiceAddress: 'https://api.contoso.com/people',
  SaveConfiguration: 'true',
  SavedConfigurationName: 'People',
});
const REVIEWER = control('Bug', 'Reviewer', { SavedConfiguration: 'People' });
const TICKET = control('Task', 'Ticket', {
  RestServiceAddress: 'https://tickets.contoso.com/api',
  AuthMethod: 'Basic',
  RestServiceUserName: 'svc',
  RestServicePassword: 'p4ssw0rd',
});
const HIDDEN = control('Task', 'Hidden', {
  RestServiceAddress: 'https://hidden.contoso.com/api',
  AuthMethod: 'Bearer token',
  RestServicePassword: '********',
});

function servicesFor(overrides: Partial<SetupServices> = {}) {
  return fakeServices(overrides, { controls: [SPONSOR, REVIEWER, TICKET, HIDDEN] });
}

describe('running a migration plan', () => {
  it('creates configurations with their secrets first, then moves each control in order', async () => {
    const services = servicesFor();
    const plan = planMigration(PROCESS, [SPONSOR, REVIEWER, TICKET, HIDDEN], []);
    const snapshots: MigrationProgress[] = [];
    const result = await runMigration(plan, services, (progress) => snapshots.push(progress));

    expect(result.groups.map((group) => group.status)).toEqual(['ready', 'ready', 'ready']);
    const byName = new Map(
      result.groups.flatMap((group) =>
        group.status === 'ready' ? [[group.configuration.name, group] as const] : []
      )
    );
    expect(byName.get('People')).toEqual(
      expect.objectContaining({ created: true, secret: 'none' })
    );
    expect(byName.get('Ticket')).toEqual(expect.objectContaining({ secret: 'saved' }));
    expect(byName.get('Hidden')).toEqual(expect.objectContaining({ secret: 'needed' }));

    // The readable password went to saveSecret, bound to the API's origin, before its
    // configuration was saved with the summary.
    const ticketGroup = byName.get('Ticket');
    const ticketId = ticketGroup?.status === 'ready' ? ticketGroup.configuration.id : '';
    expect(services.saveSecret).toHaveBeenCalledTimes(1);
    expect(services.saveSecret).toHaveBeenCalledWith(
      ticketId,
      { kind: 'password', value: 'p4ssw0rd' },
      'https://tickets.contoso.com'
    );
    const saveSecretOrder = vi.mocked(services.saveSecret).mock.invocationCallOrder[0] ?? 0;
    const ticketSave = vi
      .mocked(services.saveConfiguration)
      .mock.calls.findIndex(([doc]) => doc.id === ticketId);
    expect(saveSecretOrder).toBeLessThan(
      vi.mocked(services.saveConfiguration).mock.invocationCallOrder[ticketSave] ?? 0
    );
    expect(vi.mocked(services.saveConfiguration).mock.calls[ticketSave]?.[0].secret).toEqual(
      expect.objectContaining({ kind: 'password', boundOrigin: 'https://tickets.contoso.com' })
    );

    // The reviewer uses the sponsor's saved settings, so it moves first.
    const updates = vi.mocked(services.updateControlInputs).mock.calls;
    const order = updates.map(([moved]) => moved.label);
    expect(order.indexOf('Reviewer')).toBeLessThan(order.indexOf('Sponsor'));
    expect(updates.find(([moved]) => moved.label === 'Reviewer')?.[1]).toEqual({
      FieldName: 'Custom.Reviewer',
      Configuration: 'People',
    });
    expect(result.steps.every((step) => step.status === 'moved')).toBe(true);
    expect(snapshots.at(-1)).toEqual(result);
    // Secrets read from the layout never end up in what the page shows.
    expect(JSON.stringify(snapshots)).not.toContain('p4ssw0rd');
  });

  it('keeps a control on its settings when its configuration can’t be saved', async () => {
    const services = servicesFor({
      saveConfiguration: vi.fn<SetupServices['saveConfiguration']>(async () => {
        throw new PicklistError('network', 'Couldn’t save “Ticket”. Try again in a moment.');
      }),
    });
    const plan = planMigration(PROCESS, [TICKET], []);
    const result = await runMigration(plan, services);
    expect(result.groups[0]).toEqual({
      status: 'failed',
      message: 'Couldn’t save “Ticket”. Try again in a moment.',
    });
    expect(result.steps[0]).toEqual({
      status: 'failed',
      message:
        'Its configuration couldn’t be saved. Couldn’t save “Ticket”. Try again in a moment.',
    });
    // The secret saved for it is removed again, since nothing uses it.
    const savedId = vi.mocked(services.saveSecret).mock.calls[0]?.[0];
    expect(services.deleteSecret).toHaveBeenCalledWith(savedId);
    expect(services.updateControlInputs).not.toHaveBeenCalled();
  });

  it('doesn’t move a control whose saved settings are still used by one that failed', async () => {
    const updateControlInputs = vi.fn<SetupServices['updateControlInputs']>(
      async (moved, inputs) => {
        if (moved.label === 'Reviewer') {
          throw new PicklistError('http', 'You don’t have permission to edit the process.', 403);
        }
        return { ...moved, inputs };
      }
    );
    const services = servicesFor({ updateControlInputs });
    const plan = planMigration(PROCESS, [SPONSOR, REVIEWER], []);
    const result = await runMigration(plan, services);
    const outcome = (label: string) =>
      result.steps[plan.steps.findIndex((step) => step.control.label === label)];
    expect(outcome('Reviewer')).toEqual({
      status: 'failed',
      message: 'You don’t have permission to edit the process.',
    });
    expect(outcome('Sponsor')).toEqual({
      status: 'skipped',
      message: 'Kept its settings, because Bug › Reviewer still uses them.',
    });
    expect(updateControlInputs).toHaveBeenCalledTimes(1);
  });

  it('reuses a configuration with the same settings and keeps its secret', async () => {
    const existing = configuration('Tickets', {
      settings: {
        RestServiceAddress: 'https://hidden.contoso.com/api',
        AuthMethod: 'Bearer token',
      },
      secret: { kind: 'token', boundOrigin: 'https://hidden.contoso.com' },
    });
    const services = fakeServices({}, { controls: [HIDDEN], configurations: [existing] });
    const plan = planMigration(PROCESS, [HIDDEN], [existing]);
    expect(plan.groups[0]?.existing?.id).toBe(existing.id);
    const result = await runMigration(plan, services);
    expect(result.groups[0]).toEqual(
      expect.objectContaining({ status: 'ready', created: false, secret: 'kept' })
    );
    expect(services.saveConfiguration).not.toHaveBeenCalled();
    expect(vi.mocked(services.updateControlInputs).mock.calls[0]?.[1]).toEqual({
      FieldName: 'Custom.Hidden',
      Configuration: 'Tickets',
    });
  });

  it('reports a control whose old settings stayed as moved, but not fully', async () => {
    const services = servicesFor();
    vi.mocked(services.updateControlInputs).mockImplementation(async (target, inputs) => {
      // As if Azure DevOps kept the old inputs, the password among them.
      throw new LeftoverInputsError({ ...target, inputs: { ...target.inputs, ...inputs } }, [
        'RestServicePassword',
      ]);
    });
    const plan = planMigration(PROCESS, [TICKET], []);
    const result = await runMigration(plan, services);
    expect(result.steps[0]).toEqual({
      status: 'partial',
      control: expect.objectContaining({
        inputs: expect.objectContaining({ Configuration: 'Ticket' }),
      }),
      message:
        'The old settings, including the password, are still stored on this control. Try again, or remove the control from the form and add it again.',
    });
  });

  it('checks new names against what’s stored now, before writing anything', async () => {
    // Someone added “Ticket” in another tab after the page read the list.
    const theirs = configuration('Ticket', { id: 'cfg-theirs' });
    const services = fakeServices({}, { controls: [TICKET], configurations: [theirs] });
    const plan = planMigration(PROCESS, [TICKET], []);
    expect(plan.groups[0]?.name).toBe('Ticket');
    const result = await runMigration(plan, services);
    expect(result.groups[0]).toEqual({
      status: 'failed',
      message:
        'Another configuration in Contoso Agile answers to “Ticket” now. Close this and review the move again.',
    });
    expect(result.steps[0]?.status).toBe('failed');
    expect(services.saveSecret).not.toHaveBeenCalled();
    expect(services.saveConfiguration).not.toHaveBeenCalled();
    expect(services.updateControlInputs).not.toHaveBeenCalled();
    expect(result.latest?.map((doc) => doc.id)).toEqual(['cfg-theirs']);
  });

  it('reuses what an earlier run made when its controls couldn’t be updated, secret and all', async () => {
    const services = fakeServices({}, { controls: [TICKET] });
    // Run 1 saves the secret and the configuration, then the control update is refused.
    vi.mocked(services.updateControlInputs).mockRejectedValueOnce(
      new PicklistError('http', 'You don’t have permission to edit the process.', 403)
    );
    const first = await runMigration(planMigration(PROCESS, [TICKET], []), services);
    expect(first.groups[0]).toEqual(expect.objectContaining({ status: 'ready', created: true }));
    expect(first.steps[0]?.status).toBe('failed');
    const stored = await services.listConfigurations();
    expect(stored.map((doc) => doc.name)).toEqual(['Ticket']);

    // Run 2: planning can't read the stored secret, so it plans a new configuration…
    const plan = planMigration(PROCESS, [TICKET], stored);
    expect(plan.groups[0]?.existing).toBeNull();
    vi.mocked(services.saveConfiguration).mockClear();
    vi.mocked(services.saveSecret).mockClear();
    const second = await runMigration(plan, services);
    // …but the run finds the same secret there and uses that configuration instead.
    expect(second.groups[0]).toEqual(
      expect.objectContaining({
        status: 'ready',
        created: false,
        secret: 'kept',
        configuration: expect.objectContaining({ id: stored[0]?.id, name: 'Ticket' }),
      })
    );
    expect(services.saveConfiguration).not.toHaveBeenCalled();
    expect(services.saveSecret).not.toHaveBeenCalled();
    expect(second.steps[0]?.status).toBe('moved');
    expect(vi.mocked(services.updateControlInputs).mock.calls.at(-1)?.[1]).toEqual({
      FieldName: 'Custom.Ticket',
      Configuration: 'Ticket',
    });
    expect((await services.listConfigurations()).map((doc) => doc.name)).toEqual(['Ticket']);
  });

  it('still makes a configuration of its own when the stored secret differs', async () => {
    const services = fakeServices({}, { controls: [TICKET] });
    vi.mocked(services.updateControlInputs).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await runMigration(planMigration(PROCESS, [TICKET], []), services);
    const [stored] = await services.listConfigurations();
    // Someone entered another password meanwhile.
    await services.saveSecret(
      stored?.id ?? '',
      { kind: 'password', value: 'other' },
      'https://tickets.contoso.com'
    );
    const second = await runMigration(
      planMigration(PROCESS, [TICKET], await services.listConfigurations()),
      services
    );
    expect(second.groups[0]).toEqual(
      expect.objectContaining({
        status: 'ready',
        created: true,
        configuration: expect.objectContaining({ name: 'Ticket (Task)' }),
      })
    );
  });

  it('refuses to reuse a configuration whose settings changed since the plan was made', async () => {
    const existing = configuration('Tickets', {
      settings: {
        RestServiceAddress: 'https://hidden.contoso.com/api',
        AuthMethod: 'Bearer token',
      },
      secret: { kind: 'token', boundOrigin: 'https://hidden.contoso.com' },
    });
    const services = fakeServices({}, { controls: [HIDDEN], configurations: [existing] });
    const plan = planMigration(PROCESS, [HIDDEN], [existing]);
    expect(plan.groups[0]?.existing?.id).toBe(existing.id);
    // Another administrator points it at another API meanwhile.
    await services.saveConfiguration({
      ...existing,
      settings: { ...existing.settings, RestServiceAddress: 'https://other.contoso.com/api' },
    });
    const result = await runMigration(plan, services);
    expect(result.groups[0]).toEqual({
      status: 'failed',
      message: '“Tickets” was changed meanwhile. Close this and review the move again.',
    });
    expect(services.updateControlInputs).not.toHaveBeenCalled();
  });

  it('asks for the secret again when there’s no fixed address to bind it to', async () => {
    const templated = control('Task', 'Region', {
      RestServiceAddress: 'https://$(Custom.Region).contoso.com/api',
      AuthMethod: 'API key',
      RestServicePassword: 'k3y',
    });
    const plan = planMigration(PROCESS, [templated], []);
    expect(plan.groups[0]?.secret.status).toBe('ready');
    expect(plan.groups[0] ? movableSecret(plan.groups[0]) : true).toBe(false);
    const services = servicesFor();
    const result = await runMigration(plan, services);
    expect(services.saveSecret).not.toHaveBeenCalled();
    expect(result.groups[0]).toEqual(expect.objectContaining({ secret: 'needed' }));
    expect(vi.mocked(services.saveConfiguration).mock.calls[0]?.[0].secret).toBeNull();
  });
});
