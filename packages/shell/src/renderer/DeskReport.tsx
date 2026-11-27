import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeskReport, ReportPatch, ReportSectionView } from '../shared/api';

const api = window.cadrel.desk;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const TYPE_NAME: Record<string, string> = { developmental: 'Developmental', line: 'Line', copy: 'Copy', proof: 'Proof', untagged: 'Untagged' };

/**
 * The Editing Report of one manuscript. The numbers, themes and open items are worked out from the notes each time the report is opened, so it
 * follows the editing as it happens; what the editor types (summary, sections, round) is saved as typed. A text analysis can be attached, and the
 * whole thing is exported to PDF.
 */
export function DeskReportView({ project, file, onError, onNotice }: { project: string; file: string; onError: (m: string | null) => void; onNotice: (m: string | null) => void }) {
  const [rep, setRep] = useState<DeskReport | null>(null);
  const [summary, setSummary] = useState('');
  const [sections, setSections] = useState<ReportSectionView[]>([]);
  const [round, setRound] = useState('');
  const [editor, setEditor] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const show = useCallback((r: DeskReport) => {
    setRep(r);
    setSummary(r.data.summary ?? '');
    setSections(r.data.sections);
    setRound(r.data.round ?? '');
    setEditor(r.data.editor);
    setDirty(false);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const r = await api.report(project, file);
      // what is being typed is not overwritten; the numbers beside it are
      if (dirtyRef.current) setRep((old) => (old ? { ...old, stats: r.stats, autoSummary: r.autoSummary } : r));
      else show(r);
    } catch (e) {
      onError(message(e));
    }
  }, [project, file, show, onError]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10000); // notes arriving from an assistant keep the report current
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (f: () => Promise<DeskReport | string | null | void>, done?: (r: unknown) => string | null) => {
    setBusy(true);
    try {
      const r = await f();
      if (r && typeof r === 'object') show(r as DeskReport);
      onError(null);
      if (done) onNotice(done(r));
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!rep) return <p className="muted">Loading…</p>;
  const s = rep.stats;
  const patch = (): ReportPatch => ({ summary, round, editor, sections });
  const upd = (i: number, c: Partial<ReportSectionView>) => (setSections(sections.map((x, k) => (k === i ? { ...x, ...c } : x))), setDirty(true));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= sections.length) return;
    const next = sections.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSections(next);
    setDirty(true);
  };

  return (
    <div className="desk-report">
      <div className="actions desk-report-actions">
        <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void run(() => api.saveReport(project, file, patch()), () => 'Report saved.')}>Save report</button>
        <button type="button" disabled={busy} onClick={() => void run(() => api.attachAnalysis(project, file), () => 'Text analysis attached to the report.')} title="Run the text analysis on this manuscript and add what it found to the report">{rep.data.analysis ? 'Update text analysis' : 'Attach text analysis'}</button>
        {rep.data.analysis && <button type="button" className="quiet" disabled={busy} onClick={() => void run(() => api.saveReport(project, file, { removeAnalysis: true }))}>Remove analysis</button>}
        <button type="button" disabled={busy} onClick={() => void run(async () => { if (dirty) await api.saveReport(project, file, patch()); return api.exportReportPdf(project, file); }, (p) => (p ? `Saved ${p as string}.` : null))}>Export PDF…</button>
        <span className="muted small">{dirty ? 'Unsaved changes' : rep.saved ? 'Saved with the project' : 'Not saved yet; saved when you change it or export'}</span>
      </div>

      <section className="card">
        <div className="row3">
          <label className="field"><span className="field-label">Editor</span><input value={editor} maxLength={120} onChange={(e) => (setEditor(e.target.value), setDirty(true))} /></label>
          <label className="field"><span className="field-label">Round (counts only that round’s notes)</span><input value={round} maxLength={40} placeholder="All rounds" onChange={(e) => (setRound(e.target.value), setDirty(true))} /></label>
        </div>
        <label className="field">
          <span className="field-label">Summary <span className="muted small">{summary.trim() ? '' : '(automatic until you write your own)'}</span></span>
          <textarea rows={4} value={summary} placeholder={rep.autoSummary} onChange={(e) => (setSummary(e.target.value), setDirty(true))} />
        </label>
        {summary.trim() && <button type="button" className="link small" onClick={() => (setSummary(''), setDirty(true))}>Use the automatic summary</button>}
      </section>

      <section className="card" aria-label="Sections">
        <h3>Your sections</h3>
        {sections.length === 0 && <p className="muted small">Add sections for what the numbers cannot say: overall assessment, strengths, priorities for the next draft.</p>}
        {sections.map((sec, i) => (
          <div key={sec.id + i} className="desk-section">
            <div className="row">
              <input aria-label="Section title" value={sec.title} maxLength={120} onChange={(e) => upd(i, { title: e.target.value })} />
              <button type="button" className="quiet" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="quiet" aria-label="Move down" disabled={i === sections.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="quiet" onClick={() => (setSections(sections.filter((_x, k) => k !== i)), setDirty(true))}>Remove</button>
            </div>
            <textarea aria-label={`${sec.title} text`} rows={5} value={sec.body} onChange={(e) => upd(i, { body: e.target.value })} placeholder="Paragraphs are separated by a blank line. Start lines with “- ” for a list." />
          </div>
        ))}
        <button type="button" disabled={sections.length >= 30} onClick={() => (setSections([...sections, { id: '', title: sections.length ? 'New section' : 'Overall assessment', body: '' }]), setDirty(true))}>Add a section</button>
      </section>

      <section className="card" aria-label="The notes in numbers">
        <h3>The notes in numbers <span className="muted small">worked out from the notes{rep.data.round ? ` in ${rep.data.round}` : ''}</span></h3>
        <div className="desk-tiles">
          <Tile n={s.total} label="notes" />
          <Tile n={s.byStatus.open} label="open" />
          <Tile n={s.byStatus.accepted} label="accepted" />
          <Tile n={s.byStatus.rejected} label="rejected" />
          <Tile n={s.byStatus.resolved} label="resolved" />
        </div>
        <Bars title="By edit type" rows={Object.entries(s.byEditType).map(([k, v]) => [TYPE_NAME[k] ?? k, v])} />
        <Bars title="By source" rows={[['Editor', s.bySource.human], ['AI', s.bySource.ai], ['Outside editor', s.bySource.outside]]} />
        {Object.keys(s.byRound).length > 1 && <Bars title="By round" rows={Object.entries(s.byRound)} />}
        <Bars title="By chapter" rows={s.perChapter.filter((c) => c.count).map((c) => [c.title || `Chapter ${c.index + 1}`, c.count])} />
        {s.themes.length > 0 && (
          <>
            <h4>Themes in the feedback</h4>
            <ul className="small">{s.themes.map((t) => <li key={t.topic}><strong>{t.topic}</strong> ({t.count}){t.examples.length ? <span className="muted"> — {t.examples.join(' / ')}</span> : null}</li>)}</ul>
          </>
        )}
      </section>

      {rep.data.analysis && (
        <section className="card" aria-label="Text analysis">
          <h3>Text analysis <span className="muted small">{rep.data.analysis.generated}</span></h3>
          <div className="desk-tiles">
            <Tile n={rep.data.analysis.words.toLocaleString()} label="words" />
            <Tile n={Math.round(rep.data.analysis.readingGrade * 10) / 10} label="reading grade" />
            <Tile n={Math.round(rep.data.analysis.averageSentence * 10) / 10} label="words per sentence" />
            <Tile n={pct(rep.data.analysis.dialogueShare)} label="dialogue" />
            <Tile n={Math.round(rep.data.analysis.adverbsPer1000 * 10) / 10} label="adverbs per 1,000" />
            <Tile n={pct(rep.data.analysis.passiveShare)} label="passive" />
          </div>
          <ul className="small">{rep.data.analysis.findings.map((f, i) => <li key={i}>{f.level === 'look' && <strong>Worth a look. </strong>}{f.text}</li>)}</ul>
        </section>
      )}

      {s.open.length > 0 && (
        <section className="card" aria-label="Still open">
          <h3>Still open <span className="chip">{s.byStatus.open}</span></h3>
          <ul className="small">{s.open.map((o, i) => <li key={i}><strong>{o.chapterTitle || `Chapter ${o.chapter + 1}`}</strong> · {o.kind}{o.editType ? ` · ${o.editType}` : ''}: “{o.quote}”{o.body ? <span className="muted"> — {o.body}</span> : null}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function Tile({ n, label }: { n: number | string; label: string }) {
  return <div className="desk-tile"><b>{n}</b><span>{label}</span></div>;
}

function Bars({ title, rows }: { title: string; rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length) return null;
  return (
    <div className="desk-bars" role="group" aria-label={title}>
      <h4>{title}</h4>
      {rows.map(([label, v]) => (
        <div key={label} className="desk-bar-row"><span className="bl">{label}</span><span className="bt"><i style={{ width: `${Math.round((v / max) * 100)}%` }} /></span><span className="bv">{v}</span></div>
      ))}
    </div>
  );
}
