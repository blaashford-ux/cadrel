import type { CadrelApi } from '../shared/api';

declare global {
  interface Window {
    cadrel: CadrelApi;
  }
}
export {};
