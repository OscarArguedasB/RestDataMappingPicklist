import type { KeyboardEvent } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  id: string;
  /** A verb, ending in “…” when it opens a dialog. */
  label: string;
  onSelect: () => void;
  /** Opens a dialog, which screen readers are told about. */
  opensDialog?: boolean;
}

/** The room kept between the menu and the edge of the page. */
const MENU_MARGIN = 8;

/** “⋯”, drawn like the other icons (16×16, current color). */
function MoreIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox='0 0 16 16'
      fill='currentColor'
      aria-hidden
      focusable={false}
      className='rp-icon'
    >
      <circle cx='3.25' cy='8' r='1.25' />
      <circle cx='8' cy='8' r='1.25' />
      <circle cx='12.75' cy='8' r='1.25' />
    </svg>
  );
}

/**
 * A “More actions” button with a menu (the WAI-ARIA menu button pattern): opening it focuses the
 * first item; arrow keys, Home and End move, a letter jumps to the next item starting with it;
 * Escape closes and returns focus to the button; Tab closes and moves on. Choosing an item puts
 * focus back on the button first, so a dialog it opens returns there too.
 */
export function MenuButton(props: { label: string; items: readonly MenuItem[] }) {
  const { label, items } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The menu opens below the button, lined up with its right edge; where that would take it past
  // the left edge of the page (a narrow window, the button near the left), it lines up with the
  // button's left edge instead. Measured before it's painted.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) {
      return;
    }
    const { left, width } = menu.getBoundingClientRect();
    if (width > 0 && left < MENU_MARGIN) {
      menu.dataset.align = 'start';
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      itemRefs.current[active]?.focus();
    }
  }, [open, active]);

  // A click anywhere else closes the menu, like a native one.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (items.length === 0) {
    return null;
  }

  const show = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) {
      buttonRef.current?.focus();
    }
  };

  const onButtonKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      show(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      show(items.length - 1);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const last = items.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        setActive(active >= last ? 0 : active + 1);
        break;
      case 'ArrowUp':
        setActive(active <= 0 ? last : active - 1);
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(last);
        break;
      case 'Escape':
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Focus moves on to the next control, as from the button.
        setOpen(false);
        return;
      default: {
        if (event.key.length !== 1 || !/\S/.test(event.key)) {
          return;
        }
        const letter = event.key.toLowerCase();
        const order = [...items.slice(active + 1), ...items.slice(0, active + 1)];
        const match = order.find((item) => item.label.toLowerCase().startsWith(letter));
        if (!match) {
          return;
        }
        setActive(items.indexOf(match));
        break;
      }
    }
    event.preventDefault();
  };

  return (
    <div className='cf-menu'>
      <button
        ref={buttonRef}
        type='button'
        id={`${id}-button`}
        className='cf-button cf-button--icon'
        aria-label={label}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => (open ? close(false) : show(0))}
        onKeyDown={onButtonKeyDown}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={`${id}-menu`}
          role='menu'
          aria-labelledby={`${id}-button`}
          className='cf-menu__popup'
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type='button'
              role='menuitem'
              className='cf-menu__item'
              tabIndex={index === active ? 0 : -1}
              aria-haspopup={item.opensDialog ? 'dialog' : undefined}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
