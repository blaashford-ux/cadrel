// The Cover Designer's exit test (docs/COVER-DESIGNER-PLAN.md): a cover is designed, saved, reopened and changed, offered against a brief, chosen,
// approved as an exact version, and Preflight's cover check reads that same file. Over a real vault in a temporary folder and the Studio's own
// records; what the screen does is covered by coverDesigner.test.tsx and what the browser draws by coverExport.test.ts.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBook } from '@cadrel/write/src/shared/export/assemble';
import { buildEpub } from '@cadrel/write/src/shared/export/epub';
import { defaultBookDetails } from '@cadrel/write/src/shared/export/model';
import { CoverDesign } from '../src/main/coverDesign';
import { Preflight } from '../src/main/preflight';
import { VaultHost } from '../src/main/vaultHost';
import { addScrim, addLayer, newDesign, newImage, parse, patchLayer, serialize, type TextLayer } from '../src/shared/cover/doc';
import { titleBlock } from '../src/shared/cover/arrange';
import { fixedMeasure } from '../src/shared/cover/text';
import { fixture, type Fixture } from './artFixture';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const KDP = { w: 1600, h: 2560 };
const picture = (colour: string) => sharp({ create: { width: KDP.w, height: KDP.h, channels: 3, background: colour } }).png().toBuffer();

let f: Fixture, vault: VaultHost, cover: CoverDesign, work: string;
beforeEach(async () => {
  f = await fixture();
  work = path.join(f.dir, 'Vault');
  await fsp.mkdir(work, { recursive: true });
  vault = new VaultHost(f.host, { dir: work, blobsDir: path.join(f.dir, 'blobs'), machine: 'pc-a' });
  cover = new CoverDesign(f.studio, f.host, vault, work, path.resolve(__dirname, '../assets'));
});
afterEach(() => f.close());

const epub = (cover: Uint8Array) => {
  const d = defaultBookDetails({ title: 'Dragon Rider', author: 'Ash Wilder', year: 2026 });
  d.subtitle = 'Book Four';
  d.copyright.isbn = '978-1-23456-789-7';
  d.back.about = { enabled: true, heading: '', text: 'Bio.' };
  d.back.alsoBy = { enabled: true, heading: '', items: [{ title: 'Book One', url: '', blurb: '' }] };
  const r = assembleBook('# Chapter 1: Coming Back\n\nShe said so.\n\n# Chapter 2: Leaving\n\nGone.\n', d, { now: new Date('2026-11-19T00:00:00Z'), uuid: () => '123e4567-e89b-12d3-a456-426614174000' });
  return buildEpub(r.build!, { bytes: cover, ext: 'png' });
};

describe('Cover Designer exit test: a cover is designed, saved, changed, chosen, approved, and used by Preflight', () => {
  it('goes from a brief and a picture to an approved cover that Preflight finds in the EPUB, and nothing about it was typed as a number', async () => {
    const me = f.me();
    const series = await me.catalogue.createSeries({ name: 'Dragon Rider' } as never);
    const book = await me.catalogue.createBook({ title: 'Dragon Rider', subtitle: 'Book Four', penName: 'Ash Wilder', seriesId: series.id, position: 4 });
    const edition = await me.catalogue.addEdition(book.id, { format: 'ebook', isbn: '978-1-23456-789-7', price: 4.99 });
    await me.catalogue.linkProject(book.id, f.book4);
    await me.briefs.create({ projectId: f.book4, kind: 'cover', title: 'Cover for Book Four', body: 'A dragon at dusk.' }).then(async (b) => {
      // ---- the person brings a picture into the project and makes a cover of it with a title block, a darkened band and a texture
      const sky = await cover.importPicture({ projectId: f.book4, name: 'dusk.png', bytes: await picture('#3a1f5e'), role: 'picture' });
      let d = newDesign('ebook');
      d = addLayer(d, newImage({ path: sky.path, hash: sky.hash }, { w: sky.width, h: sky.height }, d.canvas, 'Dusk'));
      const block = titleBlock(d, 'low', 'epic', { title: 'Dragon Rider', subtitle: 'Book Four', series: 'The Ember Wars', author: 'Ash Wilder' }, fixedMeasure);
      d = block.design;
      const title = d.layers.find((l) => l.name === 'Title') as TextLayer;
      d = addScrim(d, title.id, { strength: 0.7 }).design;
      d = { ...d, layers: d.layers.map((l) => (l.id === title.id ? { ...l, fx: { glow: { color: '#ffb347', size: 0.008, strength: 0.7 }, texture: { id: 'foil', strength: 0.6, scale: 1 } } } : l)) };
      expect(d.layers.map((l) => l.name)).toEqual(['Dusk', 'Series line', 'Darken behind Title', 'Title', 'Subtitle', 'Author']);
      const v1 = await picture('#101030');
      const saved = await cover.save({ projectId: f.book4, name: 'Front', design: serialize(d), image: v1 });
      expect(await me.assets.get(saved.assetId)).toMatchObject({ kind: 'cover', state: 'draft' });
      // ---- it is reopened a day later and the title colour changed; saving again is version 2 of the same asset
      const opened = await cover.open(saved.designPath);
      expect(opened).toMatchObject({ version: 1, assetId: saved.assetId, pictures: [{ path: sky.path, state: 'ok' }] });
      const again = parse(opened.text);
      expect(again.layers).toEqual(d.layers); // nothing lost in the round trip
      const recoloured = patchLayer<TextLayer>(again, title.id, { fill: { type: 'solid', color: '#ffd27a' } });
      const v2 = await picture('#202040');
      const second = await cover.save({ projectId: f.book4, name: 'x', designPath: saved.designPath, design: serialize(recoloured), image: v2, comment: 'Warmer title' });
      expect(second).toMatchObject({ assetId: saved.assetId, version: 2 });
      expect((await vault.history(saved.imagePath)).map((h) => h.comment)).toEqual(['Warmer title', 'Saved from the Cover Designer']);
      expect(parse(await fsp.readFile(path.join(work, ...saved.designPath.split('/')), 'utf8')).render).toEqual({ path: saved.imagePath, hash: sha(v2) });

      // ---- offered against the brief, chosen, and approved as an exact version
      const png = (await vault.files()).find((x) => x.path === saved.imagePath)!;
      const concept = await me.assets.submitConcept({ briefId: b.id, fileId: png.fileId });
      expect(concept).toMatchObject({ fileVersion: 2, briefVersion: 1 });
      const { asset } = await me.assets.chooseConcept(concept.id);
      expect(asset).toMatchObject({ id: saved.assetId, state: 'in_review' });
      const ap = await me.assets.approve(asset.id, 2, 'Approved.');
      expect(ap).toMatchObject({ version: 2, hash: sha(v2) }); // the approval names the exact picture the design saved
      // a later save is a newer version that is not approved
      await cover.save({ projectId: f.book4, name: 'x', designPath: saved.designPath, design: serialize(recoloured), image: await picture('#303050') });
      const list = await me.assets.list({ projectIds: [f.book4] });
      expect(list.find((a) => a.id === asset.id)).toBeTruthy();
      expect((await me.assets.approved(asset.id)).map((a) => a.version)).toEqual([2]);

      // ---- Preflight: an EPUB that carries the approved picture is the approved cover; one that carries the newer one is not
      const abs = (rel: string) => path.join(work, ...rel.split('/'));
      await fsp.writeFile(abs('Art/Book Four/book.epub'), epub(v2));
      await vault.call('add', ['Art/Book Four/book.epub', 'Export', f.book4]);
      const epubFile = (await vault.files()).find((x) => x.path.endsWith('book.epub'))!.fileId;
      const pre = new Preflight(f.studio, f.host, vault, async () => ({ status: 'not installed' }), () => false, () => '2026-12-19T00:00:00Z');
      const run = await pre.run(epubFile, edition.id);
      if (!run.available) throw new Error(run.reason);
      expect(run.run).toMatchObject({ coverAssetId: asset.id, coverVersion: 2 });
      expect(run.results.map((r) => r.ruleId)).not.toContain('cover.approved'); // the EPUB's cover is the approved cover
      expect(run.results.find((r) => r.ruleId === 'cover.size')).toBeUndefined(); // and the picture meets KDP's size, as the designer's canvas is
      await vault.call('checkOut', ['Art/Book Four/book.epub']);
      await fsp.writeFile(abs('Art/Book Four/book.epub'), epub(await picture('#303050')));
      await vault.call('checkIn', ['Art/Book Four/book.epub', 'With the newer cover']);
      const other = await pre.run(epubFile, edition.id);
      if (!other.available) throw new Error(other.reason);
      expect(other.results.find((r) => r.ruleId === 'cover.approved')).toMatchObject({ grade: 'warning', what: expect.stringContaining('not the approved cover (version 2)') });
    });
  });

  it('a paperback is saved as a full wrap and a front, and neither carries the template', async () => {
    let d = newDesign('paperback', { w: 900, h: 600 });
    d = { ...d, template: { src: { path: 'Art/Book Four/Templates/t.png', hash: 'h' }, opacity: 0.35, hidden: false, back: 0.45, front: 0.55 } };
    const wrap = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#223355' } }).png().toBuffer();
    const front = await sharp({ create: { width: 405, height: 600, channels: 3, background: '#223355' } }).png().toBuffer();
    const s = await cover.save({ projectId: f.book4, name: 'Wrap', design: serialize(d), image: wrap, front });
    expect(s.frontPath).toBe('Art/Book Four/Wrap-front.png');
    expect(sha(await vault.bytesOf((await vault.files()).find((x) => x.path === s.frontPath)!.fileId, 1))).toBe(sha(front));
    expect(parse(await fsp.readFile(path.join(work, ...s.designPath.split('/')), 'utf8')).template).toMatchObject({ back: 0.45, front: 0.55, opacity: 0.35 });
  });
});
