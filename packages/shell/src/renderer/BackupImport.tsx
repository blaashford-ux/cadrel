import { useState } from 'react';
import type { BackupSummary, MdeditCandidate } from '../shared/api';

const api = window.cadrel.backup;

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Back up this Studio, restore from a backup, and bring projects over from MDEdit. Nothing here overwrites: a restore adds, an import copies. */
export function BackupImport({ onChanged }: { onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [backup, setBackup] = useState<BackupSummary | null>(null);
  const [studioName, setStudioName] = useState('');
  const [found, setFound] = useState<MdeditCandidate[] | null>(null);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ kind: 'ok', text });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="s-backup">
      <h3 id="s-backup">Backup and import</h3>
      <p className="muted small">
        A backup is one file holding this Studio’s projects, notes and settings. Keys and tokens are never in it. Restoring adds to this computer and never overwrites anything.
      </p>
      {message && <div className={`banner ${message.kind === 'ok' ? 'info' : 'error'}`} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</div>}

      <h4>Back up</h4>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
          const r = await api.make();
          return r && `Backed up ${r.files} files (${size(r.bytes)}) to ${r.file}. It was read back and checked.`;
        })}>Back up this Studio…</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const s = await api.inspect();
          if (s) setBackup(s);
          return null;
        })}>Open a backup…</button>
      </div>

      {backup && (
        <div className="backup-found" aria-label="The backup you opened">
          <p>
            <strong>{backup.studioName}</strong> <span className="muted small">made {backup.created.slice(0, 10)} by Cadrel {backup.app}; {backup.files} files, checked</span>
          </p>
          {backup.projects.length > 0 && (
            <ul className="plain">
              {backup.projects.map((p) => (
                <li key={p}>
                  <span className="grow-text">{p}</span>
                  <button type="button" disabled={busy} onClick={() => void run(async () => {
                    const r = await api.restoreProject(backup.file, p);
                    onChanged?.();
                    return `Restored “${p}” into this Studio as “${r.name}”.`;
                  })}>Restore into this Studio</button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <input aria-label="Name for the restored Studio" placeholder="Name for a new Studio" value={studioName} onChange={(e) => setStudioName(e.target.value)} />
            <button type="button" disabled={busy || !studioName.trim()} onClick={() => void run(async () => {
              await api.restoreAsStudio(backup.file, studioName.trim());
              setBackup(null);
              onChanged?.();
              return `Restored everything as a new Studio called “${studioName.trim()}”. Switch to it from the Studio menu on Home.`;
            })}>Restore everything as a new Studio</button>
          </div>
        </div>
      )}

      <h4>Import from MDEdit</h4>
      <p className="muted small">Choose one MDEdit project folder, or the Root Folder that holds several. Your MDEdit files are copied, not moved or changed.</p>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        const f = await api.findMdedit();
        if (f) setFound(f);
        return null;
      })}>Choose MDEdit projects…</button>
      {found && (
        <ul className="plain" aria-label="Projects found in MDEdit">
          {found.map((c) => (
            <li key={c.source}>
              <span className="grow-text">
                <strong>{c.name}</strong>{c.asName !== c.name ? ` → ${c.asName}` : ''}
                <span className="muted small"> {c.chapterFiles} chapter files, {size(c.bytes)}{c.hasGoal ? ', with a goal' : ''}{c.reviewFiles ? `, ${c.reviewFiles} review files` : ''}</span>
                {c.notCarried.length > 0 && <span className="muted small"> Not carried over: {c.notCarried.join('; ')}.</span>}
                {c.alreadyImportedAs && <span className="muted small"> Already imported as “{c.alreadyImportedAs}”.</span>}
              </span>
              <button type="button" disabled={busy} onClick={() => void run(async () => {
                const r = await api.importMdedit(c.source, { asNewCopy: !!c.alreadyImportedAs });
                setFound((l) => l && l.filter((x) => x.source !== c.source));
                onChanged?.();
                return `Imported “${c.name}” as “${r.name}”. Find it on the Projects page.`;
              })}>{c.alreadyImportedAs ? 'Import another copy' : 'Import'}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
