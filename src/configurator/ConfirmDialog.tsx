import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Spinner } from '../components/Spinner';
import { Dialog } from './Dialog';
import { Callout } from './ui';

/**
 * Asks before something that can't be undone, such as deleting a configuration. The safe choice
 * leads and has focus, so Enter never confirms by accident; Escape cancels. While `busy`, both
 * buttons wait (aria-disabled, so the focused one keeps focus) and Escape does nothing.
 */
export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  /** A verb naming the result, like “Delete”. */
  confirmLabel: string;
  /** Shown while it runs, like “Deleting…”. */
  busyLabel: string;
  cancelLabel?: string;
  /** Red confirm button, for deleting and removing. */
  danger?: boolean;
  busy?: boolean;
  /** Why the last attempt failed. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { busy = false } = props;
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      role='alertdialog'
      title={props.title}
      busy={busy}
      initialFocus={() => cancelRef.current}
      returnFocus={props.returnFocus}
      onClose={props.onCancel}
      actions={
        <>
          <button
            ref={cancelRef}
            type='button'
            className='cf-button cf-button--busy'
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : props.onCancel}
          >
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type='button'
            className={
              props.danger
                ? 'cf-button cf-button--primary cf-button--danger-fill cf-button--busy'
                : 'cf-button cf-button--primary cf-button--busy'
            }
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : props.onConfirm}
          >
            {busy ? <Spinner /> : null}
            {busy ? props.busyLabel : props.confirmLabel}
          </button>
        </>
      }
    >
      {props.children}
      {props.error ? <Callout tone='error' role='alert' title={props.error} /> : null}
    </Dialog>
  );
}
