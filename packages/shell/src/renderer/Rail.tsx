import type { Page } from '../shared/api';

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

const ITEMS: Item[] = [
  { page: 'home', label: 'Home', icon: svg('M3 11.5 12 4l9 7.5M5.5 10v9.5h5v-5.5h3v5.5h5V10') },
  { page: 'dashboard', label: 'Dashboard', icon: svg('M4 20V10m6 10V4m6 16v-7m4 7H2') },
  { page: 'write', label: 'Write', icon: svg('M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Zm9-13 4 4') },
  { page: 'market', label: 'Market', icon: svg('M3 3v18h18M7 15l4-5 3 3 5-7') }
];

/** The left rail: where you are, and where else you can go. */
export function Rail({ page, onGo }: { page: Page; onGo: (p: Page) => void }) {
  return (
    <nav className="rail" aria-label="Cadrel">
      <div className="rail-mark" aria-hidden>
        C
      </div>
      <ul>
        {ITEMS.map((it) => (
          <li key={it.page}>
            <button type="button" className="rail-btn" aria-label={it.label} aria-current={page === it.page ? 'page' : undefined} title={it.label} onClick={() => onGo(it.page)}>
              {it.icon}
              <span className="rail-label">{it.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
