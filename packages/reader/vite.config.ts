import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Windows app's window. It is Write's editor and review panel (imported from @cadrel/write) with Cadrel Reader's capabilities.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { port: 5175, strictPort: true },
  test: { root: '.', include: ['src/**/*.test.ts', 'electron/**/*.test.ts', 'test/**/*.test.ts'] }
});
