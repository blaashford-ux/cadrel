import { defineConfig } from 'vitest/config';

// The end-to-end files each launch a real Electron app. Run side by side on a CI runner they starve each other
// and the first window of one of them never shows (nav.rail times out), so run the files one after another.
export default defineConfig({ test: { fileParallelism: false } });
