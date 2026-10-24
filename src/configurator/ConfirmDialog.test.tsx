/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';

afterEach(() => {
  cleanup();
});

function confirm(busy: boolean, handlers: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog
      title='Delete “Customers”?'
      confirmLabel='Delete'
      busyLabel='Deleting…'
      danger
      busy={busy}
      onConfirm={handlers.onConfirm}
      onCancel={handlers.onCancel}
    >
      <p>Forms that use it can’t load their lists.</p>
    </ConfirmDialog>
  );
}

describe('ConfirmDialog', () => {
  it('keeps focus on the pressed button while it waits, and ignores presses meanwhile', async () => {
    const user = userEvent.setup();
    const handlers = { onConfirm: vi.fn<() => void>(), onCancel: vi.fn<() => void>() };
    const { rerender } = render(confirm(false, handlers));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // The safe choice has focus first.
    expect(document.activeElement).toBe(cancel);
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    await user.click(deleteButton);
    expect(handlers.onConfirm).toHaveBeenCalledTimes(1);

    rerender(confirm(true, handlers));
    const busy = screen.getByRole('button', { name: 'Deleting…' });
    expect(busy).toBe(deleteButton);
    // Not disabled, which would drop focus to the page behind the dialog.
    expect(busy).toHaveProperty('disabled', false);
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(busy);
    await user.click(busy);
    await user.click(cancel);
    await user.keyboard('{Escape}');
    expect(handlers.onConfirm).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).not.toHaveBeenCalled();

    rerender(confirm(false, handlers));
    expect(deleteButton.getAttribute('aria-disabled')).toBeNull();
    await user.click(cancel);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('Dialog', () => {
  it('is described by its body, or by the text it names', () => {
    const { unmount } = render(
      <Dialog title='Short' actions={null} onClose={() => undefined}>
        <p>All of it.</p>
      </Dialog>
    );
    const short = screen.getByRole('dialog', { name: 'Short' });
    expect(short.getAttribute('aria-describedby')).toBe(
      short.querySelector('.cf-dialog__body')?.id
    );
    unmount();

    render(
      <Dialog title='Long' actions={null} onClose={() => undefined} describedBy='intro'>
        <p id='intro'>What happens.</p>
        <ul>
          <li>A long plan, with warnings, that isn’t read out when it opens.</li>
        </ul>
      </Dialog>
    );
    expect(screen.getByRole('dialog', { name: 'Long' }).getAttribute('aria-describedby')).toBe(
      'intro'
    );
  });
});
