import { useContext, useId } from 'react';
import type { AuthMethod } from '../core/config';
import { AUTH_METHOD_LABELS, DEFAULT_API_KEY_HEADER } from '../core/config';
import type { SecurityPolicy } from '../core/policy';
import { checkAuthMethod } from '../core/policy';
import { OAuthFields, OAuthNotice } from './OAuthFields';
import type { Draft, Issues } from './settings';
import { LABELS, REQUIRED_MESSAGES, SIGN_IN_METHODS, listWithOr } from './settings';
import type { Choice } from './ui';
import { IssueMessage, ReadOnlyContext, SegmentedControl, TextField } from './ui';

/** Why some sign-in methods can't be chosen, or null when the policy allows them all. */
function blockedNote(policy: SecurityPolicy): string | null {
  const allowed = (method: AuthMethod) => !checkAuthMethod(method, policy);
  const blocked = SIGN_IN_METHODS.filter((method) => method !== 'none' && !allowed(method)).map(
    (method) => AUTH_METHOD_LABELS[method]
  );
  const parts: string[] = [];
  if (blocked.length > 0) {
    parts.push(`Your organization’s security policy doesn’t allow ${listWithOr(blocked)}.`);
  }
  if (!allowed('none')) {
    parts.push(
      blocked.length > 0
        ? 'It also requires signing in.'
        : 'Your organization’s security policy requires signing in.'
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Where the list comes from and how to sign in to it. Always open. */
export function ConnectCard(props: {
  draft: Draft;
  issues: Issues;
  policy: SecurityPolicy;
  onChange: (patch: Partial<Draft>) => void;
  /** Fills in a sample API; offered while the URL is empty. */
  onUseSample?: () => void;
  onValidityChange: (key: string, valid: boolean) => void;
  /** Keys that reported a problem through onValidityChange. */
  invalid: ReadonlySet<string>;
  /** Changes when Save is pressed with problems. */
  reveal: number;
}) {
  const { draft, issues, policy, onChange } = props;
  const id = useId();
  const readOnly = useContext(ReadOnlyContext);
  const note = readOnly ? null : blockedNote(policy);
  const noticeId = `${id}-oauth-notice`;
  const oauthChosen = draft.authMethod === 'oauth2';
  const choices: Choice<AuthMethod>[] = SIGN_IN_METHODS.map((method) => ({
    value: method,
    label: AUTH_METHOD_LABELS[method],
    // The method in use stays selectable, so it can be seen and changed.
    disabled: Boolean(checkAuthMethod(method, policy)) && draft.authMethod !== method,
    // The red notice describes the OAuth 2.0 choice, so it's heard with it, not skipped by Tab.
    describedBy: method === 'oauth2' && oauthChosen ? noticeId : undefined,
  }));

  return (
    <section className='cf-card' aria-labelledby={`${id}-title`}>
      <div className='cf-card__header'>
        <div>
          <h3 id={`${id}-title`} className='cf-card__title'>
            <span className='cf-step' aria-hidden='true'>
              1
            </span>
            Connect
          </h3>
          <p className='cf-card__description'>Where the list comes from and how to sign in.</p>
        </div>
        {props.onUseSample && !draft.url.trim() && !readOnly ? (
          <button type='button' className='cf-link' onClick={props.onUseSample}>
            Try a sample API
          </button>
        ) : null}
      </div>

      <TextField
        label={LABELS.url}
        help={
          <>
            HTTPS only. Insert work item values with{' '}
            <code className='cf-code'>$(Field.ReferenceName)</code>. Example:{' '}
            <code className='cf-code'>https://api.contoso.com/customers</code>
          </>
        }
        value={draft.url}
        issue={issues.url}
        required={REQUIRED_MESSAGES.url}
        code
        inputMode='url'
        placeholder='https://'
        onChange={(url) => onChange({ url })}
      />
      <TextField
        label={LABELS.params}
        help={
          <>
            Added to the query string. The list reloads when a $(field) changes. Example:{' '}
            <code className='cf-code'>
              {'{ "status": "active", "region": "$(Custom.Region)" }'}
            </code>
          </>
        }
        value={draft.params}
        issue={issues.params}
        code
        multiline
        onChange={(params) => onChange({ params })}
      />

      <div className='cf-setting cf-signin-method'>
        <SegmentedControl
          label={LABELS.authMethod}
          className='cf-segmented--adaptive'
          choices={choices}
          value={draft.authMethod}
          problem={issues.authMethod?.tone === 'error'}
          describedBy={
            [note ? `${id}-blocked` : '', issues.authMethod ? `${id}-auth-issue` : '']
              .filter(Boolean)
              .join(' ') || undefined
          }
          onChange={(authMethod) => onChange({ authMethod })}
        />
        {note ? (
          <p id={`${id}-blocked`} className='cf-help cf-help--after'>
            {note}
          </p>
        ) : null}
        {issues.authMethod ? (
          <IssueMessage id={`${id}-auth-issue`} issue={issues.authMethod} />
        ) : null}
      </div>

      {oauthChosen ? (
        <>
          <OAuthNotice id={noticeId} />
          <OAuthFields
            draft={draft}
            issues={issues}
            onChange={onChange}
            onValidityChange={props.onValidityChange}
            invalid={props.invalid}
            reveal={props.reveal}
          />
        </>
      ) : null}
      {draft.authMethod === 'basic' ? (
        <TextField
          label={LABELS.username}
          help='The password goes in Credentials.'
          value={draft.username}
          issue={issues.username}
          onChange={(username) => onChange({ username })}
        />
      ) : null}
      {draft.authMethod === 'apiKey' ? (
        <TextField
          label='Header name'
          help='The request header that carries the key. The key itself goes in Credentials.'
          value={draft.advanced.apiKeyHeader}
          placeholder={DEFAULT_API_KEY_HEADER}
          issue={issues.apiKeyHeader}
          code
          onChange={(apiKeyHeader) => onChange({ advanced: { ...draft.advanced, apiKeyHeader } })}
        />
      ) : null}
    </section>
  );
}
