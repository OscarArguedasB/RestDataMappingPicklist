import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

export interface TabDefinition<T extends string> {
  id: T;
  label: string;
}

/**
 * WAI-ARIA tabs with automatic activation: arrow keys, Home and End move between tabs and show
 * them; Tab moves on into the panel. Only the selected tab is in the Tab order.
 */
export function TabList<T extends string>(props: {
  label: string;
  tabs: readonly TabDefinition<T>[];
  selected: T;
  idPrefix: string;
  onSelect: (id: T) => void;
}) {
  const { tabs, selected, idPrefix, onSelect } = props;
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const move = (event: KeyboardEvent, index: number) => {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const tab = tabs[next];
    if (tab) {
      onSelect(tab.id);
      refs.current.get(tab.id)?.focus();
    }
  };

  return (
    <div className='cf-tabs' role='tablist' aria-label={props.label}>
      {tabs.map((tab, index) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              if (element) {
                refs.current.set(tab.id, element);
              } else {
                refs.current.delete(tab.id);
              }
            }}
            type='button'
            role='tab'
            id={`${idPrefix}-tab-${tab.id}`}
            className='cf-tab'
            aria-selected={isSelected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel(props: {
  id: string;
  idPrefix: string;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role='tabpanel'
      id={`${props.idPrefix}-panel-${props.id}`}
      aria-labelledby={`${props.idPrefix}-tab-${props.id}`}
      className='cf-tabpanel'
      hidden={!props.selected}
      // The panel itself takes focus when it has nothing focusable at the top (WAI-ARIA tabs).
      tabIndex={0}
    >
      {props.children}
    </div>
  );
}
