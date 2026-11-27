import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeskManuscript, DeskNote, DeskText, StudioState } from '../shared/api';
import { DeskReportView } from './DeskReport';
import { DeskNotes, ManuscriptPane, type Selected } from './DeskWorkspace';
import { Passes } from './Editing';
import { ScopeToggle, usePageScope } from './PageScope';

const api = window.cadrel.desk;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Tab = 'edit' | 'report' | 'passes';

interface Props {
  studio: StudioState | null;
  onProject: (id: string) => void;
}

/**
 * Editing: an editor opens a manuscript, leaves comments and one-click suggestions the way Write's Notes panel does (an AI leaving notes through MCP
 * lands in the same place), keeps an Editing Report that follows the notes, and sends the author a PDF or a Word file. The editorial passes of earlier
 * versions are still here, under their own tab.
 */
export function Editing({ studio, onProject }: Props) {
  const ps = usePageScope('editing');
  const folders = useMemo(() => (ps.scope ? ps.scope.links.filter((l) => l.module === 'write').map((l) => l.ref) : undefined), [ps.scope]);
  const foldersKey = folders ? folders.join('|') : '*';
  const [list, setList] = useState<DeskManuscript[] | null>(null);
  const [sel, setSel] = useState<{ project: string; file: string } | null>(null);
  const [tab, setTab] = useState<Tab>('edit');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setList(await api.manuscripts(folders));
      setError(null);
    } catch (e) {
      setList([]);
      setError(message(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersKey]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // the chosen manuscript is dropped when the Project on screen no longer has it
  useEffect(() => {
    if (list && sel && !list.some((m) => m.project === sel.project && m.file === sel.file)) setSel(null);
  }, [list, sel]);

  const key = (m: { project: string; file: string }) => `${m.project}/${m.file}`;
  const chosen = list?.find((m) => sel && m.project === sel.project && m.file === sel.file) ?? null;

  const upload = async () => {
    const project = sel?.project ?? list?.[0]?.project ?? (folders?.[0] ?? null);
    if (!project) return setError('Choose a project first: open a manuscript, or make a project in Write.');
    setBusy(true);
    try {
      const r = await api.upload(project);
      if (!r) return;
      await reload();
      setSel({ project: r.project, file: r.file });
      setTab('edit');
      setNotice(`Uploaded ${r.file.replace(/^.*\//, '')}: ${r.added} of ${r.found} tracked changes and comments came in as notes${r.notPlaced.length ? `; ${r.notPlaced.length} could not be placed in the text` : ''}.`);
      if (r.notPlaced.length) setError(`Not placed:\n${r.notPlaced.join('\n')}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const exportWord = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      const r = await api.exportDocx(sel.project, sel.file);
      if (r) setNotice(`Saved ${r.path}: ${r.placed} notes went in as comments and tracked changes${r.skipped ? `; ${r.skipped} could not be placed` : ''}.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editing desk">
      <div className="desk-bar">
        <label className="desk-pick">
          <span className="muted small">Manuscript</span>
          <select aria-label="Manuscript" value={chosen ? key(chosen) : ''} onChange={(e) => {
            const m = list?.find((x) => key(x) === e.target.value);
            setSel(m ? { project: m.project, file: m.file } : null);
            setNotice(null);
          }}>
            <option value="">{list === null ? 'Loading…' : list.length ? 'Choose a manuscript…' : 'No manuscripts here'}</option>
            {groupByProject(list ?? []).map(([project, items]) => (
              <optgroup key={project} label={project}>
                {items.map((m) => (
                  <option key={key(m)} value={key(m)}>{m.name} · {m.words.toLocaleString()} words{m.open ? ` · ${m.open} open` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <ScopeToggle s={ps} what="All projects" />
        <span className="grow" />
        <button type="button" onClick={() => void upload()} disabled={busy} title="Bring in a Word document, with its tracked changes and comments as notes">Upload document…</button>
        <button type="button" onClick={() => void exportWord()} disabled={busy || !chosen} title="The manuscript with its open notes as Word comments and tracked changes">Export to Word…</button>
      </div>
      <div className="seg desk-tabs" role="tablist" aria-label="Editing">
        <button type="button" role="tab" aria-selected={tab === 'edit'} aria-pressed={tab === 'edit'} onClick={() => setTab('edit')}>Edit</button>
        <button type="button" role="tab" aria-selected={tab === 'report'} aria-pressed={tab === 'report'} onClick={() => setTab('report')}>Editing Report</button>
        <button type="button" role="tab" aria-selected={tab === 'passes'} aria-pressed={tab === 'passes'} onClick={() => setTab('passes')}>Earlier passes</button>
      </div>
      {error && <div className="banner error" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{error} <button type="button" className="quiet" onClick={() => setError(null)}>Dismiss</button></div>}
      {notice && <div className="banner info" role="status">{notice} <button type="button" className="quiet" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {tab === 'passes' ? (
        <Passes studio={studio} onProject={onProject} />
      ) : !chosen ? (
        <section className="card"><p className="muted">{list && list.length === 0 ? 'There are no manuscripts to edit in this project yet. Upload a Word document, or write one in Write.' : 'Choose a manuscript above, or upload a Word document that was edited elsewhere.'}</p></section>
      ) : tab === 'report' ? (
        <DeskReportView key={key(chosen)} project={chosen.project} file={chosen.file} onError={setError} onNotice={setNotice} />
      ) : (
        <Desk key={key(chosen)} project={chosen.project} file={chosen.file} onChanged={reload} onError={setError} />
      )}
    </div>
  );
}

function groupByProject(list: DeskManuscript[]): [string, DeskManuscript[]][] {
  const by = new Map<string, DeskManuscript[]>();
  for (const m of list) by.set(m.project, [...(by.get(m.project) ?? []), m]);
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** One manuscript: the text on the left with its notes marked, the notes on the right. */
function Desk({ project, file, onChanged, onError }: { project: string; file: string; onChanged: () => void; onError: (m: string | null) => void }) {
  const [text, setText] = useState<DeskText | null>(null);
  const [chapter, setChapter] = useState(0);
  const [picked, setPicked] = useState<Selected | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setText(await api.read(project, file));
    } catch (e) {
      onError(message(e));
    }
  }, [project, file, onError]);
  useEffect(() => {
    void load();
    // notes an AI leaves through MCP appear here without leaving the page
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      onError(null);
      await load();
      onChanged();
    } catch (e) {
      onError(message(e));
    }
  };

  if (!text) return <p className="muted">Loading…</p>;
  const ch = text.chapters[Math.min(chapter, text.chapters.length - 1)];
  const notes: DeskNote[] = text.notes;
  return (
    <div className="desk-cols">
      <aside className="desk-chapters" aria-label="Chapters">
        <ul className="plain">
          {text.chapters.map((c) => {
            const here = notes.filter((n) => n.chapter === c.index);
            const open = here.filter((n) => n.status === 'open').length;
            return (
              <li key={c.index}>
                <button type="button" className={'link-row' + (c.index === chapter ? ' on' : '')} onClick={() => (setChapter(c.index), setPicked(null))}>
                  <span>{c.title || `Chapter ${c.index + 1}`}</span>
                  {here.length > 0 && <span className="chip" title={`${here.length} notes, ${open} open`}>{open || '✓'}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      {ch && (
        <ManuscriptPane
          chapter={ch}
          notes={notes.filter((n) => n.chapter === ch.index)}
          focus={focus}
          onFocus={setFocus}
          picked={picked}
          onPick={setPicked}
        />
      )}
      <DeskNotes
        text={text}
        chapter={chapter}
        picked={picked}
        focus={focus}
        onFocus={(id, c) => {
          setFocus(id);
          if (c !== undefined && c >= 0) setChapter(c);
        }}
        onClearPick={() => setPicked(null)}
        onAdd={(n) => act(() => api.addNotes(project, file, [n]).then((r) => { if (r.errors.length) throw new Error(r.errors.join('\n')); setPicked(null); }))}
        onStatus={(id, s) => act(() => api.setStatus(project, id, s))}
        onTag={(id, t) => act(() => api.tag(project, id, t))}
        onReply={(id, b) => act(() => api.reply(project, id, b))}
        onRemove={(id) => act(() => api.remove(project, id))}
      />
    </div>
  );
}
