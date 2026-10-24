import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportPlan, ExportProgress, ExportResult } from '../shared/api';
import { splitChapters } from '../shared/chapters';
import { formatBytes } from '../shared/export/outputs';
import { basename } from '../shared/paths';
import { countWords } from '../shared/words';
import { OutputsForm, TextForm, KINDS } from './exportForms';
import { Select, Toggle } from './formParts';
import { LayerProvider, LayerTag, SettingsReview } from './layerEditor';
import { useBookLayers } from './useBookLayers';
import { useEscape } from './useEscape';

interface Props {
  /** Files currently marked for export. */
  files: string[];
  /** The heading level that starts a chapter. */
  chapterLevel: number;
  initialFile: string;
  /** Files with unsaved edits in an open tab. */
  dirtyFiles: Set<string>;
  saveFile(file: string): Promise<boolean>;
  /** Opens Book Details for a file (its dialog sits on top of this one). */
  onEditDetails(file: string): void;
  /** Bumped by the parent whenever Book Details were saved, so this dialog reloads them. */
  detailsVersion: number;
  onClose(): void;
}

type Phase = 'form' | 'running' | 'done';

export function ExportDialog({ files, chapterLevel, initialFile, dirtyFiles, saveFile, onEditDetails, detailsVersion, onClose }: Props) {
  const [file, setFile] = useState(initialFile);
  const { layer, dirty, error: loadError, save: saveLayers } = useBookLayers(file, detailsVersion);
  const details = layer?.details ?? null;
  const [chapters, setChapters] = useState<{ title: string; words: number }[]>([]);
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState<ExportProgress[]>([]);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askDirty, setAskDirty] = useState(false);
  const runSeq = useRef(0);

  const dirtyBook = dirtyFiles.has(file);

  // ---- load the book --------------------------------------------------------------------
  useEffect(() => {
    let live = true;
    setConfirmed(false);
    window.mdedit
      .readFile(file)
      .then((f) => {
        if (!live) return;
        setChapters(splitChapters(f.text, chapterLevel).chapters.filter((c) => !c.isPreamble).map((c) => ({ title: c.title, words: countWords(c.raw) })));
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [file, detailsVersion, chapterLevel]);
  useEffect(() => setConfirmed(false), [file, detailsVersion]);

  // ---- where the files will go (reflects the form as it is now) ---------------------------
  useEffect(() => {
    if (!details) return;
    const t = setTimeout(() => {
      window.mdedit.planExport(file, details).then(setPlan).catch(() => setPlan(null));
    }, 250);
    return () => clearTimeout(t);
  }, [file, details?.title, details?.export.outputDir, details?.export.outputs.epub, details?.export.outputs.pdf, details?.export.outputs.docx]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => window.mdedit.onExportProgress((p) => setProgress((prev) => [...prev, p])), []);

  const running = phase === 'running';
  useEscape(() => !running && closeAndSave());

  const edit = layer?.edit ?? (() => undefined);

  const closeAndSave = async () => {
    // export settings are remembered even if you don't export
    if (layer && dirty) await saveLayers().catch(() => undefined);
    onClose();
  };

  // ---- validation -------------------------------------------------------------------------
  const problems = useMemo(() => {
    if (!details) return [];
    const p: string[] = [];
    if (!details.title.trim()) p.push('The book needs a title.');
    if (!details.author.trim()) p.push('The book needs an author or pen name.');
    if (!KINDS.some((k) => details.export.outputs[k])) p.push('Choose at least one output.');
    const included = chapters.filter((c) => !details.export.excludedChapters.includes(c.title));
    if (chapters.length === 0) p.push(`This file has no chapters (each chapter starts with a Heading ${chapterLevel}, “${'#'.repeat(chapterLevel)} ”).`);
    else if (included.length === 0) p.push('Every chapter is excluded.');
    return p;
  }, [details, chapters]);

  const startExport = async (saveFirst: boolean) => {
    if (!details) return;
    setAskDirty(false);
    if (saveFirst && !(await saveFile(file))) {
      setError('The file could not be saved, so nothing was exported.');
      return;
    }
    setError(null);
    setProgress([]);
    setResult(null);
    setPhase('running');
    const seq = ++runSeq.current;
    try {
      await saveLayers();
      const r = await window.mdedit.runExport(file);
      if (seq === runSeq.current) setResult(r);
    } catch (e) {
      if (seq === runSeq.current) setResult({ ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [], outputs: [] });
    }
    if (seq === runSeq.current) setPhase('done');
  };

  const onExportClick = () => (dirtyBook ? setAskDirty(true) : void startExport(false));

  // ---- render -----------------------------------------------------------------------------
  if (!details || !layer) {
    return (
      <div className="modal-backdrop">
        <div className="modal wide" role="dialog" aria-label="Export">
          <h3>Export</h3>
          {error ?? loadError ? <div className="banner error">{error ?? loadError}</div> : <p className="muted">Loading…</p>}
          <div className="modal-actions">
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const e = details.export;
  const included = (title: string) => !e.excludedChapters.includes(title);
  const setIncluded = (title: string, on: boolean) =>
    edit((d) => void (d.export.excludedChapters = on ? d.export.excludedChapters.filter((t) => t !== title) : [...new Set([...d.export.excludedChapters, title])]));

  return (
    <div className="modal-backdrop">
      <div className="modal wide book-dialog" role="dialog" aria-modal="true" aria-label="Export">
        <h3>Export for KDP</h3>

        {phase === 'form' && (
          <div className="dialog-body">
            {files.length > 1 && (
              <Select<string> label="Book" value={file} options={files.map((f) => ({ value: f, label: basename(f) }))} onChange={setFile} />
            )}

            <section className="readback" aria-label="Confirm title and author">
              <h4>Check these are exactly right</h4>
              <dl>
                <dt>Title</dt>
                <dd data-testid="rb-title">{details.title || <span className="bad">(missing)</span>}</dd>
                <dt>Subtitle</dt>
                <dd data-testid="rb-subtitle">{details.subtitle || <span className="muted">(none)</span>}</dd>
                <dt>Author</dt>
                <dd data-testid="rb-author">{details.author || <span className="bad">(missing)</span>}</dd>
              </dl>
              <div className="readback-actions">
                <button type="button" onClick={() => onEditDetails(file)}>
                  Edit Book Details…
                </button>
                <Toggle label="Title, subtitle and author are exactly as they should appear" checked={confirmed} onChange={setConfirmed} />
              </div>
            </section>

            {dirtyBook && (
              <div className="banner warn">
                {basename(file)} has unsaved edits. Exports use the saved file; you’ll be asked whether to save first.
              </div>
            )}

            <LayerProvider value={layer}>
              <OutputsForm details={details} edit={edit} />

              <TextForm details={details} edit={edit} />
            </LayerProvider>

            <section>
              <h4>Chapters</h4>
              <div className="inline">
                <button type="button" onClick={() => edit((d) => void (d.export.excludedChapters = []))}>
                  Include all
                </button>
                <button type="button" onClick={() => edit((d) => void (d.export.excludedChapters = chapters.map((c) => c.title)))}>
                  Exclude all
                </button>
                <span className="muted small">
                  {chapters.length - e.excludedChapters.filter((t) => chapters.some((c) => c.title === t)).length} of {chapters.length} included
                </span>
              </div>
              <div className="chapter-list" role="group" aria-label="Chapters to include">
                {chapters.map((c, i) => (
                  <label className="toggle" key={`${i}-${c.title}`}>
                    <input type="checkbox" checked={included(c.title)} onChange={(ev) => setIncluded(c.title, ev.target.checked)} />
                    <span>
                      {c.title || '(untitled)'} <span className="muted small">· {c.words.toLocaleString()} words</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section>
              <h4>
                Save to <LayerProvider value={layer}><LayerTag path="export.outputDir" /></LayerProvider>
              </h4>
              <div className="inline">
                <input
                  className="grow"
                  aria-label="Output folder"
                  value={e.outputDir}
                  onChange={(ev) => edit((d) => void (d.export.outputDir = ev.target.value))}
                />
                <button
                  type="button"
                  onClick={async () => {
                    const p = await window.mdedit.pickFolder();
                    if (p) edit((d) => void (d.export.outputDir = p));
                  }}
                >
                  Browse…
                </button>
              </div>
              <p className="muted small">A relative name is created beside the manuscript.</p>
              {plan && plan.outputs.length > 0 && (
                <ul className="plan" aria-label="Files that will be written">
                  {plan.outputs.map((o) => (
                    <li key={o.kind}>
                      <code className="path">{o.path}</code> {o.exists && <span className="warn-text">(replaces the existing file)</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <SettingsReview layer={layer} />

            {problems.length > 0 && (
              <div className="banner error" role="alert">
                {problems.map((p) => (
                  <div key={p}>{p}</div>
                ))}
              </div>
            )}
            {error && <div className="banner error">{error}</div>}
          </div>
        )}

        {phase === 'running' && (
          <div className="dialog-body" aria-live="polite">
            <p>Exporting <strong>{details.title}</strong>…</p>
            <ul className="progress-list">
              {progress.slice(-8).map((p, i, arr) => (
                <li key={i} className={i === arr.length - 1 ? 'now' : 'done'}>
                  {p.message}
                </li>
              ))}
              {progress.length === 0 && <li className="now">Starting…</li>}
            </ul>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="dialog-body" aria-live="polite">
            <div className={'banner ' + (result.ok ? 'info' : 'warn')} role="status">
              {result.ok ? `Done — ${result.outputs.length} file${result.outputs.length === 1 ? '' : 's'} created.` : 'The export finished with problems.'}
            </div>
            {result.outputs.length > 0 && (
              <ul className="results">
                {result.outputs.map((o) => (
                  <li key={o.kind}>
                    <div>
                      <strong>{basename(o.path)}</strong>
                      <span className="muted small">
                        {' '}
                        · {formatBytes(o.bytes)}
                        {o.pages ? ` · ${o.pages} pages · ${o.gutter} in inside margin` : ''}
                      </span>
                      <div className="muted small path">{o.path}</div>
                      {o.warnings.map((w) => (
                        <div key={w} className="warn-text small">
                          ⚠ {w}
                        </div>
                      ))}
                    </div>
                    <div className="inline">
                      <button type="button" onClick={() => void window.mdedit.openOutput(o.path)}>
                        Open
                      </button>
                      <button type="button" onClick={() => window.mdedit.revealOutput(o.path)}>
                        Show in folder
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {result.errors.length > 0 && (
              <div className="banner error" role="alert">
                {result.errors.map((m) => (
                  <div key={m}>{m}</div>
                ))}
              </div>
            )}
            {result.warnings.length > 0 && (
              <>
                <h5>Notes about your manuscript</h5>
                <ul className="notes">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted small">The EPUB passes the built-in structure check; run it through Kindle Previewer / KDP’s uploader to confirm KDP is happy.</p>
          </div>
        )}

        <div className="modal-actions">
          {phase === 'form' && !askDirty && (
            <>
              <button type="button" onClick={() => void closeAndSave()}>
                Close
              </button>
              <button type="button" className="primary" disabled={problems.length > 0 || !confirmed} onClick={onExportClick} title={!confirmed ? 'Confirm the title, subtitle and author first' : undefined}>
                Export
              </button>
            </>
          )}
          {phase === 'form' && askDirty && (
            <div className="confirm-row" key="dirty">
              <span className="muted">{basename(file)} has unsaved changes.</span>
              <button type="button" onClick={() => setAskDirty(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void startExport(false)}>
                Export saved version
              </button>
              <button type="button" className="primary" onClick={() => void startExport(true)}>
                Save and export
              </button>
            </div>
          )}
          {phase === 'running' && (
            <button type="button" onClick={() => window.mdedit.cancelExport()}>
              Cancel export
            </button>
          )}
          {phase === 'done' && (
            <>
              <button type="button" onClick={() => setPhase('form')}>
                Back to settings
              </button>
              <button type="button" className="primary" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
