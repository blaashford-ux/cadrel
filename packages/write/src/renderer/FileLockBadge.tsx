import { Icon } from './Icon';
import type { FileLock } from '../shared/api';

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};

/** What the check-out icon says for a file: null where the file has no check-out (not in a vault), so nothing is drawn. */
export function lockBadge(lock: FileLock | undefined): { icon: 'lock' | 'unlock'; cls: string; text: string } | null {
  if (!lock || lock.kind === 'unmanaged') return null;
  switch (lock.kind) {
    case 'free':
      return { icon: 'unlock', cls: 'in', text: `Checked in (version ${lock.version})` };
    case 'mine':
      return { icon: 'lock', cls: 'mine', text: `Checked out by you${lock.since ? ` since ${day(lock.since)}` : ''}${lock.changed ? ' · changed' : ''}` };
    case 'other':
      return { icon: 'lock', cls: 'other', text: `Checked out by ${lock.by}${lock.since ? ` since ${day(lock.since)}` : ''}` };
    case 'unprotected':
      return { icon: 'lock', cls: 'other', text: 'Changed without a check-out' };
  }
}

/** A small padlock: open when the file is checked in, closed when someone has it checked out. Hover says who. */
export function FileLockBadge({ lock }: { lock: FileLock | undefined }) {
  const b = lockBadge(lock);
  if (!b) return null;
  return (
    <span className={`lock-badge ${b.cls}`} title={b.text} aria-label={b.text} role="img">
      <Icon name={b.icon} size={13} />
    </span>
  );
}
