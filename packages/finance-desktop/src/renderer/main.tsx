import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Finance looks like Market (same palette and controls); the design system that would share this is deferred (docs/PLAN.md, M0).
import '@cadrel/market-desktop/src/renderer/styles.css';

createRoot(document.getElementById('root')!).render(<App />);
