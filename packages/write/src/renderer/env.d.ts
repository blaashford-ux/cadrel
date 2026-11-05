/// <reference types="vite/client" />

/** Present only when Write runs inside Cadrel: the Project and Book Cadrel is showing (read-only; Cadrel's own page changes it). */
interface Window {
  cadrelScope?: {
    get(): Promise<import('../shared/scope').WriteScope>;
    onChange(cb: (scope: import('../shared/scope').WriteScope) => void): () => void;
  };
}
