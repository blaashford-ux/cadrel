import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BookRow, CategorySummary, QueueItem } from '@cadrel/market-library';
import type { Api } from '../shared/api.js';

/**
 * Market inside Cadrel shows only the Market categories assigned to the Project Cadrel is showing, with a switch to see all of them
 * (docs/UI-MODEL.md). Cadrel tells it the scope through `window.cadrelScope`; Market on its own has none and shows everything. Nothing is
 * filtered in the library: the scope only decides which categories these pages ask for.
 */
export interface MarketScope {
  project: string | null;
  projectName: string | null;
  bookName: string | null;
  links: { module: string; ref: string }[];
}

declare global {
  interface Window {
    cadrelScope?: { get(): Promise<MarketScope>; onChange(cb: (s: MarketScope) => void): () => void };
  }
}

export type ScopeMode = 'project' | 'all';
export interface ScopeState {
  /** Cadrel has a Project to scope to (false for Market on its own, or a Studio with no projects). */
  available: boolean;
  mode: ScopeMode;
  setMode(m: ScopeMode): void;
  /** The category keys in scope, or null when everything is shown. */
  keys: string[] | null;
  /** The Project (and Book) being shown. */
  title: string;
  /** Changes whenever what is shown changes, so a page can start again. */
  token: string;
}

const NONE: ScopeState = { available: false, mode: 'all', setMode: () => undefined, keys: null, title: '', token: 'all' };
const Ctx = createContext<ScopeState>(NONE);
export const useMarketScope = (): ScopeState => useContext(Ctx);

/** The category keys a scope assigns to Market (each once). */
export const categoryKeys = (scope: MarketScope): string[] => [...new Set(scope.links.filter((l) => l.module === 'market').map((l) => l.ref))];

const STORE = 'cadrel.market.scope';
const readMode = (): ScopeMode => {
  try {
    return localStorage.getItem(STORE) === 'all' ? 'all' : 'project';
  } catch {
    return 'project';
  }
};

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<MarketScope | null>(null);
  const [mode, setModeState] = useState<ScopeMode>(readMode);
  useEffect(() => {
    const bridge = window.cadrelScope;
    if (!bridge) return;
    let live = true;
    void bridge.get().then((s) => live && setScope(s), () => undefined);
    const off = bridge.onChange((s) => live && setScope(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  const value = useMemo<ScopeState>(() => {
    if (!scope?.project) return NONE;
    const keys = mode === 'project' ? categoryKeys(scope) : null;
    return {
      available: true,
      mode,
      setMode: (m) => {
        setModeState(m);
        try {
          localStorage.setItem(STORE, m);
        } catch {
          /* the choice just is not remembered */
        }
      },
      keys,
      title: scope.bookName ? `${scope.projectName}: ${scope.bookName}` : scope.projectName ?? '',
      token: `${scope.project}|${mode}|${keys?.join(',') ?? ''}`
    };
  }, [scope, mode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The categories of a list that are in scope (all of them with no scope). */
export const scopedCategories = <C extends { key: string }>(cats: C[], keys: string[] | null): C[] => (keys ? cats.filter((c) => keys.includes(c.key)) : cats);

/** One call per category in scope, results joined (a book or queue entry once, in the order found). */
async function perKey<T>(keys: string[], one: (key: string) => Promise<T[]>, id: (t: T) => string): Promise<T[]> {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const k of keys) for (const t of await one(k)) if (!seen.has(id(t))) (seen.add(id(t)), out.push(t));
  return out;
}

/** Library books: the chosen category, or (none chosen) the books of every category in scope. */
export function scopedBooks(api: Api, keys: string[] | null, opts: { categoryKey?: string; search?: string }): Promise<BookRow[]> {
  if (!keys || opts.categoryKey) return api.books(opts);
  return perKey(keys, (k) => api.books({ ...opts, categoryKey: k }), (b) => b.asin);
}

/** The capture queue: the chosen category, or (none chosen) every category in scope. Books known only from searches belong to none. */
export function scopedQueue(api: Api, keys: string[] | null, opts: { categoryKey?: string; includeSkipped?: boolean; onlyNew?: boolean }): Promise<QueueItem[]> {
  if (!keys || opts.categoryKey) return api.queue(opts);
  return perKey(keys, (k) => api.queue({ ...opts, categoryKey: k }), (i) => i.asin);
}

/** The next book to open: in the chosen category, or in the first category in scope that has one waiting. */
export async function scopedOpenNext(api: Api, keys: string[] | null, categoryKey: string | undefined, onlyNew: boolean): Promise<QueueItem | null> {
  if (!keys || categoryKey) return api.openNext(categoryKey, onlyNew);
  for (const k of keys) {
    const it = await api.openNext(k, onlyNew);
    if (it) return it;
  }
  return null;
}

/** Books taken out of a category's lists: the chosen one, or every category in scope. */
export async function scopedExclusions<E extends { categoryKey?: string; asin: string }>(fetch: (key?: string) => Promise<E[]>, keys: string[] | null, categoryKey: string | undefined): Promise<E[]> {
  if (!keys || categoryKey) return fetch(categoryKey);
  return perKey(keys, (k) => fetch(k), (e) => `${e.categoryKey ?? ''}|${e.asin}`);
}

export type { CategorySummary };
