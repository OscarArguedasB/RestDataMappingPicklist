import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { AlertIcon, ChevronDownIcon } from '../components/Icons';

const STORAGE_KEY = 'rest-picklist:setup:open-sections';

// Which sections are open is remembered for the browser tab only; storage can be blocked in the
// Azure DevOps frame, so every access is guarded.
function readOpenSections(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function writeOpenSection(id: string, open: boolean): void {
  try {
    const others = readOpenSections().filter((item) => item !== id);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(open ? [...others, id] : others));
  } catch {
    // Not remembered; nothing else changes.
  }
}

/**
 * An optional group of settings, closed by default. The header names it and sums up its current
 * state in one line, so the page stays short without hiding what's set.
 */
export function Collapsible(props: {
  /** Stable id used to remember the open state. */
  id: string;
  title: string;
  summary: string;
  /** Marks the summary when a setting inside has a problem. */
  attention?: boolean;
  /** The heading level: 3 for a section of the page, 4 inside a card. */
  level?: 3 | 4;
  /**
   * Opens the section when this number changes while `attention` is set, so pressing Save can
   * show the problem inside.
   */
  reveal?: number;
  children: ReactNode;
}) {
  const { id, title, summary, attention = false, level = 3, reveal = 0, children } = props;
  const [open, setOpen] = useState(() => readOpenSections().includes(id));
  const [revealed, setRevealed] = useState(reveal);
  const domId = useId();
  const panelId = `${domId}-panel`;
  const Heading = level === 4 ? 'h4' : 'h3';

  if (reveal !== revealed) {
    setRevealed(reveal);
    if (attention && !open) {
      setOpen(true);
    }
  }

  const toggle = () => {
    setOpen(!open);
    writeOpenSection(id, !open);
  };

  return (
    <section className='cf-section' data-open={open || undefined}>
      <Heading className='cf-section__heading'>
        <button
          type='button'
          id={`${domId}-button`}
          className='cf-section__toggle'
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          <span className='cf-section__text'>
            <span className='cf-section__title'>{title}</span>
            <span className='cf-section__summary' data-attention={attention || undefined}>
              {attention ? <AlertIcon /> : null}
              {attention ? <span className='rp-sr-only'>Needs attention: </span> : null}
              {summary}
            </span>
          </span>
          <span className='cf-section__chevron'>
            <ChevronDownIcon />
          </span>
        </button>
      </Heading>
      <div id={panelId} className='cf-section__panel' hidden={!open}>
        {children}
      </div>
    </section>
  );
}
