import { useState } from 'react';
import type { AppDefaults } from '../shared/appDefaults';
import { defaultTemplates, templateErrors, type ProjectTemplate, type ProjectsConfig } from '../shared/projects';
import { DefaultsEditor } from './DefaultsEditor';
import { FolderTreeEditor } from './FolderTreeEditor';
import { Field, TextArea } from './formParts';
import { Icon } from './Icon';

/** The Projects settings being edited (saved with the rest of Settings). */
export interface ProjectsDraft {
  rootFolder: string | null;
  templates: ProjectTemplate[];
  defaultTemplateId: string;
  reopenLast: boolean;
  /** When the Root Folder changes: also move the existing projects into the new one. */
  moveProjects: boolean;
}

interface Props {
  config: ProjectsConfig;
  draft: ProjectsDraft;
  setDraft(d: ProjectsDraft): void;
  app: AppDefaults;
  /** Projects currently in the Root Folder (for the "move them" choice). */
  projectCount: number;
}

const newId = (name: string, taken: string[]) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'template';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
};

/** Settings → Projects: the Root Folder and the project templates. */
export function TemplateEditor({ config, draft, setDraft, app, projectCount }: Props) {
  const [selected, setSelected] = useState(draft.defaultTemplateId);
  const t = draft.templates.find((x) => x.id === selected) ?? draft.templates[0];
  const root = draft.rootFolder ?? config.defaultRoot;
  const changedRoot = root !== config.root;

  const setTemplates = (templates: ProjectTemplate[], patch: Partial<ProjectsDraft> = {}) => setDraft({ ...draft, templates, ...patch });
  const setT = (patch: Partial<ProjectTemplate>) => setTemplates(draft.templates.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
  const errors = templateErrors(t);

  const chooseRoot = async () => {
    const p = await window.mdedit.pickFolder();
    if (p) setDraft({ ...draft, rootFolder: p === config.defaultRoot ? null : p });
  };

  return (
    <div className="projects-settings">
      <section>
        <h4>Root Folder</h4>
        <p className="muted small">Your projects live here, one folder each. Anything you can do in File Explorer still works.</p>
        <div className="inline">
          <code className="path root-path">{root}</code>
          <button type="button" onClick={() => void chooseRoot()}>
            Change…
          </button>
          {draft.rootFolder !== null && (
            <button type="button" onClick={() => setDraft({ ...draft, rootFolder: null, moveProjects: false })}>
              Use the default
            </button>
          )}
          <button type="button" onClick={() => window.mdedit.reveal(config.root)} disabled={!config.rootExists}>
            Show in Explorer
          </button>
        </div>
        {!config.rootExists && <p className="warn-text small">This folder doesn’t exist yet; it is created when you save or make your first project.</p>}
        {changedRoot && (
          <div className="banner info" role="status">
            <div>
              New Root Folder: <strong>{root}</strong>
            </div>
            {projectCount > 0 ? (
              <>
                <label className="toggle">
                  <input type="radio" name="move" checked={!draft.moveProjects} onChange={() => setDraft({ ...draft, moveProjects: false })} />
                  <span>Just use the new folder (your {projectCount} project{projectCount === 1 ? '' : 's'} stay where they are and won’t be listed)</span>
                </label>
                <label className="toggle">
                  <input type="radio" name="move" checked={draft.moveProjects} onChange={() => setDraft({ ...draft, moveProjects: true })} />
                  <span>Move my {projectCount} project{projectCount === 1 ? '' : 's'} to the new folder</span>
                </label>
              </>
            ) : (
              <span className="muted small">No projects to move.</span>
            )}
          </div>
        )}
        <Toggle2 label="Reopen the project I was working on when the app starts" checked={draft.reopenLast} onChange={(v) => setDraft({ ...draft, reopenLast: v })} />
      </section>

      <section>
        <h4>Project templates</h4>
        <p className="muted small">A template says which folders (and starter files and defaults) a new project gets. Changing a template never changes projects that already exist.</p>
        <div className="template-layout">
          <div className="template-list" role="listbox" aria-label="Templates">
            {draft.templates.map((x) => (
              <button key={x.id} type="button" role="option" aria-selected={x.id === t.id} className={'template-item' + (x.id === t.id ? ' active' : '')} onClick={() => setSelected(x.id)}>
                <span className="template-name">{x.name || '(unnamed)'}</span>
                {x.id === draft.defaultTemplateId && <span className="chip">default</span>}
              </button>
            ))}
            <div className="template-actions">
              <button
                type="button"
                title="New template"
                onClick={() => {
                  const id = newId('New template', draft.templates.map((x) => x.id));
                  setTemplates([...draft.templates, { id, name: 'New template', description: '', folders: [], files: [], chapterLevel: null, book: null }]);
                  setSelected(id);
                }}
              >
                <Icon name="plus" size={14} /> New
              </button>
              <button
                type="button"
                title="Duplicate this template"
                onClick={() => {
                  const id = newId(t.name + ' copy', draft.templates.map((x) => x.id));
                  setTemplates([...draft.templates, { ...structuredClone(t), id, name: `${t.name} copy` }]);
                  setSelected(id);
                }}
              >
                Duplicate
              </button>
              <button
                type="button"
                title="Delete this template"
                disabled={draft.templates.length <= 1}
                onClick={() => {
                  const rest = draft.templates.filter((x) => x.id !== t.id);
                  setTemplates(rest, { defaultTemplateId: draft.defaultTemplateId === t.id ? rest[0].id : draft.defaultTemplateId });
                  setSelected(rest[0].id);
                }}
              >
                Delete
              </button>
              <button type="button" disabled={draft.defaultTemplateId === t.id} onClick={() => setDraft({ ...draft, defaultTemplateId: t.id })}>
                Make default
              </button>
              <button
                type="button"
                className="ghost"
                title="Put the built-in templates back (your own are kept)"
                onClick={() => {
                  const mine = draft.templates.filter((x) => !defaultTemplates().some((d) => d.id === x.id));
                  setTemplates([...defaultTemplates(), ...mine]);
                  setSelected('novel');
                }}
              >
                Reset built-ins
              </button>
            </div>
          </div>

          <div className="template-detail">
            <Field label="Template name" value={t.name} onChange={(v) => setT({ name: v })} required />
            <TextArea label="Description" rows={2} value={t.description} onChange={(v) => setT({ description: v })} hint="Shown when you pick this template for a new project." />
            <h5>Folders</h5>
            <FolderTreeEditor nodes={t.folders} onChange={(folders) => setT({ folders })} />
            <h5>Starter files</h5>
            <p className="muted small">Markdown files created in every new project (their folders are created too).</p>
            {t.files.map((f, i) => (
              <div className="starter-file" key={i}>
                <div className="inline">
                  <input
                    className="grow"
                    aria-label="Starter file path"
                    placeholder="Manuscript/Draft.md"
                    value={f.path}
                    onChange={(e) => setT({ files: t.files.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })}
                  />
                  <button type="button" aria-label="Remove starter file" onClick={() => setT({ files: t.files.filter((_, j) => j !== i) })}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <textarea
                  aria-label="Starter file contents"
                  rows={2}
                  value={f.content}
                  onChange={(e) => setT({ files: t.files.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)) })}
                />
              </div>
            ))}
            <button type="button" className="add-row" onClick={() => setT({ files: [...t.files, { path: '', content: '' }] })}>
              <Icon name="plus" size={14} /> Add a starter file
            </button>
            <h5>Defaults for projects made from this template</h5>
            <details className="template-defaults">
              <summary>
                {t.chapterLevel === null && t.book === null ? 'Using the app’s defaults' : 'Has its own chapter level and/or book defaults'} — edit
              </summary>
              <DefaultsEditor value={{ chapterLevel: t.chapterLevel, book: t.book }} app={{ chapterLevel: app.chapterLevel, book: app.book }} scope="projects from this template" onChange={(v) => setT({ chapterLevel: v.chapterLevel, book: v.book })} />
            </details>
            {errors.length > 0 && (
              <div className="banner error" role="alert">
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Toggle2({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
