import { describe, expect, it } from 'vitest';
import { byDate, daysBetween, lateTasks, monthGrid, relativeDay, shiftMonth } from '../src/renderer/calendar';

const t = (title: string, due: string | null, over: Partial<{ state: string; kind: string }> = {}) => ({ title, due, state: 'open', kind: 'task', ...over });

describe('the planner’s dates', () => {
  it('lays a month out in Monday-first weeks that fill the first and last week', () => {
    const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(g[0]![0]).toBe('2026-10-26');
    expect(g[0]![6]).toBe('2026-11-01');
    expect(g.at(-1)![6]).toBe('2026-12-06');
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g.flat()).toContain('2026-11-30');
    expect(monthGrid(2027, 1)).toHaveLength(4); // February 2027 is exactly four weeks, Monday to Sunday
    expect(monthGrid(2027, 0)[0]![0]).toBe('2026-12-28'); // across a year
  });
  it('moves between months across years', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
  });
  it('puts deadlines first within a day and leaves undated work out', () => {
    const m = byDate([t('b task', '2026-11-05'), t('a task', '2026-11-05'), t('Launch', '2026-11-05', { kind: 'deadline' }), t('someday', null)]);
    expect(m.get('2026-11-05')!.map((x) => x.title)).toEqual(['Launch', 'a task', 'b task']);
    expect([...m.keys()]).toEqual(['2026-11-05']);
  });
  it('finds what is late: open work before today, oldest first', () => {
    const list = [t('new', '2026-11-02'), t('done', '2026-10-01', { state: 'done' }), t('old', '2026-10-05'), t('today', '2026-11-01'), t('none', null)];
    expect(lateTasks(list, '2026-11-01').map((x) => x.title)).toEqual(['old']);
  });
  it('counts days and says them plainly', () => {
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
    expect([0, 1, -1, 5, -3].map((n) => relativeDay(['2026-11-10', '2026-11-11', '2026-11-09', '2026-11-15', '2026-11-07'][[0, 1, -1, 5, -3].indexOf(n)]!, '2026-11-10'))).toEqual(['today', 'tomorrow', 'yesterday', 'in 5 days', '3 days ago']);
  });
});
