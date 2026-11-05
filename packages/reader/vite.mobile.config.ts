import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The phone's web bundle (loaded by the Capacitor Android shell). The Windows bundle is built by vite.config.ts.
export default defineConfig({
  root: 'src/mobile',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist-mobile', emptyOutDir: true, target: 'es2022' },
  server: { port: 5176, strictPort: true }
});
