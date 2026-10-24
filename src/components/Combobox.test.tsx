/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PicklistItem } from '../core/items';
import type { ComboboxProps } from './Combobox';
import { Combobox } from './Combobox';

const NAMES = ['Contoso', 'Fabrikam', 'Northwind Traders', 'Tailspin Toys', 'Wingtip Toys'];
const ITEMS: PicklistItem[] = NAMES.map((name) => ({ key: name, value: name }));

const PEOPLE: PicklistItem[] = [
  { key: 'Ana Silva\u001fana@contoso.com', value: 'Ana Silva', detail: 'ana@contoso.com' },
  { key: 'Ana Silva\u001fana.s@fabrikam.com', value: 'Ana Silva', detail: 'ana.s@fabrikam.com' },
  { key: 'Ben Ortiz\u001fben@contoso.com', value: 'Ben Ortiz', detail: 'ben@contoso.com' },
  { key: 'Chloé Martin', value: 'Chloé Martin' },
];

beforeAll(() => {
  // jsdom has no matchMedia; the control uses it to size rows for touch screens.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
});

afterEach(cleanup);

function setup(props: Partial<ComboboxProps> = {}) {
  const onSelect = vi.fn<(item: PicklistItem) => void>();
  const onRemove = vi.fn<(value: string) => void>();
  const onClear = vi.fn<() => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(
    <Combobox
      label='Customer'
      selected={['Contoso']}
      items={ITEMS}
      onSelect={onSelect}
      onRemove={onRemove}
      onClear={onClear}
      onOpenChange={onOpenChange}
      clearable
      {...props}
    />
  );
  return { onSelect, onRemove, onClear, onOpenChange, input: screen.getByRole('combobox') };
}

function optionTexts(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

/** Finds an option by its full text (value and, when there is one, its second line). */
function optionWithText(text: string): HTMLElement {
  const found = screen.getAllByRole('option').find((option) => option.textContent === text);
  if (!found) {
    throw new Error(`No option with text ${text}`);
  }
  return found;
}

/** A parent that keeps the selection, like the controller does. */
function MultiHarness(props: Partial<ComboboxProps> & { initial?: string[] }) {
  const { initial = ['Contoso'], ...rest } = props;
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <Combobox
      label='Customer'
      items={ITEMS}
      multiple
      clearable
      selected={selected}
      onSelect={(item) => setSelected((current) => [...current, item.value])}
      onRemove={(value) => setSelected((current) => current.filter((entry) => entry !== value))}
      onClear={() => setSelected([])}
      {...rest}
    />
  );
}

describe('Combobox', () => {
  it('shows the current value and opens the list with it marked', async () => {
    const { input, onOpenChange } = setup();
    expect(input).toHaveProperty('value', 'Contoso');
    expect(input.getAttribute('aria-expanded')).toBe('false');

    await userEvent.click(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getAllByRole('option')).toHaveLength(ITEMS.length);
    const active = screen.getByRole('option', { selected: true });
    expect(active.textContent).toBe('Contoso');
    expect(input.getAttribute('aria-activedescendant')).toBe(active.id);
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBeNull();
  });

  it('filters with "contains" as you type and picks with Enter', async () => {
    const { input, onSelect } = setup();
    await userEvent.click(input);
    await userEvent.keyboard('toys');
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Tailspin Toys', 'Wingtip Toys']);
    expect(options[0]?.querySelector('mark')?.textContent).toBe('Toys');

    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith({ key: 'Wingtip Toys', value: 'Wingtip Toys' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('picks an exact match typed before leaving', async () => {
    const { input, onSelect } = setup();
    await userEvent.click(input);
    await userEvent.keyboard('fabrikam');
    await userEvent.tab();
    expect(onSelect).toHaveBeenCalledWith({ key: 'Fabrikam', value: 'Fabrikam' });
  });

  it('closes on Escape without changing the value', async () => {
    const { input, onSelect } = setup();
    await userEvent.click(input);
    await userEvent.keyboard('zzz');
    expect(screen.getByText('No matches for “zzz”')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(onSelect).not.toHaveBeenCalled();
    expect(input).toHaveProperty('value', 'Contoso');
  });

  it('clears the value when the text is erased and focus leaves', async () => {
    const { input, onClear } = setup();
    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}');
    await userEvent.tab();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('describes unsaved and required states in words, not only color', () => {
    setup({ selected: ['Contoso'], tone: 'dirty' });
    expect(screen.getByRole('combobox').getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Changed, not saved yet')).toBeTruthy();
    cleanup();

    setup({ selected: [], tone: 'error', required: true });
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('placeholder')).toBe('Select… (required)');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');
  });

  it('shows loading and errors with a way to retry', async () => {
    const onRetry = vi.fn<() => void>();
    const { input } = setup({ items: null, loading: true });
    await userEvent.click(input);
    expect(screen.getByText('Loading…')).toBeTruthy();
    cleanup();

    const failing = setup({ items: null, error: 'The service had a problem (503).', onRetry });
    await userEvent.click(failing.input);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never opens when read-only', async () => {
    const { input, onOpenChange } = setup({ readOnly: true });
    await userEvent.click(input);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Combobox second line', () => {
  it('shows the second line under the value in taller rows, with the full text as a tooltip', async () => {
    const { input } = setup({ items: PEOPLE, selected: [] });
    await userEvent.click(input);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
    const first = options[0];
    expect(first?.querySelector('.rp-option__detail')?.textContent).toBe('ana@contoso.com');
    // The accessible name keeps the two lines apart.
    expect(first?.textContent).toBe('Ana Silva, ana@contoso.com');
    expect(first?.getAttribute('title')).toBe('Ana Silva\nana@contoso.com');
    expect(first?.style.height).toBe('48px');
    // An item without a second line keeps just its value.
    expect(options[3]?.textContent).toBe('Chloé Martin');
  });

  it('keeps 32 px rows when no item has a second line', async () => {
    const { input } = setup();
    await userEvent.click(input);
    expect(screen.getAllByRole('option')[0]?.style.height).toBe('32px');
    expect(document.querySelector('.rp-option__detail')).toBeNull();
  });

  it('searches the second line and highlights the match there', async () => {
    const { input, onSelect } = setup({ items: PEOPLE, selected: [] });
    await userEvent.click(input);
    await userEvent.keyboard('fabrikam');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.querySelector('.rp-option__detail mark')?.textContent).toBe('fabrikam');

    await userEvent.keyboard('{Enter}');
    // The picked row decides the item, even when another row has the same value.
    expect(onSelect).toHaveBeenCalledWith(PEOPLE[1]);
  });

  it('ranks matches in the value above matches in the second line', async () => {
    const items: PicklistItem[] = [
      { key: 'a', value: 'Support desk', detail: 'Ben Ortiz' },
      { key: 'b', value: 'Ben Ortiz', detail: 'Sales' },
    ];
    const { input } = setup({ items, selected: [] });
    await userEvent.click(input);
    await userEvent.keyboard('ben');
    expect(optionTexts()).toEqual(['Ben Ortiz, Sales', 'Support desk, Ben Ortiz']);
  });
});

describe('Combobox duplicate values with selectedKeys', () => {
  const ANA_1 = PEOPLE[0];
  const ANA_2 = PEOPLE[1];

  it('marks every row with the value when selectedKeys is omitted', async () => {
    const { input } = setup({ items: PEOPLE, multiple: true, selected: ['Ana Silva'] });
    await userEvent.click(input);
    const options = screen.getAllByRole('option', { selected: true });
    expect(options.map((option) => option.textContent)).toEqual([
      'Ana Silva, ana@contoso.com',
      'Ana Silva, ana.s@fabrikam.com',
    ]);
  });

  it('marks only the row whose key is given', async () => {
    const { input } = setup({
      items: PEOPLE,
      multiple: true,
      selected: ['Ana Silva'],
      selectedKeys: [ANA_2.key],
    });
    await userEvent.click(input);
    const options = screen.getAllByRole('option', { selected: true });
    expect(options.map((option) => option.textContent)).toEqual(['Ana Silva, ana.s@fabrikam.com']);
  });

  it('switches the pick instead of removing when a different row for the value is chosen', async () => {
    const onSelect = vi.fn<(item: PicklistItem) => void>();
    const onRemove = vi.fn<(value: string) => void>();
    render(
      <Combobox
        label='Assignee'
        items={PEOPLE}
        multiple
        selected={['Ana Silva']}
        selectedKeys={[ANA_1.key]}
        onSelect={onSelect}
        onRemove={onRemove}
      />
    );
    const input = screen.getByRole('combobox');
    await userEvent.click(input);
    await userEvent.click(optionWithText('Ana Silva, ana.s@fabrikam.com'));
    expect(onSelect).toHaveBeenCalledWith(ANA_2);
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText('Changed Ana Silva')).toBeTruthy();
  });

  it('still removes when the marked row is chosen again', async () => {
    const onSelect = vi.fn<(item: PicklistItem) => void>();
    const onRemove = vi.fn<(value: string) => void>();
    render(
      <Combobox
        label='Assignee'
        items={PEOPLE}
        multiple
        selected={['Ana Silva']}
        selectedKeys={[ANA_1.key]}
        onSelect={onSelect}
        onRemove={onRemove}
      />
    );
    const input = screen.getByRole('combobox');
    await userEvent.click(input);
    await userEvent.click(optionWithText('Ana Silva, ana@contoso.com'));
    expect(onRemove).toHaveBeenCalledWith('Ana Silva');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Combobox multiple values', () => {
  it('shows chips with remove buttons and a multi-selectable list', async () => {
    const { input, onRemove } = setup({ multiple: true, selected: ['Contoso', 'Wingtip Toys'] });
    expect(input).toHaveProperty('value', '');
    expect(input.getAttribute('placeholder')).toBeNull();
    expect(screen.getByTitle('Wingtip Toys').textContent).toBe('Wingtip Toys');
    const description = input.getAttribute('aria-describedby') ?? '';
    expect(description).not.toBe('');
    expect(screen.getByText('2 selected: Contoso, Wingtip Toys')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Wingtip Toys' }));
    expect(onRemove).toHaveBeenCalledWith('Wingtip Toys');

    await userEvent.click(input);
    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
    const selected = within(listbox).getAllByRole('option', { selected: true });
    expect(selected.map((option) => option.textContent)).toEqual(['Contoso', 'Wingtip Toys']);
    expect(within(listbox).getAllByRole('option', { selected: false })).toHaveLength(3);
  });

  it('adds with a click and keeps the list open for more', async () => {
    const { input, onSelect } = setup({ multiple: true, selected: ['Contoso'] });
    await userEvent.click(input);
    await userEvent.click(screen.getByRole('option', { name: 'Fabrikam' }));
    expect(onSelect).toHaveBeenCalledWith({ key: 'Fabrikam', value: 'Fabrikam' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('removes a selected option chosen again, with the mouse or Enter', async () => {
    const { input, onRemove, onSelect } = setup({ multiple: true, selected: ['Contoso'] });
    await userEvent.click(input);
    await userEvent.click(screen.getByRole('option', { name: 'Contoso' }));
    expect(onRemove).toHaveBeenLastCalledWith('Contoso');

    // The row stays active after the click, so Enter chooses it again.
    await userEvent.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('adds with the keyboard after filtering, and keeps the filtered list', async () => {
    const { input, onSelect } = setup({ multiple: true, selected: [] });
    await userEvent.click(input);
    await userEvent.keyboard('toys{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith({ key: 'Wingtip Toys', value: 'Wingtip Toys' });
    expect(optionTexts()).toEqual(['Tailspin Toys', 'Wingtip Toys']);
    expect(input).toHaveProperty('value', 'toys');
  });

  it('removes the last chip with Backspace in an empty text box', async () => {
    const { input, onRemove } = setup({ multiple: true, selected: ['Contoso', 'Fabrikam'] });
    await userEvent.click(input);
    await userEvent.keyboard('n{Backspace}');
    expect(onRemove).not.toHaveBeenCalled();
    await userEvent.keyboard('{Backspace}');
    expect(onRemove).toHaveBeenCalledWith('Fabrikam');
  });

  it('drops typed text instead of picking or clearing when focus leaves', async () => {
    const { input, onSelect, onClear } = setup({ multiple: true, selected: ['Contoso'] });
    await userEvent.click(input);
    await userEvent.keyboard('Fabrikam');
    await userEvent.tab();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(input).toHaveProperty('value', '');
  });

  it('clears all values', async () => {
    const { onClear } = setup({ multiple: true, selected: ['Contoso', 'Fabrikam'] });
    await userEvent.click(screen.getByRole('button', { name: 'Clear Customer' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('announces what was added and removed', async () => {
    render(<MultiHarness />);
    const input = screen.getByRole('combobox');
    await userEvent.click(input);
    await userEvent.click(screen.getByRole('option', { name: 'Fabrikam' }));
    expect(screen.getByText('Added Fabrikam. 2 selected.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Fabrikam' })).toBeTruthy();
    expect(input.getAttribute('aria-expanded')).toBe('true');

    await userEvent.keyboard('{Backspace}');
    expect(screen.getByText('Removed Fabrikam. 1 selected.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Fabrikam' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Clear Customer' }));
    expect(screen.getByText('Removed Contoso. Nothing selected.')).toBeTruthy();
  });

  it('disables unselected options and explains why when the field is full', async () => {
    const { input, onSelect, onRemove } = setup({
      multiple: true,
      selected: ['Contoso'],
      limitMessage: 'This field is full. Remove a value to add another.',
    });
    await userEvent.click(input);
    const fabrikam = screen.getByRole('option', { name: 'Fabrikam' });
    expect(fabrikam.getAttribute('aria-disabled')).toBe('true');
    const contoso = screen.getByRole('option', { name: 'Contoso' });
    expect(contoso.getAttribute('aria-disabled')).toBeNull();

    await userEvent.click(fabrikam);
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.click(contoso);
    expect(onRemove).toHaveBeenCalledWith('Contoso');

    const message = screen.getAllByText('This field is full. Remove a value to add another.');
    const footer = message.find((node) => node.closest('.rp-popup-footer'));
    expect(footer).toBeTruthy();
    expect(footer?.closest('[role="listbox"]')).toBeNull();
  });

  it('hides remove buttons when read-only', () => {
    setup({ multiple: true, readOnly: true, selected: ['Contoso', 'Fabrikam'] });
    expect(screen.getByText('Fabrikam')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear Customer' })).toBeNull();
  });
});

function namedItems(names: string[]): PicklistItem[] {
  return names.map((name) => ({ key: name, value: name }));
}

describe('Combobox streaming stability', () => {
  it('keeps the active option in view across the sort that finishes streaming', async () => {
    const names = Array.from(
      { length: 30 },
      (_unused, index) => `Item ${String(index).padStart(2, '0')}`
    );
    // Streamed in append order (reversed, for a clearly different order); the final build sorts.
    const streamedOrder = names.toReversed();
    const sortedOrder = names.toSorted((a, b) => a.localeCompare(b));

    const { rerender } = render(
      <Combobox
        label='Item'
        items={namedItems(streamedOrder)}
        selected={[]}
        loadingMore='Loading more…'
        onSelect={() => {}}
      />
    );
    const input = screen.getByRole('combobox');
    await userEvent.click(input);
    const list = screen.getByRole('listbox');

    // Make a row that isn't the one the (unfiltered) list opens to the active one, and scroll to
    // the top, so the active-option anchor and a naive top-row anchor would disagree.
    const anchorKey = streamedOrder[5];
    const oldIndex = streamedOrder.indexOf(anchorKey);
    fireEvent.pointerMove(screen.getByRole('option', { name: anchorKey }));
    list.scrollTop = 0;
    fireEvent.scroll(list);

    rerender(
      <Combobox
        label='Item'
        items={namedItems(sortedOrder)}
        selected={[]}
        loadingMore={null}
        onSelect={() => {}}
      />
    );

    const newIndex = sortedOrder.indexOf(anchorKey);
    // The row stays at the same offset within the view (here, 0 - oldIndex * rowHeight) rather
    // than jumping to the top of the view.
    expect(list.scrollTop).toBe(newIndex * 32 - oldIndex * 32);
    expect(input.getAttribute('aria-activedescendant')).toContain(`option-${newIndex}`);
  });
});

describe('Combobox footer', () => {
  it('shows loading more and a note outside the listbox', async () => {
    const { input } = setup({
      loadingMore: 'Loading more…',
      footerNote: 'Showing the first 10,000 items',
    });
    await userEvent.click(input);
    const loadingMore = screen.getByText('Loading more…');
    const note = screen.getByText('Showing the first 10,000 items');
    const listbox = screen.getByRole('listbox');
    expect(listbox.contains(loadingMore)).toBe(false);
    expect(listbox.contains(note)).toBe(false);
    expect(loadingMore.closest('[role="status"]')?.querySelector('.rp-spinner')).toBeTruthy();
    expect(input.getAttribute('aria-describedby')).toContain(note.id);
  });

  it('shows the footer even when nothing matches, and hides it when closed', async () => {
    const { input } = setup({ loadingMore: 'Loading more…' });
    expect(screen.queryByText('Loading more…')).toBeNull();
    await userEvent.click(input);
    await userEvent.keyboard('zzz');
    expect(screen.getByText('No matches for “zzz”')).toBeTruthy();
    expect(screen.getByText('Loading more…')).toBeTruthy();
  });

  it('ignores limitMessage with a single value', async () => {
    const { input } = setup({ limitMessage: 'Full' });
    await userEvent.click(input);
    expect(screen.queryByText('Full')).toBeNull();
    expect(
      screen.getByRole('option', { name: 'Fabrikam' }).getAttribute('aria-disabled')
    ).toBeNull();
  });
});

describe('Combobox message links', () => {
  const HREF = 'https://dev.azure.com/contoso/_settings/publisher.extension.rest-picklist-setup';

  it('shows a link inside the notice, named for where it leads', async () => {
    const onClick = vi.fn<(event: ReactMouseEvent<HTMLAnchorElement>) => void>((event) =>
      event.preventDefault()
    );
    const { input } = setup({
      readOnly: true,
      notice: 'Settings moved. Find them in the settings, or',
      noticeTone: 'info',
      noticeLink: {
        text: 'click here',
        hiddenText: ' to open the settings in a new tab',
        href: HREF,
        after: '.',
        onClick,
      },
    });
    const link = screen.getByRole('link', { name: 'click here to open the settings in a new tab' });
    expect(link.getAttribute('href')).toBe(HREF);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const notice = link.closest('p');
    expect(notice?.textContent).toBe('Settings moved. Find them in the settings, or click here.');
    expect(notice?.getAttribute('data-tone')).toBe('info');
    expect(input.getAttribute('aria-describedby')).toContain(notice?.id ?? 'missing');
    // Reachable with the keyboard even though the field is read-only.
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(link);
    await userEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps notices as warnings, without a link, by default', () => {
    setup({ notice: '“Zava” isn’t in the list anymore.' });
    const notice = screen.getByText('“Zava” isn’t in the list anymore.').closest('p');
    expect(notice?.getAttribute('data-tone')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a link after the error in the list', async () => {
    const onRetry = vi.fn<() => void>();
    const { input } = setup({
      items: null,
      error: 'This configuration’s secret isn’t set.',
      errorLink: { text: 'Open the settings', hiddenText: 'in a new tab', href: HREF },
      onRetry,
    });
    await userEvent.click(input);
    const alert = screen.getByRole('alert');
    const link = within(alert).getByRole('link', { name: 'Open the settings in a new tab' });
    expect(link.getAttribute('href')).toBe(HREF);
    // “Try again” can't be reached with Tab (Tab closes the list), so Enter does it, and the
    // error says so to screen readers.
    expect(alert.textContent).toBe(
      'This configuration’s secret isn’t set. Open the settings Press Enter to try again.Try again'
    );
    // The error behind the field's icon stays plain text.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('This configuration’s secret isn’t set.')).toBeTruthy();
  });
});

describe('Combobox errors and the keyboard', () => {
  it('tries again with Enter, since Tab closes the list before “Try again”', async () => {
    const onRetry = vi.fn<() => void>();
    const { input } = setup({ items: null, error: 'The service had a problem (500).', onRetry });
    await userEvent.click(input);
    expect(screen.getByRole('alert').textContent).toContain('Press Enter to try again.');
    await userEvent.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('tries again with Enter in multiple mode too', async () => {
    const onRetry = vi.fn<() => void>();
    const onSelect = vi.fn<(item: PicklistItem) => void>();
    render(
      <Combobox
        label='Customer'
        items={null}
        multiple
        selected={[]}
        error='Couldn’t reach the service.'
        onSelect={onSelect}
        onRetry={onRetry}
      />
    );
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('only closes the list when trying again can’t help', async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const { input } = setup({ items: null, error: 'Fix the settings.', onOpenChange });
    await userEvent.click(input);
    expect(screen.getByRole('alert').textContent).not.toContain('Press Enter');
    await userEvent.keyboard('{Enter}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('marks errors under the field with a circle and warnings with a triangle', () => {
    setup({ notice: 'This configuration’s secret isn’t set.', noticeTone: 'error' });
    const error = screen.getByText('This configuration’s secret isn’t set.').closest('p');
    expect(error?.getAttribute('data-tone')).toBe('error');
    expect(error?.querySelector('path[d^="M7.13"]')).toBeNull();
    cleanup();
    setup({ notice: '“Zava” isn’t in the list anymore.' });
    const warning = screen.getByText('“Zava” isn’t in the list anymore.').closest('p');
    expect(warning?.querySelector('path[d^="M7.13"]')).not.toBeNull();
  });
});
