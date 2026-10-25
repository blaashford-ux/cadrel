import type { Page } from '../shared/api';
import { Avatar } from './Avatar';
import { Emblem } from './brand/Emblem';

interface Item {
  page: Page;
  label: string;
  icon: JSX.Element;
}

const svg = (d: string) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const TOP: Item[] = [
  { page: 'home', label: 'Home', icon: svg('M3 11.5 12 4l9 7.5M5.5 10v9.5h5v-5.5h3v5.5h5V10') },
  { page: 'dashboard', label: 'Dashboard', icon: svg('M4 20V10m6 10V4m6 16v-7m4 7H2') },
  { page: 'projects', label: 'Projects', icon: svg('M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-10Z') },
  { page: 'notes', label: 'Notes', icon: svg('M5 4.5h14v11.5l-4 4H5v-15.5ZM15 20v-4h4M8 9h8M8 12.5h5') }
];
const MODULES: Item[] = [
  { page: 'write', label: 'Write', icon: svg('M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Zm9-13 4 4') },
  { page: 'market', label: 'Market', icon: svg('M3 3v18h18M7 15l4-5 3 3 5-7') }
];
const SETTINGS: Item = { page: 'settings', label: 'Settings', icon: svg('M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13.5a7.7 7.7 0 0 0 0-3l1.9-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.3-.9-2 3.4L4.6 10.5a7.7 7.7 0 0 0 0 3l-1.9 1.5 2 3.4 2.3-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.3.9 2-3.4-1.9-1.5Z') };

/** The left rail: where you are, and where else you can go. Studio pages on top, the modules below, settings at the foot. */
export function Rail({ page, onGo }: { page: Page; onGo: (p: Page) => void }) {
  const item = (it: Item) => (
    <li key={it.page}>
      <button type="button" className="rail-btn" aria-label={it.label} aria-current={page === it.page ? 'page' : undefined} title={it.label} onClick={() => onGo(it.page)}>
        {it.icon}
        <span className="rail-label">{it.label}</span>
      </button>
    </li>
  );
  return (
    <nav className="rail" aria-label="Cadrel">
      <div className="rail-mark" role="img" aria-label="Cadrel">
        <span className="mark-tile"><Emblem size={30} /></span>
      </div>
      <ul>{TOP.map(item)}</ul>
      <hr className="rail-sep" />
      <ul>{MODULES.map(item)}</ul>
      <ul className="rail-foot">
        <li>
          <button type="button" className="rail-btn" aria-label="Profile" aria-current={page === 'profile' ? 'page' : undefined} title="Your profile" onClick={() => onGo('profile')}>
            <Avatar size={26} />
            <span className="rail-label">Profile</span>
          </button>
        </li>
        {item(SETTINGS)}
      </ul>
    </nav>
  );
}
