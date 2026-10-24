import { useId } from 'react';
import { canHoldControls } from '../devops/processes';
import type { ProcessSummary } from './services';

/** How a process is shown under its name. */
export function processKind(process: Pick<ProcessSummary, 'customizationType' | 'isEnabled'>) {
  const kind =
    process.customizationType === 'inherited'
      ? 'Inherited'
      : process.customizationType === 'custom'
        ? 'Hosted XML'
        : 'System';
  return process.isEnabled ? kind : `${kind}, disabled`;
}

/**
 * The processes to choose from: a list of buttons that keeps the selected one highlighted
 * (aria-current), and on narrow screens a native select instead (CSS shows one or the other).
 * System processes can't be changed, so they're listed apart and can't be chosen.
 */
export function ProcessList(props: {
  processes: readonly ProcessSummary[];
  selectedId: string;
  /** Configurations shared with each process. */
  counts: ReadonlyMap<string, number>;
  onSelect: (processId: string) => void;
}) {
  const { processes, selectedId, counts, onSelect } = props;
  const id = useId();
  const usable = processes.filter(canHoldControls);
  const fixed = processes.filter((process) => !canHoldControls(process));

  return (
    <>
      <nav className='cf-processes' aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className='cf-processes__title'>
          Processes
        </h2>
        <ul className='cf-process-list'>
          {usable.map((process) => {
            const count = counts.get(process.id) ?? 0;
            return (
              <li key={process.id}>
                {/* Named in full, so the parts aren't read as one run of words. It starts
                    with the visible name, so speech input finds it. */}
                <button
                  type='button'
                  className='cf-process'
                  aria-label={`${process.name}, ${processKind(process)}, ${count} ${count === 1 ? 'configuration' : 'configurations'}`}
                  aria-current={process.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(process.id)}
                >
                  <span className='cf-process__text'>
                    <span className='cf-process__name'>{process.name}</span>
                    <span className='cf-process__kind'>{processKind(process)}</span>
                  </span>
                  <span className='cf-process__count'>{count}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {fixed.length > 0 ? (
          <>
            <h3 id={`${id}-fixed`} className='cf-process-group'>
              Can’t hold custom controls
            </h3>
            <ul className='cf-process-list' aria-labelledby={`${id}-fixed`}>
              {fixed.map((process) => (
                <li key={process.id} className='cf-process cf-process--static'>
                  <span className='cf-process__text'>
                    <span className='cf-process__name'>{process.name}</span>
                    <span className='rp-sr-only'>, </span>
                    <span className='cf-process__kind'>{processKind(process)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </nav>

      <div className='cf-process-select cf-setting'>
        <label className='cf-label' htmlFor={`${id}-select`}>
          Process
        </label>
        <select
          id={`${id}-select`}
          className='cf-input cf-select'
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
        >
          {usable.map((process) => (
            <option key={process.id} value={process.id}>
              {process.name} ({counts.get(process.id) ?? 0}){process.isEnabled ? '' : ', disabled'}
            </option>
          ))}
          {fixed.length > 0 ? (
            <optgroup label='Can’t hold custom controls'>
              {fixed.map((process) => (
                <option key={process.id} value={process.id} disabled>
                  {process.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>
    </>
  );
}
