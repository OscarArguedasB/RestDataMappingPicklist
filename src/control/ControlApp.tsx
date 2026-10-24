import type { MouseEvent } from 'react';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FieldTone, MessageLink, NoticeTone } from '../components/Combobox';
import { Combobox } from '../components/Combobox';
import type { PicklistController, PicklistState } from './controller';
import { LIMIT_MESSAGE } from './controller';

interface ControlAppProps {
  controller: PicklistController;
  /** Receives the height the control needs, so the host frame can grow with the list and chips. */
  onResize: (height: number) => void;
}

const counts = new Intl.NumberFormat();

/**
 * What a control without a configuration or settings of its own says, before its link. The
 * process editor's Options tab says the same (see azure-devops-extension.json).
 */
export const MOVED_MESSAGE =
  'API configuration has moved. You can find it under Organization settings › Extensions › REST Picklist';

/** Setup problems are for a form user to notice, but only an administrator can fix them. */
const ADMINISTRATOR_NEXT_STEP =
  'Ask your Azure DevOps administrator to update this field’s settings.';

// Some messages already say to ask an administrator, such as a secret that isn't set, or a host
// that only a Project Collection Administrator can allow.
const ASKS_ADMINISTRATOR = /\bask (?:an?|your)\b[^.]*\badministrator\b/i;

function withNextStep(message: string): string {
  return ASKS_ADMINISTRATOR.test(message) ? message : `${message} ${ADMINISTRATOR_NEXT_STEP}`;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The picked values that aren't in the list, when that can be told for sure. */
function missingValues(state: PicklistState, available: ReadonlySet<string> | null): string[] {
  // While pages arrive, or when the list was cut short, a value may simply not be loaded.
  if (!available || state.loadingMore || state.truncated) {
    return [];
  }
  return state.selected.filter((value) => !available.has(value.trim()));
}

function notInListNotice(state: PicklistState, missing: readonly string[]): string | null {
  const [first] = missing;
  if (first === undefined) {
    return null;
  }
  const custom = state.notFoundMessage;
  if (!state.multiple) {
    return custom || `“${first}” isn’t in the list anymore.`;
  }
  const list = missing.map((value) => `“${value}”`).join(', ');
  if (custom) {
    return `${custom} (${list})`;
  }
  return missing.length === 1
    ? `${list} isn’t in the list anymore.`
    : `These values aren’t in the list anymore: ${list}.`;
}

/** A link to the settings page, opened in a new tab through Azure DevOps when it can. */
function settingsLink(
  controller: PicklistController,
  href: string,
  text: string,
  hiddenText: string,
  after?: string
): MessageLink {
  return {
    text,
    hiddenText,
    href,
    after,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      // Clicks with a modifier key open the link however the browser does that.
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }
      if (controller.openSettingsPage(href)) {
        event.preventDefault();
      }
    },
  };
}

export function ControlApp({ controller, onResize }: ControlAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);

  // Chips wrapping onto new lines, messages and the open list all change the height.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }
    const report = () => onResize(Math.ceil(root.getBoundingClientRect().height));
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, [onResize]);

  const available = useMemo(
    () => (state.items ? new Set(state.items.map((item) => item.value.trim())) : null),
    [state.items]
  );

  const empty = state.selected.length === 0;
  const requiredEmpty = empty && (state.required || state.ruleInvalid);
  let tone: FieldTone = 'default';
  if (state.ruleInvalid || requiredEmpty) {
    tone = 'error';
  } else if (!sameValues(state.selected, state.savedSelected)) {
    tone = 'dirty';
  }

  let error: string | null;
  let errorLink: MessageLink | null = null;
  let notice: string | null;
  let noticeLink: MessageLink | null = null;
  let noticeTone: NoticeTone = 'warning';
  if (state.moved) {
    // Nothing anyone filling in the form did, and nothing wrong with the field: information, with
    // the user's own words for the link. Its hidden text says where it leads.
    error = null;
    noticeTone = 'info';
    if (state.settingsUrl) {
      notice = `${MOVED_MESSAGE}, or`;
      noticeLink = settingsLink(
        controller,
        state.settingsUrl,
        'click here',
        ' to open REST Picklist settings in a new tab',
        '.'
      );
    } else {
      notice = `${MOVED_MESSAGE}.`;
    }
  } else {
    // Only an administrator can act on a setup problem; say so wherever it's shown to someone
    // filling in the form. The core message itself is left alone: the setup page shows it too,
    // to the administrator who can actually fix it.
    const configError = state.configError ? withNextStep(state.configError) : null;
    const link =
      configError && state.settingsUrl
        ? settingsLink(
            controller,
            state.settingsUrl,
            'Open REST Picklist settings',
            ' in a new tab'
          )
        : null;
    // A read-only control can't open its list, so a setup problem is spelled out under the field
    // instead of hiding behind the error icon.
    const blocked = state.readOnly && state.configError !== null;
    error = blocked ? null : (configError ?? state.error);
    errorLink = blocked ? null : link;
    notice = blocked
      ? configError
      : (state.notice ?? notInListNotice(state, missingValues(state, available)));
    noticeLink = blocked ? link : null;
    if (blocked) {
      // Still an error under the field, as it is in the open list and on the setup page.
      noticeTone = 'error';
    }
  }
  const footerNote = state.truncated
    ? `Showing the first ${counts.format(state.loadedCount)} items`
    : null;

  return (
    <div ref={rootRef} className='rp-control'>
      <Combobox
        label={state.fieldLabel || 'Value'}
        items={state.items}
        selected={state.selected}
        selectedKeys={state.pickedKeys}
        multiple={state.multiple}
        loading={!state.ready || state.status === 'loading'}
        loadingMore={
          state.loadingMore ? `Loading more… ${counts.format(state.loadedCount)} so far` : null
        }
        footerNote={footerNote}
        limitMessage={state.limitReached ? LIMIT_MESSAGE : null}
        error={error}
        errorLink={errorLink}
        tone={tone}
        required={state.required || requiredEmpty}
        readOnly={state.readOnly}
        disabled={!state.ready}
        clearable={!state.required}
        notice={notice}
        noticeTone={noticeTone}
        noticeLink={noticeLink}
        onOpenChange={controller.setListOpen}
        onSelect={controller.select}
        onRemove={controller.remove}
        onClear={controller.clear}
        // Setup problems can't be fixed by trying again.
        onRetry={state.configError || state.moved ? undefined : controller.retry}
      />
    </div>
  );
}
