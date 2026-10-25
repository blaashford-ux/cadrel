import { useCallback, useEffect, useState } from 'react';
import type { NoteView } from '@cadrel/kernel';
import { NotesPanel } from '@cadrel/ui';

/**
 * "Notes" beside a category or a book: the same Notes panel as everywhere in Cadrel, kept with the studio's projects. Only shown
 * when Cadrel hosts this page (a standalone Cadrel Market has nowhere to keep them).
 */
export function NotesButton({ kind, id, label }: { kind: 'category' | 'book'; id: string; label: string }) {
  const host = window.cadrelMarket.hostNotes;
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(() => host?.list({ kind, id }).then(setNotes, () => setNotes([])), [host, kind, id]);
  useEffect(() => {
    void host?.available().then(setAvailable);
  }, [host]);
  useEffect(() => {
    setOpen(false);
    if (available) void load();
  }, [available, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!host || !available) return null;
  const act = async (job: () => Promise<unknown>) => {
    setErr('');
    try {
      await job();
      await load();
      return { ok: true };
    } catch (e) {
      setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return { ok: false };
    }
  };
  const openCount = notes.filter((n) => n.status === 'open').length;

  return (
    <span className="cn-pop-wrap">
      <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        Notes{openCount > 0 && <span className="cn-count">{openCount}</span>}
      </button>
      {open && (
        <div className="cn-pop" role="dialog" aria-label={`Notes on ${label}`}>
          <h4>Notes on {label}</h4>
          {err && <div className="err" role="alert">{err}</div>}
          <NotesPanel
            notes={notes}
            addTo={{ label }}
            act={act}
            api={{
              add: (o) => host.add({ kind, id, label, ...o }),
              setStatus: host.setStatus,
              reply: host.reply,
              remove: host.remove
            }}
          />
        </div>
      )}
    </span>
  );
}
