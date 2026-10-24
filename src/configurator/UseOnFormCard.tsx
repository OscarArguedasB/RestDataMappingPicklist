import { useId } from 'react';
import { CopyButton } from './ui';

/**
 * How a form uses the configuration: by its name, entered on the control's Options tab in the
 * process editor, or assigned to the process's controls on the Configurations tab.
 */
export function UseOnFormCard(props: {
  /** The name as it is now, saved or not. */
  name: string;
  /** True when the name isn't saved yet, so forms can't find it by this name so far. */
  unsaved: boolean;
  /** Opens “Controls in this process”; without it, the words aren't a link. */
  onShowControls?: () => void;
}) {
  const id = useId();
  const name = props.name.trim();
  return (
    <section className='cf-card' aria-labelledby={`${id}-title`}>
      <div className='cf-card__header'>
        <div>
          <h3 id={`${id}-title`} className='cf-card__title'>
            Use it on a form
          </h3>
        </div>
      </div>
      <p className='cf-use-text'>
        In the process editor, add the REST Picklist control (listed as “Rest Data Mapping
        Picklist”), choose the field and enter this configuration name:
      </p>
      {name ? (
        <p className='cf-use-name'>
          <code className='cf-code cf-code--wrap'>{name}</code>
          <CopyButton label='configuration name' value={name} />
        </p>
      ) : (
        <p className='cf-hint'>Enter a name first.</p>
      )}
      {name && props.unsaved ? (
        <p className='cf-hint'>Forms find it by this name once you save.</p>
      ) : null}
      <p className='cf-use-text'>
        {props.onShowControls ? (
          <>
            Or{' '}
            <button
              type='button'
              className='cf-link cf-link--inline'
              onClick={props.onShowControls}
            >
              assign it under Controls in this process
            </button>
            .
          </>
        ) : (
          'Or assign it under Controls in this process.'
        )}
      </p>
    </section>
  );
}
