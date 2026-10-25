import type { NoteStatus, NoteView } from '@cadrel/kernel';
import type { Api } from '../shared/api.js';

/** Cadrel's notes for a Market record (a category or a book); present only when the page is hosted by Cadrel. */
export interface HostNotes {
  available(): Promise<boolean>;
  list(record: { kind: string; id: string }): Promise<NoteView[]>;
  add(o: { kind: string; id: string; label: string; body: string; category?: string }): Promise<unknown>;
  setStatus(id: string, status: NoteStatus): Promise<unknown>;
  reply(id: string, body: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

declare global {
  interface Window {
    cadrelMarket: Api & { __opened?: () => Promise<string[]>; hostNotes?: HostNotes };
  }
}
export {};
