import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@cadrel/ui/src/notes.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
