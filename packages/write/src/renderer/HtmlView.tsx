import { useEffect, useState } from 'react';
import { basename } from '../shared/paths';

interface Props {
  file: string;
  /** Changes whenever the folder is rescanned, so a page rewritten on disk is read again. */
  version: unknown;
  /** Revealing the file needs the desktop app. */
  onReveal?: () => void;
}

/**
 * A web page from the project (a tracker page or chapter record), shown read-only.
 * It runs in a sandbox with scripts allowed but no access to this app: no same-origin, so it cannot
 * touch the app, the files or the bridge; pages are self-contained and need nothing from outside.
 */
export function HtmlView({ file, version, onReveal }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    window.cadrelWrite
      .readFile(file)
      .then((r) => live && setHtml(r.text))
      .catch((e) => live && (setHtml(null), setError(e instanceof Error ? e.message : String(e))));
    const again = () => {
      window.cadrelWrite
        .readFile(file)
        .then((r) => live && setHtml(r.text))
        .catch(() => undefined);
    };
    window.addEventListener('focus', again);
    return () => {
      live = false;
      window.removeEventListener('focus', again);
    };
  }, [file, version]);

  return (
    <div className="report-view">
      <div className="report-bar">
        <strong>{basename(file)}</strong>
        <span className="muted">read-only page</span>
        <span className="spacer" />
        {onReveal && <button onClick={onReveal}>Show in File Explorer</button>}
      </div>
      {error ? (
        <p className="muted pad" role="alert">Could not open this page: {error}</p>
      ) : html === null ? (
        <p className="muted pad">Opening…</p>
      ) : (
        <iframe className="report-frame" title={basename(file)} sandbox="allow-scripts" srcDoc={html} />
      )}
    </div>
  );
}
