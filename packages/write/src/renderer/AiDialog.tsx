import { useEffect, useState } from 'react';
import { aiConfigSnippets, aiReviewers, type AiRemoteStatus, type AiReviewerSummary, type AiServerInfo } from '../shared/agent/config';
import { useEscape } from './useEscape';

interface Props {
  project: string;
  projectName: string;
  onClose(): void;
}

const copy = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** Connect an AI app (Claude, GPT…) so it can review this project, and see or remove the notes it has left. */
export function AiDialog({ project, projectName, onClose }: Props) {
  const api = window.mdedit;
  const [server, setServer] = useState<AiServerInfo | null | undefined>(undefined);
  const [reviewers, setReviewers] = useState<AiReviewerSummary[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [remote, setRemote] = useState<AiRemoteStatus | null>(null);
  useEscape(onClose);

  const load = () => void api.listReviews(project).then((l) => setReviewers(aiReviewers(l))).catch(() => undefined);
  useEffect(() => {
    void api.getAiServer().then(setServer).catch(() => setServer(null));
    void api.getAiRemote().then(setRemote).catch(() => undefined);
    load();
  }, [project]);

  const snippets = server ? aiConfigSnippets(server) : null;
  const rows: [string, string, string][] = snippets
    ? [
        ['Claude Code', 'Run this in a terminal', snippets.claudeCode],
        ['Claude Desktop', 'Add to claude_desktop_config.json', snippets.claudeDesktop],
        ['Codex (GPT)', 'Add to ~/.codex/config.toml', snippets.codex],
      ]
    : [];

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-dialog ai-dialog" role="dialog" aria-modal="true" aria-label="AI reviewers">
        <h3>AI reviewers</h3>
        <p className="modal-hint">
          Connect Claude, GPT or another AI app that supports MCP and it can read your chapters in <strong>{server?.root ?? 'your projects folder'}</strong> and leave comments and suggestions here.
          It can’t change your text: you accept or reject each note. If you move your Root Folder, copy the settings again.
        </p>

        {server && (
          <div className="ai-kit">
            <button
              type="button"
              className="primary"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                setError(null);
                void api
                  .exportAiKit()
                  .then((dir) => setNote(`Saved to ${dir}. Open README.txt there for the steps for Claude and GPT.`))
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? 'Saving…' : 'Save files to Downloads'}
            </button>
            <span className="muted small">The Claude extension, the three editing skills, the server and instructions for GPT, in one folder with a README.</span>
          </div>
        )}
        {server === undefined && <p className="muted">Looking…</p>}
        {server === null && <p className="modal-error">This build of MDEdit doesn’t include the AI connection.</p>}
        {rows.length > 0 && <h4>Or set it up by hand</h4>}
        {rows.map(([name, hint, text]) => (
          <div key={name} className="ai-snippet">
            <div className="ai-snippet-head">
              <strong>{name}</strong>
              <span className="muted small">{hint}</span>
              <button type="button" onClick={() => void copy(text).then((ok) => setNote(ok ? `${name} settings copied.` : 'Couldn’t copy to the clipboard.'))}>Copy</button>
            </div>
            <pre>{text}</pre>
          </div>
        ))}
        {note && <div className="share-note" role="status">{note}</div>}

        {remote && (
          <details className="ai-remote">
            <summary>Online apps (ChatGPT, Custom GPTs) — advanced</summary>
            <p className="modal-hint">
              These apps run on the internet, so they can’t start a program on your PC. Turn this on and MDEdit listens on this PC only, and every request needs the access token below.
              To let an online app reach it you must also make it available on the internet yourself, for example with a tunnel such as <code>cloudflared tunnel --url http://127.0.0.1:{remote.port}</code>.
              Anyone with the tunnel address <strong>and</strong> the token can read your chapters and add notes, so keep the token private and turn this off when you aren’t using it.
              ChatGPT’s connector settings must allow a bearer token; if an app only offers “no authentication” or sign-in, don’t expose this to it.
            </p>
            <div className="ai-remote-row">
              <button
                type="button"
                className={remote.enabled ? '' : 'primary'}
                onClick={() => void api.setAiRemote(!remote.enabled).then(setRemote, (e) => setError(e instanceof Error ? e.message : String(e)))}
              >
                {remote.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <span className={remote.running ? 'ai-on' : 'muted'}>{remote.running ? 'On: listening on this PC' : 'Off'}</span>
            </div>
            {remote.error && <div className="modal-error" role="alert">{remote.error}</div>}
            {remote.enabled && (
              <>
                {([['MCP address', remote.mcpUrl], ['REST address', remote.apiUrl], ['API description (for Custom GPT Actions)', remote.openApiUrl], ['Access token', remote.token]] as const).map(([label, value]) => (
                  <div key={label} className="ai-remote-field">
                    <span className="muted small">{label}</span>
                    <code>{value}</code>
                    <button type="button" onClick={() => void copy(value).then((ok) => setNote(ok ? `${label} copied.` : 'Couldn’t copy to the clipboard.'))}>Copy</button>
                  </div>
                ))}
                <button type="button" onClick={() => void api.resetAiRemoteToken().then(setRemote, (e) => setError(e instanceof Error ? e.message : String(e)))}>Make a new token (locks out the old one)</button>
              </>
            )}
          </details>
        )}

        <h4>Notes from AI in “{projectName}”</h4>
        <ul className="share-list">
          {reviewers.length === 0 && <li className="muted">None yet.</li>}
          {reviewers.map((r) => (
            <li key={r.id}>
              <span className="grow-text">
                {r.name}
                <span className="muted small share-sub"> {r.open} open of {r.total} note{r.total === 1 ? '' : 's'}</span>
              </span>
              {confirm === r.id ? (
                <>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirm(null);
                      setError(null);
                      void api.deleteReview(project, r.id).then(load, (e) => setError(e instanceof Error ? e.message : String(e)));
                    }}
                  >
                    Yes, delete {r.total}
                  </button>
                  <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirm(r.id)}>Delete all…</button>
              )}
            </li>
          ))}
        </ul>
        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
