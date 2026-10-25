import { useMemo, useState } from 'react';
import { queryNotes, STANDARD_TOPICS, type NoteStatus, type NoteView } from '@cadrel/kernel';
import { ago } from './time';

/** What a panel can do to the notes it shows. Each host (the shell, a module's own page) supplies these over its own bridge. */
export interface NotesApi {
  add(o: { body: string; category?: string }): Promise<unknown>;
  setStatus(id: string, status: NoteStatus): Promise<unknown>;
  reply(id: string, body: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export interface NotesPanelProps {
  notes: NoteView[];
  api: NotesApi;
  /** Where a new note goes; omit for a list with no box to write in. */
  addTo?: { label: string };
  /** Names for the project each note is on (shown when notes from several projects are listed). */
  projectName?: (id: string) => string | null;
  /** Runs a change, then refreshes the list. `ok` is false when it was refused (the host shows why). */
  act: (job: () => Promise<unknown>) => Promise<{ ok: boolean }>;
  /** Jump to the module that owns a note (Write's manuscript notes are changed there). Omit where that makes no sense. */
  onOpenModule?: (module: string) => void;
}

const MODULE_NAMES: Record<string, string> = { write: 'Write', market: 'Market' };

function NoteCard({ n, api, projectName, act, onOpenModule }: { n: NoteView; api: NotesApi } & Pick<NotesPanelProps, 'projectName' | 'act' | 'onOpenModule'>) {
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const mine = n.source === 'studio';
  const open = n.status === 'open';
  const mod = n.target?.module;
  const where = [n.projectId ? projectName?.(n.projectId) : null, n.target?.label].filter(Boolean).join(' · ');
  return (
    <li className={`cn-note${open ? '' : ' done'}`}>
      <div className="cn-meta">
        <strong>{n.author}</strong>
        {n.origin === 'ai' && <span className="cn-chip ai">AI</span>}
        {n.category && <span className="cn-chip">{n.category}</span>}
        {n.kind === 'suggestion' && <span className="cn-chip">suggestion</span>}
        {!open && <span className="cn-chip">{n.status}</span>}
        <span className="cn-muted">{ago(Date.parse(n.updatedAt), Date.now())}</span>
      </div>
      {where && <div className="cn-where cn-muted">{where}</div>}
      {n.target?.anchor?.quote && <blockquote className="cn-quote">{n.target.anchor.quote}</blockquote>}
      <p className="cn-body">{n.body}</p>
      {n.replacement !== undefined && <p className="cn-body cn-muted">Instead: <q>{n.replacement}</q></p>}
      {n.replies.map((r) => (
        <p key={r.id} className="cn-reply"><strong>{r.author}</strong> {r.body}</p>
      ))}
      <div className="cn-actions">
        {mine && open && <button type="button" onClick={() => void act(() => api.setStatus(n.id, 'resolved'))}>Resolve</button>}
        {mine && !open && <button type="button" onClick={() => void act(() => api.setStatus(n.id, 'open'))}>Reopen</button>}
        {mine && <button type="button" onClick={() => setReplying((v) => !v)}>Reply</button>}
        {mine && <button type="button" className="quiet" onClick={() => void act(() => api.remove(n.id))}>Delete</button>}
        {!mine && mod && onOpenModule && <button type="button" onClick={() => onOpenModule(mod)}>Open in {MODULE_NAMES[mod] ?? mod}</button>}
      </div>
      {replying && (
        <form
          className="cn-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.reply(n.id, reply)).then((r) => {
              if (r.ok) {
                setReply('');
                setReplying(false);
              }
            });
          }}
        >
          <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" aria-label="Reply" autoFocus />
          <button type="submit" className="primary" disabled={!reply.trim()}>Send</button>
        </form>
      )}
    </li>
  );
}

/**
 * The list of notes with its filters, and (with `addTo`) a box to write a new one. The same panel serves a project, a record in
 * any module and the whole studio, so Notes look and behave the same wherever they are made.
 */
export function NotesPanel({ notes, api, addTo, projectName, act, onOpenModule }: NotesPanelProps) {
  const [status, setStatus] = useState<NoteStatus | 'any'>('open');
  const [text, setText] = useState('');
  const [mod, setMod] = useState('');
  const [body, setBody] = useState('');
  const [topic, setTopic] = useState('');

  const modules = useMemo(() => [...new Set(notes.map((n) => n.target?.module).filter((m): m is string => !!m))].sort(), [notes]);
  const shown = useMemo(() => queryNotes(notes, { status, text: text.trim() || undefined, module: mod || undefined }), [notes, status, text, mod]);
  const topics = useMemo(() => [...new Set([...STANDARD_TOPICS, ...notes.map((n) => n.category).filter((c): c is string => !!c)])], [notes]);

  return (
    <div className="cn-panel">
      {addTo && (
        <form
          className="cn-new"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.add({ body, category: topic || undefined })).then((r) => {
              if (r.ok) {
                setBody('');
                setTopic('');
              }
            });
          }}
        >
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={`Add a note on ${addTo.label}…`} aria-label="New note" />
          <div className="cn-new-row">
            <input list="cn-topics" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (optional)" aria-label="Topic" />
            <datalist id="cn-topics">{topics.map((t) => <option key={t} value={t} />)}</datalist>
            <button type="submit" className="primary" disabled={!body.trim()}>Add note</button>
          </div>
        </form>
      )}
      <div className="cn-filters" role="group" aria-label="Filter notes">
        <select value={status} onChange={(e) => setStatus(e.target.value as NoteStatus | 'any')} aria-label="Status">
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="any">All</option>
        </select>
        {modules.length > 1 && (
          <select value={mod} onChange={(e) => setMod(e.target.value)} aria-label="Module">
            <option value="">Everywhere</option>
            {modules.map((m) => <option key={m} value={m}>{MODULE_NAMES[m] ?? m}</option>)}
          </select>
        )}
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search notes" aria-label="Search notes" />
      </div>
      {shown.length === 0 ? (
        <p className="cn-muted">{notes.length === 0 ? 'No notes yet.' : 'No notes match.'}</p>
      ) : (
        <ul className="cn-notes">
          {shown.map((n) => <NoteCard key={n.id} n={n} api={api} projectName={projectName} act={act} onOpenModule={onOpenModule} />)}
        </ul>
      )}
    </div>
  );
}
