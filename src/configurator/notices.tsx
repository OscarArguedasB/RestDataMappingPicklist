import { copyText } from './clipboard';
import { downloadText } from './files';
import { Callout } from './ui';

/** A page-level message about something that just happened, shown above the tabs. */
export interface Notice {
  tone: 'success' | 'warning' | 'error' | 'info';
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

/**
 * Offers `content` as a download, and the JSON to copy instead when the browser refuses (downloads
 * can be blocked inside the Azure DevOps frame). `show` receives the notice to display.
 */
export function offerDownload(
  fileName: string,
  content: string,
  what: string,
  show: (notice: Notice) => void
): void {
  const copyInstead = {
    label: 'Copy the JSON instead',
    run: () => {
      void copyText(content).then((copied) =>
        show(
          copied
            ? { tone: 'success', title: 'Copied the JSON. Paste it into a .json file.' }
            : {
                tone: 'error',
                title: 'Couldn’t copy the JSON. Your browser blocked the clipboard.',
              }
        )
      );
    },
  };
  show(
    downloadText(fileName, content)
      ? { tone: 'success', title: `Exported ${what} as ${fileName}.`, action: copyInstead }
      : { tone: 'warning', title: 'Your browser blocked the download.', action: copyInstead }
  );
}

/** The notice area: a polite live region, so results are announced without moving focus. */
export function NoticeArea(props: { notice: Notice | null; onDismiss: () => void }) {
  const { notice } = props;
  return (
    <output className='cf-notice'>
      {notice ? (
        <Callout tone={notice.tone} title={notice.title}>
          {notice.detail ? <p>{notice.detail}</p> : null}
          <p className='cf-notice__actions'>
            {notice.action ? (
              <button type='button' className='cf-link' onClick={notice.action.run}>
                {notice.action.label}
              </button>
            ) : null}
            <button type='button' className='cf-link' onClick={props.onDismiss}>
              Dismiss
            </button>
          </p>
        </Callout>
      ) : null}
    </output>
  );
}
