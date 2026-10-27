import type { FinanceApi } from '../shared/api.js';

declare global {
  interface Window {
    cadrelFinance: FinanceApi & { __opened?: () => Promise<string[]> };
  }
}
export {};
