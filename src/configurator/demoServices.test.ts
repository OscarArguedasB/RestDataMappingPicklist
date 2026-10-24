import { describe, expect, it, vi } from 'vitest';
import { parseOAuthSettings } from '../core/config';
import { canEditPolicy, configurationsForProcess } from '../core/configurations';
import { PicklistError } from '../core/errors';
import { controlStatus, migratedInputs, planMigration } from '../core/migration';
import { requestAccessToken } from '../core/oauth';
import { DEMO_API_ORIGIN, DEMO_AUTH_ORIGIN, createDemoServices, demoFetch } from './demoServices';
import { configurationProblems } from './configurationStatus';

vi.mock('azure-devops-extension-sdk', () => ({}));

describe('demo services', () => {
  it('covers every kind of process, configuration and control', async () => {
    const demo = createDemoServices({ instant: true });
    const processes = await demo.listProcesses();
    expect(processes.map((process) => process.customizationType).toSorted()).toEqual([
      'custom',
      'inherited',
      'inherited',
      'system',
      'system',
    ]);
    const docs = await demo.listConfigurations();
    const contoso = processes.find((process) => process.name === 'Contoso Agile');
    expect(contoso).toBeTruthy();
    const now = new Date();
    const problems = new Map(
      docs.map((doc) => [doc.name, configurationProblems(doc, now).map((item) => item.message)])
    );
    expect(docs.find((doc) => doc.name === 'Customers API')?.processIds).toHaveLength(2);
    expect(problems.get('People directory')).toEqual(['Secret not set']);
    expect(problems.get('Partner portal')).toEqual(['Certificate expires in 12 days']);
    expect(docs.find((doc) => doc.name === 'Service desk')?.secret?.certificate?.subject).toMatch(
      /CN=picklist-rsa/
    );
    // A configuration whose process was deleted.
    expect(
      docs.filter((doc) => !doc.processIds.some((id) => processes.some((p) => p.id === id)))
    ).toHaveLength(1);

    const controls = contoso ? await demo.scanProcessControls(contoso) : [];
    const kinds = controls.map((control) => {
      const status = controlStatus(control);
      return status.kind === 'configured' && status.leftovers ? 'leftovers' : status.kind;
    });
    expect(new Set(kinds)).toEqual(new Set(['configured', 'leftovers', 'legacy', 'empty']));
    const plan = contoso ? planMigration(contoso, controls, docs) : null;
    expect(plan?.steps.length).toBeGreaterThan(2);
    expect(plan?.groups.some((group) => group.secret.status === 'needed')).toBe(true);
    expect(plan?.groups.some((group) => group.savedConfigurationName === 'People')).toBe(true);
  });

  it('switches who you are for permissions and layout changes', async () => {
    const demo = createDemoServices({ instant: true });
    expect(demo.mode).toBe('demo');
    const processes = await demo.listProcesses();
    expect(canEditPolicy(await demo.loadPermissions(processes))).toBe(true);
    expect(demo.demo?.personas.map((persona) => persona.id)).toEqual([
      'admin',
      'editor',
      'viewer',
      'failed',
      'refused',
    ]);

    demo.demo?.setPersona('viewer');
    expect(demo.demo?.persona()).toBe('viewer');
    const viewer = await demo.loadPermissions(processes);
    expect(viewer.collectionAdmin).toBe(false);
    expect(viewer.editableProcessIds.size).toBe(0);
    const [control] = await demo.scanProcessControls({
      id: 'demo-contoso-agile',
      name: 'Contoso Agile',
    });
    await expect(
      control ? demo.updateControlInputs(control, migratedInputs(control, 'Tickets')) : null
    ).rejects.toBeInstanceOf(PicklistError);

    demo.demo?.setPersona('failed');
    expect((await demo.loadPermissions(processes)).error).toMatch(
      /^Couldn’t check your permissions/
    );
    // Refused rather than failed: processes' configurations stay editable, the policy doesn't.
    demo.demo?.setPersona('refused');
    const refused = await demo.loadPermissions(processes);
    expect(refused.error).toBeNull();
    expect(refused.unverified).toMatch(/^Couldn’t verify your permissions/);
    expect(canEditPolicy(refused)).toBe(false);
    demo.demo?.setPersona('nobody');
    expect(demo.demo?.persona()).toBe('refused');
  });

  it('keeps changes in memory so every flow can be tried', async () => {
    const demo = createDemoServices({ instant: true });
    const [first] = await demo.listConfigurations();
    if (!first) {
      throw new Error('No sample configurations');
    }
    const saved = await demo.saveConfiguration({ ...first, name: `${first.name} renamed` });
    expect(saved.__etag).toBe((first.__etag ?? 0) + 1);
    await expect(demo.saveConfiguration(first)).rejects.toMatchObject({ status: 409 });
    expect((await demo.listConfigurations()).some((doc) => doc.name === saved.name)).toBe(true);

    const control = (
      await demo.scanProcessControls({ id: 'demo-contoso-agile', name: 'Contoso Agile' })
    ).find((item) => controlStatus(item).kind === 'empty');
    if (!control) {
      throw new Error('No control without a configuration');
    }
    const updated = await demo.updateControlInputs(control, migratedInputs(control, 'Tickets'));
    expect(updated.inputs).toEqual({ FieldName: control.fieldName, Configuration: 'Tickets' });
    const again = await demo.scanProcessControls({
      id: 'demo-contoso-agile',
      name: 'Contoso Agile',
    });
    expect(again.find((item) => item.controlId === control.controlId)?.inputs).toEqual(
      updated.inputs
    );

    await demo.saveSecret(saved.id, { kind: 'token', value: 't0ken' }, DEMO_API_ORIGIN);
    expect(await demo.copySecret(saved.id, 'demo-copy')).toBe(true);
    expect((await demo.loadSecret('demo-copy'))?.secret).toEqual({ kind: 'token', value: 't0ken' });
    await demo.deleteConfiguration(saved);
    expect(await demo.loadSecret(saved.id)).toBeNull();
    expect(await demo.copySecret('nothing', 'other')).toBe(false);
  });

  it('signs in to its own token service with a key made in the browser', async () => {
    const demo = createDemoServices({ instant: true });
    const docs = await demo.listConfigurations();
    const serviceDesk = docs.find((doc) => doc.name === 'Service desk');
    if (!serviceDesk) {
      throw new Error('No Service desk sample');
    }
    const secret = await demo.loadSecret(serviceDesk.id);
    expect(secret?.secret.kind).toBe('signingKey');
    expect(secret?.boundOrigin).toBe(DEMO_AUTH_ORIGIN);
    const settings = parseOAuthSettings(serviceDesk.settings.OAuthSettings).settings;
    const policy = await demo.loadPolicy();
    const token = await requestAccessToken(
      settings,
      secret?.secret ?? { kind: 'token', value: '' },
      policy,
      {
        fetchImpl: demoFetch,
        boundOrigin: secret?.boundOrigin,
      }
    );
    expect(token.accessToken).toMatch(/^demo-/);
    expect(token.expiresAt).toBeGreaterThan(Date.now());

    const refused = await demoFetch(`${DEMO_AUTH_ORIGIN}/oauth2/token`, {
      method: 'POST',
      body: 'grant_type=client_credentials',
    });
    expect(refused.status).toBe(401);
  });

  it('still answers the 3.0 sample API', async () => {
    const page: unknown = await (await demoFetch(`${DEMO_API_ORIGIN}/customers`)).json();
    expect(page).toMatchObject({
      data: {
        result: expect.arrayContaining([expect.objectContaining({ name: 'Adventure Works' })]),
      },
      '@odata.nextLink': expect.stringContaining('page=2'),
    });
    expect((await demoFetch(`${DEMO_API_ORIGIN}/tickets`)).status).toBe(401);
    expect(
      (
        await demoFetch(`${DEMO_API_ORIGIN}/tickets`, {
          headers: { Authorization: 'Bearer demo' },
        })
      ).status
    ).toBe(200);
    const docs = await createDemoServices({ instant: true }).listConfigurations();
    expect(configurationsForProcess(docs, 'demo-fabrikam-scrum').map((doc) => doc.name)).toEqual([
      'Customers API',
      'Regions',
    ]);
  });
});
