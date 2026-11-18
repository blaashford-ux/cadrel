import { describe, expect, it } from 'vitest';
import { seedFromLedgers, SEED_ENTRY_MAX } from './canonSeed';
import { emptyLedger, type LitrpgLedger } from './litrpg';
import { emptyDay, emptyTimeline, type TimelineLedger } from './timeline';
import type { BookLedgers } from './trackers';

const litrpg = (): LitrpgLedger => {
  const l = emptyLedger('Book One');
  l.characters['Mara'] = {
    current_state: l.characters['Mara']?.current_state as never,
    event_log: [
      { id: 'e1', type: 'level_up', chapter: 2, details: { resulting_level: 2, source: 'the ford' } },
      { id: 'e2', type: 'skill_gained', chapter: 3, details: { name: 'Shadow Step' } },
      { id: 'e3', type: 'item_gained', chapter: 3, details: { name: 'Rusty Key' } },
      { id: 'e4', type: 'item_gained', chapter: 3, details: { name: 'Rusty Kye' } }, // a typo...
      { id: 'e5', type: 'item_lost', chapter: 4, details: { name: 'Rusty Kye' }, corrects: 'e4' } // ...corrected: neither is canon material
    ]
  } as never;
  return l;
};
const timeline = (): TimelineLedger => {
  const t = emptyTimeline('Book One');
  t.days['1'] = { ...emptyDay(), chapters: [{ chapter: 1, mode: 'full_scene' }], locations: ['Harrow'], characters_present: ['Mara', 'Ned'], major_events: ['The battle of Harrow'], weekday: 'Monday' };
  t.days['2'] = { ...emptyDay(), chapters: [{ chapter: 2, mode: 'full_scene' }], locations: ['Harrow', 'The ford'], characters_present: ['Mara'], major_events: ['Mara crosses the ford.'] };
  return t;
};
const book = (o: Partial<BookLedgers> = {}): BookLedgers => ({ book: 'b1', name: 'Book One', litrpg: litrpg(), timeline: timeline(), ...o });

describe('canon proposed from the tracker ledgers', () => {
  it('makes a character of each tracked one, with a fact for each logged event, in its book and chapter', () => {
    const { entries } = seedFromLedgers([book({ timeline: null })]);
    expect(entries).toHaveLength(1);
    const mara = entries[0]!;
    expect(mara).toMatchObject({ kind: 'character', name: 'Mara' });
    expect(mara.facts.map((f) => [f.text, f.book, f.chapter])).toEqual([
      ['Reached level 2 (the ford).', 'b1', 2],
      ['Learned Shadow Step.', 'b1', 3],
      ['Gained Rusty Key.', 'b1', 3]
    ]);
  });

  it('leaves out an event that a later event corrects, and the correcting event itself', () => {
    const facts = seedFromLedgers([book({ timeline: null })]).entries[0]!.facts.map((f) => f.text);
    expect(facts.some((t) => /Kye/.test(t))).toBe(false);
  });

  it('makes places and events from the timeline, naming the day, and does not duplicate a character the LitRPG ledger already has', () => {
    const { entries } = seedFromLedgers([book()]);
    expect(entries.filter((e) => e.kind === 'character').map((e) => e.name)).toEqual(['Mara', 'Ned']);
    expect(entries.filter((e) => e.kind === 'place').map((e) => e.name)).toEqual(['Harrow', 'The ford']);
    const battle = entries.find((e) => e.name === 'The battle of Harrow')!;
    expect(battle).toMatchObject({ kind: 'event', summary: 'Day 1 (Monday), chapter 1, from the timeline ledger.' });
    expect(battle.facts).toEqual([{ text: 'The battle of Harrow happened on day 1, a Monday.', book: 'b1', chapter: 1 }]);
    expect(entries.find((e) => e.name === 'Mara crosses the ford.')!.facts[0]!.text).toBe('Mara crosses the ford happened on day 2.');
  });

  it('merges a character across books by name, keeping each fact’s book', () => {
    const second = litrpg();
    second.characters['mara'] = { ...second.characters['Mara']!, event_log: [{ id: 'e1', type: 'level_up', chapter: 5, details: { resulting_level: 4 } }] } as never;
    delete second.characters['Mara'];
    const { entries } = seedFromLedgers([book({ timeline: null }), { book: 'b2', name: 'Book Two', litrpg: second, timeline: null }]);
    const mara = entries.filter((e) => e.kind === 'character');
    expect(mara).toHaveLength(1); // "Mara" and "mara" are the same character
    expect(mara[0]!.facts.map((f) => [f.book, f.chapter, f.text])).toEqual([['b1', 2, 'Reached level 2 (the ford).'], ['b1', 3, 'Learned Shadow Step.'], ['b1', 3, 'Gained Rusty Key.'], ['b2', 5, 'Reached level 4.']]);
  });

  it('is empty for ledgers with nothing in them, and caps a huge ledger', () => {
    expect(seedFromLedgers([])).toEqual({ entries: [], truncated: false });
    const t = emptyTimeline('x');
    for (let i = 1; i <= SEED_ENTRY_MAX + 20; i++) t.days[String(i)] = { ...emptyDay(), chapters: [{ chapter: i, mode: 'full_scene' }], major_events: [`Event number ${i}`] };
    const r = seedFromLedgers([{ book: 'b', name: 'B', litrpg: null, timeline: t }]);
    expect(r.entries).toHaveLength(SEED_ENTRY_MAX);
    expect(r.truncated).toBe(true);
  });
});
