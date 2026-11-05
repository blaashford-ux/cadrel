import { createRoot } from 'react-dom/client';
import { App } from '@cadrel/write/src/renderer/App';

// window.cadrelWrite is set by the preload script with Cadrel Reader's capabilities (the window is opened with --cadrel-reader).
createRoot(document.getElementById('root')!).render(<App />);
