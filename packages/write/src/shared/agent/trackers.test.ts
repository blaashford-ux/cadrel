import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { checkKeywords } from './keywords';
import { replay, type LitrpgEvent } from './litrpg';
import { buildTrackerView, checkTracker, litrpgLog, litrpgState, timelineLog, type ViewTemplates } from './trackers';
import { AgentError, type AgentContext } from './tools';

const templates: ViewTemplates = { chapter: '<title>__CADREL_TITLE__</title><script id="data">__CADREL_DATA__</script>', timeline: '<title>__CADREL_TITLE__</title><script id="data">__CADREL_DATA__</script>', litrpg: '<script>__CADREL_DATA__</script>', sheet: '<title>__CADREL_TITLE__</title><script>__CADREL_DATA__</script>' };
const setup = () => {
  const fs = new MemoryFs();
  fs.seed('/books/Novel/.cadrel/project.json', '{}');
  const ctx: AgentContext = { fs, root: '/books', agent: 'claude', agentName: 'Claude' };
  return { fs, ctx };
};
const ev = (type: string, chapter: number, details: Record<string, unknown>) => ({ type, chapter, details });
const fails = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(AgentError);
  expect((e as Error).message).toMatch(re);
};
const sean = [
  ev('class_assigned', 2, { name: 'Warden', attributes_per_level: '5 points' }),
  ev('xp_award', 3, { amount: 400, running_total: 400, xp_to_next_level: 600 }),
  ev('level_up', 4, { resulting_level: 2 }),
  ev('stat_allocation', 4, { points_allocated: 5, attributes: { Strength: 3, Agility: 2 }, resulting_totals: { Strength: 13, Agility: 12 } }),
  ev('skill_gained', 5, { name: 'Ember Lance', cost: '30 Mana', effect: 'Fire.' }),
  ev('skill_gained', 5, { name: 'Frost Veil', declined_alternative: true }),
  ev('item_gained', 7, { name: 'Cloak', description: '+2 Agility' }),
  ev('item_lost', 9, { name: 'Cloak' }),
];

describe('the LitRPG ledger', () => {
  it('logs events, replays each character, and says only what changed', async () => {
    const { ctx } = setup();
    const r = await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] });
    expect(r.changes[0]).toMatchObject({ character: 'Sean', events_added: 8, level: [null, 2], xp_total: [null, 400], new_skills: ['Ember Lance'], class: 'Warden' });
    expect(r.new_flags).toEqual([]);
    expect(r.last_updated_chapter).toBe(9);
    const st = await litrpgState(ctx, 'Novel', { character: 'sean' });
    const s = st.characters[0].state;
    expect(s.attributes).toEqual({ Strength: 13, Agility: 12 });
    expect(s.items).toEqual([]); // lost in chapter 9
    expect(s.declined_skills.map((k) => k.name)).toEqual(['Frost Veil']);
    expect(s.skills.map((k) => k.name)).toEqual(['Ember Lance']);
  });

  it('answers as of a chapter by stopping the replay early', async () => {
    const { ctx } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] });
    const s = (await litrpgState(ctx, 'Novel', { character: 'Sean', as_of_chapter: 6 })).characters[0].state;
    expect(s.level).toBe(2);
    expect(s.items).toEqual([]);
    expect((await litrpgState(ctx, 'Novel', { character: 'Sean', as_of_chapter: 7 })).characters[0].state.items.map((i) => i.name)).toEqual(['Cloak']);
    expect((await litrpgState(ctx, 'Novel', { character: 'Sean', as_of_chapter: 3 })).characters[0].state.level).toBeNull();
  });

  it('refuses a bad event and saves nothing', async () => {
    const { ctx, fs } = setup();
    await fails(litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('level_up', 1, { resulting_level: 2 }), ev('xp_award', 2, { source: 'x' })] }] }), /amount is required/);
    expect(await fs.stat('/books/Novel/Tracking/LitRPG Ledger.json')).toBeNull();
    await fails(litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('nonsense', 1, {})] }] }), /type must be one of/);
  });

  it('finds the arithmetic by itself, once, and keeps a resolved flag resolved', async () => {
    const { ctx } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] });
    const r = await litrpgLog(ctx, 'Novel', {
      characters: [{ name: 'Sean', events: [ev('xp_award', 11, { amount: 1200, running_total: 3100 }), ev('level_up', 11, { resulting_level: 4 }), ev('stat_allocation', 11, { points_allocated: 5, attributes: { Strength: 2, Agility: 2 }, resulting_totals: { Strength: 15, Agility: 14 } })] }],
    });
    const kinds = r.new_flags.map((f) => f.type).sort();
    expect(kinds).toEqual(['arithmetic_mismatch', 'arithmetic_mismatch', 'silent_jump']);
    const again = await checkTracker(ctx, 'Novel', 'litrpg');
    expect(again.new_flags).toEqual([]);
    expect(again.open_flags).toHaveLength(3);
    const id = again.open_flags[0].id;
    const res = await litrpgLog(ctx, 'Novel', { resolve_flags: [id] });
    expect(res.open_flags).toBe(2);
    expect((await checkTracker(ctx, 'Novel', 'litrpg')).open_flags).toHaveLength(2);
  });

  it('flags a skill whose numbers change, and lets a correction replace a wrong event', async () => {
    const { ctx } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('skill_gained', 5, { name: 'Ember Lance', cost: '30 Mana' }), ev('xp_award', 6, { amount: 100 })] }] });
    const r = await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('skill_gained', 9, { name: 'Ember Lance', cost: '50 Mana' })] }] });
    expect(r.new_flags.map((f) => f.type)).toEqual(['ability_drift']);
    const log = JSON.parse(await ctx.fs.readText('/books/Novel/Tracking/LitRPG Ledger.json')).characters.Sean.event_log as LitrpgEvent[];
    const wrong = log.find((e) => e.type === 'xp_award')!;
    expect(replay(log).xp_total).toBe(100);
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [{ ...ev('xp_award', 6, { amount: 10 }), corrects: wrong.id }] }] });
    expect((await litrpgState(ctx, 'Novel', {})).characters[0].state.xp_total).toBe(10);
    await fails(litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [{ ...ev('xp_award', 6, { amount: 1 }), corrects: 'e999' }] }] }), /no event with that id/);
  });

  it('keeps the earlier version of the ledger before each change', async () => {
    const { ctx, fs } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('level_up', 1, { resulting_level: 1 })] }] });
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('level_up', 2, { resulting_level: 2 })] }] });
    expect((await fs.readdir('/books/Novel/.cadrel/previous')).length).toBe(1);
  });

  it('refuses to answer from a ledger that does not exist', async () => {
    const { ctx } = setup();
    await fails(litrpgState(ctx, 'Novel', {}), /no LitRPG ledger/);
    await fails(buildTrackerView(ctx, 'Novel', { view: 'litrpg' }, templates), /no LitRPG ledger/);
  });
});

describe('the character sheet', () => {
  it('holds only known values: no nulls, no empty sections, no notes, quotes, flags or declined skills', async () => {
    const { ctx, fs } = setup();
    await litrpgLog(ctx, 'Novel', {
      characters: [{ name: 'Sean', events: [{ ...ev('skill_gained', 5, { name: 'Ember Lance', description: 'Hurl flame.', cost: '30 Mana', cooldown: null, duration: null }), source_quote: 'SECRET QUOTE', note: 'SECRET NOTE' }, ev('skill_gained', 5, { name: 'Frost Veil', declined_alternative: true }), ev('level_up', 5, { resulting_level: 2 }), ev('xp_award', 6, { amount: null, source: 'implied' })] }],
      flags: [{ type: 'silent_jump', character: 'Sean', chapters_involved: [5], description: 'SECRET FLAG' }],
    });
    const r = (await buildTrackerView(ctx, 'Novel', { view: 'character_sheet', character: 'Sean', return_html: true }, templates)) as { file: string; html: string };
    expect(r.file).toBe('Tracking/Character Sheets/Sean.html');
    const data = JSON.parse(/<script>([\s\S]*)<\/script>/.exec(r.html)![1]);
    expect(data).toEqual({ name: 'Sean', as_of_chapter: 6, level: 2, skills: [{ name: 'Ember Lance', description: 'Hurl flame.', cost: '30 Mana' }] });
    expect(r.html).not.toMatch(/SECRET|Frost|null|attributes|items/);
    expect(await fs.readText('/books/Novel/Tracking/Character Sheets/Sean.html')).toBe(r.html);
  });

  it('can be drawn as of an earlier chapter, for one character or all', async () => {
    const { ctx } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }, { name: 'Juna', events: [ev('level_up', 6, { resulting_level: 1 })] }] });
    const r = (await buildTrackerView(ctx, 'Novel', { view: 'character_sheet', character: 'Sean', as_of_chapter: 4, return_html: true }, templates)) as { file: string; html: string };
    expect(r.file).toBe('Tracking/Character Sheets/Sean (Chapter 4).html');
    expect(JSON.parse(/<script>([\s\S]*)<\/script>/.exec(r.html)![1])).toMatchObject({ as_of_chapter: 4, level: 2, attributes: [{ name: 'Strength', value: 13 }, { name: 'Agility', value: 12 }] });
    const all = (await buildTrackerView(ctx, 'Novel', { view: 'character_sheet', character: 'all' }, templates)) as { files: unknown[] };
    expect(all.files).toHaveLength(2);
    await fails(buildTrackerView(ctx, 'Novel', { view: 'character_sheet' }, templates), /Say which character/);
    await fails(buildTrackerView(ctx, 'Novel', { view: 'character_sheet', character: 'Nobody' }, templates), /no character/);
  });

  it('cannot be broken out of by what a character is called', async () => {
    const { ctx } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: '</script><b>x', events: [ev('level_up', 1, { resulting_level: 1 })] }] });
    const r = (await buildTrackerView(ctx, 'Novel', { view: 'litrpg', return_html: true }, templates)) as { html: string };
    expect(r.html).not.toMatch(/<\/script><b>/);
  });
});

describe('the timeline ledger', () => {
  const day = (n: number, chapters: number[], extra: Record<string, unknown> = {}) => ({ day: n, chapters: chapters.map((chapter) => ({ chapter })), ...extra });

  it('merges what is logged and finds contradictions by arithmetic', async () => {
    const { ctx } = setup();
    const r = await timelineLog(ctx, 'Novel', {
      days: [
        day(1, [1], { weekday: 'Monday', locations: ['School'], calendar_claims: [{ quote: 'Monday night', source_chapter: 1 }] }),
        day(2, [2], { elapsed_time_claims: [{ quote: 'the next morning', source_chapter: 2, days: 1, since_day: 1 }] }),
        day(5, [3], { weekday: 'Thursday', elapsed_time_claims: [{ quote: 'a day later', source_chapter: 3, days: 1, since_day: 2 }] }),
        day(9, [4]),
      ],
    });
    const types = r.new_flags.map((f) => f.type).sort();
    expect(types).toEqual(['day_of_week_contradiction', 'overlapping_days', 'untracked_gap']);
    expect(r.new_flags.find((f) => f.type === 'overlapping_days')!.quotes).toEqual([{ quote: 'a day later', chapter: 3 }]);
    const again = await timelineLog(ctx, 'Novel', { days: [day(1, [1], { locations: ['School', 'Gym'] })] });
    expect(again.new_flags).toEqual([]);
    const ledger = JSON.parse(await ctx.fs.readText('/books/Novel/Tracking/Timeline Ledger.json'));
    expect(ledger.days['1'].locations).toEqual(['School', 'Gym']);
    expect(ledger.days['1'].calendar_claims).toHaveLength(1);
  });

  it('lets a chapter that runs backwards through the days be a flashback, but not otherwise', async () => {
    const { ctx } = setup();
    const r = await timelineLog(ctx, 'Novel', { days: [day(10, [1]), day(3, [2])] });
    expect(r.new_flags.map((f) => f.type)).toContain('overlapping_days');
    const { ctx: c2 } = setup();
    const ok = await timelineLog(c2, 'Novel', { days: [day(10, [1]), { day: 3, chapters: [{ chapter: 2, flashback: true }] }] });
    expect(ok.new_flags.filter((f) => f.type === 'overlapping_days')).toEqual([]);
  });

  it('checks a school night against the calendar, and ignores days it cannot place', async () => {
    const { ctx } = setup();
    const r = await timelineLog(ctx, 'Novel', {
      days: [day(1, [1], { weekday: 'Friday' }), day(2, [2], { day_type: 'weekday' }), { day: 'uncertain', chapters: [{ chapter: 3, mode: 'summarized' }], day_range_if_uncertain: [3, 6] }],
    });
    expect(r.new_flags.map((f) => f.type)).toEqual(['day_of_week_contradiction']);
    await fails(timelineLog(ctx, 'Novel', { days: [{ day: 'soon' }] }), /not a day number/);
    await fails(timelineLog(ctx, 'Novel', { days: [day(1, [1])], flags: [{ type: 'duration_mismatch', description: 'x', quotes: [] }] }), /both conflicting quotes/);
  });

  it('draws the timeline with level by day when there is also a mechanics ledger', async () => {
    const { ctx } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('level_up', 2, { resulting_level: 2 })] }] });
    await timelineLog(ctx, 'Novel', { days: [day(1, [1]), day(4, [2, 3])] });
    const r = (await buildTrackerView(ctx, 'Novel', { view: 'timeline', return_html: true }, templates)) as { file: string; html: string };
    expect(r.file).toBe('Tracking/Timeline.html');
    const data = JSON.parse(/id="data">([\s\S]*)<\/script>/.exec(r.html)![1]);
    expect(data.series).toEqual([{ character: 'Sean', points: [{ day: 4, level: 2, xp_total: null }] }]);
  });

  it('turns an in-story day into a chapter for the mechanics ledger', async () => {
    const { ctx } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('level_up', 2, { resulting_level: 2 }), ev('level_up', 6, { resulting_level: 3 })] }] });
    await fails(litrpgState(ctx, 'Novel', { as_of_day: 3 }), /no timeline ledger/);
    await timelineLog(ctx, 'Novel', { days: [day(1, [1, 2]), day(3, [3, 4]), day(8, [5, 6])] });
    const r = await litrpgState(ctx, 'Novel', { character: 'Sean', as_of_day: 3 });
    expect(r).toMatchObject({ as_of_chapter: 4, as_of_day: '3' });
    expect(r.characters[0].state.level).toBe(2);
    expect((await litrpgState(ctx, 'Novel', { character: 'Sean', as_of_day: 8 })).characters[0].state.level).toBe(3);
    await fails(litrpgState(ctx, 'Novel', { as_of_day: 4 }), /not in the timeline/);
  });
});

describe('check_keywords', () => {
  const good = ['monster girl academy', 'dungeon crawl litrpg', 'summoner gamelit harem', 'succubus demon queen', 'base building adventure', 'cultivation progression magic', 'kingdom dragon rider'];
  it('passes a clean set and reports lengths', () => {
    const r = checkKeywords(good, { title: 'Realm Heir', subtitle: 'A Series', categories: ['Epic'] });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.slots[0]).toMatchObject({ slot: 1, characters: 20 });
  });
  it('finds each kind of mistake', () => {
    const r = checkKeywords(['monster girl fantasy', 'dragon girl fantasy adventure', 'x'.repeat(51) + ' go', 'free harem, school', 'reverse harem', 'litrpg', ''], { title: 'Dungeon Fantasy', maleTargeted: true });
    const said = r.problems.map((p) => `${p.slot}:${p.problem}`).join('\n');
    expect(said).toMatch(/2:.*"girl" is already used in slot 1/);
    expect(said).toMatch(/1:.*"fantasy" is already in the title/);
    expect(said).toMatch(/3:.*limit is 50/);
    expect(said).toMatch(/4:.*"free".*claim/);
    expect(said).toMatch(/4:.*punctuation/);
    expect(said).toMatch(/5:.*opposite market/);
    expect(said).toMatch(/6:.*single word/);
    expect(said).toMatch(/7:.*empty/);
    expect(checkKeywords(['reverse harem fantasy'].concat(good.slice(1)), { maleTargeted: false }).problems.filter((p) => /opposite/.test(p.problem))).toEqual([]);
  });
  it('needs seven slots', () => {
    expect(checkKeywords(good.slice(0, 6)).problems[0]).toMatchObject({ slot: null });
  });
});

describe('a series: the LitRPG ledger carries across Books', () => {
  const twoBooks = () => {
    const fs = new MemoryFs();
    fs.seed('/books/Ember/.cadrel/project.json', '{}');
    fs.seed('/books/Ash/.cadrel/project.json', '{}');
    const ctx: AgentContext = { fs, root: '/books', agent: 'claude', agentName: 'Claude' };
    return { fs, ctx };
  };
  const book1 = [ev('class_assigned', 1, { name: 'Warden' }), ev('xp_award', 5, { amount: 400, running_total: 400, xp_to_next_level: 600 }), ev('level_up', 6, { resulting_level: 2 })];
  const book2 = [ev('xp_award', 3, { amount: 600, running_total: 1000, xp_to_next_level: 800 }), ev('level_up', 4, { resulting_level: 3 })];

  it('each Book keeps its own ledger, logged where the Book is', async () => {
    const { ctx, fs } = twoBooks();
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: book1 }] });
    await litrpgLog(ctx, 'Ash', { characters: [{ name: 'Sean', events: book2 }] });
    const ash = JSON.parse(await fs.readText('/books/Ash/Tracking/LitRPG Ledger.json'));
    expect(ash.characters.Sean.event_log).toHaveLength(2); // nothing from Book 1 is copied into it
  });

  it('a Book starts where the one before left the character, and answers as of its own chapters', async () => {
    const { ctx } = twoBooks();
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: book1 }] });
    await litrpgLog(ctx, 'Ash', { characters: [{ name: 'Sean', events: book2 }] });
    const alone = (await litrpgState(ctx, 'Ash', { character: 'Sean', as_of_chapter: 2 })).characters[0].state;
    expect(alone.level).toBeNull(); // on its own, Book 2 knows nothing of Book 1
    const carried = (await litrpgState(ctx, 'Ash', { character: 'Sean', as_of_chapter: 2 }, ['Ember'])).characters[0].state;
    expect(carried).toMatchObject({ level: 2, xp_total: 400, class: { name: 'Warden' } }); // where Book 1 ended, before Book 2's chapter 3
    const later = (await litrpgState(ctx, 'Ash', { character: 'Sean', as_of_chapter: 4 }, ['Ember'])).characters[0].state;
    expect(later).toMatchObject({ level: 3, xp_total: 1000 });
  });

  it('a character who only appears in an earlier Book is known in this one', async () => {
    const { ctx } = twoBooks();
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Mira', events: [ev('level_up', 2, { resulting_level: 9 })] }] });
    await litrpgLog(ctx, 'Ash', { characters: [{ name: 'Sean', events: book2 }] });
    const all = await litrpgState(ctx, 'Ash', {}, ['Ember']);
    expect(all.characters.map((c) => c.character).sort()).toEqual(['Mira', 'Sean']);
    expect(all.characters.find((c) => c.character === 'Mira')!.state.level).toBe(9);
  });

  it('Book 2 can be read before it has a ledger of its own', async () => {
    const { ctx } = twoBooks();
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: book1 }] });
    const s = (await litrpgState(ctx, 'Ash', { character: 'Sean' }, ['Ember'])).characters[0].state;
    expect(s.level).toBe(2);
  });

  it('the checks find a jump between Books, and never copy the earlier Book’s events or its own old flags into this Book’s file', async () => {
    const { ctx, fs } = twoBooks();
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: book1 }] });
    // Book 2 starts the character at level 5, though Book 1 ended with Sean at level 2.
    await litrpgLog(ctx, 'Ash', { characters: [{ name: 'Sean', events: [ev('level_up', 2, { resulting_level: 5 })] }] });
    const r = await checkTracker(ctx, 'Ash', 'litrpg', ['Ember']);
    expect(r.new_flags.map((f) => f.type)).toContain('silent_jump');
    expect(r.new_flags.every((f) => f.chapters_involved.some((c) => c > 0))).toBe(true); // it concerns Book 2
    const saved = JSON.parse(await fs.readText('/books/Ash/Tracking/LitRPG Ledger.json'));
    expect(saved.characters.Sean.event_log).toHaveLength(1); // only its own event
    expect(saved.characters.Sean.event_log.some((e: { id: string }) => e.id.startsWith('b1:'))).toBe(false);
  });

  it('a correction in an earlier Book still works when carried, and cannot reach this Book’s events', async () => {
    const { ctx } = twoBooks();
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: [ev('level_up', 3, { resulting_level: 4 })] }] });
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: [{ ...ev('level_up', 3, { resulting_level: 2 }), corrects: 'e1' }] }] });
    await litrpgLog(ctx, 'Ash', { characters: [{ name: 'Sean', events: [ev('xp_award', 1, { amount: 10, running_total: null, xp_to_next_level: null })] }] });
    expect((await litrpgState(ctx, 'Ash', { character: 'Sean' }, ['Ember'])).characters[0].state.level).toBe(2);
  });

  it('draws a Book’s dashboard and sheet from the joined ledger without writing it into the ledger', async () => {
    const { ctx, fs } = twoBooks();
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: book1 }] });
    await litrpgLog(ctx, 'Ash', { characters: [{ name: 'Sean', events: book2 }] });
    const sheet = await buildTrackerView(ctx, 'Ash', { view: 'character_sheet', character: 'Sean', as_of_chapter: 1, return_html: true }, templates, ['Ember']);
    expect((sheet as { html: string }).html).toContain('"level":2'); // Book 1's level 2 carried into Book 2's chapter 1
    const saved = JSON.parse(await fs.readText('/books/Ash/Tracking/LitRPG Ledger.json'));
    expect(saved.characters.Sean.event_log).toHaveLength(2);
  });
});

describe('the permanent record of each chapter', () => {
  const real = {
    ...templates,
    chapter: '<title>__CADREL_TITLE__</title><script id="data" type="application/json">__CADREL_DATA__</script>'
  };
  const dataOf = (html: string) => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!);

  it('logging a chapter writes its own page: what changed, and where each character stands after it', async () => {
    const { ctx, fs } = setup();
    const r = await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] }, { templates: real });
    expect(r.chapter_records).toEqual(['Tracking/Chapters/Chapter 2.html', 'Tracking/Chapters/Chapter 3.html', 'Tracking/Chapters/Chapter 4.html', 'Tracking/Chapters/Chapter 5.html', 'Tracking/Chapters/Chapter 7.html', 'Tracking/Chapters/Chapter 9.html']);
    const four = dataOf(await fs.readText('/books/Novel/Tracking/Chapters/Chapter 4.html'));
    expect(four).toMatchObject({ project: 'Novel', chapter: 4 });
    expect(four.litrpg.events.map((e: { text: string }) => e.text)).toEqual(['Reached level 2', 'Spent 5 stat points: Strength +3, Agility +2']);
    expect(four.litrpg.after[0]).toMatchObject({ name: 'Sean', level: 2, xp_total: 400 });
    expect(four.timeline).toBeNull();
    const nine = dataOf(await fs.readText('/books/Novel/Tracking/Chapters/Chapter 9.html'));
    expect(nine.litrpg.after[0].items ?? []).toEqual([]); // the Cloak was lost in this chapter
  });

  it('a chapter’s page shows where the character stood at the end of that chapter, not the end of the ledger', async () => {
    const { ctx, fs } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] }, { templates: real });
    const seven = dataOf(await fs.readText('/books/Novel/Tracking/Chapters/Chapter 7.html'));
    expect(seven.litrpg.after[0].items.map((i: { name: string }) => i.name)).toEqual(['Cloak']);
    expect(seven.litrpg.after[0].level).toBe(2);
  });

  it('a chapter nothing was logged for has no page', async () => {
    const { ctx, fs } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] }, { templates: real });
    expect(await fs.stat('/books/Novel/Tracking/Chapters/Chapter 6.html')).toBeNull();
    expect(await fs.stat('/books/Novel/Tracking/Chapters/Chapter 1.html')).toBeNull();
  });

  it('logging the timeline adds the in-story days to the chapters it narrates, in the same page', async () => {
    const { ctx, fs } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] }, { templates: real });
    const t = await timelineLog(ctx, 'Novel', { days: [{ day: 1, chapters: [{ chapter: 4, mode: 'full_scene' }], locations: ['Keep'], characters_present: ['Sean'], major_events: ['The trial'] }] as never }, { templates: real });
    expect(t.chapter_records).toEqual(['Tracking/Chapters/Chapter 4.html']);
    const four = dataOf(await fs.readText('/books/Novel/Tracking/Chapters/Chapter 4.html'));
    expect(four.litrpg.events).toHaveLength(2); // still there
    expect(four.timeline.days[0]).toMatchObject({ day: '1', locations: ['Keep'], major_events: ['The trial'] });
  });

  it('is permanent: a correction writes a new version and keeps the one it replaces; an unchanged chapter is not rewritten', async () => {
    const { ctx, fs } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('level_up', 4, { resulting_level: 3 })] }] }, { templates: real });
    const first = await fs.readText('/books/Novel/Tracking/Chapters/Chapter 4.html');
    // logging something else leaves chapter 4's page exactly as it was
    const again = await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [ev('item_gained', 6, { name: 'Cloak' })] }] }, { templates: real });
    expect(again.chapter_records).toEqual(['Tracking/Chapters/Chapter 6.html']);
    expect(await fs.readText('/books/Novel/Tracking/Chapters/Chapter 4.html')).toBe(first);
    // a correction to chapter 4 writes a new page and keeps the old one
    const fix = await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: [{ ...ev('level_up', 4, { resulting_level: 2 }), corrects: 'e1' }] }] }, { templates: real });
    expect(fix.chapter_records).toEqual(['Tracking/Chapters/Chapter 4.html']);
    const now = dataOf(await fs.readText('/books/Novel/Tracking/Chapters/Chapter 4.html'));
    expect(now.litrpg.after[0].level).toBe(2);
    const kept = (await fs.readdir('/books/Novel/.cadrel/previous')).map((e) => e.name);
    expect(kept.some((n) => /Chapter 4/.test(n))).toBe(true);
  });

  it('does nothing without the page template, so a caller that has none is unaffected', async () => {
    const { ctx, fs } = setup();
    const r = await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] });
    expect(r).not.toHaveProperty('chapter_records');
    expect(await fs.stat('/books/Novel/Tracking/Chapters')).toBeNull();
  });

  it('the chapters view brings a ledger logged before records existed up to date, and says what it wrote', async () => {
    const { ctx, fs } = setup();
    await litrpgLog(ctx, 'Novel', { characters: [{ name: 'Sean', events: sean }] }); // no records yet
    const r = await buildTrackerView(ctx, 'Novel', { view: 'chapters' }, real);
    expect(r).toMatchObject({ view: 'chapters', chapters_covered: 6, unchanged: 0 });
    expect((r as { written: string[] }).written).toHaveLength(6);
    expect(await fs.stat('/books/Novel/Tracking/Chapters/Chapter 5.html')).not.toBeNull();
    const second = await buildTrackerView(ctx, 'Novel', { view: 'chapters' }, real);
    expect(second).toMatchObject({ written: [], unchanged: 6 }); // nothing changed since
    const one = await buildTrackerView(ctx, 'Novel', { view: 'chapters', as_of_chapter: 5 }, real);
    expect(one).toMatchObject({ unchanged: 1 });
  });

  it('a Book’s page counts what the earlier Books did', async () => {
    const fs = new MemoryFs();
    fs.seed('/books/Ember/.cadrel/project.json', '{}');
    fs.seed('/books/Ash/.cadrel/project.json', '{}');
    const ctx: AgentContext = { fs, root: '/books', agent: 'claude', agentName: 'Claude' };
    await litrpgLog(ctx, 'Ember', { characters: [{ name: 'Sean', events: [ev('level_up', 5, { resulting_level: 7 })] }] });
    await litrpgLog(ctx, 'Ash', { characters: [{ name: 'Sean', events: [ev('xp_award', 2, { amount: 50, running_total: null, xp_to_next_level: null })] }] }, { templates: real, earlier: ['Ember'] });
    const two = dataOf(await fs.readText('/books/Ash/Tracking/Chapters/Chapter 2.html'));
    expect(two.litrpg.after[0].level).toBe(7); // Book 1's ending, carried in
  });
});
