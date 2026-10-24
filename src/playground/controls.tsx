import type { ReactNode } from 'react';
import { useId } from 'react';

/** A titled group of scenario settings. */
export function Group(props: { title: string; children: ReactNode }) {
  return (
    <fieldset className='pg-group'>
      <legend className='pg-group__title'>{props.title}</legend>
      <div className='pg-group__body'>{props.children}</div>
    </fieldset>
  );
}

/** Radio buttons that look like a segmented control; arrow keys move between options. */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className='pg-segmented'>
      <legend>{props.label}</legend>
      <div className='pg-segmented__track'>
        {props.options.map(([value, text]) => (
          <label key={value} className='pg-segmented__option'>
            <input
              type='radio'
              name={name}
              value={value}
              checked={props.value === value}
              onChange={() => props.onChange(value)}
            />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Radio buttons in a column, each with an optional hint, for choices whose names don't fit side
 * by side. The group's legend names them (see Group); arrow keys move between them.
 */
export function Choices<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div className='pg-choices'>
      {props.options.map((option) => {
        const hintId = `${name}-${option.value}-hint`;
        return (
          <div key={option.value} className='pg-choice-row'>
            <label className='pg-choice'>
              <input
                type='radio'
                name={name}
                value={option.value}
                checked={props.value === option.value}
                aria-describedby={option.hint ? hintId : undefined}
                onChange={() => props.onChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
            {option.hint ? (
              <span id={hintId} className='pg-hint'>
                {option.hint}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** An on/off switch: a checkbox with the switch role, so it's read as “on” or “off”. */
export function Switch(props: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  /** Shown indented, as an option of the switch above. */
  nested?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hintId = useId();
  return (
    <div className={props.nested ? 'pg-switch-row is-nested' : 'pg-switch-row'}>
      <label className='pg-switch'>
        <input
          type='checkbox'
          role='switch'
          aria-checked={props.checked}
          aria-describedby={props.hint ? hintId : undefined}
          checked={props.checked}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span className='pg-switch__track' aria-hidden='true' />
        <span className='pg-switch__label'>{props.label}</span>
      </label>
      {props.hint ? (
        <span id={hintId} className='pg-hint'>
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}
