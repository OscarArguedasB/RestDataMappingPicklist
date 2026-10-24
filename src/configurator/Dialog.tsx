import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog. Everything behind it is made inert while it's open, focus moves into it (to
 * `initialFocus`, else the first control), Tab stays inside, Escape closes it, and focus goes back
 * to where it was — or to `returnFocus()` when that element is gone (say, a removed row).
 */
export function Dialog(props: {
  title: string;
  /** alertdialog for confirmations of something that can't be undone. */
  role?: 'dialog' | 'alertdialog';
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  /** While true, Escape doesn't close (say, during a request). */
  busy?: boolean;
  /** Wide: for a dialog that lists a plan or a file's contents. */
  size?: 'default' | 'wide';
  initialFocus?: () => HTMLElement | null;
  returnFocus?: () => HTMLElement | null;
  /**
   * The id of the text that describes the dialog, read out when it opens. Default: the whole
   * body, which suits short dialogs; a long one (a plan, a file's contents) names its first
   * paragraph instead.
   */
  describedBy?: string;
}) {
  const { title, role = 'dialog', children, actions, size = 'default' } = props;
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // The dialog renders into its own element at the end of <body>, so the page can be made inert.
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'cf-dialog-host';
    return element;
  });
  // The latest props, read by the listeners set up once per opening.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return undefined;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnFocus = latest.current.returnFocus;
    document.body.appendChild(host);
    const inertElements = [...document.body.children].filter(
      (element): element is HTMLElement =>
        element !== host && element instanceof HTMLElement && !element.hasAttribute('inert')
    );
    for (const element of inertElements) {
      element.setAttribute('inert', '');
    }
    const target =
      latest.current.initialFocus?.() ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (!latest.current.busy) {
          latest.current.onClose();
        }
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', onKeyDown);

    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      for (const element of inertElements) {
        element.removeAttribute('inert');
      }
      host.remove();
      const back = previous?.isConnected ? previous : (returnFocus?.() ?? null);
      back?.focus();
    };
  }, [host]);

  return createPortal(
    <div className='cf-dialog-backdrop'>
      <div
        ref={panelRef}
        role={role}
        aria-modal='true'
        aria-labelledby={`${id}-title`}
        aria-describedby={props.describedBy ?? `${id}-body`}
        className={size === 'wide' ? 'cf-dialog cf-dialog--wide' : 'cf-dialog'}
        tabIndex={-1}
      >
        <h2 id={`${id}-title`} className='cf-dialog__title'>
          {title}
        </h2>
        <div id={`${id}-body`} className='cf-dialog__body'>
          {children}
        </div>
        <div className='cf-dialog__actions'>{actions}</div>
      </div>
    </div>,
    host
  );
}
