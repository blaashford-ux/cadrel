import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportPlan, ExportProgress, ExportResult } from '../shared/api';
import { defaultOmnibusRecipe, moveItem, suggestOmnibusTitle, type OmnibusBookInfo, type OmnibusRecipe } from '../shared/export/omnibus';
import { formatBytes } from '../shared/export/outputs';
import { basename, joinParts } from '../shared/paths';
import { useEscape } from './useEscape';

interface Props {
  /** The project's folder, and its name (the omnibus is suggested a title from it). */
  projectPath: string;
  projectName: string;
  /** Files set as manuscripts (relative to the project, "/" separated), and every other Markdown file in the project, for "show every file". */
  manuscripts: string[];
  otherFiles: string[];
  /** The omnibus last made from this project, if any. */
  saved: OmnibusRecipe | null;
  /** Files with unsaved edits in an open tab (absolute paths). */
  dirtyFiles: Set<string>;
  saveFile(file: string): Promise<boolean>;
  /** Opens Book Details for a manuscript (its dialog sits on top of this one). */
  onEditDetails(file: string): void;
  /** Bumped by the parent whenever Book Details were saved, so the books are read again. */
  detailsVersion: number;
  onSaveRecipe(recipe: OmnibusRecipe): void;
  onClose(): void;
}

type Phase = 'form' | 'running' | 'done';
const abs = (project: string, rel: string) => joinParts(project, ...rel.split('/'));
const OUTPUT_LABEL = { epub: 'EPUB (ebook)', pdf: 'Print PDF (interior)', docx: 'Word (DOCX)' } as const;

/** Several manuscripts as one book: pick them, put them in order, give the omnibus its own title, and export. Each book's title page is taken from its own Book Details. */
export function OmnibusDialog({ projectPath, projectName, manuscripts, otherFiles, saved, dirtyFiles, saveFile, onEditDetails, detailsVersion, onSaveRecipe, onClose }: Props) {
  // a saved recipe keeps only the files that are still in the project
  const stillThere = (saved?.files ?? []).filter((f) => manuscripts.includes(f) || otherFiles.includes(f));
  const [recipe, setRecipe] = useState<OmnibusRecipe>(() => defaultOmnibusRecipe({ ...(saved ?? {}), title: saved?.title || suggestOmnibusTitle(projectName), files: stillThere }));
  const [showAll, setShowAll] = useState(() => manuscripts.length === 0 || stillThere.some((f) => !manuscripts.includes(f)));
  const [info, setInfo] = useState<Map<string, OmnibusBookInfo>>(new Map());
  const [plan, setPlan] = useState<(ExportPlan & { errors: string[]; warnings: string[] }) | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState<ExportProgress[]>([]);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // the books on offer: those set as manuscripts, the ones already chosen, and (when asked) every other Markdown file
  const candidates = useMemo(() => [...new Set([...recipe.files, ...manuscripts, ...(showAll ? otherFiles : [])])], [recipe.files, manuscripts, otherFiles, showAll]);
  const order = useMemo(() => [...recipe.files, ...candidates.filter((f) => !recipe.files.includes(f))], [recipe.files, candidates]);

  // each manuscript's Book Details, read again whenever they are saved
  useEffect(() => {
    let live = true;
    const api = window.cadrelWrite.omnibusBooks;
    if (!api) return;
    void api(projectPath, candidates).then((list) => live && setInfo(new Map(list.map((b) => [b.path, b]))), () => undefined);
    return () => {
      live = false;
    };
  }, [projectPath, candidates, detailsVersion]);

  // where it would be written, and what is wrong with it, as the form changes
  useEffect(() => {
    const api = window.cadrelWrite.planOmnibus;
    if (!api) return;
    const t = setTimeout(() => void api(projectPath, recipe).then(setPlan, () => setPlan(null)), 250);
    return () => clearTimeout(t);
  }, [projectPath, recipe, detailsVersion]);
  useEffect(() => window.cadrelWrite.onExportProgress((p) => setProgress((prev) => [...prev, p])), []);

  const running = phase === 'running';
  useEscape(() => !running && onClose());

  const set = (patch: Partial<OmnibusRecipe>) => setRecipe((r) => ({ ...r, ...patch }));
  const chosen = (f: string) => recipe.files.includes(f);
  const toggle = (f: string, on: boolean) => set({ files: on ? [...recipe.files, f] : recipe.files.filter((x) => x !== f) });
  const authors = [...new Set(recipe.files.map((f) => info.get(f)?.author).filter((a): a is string => !!a))];
  const dirtyChosen = recipe.files.filter((f) => dirtyFiles.has(abs(projectPath, f)));
  const books = recipe.files.map((f) => info.get(f)).filter((b): b is OmnibusBookInfo => !!b);
  const totalWords = books.reduce((n, b) => n + b.words, 0);

  const problems = [
    ...(plan?.errors ?? []),
    ...(!recipe.outputs.epub && !recipe.outputs.pdf && !recipe.outputs.docx ? ['Choose at least one output.'] : [])
  ];
  const create = async () => {
    setError(null);
    setProgress([]);
    setResult(null);
    setPhase('running');
    const mine = ++seq.current;
    try {
      for (const f of dirtyChosen) if (!(await saveFile(abs(projectPath, f)))) throw new Error(`${basename(f)} could not be saved, so nothing was exported.`);
      const r = await window.cadrelWrite.runOmnibus!(projectPath, recipe);
      if (mine === seq.current) {
        setResult(r);
        if (r.ok) onSaveRecipe(recipe); // remembered with the project, so the same omnibus can be made again
      }
    } catch (e) {
      if (mine === seq.current) setResult({ ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [], outputs: [] });
    }
    if (mine === seq.current) setPhase('done');
  };
  return (
    <div className="modal-backdrop">
      <div className="modal wide book-dialog omnibus" role="dialog" aria-modal="true" aria-label="Create omnibus">
        <h3>Create an omnibus</h3>
        {phase === 'form' && (
          <div className="dialog-body">
            <p className="muted small">Put several manuscripts together as one book. Each book keeps its own Book Details (its title and subtitle introduce it, and the chapters it leaves out stay out); the omnibus has its own title, author, ISBN and cover.</p>

            <section aria-label="Books">
              <h4>Books <span className="muted small">· {recipe.files.length} chosen{totalWords > 0 ? `, ${totalWords.toLocaleString()} words` : ''}</span></h4>
              {candidates.length === 0 ? (
                <p className="muted small">No manuscripts yet. Right-click a file in the tree and choose “Set as Manuscript”, or show every file.</p>
              ) : (
                <ul className="omni-books" aria-label="Manuscripts to include">
                  {order.map((f) => {
                    const b = info.get(f);
                    const on = chosen(f);
                    const i = recipe.files.indexOf(f);
                    return (
                      <li key={f} className={on ? 'on' : ''}>
                        <label>
                          <input type="checkbox" checked={on} aria-label={`Include ${b?.title ?? basename(f)}`} onChange={(e) => toggle(f, e.target.checked)} />
                          <span className="omni-title">{on && <span className="omni-n">{i + 1}</span>} {b?.title ?? basename(f).replace(/\.(md|markdown)$/i, '')}</span>
                        </label>
                        <span className="muted small omni-meta">
                          {b?.subtitle ? `${b.subtitle} · ` : ''}{b ? (b.author ? b.author : 'no author yet') : '…'} · {b ? `${b.chapters} chapter${b.chapters === 1 ? '' : 's'}, ${b.words.toLocaleString()} words` : ''}
                          {b && !b.hasDetails && <span className="warn-text"> · no Book Details yet: its title comes from the file name</span>}
                        </span>
                        <span className="omni-actions">
                          {on && <button type="button" aria-label={`Move ${b?.title ?? basename(f)} earlier`} disabled={i === 0} onClick={() => set({ files: moveItem(recipe.files, i, -1) })}>↑</button>}
                          {on && <button type="button" aria-label={`Move ${b?.title ?? basename(f)} later`} disabled={i === recipe.files.length - 1} onClick={() => set({ files: moveItem(recipe.files, i, 1) })}>↓</button>}
                          <button type="button" className="link" onClick={() => onEditDetails(abs(projectPath, f))}>Book Details…</button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {otherFiles.length > 0 && (
                <label className="toggle">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                  <span>Show every Markdown file in the project, not only manuscripts</span>
                </label>
              )}
              {authors.length > 1 && <div className="banner warn">These books name different authors ({authors.join(', ')}). Choose the omnibus’s author below.</div>}
            </section>

            <section aria-label="The omnibus">
              <h4>The omnibus</h4>
              <div className="omni-grid">
                <label>Title <input aria-label="Omnibus title" value={recipe.title} onChange={(e) => set({ title: e.target.value })} /></label>
                <label>Subtitle <input aria-label="Omnibus subtitle" value={recipe.subtitle} placeholder="optional" onChange={(e) => set({ subtitle: e.target.value })} /></label>
                <label>Author <input aria-label="Omnibus author" value={recipe.author} placeholder={authors[0] ?? 'as in the first book'} onChange={(e) => set({ author: e.target.value })} /></label>
                <label>ISBN <input aria-label="Omnibus ISBN" value={recipe.isbn} placeholder="the omnibus’s own; the books’ are not carried over" onChange={(e) => set({ isbn: e.target.value })} /></label>
              </div>
              <div className="inline">
                <input className="grow" aria-label="Omnibus cover" value={recipe.coverImage} placeholder="Cover image (JPEG or PNG), optional" onChange={(e) => set({ coverImage: e.target.value })} />
                <button type="button" onClick={async () => { const p = await window.cadrelWrite.pickCoverImage(); if (p) set({ coverImage: p }); }}>Choose…</button>
              </div>
            </section>

            <section aria-label="Options">
              <h4>Options</h4>
              <label className="toggle"><input type="checkbox" checked={recipe.numberBooks} onChange={(e) => set({ numberBooks: e.target.checked })} /><span>Number the books on their title pages (“Book One: …”)</span></label>
              <label className="toggle"><input type="checkbox" checked={recipe.bookFront} onChange={(e) => set({ bookFront: e.target.checked })} /><span>Put each book’s own dedication and epigraph on its title page</span></label>
              <label className="toggle"><input type="checkbox" checked={recipe.allBackMatter} onChange={(e) => set({ allBackMatter: e.target.checked })} /><span>Keep every book’s own back matter (About the Author, Acknowledgements…), not only the last book’s</span></label>
              <div className="inline" role="group" aria-label="Outputs">
                {(['epub', 'pdf', 'docx'] as const).map((k) => (
                  <label key={k} className="toggle"><input type="checkbox" checked={recipe.outputs[k]} onChange={(e) => set({ outputs: { ...recipe.outputs, [k]: e.target.checked } })} /><span>{OUTPUT_LABEL[k]}</span></label>
                ))}
              </div>
              <p className="muted small">The layout, fonts and trim size are the first book’s Book Details settings; the front and back matter pages are the last book’s.</p>
            </section>

            {plan && plan.outputs.length > 0 && (
              <section aria-label="Where it will be saved">
                <h4>Will be saved as</h4>
                <ul className="plan">
                  {plan.outputs.map((o) => <li key={o.kind}><code className="path">{o.path}</code> {o.exists && <span className="warn-text">(replaces the existing file)</span>}</li>)}
                </ul>
              </section>
            )}
            {problems.length > 0 && <ul className="problems" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            {plan && plan.warnings.length > 0 && <ul className="muted small" aria-label="Notes">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            {dirtyChosen.length > 0 && <div className="banner warn">{dirtyChosen.map(basename).join(', ')} {dirtyChosen.length === 1 ? 'has' : 'have'} unsaved edits. They are saved first, because the omnibus uses the saved files.</div>}
            {error && <div className="banner error">{error}</div>}
          </div>
        )}

        {phase === 'running' && (
          <div className="dialog-body" role="status" aria-live="polite">
            <p>Creating the omnibus…</p>
            <ul className="muted small">{progress.slice(-4).map((p, i) => <li key={i}>{p.message}</li>)}</ul>
            <button type="button" onClick={() => window.cadrelWrite.cancelExport()}>Cancel</button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="dialog-body">
            {result.ok ? <div className="banner info">The omnibus was created.</div> : <div className="banner error">The omnibus could not be created completely.</div>}
            {result.errors.length > 0 && <ul className="problems">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            <ul className="outputs" aria-label="Files made">
              {result.outputs.map((o) => (
                <li key={o.kind}>
                  <code className="path">{o.path}</code> <span className="muted small">{formatBytes(o.bytes)}{o.pages ? ` · ${o.pages} pages` : ''}</span>{' '}
                  <button type="button" onClick={() => window.cadrelWrite.revealOutput(o.path)}>Show in folder</button>{' '}
                  <button type="button" onClick={() => void window.cadrelWrite.openOutput(o.path)}>Open</button>
                </li>
              ))}
            </ul>
            {result.warnings.length > 0 && <ul className="muted small" aria-label="Warnings">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          </div>
        )}

        <div className="modal-actions">
          {phase === 'form' && (
            <>
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" disabled={problems.length > 0 || !plan} onClick={() => void create()}>{dirtyChosen.length ? 'Save the files and create' : 'Create the omnibus'}</button>
            </>
          )}
          {phase === 'done' && (
            <>
              {!result?.ok && <button type="button" onClick={() => setPhase('form')}>Back</button>}
              <button type="button" className="primary" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
