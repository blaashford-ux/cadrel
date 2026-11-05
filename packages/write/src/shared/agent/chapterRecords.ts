/**
 * The permanent record of one chapter: what the trackers logged for it, as a page of its own. Logging a chapter writes
 * `Tracking/Chapters/Chapter N.html`; a later correction writes a new version and the one it replaces is kept under `.cadrel/previous`
 * (see `saveToolFile`), so the record of what was known when the chapter was logged is never lost. Pure functions: the model of a page
 * from the two ledgers. The files are written in trackers.ts.
 */
import { describeEvent, replay, sheetModel, type LitrpgLedger, type SheetModel } from './litrpg';
import { orderedDays, type TimelineLedger } from './timeline';

export const CHAPTER_RECORDS_DIR = 'Tracking/Chapters';
export const chapterRecordPath = (chapter: number): string => `${CHAPTER_RECORDS_DIR}/Chapter ${chapter}.html`;

/** What the page is drawn from. A part is null when its ledger says nothing about the chapter. */
export interface ChapterRecordModel {
  project: string;
  chapter: number;
  /** When this version was written (ISO). */
  recorded_at: string;
  litrpg: null | {
    events: { character: string; id: string; type: string; text: string; corrects?: string }[];
    /** Each character who had something happen in the chapter, as they stand at its end. Known values only. */
    after: SheetModel[];
  };
  timeline: null | {
    days: {
      day: string;
      weekday: string | null;
      mode: string;
      flashback: boolean;
      locations: string[];
      characters_present: string[];
      pov_character: string | null;
      major_events: string[];
      time_of_day_markers: string[];
    }[];
  };
}

/** Every chapter (1 and up) either ledger has something about, in order. */
export function chaptersOf(litrpg: LitrpgLedger | null, timeline: TimelineLedger | null): number[] {
  const out = new Set<number>();
  for (const c of Object.values(litrpg?.characters ?? {})) for (const e of c.event_log) if (e.chapter > 0) out.add(e.chapter);
  for (const d of Object.values(timeline?.days ?? {})) for (const r of d.chapters) if (r.chapter > 0) out.add(r.chapter);
  return [...out].sort((a, b) => a - b);
}

/**
 * The record of one chapter, or null when neither ledger says anything about it. The LitRPG ledger may be the joined one (what happened in
 * earlier Books in front of this Book's), so "after" is where a character stands counting the whole series so far.
 */
export function chapterRecordModel(o: { project: string; chapter: number; litrpg: LitrpgLedger | null; timeline: TimelineLedger | null; now: string }): ChapterRecordModel | null {
  const { chapter } = o;
  let litrpg: ChapterRecordModel['litrpg'] = null;
  if (o.litrpg) {
    const events: NonNullable<ChapterRecordModel['litrpg']>['events'] = [];
    const after: SheetModel[] = [];
    for (const [name, c] of Object.entries(o.litrpg.characters)) {
      const here = c.event_log.filter((e) => e.chapter === chapter);
      if (!here.length) continue;
      for (const e of here) events.push({ character: name, id: e.id, type: e.type, text: describeEvent(e), ...(e.corrects ? { corrects: e.corrects } : {}) });
      after.push(sheetModel(name, replay(c.event_log, chapter), chapter));
    }
    if (events.length) litrpg = { events, after };
  }
  let timeline: ChapterRecordModel['timeline'] = null;
  if (o.timeline) {
    const days: NonNullable<ChapterRecordModel['timeline']>['days'] = [];
    for (const key of orderedDays(o.timeline)) {
      const d = o.timeline.days[key]!;
      const ref = d.chapters.find((r) => r.chapter === chapter);
      if (!ref) continue;
      days.push({
        day: key,
        weekday: d.weekday,
        mode: ref.mode,
        flashback: ref.flashback === true,
        locations: d.locations,
        characters_present: d.characters_present,
        pov_character: d.pov_character,
        major_events: d.major_events,
        time_of_day_markers: d.time_of_day_markers
      });
    }
    if (days.length) timeline = { days };
  }
  if (!litrpg && !timeline) return null;
  return { project: o.project, chapter, recorded_at: o.now, litrpg, timeline };
}
