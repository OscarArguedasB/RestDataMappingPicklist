import { secretDestinationOrigin } from '../core/config';
import type { ConfigurationDocument } from '../core/configurations';
import { createConfigurationDocument, findNameConflicts, quoteName } from '../core/configurations';
import { PicklistError, toUserMessage } from '../core/errors';
import type { LayoutControl, MigrationGroup, MigrationPlan } from '../core/migration';
import { describeControl, hasGroupSettings, migratedInputs } from '../core/migration';
import type { StoredSecret } from '../core/secrets';
import { summarizeSecret } from '../core/secrets';
import { LeftoverInputsError } from '../devops/layout';
import { joinNames } from './configurationStatus';
import type { SetupServices } from './services';

// Runs a migration plan (core/migration.ts) the way it asks: every group's configuration first,
// with its secret when one could be read from the layout, then each control in step order. A
// control that fails keeps its old settings and still works, so nothing is rolled back.

/** What happened to a group's configuration. */
export type GroupOutcome =
  | { status: 'pending' }
  | {
      status: 'ready';
      configuration: ConfigurationDocument;
      /** True when this run created it; false when an existing one was used. */
      created: boolean;
      /** saved: moved with the controls; needed: has to be entered in the configuration. */
      secret: 'none' | 'saved' | 'kept' | 'needed';
    }
  | { status: 'failed'; message: string };

export type StepOutcome =
  | { status: 'pending' }
  | { status: 'running' }
  | { status: 'moved'; control: LayoutControl }
  /**
   * It uses its configuration now, but Azure DevOps kept its old settings (maybe a password):
   * not fully moved. `message` says so.
   */
  | { status: 'partial'; control: LayoutControl; message: string }
  | { status: 'failed'; message: string }
  /** Not moved, so the controls that use its 3.0 saved settings keep them. */
  | { status: 'skipped'; message: string };

export interface MigrationProgress {
  groups: GroupOutcome[];
  steps: StepOutcome[];
  /** Every configuration as read just before the run, when it was; the page's list follows it. */
  latest?: ConfigurationDocument[];
}

type MigrationServices = Pick<
  SetupServices,
  'saveConfiguration' | 'saveSecret' | 'deleteSecret' | 'updateControlInputs'
> &
  Partial<Pick<SetupServices, 'listConfigurations' | 'loadSecret'>>;

export function initialProgress(plan: MigrationPlan): MigrationProgress {
  return {
    groups: plan.groups.map(() => ({ status: 'pending' })),
    steps: plan.steps.map(() => ({ status: 'pending' })),
  };
}

/** Whether the group's secret can move with it: it was readable and has an origin to bind to. */
export function movableSecret(group: MigrationGroup): boolean {
  return group.secret.status === 'ready' && secretDestinationOrigin(group.settings) !== null;
}

/**
 * Why a group can't go ahead with what's stored now: a new configuration's name was taken, or a
 * reused one was deleted or its settings changed, since the plan was made (maybe in another
 * browser tab). Null when it can.
 */
function staleProblem(
  plan: MigrationPlan,
  group: MigrationGroup,
  latest: readonly ConfigurationDocument[] | undefined
): string | null {
  if (!latest) {
    return null;
  }
  if (group.existing) {
    const existingId = group.existing.id;
    const fresh = latest.find((doc) => doc.id === existingId);
    if (!fresh) {
      return `${quoteName(group.name)} was deleted meanwhile. Close this and review the move again.`;
    }
    // The controls would move onto settings they never had.
    return hasGroupSettings(fresh, group.settings)
      ? null
      : `${quoteName(group.name)} was changed meanwhile. Close this and review the move again.`;
  }
  const [conflict] = findNameConflicts(latest, { name: group.name, processIds: [plan.processId] });
  return conflict
    ? `Another configuration in ${plan.processName} answers to ${quoteName(group.name)} now. Close this and review the move again.`
    : null;
}

/** Whether two secrets are the same credential. Memory only. */
function sameSecret(a: StoredSecret, b: StoredSecret): boolean {
  if (a.kind === 'signingKey' || b.kind === 'signingKey') {
    return (
      a.kind === 'signingKey' &&
      b.kind === 'signingKey' &&
      a.key.pkcs8 === b.key.pkcs8 &&
      a.key.algorithm === b.key.algorithm
    );
  }
  return a.kind === b.kind && a.value === b.value;
}

/**
 * A configuration an earlier run of this move already made for the group: same process, same
 * settings, and the same secret bound to the same place. It happens when that run saved the
 * configuration but couldn't update the controls (a 403, the network); running the move again
 * then reuses it instead of making a second configuration with the same secret. Planning can't
 * tell, because it never reads stored secrets.
 */
async function earlierMove(
  plan: MigrationPlan,
  group: MigrationGroup,
  services: MigrationServices,
  latest: readonly ConfigurationDocument[] | undefined,
  origin: string | null
): Promise<ConfigurationDocument | null> {
  if (group.existing || group.secret.status !== 'ready' || !origin || !latest) {
    return null;
  }
  const { secret } = group.secret;
  const candidates = latest.filter(
    (doc) =>
      doc.processIds.includes(plan.processId) &&
      doc.secret?.kind === secret.kind &&
      doc.secret.boundOrigin === origin &&
      hasGroupSettings(doc, group.settings)
  );
  for (const candidate of candidates) {
    // A secret that can't be read just isn't reused.
    const stored = await services.loadSecret?.(candidate.id).catch(() => null);
    if (stored && stored.boundOrigin === origin && sameSecret(stored.secret, secret)) {
      return candidate;
    }
  }
  return null;
}

async function runGroup(
  plan: MigrationPlan,
  group: MigrationGroup,
  services: MigrationServices,
  latest: readonly ConfigurationDocument[] | undefined
): Promise<GroupOutcome> {
  const stale = staleProblem(plan, group, latest);
  if (stale) {
    throw new PicklistError('config', stale);
  }
  const origin = secretDestinationOrigin(group.settings);
  const earlier = await earlierMove(plan, group, services, latest, origin);
  if (earlier) {
    return { status: 'ready', configuration: earlier, created: false, secret: 'kept' };
  }
  // What's stored now, with its current version, when it was read just before.
  const existing = group.existing
    ? (latest?.find((item) => item.id === group.existing?.id) ?? group.existing)
    : null;
  let doc =
    existing ??
    createConfigurationDocument({
      name: group.name,
      processIds: [plan.processId],
      settings: group.settings,
    });
  let savedSecret = false;
  if (group.secret.status === 'ready' && origin) {
    // The secret goes first, so the configuration is only ever stored with a summary of a
    // secret that exists.
    const stored = await services.saveSecret(doc.id, group.secret.secret, origin);
    doc = {
      ...doc,
      secret: summarizeSecret(group.secret.secret, origin, {
        updatedBy: stored.updatedBy,
        updatedAt: stored.updatedAt,
      }),
    };
    savedSecret = true;
  }
  if (!group.existing || savedSecret) {
    try {
      doc = await services.saveConfiguration(doc);
    } catch (error) {
      if (savedSecret && !group.existing) {
        // Nothing uses it: the configuration it belongs to was never created.
        await services.deleteSecret(doc.id).catch(() => undefined);
      }
      throw error;
    }
  }
  const secret =
    group.secret.status === 'none'
      ? 'none'
      : group.secret.status === 'kept'
        ? 'kept'
        : savedSecret
          ? 'saved'
          : 'needed';
  return { status: 'ready', configuration: doc, created: !group.existing, secret };
}

/**
 * Runs the plan, calling `onProgress` with a new snapshot after every change. Never rejects:
 * failures are in the outcomes. The plan's secrets are only sent to saveSecret.
 */
export async function runMigration(
  plan: MigrationPlan,
  services: MigrationServices,
  onProgress: (progress: MigrationProgress) => void = () => undefined
): Promise<MigrationProgress> {
  const groups: GroupOutcome[] = plan.groups.map(() => ({ status: 'pending' }));
  const steps: StepOutcome[] = plan.steps.map(() => ({ status: 'pending' }));
  // Names are checked against what's stored now, not what the page read when it opened: names
  // must stay unique per process, and the store doesn't check them.
  let latest: ConfigurationDocument[] | undefined;
  let unchecked: string | null = null;
  if (services.listConfigurations) {
    try {
      latest = await services.listConfigurations();
    } catch (error) {
      unchecked = `Couldn’t check the configuration names first. ${toUserMessage(error)}`;
    }
  }
  const report = () =>
    onProgress({ groups: [...groups], steps: [...steps], ...(latest ? { latest } : {}) });

  for (const [index, group] of plan.groups.entries()) {
    try {
      if (unchecked) {
        throw new PicklistError('network', unchecked);
      }
      groups[index] = await runGroup(plan, group, services, latest);
    } catch (error) {
      groups[index] = { status: 'failed', message: toUserMessage(error) };
    }
    report();
  }

  // Controls that didn't move keep their settings; the controls whose 3.0 saved configuration
  // they use must keep theirs too.
  const stayed = new Set<LayoutControl>();
  for (const [index, step] of plan.steps.entries()) {
    const group = groups[step.group];
    if (group?.status !== 'ready') {
      steps[index] = {
        status: 'failed',
        message:
          group?.status === 'failed'
            ? `Its configuration couldn’t be saved. ${group.message}`
            : 'Its configuration couldn’t be saved.',
      };
      stayed.add(step.control);
      report();
      continue;
    }
    const waiting = step.usedBy.filter((user) => stayed.has(user));
    if (waiting.length > 0) {
      steps[index] = {
        status: 'skipped',
        message: `Kept its settings, because ${joinNames(waiting.map(describeControl))} still ${waiting.length === 1 ? 'uses' : 'use'} them.`,
      };
      stayed.add(step.control);
      report();
      continue;
    }
    steps[index] = { status: 'running' };
    report();
    try {
      const control = await services.updateControlInputs(
        step.control,
        migratedInputs(step.control, group.configuration.name)
      );
      steps[index] = { status: 'moved', control };
    } catch (error) {
      if (error instanceof LeftoverInputsError) {
        // It moved (it names its configuration now), but isn't clean: never say it fully moved.
        steps[index] = { status: 'partial', control: error.control, message: error.message };
      } else {
        steps[index] = { status: 'failed', message: toUserMessage(error) };
        stayed.add(step.control);
      }
    }
    report();
  }
  return { groups, steps, ...(latest ? { latest } : {}) };
}
