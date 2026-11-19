// The Preflight page's main-process side on a Studio's own records: an EPUB checked against the catalogue and the approved cover, recorded, waived.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBook } from '@cadrel/write/src/shared/export/assemble';
import { buildEpub } from '@cadrel/write/src/shared/export/epub';
import { defaultBookDetails } from '@cadrel/write/src/shared/export/model';
import { Art } from '../src/main/art';
import { epubcheckFindings } from '../src/main/epubcheck';
import { Preflight, PreflightError, blurbOf, keywordsOf } from '../src/main/preflight';
import { FakeVault, fixture, jpeg, type Fixture } from './artFixture';

let f: Fixture, vault: FakeVault, pre: Preflight, art: Art;
const COVER = jpeg(1600, 2560, 7);
const SRC = '# Chapter 1: Coming Back\n\nShe said so.\n\n# Chapter 2: Leaving\n\nGone.\n';
const epub = (title = 'Dragon Rider', cover: Uint8Array | null = COVER) => {
  const d = defaultBookDetails({ title, author: 'Ash Wilder', year: 2026 });
  d.subtitle = 'Book Four';
  d.copyright.isbn = '978-1-23456-789-7';
  d.back.about = { enabled: true, heading: '', text: 'Bio.' };
  d.back.alsoBy = { enabled: true, heading: '', items: [{ title: 'Book One', url: '', blurb: '' }] };
  const r = assembleBook(SRC, d, { now: new Date('2026-11-19T00:00:00Z'), uuid: () => '123e4567-e89b-12d3-a456-426614174000' });
  return buildEpub(r.build!, cover ? { bytes: cover, ext: 'jpg' } : undefined);
};
const text = (s: string) => new TextEncoder().encode(s);
const go = (name: string, ...args: unknown[]) => art.call(name, args);
const KEYWORDS = '# Keywords\n\n' + ['dragon rider fantasy', 'reverse harem dragons', 'epic fantasy romance', 'fantasy series dragons', 'slow burn dragon rider', 'found family fantasy', 'dragon shifter romance'].map((k, i) => `${i + 1}. ${k}`).join('\n');
const run = async (fileId = 'epub', edition: string | null = null) => {
  const v = await pre.run(fileId, edition);
  if (!v.available) throw new Error(v.reason);
  return v;
};
// Write's EPUBs carry no series metadata, so the catalogue's series always draws this one suggestion; the tests look at everything else
const grades = (v: Awaited<ReturnType<typeof run>>) => v.results.map((r) => `${r.grade}:${r.ruleId}`).filter((g) => g !== 'suggestion:names.series');

beforeEach(async () => {
  f = await fixture();
  vault = new FakeVault([
    { fileId: 'epub', path: 'Book Four/Exports/book.epub', projectId: f.book4, versions: [epub()] },
    { fileId: 'cov', path: 'Book Four/Art/cover.jpg', projectId: f.book4, versions: [COVER] },
    { fileId: 'blurb', path: 'Book Four/Marketing/Blurb.md', projectId: f.book4, versions: [text('# Blurb\n\nA dragon rider falls.\n\n---\n\n## Tropes\n\nslow burn')] },
    { fileId: 'kw', path: 'Book Four/Marketing/Keywords.md', projectId: f.book4, versions: [text(KEYWORDS)] },
    { fileId: 'other', path: 'Book One/Exports/one.epub', projectId: f.book1, versions: [epub('Book One')] }
  ]);
  await f.register(vault);
  art = new Art(f.studio, f.host, vault);
  // the catalogue: the book, its edition, linked to Book Four's project
  const as = f.me();
  const series = await as.catalogue.createSeries({ name: 'Dragon Rider' } as never);
  const book = await as.catalogue.createBook({ title: 'Dragon Rider', subtitle: 'Book Four', penName: 'Ash Wilder', seriesId: series.id, position: 4 });
  await as.catalogue.addEdition(book.id, { format: 'ebook', isbn: '978-1-23456-789-7', price: 4.99 });
  await as.catalogue.linkProject(book.id, f.book4);
  pre = new Preflight(f.studio, f.host, vault, async () => ({ status: 'not installed' }), () => false, () => '2026-12-19T00:00:00Z');
});
afterEach(() => f.close());

describe('Preflight: what the page offers', () => {
  it('lists the EPUBs of the project in view, the editions linked to it, and what the rules were read from and how old that is', async () => {
    const s = await pre.state(f.book4);
    if (!s.available) throw new Error(s.reason);
    expect(s.files.map((x) => [x.path, x.latest])).toEqual([['Book Four/Exports/book.epub', null]]); // not Book One's
    expect(s.editions.map((e) => e.label)).toEqual(['Dragon Rider, ebook (9781234567897)']);
    expect(s.pack).toMatchObject({ id: 'kdp-ebook', verified: '2026-11-19', ageMonths: 1 });
    expect(s.pack.sources.length).toBeGreaterThan(2);
    expect(s.pack.notChecked.length).toBeGreaterThan(0);
    expect(s.may).toEqual({ read: true, run: true });
    expect(s.epubcheck).toBe(false);
    const all = await pre.state(f.series);
    expect(all.available && all.files.length).toBe(2);
    expect(await pre.state('nope')).toMatchObject({ available: false });
  });
});

describe('Preflight: a run', () => {
  it('checks the EPUB against the catalogue and the approved cover; a sound book with its marketing files is ready, and the run is recorded with what it saw', async () => {
    const a = (await go('create', { projectId: f.book4, fileId: 'cov', kind: 'cover' })) as { id: string };
    await go('approve', a.id, 1);
    const v = await run();
    expect(grades(v)).toEqual([]);
    expect(v.run).toMatchObject({ ready: true, errors: 0, fileId: 'epub', fileVersion: 1, packId: 'kdp-ebook', packVerified: '2026-11-19', coverAssetId: a.id, coverVersion: 1, runBy: f.host.me });
    expect(v.run.fileHash).toHaveLength(64);
    expect(v.run.notChecked).toEqual(expect.arrayContaining([expect.stringContaining('epubcheck')]));
    expect(v.byName).toBe('you');
    expect(v.path).toBe('Book Four/Exports/book.epub');
    expect(v.editionLabel).toContain('Dragon Rider');
    expect(v.epubcheck).toBe('not installed');
    const s = await pre.state(f.book4);
    expect(s.available && s.files[0]!.latest).toMatchObject({ id: v.run.id, ready: true });
  });

  it('without an approved cover it says so; with a different cover than the approved one it says which', async () => {
    expect(grades(await run())).toEqual(['warning:cover.approved']);
    const a = (await go('create', { projectId: f.book4, fileId: 'cov', kind: 'cover' })) as { id: string };
    await go('approve', a.id, 1);
    // the EPUB is rebuilt with a different cover: not the approved file
    await f.db().run("UPDATE vault_file SET current_version = 1 WHERE id = 'epub'");
    vault.list[0]!.versions = [epub('Dragon Rider', jpeg(1600, 2560, 99))];
    await f.db().run("UPDATE file_version SET hash = 'x' WHERE file_id = 'epub'");
    const v = await run();
    expect(v.results.find((r) => r.ruleId === 'cover.approved')).toMatchObject({ grade: 'warning', what: expect.stringContaining('not the approved cover (version 1)') });
  });

  it('planted defects are found with what was measured and expected; a wrong title and a small cover are errors; the run is not ready', async () => {
    vault.list[0]!.versions = [epub('Dragon Rider Three', jpeg(400, 450))];
    const v = await run();
    expect(v.run).toMatchObject({ ready: false });
    expect(v.results.find((r) => r.ruleId === 'names.title')).toMatchObject({ grade: 'error', measured: 'Dragon Rider Three', expected: 'Dragon Rider (or Dragon Rider: Book Four)' });
    expect(v.results.find((r) => r.ruleId === 'cover.size')).toMatchObject({ grade: 'error', measured: '400 × 450 pixels' });
    expect(v.results[0]!.grade).toBe('error'); // worst first
  });

  it('the blurb and keywords come from the marketing files; with none found it says so, and an over-long blurb is an error', async () => {
    vault.list.splice(2, 2);
    await f.db().run("DELETE FROM file_card WHERE file_id IN ('blurb', 'kw')");
    expect(grades(await run())).toEqual(expect.arrayContaining(['warning:meta.blurb', 'warning:meta.keywords']));
    vault.list.push({ fileId: 'blurb2', path: 'Book Four/Marketing/Blurb.md', projectId: f.book4, versions: [text('x'.repeat(4001))] });
    expect(grades(await run())).toContain('error:meta.blurb');
  });

  it('a waiver needs a reason, and carries onto the next run of the same file', async () => {
    vault.list[0]!.versions = [epub('Dragon Rider', jpeg(400, 450))];
    const first = await run();
    const seq = first.results.find((r) => r.ruleId === 'cover.size')!.seq;
    await expect(pre.waive(first.run.id, seq, ' ')).rejects.toThrow(/reason/);
    const w = await pre.waive(first.run.id, seq, 'The retailer accepts this size for a box set.');
    if (!w.available) throw new Error(w.reason);
    expect(w.run.errors).toBe(first.run.errors - 1);
    const second = await run();
    expect(second.results.find((r) => r.ruleId === 'cover.size')).toMatchObject({ state: 'waived', waivedReason: 'The retailer accepts this size for a box set.', carried: true });
    expect(second.run.errors).toBe(w.run.errors);
    expect((await pre.get(second.run.id)).available).toBe(true);
  });

  it('without a chosen or linked edition the names are not compared, and it says so', async () => {
    await f.db().run('DELETE FROM book_project');
    const v = await run();
    expect(v.results.map((r) => r.ruleId)).toContain('names.nocatalogue');
    expect(v.editionLabel).toBeNull();
  });

  it('refuses what is not an EPUB, a file in no project, and an edition that is not there', async () => {
    await expect(pre.run('cov', null)).rejects.toThrow(/EPUB/);
    await expect(pre.run('nope', null)).rejects.toBeInstanceOf(PreflightError);
    await expect(pre.run('epub', 'nope')).rejects.toThrow(/edition/);
    vault.list.push({ fileId: 'free', path: 'free.epub', projectId: null, versions: [epub()] });
    await expect(pre.run('free', null)).rejects.toThrow(/no project/);
  });

  it('epubcheck, when it runs, adds its messages, graded the same way, and the run says it was used', async () => {
    const withCheck = new Preflight(f.studio, f.host, vault, async () => ({ status: 'used', findings: epubcheckFindings({ messages: [{ ID: 'RSC-005', severity: 'ERROR', message: 'Element "p" not allowed here.', locations: [{ path: 'OEBPS/ch1.xhtml', line: 12 }] }, { ID: 'OPF-014', severity: 'USAGE', message: 'Add the scripted property.', locations: [] }] }) }), () => true, () => '2026-12-19T00:00:00Z');
    const v = await withCheck.run('epub', null);
    if (!v.available) throw new Error(v.reason);
    expect(v.epubcheck).toBe('used');
    expect(v.results.find((r) => r.ruleId === 'epubcheck.RSC-005')).toMatchObject({ grade: 'error', location: 'OEBPS/ch1.xhtml:12' });
    expect(v.results.find((r) => r.ruleId === 'epubcheck.OPF-014')).toMatchObject({ grade: 'suggestion' });
    expect(v.run.notChecked.some((n) => /epubcheck/i.test(n))).toBe(false);
    const failed = new Preflight(f.studio, f.host, vault, async () => ({ status: 'failed', why: 'x' }), () => true);
    const fv = await failed.run('epub', null);
    expect(fv.available && fv.epubcheck).toBe('failed');
  });
});

describe('Preflight: reading the marketing files', () => {
  it('keywords are the bullet or numbered lines; a file with none has no keywords', () => {
    expect(keywordsOf(KEYWORDS)).toHaveLength(7);
    expect(keywordsOf('- **one**\n* `two`\n• three\nnot a keyword')).toEqual(['one', 'two', 'three']);
    expect(keywordsOf('# Keywords\n\nnothing yet')).toBeNull();
  });
  it('the blurb is what comes before the structured block', () => {
    expect(blurbOf('# Blurb\n\nA dragon rider falls.\n\n---\n\n## Tropes\n\nslow burn')).toBe('A dragon rider falls.');
    expect(blurbOf('Hook.\n\nSetup.\n\n## Tropes\nx')).toBe('Hook.\n\nSetup.');
    expect(blurbOf('Just this.')).toBe('Just this.');
  });
  it('epubcheck’s report: severities become grades, repeats are folded, unknown severities are dropped', () => {
    const m = { ID: 'X', severity: 'WARNING', message: 'm', locations: [{ path: 'a.xhtml' }] };
    expect(epubcheckFindings({ messages: [m, m, { ID: 'Y', severity: 'FATAL', message: 'bad' }, { ID: 'Z', severity: 'WEIRD', message: 'q' }] }).map((x) => [x.ruleId, x.grade])).toEqual([['epubcheck.X', 'warning'], ['epubcheck.Y', 'error']]);
    expect(epubcheckFindings(null)).toEqual([]);
  });
});
