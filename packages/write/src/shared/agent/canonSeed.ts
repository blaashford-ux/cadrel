/**
 * Proposed canon from what the trackers already hold (docs/M4-PLAN.md, slice 4): a studio with three finished books and ledgers must not start canon
 * from nothing. Pure: it reads parsed ledgers and returns candidates; nothing is written, and nothing here is canon until a person approves a
 * proposal made from it.
 *
 *   - LitRPG ledger: each character becomes an entry (summary from where the character stands now) and each logged event a fact ("Reached level 3",
 *     "Learned Shadow Step") with the Book and chapter it happened in. Events a later event corrects are left out.
 *   - Timeline ledger: each place the days name and each major event becomes an entry; an event's fact says what day it happened on.
 */
import { describeEvent, replay, type LitrpgLedger } from './litrpg';
import type { TimelineLedger } from './timeline';
import type { BookLedgers } from './trackers';

export interface SeedFact {
  text: string;
  /** The Book's key in the ledger (its project id, where the series file has one). */
  book: string;
  chapter: number | null;
}
export interface SeedEntry {
  kind: 'character' | 'place' | 'event';
  name: string;
  summary: string;
  facts: SeedFact[];
}

export const SEED_ENTRY_MAX = 300;
const NAME_MAX = 120;

const shorten = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}…`;
};
const key = (kind: string, name: string) => `${kind}:${name.toLowerCase()}`;

function fromLitrpg(book: string, ledger: LitrpgLedger, into: Map<string, SeedEntry>) {
  for (const [name, c] of Object.entries(ledger.characters ?? {})) {
    const events = c.event_log ?? [];
    const wrong = new Set(events.filter((e) => e.corrects).map((e) => e.corrects));
    const state = replay(events);
    const e = into.get(key('character', name)) ?? { kind: 'character' as const, name: shorten(name, NAME_MAX), summary: '', facts: [] };
    const where = [state.level !== null ? `level ${state.level}` : '', state.class ? state.class.name : ''].filter(Boolean).join(', ');
    e.summary = where ? `A character the LitRPG ledger follows (${where} at the end of the ledger).` : 'A character the LitRPG ledger follows.';
    for (const ev of events) {
      if (ev.corrects || wrong.has(ev.id)) continue;
      const text = `${describeEvent(ev)}.`;
      if (!e.facts.some((f) => f.text === text && f.chapter === ev.chapter && f.book === book)) e.facts.push({ text, book, chapter: ev.chapter });
    }
    into.set(key('character', name), e);
  }
}

function fromTimeline(book: string, t: TimelineLedger, into: Map<string, SeedEntry>) {
  for (const [day, d] of Object.entries(t.days ?? {})) {
    const first = d.chapters?.[0]?.chapter ?? null;
    for (const place of d.locations ?? []) {
      if (!place.trim() || into.has(key('place', place))) continue;
      into.set(key('place', place), { kind: 'place', name: shorten(place, NAME_MAX), summary: 'A place the timeline ledger names.', facts: [] });
    }
    for (const who of d.characters_present ?? []) {
      if (!who.trim() || into.has(key('character', who))) continue;
      into.set(key('character', who), { kind: 'character', name: shorten(who, NAME_MAX), summary: 'A character the timeline ledger names.', facts: [] });
    }
    for (const ev of d.major_events ?? []) {
      if (!ev.trim()) continue;
      const name = shorten(ev, NAME_MAX);
      const k = key('event', name);
      const when = `Day ${day}${d.weekday ? ` (${d.weekday})` : ''}`;
      const e = into.get(k) ?? { kind: 'event' as const, name, summary: `${when}${first !== null ? `, chapter ${first}` : ''}, from the timeline ledger.`, facts: [] };
      const text = `${ev.trim().replace(/[.!?]*$/, '')} happened on day ${day}${d.weekday ? `, a ${d.weekday}` : ''}.`;
      if (!e.facts.some((f) => f.text === text)) e.facts.push({ text, book, chapter: first });
      into.set(k, e);
    }
  }
}

/** The entries (with facts) the ledgers of a series suggest, in a stable order, capped at SEED_ENTRY_MAX with `truncated` saying so. */
export function seedFromLedgers(books: BookLedgers[]): { entries: SeedEntry[]; truncated: boolean } {
  const into = new Map<string, SeedEntry>();
  for (const b of books) if (b.litrpg) fromLitrpg(b.book, b.litrpg, into);
  for (const b of books) if (b.timeline) fromTimeline(b.book, b.timeline, into);
  const order = { character: 0, place: 1, event: 2 } as const;
  const all = [...into.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  return { entries: all.slice(0, SEED_ENTRY_MAX), truncated: all.length > SEED_ENTRY_MAX };
}
