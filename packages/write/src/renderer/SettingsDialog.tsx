import { useEffect, useState } from 'react';
import { defaultAppDefaults, type AppDefaults } from '../shared/appDefaults';
import type { BookDetails } from '../shared/export/model';
import { BackMatterForm, FrontMatterForm, TitleCopyrightForm } from './bookForms';
import { OutputsForm, TextForm } from './exportForms';
import { Field, Select } from './formParts';
import { TemplateEditor, type ProjectsDraft } from './TemplateEditor';
import { templateErrors, type ProjectsConfig } from '../shared/projects';
import { useEscape } from './useEscape';

type Tab = 'chapters' | 'title' | 'front' | 'back' | 'export' | 'projects';

interface Props {
  /** Saves the settings; resolves false if that was cancelled or failed (the dialog then stays open). */
  onSave(defaults: AppDefaults): Promise<boolean>;
  /** Called before projects are moved to a new Root Folder (the open project must be closed first). False cancels. */
  beforeMove?(): Promise<boolean>;
  onClose(): void;
}

const LEVELS = [1, 2, 3, 4, 5, 6].map((n) => ({
  value: n,
  label: `Heading ${n}  (${'#'.repeat(n)} Title)${n === 1 ? ' — default' : ''}`
}));

/** File → Settings: how chapters are split, and what new books start with. */
export function SettingsDialog({ onSave, beforeMove, onClose }: Props) {
  const [defaults, setDefaults] = useState<AppDefaults | null>(null);
  const [initial, setInitial] = useState('');
  const [config, setConfig] = useState<ProjectsConfig | null>(null);
  const [pdraft, setPdraft] = useState<ProjectsDraft | null>(null);
  const [pInitial, setPinitial] = useState('');
  const [projectCount, setProjectCount] = useState(0);
  const [tab, setTab] = useState<Tab>('chapters');
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    window.mdedit
      .getAppDefaults()
      .then((d) => {
        if (!live) return;
        setDefaults(d);
        setInitial(JSON.stringify(d));
      })
      .catch((e) => live && setError(String(e)));
    void Promise.all([window.mdedit.getProjectsConfig(), window.mdedit.listProjects()])
      .then(([c, l]) => {
        if (!live) return;
        const draft: ProjectsDraft = { rootFolder: c.rootFolder, templates: c.templates, defaultTemplateId: c.defaultTemplateId, reopenLast: c.reopenLast, moveProjects: false };
        setConfig(c);
        setPdraft(draft);
        setPinitial(JSON.stringify(draft));
        setProjectCount(l.projects.length);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const projectsDirty = pdraft !== null && JSON.stringify(pdraft) !== pInitial;
  const projectErrors = pdraft ? pdraft.templates.flatMap((t) => templateErrors(t).map((e) => `${t.name || '(unnamed)'}: ${e}`)) : [];
  const dirty = (defaults !== null && JSON.stringify(defaults) !== initial) || projectsDirty;
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  useEscape(() => (confirmDiscard ? setConfirmDiscard(false) : requestClose()));

  const save = async () => {
    if (!defaults || saving) return;
    setSaving(true);
    setError(null);
    if (projectErrors.length) {
      setError('Fix the template problems first (Projects tab).');
      setTab('projects');
      setSaving(false);
      return;
    }
    if (projectsDirty && pdraft && config) {
      const newRoot = pdraft.rootFolder ?? config.defaultRoot;
      try {
        if (pdraft.moveProjects && newRoot !== config.root) {
          if (beforeMove && !(await beforeMove())) return setSaving(false);
          await window.mdedit.setProjectsConfig({ rootFolder: pdraft.rootFolder }); // creates the folder
          const r = await window.mdedit.moveProjects(newRoot);
          if (r.failed.length) setError(`Some projects couldn’t be moved: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
        }
        await window.mdedit.setProjectsConfig({ rootFolder: pdraft.rootFolder, templates: pdraft.templates, defaultTemplateId: pdraft.defaultTemplateId, reopenLast: pdraft.reopenLast });
      } catch (e) {
        setError(`Could not save the project settings: ${e instanceof Error ? e.message : e}`);
        setSaving(false);
        return;
      }
    }
    const ok = await onSave(defaults);
    if (ok) onClose();
    else setSaving(false);
  };

  if (!defaults) {
    return (
      <div className="modal-backdrop">
        <div className="modal wide" role="dialog" aria-label="Settings">
          <h3>Settings</h3>
          {error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>}
          {error && (
            <div className="modal-actions">
              <button onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const book = defaults.book;
  const setBook = (patch: Partial<BookDetails>) => setDefaults({ ...defaults, book: { ...book, ...patch } });
  const editBook = (fn: (d: BookDetails) => void) => {
    const next = structuredClone(book);
    fn(next);
    setDefaults({ ...defaults, book: next });
  };
  const levelChanged = initial !== '' && (JSON.parse(initial) as AppDefaults).chapterLevel !== defaults.chapterLevel;

  return (
    <div className="modal-backdrop">
      <form
        className="modal wide book-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>Settings</h3>
        <div className="subtabs" role="tablist">
          {(
            [
              ['chapters', 'Chapters'],
              ['title', 'Title & copyright'],
              ['front', 'Front matter'],
              ['back', 'Back matter'],
              ['export', 'Export'],
              ['projects', 'Projects']
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        <div className="dialog-body">
          {error && <div className="banner error">{error}</div>}

          {tab === 'chapters' && (
            <section>
              <h4>Chapter headings</h4>
              <p className="muted small">
                Each heading of this level starts a new chapter, and the editor shows one chapter at a time. Text above the first one is shown as a
                “preamble”. Deeper headings stay inside their chapter; export treats them as sub-headings.
              </p>
              <Select<number>
                label="A chapter starts at"
                value={defaults.chapterLevel}
                options={LEVELS}
                onChange={(v) => setDefaults({ ...defaults, chapterLevel: v })}
                hint="Applies to every folder and to exports. Your files are never changed by this setting."
              />
              {levelChanged && (
                <div className="banner warn" role="status">
                  Changing this re-splits your open files. If any have unsaved edits you’ll be asked to save or discard them first.
                </div>
              )}
            </section>
          )}

          {(tab === 'title' || tab === 'front' || tab === 'back') && (
            <p className="muted small">
              {tab === 'title' ? 'These are the starting values' : 'This is the starting layout'} for each <em>new</em> book, i.e. a file the first time you
              choose “Mark for Export”. Books you have already set up keep their own details.
            </p>
          )}
          {tab === 'title' && <TitleCopyrightForm template details={book} set={setBook} />}
          {tab === 'front' && <FrontMatterForm template details={book} set={setBook} />}
          {tab === 'back' && <BackMatterForm template details={book} set={setBook} />}

          {tab === 'projects' &&
            (config && pdraft ? (
              <TemplateEditor config={config} draft={pdraft} setDraft={setPdraft} app={defaults} projectCount={projectCount} />
            ) : (
              <p className="muted">Loading…</p>
            ))}

          {tab === 'export' && (
            <>
              <p className="muted small">The starting export choices for each new book. You can still change them per book in the Export window.</p>
              <section>
                <h4>Save to</h4>
                <Field
                  label="Output folder"
                  value={book.export.outputDir}
                  onChange={(v) => editBook((d) => void (d.export.outputDir = v))}
                  hint="A relative name is created beside each manuscript."
                />
              </section>
              <OutputsForm template details={book} edit={editBook} />
              <TextForm template details={book} edit={editBook} />
            </>
          )}
        </div>

        <div className="modal-actions">
          {confirmDiscard ? (
            <div className="confirm-row" key="confirm">
              <span className="muted">Discard your changes?</span>
              <button type="button" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </button>
              <button type="button" className="danger" onClick={onClose}>
                Discard
              </button>
            </div>
          ) : (
            <div className="confirm-row" key="normal">
              <button type="button" onClick={() => setDefaults(defaultAppDefaults())} title="Put every setting back to how the app first shipped (nothing is saved until you press Save)">
                Reset all
              </button>
              <button type="button" onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={saving || !dirty}>
                Save
              </button>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
