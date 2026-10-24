import { useEffect, useMemo, useRef, useState } from 'react';
import { flattenFolders, projectNameError, type ProjectsConfig } from '../shared/projects';
import { joinPath } from '../shared/paths';
import { Icon } from './Icon';
import { useEscape } from './useEscape';

interface Props {
  config: ProjectsConfig;
  /** Names already in the Root Folder (projects and other folders). */
  existingNames: string[];
  /** Creates the project; resolves to an error message to keep the dialog open, or null on success. */
  onCreate(name: string, templateId: string): Promise<string | null>;
  onClose(): void;
}

/** New Project: a name and a template, with a live preview of the folders it will make and where. */
export function NewProjectDialog({ config, existingNames, onCreate, onClose }: Props) {
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(config.defaultTemplateId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEscape(onClose);
  useEffect(() => input.current?.focus(), []);

  const template = config.templates.find((t) => t.id === templateId) ?? config.templates[0];
  const problem = name.trim() === '' ? null : projectNameError(name, existingNames);
  const valid = name.trim() !== '' && !problem && !!template;
  const folders = useMemo(() => flattenFolders(template?.folders ?? []), [template]);
  const files = template?.files ?? [];

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const err = await onCreate(name.trim(), template.id);
    if (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form
        className="modal new-project"
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>New project</h3>
        <label className="field">
          <span className="field-label">Project name</span>
          <input ref={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="The Lost King" aria-invalid={!!problem || undefined} spellCheck={false} />
        </label>
        <div className="modal-error" role="alert">
          {problem ?? error ?? ''}
        </div>
        <label className="field">
          <span className="field-label">Template</span>
          <select value={template?.id} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
            {config.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.id === config.defaultTemplateId ? ' (default)' : ''}
              </option>
            ))}
          </select>
          {template?.description && <span className="field-hint">{template.description}</span>}
        </label>
        <div className="project-preview" aria-label="What will be created">
          <div className="preview-title">Creates</div>
          <div className="preview-path">
            <Icon name="folder" size={14} className="kind-dir" /> {valid ? joinPath(config.root, name.trim()) : joinPath(config.root, '…')}
          </div>
          {folders.length === 0 && files.length === 0 && <div className="muted small">An empty project.</div>}
          {folders.map((f) => (
            <div key={f} className="preview-row" style={{ paddingLeft: 18 + (f.split('/').length - 1) * 16 }}>
              <Icon name="folder" size={13} className="kind-dir" /> {f.split('/').pop()}
            </div>
          ))}
          {files.map((f) => (
            <div key={f.path} className="preview-row" style={{ paddingLeft: 18 + (f.path.split('/').length - 1) * 16 }}>
              <Icon name="file" size={13} className="kind-file" /> {f.path}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  );
}
