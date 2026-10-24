import type { ChangeEvent, FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PicklistItem } from '../core/items';
import { createSearchIndex, foldText, matchRanges, searchItems } from '../core/search';
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ClearIcon,
  DismissIcon,
  InfoIcon,
  WarningIcon,
} from './Icons';
import { Spinner } from './Spinner';

/** Border treatment: `dirty` is an unsaved change, `error` is required-and-empty or invalid. */
export type FieldTone = 'default' | 'dirty' | 'error';

/**
 * How the notice under the field reads: a warning (a triangle), neutral information, or an error
 * (a circle), such as a setup problem spelled out under a read-only field.
 */
export type NoticeTone = 'warning' | 'info' | 'error';

/**
 * A link at the end of a message, such as where a setup problem can be fixed. It's a real link,
 * so it can be copied or opened another way, and it opens in a new tab.
 */
export interface MessageLink {
  /** The visible text. */
  text: string;
  /** Completes the link's name for screen readers, after `text`, so it says where it leads. */
  hiddenText?: string;
  href: string;
  /** Text right after the link, such as the period that ends the sentence. */
  after?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export interface ComboboxProps {
  /** Accessible name, normally the field's display name. */
  label: string;
  /** Null while the list hasn't been loaded. */
  items: readonly PicklistItem[] | null;
  /** The selected values. Single mode uses the first one. */
  selected: readonly string[];
  /**
   * The keys of the rows actually behind `selected`, where known. Rows can share a value but
   * differ in their second line; when given, only the row whose key is listed here is marked
   * (checkmark, `aria-selected`) for that value, instead of every row with that value. A value
   * with no key listed here (not yet picked from the list, or its row isn't known) still marks
   * every row with that value, as when this prop is omitted entirely.
   */
  selectedKeys?: readonly string[];
  /** Pick several values, shown as chips before the text box. */
  multiple?: boolean;
  /** The first page is loading. */
  loading?: boolean;
  /** Footer text, with a spinner, while more pages load (for example “Loading more…”). */
  loadingMore?: string | null;
  /** Footer text under the list, for example “Showing the first 10,000 items”. */
  footerNote?: string | null;
  /**
   * Multiple values only: the field can't take more. Unselected options are disabled and this
   * message is shown in the footer (selected ones can still be removed).
   */
  limitMessage?: string | null;
  error?: string | null;
  /** A link after `error`, in the list. */
  errorLink?: MessageLink | null;
  tone?: FieldTone;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  required?: boolean;
  clearable?: boolean;
  /** Short message shown under the field, such as "this value isn't in the list". */
  notice?: string | null;
  /** Default: a warning. */
  noticeTone?: NoticeTone;
  /** A link after `notice`. */
  noticeLink?: MessageLink | null;
  onOpenChange?: (open: boolean) => void;
  /** Single: picks the item. Multiple: adds its value. */
  onSelect: (item: PicklistItem) => void;
  /** Multiple: removes a value (chip button, Backspace, or choosing a selected option again). */
  onRemove?: (value: string) => void;
  /** Clears the field (all values in multiple mode). */
  onClear?: () => void;
  onRetry?: () => void;
}

type CloseReason = 'select' | 'escape' | 'dismiss';
type RowKind = 'oneLine' | 'twoLines';

const COARSE_POINTER_QUERY = '(pointer: coarse)';
// Rows are taller when any item has a second line, so both lines fit.
const ROW_HEIGHT = {
  oneLine: { fine: 32, coarse: 44 },
  twoLines: { fine: 48, coarse: 60 },
} as const;
// Half a row peeks out at the bottom so it's obvious the list scrolls.
const VISIBLE_ROWS = {
  oneLine: { fine: 7.5, coarse: 5.5 },
  twoLines: { fine: 5.5, coarse: 4.5 },
} as const;
const OVERSCAN_ROWS = 6;

function subscribeToPointerChanges(onChange: () => void) {
  const query = window.matchMedia(COARSE_POINTER_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isCoarsePointer() {
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

// Keeps focus in the text box when clicking buttons or rows in the list.
function preventFocusLoss(event: MouseEvent) {
  event.preventDefault();
}

function parseSelection(key: string): string[] {
  const parsed: unknown = JSON.parse(key);
  return Array.isArray(parsed) ? [...new Set(parsed.map(String))] : [];
}

/**
 * The key of the option at or after `position` in a key→position map built in position order
 * (as `positions` is, from `results.forEach`). Used to find whatever was at the top of the view.
 */
function keyAtOrAfter(positions: ReadonlyMap<string, number>, position: number): string | null {
  for (const [key, at] of positions) {
    if (at >= position) {
      return key;
    }
  }
  return null;
}

/** What a screen reader hears after the selection changes in multiple mode. */
function describeSelectionChange(previous: readonly string[], next: readonly string[]): string {
  const before = new Set(previous);
  const after = new Set(next);
  const added = next.filter((value) => !before.has(value));
  const removed = previous.filter((value) => !after.has(value));
  const count = next.length === 0 ? 'Nothing selected.' : `${next.length} selected.`;
  if (added.length === 1 && removed.length === 0) {
    return `Added ${added[0]}. ${count}`;
  }
  if (removed.length === 1 && added.length === 0) {
    return `Removed ${removed[0]}. ${count}`;
  }
  return next.length === 0 ? 'Removed all values.' : count;
}

/** A message's link, after a space. */
function MessageLinkText({ link }: { link: MessageLink }) {
  const hidden = link.hiddenText?.trim();
  return (
    <>
      {' '}
      <a
        className='rp-message-link'
        href={link.href}
        target='_blank'
        rel='noopener noreferrer'
        // A label rather than visually hidden text, whose spaces some screen readers drop. It
        // starts with the visible words, so speech input finds the link by them too.
        aria-label={hidden ? `${link.text} ${hidden}` : undefined}
        onClick={link.onClick}
      >
        {link.text}
      </a>
      {link.after}
    </>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const ranges = query ? matchRanges(text, query) : [];
  if (ranges.length === 0) {
    return <>{text}</>;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    parts.push(
      <mark key={start} className='rp-mark'>
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return <>{parts}</>;
}

/**
 * An editable combobox (WAI-ARIA 1.2 pattern) with a filtered, virtualized listbox.
 * Typing filters with a case- and accent-insensitive "contains" match on the value and the
 * second line. With `multiple`, selected values are chips and the listbox is multi-selectable.
 */
export function Combobox({
  label,
  items,
  selected,
  selectedKeys,
  multiple = false,
  loading = false,
  loadingMore = null,
  footerNote = null,
  limitMessage = null,
  error = null,
  errorLink = null,
  tone = 'default',
  placeholder = 'Select…',
  readOnly = false,
  disabled = false,
  required = false,
  clearable = false,
  notice = null,
  noticeTone = 'warning',
  noticeLink = null,
  onOpenChange,
  onSelect,
  onRemove,
  onClear,
  onRetry,
}: ComboboxProps) {
  const id = useId();
  const listboxId = `${id}listbox`;
  const noticeId = `${id}notice`;
  const errorId = `${id}error`;
  const stateId = `${id}state`;
  const selectionId = `${id}selection`;
  const limitId = `${id}limit`;
  const footerNoteId = `${id}footer-note`;
  const optionId = (position: number) => `${id}option-${position}`;

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The list element that was last scrolled into place (see attachList).
  const placedListRef = useRef<HTMLDivElement | null>(null);
  // What was on screen just before this render, for the layout effect below that keeps the view
  // anchored across the one reorder that happens when streaming finishes (see its comment).
  const lastLayoutRef = useRef<{ positions: Map<string, number>; scrollTop: number } | null>(null);
  const wasLoadingMoreRef = useRef(false);

  // Parents often pass a new array with the same values on every render; keying on the contents
  // keeps the memoized lookups below from being rebuilt each time.
  const selectionKey = JSON.stringify(selected);
  const selectedValues = useMemo(() => parseSelection(selectionKey), [selectionKey]);
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const value = selectedValues[0] ?? '';

  // Parents often pass a new array with the same keys on every render too; key on its contents
  // for the same reason as `selected` above.
  const hasSelectedKeys = selectedKeys !== undefined;
  const selectedKeysKey = hasSelectedKeys ? JSON.stringify(selectedKeys) : '';
  const selectedKeySet = useMemo(
    () => (hasSelectedKeys ? new Set(parseSelection(selectedKeysKey)) : null),
    [hasSelectedKeys, selectedKeysKey]
  );
  // Values for which some loaded row's key is already known (so that value's checkmark should
  // follow that one row, rather than mark every row with the value — see `selectedKeySet` above).
  const valuesWithKnownKey = useMemo(() => {
    if (!selectedKeySet || !items) {
      return null;
    }
    const values = new Set<string>();
    for (const item of items) {
      if (selectedKeySet.has(item.key)) {
        values.add(item.value);
      }
    }
    return values;
  }, [items, selectedKeySet]);

  const isChosen = useCallback(
    (item: PicklistItem) => {
      const valueMatches = multiple ? selectedSet.has(item.value) : item.value === value;
      if (!valueMatches || !selectedKeySet) {
        return valueMatches;
      }
      if (selectedKeySet.has(item.key)) {
        return true;
      }
      // A different row for a value some other row is already known to be picked for: only that
      // known row is marked. Otherwise (no row known yet) every row with the value still is.
      return !(valuesWithKnownKey?.has(item.value) ?? false);
    },
    [multiple, selectedSet, value, selectedKeySet, valuesWithKnownKey]
  );

  const hasDetails = useMemo(() => items?.some((item) => Boolean(item.detail)) ?? false, [items]);
  const coarse = useSyncExternalStore(subscribeToPointerChanges, isCoarsePointer, () => false);
  const rowKind: RowKind = hasDetails ? 'twoLines' : 'oneLine';
  const pointer = coarse ? 'coarse' : 'fine';
  const rowHeight = ROW_HEIGHT[rowKind][pointer];
  const maxListHeight = Math.round(rowHeight * VISIBLE_ROWS[rowKind][pointer]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Multiple mode announces selection changes while the person is working in this control, and
  // stays quiet about changes made elsewhere (another field's rule, a reload).
  const [engaged, setEngaged] = useState(false);
  const [announcedSelection, setAnnouncedSelection] = useState(selectionKey);
  const [selectionMessage, setSelectionMessage] = useState('');

  const announce = (message: string) =>
    // A live region only speaks when its text changes, so a repeat gets an invisible difference.
    setSelectionMessage((current) => (current === message ? `${message} ` : message));

  // Announced from the selection actually received, not the one requested: the parent may refuse
  // a value (for example when the field would get too long) or update it asynchronously.
  if (announcedSelection !== selectionKey) {
    setAnnouncedSelection(selectionKey);
    if (multiple && engaged) {
      const change = describeSelectionChange(parseSelection(announcedSelection), selectedValues);
      announce(limitMessage ? `${change} ${limitMessage}` : change);
    }
  }

  const searchIndex = useMemo(() => (items ? createSearchIndex(items) : null), [items]);
  const results = useMemo(
    () => (searchIndex ? searchItems(searchIndex, filtering ? query : '') : []),
    [searchIndex, filtering, query]
  );
  const positions = useMemo(() => {
    const map = new Map<string, number>();
    if (items) {
      results.forEach((itemIndex, position) => map.set(items[itemIndex]?.key ?? '', position));
    }
    return map;
  }, [items, results]);
  // Where the unfiltered list opens: at the (first) selected value.
  const anchorPosition = useMemo(() => {
    if (!items || filtering) {
      return -1;
    }
    return results.findIndex((itemIndex) => {
      const item = items[itemIndex];
      return item !== undefined && isChosen(item);
    });
  }, [items, filtering, results, isChosen]);

  const total = results.length;
  const itemAt = (position: number): PicklistItem | undefined => items?.[results[position] ?? -1];
  const fallbackActive = total === 0 ? -1 : filtering ? 0 : Math.max(0, anchorPosition);
  const activeIndex =
    activeKey !== null && positions.has(activeKey)
      ? (positions.get(activeKey) ?? fallbackActive)
      : fallbackActive;
  const highlightQuery = filtering ? query.trim() : '';
  const pageSize = Math.max(1, Math.floor(maxListHeight / rowHeight) - 1);
  const editable = !readOnly && !disabled;
  const limitText = multiple && limitMessage ? limitMessage : null;

  const openList = () => {
    if (open || !editable) {
      return;
    }
    setOpen(true);
    setQuery(multiple ? '' : value);
    setFiltering(false);
    setActiveKey(null);
    setScrollTop(0);
    onOpenChange?.(true);
    if (!coarse && !multiple) {
      // Typing replaces the current value instead of appending to it.
      inputRef.current?.select();
    }
  };

  const closeList = (reason: CloseReason) => {
    if (!open) {
      return;
    }
    // Leaving with typed text picks an exact match, or clears when the text was erased. With
    // multiple values the text is just dropped: re-adding a value someone has just removed, or
    // clearing every chip, would be a nasty surprise.
    if (reason === 'dismiss' && filtering && !multiple) {
      const typed = query.trim();
      if (!typed) {
        if (clearable && value) {
          onClear?.();
        }
      } else {
        const folded = foldText(typed);
        const exact = items?.find((item) => foldText(item.value) === folded);
        if (exact !== undefined && exact.value !== value) {
          onSelect(exact);
        }
      }
    }
    setOpen(false);
    setQuery('');
    setFiltering(false);
    setActiveKey(null);
    onOpenChange?.(false);
  };

  const commit = (item: PicklistItem) => {
    onSelect(item);
    closeList('select');
  };

  const removeValue = (removed: string) => {
    setEngaged(true);
    onRemove?.(removed);
  };

  const clearAll = () => {
    if (multiple) {
      setEngaged(true);
    }
    onClear?.();
  };

  // Multiple mode: choosing an option adds it, choosing the marked one for its value removes it,
  // and the list stays open for more. Choosing an unmarked row for a value that's already picked
  // (rows can share a value but differ in their second line) switches the pick to this row
  // instead — see `selectedKeys`.
  const toggle = (item: PicklistItem) => {
    // Pin the active row: removing the first selected value would otherwise move it.
    setActiveKey(item.key);
    setEngaged(true);
    const alreadyHasValue = selectedSet.has(item.value);
    if (alreadyHasValue && isChosen(item)) {
      onRemove?.(item.value);
      return;
    }
    if (!alreadyHasValue && limitMessage) {
      announce(limitMessage);
      return;
    }
    onSelect(item);
    if (alreadyHasValue) {
      announce(`Changed ${item.value}`);
    } else if (!coarse && query) {
      // The filtered list stays for more picks; typing again starts a new search.
      inputRef.current?.select();
    }
  };

  const choose = (item: PicklistItem) => (multiple ? toggle(item) : commit(item));

  // Scrolls the list so the current value is visible whenever the list (re)appears.
  const attachList = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
      // This callback changes with the items and the selection, and React then re-attaches the
      // same element. Only a newly shown list is scrolled: more pages and new picks arrive while
      // the list is open, and it mustn't jump under the pointer.
      if (!element || element === placedListRef.current) {
        return;
      }
      placedListRef.current = element;
      element.scrollTop =
        !filtering && anchorPosition >= 0
          ? Math.max(0, anchorPosition * rowHeight - (maxListHeight - rowHeight) / 2)
          : 0;
      setScrollTop(element.scrollTop);
    },
    [filtering, anchorPosition, rowHeight, maxListHeight]
  );

  // While pages stream in, `items` only grows at the end (see the controller), so whatever's on
  // screen stays put on its own. The list is reordered exactly once, when `loadingMore` finishes
  // and the final sort replaces the streamed-in order; that reorder can move rows anywhere, so
  // without this it would look like the list jumped under the pointer. Keep the active option (or
  // failing that, whatever was at the top of the view) at the same place in the view across it.
  // It deliberately runs after every render, since it needs each render's own scrollTop and
  // positions to snapshot; the setState it makes is conditional on a real change, so it can't
  // form a render loop.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above: intentional
  useLayoutEffect(() => {
    const finalizing = wasLoadingMoreRef.current && !loadingMore;
    wasLoadingMoreRef.current = Boolean(loadingMore);
    const list = listRef.current;
    const last = lastLayoutRef.current;
    if (finalizing && list && last) {
      const anchorKey =
        (activeKey && last.positions.has(activeKey) ? activeKey : null) ??
        keyAtOrAfter(last.positions, Math.round(last.scrollTop / rowHeight));
      const oldIndex = anchorKey ? last.positions.get(anchorKey) : undefined;
      const newIndex = anchorKey ? positions.get(anchorKey) : undefined;
      if (oldIndex !== undefined && newIndex !== undefined) {
        const nextScrollTop = Math.max(
          0,
          newIndex * rowHeight + (last.scrollTop - oldIndex * rowHeight)
        );
        list.scrollTop = nextScrollTop;
        if (nextScrollTop !== scrollTop) {
          setScrollTop(nextScrollTop);
        }
      }
    }
    lastLayoutRef.current = { positions, scrollTop: list ? list.scrollTop : scrollTop };
  });

  const moveTo = (position: number) => {
    if (total === 0) {
      return;
    }
    const next = Math.min(total - 1, Math.max(0, position));
    setActiveKey(itemAt(next)?.key ?? null);
    const list = listRef.current;
    if (list) {
      const top = next * rowHeight;
      if (top < list.scrollTop) {
        list.scrollTop = top;
      } else if (top + rowHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = top + rowHeight - list.clientHeight;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!editable) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) {
          openList();
        } else if (!event.altKey) {
          moveTo(activeIndex + 1);
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) {
          closeList('escape');
        } else if (open) {
          moveTo(activeIndex - 1);
        }
        break;
      case 'PageDown':
      case 'PageUp':
        if (open) {
          event.preventDefault();
          moveTo(activeIndex + (event.key === 'PageDown' ? pageSize : -pageSize));
        }
        break;
      case 'Home':
      case 'End':
        if (open && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          moveTo(event.key === 'Home' ? 0 : total - 1);
        }
        break;
      case 'Enter': {
        event.preventDefault();
        const active = activeIndex >= 0 ? itemAt(activeIndex) : undefined;
        if (!open) {
          openList();
        } else if (!active && error && onRetry) {
          // The list's “Try again” can't be reached with Tab, which closes the list, so Enter
          // does what it does (the error says so to screen readers).
          onRetry();
        } else if (multiple) {
          if (active) {
            toggle(active);
          } else {
            closeList('dismiss');
          }
        } else if (filtering && !query.trim()) {
          closeList('dismiss');
        } else if (active) {
          commit(active);
        } else {
          closeList('dismiss');
        }
        break;
      }
      case 'Backspace': {
        const last = selectedValues[selectedValues.length - 1];
        // A held-down Backspace stops once the text is gone: each chip takes a deliberate press.
        if (multiple && !event.repeat && event.currentTarget.value === '' && last !== undefined) {
          event.preventDefault();
          removeValue(last);
        }
        break;
      }
      case 'Escape':
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          closeList('escape');
        }
        break;
      case 'Tab':
        closeList('dismiss');
        break;
      default:
        break;
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!editable) {
      return;
    }
    if (!open) {
      setOpen(true);
      onOpenChange?.(true);
    }
    setQuery(event.target.value);
    setFiltering(true);
    setActiveKey(null);
    setScrollTop(0);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  };

  const handleFocus = () => {
    if (multiple && !engaged) {
      setEngaged(true);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) {
      return;
    }
    closeList('dismiss');
    if (multiple) {
      setEngaged(false);
      setSelectionMessage('');
    }
  };

  const handleFieldMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    // Clicking the padding around the text box, or a chip, behaves like clicking the text box.
    const { target } = event;
    if (
      disabled ||
      !(target instanceof Element) ||
      target === inputRef.current ||
      target.closest('button')
    ) {
      return;
    }
    event.preventDefault();
    inputRef.current?.focus();
    openList();
  };

  const toggleList = () => {
    if (open) {
      closeList('escape');
    } else {
      inputRef.current?.focus();
      openList();
    }
  };

  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.min(
    total,
    Math.ceil((scrollTop + maxListHeight) / rowHeight) + OVERSCAN_ROWS
  );
  const renderedRows: number[] = [];
  for (let position = firstRow; position < lastRow; position++) {
    renderedRows.push(position);
  }
  // Keep the active option in the DOM so aria-activedescendant always points at something.
  if (activeIndex >= 0 && (activeIndex < firstRow || activeIndex >= lastRow)) {
    renderedRows.push(activeIndex);
  }

  const renderOption = (position: number) => {
    const item = itemAt(position);
    if (!item) {
      return null;
    }
    const active = position === activeIndex;
    const chosen = isChosen(item);
    const unavailable = limitText !== null && !chosen;
    let className = 'rp-option';
    if (active) {
      className += ' is-active';
    }
    if (chosen) {
      className += multiple ? ' is-selected' : ' is-current';
    }
    const valueLine = (
      <span className='rp-option__label'>
        <HighlightedText text={item.value} query={highlightQuery} />
      </span>
    );
    // Options aren't focusable on purpose: focus stays in the text box and the keyboard reaches
    // options through aria-activedescendant (the WAI-ARIA combobox pattern).
    return (
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus
      <div
        key={item.key}
        id={optionId(position)}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <option> can't be styled or virtualized
        role='option'
        // Single: the active option (the combobox pattern). Multiple: whether it's picked.
        aria-selected={multiple ? chosen : active}
        aria-disabled={unavailable || undefined}
        aria-setsize={total}
        aria-posinset={position + 1}
        className={className}
        style={{ top: position * rowHeight, height: rowHeight }}
        title={item.detail ? `${item.value}\n${item.detail}` : item.value}
        onPointerMove={() => {
          if (!active) {
            setActiveKey(item.key);
          }
        }}
        onClick={() => choose(item)}
      >
        {multiple ? (
          <span className='rp-option__box' aria-hidden='true'>
            {chosen ? <CheckIcon /> : null}
          </span>
        ) : null}
        {hasDetails ? (
          <span className='rp-option__text'>
            {valueLine}
            {item.detail ? (
              <>
                {/* Keeps the two lines apart in the option's accessible name. */}
                <span className='rp-sr-only'>, </span>
                <span className='rp-option__detail'>
                  <HighlightedText text={item.detail} query={highlightQuery} />
                </span>
              </>
            ) : null}
          </span>
        ) : (
          valueLine
        )}
        {!multiple && chosen ? (
          <span className='rp-option__check'>
            <CheckIcon />
          </span>
        ) : null}
      </div>
    );
  };

  const showList = open && items !== null && total > 0;
  const showClear =
    clearable && editable && (multiple ? selectedValues.length > 0 : !open && value !== '');
  const showErrorBadge = !loading && Boolean(error) && !open;
  // While the open list shows its own "Loading…" row, a second spinner would be noise.
  const showSpinner = loading && !(open && items === null);
  const showFooter = open && items !== null && Boolean(loadingMore || limitText || footerNote);
  // States are never conveyed by color alone: unsaved gets a dot, required gets words.
  const unsaved = tone === 'dirty';
  const needsValue = tone === 'error' && selectedValues.length === 0;
  const stateText = needsValue ? 'Required' : unsaved ? 'Changed, not saved yet' : '';
  const describedBy =
    [
      notice ? noticeId : '',
      showErrorBadge ? errorId : '',
      stateText ? stateId : '',
      multiple && selectedValues.length > 0 ? selectionId : '',
      showFooter && limitText ? limitId : '',
      showFooter && footerNote ? footerNoteId : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  let announcement = '';
  // While more pages stream in the count would change (and be spoken) on its own; it's announced
  // once loading finishes.
  if (open && items !== null && filtering && !loadingMore) {
    announcement =
      total === 0 ? 'No matches' : `${total} ${total === 1 ? 'match' : 'matches'} available`;
  }

  const input = (
    <input
      ref={inputRef}
      className='rp-input'
      type='text'
      role='combobox'
      aria-label={label}
      aria-haspopup='listbox'
      aria-expanded={open}
      aria-controls={showList ? listboxId : undefined}
      aria-autocomplete='list'
      aria-activedescendant={showList && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      aria-invalid={tone === 'error' ? true : undefined}
      aria-required={required ? true : undefined}
      aria-busy={loading ? true : undefined}
      aria-describedby={describedBy}
      autoComplete='off'
      autoCorrect='off'
      autoCapitalize='none'
      spellCheck={false}
      enterKeyHint='done'
      placeholder={
        readOnly || (multiple && selectedValues.length > 0)
          ? undefined
          : needsValue
            ? `${placeholder} (required)`
            : placeholder
      }
      title={multiple || open || !value ? undefined : value}
      readOnly={readOnly}
      disabled={disabled}
      value={multiple || open ? query : value}
      onChange={handleChange}
      onClick={openList}
      onKeyDown={handleKeyDown}
    />
  );

  return (
    <div
      ref={rootRef}
      className='rp-combobox'
      data-open={open || undefined}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- mouse-only convenience; the input handles the keyboard */}
      <div
        className='rp-field'
        data-tone={tone}
        data-multiple={multiple || undefined}
        data-readonly={readOnly || undefined}
        data-disabled={disabled || undefined}
        onMouseDown={handleFieldMouseDown}
      >
        {multiple ? (
          <div className='rp-values'>
            {selectedValues.map((chip) => (
              <span
                key={chip}
                className={editable ? 'rp-chip' : 'rp-chip rp-chip--static'}
                title={chip}
              >
                <span className='rp-chip__text'>{chip}</span>
                {editable ? (
                  // Not a tab stop, like the other buttons in the field: the keyboard removes
                  // values with Backspace or by choosing them again in the list.
                  <button
                    type='button'
                    className='rp-chip__remove'
                    aria-label={`Remove ${chip}`}
                    title='Remove'
                    tabIndex={-1}
                    onMouseDown={preventFocusLoss}
                    onClick={() => removeValue(chip)}
                  >
                    <DismissIcon />
                  </button>
                ) : null}
              </span>
            ))}
            {input}
          </div>
        ) : (
          input
        )}
        <div className='rp-accessories'>
          {showSpinner ? <Spinner /> : null}
          {unsaved && !showSpinner ? (
            <span className='rp-unsaved-dot' title='Not saved yet' aria-hidden='true' />
          ) : null}
          {showErrorBadge ? (
            <span className='rp-status-icon' title={error ?? undefined}>
              <AlertIcon />
              <span id={errorId} className='rp-sr-only'>
                {error}
              </span>
            </span>
          ) : null}
          {showClear ? (
            <button
              type='button'
              className='rp-icon-button rp-clear'
              aria-label={`Clear ${label}`}
              title={multiple ? 'Clear all' : 'Clear'}
              tabIndex={-1}
              onMouseDown={preventFocusLoss}
              onClick={clearAll}
            >
              <ClearIcon />
            </button>
          ) : null}
          {readOnly ? null : (
            <button
              type='button'
              className='rp-icon-button rp-chevron'
              aria-label={open ? 'Close list' : 'Open list'}
              tabIndex={-1}
              disabled={disabled}
              onMouseDown={preventFocusLoss}
              onClick={toggleList}
            >
              <ChevronDownIcon />
            </button>
          )}
        </div>
      </div>

      {open ? (
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- only keeps focus in the input
        <div className='rp-popup' onMouseDown={preventFocusLoss}>
          {error ? (
            <div className='rp-popup-status rp-popup-status--error' role='alert'>
              <AlertIcon />
              <span className='rp-popup-status__text'>
                {error}
                {errorLink ? <MessageLinkText link={errorLink} /> : null}
                {onRetry ? <span className='rp-sr-only'> Press Enter to try again.</span> : null}
              </span>
              {onRetry ? (
                <button type='button' className='rp-link-button' onClick={onRetry}>
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
          {items === null && !error ? (
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a flex container, not form output
            <div className='rp-popup-status' role='status'>
              <Spinner />
              <span>Loading…</span>
            </div>
          ) : null}
          {showList ? (
            <div
              ref={attachList}
              id={listboxId}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <select> can't filter or virtualize
              role='listbox'
              aria-label={label}
              aria-multiselectable={multiple || undefined}
              className='rp-listbox'
              style={{ height: Math.min(total * rowHeight, maxListHeight) }}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
              <div className='rp-listbox__canvas' style={{ height: total * rowHeight }}>
                {renderedRows.map(renderOption)}
              </div>
            </div>
          ) : null}
          {open && items !== null && total === 0 && !error ? (
            <div className='rp-popup-status'>
              {filtering && query.trim()
                ? `No matches for “${query.trim()}”`
                : 'No items available.'}
            </div>
          ) : null}
          {showFooter ? (
            // Outside the listbox: only options belong in it.
            <div className='rp-popup-footer'>
              {loadingMore ? (
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a flex container, not form output
                <div className='rp-popup-footer__row' role='status'>
                  <Spinner />
                  <span>{loadingMore}</span>
                </div>
              ) : null}
              {limitText ? (
                <div id={limitId} className='rp-popup-footer__row rp-popup-footer__row--limit'>
                  <WarningIcon />
                  <span>{limitText}</span>
                </div>
              ) : null}
              {footerNote ? (
                <div id={footerNoteId} className='rp-popup-footer__row'>
                  {footerNote}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p
          id={noticeId}
          className='rp-notice'
          data-tone={noticeTone === 'warning' ? undefined : noticeTone}
        >
          {noticeTone === 'info' ? (
            <InfoIcon />
          ) : noticeTone === 'error' ? (
            <AlertIcon />
          ) : (
            <WarningIcon />
          )}
          <span>
            {notice}
            {noticeLink ? <MessageLinkText link={noticeLink} /> : null}
          </span>
        </p>
      ) : null}
      {stateText ? (
        <span id={stateId} className='rp-sr-only'>
          {stateText}
        </span>
      ) : null}
      {multiple && selectedValues.length > 0 ? (
        <span id={selectionId} className='rp-sr-only'>
          {`${selectedValues.length} selected: ${selectedValues.join(', ')}`}
        </span>
      ) : null}
      <div className='rp-sr-only' aria-live='polite'>
        {announcement}
      </div>
      {multiple ? (
        <div className='rp-sr-only' aria-live='polite'>
          {selectionMessage}
        </div>
      ) : null}
    </div>
  );
}
