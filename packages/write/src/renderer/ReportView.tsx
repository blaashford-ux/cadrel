import { useMemo, useState } from 'react';
import type { Analysis } from '../shared/analysis/analyze';
import { renderReportHtml } from '../shared/analysis/html';
import type { ReportMeta } from '../shared/analysis/embed';
import { basename } from '../shared/paths';

interface Props {
  file: string;
  report: { meta: ReportMeta; analysis: Analysis };
  /** Saving as a web page or PDF needs the desktop app. */
  canSave: boolean;
  onEdit(): void;
}

/** A text-analysis report drawn as a page of charts and tables, with buttons to save it as HTML or PDF. */
export function ReportView({ file, report, canSave, onEdit }: Props) {
  const html = useMemo(() => renderReportHtml(report.analysis, report.meta), [report]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stem = basename(file).replace(/\.(md|markdown)$/i, '');
  const save = async (kind: 'html' | 'pdf') => {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await window.mdedit.saveReport(kind, stem, html);
      setMsg(saved ? `Saved ${basename(saved)}` : null);
    } catch (e) {
      setMsg(`Could not save: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '') : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="report-view">
      <div className="report-bar">
        <strong>Text analysis</strong>
        <span className="muted">of {report.meta.source || 'the manuscript'}</span>
        {msg && <span className="report-msg" role="status">{msg}</span>}
        <span className="spacer" />
        {canSave && (
          <>
            <button disabled={busy} onClick={() => void save('html')} title="Save a self-contained web page you can open or share">
              Save as HTML
            </button>
            <button disabled={busy} onClick={() => void save('pdf')} title="Save a PDF of the report">
              Save as PDF
            </button>
          </>
        )}
        <button onClick={onEdit} title="Show the report's Markdown text">
          Edit as Markdown
        </button>
      </div>
      <iframe className="report-frame" title="Text analysis report" sandbox="allow-same-origin" srcDoc={html} />
    </div>
  );
}
