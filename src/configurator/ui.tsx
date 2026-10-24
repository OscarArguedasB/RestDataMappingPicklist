import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { AlertIcon, CopyIcon, InfoIcon, SuccessIcon, WarningIcon } from '../components/Icons';
import { copyText } from './clipboard';
import type { Issue } from './settings';

// Form building blocks shared by the setup page's tabs. Every control has a visible label, its
// help and problems are linked with aria-describedby, and problems never rely on color alone.

/**
 * True where settings may be viewed but not changed: choices and switches are written out as
 * text. Text fields stay read-only inputs on purpose: at full contrast (not disabled), and
 * selectable, so a URL or a client ID can still be copied.
 */
export const ReadOnlyContext = createContext(false);

/** True once Save was pressed: required fields that are still empty say so, visited or not. */
export const ShowRequiredContext = createContext(false);

function joinIds(...ids: Array<string | false | null | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined || undefined;
}

/** Errors get a circle and warnings a triangle, so their severity isn't told by color alone. */
export function IssueMessage({ id, issue }: { id: string; issue: Issue }) {
  return (
    <p id={id} className={`cf-issue cf-issue--${issue.tone}`}>
      {issue.tone === 'error' ? <AlertIcon /> : <WarningIcon />}
      <span>
        <span className='rp-sr-only'>{issue.tone === 'error' ? 'Error: ' : 'Warning: '}</span>
        {issue.message}
      </span>
    </p>
  );
}

export interface FieldIds {
  id: string;
  describedBy: string | undefined;
  invalid: true | undefined;
}

export function Field(props: {
  label: ReactNode;
  help?: ReactNode;
  issue?: Issue | null;
  /** Shown at the end of the label row, like a Detect button. */
  action?: ReactNode;
  className?: string;
  children: (ids: FieldIds) => ReactNode;
}) {
  const { label, help, issue, action, className, children } = props;
  const id = useId();
  const helpId = help ? `${id}-help` : null;
  const issueId = issue ? `${id}-issue` : null;
  return (
    <div className={joinIds('cf-setting', className)} data-issue={issue?.tone}>
      <div className='cf-setting__label-row'>
        <label className='cf-label' htmlFor={id}>
          {label}
        </label>
        {action}
      </div>
      {help ? (
        <p id={helpId ?? undefined} className='cf-help'>
          {help}
        </p>
      ) : null}
      {children({
        id,
        describedBy: joinIds(helpId, issueId),
        invalid: issue?.tone === 'error' ? true : undefined,
      })}
      {issue && issueId ? <IssueMessage id={issueId} issue={issue} /> : null}
    </div>
  );
}

export function TextField(props: {
  label: ReactNode;
  help?: ReactNode;
  issue?: Issue | null;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  code?: boolean;
  multiline?: boolean;
  inputMode?: 'url' | 'text';
  /**
   * What to say while the field is empty, which makes it required. It's said once the field was
   * left, or once Save was pressed (ShowRequiredContext).
   */
  required?: string;
  disabled?: boolean;
  action?: ReactNode;
  /** Extra content under the input, such as suggestions. */
  after?: ReactNode;
}) {
  const {
    value,
    onChange,
    placeholder,
    code,
    multiline,
    inputMode,
    required,
    disabled,
    after,
    issue,
    ...field
  } = props;
  const readOnly = useContext(ReadOnlyContext);
  const showRequired = useContext(ShowRequiredContext);
  const [visited, setVisited] = useState(false);
  const missing = Boolean(required) && !readOnly && !value.trim();
  const shown: Issue | null | undefined =
    missing && required && (visited || showRequired) ? { tone: 'error', message: required } : issue;
  const className = code ? 'cf-input cf-input--code' : 'cf-input';
  return (
    <Field {...field} issue={shown}>
      {({ id, describedBy, invalid }) => (
        <>
          {multiline ? (
            <textarea
              id={id}
              className={className}
              value={value}
              placeholder={placeholder}
              readOnly={readOnly}
              disabled={disabled}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={required ? true : undefined}
              spellCheck={false}
              autoComplete='off'
              rows={Math.min(8, Math.max(3, value.split('\n').length))}
              onBlur={() => setVisited(true)}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <input
              id={id}
              className={className}
              value={value}
              placeholder={placeholder}
              readOnly={readOnly}
              disabled={disabled}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={required ? true : undefined}
              spellCheck={false}
              autoComplete='off'
              inputMode={inputMode}
              onBlur={() => setVisited(true)}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
          {after}
        </>
      )}
    </Field>
  );
}

/**
 * A password, token or key: hidden by default, never filled in by the page (what's typed is the
 * only value it ever holds), and kept away from password managers: it's outside any <form>,
 * autocomplete is off, and the common managers' own opt-outs are set, so the browser doesn't
 * offer to save the secret (a saved copy would live, and sync, outside Azure DevOps).
 */
export function SecretField(props: {
  label: string;
  help?: ReactNode;
  issue?: Issue | null;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const { value, onChange, onKeyDown, inputRef, ...field } = props;
  const [revealed, setRevealed] = useState(false);
  return (
    <Field {...field}>
      {({ id, describedBy, invalid }) => (
        <div className='cf-input-group'>
          <input
            ref={inputRef}
            id={id}
            className='cf-input'
            type={revealed ? 'text' : 'password'}
            value={value}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            spellCheck={false}
            autoComplete='off'
            data-lpignore='true'
            data-1p-ignore='true'
            data-bwignore='true'
            data-form-type='other'
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* The label flips with the visible Show/Hide text, so it isn't also a toggle button:
              “Hide client secret, pressed” would state the state twice, in opposite words. */}
          <button
            type='button'
            className='cf-button cf-button--quiet'
            aria-label={
              revealed ? `Hide ${props.label.toLowerCase()}` : `Show ${props.label.toLowerCase()}`
            }
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
    </Field>
  );
}

export function CheckboxField(props: {
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const readOnly = useContext(ReadOnlyContext);
  if (readOnly) {
    // Written out, like the other choices: a disabled checkbox is faint and reads as broken.
    return (
      <dl className='cf-setting cf-facts'>
        <div className='cf-facts__row'>
          <dt className='cf-label'>{props.label}</dt>
          <dd>{props.checked ? 'On' : 'Off'}</dd>
        </div>
      </dl>
    );
  }
  return (
    <div className='cf-setting cf-setting--flag'>
      <input
        id={id}
        type='checkbox'
        className='cf-checkbox'
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.help ? `${id}-help` : undefined}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <div>
        <label className='cf-label' htmlFor={id}>
          {props.label}
        </label>
        {props.help ? (
          <p id={`${id}-help`} className='cf-help'>
            {props.help}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Secondary text under a radio option. */
  help?: string;
  /** The id of text that describes this option, such as a notice shown while it's chosen. */
  describedBy?: string;
}

/** A choice written out, for people who may view but not change it. */
function ChoiceText<T extends string>(props: {
  label: string;
  choices: readonly Choice<T>[];
  value: T | null;
}) {
  const chosen = props.choices.find((choice) => choice.value === props.value);
  return (
    <dl className='cf-setting cf-facts'>
      <div className='cf-facts__row'>
        <dt className='cf-label'>{props.label}</dt>
        <dd>{chosen?.label ?? 'Not set'}</dd>
      </div>
    </dl>
  );
}

/**
 * Mutually exclusive choices shown as joined buttons. Native radios underneath, so arrow keys,
 * disabled options and form semantics work as people expect. `className` lets a narrow container
 * restyle them as a list (see editor.css).
 */
export function SegmentedControl<T extends string>(props: {
  label: string;
  choices: readonly Choice<T>[];
  value: T | null;
  onChange: (value: T) => void;
  describedBy?: string;
  className?: string;
  /** The checked option is where Save sends focus when the choice has a problem. */
  problem?: boolean;
}) {
  const name = useId();
  const readOnly = useContext(ReadOnlyContext);
  if (readOnly) {
    return <ChoiceText label={props.label} choices={props.choices} value={props.value} />;
  }
  return (
    <fieldset
      className={joinIds('cf-segmented', props.className)}
      aria-describedby={props.describedBy}
    >
      <legend className='cf-label cf-legend'>{props.label}</legend>
      <div className='cf-segmented__options'>
        {props.choices.map((choice) => (
          <label
            key={choice.value}
            className='cf-segmented__option'
            data-disabled={choice.disabled || undefined}
          >
            <input
              type='radio'
              name={name}
              className='cf-segmented__input'
              value={choice.value}
              checked={props.value === choice.value}
              disabled={choice.disabled}
              aria-describedby={choice.describedBy}
              data-problem={(props.problem && props.value === choice.value) || undefined}
              onChange={() => props.onChange(choice.value)}
            />
            <span className='cf-segmented__label'>{choice.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function RadioGroupField<T extends string>(props: {
  legend: string;
  help?: ReactNode;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  const readOnly = useContext(ReadOnlyContext);
  if (readOnly) {
    return <ChoiceText label={props.legend} choices={props.choices} value={props.value} />;
  }
  return (
    <fieldset
      className='cf-setting cf-radio-group'
      aria-describedby={props.help ? `${name}-help` : undefined}
    >
      <legend className='cf-label'>{props.legend}</legend>
      {props.help ? (
        <p id={`${name}-help`} className='cf-help'>
          {props.help}
        </p>
      ) : null}
      {props.choices.map((choice) => (
        <label key={choice.value} className='cf-radio'>
          <input
            type='radio'
            name={name}
            className='cf-checkbox'
            value={choice.value}
            checked={props.value === choice.value}
            disabled={choice.disabled}
            onChange={() => props.onChange(choice.value)}
          />
          <span>
            {choice.label}
            {choice.help ? <span className='cf-radio__help'>{choice.help}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim().replace(/[,\s]/g, '');
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * A whole number within limits. What's typed is kept while it's invalid (with a message), and only
 * valid numbers reach `onChange`, so the setting keeps its last good value meanwhile.
 */
export function NumberField(props: {
  label: string;
  help?: ReactNode;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { value, min, max, unit, onChange, onValidityChange, ...field } = props;
  const readOnly = useContext(ReadOnlyContext);
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  // Follow changes made elsewhere (import, load, reset) without fighting the person typing.
  if (value !== shown) {
    setShown(value);
    if (parseWholeNumber(text) !== value) {
      setText(String(value));
    }
  }
  const parsed = parseWholeNumber(text);
  const valid = parsed !== null && parsed >= min && parsed <= max;
  // Reported when validity changes, not on every render (parents pass inline callbacks).
  const validityRef = useRef(onValidityChange);
  useEffect(() => {
    validityRef.current = onValidityChange;
  });
  useEffect(() => {
    validityRef.current?.(valid);
  }, [valid]);
  // A field that goes away (another paging type, say) no longer has a problem.
  useEffect(() => () => validityRef.current?.(true), []);
  const issue: Issue | null = valid
    ? null
    : {
        tone: 'error',
        message: `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`,
      };
  return (
    <Field {...field} issue={issue} className='cf-setting--number'>
      {({ id, describedBy, invalid }) => (
        <div className='cf-number'>
          <input
            id={id}
            className='cf-input'
            inputMode='numeric'
            value={text}
            readOnly={readOnly}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoComplete='off'
            onChange={(event) => {
              setText(event.target.value);
              const next = parseWholeNumber(event.target.value);
              if (next !== null && next >= min && next <= max) {
                onChange(next);
              }
            }}
          />
          {unit ? <span className='cf-number__unit'>{unit}</span> : null}
        </div>
      )}
    </Field>
  );
}

export function CopyButton({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    setState((await copyText(value)) ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };
  return (
    <button
      type='button'
      className='cf-button cf-button--quiet cf-copy'
      aria-label={`Copy ${label}`}
      onClick={() => void copy()}
    >
      {state === 'copied' ? <SuccessIcon /> : <CopyIcon />}
      <span aria-live='polite'>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}
      </span>
    </button>
  );
}

export function Callout(props: {
  tone: 'error' | 'warning' | 'success' | 'info';
  title?: ReactNode;
  children?: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  // A triangle for warnings and a circle for errors: the two never differ by color alone.
  const icon =
    props.tone === 'success' ? (
      <SuccessIcon />
    ) : props.tone === 'info' ? (
      <InfoIcon />
    ) : props.tone === 'warning' ? (
      <WarningIcon />
    ) : (
      <AlertIcon />
    );
  return (
    <div
      className={joinIds(`cf-callout cf-callout--${props.tone}`, props.className)}
      role={props.role}
    >
      {icon}
      <div className='cf-callout__body'>
        {props.title ? <p className='cf-callout__title'>{props.title}</p> : null}
        {props.children}
      </div>
    </div>
  );
}
