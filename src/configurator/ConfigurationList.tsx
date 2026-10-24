import { useId, useState } from 'react';
import type { ConfigurationDocument } from '../core/configurations';
import { quoteName } from '../core/configurations';
import { configurationProblems, sharingLine, statusSentence } from './configurationStatus';
import type { MenuItem } from './MenuButton';
import { MenuButton } from './MenuButton';
import { IssueMessage } from './ui';

/**
 * Configurations as rows: the name, its former names, a status line that reads like a sentence,
 * problems with an icon and words, and who it's shared with. One visible action (Edit, or View
 * when read-only) and the rest in a “More actions” menu. Rows aren't colored.
 */
export function ConfigurationList(props: {
  /** Names the list for screen readers, like “Configurations in Contoso Agile”. */
  label: string;
  configurations: readonly ConfigurationDocument[];
  processName: (processId: string) => string | undefined;
  /** Controls using each one; null while they're still being counted. */
  usage: (doc: ConfigurationDocument) => number | null;
  canEdit: (doc: ConfigurationDocument) => boolean;
  /** Omit to leave out the Edit / View button. */
  onEdit?: (doc: ConfigurationDocument) => void;
  menu: (doc: ConfigurationDocument) => MenuItem[];
}) {
  const id = useId();
  // Certificate warnings count days from when the list was shown.
  const [now] = useState(() => new Date());
  return (
    <ul className='cf-config-list' aria-label={props.label}>
      {props.configurations.map((doc, index) => {
        const problems = configurationProblems(doc, now);
        const editable = props.canEdit(doc);
        return (
          <li key={doc.id} className='cf-config'>
            <div className='cf-config__main'>
              <h3 className='cf-config__name'>{doc.name}</h3>
              {doc.aliases.length > 0 ? (
                <p className='cf-config__aliases'>
                  Also answers to {doc.aliases.map((alias) => quoteName(alias)).join(', ')}
                </p>
              ) : null}
              <p className='cf-config__status'>{statusSentence(doc, props.usage(doc), now)}</p>
              {problems.map((problem, position) => (
                <IssueMessage
                  key={problem.message}
                  id={`${id}-${index}-problem-${position}`}
                  issue={problem}
                />
              ))}
              <p className='cf-config__meta'>{sharingLine(doc, props.processName, now)}</p>
            </div>
            <div className='cf-config__actions'>
              {props.onEdit ? (
                <button
                  type='button'
                  className='cf-button'
                  aria-label={`${editable ? 'Edit' : 'View'} ${doc.name}`}
                  onClick={() => props.onEdit?.(doc)}
                >
                  {editable ? 'Edit' : 'View'}
                </button>
              ) : null}
              <MenuButton label={`More actions for ${doc.name}`} items={props.menu(doc)} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
