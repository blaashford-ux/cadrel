import { useEffect, useRef, useState } from 'react';
import type { CoverKind } from '../../shared/cover/doc';

/** What can be created. Each entry may have sub-entries; more kinds (banner, ad) are added here as data. */
export interface CreateEntry {
  id: string;
  label: string;
  /** What choosing a leaf does. */
  make?: CoverKind;
  children?: CreateEntry[];
}
export const CREATE_ENTRIES: readonly CreateEntry[] = [
  { id: 'cover', label: 'Cover', children: [{ id: 'ebook', label: 'eBook', make: 'ebook' }, { id: 'paperback', label: 'Paperback', make: 'paperback' }] }
];

/** "Create asset" as a button that opens a short menu: Cover, with eBook and Paperback under it. */
export function CreateAssetMenu({ onCreate, disabled }: { onCreate: (kind: CoverKind) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  const choose = (e: CreateEntry) => {
    if (e.children) return setSub(sub === e.id ? null : e.id);
    if (e.make) { setOpen(false); setSub(null); onCreate(e.make); }
  };
  const list = (entries: readonly CreateEntry[], depth: number): JSX.Element => (
    <ul role="menu" className={depth ? 'cam-sub' : 'cam-list'}>
      {entries.map((e) => (
        <li key={e.id} role="none">
          <button type="button" role="menuitem" aria-haspopup={e.children ? 'menu' : undefined} aria-expanded={e.children ? sub === e.id : undefined} onClick={() => choose(e)}>
            {e.label}{e.children ? <span aria-hidden="true"> ▸</span> : null}
          </button>
          {e.children && sub === e.id && list(e.children, depth + 1)}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="cam" ref={root}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>Create asset <span aria-hidden="true">▾</span></button>
      {open && list(CREATE_ENTRIES, 0)}
    </div>
  );
}
