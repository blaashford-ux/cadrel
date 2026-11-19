import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runPreflight, type PreflightFacts } from '@cadrel/kernel';
import { assembleBook } from '@cadrel/write/src/shared/export/assemble';
import { buildEpub } from '@cadrel/write/src/shared/export/epub';
import { defaultBookDetails } from '@cadrel/write/src/shared/export/model';
import { inspectEpub } from '../src/main/epubInspect';

const SRC = '# Chapter 1: Coming Back\n\nShe said so.\n\n# Chapter 2: Leaving\n\nGone.\n';
/** A JPEG header the size of a cover (enough for the reader, which only looks at the header). */
const jpeg = (w: number, h: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

const details = () => {
  const d = defaultBookDetails({ title: 'Dragon Rider', author: 'Ash Wilder', year: 2026 });
  d.subtitle = 'Book Four';
  d.copyright.isbn = '978-1-23456-789-7';
  d.back.about = { enabled: true, heading: '', text: 'Bio.' };
  d.back.alsoBy = { enabled: true, heading: '', items: [{ title: 'Book One', url: '', blurb: '' }] };
  return d;
};
const COVER = jpeg(1600, 2560);
const built = (cover: Uint8Array | null = COVER) => {
  const r = assembleBook(SRC, details(), { now: new Date('2026-11-19T00:00:00Z'), uuid: () => '123e4567-e89b-12d3-a456-426614174000' });
  expect(r.errors).toEqual([]);
  return buildEpub(r.build!, cover ? { bytes: cover, ext: 'jpg' } : undefined);
};
const facts = (bytes: Uint8Array): PreflightFacts => {
  const epub = inspectEpub(bytes);
  return {
    epub,
    book: { title: 'Dragon Rider', subtitle: 'Book Four', author: 'Ash Wilder', series: null, seriesNumber: null, isbn: '978-1-23456-789-7', asin: null, language: 'en', price: 4.99, publishedOn: null, blurb: 'A dragon.', keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    approvedCover: { assetId: 'a', version: 1, hash: createHash('sha256').update(COVER).digest('hex'), format: 'jpeg', width: 1600, height: 2560, colour: 'rgb', dpi: null, bytes: COVER.length },
    epubCover: { colour: 'rgb', dpi: null }
  };
};
const rezip = (bytes: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array => {
  const files = unzipSync(bytes);
  edit(files);
  const z: Zippable = { mimetype: [files.mimetype!, { level: 0 }] };
  for (const [k, v] of Object.entries(files)) if (k !== 'mimetype') z[k] = v;
  return zipSync(z);
};
const rules = (f: PreflightFacts) => runPreflight(f).map((x) => `${x.grade}:${x.ruleId}`);

describe('reading an EPUB for Preflight', () => {
  it('reads the structure of a book Write built: package, navigation, documents, cover and title page', () => {
    const f = inspectEpub(built());
    expect(f.zip).toMatchObject({ readable: true, mimetypeFirst: true, mimetypeStored: true, mimetypeText: 'application/epub+zip' });
    expect(f.opf).toMatchObject({ wellFormed: true, title: 'Dragon Rider', creators: ['Ash Wilder'], language: 'en', version: '3.0' });
    expect(f.opf!.identifiers.some((i) => i.includes('9781234567897'))).toBe(true);
    expect(f.opf!.manifest.every((m) => m.present)).toBe(true);
    expect(f.nav).toMatchObject({ hasToc: true });
    expect(f.nav!.entries.length).toBeGreaterThanOrEqual(2);
    expect(f.nav!.entries.every((e) => e.resolved)).toBe(true);
    expect(f.ncx).toBe(true);
    expect(f.documents.length).toBeGreaterThan(3);
    expect(f.documents.every((d) => d.wellFormed && d.brokenLinks.length === 0)).toBe(true);
    expect(f.cover).toMatchObject({ format: 'jpeg', width: 1600, height: 2560 });
    expect(f.titlePage).toEqual({ title: 'Dragon Rider', author: 'Ash Wilder' });
  });

  it('a clean build checks out against a matching catalogue and the approved cover', () => {
    expect(runPreflight(facts(built()))).toEqual([]);
  });

  it('finds what is planted: a dangling manifest item, a broken contents entry, a wrong title, a small cover, a different cover', () => {
    const base = built();
    const missing = rezip(base, (f) => {
      const k = Object.keys(f).find((n) => /ch.*0*1.*\.xhtml$/i.test(n) && !/nav|title/.test(n))!;
      delete f[k];
    });
    expect(rules(facts(missing))).toEqual(expect.arrayContaining(['error:epub.manifest']));
    const small = built(jpeg(400, 450));
    const r = runPreflight(facts(small));
    expect(r.find((x) => x.ruleId === 'cover.size')).toMatchObject({ grade: 'error', measured: '400 × 450 pixels' });
    expect(r.find((x) => x.ruleId === 'cover.approved')).toMatchObject({ grade: 'warning' }); // not the approved file
    const f = facts(base);
    f.book.title = 'Dragon Rider Three';
    expect(runPreflight(f).find((x) => x.ruleId === 'names.title')).toMatchObject({ grade: 'error' });
  });

  it('a broken link and a missing image inside a chapter are found with the file they are in', () => {
    const bad = rezip(built(), (f) => {
      const k = Object.keys(f).find((n) => /\.xhtml$/.test(n) && /Coming Back|Chapter 1/.test(strFromU8(f[n]!)))!;
      f[k] = strToU8(strFromU8(f[k]!).replace('</body>', '<p><a href="nowhere.xhtml">x</a><img src="images/gone.png" alt=""/></p></body>'));
    });
    const found = runPreflight(facts(bad));
    expect(found.find((x) => x.ruleId === 'doc.links')).toMatchObject({ measured: 'nowhere.xhtml' });
    expect(found.find((x) => x.ruleId === 'doc.images')).toMatchObject({ measured: 'images/gone.png' });
    expect(found.find((x) => x.ruleId === 'doc.links')!.location).toMatch(/\.xhtml$/);
  });

  it('a chapter that is not well-formed XML, a compressed mimetype, and a file that is not a zip', () => {
    const broken = rezip(built(), (f) => {
      const k = Object.keys(f).find((n) => /\.xhtml$/.test(n) && /Coming Back|Chapter 1/.test(strFromU8(f[n]!)))!;
      f[k] = strToU8(strFromU8(f[k]!).replace('</body>', '<p></body>'));
    });
    expect(rules(facts(broken))).toContain('error:doc.xml');
    const compressed = zipSync(Object.fromEntries(Object.entries(unzipSync(built())).map(([k, v]) => [k, [v, { level: 6 }]])) as Zippable);
    expect(rules(facts(compressed))).toContain('error:epub.mimetype');
    const nope = facts(strToU8('this is not an epub'));
    expect(runPreflight(nope)[0]).toMatchObject({ ruleId: 'epub.zip', grade: 'error' });
  });

  it('a cover-less build has no cover; a package that is not XML is reported', () => {
    expect(rules(facts(built(null)))).toContain('error:cover.missing');
    const bad = rezip(built(), (f) => {
      const k = Object.keys(f).find((n) => n.endsWith('.opf'))!;
      f[k] = strToU8('<package><metadata></package>');
    });
    expect(rules(facts(bad))[0]).toBe('error:epub.package');
  });
});

function strFromU8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
