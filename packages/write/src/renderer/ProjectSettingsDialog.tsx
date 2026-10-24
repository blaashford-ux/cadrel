import { useEffect, useMemo, useState } from 'react';
import type { AppDefaults } from '../shared/appDefaults';
import type { TreeNode } from '../shared/api';
import { localDate, sanitizeGoal } from '../shared/progress';
import { goalFor, STATUS_LABELS, STATUSES, withGoal, type ProjectMeta, type ProjectStatus, type ProjectsConfig } from '../shared/projects';
import { DefaultsEditor } from './DefaultsEditor';
import { Field, NumberField, TextArea, Toggle } from './formParts';
import { useEscape } from './useEscape';

type Tab = 'general' | 'goal' | 'defaults';

interface Props {
  path: string;
  config: ProjectsConfig | null;
  onClose(): void;
  /** The project's metadata was saved. */
  onChanged(meta: ProjectMeta): void;
}

/** Folders of a scanned project, relative to it ("Manuscript", "Notes/Maps"). */
function relFolders(tree: TreeNode, base = ''): string[] {
  if (tree.kind !== 'dir') return [];
  return tree.children.flatMap((c) => (c.kind === 'dir' ? [base + c.name, ...relFolders(c, `${base}${c.name}/`)] : []));
}

/** Project settings: status and notes, the word-count goal and what counts toward it, and export defaults. */
export function ProjectSettingsDialog({ path, config, onClose, onChanged }: Props) {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [initial, setInitial] = useState('');
  const [app, setApp] = useState<AppDefaults | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('general');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [goalOn, setGoalOn] = useState(false);
  const today = localDate(new Date());

  useEffect(() => {
    let live = true;
    void Promise.all([window.mdedit.getProjectMeta(path), window.mdedit.getAppDefaults(), window.mdedit.scanFolder(path)])
      .then(([m, a, tree]) => {
        if (!live) return;
        if (!m) return setError('That folder is not a project.');
        setMeta(m);
        setInitial(JSON.stringify(m));
        setGoalOn(goalFor(m) !== null);
        setApp(a);
        setFolders(relFolders(tree));
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [path]);

  const dirty = meta !== null && JSON.stringify(meta) !== initial;
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  useEscape(() => (confirmDiscard ? setConfirmDiscard(false) : requestClose()));

  const template = useMemo(() => config?.templates.find((t) => t.id === meta?.templateId) ?? null, [config, meta?.templateId]);

  if (!meta || !app) {
    return (
      <div className="modal-backdrop">
        <div className="modal wide" role="dialog" aria-label="Project settings">
          <h3>Project settings</h3>
          {error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>}
          <div className="modal-actions">
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const patch = (p: Partial<ProjectMeta>) => setMeta({ ...meta, ...p });
  const goal = goalFor(meta);
  const fileName = meta.activeManuscript ? meta.activeManuscript.split('/').pop() : null;
  const setGoal = (g: Partial<NonNullable<ProjectMeta['goal']>>) =>
    setMeta(withGoal(meta, { targetWords: 80000, startDate: today, targetDate: null, ...goal, ...g }));
  const excluded = new Set(meta.excludedFolders);
  const toggleFolder = (f: string, counted: boolean) => {
    const next = new Set(excluded);
    if (counted) next.delete(f);
    else next.add(f);
    patch({ excludedFolders: [...next].sort() });
  };

  const save = async () => {
    if (saving) return;
    let finalGoal = goal;
    if (!goalOn) finalGoal = null;
    else {
      finalGoal = sanitizeGoal(goal, today);
      if (!finalGoal) {
        setTab('goal');
        return setError('Enter a target word count above zero, and a deadline that is not before the start date.');
      }
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await window.mdedit.updateProject(path, {
        status: meta.status,
        notes: meta.notes,
        archived: meta.archived,
        ...(({ goal: g, manuscriptGoals }) => ({ goal: g, manuscriptGoals }))(withGoal(meta, finalGoal)),
        excludedFolders: meta.excludedFolders,
        overrides: meta.overrides
      });
      onChanged(saved);
      onClose();
    } catch (e) {
      setError(`Could not save: ${e instanceof Error ? e.message : e}`);
      setSaving(false);
    }
  };

  const addMissing = async () => {
    if (!template) return;
    try {
      const added = await window.mdedit.addMissingTemplateParts(path, template.id);
      setInfo(added.length ? `Added: ${added.join(', ')}` : 'Nothing was missing.');
      setFolders(relFolders(await window.mdedit.scanFolder(path)));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="modal-backdrop">
      <form
        className="modal wide book-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>Project settings — {meta.name}</h3>
        <div className="subtabs" role="tablist">
          {(
            [
              ['general', 'General'],
              ['goal', 'Goal'],
              ['defaults', 'Export defaults']
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="dialog-body">
          {error && <div className="banner error">{error}</div>}
          {info && <div className="banner info">{info}</div>}

          {tab === 'general' && (
            <section>
              <label className="field" style={{ maxWidth: 240 }}>
                <span className="field-label">Status</span>
                <select value={meta.status} onChange={(e) => patch({ status: e.target.value as ProjectStatus })} aria-label="Status">
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <TextArea label="Notes" value={meta.notes} onChange={(v) => patch({ notes: v })} rows={4} placeholder="Anything worth remembering about this project" />
              <Toggle label="Archived" checked={meta.archived} onChange={(v) => patch({ archived: v })} hint="Archived projects are tucked away on the Projects home." />
              <p className="muted small">
                Made from the “{meta.templateName}” template on {new Date(meta.createdAt).toLocaleDateString()}.
              </p>
              <div className="row-actions">
                <button type="button" onClick={() => void addMissing()} disabled={!template} title={template ? '' : 'The template this project was made from no longer exists'}>
                  Add missing template folders
                </button>
                <button type="button" onClick={() => window.mdedit.reveal(path)}>
                  Show in File Explorer
                </button>
              </div>
            </section>
          )}

          {tab === 'goal' && (
            <section>
              <p className="muted small">
                {fileName ? (
                  <>
                    This goal is for the active manuscript, <strong>{fileName}</strong>. Right-click another file and choose “Active Manuscript” to give that one its own goal.
                  </>
                ) : (
                  'This goal covers the whole project. Right-click a file and choose “Active Manuscript” to track one book on its own.'
                )}
              </p>
              <Toggle label="Set a word-count goal" checked={goalOn} onChange={(v) => (setGoalOn(v), v && !goal && setGoal({}))} />
              {goalOn && goal && (
                <>
                  <NumberField label="Target" value={goal.targetWords} min={1} max={10_000_000} step={1} unit="words" onChange={(v) => setGoal({ targetWords: Math.round(v) })} />
                  <Field label="Start date" type="date" value={goal.startDate} onChange={(v) => v && setGoal({ startDate: v })} hint="Words already written before this day don’t count as progress." />
                  <Field label="Finish by (optional)" type="date" value={goal.targetDate ?? ''} onChange={(v) => setGoal({ targetDate: v || null })} hint="With a deadline you’ll see the words per day you need." />
                </>
              )}
              {fileName ? null : <h4>What counts</h4>}
              {!fileName && (
                <>
              <p className="muted small">Words in checked folders count toward the goal. Files directly in the project folder always count.</p>
              {folders.length === 0 ? (
                <p className="muted small">This project has no subfolders.</p>
              ) : (
                <div className="count-list">
                  {folders.map((f) => (
                    <label key={f} className="count-row" style={{ paddingLeft: 8 + (f.split('/').length - 1) * 18 }}>
                      <input type="checkbox" checked={!excluded.has(f)} onChange={(e) => toggleFolder(f, e.target.checked)} /> {f.split('/').pop()}
                    </label>
                  ))}
                </div>
              )}
                </>
              )}
            </section>
          )}

          {tab === 'defaults' && (
            <DefaultsEditor
              scope="this project"
              app={{ chapterLevel: app.chapterLevel, book: app.book }}
              value={{ chapterLevel: meta.overrides.chapterLevel, book: meta.overrides.book }}
              onChange={(v) => patch({ overrides: { chapterLevel: v.chapterLevel, book: v.book } })}
            />
          )}
        </div>
        <div className="modal-actions">
          {confirmDiscard ? (
            <>
              <span className="muted">Discard your changes?</span>
              <button type="button" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </button>
              <button type="button" className="danger" onClick={onClose}>
                Discard
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
