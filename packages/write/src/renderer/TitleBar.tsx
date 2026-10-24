import { useEffect, useState } from 'react';
import type { WindowInfo } from '../shared/api';
import logo from './logo.png';
import { MenuBar } from './MenuBar';

interface Props {
  /** What is open, e.g. "Chapter 3 — book.md". */
  title: string;
  dirty: boolean;
}

const control = (action: 'minimize' | 'maximize' | 'close') => window.mdedit.windowControl(action);

/** The window's own title bar: logo, menus, the open document, and (off Windows) the window buttons. */
export function TitleBar({ title, dirty }: Props) {
  const [info, setInfo] = useState<WindowInfo | null>(null);
  useEffect(() => {
    void window.mdedit.windowInfo().then(setInfo);
    return window.mdedit.onWindowState(setInfo);
  }, []);

  return (
    <header className="titlebar" onDoubleClick={(e) => e.target === e.currentTarget && control('maximize')}>
      <div className="tb-left">
        <img className="tb-logo" src={logo} alt="" width={20} height={20} />
        <span className="wordmark">MDEdit</span>
        <MenuBar />
      </div>
      <div className="tb-title" title={title} onDoubleClick={() => control('maximize')}>
        <span className="tb-title-text">{title}</span>
        {dirty && <span className="dirty" aria-label="unsaved changes"> ●</span>}
      </div>
      {info && !info.overlay && (
        <div className="tb-controls" role="group" aria-label="Window controls">
          <button type="button" className="tb-btn" aria-label="Minimize" title="Minimize" onClick={() => control('minimize')}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
          <button type="button" className="tb-btn" aria-label={info.maximized ? 'Restore' : 'Maximize'} title={info.maximized ? 'Restore' : 'Maximize'} onClick={() => control('maximize')}>
            {info.maximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2.5" y="4" width="5.5" height="5.5" rx="1" /><path d="M4.5 4V3a1 1 0 0 1 1-1H9a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H8" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" /></svg>
            )}
          </button>
          <button type="button" className="tb-btn close" aria-label="Close" title="Close" onClick={() => control('close')}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="m2.5 2.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
        </div>
      )}
    </header>
  );
}
