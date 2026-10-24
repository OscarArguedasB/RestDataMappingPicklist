import type { JSX, RefObject } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DismissIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import { AUTH_METHOD_LABELS } from '../core/config';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import {
  canCreateIn,
  canEditConfiguration,
  canEditProcess,
  canShareWith,
  createConfigurationDocument,
  findNameConflicts,
  forgetAlias,
  nameConflictMessage,
  nameKey,
  quoteName,
  renameConfiguration,
  validateConfigurationName,
} from '../core/configurations';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import type { SecurityPolicy } from '../core/policy';
import type { SecretDocument, SecretKind, SecretSummary, StoredSecret } from '../core/secrets';
import { summarizeSecret } from '../core/secrets';
import type { ProcessSummary } from '../devops/processes';
import { canHoldControls } from '../devops/processes';
import type { TestCredential } from './BuildTab';
import { BuildTab } from './BuildTab';
import { ConfirmDialog } from './ConfirmDialog';
import type { CredentialDraft } from './CredentialsCard';
import { controlsNaming, countOf } from './configurationStatus';
import { CredentialsCard, EMPTY_CREDENTIALS, signingKeyFor } from './CredentialsCard';
import { ChevronLeftIcon } from './icons';
import { secretFingerprint } from './probe';
import type { SetupServices } from './services';
import type { Draft, Issue, SecretPlan } from './settings';
import {
  REQUIRED_MESSAGES,
  SAMPLE_DRAFT,
  SECRET_MOVED,
  SECRET_NOUNS,
  draftFromSettings,
  draftToSettings,
  formatDay,
  keyIdProblem,
  listWithOr,
  missingRequired,
  planSecret,
  sameSettings,
  saveProblems,
  secretApiDestination,
  secretDestination,
  secretKindOf,
  validateDraft,
} from './settings';
import { Callout, IssueMessage, ReadOnlyContext, ShowRequiredContext, TextField } from './ui';
import { UseOnFormCard } from './UseOnFormCard';

export interface ConfigurationEditorProps {
  services: SetupServices;
  policy: SecurityPolicy;
  permissions: PermissionSnapshot;
  processes: readonly ProcessSummary[];
  /** Every configuration, for name checks and sharing. */
  configurations: readonly ConfigurationDocument[];
  /** The configuration to edit; null for a new one. */
  configuration: ConfigurationDocument | null;
  /** The process the editor was opened from; a new configuration starts shared with it. */
  processId: string;
  /** After a successful save: the stored document and its previous name when it was renamed. */
  onSaved: (saved: ConfigurationDocument, previousName: string | null) => void;
  /** Leave the editor; the editor asks first when there are unsaved changes. */
  onClose: () => void;
  /** Lets the page warn before switching tabs with unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Opens “Controls in this process” (after asking about unsaved changes). Without it, “Use it on
   * a form” mentions the place without linking to it.
   */
  onShowControls?: () => void;
  /**
   * Every configuration as just read from Azure DevOps, before a save and on Reload: newer than
   * `configurations`, so the page's list can follow it.
   */
  onConfigurationsLoaded?: (docs: ConfigurationDocument[]) => void;
  /** The controls read from the processes' layouts so far, to count who uses a former name. */
  scanned?: readonly LayoutControl[];
  /** False while some processes haven't been read yet, so counts may be short. */
  scansComplete?: boolean;
  /** For certificate dates; tests set it. */
  now?: () => Date;
}

/** What's being edited; reset as a whole when a configuration is opened, saved or reloaded. */
interface EditorState {
  /** The configuration as it's stored; null until a new one is saved. */
  baseline: ConfigurationDocument | null;
  name: string;
  processIds: string[];
  draft: Draft;
  credentials: CredentialDraft;
  /** Former names to forget when saving. */
  forgotten: string[];
  /** Settings that couldn't be read and were reset. */
  problems: string[];
}

function initialState(configuration: ConfigurationDocument | null, processId: string): EditorState {
  const { draft, problems } = draftFromSettings(configuration?.settings ?? {});
  return {
    baseline: configuration,
    name: configuration?.name ?? '',
    processIds: configuration ? [...configuration.processIds] : [processId],
    draft,
    credentials: EMPTY_CREDENTIALS,
    forgotten: [],
    problems,
  };
}

type Confirmation =
  | { kind: 'discard'; proceed: () => void }
  | { kind: 'switch'; patch: Partial<Draft> }
  | { kind: 'remove' }
  | { kind: 'unshare'; processId: string }
  | { kind: 'forget'; alias: string };

function isForgotten(forgotten: readonly string[], alias: string): boolean {
  return forgotten.some((name) => nameKey(name) === nameKey(alias));
}

/** What happens to controls that use a former name that's about to go. */
function usersSentence(users: readonly LayoutControl[] | null, newName: string): string {
  if (users === null) {
    return `Controls that still use it will show “Configuration not found” until they use ${quoteName(newName)}.`;
  }
  if (users.length === 0) {
    return 'No control uses it.';
  }
  return `${countOf(users.length, 'control')} still ${users.length === 1 ? 'uses' : 'use'} it and will show “Configuration not found” until ${users.length === 1 ? 'it uses' : 'they use'} ${quoteName(newName)}.`;
}

/** Under the name, when renaming drops the oldest former name. */
function droppedMessage(name: string, users: readonly LayoutControl[] | null): string {
  const lead = `Renaming drops the oldest former name, ${quoteName(name)}: a configuration keeps five.`;
  return users === null || users.length === 0
    ? `${lead} Forget another one first to keep it.`
    : `${lead} ${countOf(users.length, 'control')} still ${users.length === 1 ? 'uses' : 'use'} it. Forget another one first to keep it.`;
}

/**
 * Puts a secret back as it was before a save that didn't go through: the previous one (read
 * into memory just before), or none. False when that wasn't possible, or isn't known.
 */
async function restoreSecret(
  services: SetupServices,
  id: string,
  previous: SecretDocument | null | undefined
): Promise<boolean> {
  try {
    if (previous === undefined) {
      return false;
    }
    if (previous === null) {
      await services.deleteSecret(id);
    } else {
      await (previous.apiOrigin
        ? services.saveSecret(id, previous.secret, previous.boundOrigin, previous.apiOrigin)
        : services.saveSecret(id, previous.secret, previous.boundOrigin));
    }
    return true;
  } catch {
    return false;
  }
}

interface Message {
  tone: 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
  /** Someone else changed or deleted it: offer to reload. */
  reload?: boolean;
  /** It no longer exists: offer to go back. */
  gone?: boolean;
  /**
   * Saved without its secret, but the old secret couldn't be deleted: the id of the configuration
   * it belongs to, to offer removing it again. Nothing else shows it any more, and any member of
   * the organization could still read it.
   */
  leftoverSecretId?: string;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof PicklistError ? error.message : fallback;
}

/** The secret typed or chosen in the editor, ready to save or test; null when there's none. */
function enteredSecret(
  kind: SecretKind | null,
  password: string,
  credentials: CredentialDraft
): StoredSecret | null {
  if (kind === null) {
    return null;
  }
  if (kind === 'signingKey') {
    const key = signingKeyFor(credentials);
    return key ? { kind, key } : null;
  }
  return password.trim() ? { kind, value: password } : null;
}

/** Who saved a secret and when: what the store says, else this person, now. */
function secretStamp(saved: SecretDocument, services: SetupServices) {
  return {
    updatedBy: saved.updatedBy ?? services.currentUser().displayName,
    updatedAt: saved.updatedAt ?? new Date().toISOString(),
  };
}

/** What a saved secret is, for sentences. */
function storedNoun(summary: SecretSummary): string {
  if (summary.kind === 'signingKey') {
    return summary.certificate ? 'certificate' : 'key';
  }
  return SECRET_NOUNS[summary.kind];
}

/** The sign-in a draft uses, named for “can’t be used with …”. */
function signInLabel(draft: Draft, stored: SecretSummary | null): string {
  const oauthKinds: readonly SecretKind[] = ['clientSecret', 'signingKey'];
  if (draft.authMethod === 'oauth2' && stored && oauthKinds.includes(stored.kind)) {
    return draft.credential === 'certificate' ? 'a certificate' : 'a client secret';
  }
  return AUTH_METHOD_LABELS[draft.authMethod];
}

/** Keeps the focused field clear of the pinned footer (WCAG 2.4.11), like the policy's Save bar. */
function useScrollPaddingFor(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const bar = ref.current;
    if (!bar || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const height = bar.offsetHeight;
      root.style.setProperty('--cf-editor-footer-space', `${height ? height + 8 : 0}px`);
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--cf-editor-footer-space');
    };
  }, [ref]);
}

/** A list of the processes it can also be shared with, under an “Add process” button. */
function AddProcess(props: {
  processes: readonly ProcessSummary[];
  onAdd: (processId: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLUListElement>(null);

  // A click anywhere else closes the list, like a menu.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className='cf-add-process'>
      <button
        ref={button}
        type='button'
        className='cf-button cf-button--small'
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        Add process
      </button>
      <ul ref={panel} id={`${id}-list`} className='cf-add-process__list' hidden={!open}>
        {props.processes.map((process) => (
          <li key={process.id}>
            <button
              type='button'
              className='cf-add-process__item'
              aria-label={`Share with ${process.name}`}
              onClick={() => {
                close();
                props.onAdd(process.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  close();
                }
              }}
            >
              {process.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The configuration editor: its name, the processes it's shared with, its settings and write-only
 * secret, the test with the live preview, and how to use it on a form. It owns saving: names are
 * checked first, then the secret and the configuration are written in an order that never leaves
 * a configuration pointing at a secret that isn't there.
 */
export function ConfigurationEditor(props: ConfigurationEditorProps): JSX.Element {
  const { services, policy, permissions, processes, configurations } = props;
  const id = useId();
  const [state, setState] = useState<EditorState>(() =>
    initialState(props.configuration, props.processId)
  );
  const [source, setSource] = useState(props.configuration);
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [showRequired, setShowRequired] = useState(false);
  const [reveal, setReveal] = useState(0);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [removingSecret, setRemovingSecret] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // The fingerprint of a secret saved here, so the last test doesn't look out of date after it.
  const [savedSecretId, setSavedSecretId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const sharingRef = useRef<HTMLUListElement>(null);
  const focusProblem = useRef(false);
  useScrollPaddingFor(footerRef);

  const { baseline, name, processIds, draft, credentials } = state;
  const credentialsHeadingId = `${id}-credentials`;

  // The editor replaces the list, so the new view's heading takes focus.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const byId = useMemo(
    () => new Map(processes.map((process) => [process.id, process])),
    [processes]
  );
  const processName = useCallback(
    (processId: string) => byId.get(processId)?.name ?? 'Unknown process',
    [byId]
  );

  const readOnly = baseline
    ? !canEditConfiguration(permissions, baseline)
    : !canCreateIn(permissions, props.processId);
  const kind = secretKindOf(draft);
  const stored = baseline?.secret ?? null;
  const entered = enteredSecret(kind, draft.password, credentials);
  const credentialState = { stored, entered: entered !== null, removing: credentials.removing };
  const plan: SecretPlan = planSecret(draft, credentialState);
  // Basic with a user name works without a password: forms send the user name alone.
  const passwordOptional = draft.authMethod === 'basic' && draft.username.trim() !== '';
  const issues = validateDraft(draft, policy, credentialState);
  const destination = secretDestination(draft);
  const keyIdText = credentials.keyId.trim();
  const keyIdMessage = kind === 'signingKey' && keyIdText ? keyIdProblem(keyIdText) : null;
  const keyIdIssue: Issue | null = keyIdMessage ? { tone: 'error', message: keyIdMessage } : null;

  // Names are unique per process, former names included.
  const trimmedName = name.normalize('NFC').trim();
  const nameProblem = trimmedName ? validateConfigurationName(trimmedName) : null;
  // The stored configuration without the former names chosen to be forgotten, then renamed.
  const kept = baseline
    ? state.forgotten.reduce((doc, alias) => forgetAlias(doc, alias), baseline)
    : null;
  const renamed =
    kept && trimmedName && !nameProblem ? renameConfiguration(kept, trimmedName) : null;
  const conflicts =
    trimmedName && !nameProblem
      ? findNameConflicts(configurations, {
          id: baseline?.id,
          name: trimmedName,
          aliases: renamed?.aliases ?? [],
          processIds,
        })
      : [];
  const ownConflict = conflicts.find((conflict) => nameKey(conflict.name) === nameKey(trimmedName));
  const formerConflict = conflicts.find((conflict) => conflict !== ownConflict);
  // Controls that use a name, in the processes it's shared with (null: they haven't been read).
  const usersOf = (alias: string): LayoutControl[] | null =>
    props.scanned ? controlsNaming(props.scanned, alias, processIds) : null;
  // A configuration keeps five former names: renaming once more drops the oldest.
  const dropped =
    kept && renamed
      ? [kept.name, ...kept.aliases].filter(
          (old) =>
            nameKey(old) !== nameKey(renamed.name) &&
            !renamed.aliases.some((alias) => nameKey(alias) === nameKey(old))
        )
      : [];
  const droppedIssue: Issue | null = dropped[0]
    ? { tone: 'warning', message: droppedMessage(dropped[0], usersOf(dropped[0])) }
    : null;
  const nameIssue: Issue | null = nameProblem
    ? { tone: 'error', message: nameProblem }
    : ownConflict
      ? { tone: 'error', message: nameConflictMessage(ownConflict, processName) }
      : null;
  const sharingIssue: Issue | null = formerConflict
    ? { tone: 'error', message: nameConflictMessage(formerConflict, processName) }
    : null;

  const problemCount =
    (trimmedName ? 0 : 1) +
    (nameIssue ? 1 : 0) +
    (sharingIssue ? 1 : 0) +
    missingRequired(draft).length +
    saveProblems(issues).length +
    (keyIdIssue ? 1 : 0) +
    invalid.size;

  const baselineSettings = useMemo(
    () => draftToSettings(draftFromSettings(baseline?.settings ?? {}).draft),
    [baseline]
  );
  const dirty =
    trimmedName !== (baseline?.name ?? '') ||
    !sameIds(processIds, baseline?.processIds ?? [props.processId]) ||
    !sameSettings(draftToSettings(draft), baselineSettings) ||
    entered !== null ||
    credentials.removing ||
    state.forgotten.length > 0;

  // A newer copy of this configuration (or another one) from the page is shown when nothing here
  // would be lost.
  if (props.configuration !== source) {
    setSource(props.configuration);
    const incoming = props.configuration;
    const another = (incoming?.id ?? null) !== (baseline?.id ?? null);
    const newer = incoming !== null && !another && incoming.__etag !== baseline?.__etag;
    if (another || (newer && !dirty)) {
      setState(initialState(incoming, props.processId));
      setSavedSecretId(null);
      setShowRequired(false);
      setMessage(null);
    }
  }

  const onDirtyChange = useRef(props.onDirtyChange);
  useEffect(() => {
    onDirtyChange.current = props.onDirtyChange;
  });
  useEffect(() => {
    onDirtyChange.current?.(dirty);
  }, [dirty]);
  useEffect(() => {
    const latest = onDirtyChange;
    return () => latest.current?.(false);
  }, []);

  // Closing the browser tab with unsaved changes asks first, too.
  useEffect(() => {
    if (!dirty) {
      return undefined;
    }
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // After Save with problems, the first one takes focus (in the order they're shown).
  useEffect(() => {
    if (!focusProblem.current) {
      return;
    }
    focusProblem.current = false;
    const candidates = rootRef.current?.querySelectorAll<HTMLElement>(
      '[aria-invalid="true"], [data-problem="true"]'
    );
    const target = [...(candidates ?? [])].find((element) => !element.closest('[hidden]'));
    target?.focus();
  });

  /** Every change goes through here; a “Saved” message gives way to the next change. */
  const edit = (change: (current: EditorState) => EditorState) => {
    setState(change);
    setMessage((current) => (current?.tone === 'success' ? null : current));
  };

  const applyChange = (patch: Partial<Draft>) =>
    edit((current) => {
      const next = { ...current.draft, ...patch };
      // A secret typed for one kind of sign-in is never sent as another.
      if (secretKindOf(next) === secretKindOf(current.draft)) {
        return { ...current, draft: next };
      }
      return {
        ...current,
        draft: { ...next, password: '' },
        credentials: { ...current.credentials, replacing: false },
      };
    });

  /** Changing how it signs in so the saved secret no longer fits asks first. */
  const requestChange = (patch: Partial<Draft>) => {
    const before = secretKindOf(draft);
    const after = secretKindOf({ ...draft, ...patch });
    if (before !== after && stored && stored.kind === before && !credentials.removing) {
      setConfirm({ kind: 'switch', patch });
      return;
    }
    applyChange(patch);
  };

  const onValidityChange = useCallback(
    (key: string, valid: boolean) =>
      setInvalid((current) => {
        if (valid !== current.has(key)) {
          return current;
        }
        const next = new Set(current);
        if (valid) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      }),
    []
  );

  const leave = (proceed: () => void) => {
    if (dirty && !readOnly) {
      setConfirm({ kind: 'discard', proceed });
    } else {
      proceed();
    }
  };

  const reset = (configuration: ConfigurationDocument | null) => {
    setState(initialState(configuration, props.processId));
    setSavedSecretId(null);
    setShowRequired(false);
  };

  const save = async () => {
    if (saving || readOnly || !dirty) {
      return;
    }
    if (problemCount > 0) {
      setShowRequired(true);
      setReveal((count) => count + 1);
      focusProblem.current = true;
      return;
    }
    const current = state;
    const secret = entered;
    setSaving(true);
    setMessage(null);
    try {
      const settings = draftToSettings(current.draft);
      // Former names chosen to be forgotten go first, so renaming can keep the others.
      const base = current.baseline
        ? current.forgotten.reduce((doc, alias) => forgetAlias(doc, alias), current.baseline)
        : null;
      const doc = base
        ? {
            ...renameConfiguration(base, trimmedName),
            processIds: [...current.processIds],
            settings,
          }
        : createConfigurationDocument({
            name: trimmedName,
            processIds: current.processIds,
            settings,
          });
      // Before anything is written, what's stored now: the list the page read when it opened
      // may be hours old, and the store checks neither names nor (for the secret) versions.
      const latest = await services.listConfigurations();
      props.onConfigurationsLoaded?.(latest);
      if (current.baseline) {
        const { name: storedName, id: storedId, __etag: etag } = current.baseline;
        const storedNow = latest.find((item) => item.id === storedId);
        if (!storedNow) {
          throw new PicklistError(
            'http',
            `${quoteName(storedName)} was deleted since you opened it. Reload to see the current configurations.`,
            404
          );
        }
        if (storedNow.__etag !== etag) {
          throw new PicklistError(
            'http',
            `Someone changed ${quoteName(storedName)} since you opened it. Reload to see their changes.`,
            409
          );
        }
      }
      const [conflict] = findNameConflicts(latest, {
        id: current.baseline?.id,
        name: doc.name,
        aliases: doc.aliases,
        processIds: doc.processIds,
      });
      if (conflict) {
        throw new PicklistError('config', nameConflictMessage(conflict, processName));
      }

      let summary = plan === 'keep' ? (current.baseline?.secret ?? null) : null;
      let wroteSecret = false;
      // What the secret was before, to put back if the configuration then can't be saved:
      // none for a new configuration; undefined when it couldn't be read. Memory only.
      let previousSecret: SecretDocument | null | undefined = null;
      if (plan === 'save' && secret) {
        const origin = secretDestination(current.draft);
        if (!origin) {
          throw new PicklistError(
            'config',
            'A secret can only be saved for an https:// address. Check where it’s sent.'
          );
        }
        // OAuth 2.0: its access tokens go to the API, so the secret is bound to that too.
        const apiOrigin = secretApiDestination(current.draft) ?? undefined;
        if (current.baseline?.secret) {
          previousSecret = await services.loadSecret(doc.id).catch(() => undefined);
        }
        const savedSecret = apiOrigin
          ? await services.saveSecret(doc.id, secret, origin, apiOrigin)
          : await services.saveSecret(doc.id, secret, origin);
        wroteSecret = true;
        summary = summarizeSecret(
          secret,
          savedSecret.boundOrigin,
          secretStamp(savedSecret, services),
          secret.kind === 'signingKey'
            ? (current.credentials.chosenKey?.parsed.certificate ?? undefined)
            : undefined,
          savedSecret.apiOrigin ?? apiOrigin
        );
      }

      let saved: ConfigurationDocument;
      try {
        saved = await services.saveConfiguration({ ...doc, secret: summary });
      } catch (error) {
        // The secret goes back to what it was, so forms keep using the stored configuration as it
        // is (a new one that wasn't created mustn't leave its secret behind either).
        if (wroteSecret && !(await restoreSecret(services, doc.id, previousSecret))) {
          const failure = error instanceof PicklistError ? error : null;
          throw new PicklistError(
            failure?.kind ?? 'http',
            `${messageOf(error, 'Couldn’t save the configuration.')} Its new secret was already saved, though: forms may not be able to sign in until you save it again.`,
            failure?.status
          );
        }
        throw error;
      }

      // The configuration no longer points at the old secret, so deleting it can't break it.
      let leftover: string | null = null;
      if (plan === 'remove' && current.baseline?.secret) {
        try {
          await services.deleteSecret(saved.id);
        } catch (error) {
          leftover = messageOf(error, 'Try removing it again in a moment.');
        }
      }

      const previousName =
        current.baseline && current.baseline.name !== saved.name ? current.baseline.name : null;
      reset(saved);
      setSavedSecretId(
        plan === 'save' && secret
          ? secretFingerprint(secret)
          : plan === 'keep'
            ? savedSecretId
            : null
      );
      setMessage(
        leftover
          ? {
              tone: 'warning',
              title: `Saved ${quoteName(saved.name)}, but its old secret couldn’t be deleted.`,
              detail: leftover,
              leftoverSecretId: saved.id,
            }
          : { tone: 'success', title: `Saved ${quoteName(saved.name)}.` }
      );
      props.onSaved(saved, previousName);
    } catch (error) {
      const status = error instanceof PicklistError ? error.status : undefined;
      setMessage({
        tone: 'error',
        title: messageOf(error, 'Couldn’t save the configuration. Try again in a moment.'),
        reload: status === 409 || status === 404,
      });
    } finally {
      setSaving(false);
    }
  };

  /** Deletes a secret the last save left behind (see Message.leftoverSecretId). */
  const removeLeftoverSecret = async (secretId: string, configurationName: string) => {
    if (removingSecret) {
      return;
    }
    setRemovingSecret(true);
    try {
      await services.deleteSecret(secretId);
      setMessage({
        tone: 'success',
        title: `Removed the old secret of ${quoteName(configurationName)}.`,
      });
    } catch (error) {
      setMessage({
        tone: 'warning',
        title: `The old secret of ${quoteName(configurationName)} still couldn’t be deleted.`,
        detail: messageOf(error, 'Try removing it again in a moment.'),
        leftoverSecretId: secretId,
      });
    } finally {
      setRemovingSecret(false);
    }
  };

  const reload = async () => {
    const current = baseline;
    if (!current) {
      return;
    }
    setReloading(true);
    try {
      const list = await services.listConfigurations();
      // The page's list (and the next Edit) gets the same newer copy, with its version.
      props.onConfigurationsLoaded?.(list);
      const latest = list.find((doc) => doc.id === current.id);
      if (latest) {
        reset(latest);
        setMessage({
          tone: 'success',
          title: `Loaded the latest version of ${quoteName(latest.name)}.`,
        });
      } else {
        setMessage({ tone: 'error', title: `${quoteName(current.name)} was deleted.`, gone: true });
      }
    } catch (error) {
      setMessage({
        tone: 'error',
        title: messageOf(error, 'Couldn’t load the configuration. Try again in a moment.'),
        reload: true,
      });
    } finally {
      setReloading(false);
    }
  };

  // ---- Credentials and the test ----

  const testCredential: TestCredential = (() => {
    if (kind === null) {
      return { source: 'none' };
    }
    if (entered) {
      return { source: 'entered', secret: entered };
    }
    const noun = SECRET_NOUNS[kind];
    if (plan === 'missing' && passwordOptional) {
      // Basic with a user name and no password: the user name alone, as forms send it.
      return { source: 'none' };
    }
    if (plan === 'keep' && baseline) {
      const configurationId = baseline.id;
      const origin = destination;
      const apiOrigin = secretApiDestination(draft);
      return {
        source: 'saved',
        // Read only when the test runs, kept for that run only, and never shown.
        load: async () => {
          const document = await services.loadSecret(configurationId);
          if (!document || document.secret.kind !== kind) {
            throw new PicklistError(
              'config',
              `The saved ${noun} couldn’t be read. Enter it again in Credentials to test.`
            );
          }
          if (
            document.boundOrigin !== origin ||
            (document.apiOrigin !== undefined && document.apiOrigin !== apiOrigin)
          ) {
            throw new PicklistError('config', SECRET_MOVED);
          }
          return document.secret;
        },
      };
    }
    return {
      source: 'missing',
      message:
        kind === 'signingKey'
          ? 'Choose the certificate or key in Credentials to test.'
          : `Enter the ${noun} in Credentials to test.`,
    };
  })();
  const credentialId = entered
    ? secretFingerprint(entered)
    : plan === 'keep'
      ? (savedSecretId ?? `saved:${stored?.updatedAt ?? ''}`)
      : '';

  const credentialsCard =
    kind !== null || stored !== null ? (
      <CredentialsCard
        kind={kind}
        stored={stored}
        secret={draft.password}
        onSecretChange={(password) =>
          edit((current) => ({ ...current, draft: { ...current.draft, password } }))
        }
        credentials={credentials}
        onCredentialsChange={(patch) =>
          edit((current) => ({ ...current, credentials: { ...current.credentials, ...patch } }))
        }
        onRemove={() => setConfirm({ kind: 'remove' })}
        issue={issues.secret ?? null}
        keyIdIssue={keyIdIssue}
        destination={destination}
        apiDestination={secretApiDestination(draft)}
        methodLabel={signInLabel(draft, stored)}
        headingId={credentialsHeadingId}
        saved={baseline !== null}
        optional={passwordOptional}
        now={props.now}
      />
    ) : null;

  // ---- Sharing ----

  const basis = baseline ?? { processIds: [props.processId] };
  const eligible = readOnly
    ? []
    : processes
        .filter(
          (process) =>
            canHoldControls(process) &&
            !processIds.includes(process.id) &&
            canShareWith(permissions, basis, process.id)
        )
        .toSorted((a, b) => a.name.localeCompare(b.name));
  const share = (processId: string) =>
    edit((current) => ({ ...current, processIds: [...current.processIds, processId] }));
  // It has to stay shared with a process that still exists: one that was deleted doesn't count,
  // or the configuration would vanish for everyone but collection administrators.
  // A deleted process can be dropped by anyone who may edit the configuration: nobody has Edit
  // process on it any more.
  const canRemoveChip = (processId: string) =>
    !readOnly &&
    (byId.has(processId)
      ? canEditProcess(permissions, processId)
      : canEditConfiguration(permissions, basis)) &&
    processIds.some((other) => {
      const process = other === processId ? undefined : byId.get(other);
      return process !== undefined && canHoldControls(process);
    });
  const unshare = (processId: string) => {
    if (baseline?.processIds.includes(processId)) {
      setConfirm({ kind: 'unshare', processId });
      return;
    }
    edit((current) => ({
      ...current,
      processIds: current.processIds.filter((item) => item !== processId),
    }));
    sharingRef.current?.focus();
  };

  // ---- Status ----

  const readOnlyReason =
    permissions.error ??
    `You can view this configuration. To change it, you need Edit process permission on ${listWithOr(
      (baseline?.processIds ?? [props.processId]).map(processName)
    )}.`;
  const lastChange = baseline?.updatedAt
    ? `Last changed${baseline.updatedBy ? ` by ${baseline.updatedBy}` : ''} on ${formatDay(baseline.updatedAt)}.`
    : '';
  const statusText = saving
    ? 'Saving…'
    : dirty
      ? `Unsaved changes${problemCount > 0 ? `: fix ${plural(problemCount, 'problem', 'problems')} to save.` : ''}`
      : message?.tone === 'success'
        ? message.title
        : lastChange;
  const displayName = trimmedName || baseline?.name || 'this configuration';

  const cancel = () => setConfirm(null);
  const confirmation = (() => {
    if (!confirm) {
      return null;
    }
    switch (confirm.kind) {
      case 'discard':
        return (
          <ConfirmDialog
            title={
              baseline
                ? `Discard changes to ${quoteName(baseline.name)}?`
                : 'Discard this new configuration?'
            }
            confirmLabel='Discard'
            busyLabel='Discarding…'
            cancelLabel='Keep editing'
            danger
            onCancel={cancel}
            onConfirm={() => {
              setConfirm(null);
              confirm.proceed();
            }}
          >
            <p>{baseline ? 'Your changes haven’t been saved.' : 'It hasn’t been saved.'}</p>
          </ConfirmDialog>
        );
      case 'switch': {
        const next = { ...draft, ...confirm.patch };
        const noun = stored ? storedNoun(stored) : 'secret';
        const off = secretKindOf(next) === null;
        const target = signInLabel(next, stored);
        return (
          <ConfirmDialog
            title={off ? 'Stop signing in?' : `Switch to ${target}?`}
            confirmLabel={off ? 'Stop signing in' : 'Switch'}
            busyLabel='Switching…'
            danger
            onCancel={cancel}
            onConfirm={() => {
              setConfirm(null);
              applyChange(confirm.patch);
            }}
          >
            <p>
              {off
                ? `The saved ${noun} is removed when you save, and the API is called without signing in.`
                : `The saved ${noun} can’t be used with ${target}, so it’s removed when you save.`}
            </p>
          </ConfirmDialog>
        );
      }
      case 'remove': {
        const noun = stored ? storedNoun(stored) : 'secret';
        return (
          <ConfirmDialog
            title={`Remove the saved ${noun}?`}
            confirmLabel='Remove'
            busyLabel='Removing…'
            danger
            returnFocus={() => document.getElementById(credentialsHeadingId)}
            onCancel={cancel}
            onConfirm={() => {
              setConfirm(null);
              edit((current) => ({
                ...current,
                draft: { ...current.draft, password: '' },
                credentials: { ...current.credentials, removing: true, replacing: false },
              }));
            }}
          >
            <p>
              Forms that use {quoteName(displayName)} can’t sign in until a new one is entered. It’s
              removed when you save.
            </p>
          </ConfirmDialog>
        );
      }
      case 'unshare': {
        const label = processName(confirm.processId);
        return (
          <ConfirmDialog
            title={`Stop sharing with ${label}?`}
            confirmLabel='Stop sharing'
            busyLabel='Stopping…'
            danger
            returnFocus={() => sharingRef.current}
            onCancel={cancel}
            onConfirm={() => {
              setConfirm(null);
              edit((current) => ({
                ...current,
                processIds: current.processIds.filter((item) => item !== confirm.processId),
              }));
            }}
          >
            <p>
              Controls in {label} that use {quoteName(displayName)} will show “Configuration not
              found” after you save, until they use another configuration.
            </p>
          </ConfirmDialog>
        );
      }
      case 'forget': {
        const { alias } = confirm;
        const users = usersOf(alias);
        return (
          <ConfirmDialog
            title={`Forget the former name ${quoteName(alias)}?`}
            confirmLabel='Forget'
            busyLabel='Forgetting…'
            danger
            onCancel={cancel}
            onConfirm={() => {
              setConfirm(null);
              edit((current) =>
                isForgotten(current.forgotten, alias)
                  ? current
                  : { ...current, forgotten: [...current.forgotten, alias] }
              );
            }}
          >
            <p>
              {usersSentence(users, displayName)}
              {users !== null && props.scansComplete === false
                ? ' Controls in processes that haven’t been read yet aren’t counted.'
                : ''}{' '}
              It’s forgotten when you save, and another configuration can then use the name.
            </p>
          </ConfirmDialog>
        );
      }
      default:
        return null;
    }
  })();

  return (
    <ReadOnlyContext value={readOnly}>
      <ShowRequiredContext value={showRequired}>
        <div ref={rootRef} className='cf-editor'>
          <p className='cf-editor__back'>
            {/* Not while saving: a save in flight can't be discarded any more. */}
            <button
              type='button'
              className='cf-link cf-back'
              aria-label='Back to Configurations'
              disabled={saving}
              onClick={() => leave(props.onClose)}
            >
              <ChevronLeftIcon />
              Configurations
            </button>
          </p>
          <h2 ref={headingRef} className='cf-editor__title' tabIndex={-1}>
            {baseline?.name ?? 'New configuration'}
          </h2>

          {readOnly ? (
            <Callout tone='info' title='View only' className='cf-editor__callout'>
              <p>{readOnlyReason}</p>
            </Callout>
          ) : null}
          {state.problems.length > 0 ? (
            <Callout
              tone='warning'
              title='Some settings couldn’t be read, so they were reset.'
              className='cf-editor__callout'
            >
              <p>{state.problems.join(' ')}</p>
            </Callout>
          ) : null}

          <div className='cf-editor__body' inert={saving || undefined}>
            <section className='cf-editor__identity' aria-label='Name and sharing'>
              <TextField
                label='Name'
                help='Controls find the configuration by this name.'
                value={name}
                issue={nameIssue ?? droppedIssue}
                required={REQUIRED_MESSAGES.name}
                onChange={(value) => edit((current) => ({ ...current, name: value }))}
              />
              {baseline && baseline.aliases.length > 0 ? (
                readOnly ? (
                  <p className='cf-meta'>
                    Also answers to {baseline.aliases.map((alias) => quoteName(alias)).join(', ')}.
                  </p>
                ) : (
                  <div className='cf-aliases'>
                    <p id={`${id}-aliases`} className='cf-meta'>
                      Also answers to its former names, so controls that still use them keep
                      working:
                    </p>
                    <ul className='cf-aliases__list' aria-labelledby={`${id}-aliases`}>
                      {baseline.aliases.map((alias) => (
                        <li key={alias} className='cf-aliases__item'>
                          <span>{quoteName(alias)}</span>
                          {isForgotten(state.forgotten, alias) ? (
                            <>
                              <span className='cf-meta'>Forgotten when you save.</span>
                              <button
                                type='button'
                                className='cf-link'
                                aria-label={`Keep the former name ${alias}`}
                                onClick={() =>
                                  edit((current) => ({
                                    ...current,
                                    forgotten: current.forgotten.filter(
                                      (other) => nameKey(other) !== nameKey(alias)
                                    ),
                                  }))
                                }
                              >
                                Undo
                              </button>
                            </>
                          ) : (
                            <button
                              type='button'
                              className='cf-link'
                              aria-label={`Forget the former name ${alias}`}
                              aria-haspopup='dialog'
                              onClick={() => setConfirm({ kind: 'forget', alias })}
                            >
                              Forget
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              ) : null}
              <div className='cf-setting cf-sharing'>
                <p id={`${id}-shared`} className='cf-label'>
                  Shared with
                </p>
                <div className='cf-sharing__row'>
                  <ul
                    ref={sharingRef}
                    className='cf-process-chips'
                    aria-labelledby={`${id}-shared`}
                    aria-describedby={sharingIssue ? `${id}-sharing-issue` : undefined}
                    data-problem={sharingIssue ? true : undefined}
                    tabIndex={-1}
                  >
                    {processIds.map((processId) => {
                      const label = processName(processId);
                      return (
                        <li key={processId} className='cf-process-chip'>
                          <span>{label}</span>
                          {canRemoveChip(processId) ? (
                            <button
                              type='button'
                              className='cf-process-chip__remove'
                              aria-label={`Stop sharing with ${label}`}
                              onClick={() => unshare(processId)}
                            >
                              <DismissIcon />
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {eligible.length > 0 ? <AddProcess processes={eligible} onAdd={share} /> : null}
                </div>
                {sharingIssue ? (
                  <IssueMessage id={`${id}-sharing-issue`} issue={sharingIssue} />
                ) : null}
                <p className='cf-help cf-help--after'>
                  Project Collection Administrators and editors of these processes can change it.
                </p>
              </div>
            </section>

            <BuildTab
              draft={draft}
              issues={issues}
              policy={policy}
              readOnly={readOnly}
              fetchImpl={services.fetchImpl}
              onChange={requestChange}
              onUseSample={
                baseline ? undefined : () => applyChange({ ...SAMPLE_DRAFT, password: '' })
              }
              credentials={credentialsCard}
              after={
                <UseOnFormCard
                  name={name}
                  unsaved={!baseline || baseline.name !== trimmedName}
                  onShowControls={
                    props.onShowControls ? () => leave(() => props.onShowControls?.()) : undefined
                  }
                />
              }
              testCredential={testCredential}
              credentialId={credentialId}
              onValidityChange={onValidityChange}
              invalid={invalid}
              reveal={reveal}
            />
          </div>

          <div ref={footerRef} className='cf-editor__footer'>
            {message?.tone === 'error' || message?.tone === 'warning' ? (
              <Callout
                tone={message.tone}
                role='alert'
                title={message.title}
                className='cf-editor__message'
              >
                {message.detail ? <p>{message.detail}</p> : null}
                {message.leftoverSecretId ? (
                  <p className='cf-editor__message-actions'>
                    <button
                      type='button'
                      className='cf-button cf-button--small cf-button--busy'
                      aria-disabled={removingSecret || undefined}
                      onClick={() => {
                        const leftover = message.leftoverSecretId;
                        if (leftover) {
                          void removeLeftoverSecret(leftover, baseline?.name ?? name);
                        }
                      }}
                    >
                      {removingSecret ? <Spinner /> : null}
                      {removingSecret ? 'Removing…' : 'Remove the old secret'}
                    </button>
                  </p>
                ) : null}
                {message.reload || message.gone ? (
                  <p className='cf-editor__message-actions'>
                    {message.reload ? (
                      <button
                        type='button'
                        className='cf-button cf-button--small'
                        disabled={reloading}
                        onClick={() => void reload()}
                      >
                        {reloading ? <Spinner /> : null}
                        {reloading ? 'Reloading…' : 'Reload'}
                      </button>
                    ) : null}
                    {message.gone ? (
                      <button
                        type='button'
                        className='cf-button cf-button--small'
                        onClick={props.onClose}
                      >
                        Back to configurations
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </Callout>
            ) : null}
            <div className='cf-editor__bar'>
              <p className='cf-editor__status' aria-live='polite'>
                {dirty && !saving ? (
                  <span className='cf-unsaved'>
                    <span className='cf-unsaved__dot' aria-hidden='true' />
                    {statusText}
                  </span>
                ) : (
                  statusText
                )}
              </p>
              <div className='cf-editor__actions'>
                {readOnly ? (
                  <button type='button' className='cf-button' onClick={props.onClose}>
                    Close
                  </button>
                ) : (
                  <>
                    <button
                      type='button'
                      className='cf-button'
                      disabled={saving}
                      onClick={() => leave(props.onClose)}
                    >
                      Cancel
                    </button>
                    <button
                      type='button'
                      className='cf-button cf-button--primary'
                      disabled={!dirty || saving}
                      aria-disabled={problemCount > 0 ? true : undefined}
                      onClick={() => void save()}
                    >
                      {saving ? <Spinner /> : null}
                      {saving ? 'Saving…' : 'Save configuration'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
          {confirmation}
        </div>
      </ShowRequiredContext>
    </ReadOnlyContext>
  );
}
