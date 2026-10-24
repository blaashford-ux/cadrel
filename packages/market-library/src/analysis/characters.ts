import { characterOf, TEXT_READ_CHARS, type CharacterProfile, type Gender, type StoryText } from '@cadrel/market-core';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../schema.js';
import { categoryBooks, type CategoryBook } from '../category.js';
import { bestText, extractedDir, getManuscripts, readManuscriptText } from '../manuscripts.js';

export interface Tally { label: string; top: number; rest: number; topShare: number | null; restShare: number | null }

export interface CharacterStats {
  topN: number;
  /** Books whose blurb could be read; the shares below use these. */
  readable: { top: number; rest: number };
  /** Of the books read, how many had the sample or an uploaded text to read as well as the blurb. */
  withText: { top: number; rest: number };
  mainCharacterGender: Tally[];
  loveInterestGender: Tally[];
  /** How many love interests the blurb implies: none stated, one, a triangle, several. */
  loveInterestCount: Tally[];
  /** Share of readable blurbs that say the book has dual / alternating points of view. */
  dualPov: { top: number; rest: number; topShare: number | null; restShare: number | null };
  mainCharacterArchetypes: Tally[];
  loveInterestArchetypes: Tally[];
  tropes: Tally[];
  caveats: string[];
}

function blurbOf(db: Db, asin: string): string | null {
  return db.scalar<string>(`SELECT t.body FROM text_block t JOIN snapshot s ON s.id = t.snapshot_id WHERE s.asin = ? AND t.kind = 'blurb' ORDER BY s.captured_at DESC LIMIT 1`, asin) ?? null;
}

const GENDER_LABEL: Record<Gender, string> = { female: 'Female', male: 'Male', nonbinary: 'Non-binary', unknown: 'Not stated' };
const COUNT_LABEL = ['No love interest stated', 'One love interest', 'Love triangle (two)', 'Several (harem / why choose)'];

/** The uploaded manuscript if there is one, otherwise the free sample; null when neither is stored (or no library folder is known). */
function storyOf(db: Db, root: string | undefined, asin: string): StoryText | null {
  if (!root) return null;
  const source = bestText(db, asin);
  if (!source || !getManuscripts(db, asin).length) return null;
  const body = readManuscriptText(root, asin, source);
  if (!body) return null;
  let chapterTitles: string[] | undefined;
  try {
    chapterTitles = (JSON.parse(fs.readFileSync(path.join(extractedDir(root, asin), `${source}.json`), 'utf8')) as { chapters: { title: string }[] }).chapters.map((c) => c.title);
  } catch { /* chapters are optional */ }
  return { body: body.slice(0, TEXT_READ_CHARS), chapterTitles };
}

export function characterStats(db: Db, categoryKey: string, topN = 10, books: CategoryBook[] = categoryBooks(db, categoryKey), root?: string): CharacterStats {
  const rows = books
    .filter((b) => b.captured)
    .map((b) => ({ top: b.listRank <= topN, p: characterOf(b.title, b.captured ? blurbOf(db, b.asin) : null, storyOf(db, root, b.asin)) }))
    .filter((r) => r.p.readable);
  const top = rows.filter((r) => r.top), rest = rows.filter((r) => !r.top);
  const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 1000 : null);
  const tally = (labels: string[], pick: (p: CharacterProfile) => string[], sort = true): Tally[] => {
    const out = labels.map((label) => {
      const a = top.filter((r) => pick(r.p).includes(label)).length, b = rest.filter((r) => pick(r.p).includes(label)).length;
      return { label, top: a, rest: b, topShare: share(a, top.length), restShare: share(b, rest.length) };
    });
    return sort ? out.filter((t) => t.top + t.rest > 0).sort((x, y) => y.top + y.rest - (x.top + x.rest) || x.label.localeCompare(y.label)) : out;
  };
  const uniq = (xs: string[][]) => [...new Set(xs.flat())];
  const romantic = (g: Gender[]) => (g.length ? g : ['unknown' as Gender]);
  const dual = (rs: typeof rows) => rs.filter((r) => r.p.dualPov).length;
  const caveats = [
    'Read from each book\'s blurb and, where there is one, its free sample or uploaded text (the first ~60,000 characters). Gender comes from pronoun and word counts, archetypes and tropes from phrases. A blurb shows how a book is sold; a sample shows only its opening, so both can miss a love interest who arrives later.',
    '"Not stated" means the blurb does not say, not that the book lacks it. Dual POV is counted only when the blurb names it, so it understates how many books use it.',
  ];
  const missing = books.length - rows.length;
  if (missing > 0) caveats.push(`${missing} of ${books.length} listed books have no readable blurb or text (no detail page or text captured, or too short), so they are left out.`);
  return {
    topN,
    readable: { top: top.length, rest: rest.length },
    withText: { top: top.filter((r) => r.p.basis.text).length, rest: rest.filter((r) => r.p.basis.text).length },
    mainCharacterGender: tally((Object.keys(GENDER_LABEL) as Gender[]).map((g) => GENDER_LABEL[g]), (p) => [GENDER_LABEL[p.mainCharacter.gender]], false),
    loveInterestGender: tally((Object.keys(GENDER_LABEL) as Gender[]).map((g) => GENDER_LABEL[g]), (p) => (p.loveInterests.romance ? romantic(p.loveInterests.genders).map((g) => GENDER_LABEL[g]) : []), false),
    loveInterestCount: tally(COUNT_LABEL, (p) => [COUNT_LABEL[p.loveInterests.count]!], false),
    dualPov: { top: dual(top), rest: dual(rest), topShare: share(dual(top), top.length), restShare: share(dual(rest), rest.length) },
    mainCharacterArchetypes: tally(uniq(rows.map((r) => r.p.mainCharacter.archetypes)), (p) => p.mainCharacter.archetypes),
    loveInterestArchetypes: tally(uniq(rows.map((r) => r.p.loveInterests.archetypes)), (p) => p.loveInterests.archetypes),
    tropes: tally(uniq(rows.map((r) => r.p.tropes)), (p) => p.tropes),
    caveats,
  };
}
