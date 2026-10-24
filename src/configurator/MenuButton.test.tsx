/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuButton } from './MenuButton';

afterEach(cleanup);

function renderMenu() {
  const chosen = vi.fn<(id: string) => void>();
  render(
    <>
      <MenuButton
        label='More actions for Customers API'
        items={['Duplicate', 'Share…', 'Export', 'Delete'].map((label) => ({
          id: label,
          label,
          opensDialog: label.endsWith('…'),
          onSelect: () => chosen(label),
        }))}
      />
      <button type='button'>Next</button>
    </>
  );
  return { chosen, button: screen.getByRole('button', { name: 'More actions for Customers API' }) };
}

describe('MenuButton', () => {
  it('opens a menu with the first item focused and closes with Escape', async () => {
    const user = userEvent.setup();
    const { button } = renderMenu();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'More actions for Customers API' });
    expect(menu).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBe(document.activeElement);
    expect(screen.getByRole('menuitem', { name: 'Share…' }).getAttribute('aria-haspopup')).toBe(
      'dialog'
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toBe(document.activeElement);
  });

  it('moves with the arrow keys, Home, End and letters, and runs the chosen item', async () => {
    const user = userEvent.setup();
    const { chosen, button } = renderMenu();
    button.focus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBe(document.activeElement);
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBe(document.activeElement);
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBe(document.activeElement);
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBe(document.activeElement);
    await user.keyboard('e');
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBe(document.activeElement);
    await user.keyboard('{Enter}');
    expect(chosen).toHaveBeenCalledWith('Export');
    expect(screen.queryByRole('menu')).toBeNull();
    // Focus goes back to the button, so a dialog the item opens returns there too.
    expect(button).toBe(document.activeElement);
  });

  it('closes when focus or a click goes elsewhere', async () => {
    const user = userEvent.setup();
    const { chosen, button } = renderMenu();
    await user.click(button);
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(button);
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(chosen).not.toHaveBeenCalled();
  });
});

/** Where the open menu is measured, as if laid out that far from the left edge. */
function placeMenuAt(left: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.getAttribute('role') === 'menu'
      ? DOMRect.fromRect({ x: left, y: 40, width: 180, height: 140 })
      : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  });
}

describe('MenuButton near the left edge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens to the right of its button when it would leave the page', async () => {
    const user = userEvent.setup();
    placeMenuAt(-90);
    const { button } = renderMenu();
    await user.click(button);
    expect(screen.getByRole('menu').dataset.align).toBe('start');
    // Closed and opened again, it's measured again.
    await user.keyboard('{Escape}');
    vi.restoreAllMocks();
    placeMenuAt(120);
    await user.click(button);
    expect(screen.getByRole('menu').dataset.align).toBeUndefined();
  });
});
