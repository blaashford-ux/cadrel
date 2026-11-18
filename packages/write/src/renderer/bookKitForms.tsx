import { useMemo, useState } from 'react';
import type { BookDetails, TitleItem } from '../shared/export/model';
import { addAlsoBy, alsoByCandidates, insertText, onAlsoBy } from '../shared/bookKit';
import { BlockTools, useBookTools } from './bookTools';
import { Field, Toggle } from './formParts';

/** Also by: pick a book from My Books in the dropdown (title, link, cover and blurb come with it) instead of typing each one. Absent where Write has no My Books to ask. */
export function AlsoByPicker({ author, title, items, onChange }: { author: string; title: string; items: TitleItem[]; onChange(items: TitleItem[]): void }) {
  const kit = useBookTools()?.kit;
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => (kit ? alsoByCandidates(kit.books, { author, title, all }) : []), [kit, author, title, all]);
  if (!kit) return null;
  const fresh = candidates.filter((b) => !onAlsoBy(items, b));
  const add = async (books: typeof candidates) => {
    setBusy(true);
    try {
      const cards = await Promise.all(books.map((b) => window.cadrelWrite.bookCard?.(b.asin).catch(() => null) ?? null));
      onChange(addAlsoBy(items, books, cards));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-panel">
      <div className="kit-row">
        <select aria-label="Add a book from My Books" value="" disabled={busy || fresh.length === 0} onChange={(e) => { const b = fresh.find((x) => x.asin === e.target.value); if (b) void add([b]); }}>
          <option value="">{fresh.length ? 'Add a book from My Books…' : candidates.length ? 'All books are on the page' : 'No other books in My Books'}</option>
          {fresh.map((b) => (
            <option key={b.asin} value={b.asin}>{b.title}{b.series ? ` — ${b.series}${b.position != null ? ` #${b.position}` : ''}` : ''}</option>
          ))}
        </select>
        {fresh.length > 1 && <button type="button" disabled={busy} onClick={() => void add(fresh)} title="Add every book listed that is not already on the page">Add all {fresh.length} by {author.trim() || 'this author'}</button>}
        {busy && <span className="muted small">Fetching covers…</span>}
      </div>
      <label className="toggle"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span>Show books under every pen name</span></label>
    </div>
  );
}

/** A book's cover on the Also By page: shown, replaced from a file, or removed. Kept as a small image saved with the book's details. */
export function CoverField({ cover, onChange }: { cover: string; onChange(cover: string): void }) {
  const [error, setError] = useState('');
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try {
      // decoded without loading a URL, so it works under the page's content security policy
      const bmp = await createImageBitmap(file);
      const w = Math.min(360, bmp.width || 360);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = Math.max(1, Math.round(w * (bmp.height / (bmp.width || 1))));
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.fillStyle = '#fff'; // a PNG's transparent areas become white in the JPEG
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      onChange(c.toDataURL('image/jpeg', 0.85));
    } catch {
      setError('That image could not be read. Use a JPEG or PNG file.');
    }
  };
  return (
    <div className="kit-row">
      {cover ? <img src={cover} alt="Book cover" style={{ height: 72, width: 'auto', borderRadius: 2 }} /> : <span className="muted small">No cover</span>}
      <label className="button-like"><input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />{cover ? 'Replace cover…' : 'Choose cover…'}</label>
      {cover && <button type="button" onClick={() => onChange('')}>Remove cover</button>}
      {error && <span className="muted small" role="alert">{error}</span>}
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
