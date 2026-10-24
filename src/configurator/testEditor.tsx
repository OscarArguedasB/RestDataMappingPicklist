import { useEffect, useState } from 'react';
import type { ConfigurationDocument, PermissionSnapshot } from '../core/configurations';
import {
  canEditConfiguration,
  createConfigurationDocument,
  nameKey,
  renameConfiguration,
} from '../core/configurations';
import { toUserMessage } from '../core/errors';
import type { SecurityPolicy } from '../core/policy';
import type { ProcessSummary, SetupServices } from './services';

// A stand-in for ConfigurationEditor in the page's component tests (vi.mock('./ConfigurationEditor',
// () => import('./testEditor'))), with the same props. It edits only the name, so tests can save,
// rename, make changes and leave without depending on the real editor.

export interface TestEditorProps {
  services: SetupServices;
  policy: SecurityPolicy;
  permissions: PermissionSnapshot;
  processes: readonly ProcessSummary[];
  configurations: readonly ConfigurationDocument[];
  configuration: ConfigurationDocument | null;
  processId: string;
  onSaved: (saved: ConfigurationDocument, previousName: string | null) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onShowControls?: () => void;
}

export function ConfigurationEditor(props: TestEditorProps) {
  const { configuration, onDirtyChange } = props;
  const [base, setBase] = useState(configuration);
  const [name, setName] = useState(configuration?.name ?? '');
  const [error, setError] = useState('');
  const dirty = name !== (base?.name ?? '');
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const editable = base
    ? canEditConfiguration(props.permissions, base)
    : props.permissions.error === null;

  const save = async () => {
    try {
      const doc = base
        ? renameConfiguration(base, name)
        : createConfigurationDocument({ name, processIds: [props.processId] });
      const saved = await props.services.saveConfiguration(doc);
      setBase(saved);
      setError('');
      props.onSaved(saved, base && nameKey(base.name) !== nameKey(saved.name) ? base.name : null);
    } catch (failure) {
      setError(toUserMessage(failure));
    }
  };

  return (
    <section aria-labelledby='test-editor-title'>
      <button type='button' onClick={props.onClose}>
        ‹ Configurations
      </button>
      <h2 id='test-editor-title'>{base ? base.name : 'New configuration'}</h2>
      <p>
        {editable ? 'Editable' : 'Read only'} · opened from {props.processId} ·{' '}
        {props.configurations.length} configurations · policy version {props.policy.version}
      </p>
      <label>
        Name
        <input
          value={name}
          readOnly={!editable}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button type='button' disabled={!editable || !dirty} onClick={() => void save()}>
        Save configuration
      </button>
      {props.onShowControls ? (
        <button type='button' onClick={props.onShowControls}>
          Assign it under Controls in this process
        </button>
      ) : null}
      {error ? <p role='alert'>{error}</p> : null}
    </section>
  );
}
