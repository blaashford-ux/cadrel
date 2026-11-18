import { useMemo, useState } from 'react';
import type { BookDetails, TitleItem } from '../shared/export/model';
import { addAlsoBy, alsoByCandidates, insertText, onAlsoBy } from '../shared/bookKit';
import { BlockTools, useBookTools } from './bookTools';
import { Field, Toggle } from './formParts';

/** Also by: choose from My Books instead of typing each title and link. Absent where Write has no My Books to ask. */
export function AlsoByPicker({ author, title, items, onChange }: { author: string; title: string; items: TitleItem[]; onChange(items: TitleItem[]): void }) {
  const kit = useBookTools()?.kit;
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const candidates = useMemo(() => (kit ? alsoByCandidates(kit.books, { author, title, all }) : []), [kit, author, title, all]);
  if (!kit) return null;
  const fresh = candidates.filter((b) => !onAlsoBy(items, b));
  const add = (books: typeof candidates) => {
    onChange(addAlsoBy(items, books));
    setPicked(new Set());
  };
  return (
    <div className="kit-panel">
      <div className="kit-row">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>Add from My Books…</button>
        {fresh.length > 0 && <button type="button" onClick={() => add(fresh)} title="Add every book listed that is not already on the page">Add all {fresh.length} by {author.trim() || 'this author'}</button>}
        {kit.books.length === 0 && <span className="muted small">My Books has no published books yet.</span>}
      </div>
      {open && (
        <>
          <label className="toggle"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span>Show books under every pen name</span></label>
          <div className="kit-books" role="group" aria-label="Books from My Books">
            {candidates.length === 0 && <p className="muted small">No other books to add.</p>}
            {candidates.map((b) => {
              const there = onAlsoBy(items, b);
              return (
                <label key={b.asin}>
                  <input type="checkbox" disabled={there} checked={there || picked.has(b.asin)} onChange={(e) => setPicked((cur) => { const n = new Set(cur); if (e.target.checked) n.add(b.asin); else n.delete(b.asin); return n; })} />
                  <span>{b.title}{b.series ? <span className="muted small"> — {b.series}{b.position != null ? ` #${b.position}` : ''}</span> : null}{there ? <span className="muted small"> (on the page)</span> : null}</span>
                </label>
              );
            })}
          </div>
          <button type="button" className="primary" disabled={picked.size === 0} onClick={() => add(candidates.filter((b) => picked.has(b.asin)))}>Add {picked.size || ''} selected</button>
        </>
      )}
    </div>
  );
}

/** The Patreon page: switched on here, worded and linked from the author's profile. */
export function PatreonSection({ details, set }: { details: BookDetails; set(patch: Partial<BookDetails['back']>): void }) {
  const kit = useBookTools()?.kit;
  const p = details.back.patreon;
  const prof = kit?.profile;
  return (
    <section>
      <h4>Patreon</h4>
      <Toggle label="Include a Patreon page" checked={p.enabled} path="back.patreon.enabled" onChange={(v) => set({ patreon: { ...p, enabled: v } })} hint="Its link and wording come from your profile." />
      {p.enabled && (
        <>
          <Field label="Heading" value={p.heading} placeholder="SUPPORT ME ON PATREON" path="back.patreon.heading" onChange={(v) => set({ patreon: { ...p, heading: v } })} />
          {!kit ? (
            <p className="muted small">The link and wording are taken from your Cadrel profile when the book is exported.</p>
          ) : prof?.patreonUrl.trim() ? (
            <div className="preview-box" aria-label="Patreon page preview">
              <div className="preview-title">From your profile</div>
              {prof.patreonCta.trim() && <p>{prof.patreonCta}</p>}
              <p>{prof.patreonUrl}</p>
            </div>
          ) : (
            <div className="banner warn">Your profile has no Patreon link yet, so this page would be left out. Add it in Profile.</div>
          )}
        </>
      )}
    </section>
  );
}

/** Pen names from the profile, to pick instead of typing. */
export function PenNamePicker({ author, onPick }: { author: string; onPick(name: string): void }) {
  const kit = useBookTools()?.kit;
  const names = [...new Set([...(kit?.profile.penNames ?? []), ...(kit?.profile.displayName ? [kit.profile.displayName] : [])].map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0) return null;
  return (
    <div className="kit-row">
      <label className="muted small" htmlFor="pen-name-pick">From your profile</label>
      <select id="pen-name-pick" value="" onChange={(e) => e.target.value && onPick(e.target.value)}>
        <option value="">Pick a name…</option>
        {names.filter((n) => n !== author).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}

/** Puts the profile's bio into the About the author page. */
export function BioFromProfile({ value, onChange }: { value: string; onChange(v: string): void }) {
  const bio = useBookTools()?.kit?.profile.bio.trim();
  if (!bio) return null;
  return (
    <div className="kit-row">
      <button type="button" onClick={() => onChange(insertText(value, bio))}>Use my profile bio</button>
    </div>
  );
}

/** The Community page: the Studio's community links, each switched on or off for this book (all on to begin with), and a place to define them. */
export function CommunitySection({ details, set }: { details: BookDetails; set(patch: Partial<BookDetails['back']>): void }) {
  const tools = useBookTools();
  const c = details.back.community;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ id?: string; name: string; url: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!tools || tools.communities === null) return null;
  const all = tools.communities;
  const setOff = (id: string, on: boolean) => set({ community: { ...c, off: on ? c.off.filter((x) => x !== id) : [...new Set([...c.off, id])] } });
  const save = async () => {
    setBusy(true);
    try {
      await tools.saveCommunities(draft);
      setEditing(false);
      setError('');
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };
  const shown = all.filter((x) => !c.off.includes(x.id)).length;
  return (
    <section>
      <h4>Community links</h4>
      <Toggle label="Include a Community page" checked={c.enabled} path="back.community.enabled" onChange={(v) => set({ community: { ...c, enabled: v } })} hint="One line for each community: its name, then its address." />
      {c.enabled && (
        <>
          <Field label="Heading" value={c.heading} placeholder="JOIN THE COMMUNITY" path="back.community.heading" onChange={(v) => set({ community: { ...c, heading: v } })} />
          {all.length === 0 && !editing && <p className="muted small">This Studio has no community links yet.</p>}
          {!editing && all.map((x) => (
            <label className="toggle" key={x.id}>
              <input type="checkbox" checked={!c.off.includes(x.id)} onChange={(e) => setOff(x.id, e.target.checked)} />
              <span>{x.name} <span className="muted small">{x.url}</span></span>
            </label>
          ))}
          {!editing && all.length > 0 && <p className="muted small">{shown === 0 ? 'None are switched on for this book, so the page is left out.' : `${shown} of ${all.length} on for this book.`}</p>}
          {!editing ? (
            <div className="kit-row"><button type="button" onClick={() => (setDraft(all.map((x) => ({ ...x }))), setError(''), setEditing(true))}>{all.length ? 'Edit the Studio’s communities…' : 'Add a community…'}</button></div>
          ) : (
            <div className="kit-panel">
              <p className="muted small">These are kept for the whole Studio, so every book can use them. New ones are on in every book until you switch them off there.</p>
              {draft.map((x, i) => (
                <div className="kit-row" key={x.id ?? `new${i}`}>
                  <input aria-label="Community name" placeholder="Name (e.g. Reader Discord)" value={x.name} onChange={(e) => setDraft(draft.map((d, k) => (k === i ? { ...d, name: e.target.value } : d)))} />
                  <input aria-label="Community address" placeholder="https://…" value={x.url} onChange={(e) => setDraft(draft.map((d, k) => (k === i ? { ...d, url: e.target.value } : d)))} />
                  <button type="button" aria-label="Remove community" onClick={() => setDraft(draft.filter((_, k) => k !== i))}>✕</button>
                </div>
              ))}
              <div className="kit-row">
                <button type="button" onClick={() => setDraft([...draft, { name: '', url: '' }])}>＋ Add a community</button>
                <button type="button" className="primary" disabled={busy} onClick={() => void save()}>Save to Studio</button>
                <button type="button" disabled={busy} onClick={() => (setEditing(false), setError(''))}>Cancel</button>
              </div>
              {error && <div className="bad" role="alert">{error}</div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export { BlockTools };
