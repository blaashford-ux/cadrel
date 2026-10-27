/**
 * The studio's catalogue: IP, series, books and editions. Pure rules and SQL over the kernel's async `Db`, so the same code runs in the app
 * (node:sqlite) and in the Worker (D1). Nothing here decides who may do what: that is the service's `can` check before it calls in.
 *
 * Every write is one `batch` (a transaction) holding the change and its audit row, so the log never disagrees with the data. Uniqueness
 * lives in the database (unique indexes), so two writers racing cannot both succeed; the friendly message is read from the violation.
 *
 * `work` from the architecture is folded into `book`: a book is a title, and its formats are its editions.
 * Records are archived, never deleted, in M1: an ASIN that sales were reported under must stay joined to its book.
 */
import { newRecordId } from './ids';
import type { Db } from './vault';

export type CatalogueCode = 'invalid' | 'exists' | 'not-found' | 'archived' | 'conflict';
export class CatalogueError extends Error {
  constructor(readonly code: CatalogueCode, message: string) {
    super(message);
  }
}
const fail = (code: CatalogueCode, m: string): never => {
  throw new CatalogueError(code, m);
};

/** Who is changing what, and when. The studio is part of it so a record can never be made in the wrong one. */
export interface Ctx {
  studioId: string;
  /** The person's id; written on every row and in the audit log. */
  actor: string;
  now: string;
}

interface Stamped {
  id: string;
  studioId: string;
  archivedAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
export interface Ip extends Stamped { name: string; description: string }
export interface Series extends Stamped { ipId: string | null; name: string; description: string }
export interface Book extends Stamped { seriesId: string | null; position: number | null; title: string; subtitle: string; penName: string; stage: string }
export interface Edition extends Stamped { bookId: string; format: EditionFormat; asin: string | null; isbn: string | null; price: number | null; currency: string; publishedOn: string | null }
export interface BookWithEditions extends Book { editions: Edition[] }

export const EDITION_FORMATS = ['ebook', 'paperback', 'hardcover', 'audiobook', 'other'] as const;
export type EditionFormat = (typeof EDITION_FORMATS)[number];

// ---- validation (pure) -------------------------------------------------------------------------------------------------------

function cleanCatalogueName(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) return fail('invalid', `${what} needs a name.`);
  if (s.length > 200) return fail('invalid', `${what} is too long (200 characters at most).`);
  return s;
}
const cleanText = (v: unknown, max: number, what: string): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return fail('invalid', `${what} must be text.`);
  const s = v.trim();
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};

export function normalizeAsin(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return /^[A-Z0-9]{10}$/.test(s) ? s : fail('invalid', 'An ASIN is 10 letters and digits (for example B0C1R52V2J).');
}

/** ISBN-10 or ISBN-13 with a correct check digit; stored as 13 digits without hyphens (an ISBN-10 is converted). */
export function normalizeIsbn(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const raw = typeof v === 'string' ? v.replace(/[\s-]/g, '').toUpperCase() : '';
  if (/^\d{9}[\dX]$/.test(raw)) {
    const sum = [...raw].reduce((a, c, i) => a + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    if (sum % 11 !== 0) return fail('invalid', 'That ISBN-10 has a wrong check digit.');
    const head = `978${raw.slice(0, 9)}`;
    return head + String((10 - ([...head].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10);
  }
  if (/^\d{13}$/.test(raw)) {
    const sum = [...raw].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? raw : fail('invalid', 'That ISBN-13 has a wrong check digit.');
  }
  return fail('invalid', 'An ISBN is 10 or 13 digits.');
}

function cleanFormat(v: unknown): EditionFormat {
  return (EDITION_FORMATS as readonly string[]).includes(v as string) ? (v as EditionFormat) : fail('invalid', `A format is one of: ${EDITION_FORMATS.join(', ')}.`);
}
function cleanPosition(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1000 ? v : fail('invalid', 'A position in a series is a number above 0 (1, 2, 2.5 for a novella between books).');
}
function cleanDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : fail('invalid', 'A date is written 2026-10-31.');
}
function cleanPrice(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 10000 ? Math.round(v * 100) / 100 : fail('invalid', 'A price is a number of 0 or more.');
}
function cleanCurrency(v: unknown): string {
  if (v === undefined || v === null) return 'USD';
  return typeof v === 'string' && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : fail('invalid', 'A currency is a three-letter code such as USD.');
}

// ---- writing -----------------------------------------------------------------------------------------------------------------

const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});

/** Runs the change and its audit row together; turns a unique-index violation into the message for that rule. */
async function write(db: Db, stmts: { sql: string; params?: unknown[] }[], onUnique: string): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String((e as Error)?.message ?? e))) fail('exists', onUnique);
    if (/FOREIGN KEY/i.test(String((e as Error)?.message ?? e))) fail('not-found', 'That record is not there any more.');
    throw e;
  }
}

const IP_COLS = 'id, studio_id AS studioId, name, description, archived_at AS archivedAt, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt, updated_by AS updatedBy';
const SERIES_COLS = 'id, studio_id AS studioId, ip_id AS ipId, name, description, archived_at AS archivedAt, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt, updated_by AS updatedBy';
const BOOK_COLS = 'id, studio_id AS studioId, series_id AS seriesId, position, title, subtitle, pen_name AS penName, stage, archived_at AS archivedAt, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt, updated_by AS updatedBy';
const EDITION_COLS = 'id, studio_id AS studioId, book_id AS bookId, format, asin, isbn, price, currency, published_on AS publishedOn, archived_at AS archivedAt, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt, updated_by AS updatedBy';

export async function getIp(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Ip | null> {
  return db.first<Ip>(`SELECT ${IP_COLS} FROM ip WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}
export async function getSeries(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Series | null> {
  return db.first<Series>(`SELECT ${SERIES_COLS} FROM series WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}
export async function getBook(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<BookWithEditions | null> {
  const b = await db.first<Book>(`SELECT ${BOOK_COLS} FROM book WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  if (!b) return null;
  return { ...b, editions: await db.all<Edition>(`SELECT ${EDITION_COLS} FROM edition WHERE book_id = ? ORDER BY format`, [id]) };
}
export async function getEdition(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Edition | null> {
  return db.first<Edition>(`SELECT ${EDITION_COLS} FROM edition WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}

export async function createIp(db: Db, c: Ctx, input: { name: string; description?: string }): Promise<Ip> {
  const name = cleanCatalogueName(input?.name, 'An IP');
  const description = cleanText(input?.description, 5000, 'The description');
  const id = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO ip (id, studio_id, name, description, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)', params: [id, c.studioId, name, description, c.now, c.actor, c.now, c.actor] },
    audit(c, 'catalogue.ip.create', id, { name })
  ], `There is already an IP called “${name}”.`);
  return (await getIp(db, c, id))!;
}

export async function createSeries(db: Db, c: Ctx, input: { name: string; description?: string; ipId?: string | null }): Promise<Series> {
  const name = cleanCatalogueName(input?.name, 'A series');
  const description = cleanText(input?.description, 5000, 'The description');
  const ipId = input?.ipId ?? null;
  if (ipId) {
    const ip = await getIp(db, c, ipId);
    if (!ip) fail('not-found', 'That IP is not there.');
    if (ip!.archivedAt) fail('archived', 'That IP is archived. Restore it first.');
  }
  const id = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO series (id, studio_id, ip_id, name, description, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, ipId, name, description, c.now, c.actor, c.now, c.actor] },
    audit(c, 'catalogue.series.create', id, { name, ipId })
  ], `There is already a series called “${name}”.`);
  return (await getSeries(db, c, id))!;
}

export async function createBook(db: Db, c: Ctx, input: { title: string; subtitle?: string; penName?: string; seriesId?: string | null; position?: number | null; stage?: string }): Promise<BookWithEditions> {
  const title = cleanCatalogueName(input?.title, 'A book');
  const subtitle = cleanText(input?.subtitle, 300, 'The subtitle');
  const penName = cleanText(input?.penName, 200, 'The pen name');
  const stage = cleanText(input?.stage ?? 'concept', 60, 'The stage') || 'concept';
  const seriesId = input?.seriesId ?? null;
  let position = cleanPosition(input?.position);
  if (seriesId) {
    const s = await getSeries(db, c, seriesId);
    if (!s) fail('not-found', 'That series is not there.');
    if (s!.archivedAt) fail('archived', 'That series is archived. Restore it first.');
    // the next free whole position when none is given
    if (position === null) position = Math.floor(((await db.first<{ m: number | null }>('SELECT MAX(position) AS m FROM book WHERE series_id = ? AND archived_at IS NULL', [seriesId]))?.m ?? 0)) + 1;
  } else if (position !== null) fail('invalid', 'A position needs a series.');
  const id = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO book (id, studio_id, series_id, position, title, subtitle, pen_name, stage, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, seriesId, position, title, subtitle, penName, stage, c.now, c.actor, c.now, c.actor] },
    audit(c, 'catalogue.book.create', id, { title, seriesId, position })
  ], position !== null && seriesId ? `Position ${position} in that series is taken, or it already has a book called “${title}”.` : `There is already a book called “${title}” outside any series.`);
  return (await getBook(db, c, id))!;
}

export async function addEdition(db: Db, c: Ctx, bookId: string, input: { format: string; asin?: string | null; isbn?: string | null; price?: number | null; currency?: string; publishedOn?: string | null }): Promise<Edition> {
  const format = cleanFormat(input?.format);
  const asin = normalizeAsin(input?.asin);
  const isbn = normalizeIsbn(input?.isbn);
  const price = cleanPrice(input?.price);
  const currency = cleanCurrency(input?.currency);
  const publishedOn = cleanDate(input?.publishedOn);
  const book = await getBook(db, c, bookId);
  if (!book) fail('not-found', 'That book is not there.');
  if (book!.archivedAt) fail('archived', 'That book is archived. Restore it first.');
  const id = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO edition (id, studio_id, book_id, format, asin, isbn, price, currency, published_on, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, bookId, format, asin, isbn, price, currency, publishedOn, c.now, c.actor, c.now, c.actor] },
    audit(c, 'catalogue.edition.add', id, { bookId, format, asin, isbn })
  ], await whichClash(db, c, bookId, format, asin, isbn));
  return (await getEdition(db, c, id))!;
}

async function whichClash(db: Db, c: Ctx, bookId: string, format: string, asin: string | null, isbn: string | null): Promise<string> {
  // read after the failure would be too late to know which rule; this is the message for whichever of them is true now
  const other = asin ? await db.first<{ title: string }>('SELECT b.title AS title FROM edition e JOIN book b ON b.id = e.book_id WHERE e.studio_id = ? AND e.asin = ?', [c.studioId, asin]) : null;
  if (other) return `ASIN ${asin} already belongs to “${other.title}”.`;
  const sameIsbn = isbn ? await db.first<{ title: string }>('SELECT b.title AS title FROM edition e JOIN book b ON b.id = e.book_id WHERE e.studio_id = ? AND e.isbn = ? AND e.archived_at IS NULL', [c.studioId, isbn]) : null;
  if (sameIsbn) return `ISBN ${isbn} already belongs to “${sameIsbn.title}”.`;
  return `That book already has a ${format} edition.`;
}

export async function updateBook(db: Db, c: Ctx, id: string, patch: { title?: string; subtitle?: string; penName?: string; stage?: string }): Promise<BookWithEditions> {
  const cur = await getBook(db, c, id);
  if (!cur) return fail('not-found', 'That book is not there.');
  if (cur.archivedAt) fail('archived', 'That book is archived. Restore it first.');
  const title = patch.title !== undefined ? cleanCatalogueName(patch.title, 'A book') : cur.title;
  const subtitle = patch.subtitle !== undefined ? cleanText(patch.subtitle, 300, 'The subtitle') : cur.subtitle;
  const penName = patch.penName !== undefined ? cleanText(patch.penName, 200, 'The pen name') : cur.penName;
  const stage = patch.stage !== undefined ? cleanText(patch.stage, 60, 'The stage') || cur.stage : cur.stage;
  await write(db, [
    { sql: 'UPDATE book SET title = ?, subtitle = ?, pen_name = ?, stage = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [title, subtitle, penName, stage, c.now, c.actor, id, c.studioId] },
    audit(c, 'catalogue.book.update', id, { from: { title: cur.title, subtitle: cur.subtitle, penName: cur.penName, stage: cur.stage }, to: { title, subtitle, penName, stage } })
  ], `There is already a book called “${title}” in that series.`);
  return (await getBook(db, c, id))!;
}

/** Moves a book into a series (or out of one, with null) at a position. */
export async function moveBook(db: Db, c: Ctx, id: string, seriesId: string | null, position?: number | null): Promise<BookWithEditions> {
  const cur = await getBook(db, c, id);
  if (!cur) return fail('not-found', 'That book is not there.');
  if (cur.archivedAt) fail('archived', 'That book is archived. Restore it first.');
  let pos = cleanPosition(position);
  if (seriesId) {
    const s = await getSeries(db, c, seriesId);
    if (!s) fail('not-found', 'That series is not there.');
    if (s!.archivedAt) fail('archived', 'That series is archived. Restore it first.');
    if (pos === null) pos = Math.floor(((await db.first<{ m: number | null }>('SELECT MAX(position) AS m FROM book WHERE series_id = ? AND archived_at IS NULL AND id <> ?', [seriesId, id]))?.m ?? 0)) + 1;
  } else if (pos !== null) fail('invalid', 'A position needs a series.');
  await write(db, [
    { sql: 'UPDATE book SET series_id = ?, position = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [seriesId, pos, c.now, c.actor, id, c.studioId] },
    audit(c, 'catalogue.book.move', id, { from: { seriesId: cur.seriesId, position: cur.position }, to: { seriesId, position: pos } })
  ], seriesId ? `Position ${pos} in that series is taken, or it already has a book called “${cur.title}”.` : `There is already a book called “${cur.title}” outside any series.`);
  return (await getBook(db, c, id))!;
}

/** Sets or clears an edition's ASIN, ISBN, price or date. The ASIN is the join to Market and Finance, so changing it is audited with the old value. */
export async function updateEdition(db: Db, c: Ctx, id: string, patch: { asin?: string | null; isbn?: string | null; price?: number | null; currency?: string; publishedOn?: string | null }): Promise<Edition> {
  const cur = await getEdition(db, c, id);
  if (!cur) return fail('not-found', 'That edition is not there.');
  if (cur.archivedAt) fail('archived', 'That edition is archived.');
  const asin = 'asin' in patch ? normalizeAsin(patch.asin) : cur.asin;
  const isbn = 'isbn' in patch ? normalizeIsbn(patch.isbn) : cur.isbn;
  const price = 'price' in patch ? cleanPrice(patch.price) : cur.price;
  const currency = 'currency' in patch ? cleanCurrency(patch.currency) : cur.currency;
  const publishedOn = 'publishedOn' in patch ? cleanDate(patch.publishedOn) : cur.publishedOn;
  await write(db, [
    { sql: 'UPDATE edition SET asin = ?, isbn = ?, price = ?, currency = ?, published_on = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [asin, isbn, price, currency, publishedOn, c.now, c.actor, id, c.studioId] },
    audit(c, 'catalogue.edition.update', id, { from: { asin: cur.asin, isbn: cur.isbn, price: cur.price, publishedOn: cur.publishedOn }, to: { asin, isbn, price, publishedOn } })
  ], await whichClash(db, c, cur.bookId, cur.format, asin !== cur.asin ? asin : null, isbn !== cur.isbn ? isbn : null));
  return (await getEdition(db, c, id))!;
}

/**
 * Archive or restore. Archiving an IP archives its series, their books and editions in one batch; restoring needs the parent to be live
 * (a book into a live series, an edition into a live book), and restores only that record, so what was archived separately stays so.
 */
export async function setCatalogueArchived(db: Db, c: Ctx, kind: 'ip' | 'series' | 'book' | 'edition', id: string, archived: boolean): Promise<void> {
  const at = archived ? c.now : null;
  const stamp = [c.now, c.actor];
  const live = 'archived_at IS NULL';
  if (kind === 'ip') {
    if (!(await getIp(db, c, id))) fail('not-found', 'That IP is not there.');
    const cascade = archived
      ? [
          { sql: `UPDATE edition SET archived_at = ?, updated_at = ?, updated_by = ? WHERE ${live} AND book_id IN (SELECT id FROM book WHERE series_id IN (SELECT id FROM series WHERE ip_id = ?))`, params: [at, ...stamp, id] },
          { sql: `UPDATE book SET archived_at = ?, updated_at = ?, updated_by = ? WHERE ${live} AND series_id IN (SELECT id FROM series WHERE ip_id = ?)`, params: [at, ...stamp, id] },
          { sql: `UPDATE series SET archived_at = ?, updated_at = ?, updated_by = ? WHERE ${live} AND ip_id = ?`, params: [at, ...stamp, id] }
        ]
      : [];
    await write(db, [...cascade, { sql: 'UPDATE ip SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [at, ...stamp, id, c.studioId] }, audit(c, `catalogue.ip.${archived ? 'archive' : 'restore'}`, id, {})], 'Restoring it would clash with a live IP of the same name.');
    return;
  }
  if (kind === 'series') {
    const s = await getSeries(db, c, id);
    if (!s) return fail('not-found', 'That series is not there.');
    if (!archived && s.ipId && (await getIp(db, c, s.ipId))?.archivedAt) fail('archived', 'Its IP is archived. Restore the IP first.');
    const cascade = archived
      ? [
          { sql: `UPDATE edition SET archived_at = ?, updated_at = ?, updated_by = ? WHERE ${live} AND book_id IN (SELECT id FROM book WHERE series_id = ?)`, params: [at, ...stamp, id] },
          { sql: `UPDATE book SET archived_at = ?, updated_at = ?, updated_by = ? WHERE ${live} AND series_id = ?`, params: [at, ...stamp, id] }
        ]
      : [];
    await write(db, [...cascade, { sql: 'UPDATE series SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [at, ...stamp, id, c.studioId] }, audit(c, `catalogue.series.${archived ? 'archive' : 'restore'}`, id, {})], 'Restoring it would clash with a live series of the same name.');
    return;
  }
  if (kind === 'book') {
    const b = await getBook(db, c, id);
    if (!b) return fail('not-found', 'That book is not there.');
    if (!archived && b.seriesId && (await getSeries(db, c, b.seriesId))?.archivedAt) fail('archived', 'Its series is archived. Restore the series first.');
    const cascade = archived ? [{ sql: `UPDATE edition SET archived_at = ?, updated_at = ?, updated_by = ? WHERE ${live} AND book_id = ?`, params: [at, ...stamp, id] }] : [];
    await write(db, [...cascade, { sql: 'UPDATE book SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [at, ...stamp, id, c.studioId] }, audit(c, `catalogue.book.${archived ? 'archive' : 'restore'}`, id, {})], 'Restoring it would clash with a live book at that position or with that title.');
    return;
  }
  const e = await getEdition(db, c, id);
  if (!e) return fail('not-found', 'That edition is not there.');
  if (!archived && (await getBook(db, c, e.bookId))?.archivedAt) fail('archived', 'Its book is archived. Restore the book first.');
  await write(db, [{ sql: 'UPDATE edition SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [at, ...stamp, id, c.studioId] }, audit(c, `catalogue.edition.${archived ? 'archive' : 'restore'}`, id, {})], 'Restoring it would clash with a live edition of the same format or ISBN.');
}

// ---- reading -----------------------------------------------------------------------------------------------------------------

export async function listIps(db: Db, c: Pick<Ctx, 'studioId'>, o: { archived?: boolean } = {}): Promise<Ip[]> {
  return db.all<Ip>(`SELECT ${IP_COLS} FROM ip WHERE studio_id = ? AND ${o.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'} ORDER BY lower(name)`, [c.studioId]);
}
export async function listSeries(db: Db, c: Pick<Ctx, 'studioId'>, o: { ipId?: string; archived?: boolean } = {}): Promise<Series[]> {
  return db.all<Series>(`SELECT ${SERIES_COLS} FROM series WHERE studio_id = ? AND ${o.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'}${o.ipId ? ' AND ip_id = ?' : ''} ORDER BY lower(name)`, o.ipId ? [c.studioId, o.ipId] : [c.studioId]);
}
/** Books in a series by position, or all live books (series first, then standalones by title). Each comes with its live editions. */
export async function listBooks(db: Db, c: Pick<Ctx, 'studioId'>, o: { seriesId?: string | null; archived?: boolean } = {}): Promise<BookWithEditions[]> {
  const where = ['studio_id = ?', o.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const params: unknown[] = [c.studioId];
  if (o.seriesId === null) where.push('series_id IS NULL');
  else if (o.seriesId) (where.push('series_id = ?'), params.push(o.seriesId));
  const books = await db.all<Book>(`SELECT ${BOOK_COLS} FROM book WHERE ${where.join(' AND ')} ORDER BY series_id IS NULL, series_id, position, lower(title)`, params);
  if (!books.length) return [];
  const eds = await db.all<Edition>(`SELECT ${EDITION_COLS} FROM edition WHERE studio_id = ? AND ${o.archived ? '1=1' : 'archived_at IS NULL'} ORDER BY format`, [c.studioId]);
  const by = new Map<string, Edition[]>();
  for (const e of eds) by.set(e.bookId, [...(by.get(e.bookId) ?? []), e]);
  return books.map((b) => ({ ...b, editions: by.get(b.id) ?? [] }));
}

/** The book an ASIN belongs to: the join from a Market or Finance row to the catalogue. */
export async function bookByAsin(db: Db, c: Pick<Ctx, 'studioId'>, asin: string): Promise<{ book: Book; edition: Edition } | null> {
  let a: string | null;
  try {
    a = normalizeAsin(asin);
  } catch {
    return null; // not an ASIN, so not any book's
  }
  if (!a) return null;
  const e = await db.first<Edition>(`SELECT ${EDITION_COLS} FROM edition WHERE studio_id = ? AND asin = ?`, [c.studioId, a]);
  if (!e) return null;
  const b = await db.first<Book>(`SELECT ${BOOK_COLS} FROM book WHERE id = ?`, [e.bookId]);
  return b ? { book: b, edition: e } : null;
}
