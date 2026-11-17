/**
 * What a book earned, month by month, kept in the Studio so the people who wrote it can see it. The figures are the publisher's (KDP reports
 * are imported on their computer); their Cadrel publishes one report per book per month, each holding that book alone. Records over the
 * kernel's `Db`; who may publish and who may read which book is the service's business (see `ownedAsins` for the rule about authors).
 */
import { normalizeAsin } from './catalogue';
import type { Db } from './vault';

export class BookFinanceError extends Error {
  constructor(readonly code: 'invalid', message: string) {
    super(message);
  }
}

/** The most one month's report for one book may weigh, as JSON. A real one is a few kilobytes. */
export const MAX_MONTH_REPORT = 256 * 1024;
export const MAX_MONTHS = 600;

export interface BookFinanceSummary {
  asin: string;
  title: string;
  /** The months published, newest first. */
  months: string[];
  publishedAt: string;
}

export interface PublishedMonth {
  month: string;
  /** The month's report for this one book (an `AnalysisReport` or `MonthReport` of the finance code). */
  report: unknown;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Replaces what is published for one book with these months, so a month that was corrected, or taken out, is corrected or gone here too.
 * Months not in the list are removed.
 */
export async function publishBookFinance(db: Db, c: { studioId: string; actor: string; now: string }, input: { asin: unknown; title?: unknown; months: unknown }): Promise<{ asin: string; months: number }> {
  let asin: string | null;
  try {
    asin = normalizeAsin(input?.asin);
  } catch (e) {
    throw new BookFinanceError('invalid', (e as Error).message);
  }
  if (!asin) throw new BookFinanceError('invalid', 'A book is named by its ASIN.');
  if (!Array.isArray(input.months) || input.months.length > MAX_MONTHS) throw new BookFinanceError('invalid', `A book has up to ${MAX_MONTHS} months.`);
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 300) : '';
  const seen = new Set<string>();
  const rows: { month: string; json: string }[] = [];
  for (const m of input.months as PublishedMonth[]) {
    if (!m || typeof m.month !== 'string' || !MONTH.test(m.month)) throw new BookFinanceError('invalid', 'A month is written 2026-09.');
    if (seen.has(m.month)) throw new BookFinanceError('invalid', `${m.month} is there twice.`);
    seen.add(m.month);
    const json = JSON.stringify(m.report ?? null);
    if (!m.report || typeof m.report !== 'object' || json.length > MAX_MONTH_REPORT) throw new BookFinanceError('invalid', `The report for ${m.month} is missing or too large.`);
    // a report that names another book is refused: what an author is shown must be about their book alone
    const others = ((m.report as { books?: { asin?: unknown }[] }).books ?? []).some((b) => b?.asin !== asin);
    if (others) throw new BookFinanceError('invalid', `The report for ${m.month} has other books in it.`);
    rows.push({ month: m.month, json });
  }
  await db.batch([
    { sql: 'DELETE FROM book_finance WHERE studio_id = ? AND asin = ?', params: [c.studioId, asin] },
    ...rows.map((r) => ({
      sql: 'INSERT INTO book_finance (studio_id, asin, month, title, report, published_at, published_by) VALUES (?,?,?,?,?,?,?)',
      params: [c.studioId, asin, r.month, title, r.json, c.now, c.actor]
    })),
    { sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', params: [c.now, c.actor, 'finance.publish', asin, JSON.stringify({ months: rows.length })] }
  ]);
  return { asin, months: rows.length };
}

/**
 * The ASINs of the books this person wrote: the editions of every live book on which they hold a live author or co-author credit (as
 * themselves, or under a pen name they hold) or contribution. Several people can hold one, so a book written together shows to each of them.
 */
export async function ownedAsins(db: Db, studioId: string, personId: string): Promise<string[]> {
  const rows = await db.all<{ asin: string }>(
    `SELECT DISTINCT e.asin AS asin FROM edition e JOIN book b ON b.id = e.book_id
      WHERE e.studio_id = ? AND e.asin IS NOT NULL AND e.archived_at IS NULL AND b.archived_at IS NULL AND (
        EXISTS (SELECT 1 FROM credit c WHERE c.studio_id = e.studio_id AND c.archived_at IS NULL AND c.role IN ('author', 'co-author')
                  AND ((c.subject_kind = 'book' AND c.subject_id = b.id) OR (c.subject_kind = 'edition' AND c.subject_id = e.id))
                  AND (c.person_id = ? OR c.pen_name_id IN (SELECT pen_name_id FROM pen_name_person WHERE person_id = ?)))
        OR EXISTS (SELECT 1 FROM contribution k WHERE k.studio_id = e.studio_id AND k.archived_at IS NULL AND k.person_id = ? AND k.role IN ('author', 'co-author')
                  AND ((k.subject_kind = 'book' AND k.subject_id = b.id) OR (k.subject_kind = 'edition' AND k.subject_id = e.id))))`,
    [studioId, personId, personId, personId]
  );
  return rows.map((r) => r.asin);
}

/** What is published, for these books (null: every book). Newest month first. */
export async function listBookFinance(db: Db, studioId: string, asins: string[] | null): Promise<BookFinanceSummary[]> {
  if (asins && asins.length === 0) return [];
  const where = asins ? ` AND asin IN (${asins.map(() => '?').join(',')})` : '';
  const rows = await db.all<{ asin: string; month: string; title: string; publishedAt: string }>(
    `SELECT asin, month, title, published_at AS publishedAt FROM book_finance WHERE studio_id = ?${where} ORDER BY asin, month DESC`, [studioId, ...(asins ?? [])]);
  const out = new Map<string, BookFinanceSummary>();
  for (const r of rows) {
    const s = out.get(r.asin) ?? { asin: r.asin, title: r.title, months: [], publishedAt: r.publishedAt };
    s.months.push(r.month);
    out.set(r.asin, s);
  }
  return [...out.values()];
}

/** Every published month of one book, oldest first. */
export async function bookFinanceMonths(db: Db, studioId: string, asin: string): Promise<PublishedMonth[]> {
  const rows = await db.all<{ month: string; report: string }>('SELECT month, report FROM book_finance WHERE studio_id = ? AND asin = ? ORDER BY month', [studioId, asin]);
  return rows.map((r) => ({ month: r.month, report: JSON.parse(r.report) as unknown }));
}
