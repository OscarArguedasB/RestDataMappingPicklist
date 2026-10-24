import type { DragEvent, ReactNode, Ref } from 'react';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { InfoIcon, SuccessIcon, WarningIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import type { CredentialSource, ParsedCredential } from '../core/certificates';
import { PicklistError } from '../core/errors';
import type {
  CertificateInfo,
  JwsAlgorithm,
  SecretKind,
  SecretSummary,
  SigningKey,
} from '../core/secrets';
import type { Issue } from './settings';
import { SECRET_NOUNS, certificateWarnings, describeSecretChange, formatDay } from './settings';
import {
  CheckboxField,
  CopyButton,
  Field,
  IssueMessage,
  ReadOnlyContext,
  SecretField,
  TextField,
} from './ui';

/** A certificate or key read on this page, not saved yet. Never shown: only described. */
export interface ChosenKey {
  parsed: ParsedCredential;
  /** What the key can sign with; the first is its default (see allowedAlgorithms). */
  algorithms: readonly JwsAlgorithm[];
  /** The files, or the pasted text, it was read from. */
  sources: readonly string[];
}

/** The parts of the credentials that are edited apart from the typed secret. */
export interface CredentialDraft {
  chosenKey: ChosenKey | null;
  /** The JWT's "kid" header, for keys registered by key ID. */
  keyId: string;
  /** Another algorithm the chosen key can sign with; null for its default. */
  algorithm: JwsAlgorithm | null;
  /** Replace was pressed: a new secret is being entered. */
  replacing: boolean;
  /** Remove was confirmed: the saved secret is deleted on save. */
  removing: boolean;
}

export const EMPTY_CREDENTIALS: CredentialDraft = {
  chosenKey: null,
  keyId: '',
  algorithm: null,
  replacing: false,
  removing: false,
};

/** The signing key to save or test with: the chosen key, with its key ID and algorithm. */
export function signingKeyFor(credentials: CredentialDraft): SigningKey | null {
  const { chosenKey, keyId, algorithm } = credentials;
  if (!chosenKey) {
    return null;
  }
  const key: SigningKey = { ...chosenKey.parsed.signingKey };
  if (algorithm && chosenKey.algorithms.includes(algorithm)) {
    key.algorithm = algorithm;
  }
  const kid = keyId.trim();
  if (kid) {
    key.kid = kid;
  } else {
    delete key.kid;
  }
  return key;
}

/** Labels for the secret field, by kind. */
const SECRET_LABELS: Record<Exclude<SecretKind, 'signingKey'>, string> = {
  password: 'Password',
  token: 'Token',
  apiKey: 'API key',
  clientSecret: 'Client secret',
};

const SECRET_HELP: Record<Exclude<SecretKind, 'signingKey'>, string> = {
  password: 'Sent with the user name in a Basic Authorization header.',
  token: 'Sent as “Authorization: Bearer …”.',
  apiKey: 'Sent in the header set in Connect.',
  clientSecret: 'Sent to the access token URL only, never to the API.',
};

const KEY_FILE_TYPES = '.pfx,.p12,.pem,.cer,.crt,.der,.key';
const PASTED = 'Pasted text';

/** What a saved signing key is, for sentences: a certificate's key, or a key on its own. */
function storedNoun(summary: SecretSummary): string {
  if (summary.kind === 'signingKey') {
    return summary.certificate ? 'certificate' : 'key';
  }
  return SECRET_NOUNS[summary.kind];
}

function hostOf(origin: string | null): string | null {
  if (!origin) {
    return null;
  }
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Plain bytes for pasted text (TextEncoder's can belong to another realm in tests). */
function textSource(text: string): CredentialSource {
  return { name: PASTED, data: Uint8Array.from(new TextEncoder().encode(text)) };
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files');
}

async function fileSource(file: File): Promise<CredentialSource> {
  return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
}

function StatusLine(props: { tone: 'set' | 'unset' | 'warning'; children: ReactNode }) {
  return (
    <p className={`cf-secret-status cf-secret-status--${props.tone}`}>
      {props.tone === 'set' ? (
        <SuccessIcon />
      ) : props.tone === 'warning' ? (
        <WarningIcon />
      ) : (
        <InfoIcon />
      )}
      <span>{props.children}</span>
    </p>
  );
}

function Warnings({ warnings }: { warnings: readonly string[] }) {
  return warnings.length > 0 ? (
    <ul className='cf-secret-warnings'>
      {warnings.map((warning) => (
        <li key={warning}>
          <WarningIcon />
          <span>
            <span className='rp-sr-only'>Warning: </span>
            {warning}
          </span>
        </li>
      ))}
    </ul>
  ) : null;
}

/** What may be shown about a certificate: names, dates and thumbprints, never the key. */
function CertificateDetails({ info }: { info: CertificateInfo }) {
  return (
    <>
      <dl className='cf-facts cf-facts--details'>
        <div className='cf-facts__row'>
          <dt>Subject</dt>
          <dd className='cf-facts__wrap'>{info.subject || 'None'}</dd>
        </div>
        <div className='cf-facts__row'>
          <dt>Issuer</dt>
          <dd className='cf-facts__wrap'>{info.issuer || 'None'}</dd>
        </div>
        <div className='cf-facts__row'>
          <dt>Valid until</dt>
          <dd>{formatDay(info.notAfter, true)}</dd>
        </div>
        <div className='cf-facts__row'>
          <dt>SHA-1 thumbprint</dt>
          <dd className='cf-facts__copy'>
            <code className='cf-code cf-code--wrap'>{info.sha1Thumbprint}</code>
            <CopyButton label='SHA-1 thumbprint' value={info.sha1Thumbprint} />
          </dd>
        </div>
      </dl>
      <details className='cf-disclosure'>
        <summary>SHA-256 thumbprint</summary>
        <p className='cf-facts__copy'>
          <code className='cf-code cf-code--wrap'>{info.sha256Thumbprint}</code>
          <CopyButton label='SHA-256 thumbprint' value={info.sha256Thumbprint} />
        </p>
      </details>
    </>
  );
}

/** A saved signing key, from the configuration's summary. */
function StoredKeyDetails({ summary, now }: { summary: SecretSummary; now: Date }) {
  return (
    <>
      {summary.certificate ? <CertificateDetails info={summary.certificate} /> : null}
      <dl className='cf-facts cf-facts--details'>
        {summary.keyId ? (
          <div className='cf-facts__row'>
            <dt>Key ID</dt>
            <dd className='cf-facts__wrap'>
              <code className='cf-code'>{summary.keyId}</code>
            </dd>
          </div>
        ) : null}
        {summary.algorithm ? (
          <div className='cf-facts__row'>
            <dt>Signature</dt>
            <dd>{summary.algorithm}</dd>
          </div>
        ) : null}
      </dl>
      {summary.certificate ? (
        <Warnings warnings={certificateWarnings(summary.certificate, now)} />
      ) : null}
    </>
  );
}

type Reading =
  { status: 'idle' } | { status: 'reading'; what: string } | { status: 'error'; message: string };

/**
 * Reads a certificate and its key, or a key on its own: files (chosen or dropped) or pasted PEM,
 * with a password when the file needs one. The parser loads only when something is chosen, and
 * the files, text and password are dropped as soon as the key is read.
 */
function KeyPicker({
  ref,
  keyOnly,
  issue,
  now,
  onChosen,
}: {
  keyOnly: boolean;
  issue: Issue | null;
  now?: () => Date;
  /** The “Choose a file” button, so the card can move focus to it. */
  ref: Ref<HTMLButtonElement>;
  onChosen: (key: ChosenKey) => void;
}) {
  const id = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [pasted, setPasted] = useState('');
  const [password, setPassword] = useState('');
  const [reading, setReading] = useState<Reading>({ status: 'idle' });
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const runs = useRef(0);
  const focusPaste = useRef(false);
  // Unmounting cancels: a result that arrives later is ignored.
  useEffect(() => {
    const counter = runs;
    return () => {
      counter.current++;
    };
  }, []);
  useEffect(() => {
    if (focusPaste.current) {
      focusPaste.current = false;
      pasteRef.current?.focus();
    }
  });

  const read = async (nextFiles: readonly File[], text: string, secret: string) => {
    const run = ++runs.current;
    if (nextFiles.length === 0 && !text.trim()) {
      setReading({ status: 'idle' });
      return;
    }
    setReading({
      status: 'reading',
      what:
        nextFiles.length === 0
          ? 'the pasted text'
          : nextFiles.length === 1
            ? `“${nextFiles[0]?.name ?? ''}”`
            : `${nextFiles.length} files`,
    });
    try {
      const certificates = await import('../core/certificates');
      const tooLarge = nextFiles.find(
        (file) => file.size > certificates.CREDENTIAL_LIMITS.maxFileBytes
      );
      if (tooLarge) {
        throw new PicklistError(
          'config',
          `“${tooLarge.name}” is larger than 1 MB, so it isn’t a key or certificate file.`
        );
      }
      const sources = await Promise.all(nextFiles.map(fileSource));
      if (text.trim()) {
        sources.push(textSource(text));
      }
      const parsed = await certificates.parseCredentials(sources, {
        password: secret,
        now: now?.(),
      });
      if (run !== runs.current) {
        return;
      }
      onChosen({
        parsed,
        algorithms: certificates.allowedAlgorithms(parsed.keyType, parsed.curve ?? parsed.keyBits),
        sources: sources.map((source) => source.name),
      });
      setFiles([]);
      setPasted('');
      setPassword('');
      setReading({ status: 'idle' });
    } catch (error) {
      if (run === runs.current) {
        setReading({
          status: 'error',
          message:
            error instanceof PicklistError
              ? error.message
              : 'The file couldn’t be read. Try again.',
        });
      }
    }
  };

  const addFiles = (added: readonly File[]) => {
    if (added.length === 0) {
      return;
    }
    // Choosing a file again replaces the earlier copy, so a key and its certificate can be
    // chosen one after the other.
    const names = new Set(added.map((file) => file.name));
    const next = [...files.filter((file) => !names.has(file.name)), ...added];
    setFiles(next);
    void read(next, '', password);
  };

  const removeFile = (name: string) => {
    const next = files.filter((file) => file.name !== name);
    setFiles(next);
    void read(next, '', password);
  };

  const error = reading.status === 'error' ? reading.message : null;
  const passwordError = error && /password/i.test(error) ? error : null;
  const otherError = error && !passwordError ? error : null;
  const needsPassword =
    Boolean(passwordError) || files.some((file) => /\.(pfx|p12)$/i.test(file.name));
  const subject = keyOnly ? 'key' : 'certificate';

  return (
    <div className='cf-key-picker'>
      {mode === 'file' ? (
        <div
          className='cf-dropzone'
          data-dragging={dragging || undefined}
          data-issue={issue ? 'error' : undefined}
          onDragEnter={(event) => {
            if (hasFiles(event)) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragOver={(event) => {
            if (hasFiles(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDragLeave={(event) => {
            if (!(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles([...event.dataTransfer.files]);
          }}
        >
          <button
            ref={ref}
            type='button'
            className='cf-button'
            aria-describedby={joinIds(`${id}-types`, issue ? `${id}-issue` : null)}
            data-problem={issue ? true : undefined}
            onClick={() => fileInput.current?.click()}
          >
            {keyOnly ? 'Choose a key file…' : 'Choose a certificate file…'}
          </button>
          <p id={`${id}-types`} className='cf-hint'>
            Or drop it here: .pfx, .p12, .pem, .cer, .crt or .key. A certificate and its key can be
            two files.
          </p>
          <input
            ref={fileInput}
            type='file'
            multiple
            accept={KEY_FILE_TYPES}
            className='cf-key-picker__input'
            tabIndex={-1}
            aria-label='Certificate or key file'
            onChange={(event) => {
              const chosen = [...(event.target.files ?? [])];
              // Choosing the same file again should still work.
              event.target.value = '';
              addFiles(chosen);
            }}
          />
          {files.length > 0 ? (
            <ul className='cf-key-picker__files' aria-label='Chosen files'>
              {files.map((file) => (
                <li key={file.name}>
                  <span className='cf-key-picker__file'>{file.name}</span>
                  <button
                    type='button'
                    className='cf-button cf-button--quiet cf-button--small'
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(file.name)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <Field
          label='PEM text'
          help='Paste the BEGIN and END lines too. A key and its certificate can be pasted together.'
          issue={issue}
        >
          {({ id: fieldId, describedBy, invalid }) => (
            <textarea
              ref={pasteRef}
              id={fieldId}
              className='cf-input cf-input--code'
              rows={6}
              value={pasted}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              spellCheck={false}
              autoComplete='off'
              onChange={(event) => {
                setPasted(event.target.value);
                void read([], event.target.value, password);
              }}
            />
          )}
        </Field>
      )}
      {mode === 'file' && issue ? <IssueMessage id={`${id}-issue`} issue={issue} /> : null}
      <p className='cf-key-picker__switch'>
        <button
          type='button'
          className='cf-link'
          onClick={() => {
            const next = mode === 'file' ? 'paste' : 'file';
            runs.current++;
            setMode(next);
            setFiles([]);
            setPasted('');
            setReading({ status: 'idle' });
            focusPaste.current = next === 'paste';
          }}
        >
          {mode === 'file' ? 'Paste PEM instead' : 'Choose a file instead'}
        </button>
      </p>
      {needsPassword ? (
        <div className='cf-key-picker__password'>
          <SecretField
            label='File password'
            help={`The password the ${subject} was exported with.`}
            value={password}
            issue={passwordError ? { tone: 'error', message: passwordError } : null}
            onChange={setPassword}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void read(files, pasted, password);
              }
            }}
          />
          <button
            type='button'
            className='cf-button'
            disabled={reading.status === 'reading'}
            onClick={() => void read(files, pasted, password)}
          >
            Unlock
          </button>
        </div>
      ) : null}
      <div className='cf-key-picker__status' aria-live='polite'>
        {reading.status === 'reading' ? (
          <p className='cf-progress'>
            <Spinner />
            <span>Reading {reading.what}…</span>
          </p>
        ) : null}
        {otherError ? (
          <IssueMessage id={`${id}-read-issue`} issue={{ tone: 'error', message: otherError }} />
        ) : null}
      </div>
    </div>
  );
}

function joinIds(...ids: Array<string | null>): string | undefined {
  return ids.filter(Boolean).join(' ') || undefined;
}

/** A key read on this page: what it is, what it signs with, and that it isn't saved yet. */
function ChosenKeyDetails(props: {
  chosenKey: ChosenKey;
  algorithm: JwsAlgorithm | null;
  onAlgorithmChange: (algorithm: JwsAlgorithm) => void;
}) {
  const { parsed, algorithms, sources } = props.chosenKey;
  const algorithm = props.algorithm ?? parsed.signingKey.algorithm;
  const keyText =
    parsed.keyType === 'RSA'
      ? `RSA ${parsed.keyBits}-bit key`
      : `EC key on ${parsed.curve ?? `${parsed.keyBits}-bit curve`}`;
  return (
    <>
      <p className='cf-meta'>
        From {sources.join(', ')} · {keyText}
        {parsed.certificate ? '' : ' · no certificate'}
      </p>
      {parsed.certificate ? <CertificateDetails info={parsed.certificate} /> : null}
      {algorithms.length > 1 ? (
        <Field
          label='Signing algorithm'
          help='RS256 works with most token services. Use another only if yours asks for it.'
        >
          {({ id, describedBy }) => (
            <select
              id={id}
              className='cf-input cf-select cf-select--short'
              aria-describedby={describedBy}
              value={algorithm}
              onChange={(event) => {
                const chosen = algorithms.find((item) => item === event.target.value);
                if (chosen) {
                  props.onAlgorithmChange(chosen);
                }
              }}
            >
              {algorithms.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <p className='cf-meta'>Signature: {algorithm}.</p>
      )}
      <Warnings warnings={parsed.warnings} />
    </>
  );
}

/**
 * The configuration's secret, write-only: it can be entered, replaced or removed, but once saved
 * it's never shown again, only described (who changed it and when, and for certificates their
 * names, dates and thumbprints). Nothing is prepopulated, and nothing typed here is logged.
 */
export function CredentialsCard(props: {
  /** What the sign-in method needs; null when it needs nothing. */
  kind: SecretKind | null;
  /** The configuration's saved secret, described; null when none is saved. */
  stored: SecretSummary | null;
  /** The password, token, API key or client secret typed here. */
  secret: string;
  onSecretChange: (value: string) => void;
  credentials: CredentialDraft;
  onCredentialsChange: (patch: Partial<CredentialDraft>) => void;
  /** Asks first, then sets `removing`. */
  onRemove: () => void;
  /** Problems with the secret (it has to be entered again) and with the key ID. */
  issue: Issue | null;
  keyIdIssue: Issue | null;
  /** Where a new secret would be sent, for “Sent only to …”. */
  destination: string | null;
  /** OAuth 2.0: where the secret's access tokens go (the API's origin); otherwise null. */
  apiDestination?: string | null;
  /** The sign-in method's name, for when the saved secret doesn't fit it. */
  methodLabel: string;
  /** Lets the page move focus here, for example after a dialog. */
  headingId: string;
  /** The configuration is saved, so forms already use it: a missing secret is a problem now. */
  saved?: boolean;
  /**
   * The secret may be left out: Basic sign-in with a user name sends the user name alone, as it
   * did before 4.0 (some APIs take a key as the user name, with no password).
   */
  optional?: boolean;
  /** For certificate dates; tests set it. */
  now?: () => Date;
}) {
  const { kind, stored, credentials, onCredentialsChange } = props;
  const readOnly = useContext(ReadOnlyContext);
  const [keyOnly, setKeyOnly] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'input' | 'replace' | null>(null);
  // Focus follows the buttons that swap the card's content, so it never falls back to the page.
  useEffect(() => {
    if (focusNext.current === 'input') {
      (secretInput.current ?? pickerButton.current)?.focus();
    } else if (focusNext.current === 'replace') {
      replaceButton.current?.focus();
    }
    focusNext.current = null;
  });

  // Certificate warnings count days, so the date the card was opened is close enough.
  const [now] = useState(() => props.now?.() ?? new Date());
  const chosenKey = credentials.chosenKey;
  const usable = stored !== null && kind !== null && stored.kind === kind;
  // The saved secret (or, for OAuth 2.0, the tokens it gets) would now go somewhere else, so it
  // has to be entered again.
  const moved =
    usable &&
    (props.destination !== stored.boundOrigin ||
      (stored.apiOrigin !== undefined && (props.apiDestination ?? null) !== stored.apiOrigin));
  const entering = props.secret !== '' || chosenKey !== null;
  const kept = usable && !credentials.replacing && !credentials.removing && !moved && !entering;
  const showInput = kind !== null && !readOnly && !kept;
  const host = hostOf(props.destination);
  const showKeyId =
    kind === 'signingKey' &&
    (keyOnly ||
      Boolean(credentials.keyId.trim()) ||
      (chosenKey !== null && !chosenKey.parsed.certificate));

  const cancelReplace = () => {
    focusNext.current = 'replace';
    props.onSecretChange('');
    onCredentialsChange({ replacing: false, chosenKey: null, keyId: '', algorithm: null });
  };

  let status: ReactNode;
  if (stored && kind === null) {
    status = (
      <StatusLine tone='warning'>
        The saved {storedNoun(stored)} is removed when you save, because the API no longer signs in.
      </StatusLine>
    );
  } else if (stored && credentials.removing) {
    status = (
      <StatusLine tone='warning'>
        Removed when you save.{' '}
        {readOnly ? null : (
          <button
            type='button'
            className='cf-link'
            onClick={() => {
              focusNext.current = 'replace';
              onCredentialsChange({ removing: false });
            }}
          >
            Undo
          </button>
        )}
      </StatusLine>
    );
  } else if (stored && !usable) {
    status = (
      <StatusLine tone='warning'>
        The saved {storedNoun(stored)} can’t be used with {props.methodLabel}, so it’s removed when
        you save.
      </StatusLine>
    );
  } else if (stored) {
    status = <StatusLine tone='set'>{describeSecretChange(stored)}</StatusLine>;
  } else if (kind !== null && props.optional) {
    status = (
      <StatusLine tone='unset'>Not set: forms send the user name without a password.</StatusLine>
    );
  } else if (kind !== null && props.saved) {
    // The list shows this as “Secret not set”, an error: here it says what it means for forms.
    status = (
      <StatusLine tone='warning'>
        Not set: forms that use it can’t sign in until it’s entered.
      </StatusLine>
    );
  } else {
    status = <StatusLine tone='unset'>Not set</StatusLine>;
  }

  const stringKind = kind !== null && kind !== 'signingKey' ? kind : null;
  const typed = props.secret !== '';

  return (
    <section className='cf-card cf-credentials' aria-labelledby={props.headingId}>
      <div className='cf-card__header'>
        <div>
          <h3 id={props.headingId} className='cf-card__title' tabIndex={-1}>
            Credentials
          </h3>
          <p className='cf-card__description'>
            Write-only: once saved, it can be replaced or removed, but never shown.
          </p>
        </div>
      </div>

      {status}
      {host && kind !== null ? (
        <p className='cf-meta'>
          {/* A key never leaves the page: only what it signs goes to the token URL. */}
          {kind === 'signingKey' ? `Used only with ${host}.` : `Sent only to ${host}.`}
        </p>
      ) : null}

      {usable && stored?.kind === 'signingKey' && !credentials.removing ? (
        <StoredKeyDetails summary={stored} now={now} />
      ) : null}

      {kept && !readOnly ? (
        <div className='cf-secret-actions'>
          <button
            ref={replaceButton}
            type='button'
            className='cf-button'
            onClick={() => {
              focusNext.current = 'input';
              onCredentialsChange({ replacing: true });
            }}
          >
            Replace
          </button>
          <button type='button' className='cf-button' onClick={props.onRemove}>
            Remove
          </button>
        </div>
      ) : null}

      {showInput && stringKind ? (
        <div className='cf-secret-input'>
          <SecretField
            label={
              credentials.replacing ? `New ${SECRET_NOUNS[stringKind]}` : SECRET_LABELS[stringKind]
            }
            help={SECRET_HELP[stringKind]}
            value={props.secret}
            issue={props.issue}
            inputRef={secretInput}
            onChange={props.onSecretChange}
          />
          {typed ? (
            <p className='cf-hint'>Saved when you save the configuration, then never shown.</p>
          ) : null}
        </div>
      ) : null}

      {showInput && kind === 'signingKey' ? (
        <div className='cf-secret-input'>
          {chosenKey ? (
            <>
              <ChosenKeyDetails
                chosenKey={chosenKey}
                algorithm={credentials.algorithm}
                onAlgorithmChange={(algorithm) => onCredentialsChange({ algorithm })}
              />
              <p className='cf-hint'>Not saved yet: it’s saved when you save the configuration.</p>
              <p>
                <button
                  type='button'
                  className='cf-link'
                  onClick={() => {
                    focusNext.current = 'input';
                    onCredentialsChange({ chosenKey: null, algorithm: null });
                  }}
                >
                  Choose another file
                </button>
              </p>
            </>
          ) : (
            <>
              <KeyPicker
                keyOnly={keyOnly}
                issue={props.issue}
                now={props.now}
                ref={pickerButton}
                onChosen={(key) => onCredentialsChange({ chosenKey: key, algorithm: null })}
              />
              <CheckboxField
                label='I have a key without a certificate'
                help='For token services that know the key by a key ID instead of a certificate.'
                checked={keyOnly}
                onChange={setKeyOnly}
              />
            </>
          )}
          {showKeyId ? (
            <TextField
              label='Key ID (optional)'
              help='The key ID the token service registered for this key. It’s sent as the JWT’s “kid” header.'
              value={credentials.keyId}
              issue={props.keyIdIssue}
              code
              onChange={(keyId) => onCredentialsChange({ keyId })}
            />
          ) : null}
        </div>
      ) : null}

      {credentials.replacing && !readOnly ? (
        <p className='cf-secret-actions'>
          <button type='button' className='cf-button' onClick={cancelReplace}>
            Cancel
          </button>
          <span className='cf-hint'>The saved one stays until you save.</span>
        </p>
      ) : null}
      {moved && !credentials.removing && !credentials.replacing && !readOnly ? (
        <p className='cf-secret-actions'>
          <button type='button' className='cf-button' onClick={props.onRemove}>
            Remove
          </button>
        </p>
      ) : null}

      <p className='cf-note'>
        Hidden on every screen, but not encrypted: any member of your organization can read it
        through the Azure DevOps REST API, and anyone who opens a work item that uses it can read it
        with browser developer tools. Use a read-only credential limited to this API.
      </p>
    </section>
  );
}
