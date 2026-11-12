import { describe, expect, it } from 'vitest';
import {
  addDays, averageWritten, baselineWords, burnDown, dailySeries, dateRange, daysBetween, daysLeft, emptyProgress, isDate, localDate, mergeProgress, projectCompletion,
  recordSnapshot, requiredPerDay, sanitizeGoal, sanitizeProgress, summarize, totalOn, withBaseline, writtenOn, type Goal, type Progress
} from './progress';

const build = (rows: [string, number][]): Progress => rows.reduce((p, [d, t]) => recordSnapshot(p, d, t), emptyProgress());

describe('dates', () => {
  it('adds and subtracts days across month ends, leap years and DST', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30'); // a DST change in Europe
    expect(daysBetween('2026-10-05', '2026-10-12')).toBe(7);
    expect(daysBetween('2026-10-12', '2026-10-05')).toBe(-7);
  });
  it('validates date strings', () => {
    expect(isDate('2026-10-05')).toBe(true);
    expect(isDate('2026-13-45')).toBe(false);
    expect(isDate('10/05/2026')).toBe(false);
    expect(isDate(20261005)).toBe(false);
  });
  it('formats the local calendar date', () => {
    expect(localDate(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    expect(localDate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
  it('ranges are inclusive', () => {
    expect(dateRange('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(dateRange('2026-10-03', '2026-10-01')).toEqual([]);
  });
});

describe('recordSnapshot', () => {
  it('the first sighting is the baseline: nothing counts as written', () => {
    const p = build([['2026-10-01', 5000]]);
    expect(p.days['2026-10-01']).toEqual({ start: 5000, end: 5000 });
    expect(writtenOn(p, '2026-10-01')).toBe(0);
  });
  it('later sightings the same day move the end, not the start', () => {
    const p = build([['2026-10-01', 5000], ['2026-10-01', 5400], ['2026-10-01', 5900]]);
    expect(p.days['2026-10-01']).toEqual({ start: 5000, end: 5900 });
    expect(writtenOn(p, '2026-10-01')).toBe(900);
  });
  it('a new day starts from the previous day’s end, so overnight and outside edits count', () => {
    const p = build([['2026-10-01', 5000], ['2026-10-01', 5900], ['2026-10-02', 6000]]);
    expect(p.days['2026-10-02']).toEqual({ start: 5900, end: 6000 });
    expect(writtenOn(p, '2026-10-02')).toBe(100);
  });
  it('gaps between days are zero days and the next day starts from the last end', () => {
    const p = build([['2026-10-01', 1000], ['2026-10-05', 1800]]);
    expect(writtenOn(p, '2026-10-03')).toBe(0);
    expect(writtenOn(p, '2026-10-05')).toBe(800);
  });
  it('deletions are negative days', () => {
    const p = build([['2026-10-01', 1000], ['2026-10-02', 700]]);
    expect(writtenOn(p, '2026-10-02')).toBe(-300);
  });
  it('is pure and returns the same object when nothing changed', () => {
    const p = build([['2026-10-01', 1000]]);
    expect(recordSnapshot(p, '2026-10-01', 1000)).toBe(p);
    const q = recordSnapshot(p, '2026-10-01', 1200);
    expect(p.days['2026-10-01'].end).toBe(1000);
    expect(q.days['2026-10-01'].end).toBe(1200);
  });
  it('totals carry forward', () => {
    const p = build([['2026-10-01', 1000], ['2026-10-04', 1500]]);
    expect(totalOn(p, '2026-09-30')).toBeNull();
    expect(totalOn(p, '2026-10-02')).toBe(1000);
    expect(totalOn(p, '2026-10-04')).toBe(1500);
    expect(totalOn(p, '2026-10-09')).toBe(1500);
  });
  it('sanitises a damaged file', () => {
    expect(sanitizeProgress(null)).toEqual(emptyProgress());
    expect(sanitizeProgress({ days: { 'x': { start: 1, end: 2 }, '2026-10-01': { start: 'a', end: 2 }, '2026-10-02': { start: 10.4, end: -5 } } }).days).toEqual({ '2026-10-02': { start: 10, end: 0 } });
  });
});

describe('averages', () => {
  const p = build([['2026-10-01', 10000], ['2026-10-02', 10500], ['2026-10-03', 11500], ['2026-10-04', 11500], ['2026-10-05', 12400]]);
  it('3-day and 5-day averages are of the finished days before today, zero days counted', () => {
    // written: 10-02 500, 10-03 1000, 10-04 0, and today (10-05) 900, which is left out
    expect(averageWritten(p, '2026-10-05', 3)).toBeCloseTo((500 + 1000 + 0) / 3);
    expect(averageWritten(p, '2026-10-05', 5)).toBeCloseTo((500 + 1000 + 0) / 5); // 09-30 and 10-01 had no writing
  });
  it('do not move while today is written', () => {
    const before = build([['2026-10-01', 10000], ['2026-10-02', 10800], ['2026-10-03', 11600], ['2026-10-04', 11600]]);
    const morning = recordSnapshot(before, '2026-10-05', 11679);
    const evening = recordSnapshot(morning, '2026-10-05', 13000);
    expect(averageWritten(morning, '2026-10-05', 3)).toBe(averageWritten(evening, '2026-10-05', 3));
    expect(averageWritten(morning, '2026-10-05', 5)).toBe(averageWritten(evening, '2026-10-05', 5));
  });
  it('days before tracking began count as zero', () => {
    expect(averageWritten(build([['2026-10-05', 100]]), '2026-10-05', 5)).toBe(0);
  });
});

describe('goal maths', () => {
  const goal: Goal = { targetWords: 90000, startDate: '2026-10-01', targetDate: '2026-12-31' };
  it('days left counts today through the deadline', () => {
    expect(daysLeft(goal, '2026-12-31')).toBe(1);
    expect(daysLeft(goal, '2026-12-30')).toBe(2);
    expect(daysLeft({ ...goal, targetDate: null }, '2026-10-05')).toBeNull();
  });
  it('words per day needed', () => {
    expect(requiredPerDay(goal, 20000, '2026-10-05')).toBe(Math.ceil(70000 / 88));
    expect(requiredPerDay(goal, 90000, '2026-10-05')).toBe(0);
    expect(requiredPerDay(goal, 95000, '2026-10-05')).toBe(0);
    expect(requiredPerDay({ ...goal, targetDate: null }, 20000, '2026-10-05')).toBeNull();
    expect(requiredPerDay(goal, 80000, '2027-01-10')).toBe(10000); // deadline passed: the whole remainder, today
  });
  it('estimated completion at a pace, with ahead / behind the deadline', () => {
    const e = projectCompletion(goal, 20000, 1000, '2026-10-05');
    expect(e).toEqual({ days: 70, date: '2026-12-13', vsDeadline: 18 }); // today is day 1: 70 days end on 12-13
    const late = projectCompletion(goal, 20000, 500, '2026-10-05');
    expect(late.days).toBe(140);
    expect(late.vsDeadline).toBeLessThan(0);
    expect(projectCompletion(goal, 20000, 0, '2026-10-05')).toEqual({ days: null, date: null, vsDeadline: null });
    expect(projectCompletion(goal, 20000, -50, '2026-10-05').date).toBeNull();
    expect(projectCompletion(goal, 90000, 0, '2026-10-05').days).toBe(0);
  });
  it('lands exactly on the deadline when the pace is exactly what is needed', () => {
    const exact: Goal = { targetWords: 8800, startDate: '2026-10-05', targetDate: '2026-12-31' };
    expect(requiredPerDay(exact, 0, '2026-10-05')).toBe(100);
    expect(projectCompletion(exact, 0, 100, '2026-10-05')).toEqual({ days: 88, date: '2026-12-31', vsDeadline: 0 });
  });
  it('rounds the day count up', () => {
    expect(projectCompletion({ ...goal, targetWords: 1001, targetDate: null }, 0, 1000, '2026-10-05').days).toBe(2);
  });
  it('summarises with 3- and 5-day estimates', () => {
    const p = build([['2026-10-01', 10000], ['2026-10-02', 11000], ['2026-10-03', 12500], ['2026-10-04', 12500], ['2026-10-05', 14000]]);
    const s = summarize(p, goal, 14000, '2026-10-05');
    expect(s.writtenToday).toBe(1500);
    expect(s.remaining).toBe(76000);
    expect(s.percent).toBe(16);
    expect(s.avg3).toBeCloseTo((1000 + 1500 + 0) / 3); // 10-02 to 10-04: today is not counted
    expect(s.avg5).toBeCloseTo((0 + 0 + 1000 + 1500 + 0) / 5);
    // today began at 12,500 words, so 77,500 were to go: that is what today and the days after it are worked out from
    expect(s.eta3.days).toBe(Math.ceil(77500 / s.avg3));
    expect(s.eta5.days).toBe(Math.ceil(77500 / s.avg5));
    expect(s.requiredPerDay).toBe(Math.ceil(77500 / 88));
    expect(s.done).toBe(false);
  });
  it('needed per day does not move while today is written, and falls after a day that beat it', () => {
    const base: Goal = { targetWords: 80000, startDate: '2026-11-01', targetDate: '2027-02-01' };
    const yesterday = build([['2026-11-10', 17000], ['2026-11-11', 18015]]);
    const day = (p: Progress, total: number, today: string) => summarize(recordSnapshot(p, today, total), base, total, today).requiredPerDay;
    const at = [18015, 18094, 18800, 19400].map((t) => day(yesterday, t, '2026-11-12'));
    expect(new Set(at).size).toBe(1); // the same all day
    const tomorrow = day(recordSnapshot(yesterday, '2026-11-12', 19400), 19400, '2026-11-13');
    expect(tomorrow).toBeLessThan(at[0]!); // 1,385 written against ~756 needed: tomorrow needs less
  });
});

describe('the burn-down baseline', () => {
  const p = build([['2026-10-01', 1000], ['2026-10-02', 1200], ['2026-10-03', 1500]]);
  const goal: Goal = { targetWords: 11000, startDate: '2026-10-01', targetDate: '2026-10-10' };
  it('is the words at the start, kept in the goal, and the steady-pace line does not move as words are written', () => {
    const g = withBaseline(null, goal, p, 1500);
    expect(g.startWords).toBe(1000);
    const early = burnDown(build([['2026-10-01', 1000]]), g, '2026-10-01', '2026-10-10', '2026-10-01').map((x) => x.ideal);
    const later = burnDown(p, g, '2026-10-01', '2026-10-10', '2026-10-03').map((x) => x.ideal);
    expect(later).toEqual(early);
    expect(later[0]).toBe(9000); // 10000 to go over ten days, after the first
    expect(later[9]).toBe(0);
  });
  it('is kept while the start date, deadline and target are the same, whatever the total is now', () => {
    const g = withBaseline(null, goal, p, 1500);
    expect(withBaseline(g, { ...goal }, build([['2026-10-01', 1000], ['2026-10-05', 9000]]), 9000).startWords).toBe(1000);
  });
  it('is taken afresh when the start date, the deadline or the target changes', () => {
    const g = withBaseline(null, goal, p, 1500);
    expect(withBaseline(g, { ...goal, targetWords: 12000 }, p, 1500).startWords).toBe(1000);
    expect(withBaseline(g, { ...goal, startDate: '2026-10-03' }, p, 1500).startWords).toBe(1200);
    expect(withBaseline(g, { ...goal, targetDate: '2026-10-20' }, p, 1500).startWords).toBe(1000);
  });
  it('uses the current total when nothing has been recorded, and the first record when the goal began before tracking', () => {
    expect(withBaseline(null, goal, emptyProgress(), 4321).startWords).toBe(4321);
    expect(baselineWords(build([['2026-10-05', 700]]), { startDate: '2026-10-01' })).toBe(700);
  });
  it('is carried through sanitizeGoal', () => {
    expect(sanitizeGoal({ ...goal, startWords: 1000.4 }, '2026-10-05')).toMatchObject({ startWords: 1000 });
    expect(sanitizeGoal({ ...goal, startWords: -5 }, '2026-10-05')?.startWords).toBeUndefined();
  });
  it('leaves the daily target dynamic: it follows what is left and the days left', () => {
    const g = withBaseline(null, goal, p, 1500);
    expect(requiredPerDay(g, 1500, '2026-10-03')).toBe(Math.ceil(9500 / 8));
    expect(requiredPerDay(g, 5000, '2026-10-06')).toBe(Math.ceil(6000 / 5));
  });
});

describe('burn-down and series', () => {
  const goal: Goal = { targetWords: 1000, startDate: '2026-10-01', targetDate: '2026-10-10' };
  const p = build([['2026-10-01', 0], ['2026-10-02', 200], ['2026-10-03', 200], ['2026-10-04', 500]]);
  it('actual remaining falls as words are written and stops after today', () => {
    const b = burnDown(p, goal, '2026-10-01', '2026-10-08', '2026-10-04');
    expect(b.map((x) => x.remaining)).toEqual([1000, 800, 800, 500, null, null, null, null]);
  });
  it('the ideal line runs straight from the start total to zero on the deadline', () => {
    const b = burnDown(p, goal, '2026-10-01', '2026-10-10', '2026-10-04');
    expect(b[0].ideal).toBe(900); // after day one of ten
    expect(b[9].ideal).toBe(0);
    expect(b[4].ideal).toBe(500);
  });
  it('no deadline, no ideal line', () => {
    expect(burnDown(p, { ...goal, targetDate: null }, '2026-10-01', '2026-10-03', '2026-10-04').every((x) => x.ideal === null)).toBe(true);
  });
  it('a goal that starts after tracking began uses the total at that time', () => {
    const g: Goal = { targetWords: 1000, startDate: '2026-10-03', targetDate: '2026-10-12' };
    const b = burnDown(p, g, '2026-10-03', '2026-10-03', '2026-10-04');
    expect(b[0].ideal).toBe(Math.round(800 * (1 - 1 / 10)));
  });
  it('daily series pairs words written with the running total', () => {
    const s = dailySeries(p, '2026-10-01', '2026-10-06', '2026-10-04');
    expect(s.map((d) => d.written)).toEqual([0, 200, 0, 300, 0, 0]);
    expect(s.map((d) => d.total)).toEqual([0, 200, 200, 500, null, null]);
  });
});

describe('goal input', () => {
  it('accepts a sensible goal and tidies the dates', () => {
    expect(sanitizeGoal({ targetWords: 90000.7, startDate: '2026-10-01', targetDate: '2026-12-31' }, '2026-10-05')).toEqual({ targetWords: 90001, startDate: '2026-10-01', targetDate: '2026-12-31' });
    expect(sanitizeGoal({ targetWords: 5000 }, '2026-10-05')).toEqual({ targetWords: 5000, startDate: '2026-10-05', targetDate: null });
    expect(sanitizeGoal({ targetWords: 5000, startDate: '2026-10-05', targetDate: '2026-10-01' }, '2026-10-05')?.targetDate).toBeNull();
  });
  it('rejects nonsense', () => {
    expect(sanitizeGoal(null, '2026-10-05')).toBeNull();
    expect(sanitizeGoal({ targetWords: 0 }, '2026-10-05')).toBeNull();
    expect(sanitizeGoal({ targetWords: 'lots' }, '2026-10-05')).toBeNull();
  });
});

describe('mergeProgress', () => {
  const p = (days: Progress['days']): Progress => ({ version: 1, days });

  it('keeps every date from both sides', () => {
    const m = mergeProgress(p({ '2026-10-01': { start: 0, end: 100 } }), p({ '2026-10-02': { start: 100, end: 150 } }));
    expect(Object.keys(m.days)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('uses the earliest start and the highest end for a shared date', () => {
    const m = mergeProgress(p({ '2026-10-05': { start: 1000, end: 1500 } }), p({ '2026-10-05': { start: 1000, end: 1300 } }));
    expect(m.days['2026-10-05']).toEqual({ start: 1000, end: 1500 });
  });

  it('is symmetric and does not change its inputs', () => {
    const a = p({ '2026-10-05': { start: 10, end: 20 } });
    const b = p({ '2026-10-05': { start: 5, end: 15 } });
    expect(mergeProgress(a, b)).toEqual(mergeProgress(b, a));
    expect(a.days['2026-10-05']).toEqual({ start: 10, end: 20 });
  });

  it('corrects the current day once the merged total is re-recorded', () => {
    const merged = mergeProgress(p({ '2026-10-05': { start: 1000, end: 1500 } }), p({ '2026-10-05': { start: 1000, end: 1300 } }));
    expect(recordSnapshot(merged, '2026-10-05', 1800).days['2026-10-05']).toEqual({ start: 1000, end: 1800 });
  });
});
