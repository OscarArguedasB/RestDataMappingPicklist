import type { ReactNode, RefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { Spinner } from '../components/Spinner';
import type { AuthMethod } from '../core/config';
import { AUTH_METHOD_LABELS, AUTH_METHODS, LIMITS } from '../core/config';
import type { PermissionSnapshot } from '../core/configurations';
import { canEditPolicy, permissionsUnverified } from '../core/configurations';
import { toUserMessage } from '../core/errors';
import type { SecurityPolicy } from '../core/policy';
import { LockIcon } from './icons';
import type { PolicyForm } from './policyForm';
import {
  formToPolicy,
  hasPolicyIssues,
  policyToForm,
  samePolicy,
  validatePolicyForm,
} from './policyForm';
import { formatDay } from './settings';
import { Callout, CheckboxField, Field, IssueMessage, NumberField } from './ui';

const METHOD_HELP: Record<AuthMethod, string> = {
  none: 'Public APIs that need no sign-in.',
  basic: 'User name and password.',
  bearer: 'A token in the Authorization header.',
  apiKey: 'A key in its own header, like x-api-key.',
  oauth2:
    'An access token from a token URL (client credentials), got with a client secret or a certificate.',
};

const POLICY_DESCRIPTION =
  'Rules for every REST Picklist control in this organization. They can only tighten the protections built into the control, never loosen them.';

function formatChanged(policy: SecurityPolicy): string | null {
  // Written like every other date on the page, such as “14 Sep 2026”.
  const when = formatDay(policy.changedAt);
  if (!when) {
    return null;
  }
  return policy.changedBy
    ? `Last changed by ${policy.changedBy} on ${when}.`
    : `Last changed on ${when}.`;
}

/**
 * Keeps what's focused clear of the pinned Save bar: the page's bottom scroll padding follows the
 * bar's height (nothing while the tab is hidden and the bar has no size), so fields reached with
 * Tab scroll into view above the bar, never under it (WCAG 2.4.11).
 */
function useScrollPaddingFor(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const bar = ref.current;
    if (!bar || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const height = bar.offsetHeight;
      // A little extra room, so a focus outline isn't flush against the bar.
      root.style.setProperty('--cf-actionbar-space', `${height ? height + 8 : 0}px`);
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--cf-actionbar-space');
    };
  }, [ref]);
}

function PolicyEditor(props: {
  saved: SecurityPolicy;
  demo: boolean;
  onSave: (policy: SecurityPolicy) => Promise<SecurityPolicy>;
}) {
  const { saved, onSave } = props;
  const id = useId();
  const [form, setForm] = useState<PolicyForm>(() => policyToForm(saved));
  const [invalidNumbers, setInvalidNumbers] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useScrollPaddingFor(barRef);

  const issues = validatePolicyForm(form);
  const next = formToPolicy(form, saved);
  const dirty = !samePolicy(next, saved);
  const blocked = hasPolicyIssues(issues) || invalidNumbers.size > 0;

  const update = (patch: Partial<PolicyForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setMessage(null);
  };
  const trackNumber = (key: string) => (valid: boolean) =>
    setInvalidNumbers((current) => {
      if (valid !== current.has(key)) {
        return current;
      }
      const copy = new Set(current);
      if (valid) {
        copy.delete(key);
      } else {
        copy.add(key);
      }
      return copy;
    });

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const stored = await onSave(next);
      setForm(policyToForm(stored));
      setMessage({
        tone: 'success',
        text: 'Policy saved. Controls pick it up within five minutes.',
      });
    } catch (error) {
      setMessage({ tone: 'error', text: toUserMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const toggleMethod = (method: AuthMethod, on: boolean) =>
    update({
      allowedAuthMethods: on
        ? [...form.allowedAuthMethods, method]
        : form.allowedAuthMethods.filter((item) => item !== method),
    });

  const changed = formatChanged(saved);

  return (
    <form
      className='cf-policy'
      aria-labelledby={`${id}-title`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !blocked && !saving) {
          void save();
        }
      }}
    >
      <section className='cf-card'>
        <div className='cf-card__header'>
          <div>
            <h2 id={`${id}-title`} className='cf-card__title'>
              Security policy
            </h2>
            <p className='cf-card__description'>{POLICY_DESCRIPTION}</p>
          </div>
        </div>
        <Callout tone='info' title='A guard rail for process editors, not a lock.'>
          <p>
            The policy is stored in this extension’s data, which Azure DevOps lets any member of the
            organization change through its REST API. It keeps process editors to the endpoints and
            sign-in methods you allow; the built-in protections (HTTPS, no credentials sent to other
            sites, time and size limits) always apply.
          </p>
        </Callout>
        {props.demo ? (
          <p className='cf-hint cf-hint--spaced'>
            Local demo: saving keeps the policy in this page only.
          </p>
        ) : null}
      </section>

      <section className='cf-card' aria-labelledby={`${id}-endpoints`}>
        <h3 id={`${id}-endpoints`} className='cf-card__title cf-card__title--section'>
          Endpoints
        </h3>
        <div className='cf-always-on'>
          <LockIcon />
          <div>
            <p className='cf-label'>
              HTTPS required <span className='cf-badge'>Always on</span>
            </p>
            <p className='cf-help'>
              Endpoints must use https://. This is built in and can’t be turned off.
            </p>
          </div>
        </div>
        <CheckboxField
          label='Allow http://localhost for testing'
          help='Lets controls call http://localhost, http://127.0.0.1 and http://[::1], for people testing an API on their own computer. Leave it off otherwise.'
          checked={form.allowLocalhost}
          onChange={(allowLocalhost) => update({ allowLocalhost })}
        />
        <CheckboxField
          label={
            <>
              Block private network addresses{' '}
              <span className='cf-badge cf-badge--accent'>Recommended</span>
            </>
          }
          help='Blocks names and addresses that only exist inside a network, like *.local, *.internal, 10.x.x.x and 192.168.x.x. Off by default so existing intranet setups keep working.'
          checked={form.blockPrivateNetworks}
          onChange={(blockPrivateNetworks) => update({ blockPrivateNetworks })}
        />
        <Field
          label='Allowed hosts'
          help={
            <>
              One per line. <code className='cf-code'>*.contoso.com</code> allows every subdomain of
              contoso.com. Leave empty to allow any HTTPS host.
            </>
          }
          issue={
            issues.hosts.length > 0
              ? { tone: 'error', message: issues.hosts.slice(0, 5).join(' ') }
              : null
          }
        >
          {({ id: hostsId, describedBy, invalid }) => (
            <textarea
              id={hostsId}
              className='cf-input cf-input--code'
              rows={Math.min(10, Math.max(4, form.allowedHosts.split('\n').length + 1))}
              value={form.allowedHosts}
              placeholder={'api.contoso.com\n*.service-now.com'}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              spellCheck={false}
              autoComplete='off'
              onChange={(event) => update({ allowedHosts: event.target.value })}
            />
          )}
        </Field>
        <p className='cf-note'>
          When allowed hosts or private network blocking are on, requests don’t follow redirects,
          because the browser would contact a redirect’s target before it can be checked: endpoints
          must use their final address. A public host name that resolves to a private address can’t
          be detected in the browser.
        </p>
      </section>

      <section className='cf-card' aria-labelledby={`${id}-methods`}>
        <h3 id={`${id}-methods`} className='cf-card__title cf-card__title--section'>
          Sign-in methods
        </h3>
        <p className='cf-card__description cf-card__description--spaced'>
          Controls can only use the methods allowed here.
        </p>
        {AUTH_METHODS.map((method) => (
          <CheckboxField
            key={method}
            label={AUTH_METHOD_LABELS[method]}
            help={METHOD_HELP[method]}
            checked={form.allowedAuthMethods.includes(method)}
            onChange={(on) => toggleMethod(method, on)}
          />
        ))}
        {issues.methods ? (
          <IssueMessage
            id={`${id}-methods-issue`}
            issue={{ tone: 'error', message: issues.methods }}
          />
        ) : null}
      </section>

      <section className='cf-card' aria-labelledby={`${id}-limits`}>
        <h3 id={`${id}-limits`} className='cf-card__title cf-card__title--section'>
          Limits
        </h3>
        <p className='cf-card__description cf-card__description--spaced'>
          The most any control may load. Controls with lower settings keep them.
        </p>
        <div className='cf-grid-3'>
          <NumberField
            label='Maximum pages'
            value={form.maxPages}
            min={LIMITS.maxPages.min}
            max={LIMITS.maxPages.max}
            onChange={(maxPages) => update({ maxPages })}
            onValidityChange={trackNumber('maxPages')}
          />
          <NumberField
            label='Maximum items'
            value={form.maxItems}
            min={LIMITS.maxItems.min}
            max={LIMITS.maxItems.max}
            onChange={(maxItems) => update({ maxItems })}
            onValidityChange={trackNumber('maxItems')}
          />
          <NumberField
            label='Timeout'
            unit='seconds'
            value={form.timeoutSeconds}
            min={LIMITS.timeoutSeconds.min}
            max={LIMITS.timeoutSeconds.max}
            onChange={(timeoutSeconds) => update({ timeoutSeconds })}
            onValidityChange={trackNumber('timeoutSeconds')}
          />
        </div>
      </section>

      {/* Laid out like the editor's footer: the state first, the actions last, Save trailing. */}
      <div ref={barRef} className='cf-actionbar'>
        <p id={`${id}-state`} className='cf-actionbar__state' aria-live='polite'>
          {dirty ? (
            <span className='cf-unsaved'>
              <span className='cf-unsaved__dot' aria-hidden='true' />
              Unsaved changes{blocked ? ': fix the problems above to save.' : ''}
            </span>
          ) : message?.tone === 'success' ? (
            message.text
          ) : (
            (changed ?? 'Using the built-in defaults: no policy has been saved yet.')
          )}
        </p>
        <div className='cf-editor__actions'>
          {dirty && !saving ? (
            <button
              type='button'
              className='cf-button'
              onClick={() => {
                setForm(policyToForm(saved));
                setMessage(null);
              }}
            >
              Discard changes
            </button>
          ) : null}
          <button
            type='submit'
            className='cf-button cf-button--primary'
            disabled={!dirty || blocked || saving}
            aria-describedby={`${id}-state`}
          >
            {saving ? <Spinner /> : null}
            {saving ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </div>
      {message?.tone === 'error' ? (
        <Callout tone='error' role='alert' title={message.text} className='cf-actionbar__error' />
      ) : null}
    </form>
  );
}

const numberFormat = new Intl.NumberFormat('en-US');

function Fact(props: { term: string; children: ReactNode }) {
  return (
    <div className='cf-policy-facts__row'>
      <dt>{props.term}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/**
 * The policy for people who can't change it: the same sections with every value written out,
 * rather than disabled controls (which read as broken and are hard to read).
 */
function PolicySummary({ policy, unverified }: { policy: SecurityPolicy; unverified: boolean }) {
  const id = useId();
  const changed = formatChanged(policy);
  return (
    <div className='cf-policy'>
      <section className='cf-card' aria-labelledby={`${id}-title`}>
        <div className='cf-card__header'>
          <div>
            <h2 id={`${id}-title`} className='cf-card__title'>
              Security policy
            </h2>
            <p className='cf-card__description'>{POLICY_DESCRIPTION}</p>
          </div>
        </div>
        <Callout tone='info' title='Only Project Collection Administrators can change the policy.'>
          {unverified ? (
            <p>
              Your permissions couldn’t be verified, so the policy stays read-only until the check
              works.
            </p>
          ) : null}
        </Callout>
        <p className='cf-hint cf-hint--spaced'>
          {changed ?? 'The built-in rules apply: no policy has been saved yet.'}
        </p>
      </section>

      <section className='cf-card' aria-labelledby={`${id}-endpoints`}>
        <h3 id={`${id}-endpoints`} className='cf-card__title cf-card__title--section'>
          Endpoints
        </h3>
        <dl className='cf-policy-facts'>
          <Fact term='HTTPS'>Required. This is built in and can’t be turned off.</Fact>
          <Fact term='http://localhost for testing'>
            {policy.allowLocalhost ? 'Allowed' : 'Not allowed'}
          </Fact>
          <Fact term='Private network addresses'>
            {policy.blockPrivateNetworks ? 'Blocked' : 'Allowed'}
          </Fact>
          <Fact term='Allowed hosts'>
            {policy.allowedHosts.length > 0 ? (
              <ul className='cf-policy-facts__list'>
                {policy.allowedHosts.map((host) => (
                  <li key={host}>
                    <code className='cf-code'>{host}</code>
                  </li>
                ))}
              </ul>
            ) : (
              'Any HTTPS host'
            )}
          </Fact>
        </dl>
      </section>

      <section className='cf-card' aria-labelledby={`${id}-methods`}>
        <h3 id={`${id}-methods`} className='cf-card__title cf-card__title--section'>
          Sign-in methods
        </h3>
        <dl className='cf-policy-facts'>
          {AUTH_METHODS.map((method) => (
            <Fact key={method} term={AUTH_METHOD_LABELS[method]}>
              {policy.allowedAuthMethods.includes(method) ? 'Allowed' : 'Not allowed'}
            </Fact>
          ))}
        </dl>
      </section>

      <section className='cf-card' aria-labelledby={`${id}-limits`}>
        <h3 id={`${id}-limits`} className='cf-card__title cf-card__title--section'>
          Limits
        </h3>
        <dl className='cf-policy-facts'>
          <Fact term='Maximum pages'>{numberFormat.format(policy.maxPages)}</Fact>
          <Fact term='Maximum items'>{numberFormat.format(policy.maxItems)}</Fact>
          <Fact term='Timeout'>{numberFormat.format(policy.timeoutSeconds)} seconds</Fact>
        </dl>
      </section>
    </div>
  );
}

/** The “Security policy” tab: editable by Project Collection Administrators, read by everyone. */
export function PolicyTab(props: {
  policy: SecurityPolicy | null;
  /** Reading the saved policy failed; editing would risk replacing it with the defaults. */
  error?: string | null;
  onRetry?: () => void;
  /** Null while the permission check runs. */
  permissions: PermissionSnapshot | null;
  demo: boolean;
  onSave: (policy: SecurityPolicy) => Promise<SecurityPolicy>;
}) {
  if (props.error) {
    return (
      <Callout tone='error' role='alert' title='The security policy couldn’t be loaded'>
        <p>{props.error}</p>
        {props.onRetry ? (
          <button type='button' className='cf-button' onClick={props.onRetry}>
            Try again
          </button>
        ) : null}
      </Callout>
    );
  }
  if (!props.policy || !props.permissions) {
    return (
      <output className='cf-loading'>
        <Spinner /> Loading the security policy…
      </output>
    );
  }
  return canEditPolicy(props.permissions) ? (
    <PolicyEditor saved={props.policy} demo={props.demo} onSave={props.onSave} />
  ) : (
    <PolicySummary policy={props.policy} unverified={permissionsUnverified(props.permissions)} />
  );
}
