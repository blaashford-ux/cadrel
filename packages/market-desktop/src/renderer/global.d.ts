import type { Api } from '../shared/api.js';

declare global {
  interface Window {
    bookscout: Api & { __opened?: () => Promise<string[]> };
  }
}
export {};
