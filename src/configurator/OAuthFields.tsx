import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { ClientAuthentication } from '../core/config';
import {
  CLIENT_AUTHENTICATION_LABELS,
  OAUTH_LIMITS,
  validateTokenParameterName,
} from '../core/config';
import { Collapsible } from './Collapsible';
import { WarningIcon } from './icons';
import type { Draft, Issues, OAuthCredential } from './settings';
import { GRANT_TYPE_LABEL, REQUIRED_MESSAGES, summarizeOAuthAdvanced } from './settings';
import type { Choice } from './ui';
import { IssueMessage, RadioGroupField, ReadOnlyContext, TextField } from './ui';

/**
 * The notice under the sign-in method while OAuth 2.0 is chosen, in two paragraphs: what it is,
 * then the limitation. Its words are a product decision; keep them as they are.
 */
export const OAUTH_NOTICE = [
  'OAuth 2.0 uses the app registration’s application permissions (client credentials) to get the token.',
  'It doesn’t use delegated permissions or a sign-in page, and nothing extra needs to be deployed.',
  'The token is requested from this browser, so the token URL must accept requests from Azure DevOps (CORS).',
  'Microsoft Entra ID refuses client credentials sent from a browser, so Entra app registrations won’t work.',
] as const;

/**
 * Always shown with OAuth 2.0, never behind a toggle: red text on the card itself (never on the
 * red wash, which is too faint in the dark theme), a warning icon and a bold first sentence, so
 * it doesn't rely on color and still reads in forced-colors mode. Its `id` lets the OAuth 2.0
 * choice point at it, so screen readers hear it with the choice rather than skipping it.
 */
export function OAuthNotice({ id }: { id?: string }) {
  return (
    <div id={id} role='note' className='cf-oauth-notice'>
      <WarningIcon />
      <div className='cf-oauth-notice__text'>
        <p>
          <strong className='cf-oauth-notice__lead'>{OAUTH_NOTICE[0]}</strong> {OAUTH_NOTICE[1]}
        </p>
        <p>
          {OAUTH_NOTICE[2]} {OAUTH_NOTICE[3]}
        </p>
      </div>
    </div>
  );
}

const CREDENTIAL_CHOICES: readonly Choice<OAuthCredential>[] = [
  { value: 'secret', label: 'Client secret' },
  {
    value: 'certificate',
    label: 'Certificate',
    help: 'A certificate and its private key, or a key on its own. It signs each token request, so no secret is sent.',
  },
];

type SecretAuthentication = Exclude<ClientAuthentication, 'privateKeyJwt'>;

const CLIENT_AUTHENTICATION_CHOICES: readonly Choice<SecretAuthentication>[] = [
  { value: 'basic', label: CLIENT_AUTHENTICATION_LABELS.basic },
  { value: 'body', label: CLIENT_AUTHENTICATION_LABELS.body },
];

/** The key under which the extra parameter rows report whether they're valid. */
export const TOKEN_PARAMETERS_KEY = 'tokenParameters';

interface ParameterRow {
  key: number;
  name: string;
  value: string;
}

// Row keys only need to be unique on the page.
let lastRowKey = 0;

function rowsFrom(parameters: Record<string, string>): ParameterRow[] {
  return Object.entries(parameters).map(([name, value]) => ({ key: ++lastRowKey, name, value }));
}

function sameParameters(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => Object.hasOwn(b, name) && a[name] === b[name])
  );
}

/** The parameters the rows add up to, and what's wrong with the rows that can't be sent. */
function readRows(rows: readonly ParameterRow[]): {
  parameters: Record<string, string>;
  problems: Map<number, string>;
} {
  const usable: Array<[string, string]> = [];
  const problems = new Map<number, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    // A row that was added but not filled in yet isn't a problem; it's just not sent.
    if (!name && !row.value) {
      continue;
    }
    const problem =
      validateTokenParameterName(name) ??
      (seen.has(name) ? `“${name}” is listed twice in the extra token parameters.` : null);
    if (problem) {
      problems.set(row.key, problem);
    } else {
      seen.add(name);
      usable.push([name, row.value]);
    }
  }
  // fromEntries defines own properties, so no name can reach the object's prototype.
  return { parameters: Object.fromEntries(usable), problems };
}

/**
 * Name and value rows for extra token parameters. Rows are edited here and only the ones that
 * can be sent reach the draft, like NumberField does with numbers; the rest say what's wrong and
 * report it through `onValidityChange`.
 */
function TokenParameters(props: {
  parameters: Record<string, string>;
  onChange: (parameters: Record<string, string>) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const { parameters } = props;
  const id = useId();
  const readOnly = useContext(ReadOnlyContext);
  const [rows, setRows] = useState<ParameterRow[]>(() => rowsFrom(parameters));
  const [shown, setShown] = useState(parameters);
  // Follow changes made elsewhere (reload, discard) without losing rows that are being typed.
  if (parameters !== shown) {
    setShown(parameters);
    if (!sameParameters(readRows(rows).parameters, parameters)) {
      setRows(rowsFrom(parameters));
    }
  }
  const { problems } = readRows(rows);
  const valid = problems.size === 0;
  const validityRef = useRef(props.onValidityChange);
  useEffect(() => {
    validityRef.current = props.onValidityChange;
  });
  useEffect(() => {
    validityRef.current(valid);
  }, [valid]);
  useEffect(() => () => validityRef.current(true), []);

  const update = (next: ParameterRow[]) => {
    setRows(next);
    const read = readRows(next).parameters;
    if (!sameParameters(read, parameters)) {
      props.onChange(read);
    }
  };

  return (
    <fieldset className='cf-setting cf-params' aria-describedby={`${id}-help`}>
      <legend className='cf-label cf-legend'>Extra token parameters</legend>
      <p id={`${id}-help`} className='cf-help'>
        Sent with the token request, for token services that need more, like a tenant. They’re saved
        as plain settings, so don’t put secrets here.
      </p>
      {rows.length > 0 ? (
        <div className='cf-params__rows'>
          <div className='cf-params__header' aria-hidden='true'>
            <span>Name</span>
            <span>Value</span>
          </div>
          {rows.map((row, index) => {
            const problem = problems.get(row.key);
            const issueId = `${id}-${row.key}-issue`;
            return (
              <div key={row.key} className='cf-params__row'>
                <input
                  className='cf-input cf-input--code'
                  aria-label={`Name of parameter ${index + 1}`}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? issueId : undefined}
                  value={row.name}
                  readOnly={readOnly}
                  spellCheck={false}
                  autoComplete='off'
                  onChange={(event) =>
                    update(
                      rows.map((item) =>
                        item.key === row.key ? { ...item, name: event.target.value } : item
                      )
                    )
                  }
                />
                <input
                  className='cf-input cf-input--code'
                  aria-label={`Value of parameter ${index + 1}`}
                  value={row.value}
                  readOnly={readOnly}
                  spellCheck={false}
                  autoComplete='off'
                  onChange={(event) =>
                    update(
                      rows.map((item) =>
                        item.key === row.key ? { ...item, value: event.target.value } : item
                      )
                    )
                  }
                />
                {readOnly ? null : (
                  <button
                    type='button'
                    className='cf-button cf-button--quiet cf-button--small'
                    aria-label={`Remove parameter ${index + 1}`}
                    onClick={() => update(rows.filter((item) => item.key !== row.key))}
                  >
                    Remove
                  </button>
                )}
                {problem ? (
                  <IssueMessage id={issueId} issue={{ tone: 'error', message: problem }} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : readOnly ? (
        <p className='cf-hint'>None.</p>
      ) : null}
      {readOnly ? null : (
        <button
          type='button'
          className='cf-button cf-button--small cf-params__add'
          aria-describedby={`${id}-help`}
          disabled={rows.length >= OAUTH_LIMITS.maxExtraParams}
          onClick={() => update([...rows, { key: ++lastRowKey, name: '', value: '' }])}
        >
          Add parameter
        </button>
      )}
    </fieldset>
  );
}

/**
 * OAuth 2.0 client credentials, in the order Postman's “Configure New Token” uses. The secret
 * itself, or the certificate, goes in the Credentials card.
 */
export function OAuthFields(props: {
  draft: Draft;
  issues: Issues;
  onChange: (patch: Partial<Draft>) => void;
  onValidityChange: (key: string, valid: boolean) => void;
  /** Keys that reported a problem through onValidityChange. */
  invalid: ReadonlySet<string>;
  /** Changes when Save is pressed with problems, to open Advanced when one is inside. */
  reveal: number;
}) {
  const { draft, issues, onChange, invalid } = props;
  const id = useId();
  const { oauth } = draft;
  const setOAuth = (patch: Partial<Draft['oauth']>) => onChange({ oauth: { ...oauth, ...patch } });
  const certificate = draft.credential === 'certificate';

  return (
    <div className='cf-oauth'>
      <dl className='cf-setting cf-facts'>
        <div className='cf-facts__row'>
          <dt className='cf-label'>Grant type</dt>
          <dd>{GRANT_TYPE_LABEL}</dd>
        </div>
      </dl>
      <TextField
        label='Access token URL'
        help='The client signs in here, and the token it gets is sent to the API.'
        value={oauth.tokenUrl}
        issue={issues.tokenUrl ?? issues.entra}
        required={REQUIRED_MESSAGES.tokenUrl}
        code
        inputMode='url'
        placeholder='https://auth.example.com/oauth2/token'
        onChange={(tokenUrl) => setOAuth({ tokenUrl })}
      />
      <TextField
        label='Client ID'
        value={oauth.clientId}
        required={REQUIRED_MESSAGES.clientId}
        code
        onChange={(clientId) => setOAuth({ clientId })}
      />
      <TextField
        label='Scope (optional)'
        help='Space-separated. Leave empty when the token service doesn’t ask for one.'
        value={oauth.scope}
        code
        placeholder='api://…/.default'
        onChange={(scope) => setOAuth({ scope })}
      />
      <RadioGroupField<OAuthCredential>
        legend='Credential'
        choices={CREDENTIAL_CHOICES}
        value={draft.credential}
        onChange={(credential) => onChange({ credential })}
      />
      {certificate ? null : (
        <RadioGroupField<SecretAuthentication>
          legend='Client authentication'
          help='If the token service turns down secrets with special characters, or its CORS settings don’t allow an Authorization header, send the credentials in the body.'
          choices={CLIENT_AUTHENTICATION_CHOICES}
          value={oauth.clientAuthentication === 'body' ? 'body' : 'basic'}
          onChange={(clientAuthentication) => setOAuth({ clientAuthentication })}
        />
      )}
      <div className='cf-sections cf-oauth__advanced'>
        <Collapsible
          id='oauthAdvanced'
          title='Advanced'
          summary={summarizeOAuthAdvanced(draft)}
          level={4}
          attention={issues.oauth?.tone === 'error' || invalid.has(TOKEN_PARAMETERS_KEY)}
          reveal={props.reveal}
        >
          <TextField
            label='Audience (optional)'
            help='Sent as “audience”, for token services such as Auth0.'
            value={oauth.audience}
            code
            onChange={(audience) => setOAuth({ audience })}
          />
          <TextField
            label='Resource (optional)'
            help='Sent as “resource”, for token services such as AD FS.'
            value={oauth.resource}
            code
            onChange={(resource) => setOAuth({ resource })}
          />
          {certificate ? (
            <TextField
              label='Assertion audience (optional)'
              help='The signed JWT’s “aud” claim. Leave empty to use the access token URL.'
              value={oauth.assertionAudience}
              code
              placeholder='The access token URL'
              onChange={(assertionAudience) => setOAuth({ assertionAudience })}
            />
          ) : null}
          <TokenParameters
            parameters={oauth.extraParams}
            onChange={(extraParams) => setOAuth({ extraParams })}
            onValidityChange={(valid) => props.onValidityChange(TOKEN_PARAMETERS_KEY, valid)}
          />
          {issues.oauth ? <IssueMessage id={`${id}-issue`} issue={issues.oauth} /> : null}
        </Collapsible>
      </div>
    </div>
  );
}
