/**
 * The LitRPG mechanics ledger: every Level, XP award, stat allocation, class, skill, item, title and companion in a manuscript,
 * kept as an append-only event log per character, with the current state always replayed from that log (never edited by hand).
 *
 * Pure functions over plain data: replaying the log, the consistency checks, and the views built from it. The file and tool
 * plumbing is in trackers.ts.
 */
import { AgentError } from './tools';

export const EVENT_TYPES = [
  'level_up',
  'xp_award',
  'stat_allocation',
  'class_assigned',
  'skill_gained',
  'item_gained',
  'item_lost',
  'title_gained',
  'summon_gained',
  'quest_reward',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface LitrpgEvent {
  /** Assigned when the event is logged ("e17"); a later event can correct it by naming it in `corrects`. */
  id: string;
  type: EventType;
  /** The chapter as the book numbers it (Chapter 1 is 1), not the 0-based index the chapter tools use. */
  chapter: number;
  details: Record<string, unknown>;
  /** The manuscript's exact words, where they matter (ability and item descriptions, stated totals). Never shown on a sheet. */
  source_quote?: string;
  /** Free note about the event. Never shown on a sheet. */
  note?: string;
  /** The id of an earlier event that was extracted wrongly; replaying skips it. */
  corrects?: string;
}

export interface Skill {
  name: string;
  description: string | null;
  cost: string | null;
  cooldown: string | null;
  duration: string | null;
  effect: string | null;
  chapter: number;
}
export interface Item {
  name: string;
  description: string | null;
  holder: string | null;
  chapter: number;
}
export interface Title {
  name: string;
  effect: string | null;
  equipped: boolean | null;
  chapter: number;
}
export interface Summon {
  name: string;
  type: string | null;
  level: number | null;
  xp: number | null;
  chapter: number;
}
export interface ClassState {
  name: string;
  assigned_chapter: number;
  attributes_per_level: string | null;
  class_skills: string[];
}

/** Everything a character is, as of some chapter. Unknown values are `null` or empty, never guessed. */
export interface CharacterState {
  level: number | null;
  xp_total: number | null;
  xp_to_next_level: number | null;
  class: ClassState | null;
  attributes: Record<string, number>;
  skills: Skill[];
  items: Item[];
  titles: Title[];
  summons: Summon[];
  /** Skills that were offered and not taken. They may resurface, so they are kept, but they are not the character's. */
  declined_skills: Skill[];
}

export interface LedgerFlag {
  id: string;
  type: 'arithmetic_mismatch' | 'threshold_contradiction' | 'ability_drift' | 'silent_jump';
  character: string;
  chapters_involved: number[];
  description: string;
  status: 'open' | 'resolved';
}

export interface LitrpgLedger {
  meta: { project: string; last_updated_chapter: number; schema_version: string };
  characters: Record<string, { current_state: CharacterState; event_log: LitrpgEvent[] }>;
  consistency_flags: LedgerFlag[];
}

export const FLAG_TYPES = ['arithmetic_mismatch', 'threshold_contradiction', 'ability_drift', 'silent_jump'] as const;

export const emptyState = (): CharacterState => ({ level: null, xp_total: null, xp_to_next_level: null, class: null, attributes: {}, skills: [], items: [], titles: [], summons: [], declined_skills: [] });
export const emptyLedger = (project: string): LitrpgLedger => ({ meta: { project, last_updated_chapter: 0, schema_version: '1.0' }, characters: {}, consistency_flags: [] });

// ---- reading the loose JSON a model sends -----------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  return out;
};

/** Checks one event a caller wants to log and returns it cleaned. The message says what to fix. */
export function parseEvent(raw: unknown, where: string): Omit<LitrpgEvent, 'id'> {
  if (!isObj(raw)) throw new AgentError(`${where}: an event must be an object with type, chapter and details.`);
  const type = raw.type as EventType;
  if (!EVENT_TYPES.includes(type)) throw new AgentError(`${where}: type must be one of ${EVENT_TYPES.join(', ')}.`);
  const chapter = raw.chapter;
  if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 0) throw new AgentError(`${where}: chapter must be a whole number (the chapter as the book numbers it, so Chapter 1 is 1).`);
  const d = isObj(raw.details) ? raw.details : {};
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new AgentError(`${where} (${type}): ${msg}`);
  };
  const details: Record<string, unknown> = { ...d };
  switch (type) {
    case 'level_up':
      need(typeof d.resulting_level === 'number' && d.resulting_level >= 0, 'details.resulting_level (a number) is required.');
      break;
    case 'xp_award':
      need('amount' in d, 'details.amount is required: the number the text gives, or null when the text implies a gain without a number. Never invent one.');
      need(d.amount === null || typeof d.amount === 'number', 'details.amount must be a number or null.');
      break;
    case 'stat_allocation':
      need(isObj(d.attributes) && Object.keys(numMap(d.attributes)).length > 0, 'details.attributes (attribute name to points added) is required.');
      need(isObj(d.resulting_totals) && Object.keys(numMap(d.resulting_totals)).length > 0, 'details.resulting_totals (attribute name to total after the allocation) is required.');
      details.attributes = numMap(d.attributes);
      details.resulting_totals = numMap(d.resulting_totals);
      break;
    case 'class_assigned':
    case 'skill_gained':
    case 'item_gained':
    case 'item_lost':
    case 'title_gained':
    case 'summon_gained':
      need(str(d.name) !== null, 'details.name is required.');
      break;
    case 'quest_reward':
      need(str(d.quest_name) !== null, 'details.quest_name is required.');
      break;
  }
  const out: Omit<LitrpgEvent, 'id'> = { type, chapter, details };
  if (typeof raw.source_quote === 'string' && raw.source_quote) out.source_quote = raw.source_quote;
  if (typeof raw.note === 'string' && raw.note) out.note = raw.note;
  if (typeof raw.corrects === 'string' && raw.corrects) out.corrects = raw.corrects;
  return out;
}

// ---- replay ---------------------------------------------------------------------------------

/** The character as of `upToChapter` (all events when omitted), replayed from the event log in order. */
export function replay(events: LitrpgEvent[], upToChapter = Infinity): CharacterState {
  const s = emptyState();
  const wrong = new Set(events.filter((e) => e.corrects).map((e) => e.corrects));
  const byName = <T extends { name: string }>(list: T[], item: T) => {
    const i = list.findIndex((x) => x.name.toLowerCase() === item.name.toLowerCase());
    if (i >= 0) list[i] = item;
    else list.push(item);
  };
  for (const e of events) {
    if (e.chapter > upToChapter || wrong.has(e.id)) continue;
    const d = e.details;
    switch (e.type) {
      case 'level_up':
        s.level = num(d.resulting_level);
        if (num(d.xp_to_next_level) !== null) s.xp_to_next_level = num(d.xp_to_next_level);
        break;
      case 'xp_award': {
        const total = num(d.running_total);
        const amount = num(d.amount);
        // A total the text states outranks a sum we work out.
        if (total !== null) s.xp_total = total;
        else if (amount !== null) s.xp_total = (s.xp_total ?? 0) + amount;
        if (num(d.xp_to_next_level) !== null) s.xp_to_next_level = num(d.xp_to_next_level);
        break;
      }
      case 'stat_allocation':
        Object.assign(s.attributes, numMap(d.resulting_totals));
        break;
      case 'class_assigned':
        s.class = {
          name: String(d.name),
          assigned_chapter: e.chapter,
          attributes_per_level: str(d.attributes_per_level),
          class_skills: Array.isArray(d.class_skills) ? d.class_skills.filter((x): x is string => typeof x === 'string') : [],
        };
        break;
      case 'skill_gained': {
        const skill: Skill = { name: String(d.name), description: str(d.description), cost: str(d.cost), cooldown: str(d.cooldown), duration: str(d.duration), effect: str(d.effect), chapter: e.chapter };
        if (d.declined_alternative === true) byName(s.declined_skills, skill);
        else byName(s.skills, skill);
        break;
      }
      case 'item_gained':
        byName(s.items, { name: String(d.name), description: str(d.description), holder: str(d.holder), chapter: e.chapter });
        break;
      case 'item_lost':
        s.items = s.items.filter((i) => i.name.toLowerCase() !== String(d.name).toLowerCase());
        break;
      case 'title_gained':
        byName(s.titles, { name: String(d.name), effect: str(d.effect), equipped: typeof d.equipped === 'boolean' ? d.equipped : null, chapter: e.chapter });
        break;
      case 'summon_gained':
        byName(s.summons, { name: String(d.name), type: str(d.type), level: num(d.level), xp: num(d.xp), chapter: e.chapter });
        break;
      // Quest rewards are logged as their own events (an XP award, an item) and are not applied again here, so nothing counts twice.
    }
  }
  return s;
}

/** The state after each chapter that has events, so a view can show "as of Chapter N" without replaying. */
export function snapshots(events: LitrpgEvent[]): { chapter: number; state: CharacterState }[] {
  return [...new Set(events.map((e) => e.chapter))].sort((a, b) => a - b).map((chapter) => ({ chapter, state: replay(events, chapter) }));
}

/** Recomputes every character's `current_state` from its log. */
export function refresh(ledger: LitrpgLedger): LitrpgLedger {
  for (const c of Object.values(ledger.characters)) c.current_state = replay(c.event_log);
  return ledger;
}

/** The ledger from a file, with the pieces a hand edit or an older file might lack filled in. */
export function normalizeLedger(raw: unknown, project: string): LitrpgLedger {
  const base = emptyLedger(project);
  if (!isObj(raw)) return base;
  const ledger: LitrpgLedger = {
    meta: { ...base.meta, ...(isObj(raw.meta) ? (raw.meta as Partial<LitrpgLedger['meta']>) : {}) },
    characters: {},
    consistency_flags: Array.isArray(raw.consistency_flags) ? (raw.consistency_flags as LedgerFlag[]) : [],
  };
  if (isObj(raw.characters)) {
    for (const [name, c] of Object.entries(raw.characters)) {
      const log = isObj(c) && Array.isArray(c.event_log) ? (c.event_log as LitrpgEvent[]) : [];
      ledger.characters[name] = { current_state: emptyState(), event_log: log.map((e, i) => ({ ...e, id: e.id ?? `e${i + 1}` })) };
    }
  }
  ledger.consistency_flags = ledger.consistency_flags.map((f, i) => ({ ...f, id: f.id ?? `f${i + 1}`, status: f.status === 'resolved' ? 'resolved' : 'open' }));
  return refresh(ledger);
}

// ---- consistency checks ---------------------------------------------------------------------

type NewFlag = Omit<LedgerFlag, 'id' | 'status'>;

/**
 * The checks that can be done by arithmetic and comparison. (Whether the text itself contradicts the ledger, say a stated
 * total that disagrees with what the book showed earlier, is for the reader to flag when logging.)
 */
export function checkCharacter(name: string, events: LitrpgEvent[]): NewFlag[] {
  const flags: NewFlag[] = [];
  const wrong = new Set(events.filter((e) => e.corrects).map((e) => e.corrects));
  const live = events.filter((e) => !wrong.has(e.id));
  const flag = (type: NewFlag['type'], chapters: number[], description: string) => flags.push({ type, character: name, chapters_involved: [...new Set(chapters)].sort((a, b) => a - b), description });
  const nextForLevel = new Map<number, { value: number; chapter: number }>();
  const abilities = new Map<string, Skill & { n: number }>();

  for (let i = 0; i < live.length; i++) {
    const e = live[i];
    const d = e.details;
    const prev = replay(live.slice(0, i));
    if (e.type === 'xp_award') {
      const amount = num(d.amount);
      const total = num(d.running_total);
      if (amount !== null && total !== null && prev.xp_total !== null && total !== prev.xp_total + amount) {
        flag('arithmetic_mismatch', [e.chapter], `The text gives a running XP total of ${total} in chapter ${e.chapter}, but the total before it (${prev.xp_total}) plus this award (${amount}) is ${prev.xp_total + amount}.`);
      }
      if (total !== null && prev.xp_total !== null && total < prev.xp_total) flag('silent_jump', [e.chapter], `XP total goes down from ${prev.xp_total} to ${total} in chapter ${e.chapter} with no event that explains it.`);
    }
    if (e.type === 'level_up') {
      const to = num(d.resulting_level);
      if (to !== null && prev.level !== null && to !== prev.level + 1) {
        flag('silent_jump', [e.chapter], `Level goes from ${prev.level} to ${to} in chapter ${e.chapter}${to > prev.level + 1 ? `, skipping ${to - prev.level - 1} level(s) with no level-up logged` : ''}.`);
      }
    }
    if (e.type === 'stat_allocation') {
      const added = numMap(d.attributes);
      const points = num(d.points_allocated);
      const sum = Object.values(added).reduce((a, b) => a + b, 0);
      if (points !== null && sum !== points) flag('arithmetic_mismatch', [e.chapter], `Chapter ${e.chapter} allocates ${points} stat points, but the attributes listed add up to ${sum}.`);
      for (const [attr, total] of Object.entries(numMap(d.resulting_totals))) {
        const before = prev.attributes[attr];
        const gain = added[attr] ?? 0;
        if (before !== undefined && total !== before + gain) {
          flag('arithmetic_mismatch', [e.chapter], `${attr} is ${total} after chapter ${e.chapter}'s allocation, but it was ${before} and gained ${gain}, which is ${before + gain}.`);
        }
      }
    }
    // The same level should always need the same XP to the next.
    const next = num(d.xp_to_next_level);
    const lvl = e.type === 'level_up' ? num(d.resulting_level) : prev.level;
    if (next !== null && lvl !== null) {
      const seen = nextForLevel.get(lvl);
      if (seen && seen.value !== next) flag('threshold_contradiction', [seen.chapter, e.chapter], `XP to reach the level after ${lvl} is ${seen.value} in chapter ${seen.chapter} and ${next} in chapter ${e.chapter}.`);
      else if (!seen) nextForLevel.set(lvl, { value: next, chapter: e.chapter });
    }
    if (e.type === 'skill_gained' && d.declined_alternative !== true) {
      const skill: Skill = { name: String(d.name), description: str(d.description), cost: str(d.cost), cooldown: str(d.cooldown), duration: str(d.duration), effect: str(d.effect), chapter: e.chapter };
      const key = skill.name.toLowerCase();
      const earlier = abilities.get(key);
      if (earlier) {
        for (const field of ['cost', 'cooldown', 'duration', 'effect'] as const) {
          if (earlier[field] !== null && skill[field] !== null && earlier[field] !== skill[field]) {
            flag('ability_drift', [earlier.chapter, e.chapter], `${skill.name} has ${field} "${earlier[field]}" in chapter ${earlier.chapter} and "${skill[field]}" in chapter ${e.chapter}. If it was upgraded on the page, resolve this flag.`);
          }
        }
      }
      abilities.set(key, { ...skill, n: (earlier?.n ?? 0) + 1 });
    }
  }
  // Events must be in chapter order for a replay to mean anything.
  for (let i = 1; i < events.length; i++) if (events[i].chapter < events[i - 1].chapter) flag('silent_jump', [events[i - 1].chapter, events[i].chapter], `Events are out of chapter order (chapter ${events[i].chapter} after chapter ${events[i - 1].chapter}).`);
  return flags;
}

const flagKey = (f: { type: string; character?: string; chapters_involved: number[]; description: string }) => `${f.type}|${f.character ?? ''}|${f.chapters_involved.join(',')}|${f.description}`;

/** Adds the flags the checks find that the ledger doesn't already have. Returns the new ones. A resolved flag is not raised again. */
export function mergeFlags(ledger: LitrpgLedger, found: NewFlag[]): LedgerFlag[] {
  const have = new Set(ledger.consistency_flags.map(flagKey));
  let n = ledger.consistency_flags.reduce((m, f) => Math.max(m, Number(/^f(\d+)$/.exec(f.id)?.[1] ?? 0)), 0);
  const added: LedgerFlag[] = [];
  for (const f of found) {
    if (have.has(flagKey(f))) continue;
    have.add(flagKey(f));
    const full: LedgerFlag = { ...f, id: `f${++n}`, status: 'open' };
    ledger.consistency_flags.push(full);
    added.push(full);
  }
  return added;
}

export function runChecks(ledger: LitrpgLedger): NewFlag[] {
  return Object.entries(ledger.characters).flatMap(([name, c]) => checkCharacter(name, c.event_log));
}

// ---- logging ---------------------------------------------------------------------------------

export interface CharacterDelta {
  character: string;
  events_added: number;
  level: [number | null, number | null];
  xp_total: [number | null, number | null];
  new_skills: string[];
  new_items: string[];
  new_titles: string[];
  new_summons: string[];
  class: string | null;
}

export function delta(name: string, before: CharacterState, after: CharacterState, added: number): CharacterDelta {
  const fresh = <T extends { name: string }>(a: T[], b: T[]) => b.filter((x) => !a.some((y) => y.name.toLowerCase() === x.name.toLowerCase())).map((x) => x.name);
  return {
    character: name,
    events_added: added,
    level: [before.level, after.level],
    xp_total: [before.xp_total, after.xp_total],
    new_skills: fresh(before.skills, after.skills),
    new_items: fresh(before.items, after.items),
    new_titles: fresh(before.titles, after.titles),
    new_summons: fresh(before.summons, after.summons),
    class: after.class?.name !== before.class?.name ? (after.class?.name ?? null) : null,
  };
}

/** Appends events to characters (creating them), keeping the log in chapter order, and recomputes the states. */
export function appendEvents(ledger: LitrpgLedger, entries: { name: string; events: Omit<LitrpgEvent, 'id'>[] }[]): CharacterDelta[] {
  let n = 0;
  for (const c of Object.values(ledger.characters)) for (const e of c.event_log) n = Math.max(n, Number(/^e(\d+)$/.exec(e.id)?.[1] ?? 0));
  const deltas: CharacterDelta[] = [];
  for (const entry of entries) {
    const existing = ledger.characters[entry.name] ?? (ledger.characters[entry.name] = { current_state: emptyState(), event_log: [] });
    const before = replay(existing.event_log);
    const ids = new Set(existing.event_log.map((e) => e.id));
    const added = entry.events.map((e) => ({ ...e, id: `e${++n}` }) as LitrpgEvent);
    for (const e of added) {
      if (e.corrects && !ids.has(e.corrects)) throw new AgentError(`${entry.name}: corrects "${e.corrects}", but there is no event with that id in this character's log.`);
    }
    // Stable by chapter: events of one chapter keep the order they were logged in.
    existing.event_log = [...existing.event_log, ...added].map((e, i) => ({ e, i })).sort((a, b) => a.e.chapter - b.e.chapter || a.i - b.i).map((x) => x.e);
    existing.current_state = replay(existing.event_log);
    deltas.push(delta(entry.name, before, existing.current_state, added.length));
  }
  return deltas;
}

// ---- a series: what happened in earlier Books --------------------------------------------------

/**
 * This Book's ledger with what happened in the Books before it placed in front, as if at "chapter 0" of this one: a character who ended
 * Book 1 at level 24 starts Book 2 at level 24, and the checks catch a jump between the two. The earlier Books' events keep their order,
 * their ids are prefixed ("b1:e17") so they cannot clash with this Book's, and nothing here is saved: the joined ledger is for reading
 * (state, checks, views). Each Book's own ledger stays as logged, in its own folder.
 */
export function carryLedger(own: LitrpgLedger, earlier: LitrpgLedger[]): LitrpgLedger {
  const out: LitrpgLedger = { meta: { ...own.meta }, characters: {}, consistency_flags: own.consistency_flags.map((f) => ({ ...f })) };
  const names = new Set<string>(Object.keys(own.characters));
  for (const l of earlier) for (const n of Object.keys(l.characters)) names.add(n);
  for (const name of names) {
    const carried: LitrpgEvent[] = [];
    earlier.forEach((l, i) => {
      for (const e of l.characters[name]?.event_log ?? []) {
        carried.push({ ...e, id: `b${i + 1}:${e.id}`, chapter: 0, ...(e.corrects ? { corrects: `b${i + 1}:${e.corrects}` } : {}) });
      }
    });
    out.characters[name] = { current_state: emptyState(), event_log: [...carried, ...(own.characters[name]?.event_log ?? [])] };
  }
  return refresh(out);
}

/**
 * The flags a joined ledger's checks found that concern this Book: those that touch one of its chapters. A flag wholly about an earlier
 * Book belongs to that Book's own ledger, and is not repeated here.
 */
export const flagsForThisBook = <F extends { chapters_involved: number[] }>(flags: F[]): F[] => flags.filter((f) => f.chapters_involved.length === 0 || f.chapters_involved.some((c) => c > 0));

// ---- views ----------------------------------------------------------------------------------

/** One line in plain words for an event, for the feed on the dashboard. */
export function describeEvent(e: LitrpgEvent): string {
  const d = e.details;
  const name = String(d.name ?? '');
  switch (e.type) {
    case 'level_up':
      return `Reached level ${d.resulting_level}${str(d.source) ? ` (${d.source})` : ''}`;
    case 'xp_award':
      return `${num(d.amount) === null ? 'XP gained' : `+${d.amount} XP`}${str(d.source) ? `: ${d.source}` : ''}`;
    case 'stat_allocation':
      return `Spent ${num(d.points_allocated) ?? Object.values(numMap(d.attributes)).reduce((a, b) => a + b, 0)} stat points: ${Object.entries(numMap(d.attributes)).map(([k, v]) => `${k} +${v}`).join(', ')}`;
    case 'class_assigned':
      return `Became ${name}`;
    case 'skill_gained':
      return d.declined_alternative === true ? `Declined skill: ${name}` : `Learned ${name}`;
    case 'item_gained':
      return `Gained ${name}`;
    case 'item_lost':
      return `Lost ${name}`;
    case 'title_gained':
      return `Earned the title ${name}`;
    case 'summon_gained':
      return `Gained companion ${name}`;
    case 'quest_reward':
      return `Quest complete: ${d.quest_name}`;
  }
}

const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined && v !== '';
const pick = <T extends object>(o: T, keys: (keyof T)[]): Partial<T> => Object.fromEntries(keys.filter((k) => present(o[k]) && !(Array.isArray(o[k]) && (o[k] as unknown[]).length === 0)).map((k) => [k, o[k]])) as Partial<T>;

/**
 * What a character sheet may show: the values the book has given, and nothing else. Anything unknown is left out entirely
 * (not shown as a dash), as are empty sections, declined skills, source quotes, notes, flags, and the chapter things came from.
 */
export interface SheetModel {
  name: string;
  as_of_chapter: number | null;
  level?: number;
  xp_total?: number;
  xp_to_next_level?: number;
  class?: { name: string; attributes_per_level?: string; class_skills?: string[] };
  attributes?: { name: string; value: number }[];
  skills?: { name: string; description?: string; cost?: string; cooldown?: string; duration?: string; effect?: string }[];
  items?: { name: string; description?: string }[];
  titles?: { name: string; effect?: string; equipped?: boolean }[];
  companions?: { name: string; type?: string; level?: number; xp?: number }[];
}

export function sheetModel(name: string, s: CharacterState, asOf: number | null): SheetModel {
  const out: SheetModel = { name, as_of_chapter: asOf };
  if (s.level !== null) out.level = s.level;
  if (s.xp_total !== null) out.xp_total = s.xp_total;
  if (s.xp_to_next_level !== null) out.xp_to_next_level = s.xp_to_next_level;
  if (s.class) out.class = pick({ name: s.class.name, attributes_per_level: s.class.attributes_per_level ?? undefined, class_skills: s.class.class_skills }, ['name', 'attributes_per_level', 'class_skills']) as SheetModel['class'];
  const attrs = Object.entries(s.attributes).map(([n, value]) => ({ name: n, value }));
  if (attrs.length) out.attributes = attrs;
  const skills = s.skills.map((k) => pick(k, ['name', 'description', 'cost', 'cooldown', 'duration', 'effect'])) as NonNullable<SheetModel['skills']>;
  if (skills.length) out.skills = skills;
  const items = s.items.map((i) => pick(i, ['name', 'description'])) as NonNullable<SheetModel['items']>;
  if (items.length) out.items = items;
  const titles = s.titles.map((t) => ({ name: t.name, ...(present(t.effect) ? { effect: t.effect } : {}), ...(t.equipped === true ? { equipped: true } : {}) }));
  if (titles.length) out.titles = titles;
  const companions = s.summons.map((c) => pick(c, ['name', 'type', 'level', 'xp'])) as NonNullable<SheetModel['companions']>;
  if (companions.length) out.companions = companions;
  return out;
}

export interface DashboardModel {
  project: string;
  last_updated_chapter: number;
  chapters: number[];
  characters: {
    name: string;
    snapshots: { chapter: number; sheet: SheetModel }[];
    events: { id: string; chapter: number; type: EventType; text: string }[];
  }[];
  flags: { id: string; type: string; character: string; chapters: number[]; description: string; status: string }[];
}

export function dashboardModel(ledger: LitrpgLedger): DashboardModel {
  const chapters = [...new Set(Object.values(ledger.characters).flatMap((c) => c.event_log.map((e) => e.chapter)))].sort((a, b) => a - b);
  return {
    project: ledger.meta.project,
    last_updated_chapter: ledger.meta.last_updated_chapter,
    chapters,
    characters: Object.entries(ledger.characters).map(([name, c]) => ({
      name,
      snapshots: snapshots(c.event_log).map((s) => ({ chapter: s.chapter, sheet: sheetModel(name, s.state, s.chapter) })),
      events: c.event_log.filter((e) => !c.event_log.some((x) => x.corrects === e.id)).map((e) => ({ id: e.id, chapter: e.chapter, type: e.type, text: describeEvent(e) })),
    })),
    flags: ledger.consistency_flags.map((f) => ({ id: f.id, type: f.type, character: f.character, chapters: f.chapters_involved, description: f.description, status: f.status })),
  };
}
