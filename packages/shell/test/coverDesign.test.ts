// The Cover Designer's main-process side over a real vault in a temporary folder: what it offers, importing pictures, saving a design and its
// picture as one cover asset, reopening it, and refusing what would make the picture not the render of the design.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoverDesign, CoverError, safeName } from '../src/main/coverDesign';
import { VaultHost } from '../src/main/vaultHost';
import { addLayer, newDesign, newImage, newText, parse, serialize } from '../src/shared/cover/doc';
import { STARTER_FONTS } from '../src/shared/cover/fonts';
import { fixture, type Fixture } from './artFixture';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const png = (w: number, h: number, colour = '#336699') => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();

let f: Fixture, vault: VaultHost, cover: CoverDesign, work: string;
const ebook = async (title = 'Dragon', pic?: { path: string; hash: string }) => {
  let d = newDesign('ebook', { w: 400, h: 640 });
  if (pic) d = addLayer(d, newImage(pic, { w: 100, h: 100 }, d.canvas));
  return addLayer(d, newText(title));
};
beforeEach(async () => {
  f = await fixture();
  work = path.join(f.dir, 'Vault');
  vault = new VaultHost(f.host, { dir: work, blobsDir: path.join(f.dir, 'blobs'), machine: 'pc-a' });
  await fsp.mkdir(work, { recursive: true });
  cover = new CoverDesign(f.studio, f.host, vault, work, path.resolve(__dirname, '../assets'));
});
afterEach(() => f.close());

describe('names', () => {
  it('makes a name that is safe on any system', () => {
    expect(safeName('Book 4: The "Last" Dragon?')).toBe('Book 4 The Last Dragon');
    expect(safeName('con')).toBe('Cover');
    expect(safeName('   ...  ')).toBe('Cover');
    expect(safeName('x'.repeat(200))).toHaveLength(60);
  });
});

describe('importing pictures', () => {
  it('puts a picture in the project’s files and says where, never overwriting one of the same name', async () => {
    const a = await cover.importPicture({ projectId: f.book4, name: 'moon.png', bytes: await png(30, 20), role: 'picture' });
    const b = await cover.importPicture({ projectId: f.book4, name: 'moon.png', bytes: await png(30, 20, '#aa0000'), role: 'picture' });
    expect(a).toMatchObject({ path: 'Art/Book Four/Pictures/moon.png', width: 30, height: 20 });
    expect(b.path).toBe('Art/Book Four/Pictures/moon (2).png');
    expect((await vault.files()).map((x) => x.path).sort()).toEqual([b.path, a.path]);
    expect((await vault.files())[0]!.projectId).toBe(f.book4);
    const t = await cover.importPicture({ projectId: f.book4, name: 'template.png', bytes: await png(50, 40), role: 'template' });
    expect(t.path).toBe('Art/Book Four/Templates/template.png');
  });
  it('refuses what is not a picture, and a role that may not write', async () => {
    await expect(cover.importPicture({ projectId: f.book4, name: 'x.png', bytes: new TextEncoder().encode('not a picture'), role: 'picture' })).rejects.toThrow(/cannot read that as a picture/);
    const nope = new CoverDesign(f.studio, new Proxy(f.host, { get: (t, k) => (k === 'mayOn' ? async () => false : (t as never)[k]) }), vault, work, '');
    await expect(nope.importPicture({ projectId: f.book4, name: 'x.png', bytes: await png(5, 5), role: 'picture' })).rejects.toThrow(CoverError);
  });
});

describe('offering what a design can use', () => {
  it('lists the project’s pictures and designs, and fills a title block from the project names', async () => {
    const p = await cover.importPicture({ projectId: f.book4, name: 'sky.png', bytes: await png(10, 10), role: 'picture' });
    const d = await ebook();
    await cover.save({ projectId: f.book4, name: 'Front', design: serialize(d), image: await png(400, 640) });
    const c = await cover.context(f.book4);
    if (!c.available) throw new Error(c.reason);
    expect(c.pictures.map((x) => x.path)).toEqual(['Art/Book Four/Front.png', p.path]);
    expect(c.designs).toMatchObject([{ path: 'Art/Book Four/Front.cadrel-cover.json', imagePath: 'Art/Book Four/Front.png', name: 'Front' }]);
    expect(c.fields).toMatchObject({ title: 'Book Four', series: 'Dragon Rider' });
    expect(c.may.write).toBe(true);
    const other = await cover.context(f.book1);
    if (!other.available) throw new Error('x');
    expect(other.designs).toEqual([]); // Book One has none of Book Four's
    expect(await cover.context('nope')).toMatchObject({ available: false });
  });
});

describe('saving a cover', () => {
  it('saves the design and its picture as two files, makes the picture an asset, and records which picture it is', async () => {
    const pic = await cover.importPicture({ projectId: f.book4, name: 'sky.png', bytes: await png(10, 10), role: 'picture' });
    const image = await png(400, 640);
    const saved = await cover.save({ projectId: f.book4, name: 'Front: The Dragon', design: serialize(await ebook('Dragon', { path: pic.path, hash: pic.hash })), image });
    expect(saved).toMatchObject({ designPath: 'Art/Book Four/Front The Dragon.cadrel-cover.json', imagePath: 'Art/Book Four/Front The Dragon.png', frontPath: null, version: 1 });
    const asset = await f.me().assets.get(saved.assetId);
    expect(asset).toMatchObject({ kind: 'cover', state: 'draft', projectId: f.book4, name: 'Front The Dragon' });
    const design = parse(await fsp.readFile(path.join(work, ...saved.designPath.split('/')), 'utf8'));
    expect(design.render).toEqual({ path: saved.imagePath, hash: sha(image) });
    const d = await vault.detail(saved.designPath);
    expect(d.uses.map((u) => u.path)).toEqual([pic.path]);
    expect((await vault.detail(saved.imagePath)).uses.map((u) => u.path)).toEqual([saved.designPath]);
  });
  it('saves again as new versions of the same files and the same asset', async () => {
    const first = await cover.save({ projectId: f.book4, name: 'Front', design: serialize(await ebook('One')), image: await png(400, 640, '#111111') });
    const second = await cover.save({ projectId: f.book4, name: 'ignored', designPath: first.designPath, design: serialize(await ebook('Two')), image: await png(400, 640, '#222222'), comment: 'New title' });
    expect(second).toMatchObject({ assetId: first.assetId, designPath: first.designPath, imagePath: first.imagePath, version: 2 });
    expect((await vault.history(first.imagePath)).map((h) => h.comment)).toEqual(['New title', 'Saved from the Cover Designer']);
    expect(await f.me().assets.list({ projectIds: [f.book4] })).toHaveLength(1);
    // the same design saved with a picture that has not changed is not a new version
    const again = await cover.save({ projectId: f.book4, name: 'x', designPath: first.designPath, design: serialize(await ebook('Two')), image: await png(400, 640, '#222222') });
    expect((await vault.history(first.imagePath)).length).toBe(2);
    expect(again.assetId).toBe(first.assetId);
  });
  it('gives a second design of the same name its own files', async () => {
    const a = await cover.save({ projectId: f.book4, name: 'Front', design: serialize(await ebook()), image: await png(400, 640) });
    const b = await cover.save({ projectId: f.book4, name: 'Front', design: serialize(await ebook()), image: await png(400, 640, '#999999') });
    expect(b.designPath).toBe('Art/Book Four/Front (2).cadrel-cover.json');
    expect(b.assetId).not.toBe(a.assetId);
  });
  it('refuses a picture that is not the render of the design', async () => {
    const design = serialize(await ebook());
    await expect(cover.save({ projectId: f.book4, name: 'x', design, image: await png(100, 100) })).rejects.toThrow(/this design is 400 × 640/);
    await expect(cover.save({ projectId: f.book4, name: 'x', design, image: await sharp({ create: { width: 400, height: 640, channels: 3, background: '#fff' } }).jpeg().toBuffer() })).rejects.toThrow(/must be a PNG/);
    await expect(cover.save({ projectId: f.book4, name: 'x', design: 'not json', image: await png(400, 640) })).rejects.toThrow(/not a Cover Designer file/);
    await expect(cover.save({ projectId: f.book4, name: 'x', design, image: await png(400, 640), front: await png(200, 640) })).rejects.toThrow(/no separate front/);
    expect(await vault.files()).toEqual([]); // nothing half-saved
  });
  it('saves a paperback with its full wrap and its front cover, as two pictures of one design', async () => {
    let d = newDesign('paperback', { w: 800, h: 600 });
    d = { ...d, template: { src: { path: 'Art/Book Four/Templates/t.png', hash: 'h' }, opacity: 0.3, hidden: false, back: 0.45, front: 0.55 } };
    const s = await cover.save({ projectId: f.book4, name: 'Wrap', design: serialize(d), image: await png(800, 600), front: await png(360, 600) });
    expect(s.frontPath).toBe('Art/Book Four/Wrap-front.png');
    expect((await vault.files()).map((x) => x.path).sort()).toEqual(['Art/Book Four/Wrap-front.png', 'Art/Book Four/Wrap.cadrel-cover.json', 'Art/Book Four/Wrap.png']);
    // the template is not an input the picture was made from, only something the design points at
    expect(parse(await fsp.readFile(path.join(work, 'Art', 'Book Four', 'Wrap.cadrel-cover.json'), 'utf8')).template?.back).toBe(0.45);
  });
  it('refuses to save for a role that may not write, and over another project’s design', async () => {
    const own = await cover.save({ projectId: f.book4, name: 'Front', design: serialize(await ebook()), image: await png(400, 640) });
    await expect(cover.save({ projectId: f.book1, name: 'x', designPath: own.designPath, design: serialize(await ebook()), image: await png(400, 640) })).rejects.toThrow(/another project/);
    const nope = new CoverDesign(f.studio, new Proxy(f.host, { get: (t, k) => (k === 'mayOn' ? async () => false : (t as never)[k]) }), vault, work, '');
    await expect(nope.save({ projectId: f.book4, name: 'x', design: serialize(await ebook()), image: await png(400, 640) })).rejects.toThrow(/does not let you/);
  });
});

describe('opening a design', () => {
  it('gives back the text, the asset, and which pictures are here, missing or changed', async () => {
    const pic = await cover.importPicture({ projectId: f.book4, name: 'sky.png', bytes: await png(10, 10), role: 'picture' });
    const gone = { path: 'Art/Book Four/Pictures/gone.png', hash: 'x' };
    let d = await ebook('Dragon', { path: pic.path, hash: pic.hash });
    d = addLayer(d, newImage(gone, { w: 1, h: 1 }, d.canvas));
    const s = await cover.save({ projectId: f.book4, name: 'Front', design: serialize(d), image: await png(400, 640) });
    let o = await cover.open(s.designPath);
    expect(o).toMatchObject({ path: s.designPath, version: 1, assetId: s.assetId });
    expect(o.pictures).toEqual([{ path: pic.path, state: 'ok' }, { path: gone.path, state: 'missing' }]);
    expect(parse(o.text).layers).toHaveLength(3);
    // the picture is replaced by a newer version: the design says so
    await vault.call('checkOut', [pic.path]);
    await fsp.writeFile(path.join(work, ...pic.path.split('/')), await png(10, 10, '#ff0000'));
    await vault.call('checkIn', [pic.path, 'recoloured']);
    o = await cover.open(s.designPath);
    expect(o.pictures[0]).toEqual({ path: pic.path, state: 'changed' });
    await expect(cover.open(pic.path)).rejects.toThrow(/not a Cover Designer file/);
    await expect(cover.open('Art/none.cadrel-cover.json')).rejects.toThrow(/not in the vault/);
  });
  it('reads a picture to draw, and refuses what cannot be drawn', async () => {
    const pic = await cover.importPicture({ projectId: f.book4, name: 'sky.png', bytes: await png(10, 20), role: 'picture' });
    const img = await cover.image(pic.path);
    expect(img).toMatchObject({ mime: 'image/png', width: 10, height: 20, version: 1, hash: pic.hash });
    expect(img.bytes.length).toBeGreaterThan(20);
    await expect(cover.image('Art/missing.png')).rejects.toThrow(/not in the vault/);
  });
});

describe('fonts', () => {
  it('gives the starter fonts as data and nothing for a family that is not one', async () => {
    const fonts = await cover.fonts(['Cinzel', 'Montserrat', 'Comic Sans', 'Bebas Neue', 'Cinzel']);
    expect(fonts.map((x) => `${x.family} ${x.weight}`)).toEqual(['Cinzel 400', 'Cinzel 700', 'Montserrat 400', 'Montserrat 700', 'Bebas Neue 400']);
    expect(fonts.every((x) => x.dataUrl.startsWith('data:font/woff2;base64,'))).toBe(true);
  });

  it('every starter font is a file that exists beside its licence, and the licence is the SIL Open Font License 1.1', async () => {
    const roots = [path.resolve(__dirname, '../assets'), path.resolve(__dirname, '../../write/assets')];
    for (const f of STARTER_FONTS) {
      for (const rel of Object.values(f.files)) {
        const abs = [path.resolve(roots[0]!, rel), path.resolve(roots[1]!, rel)].find((p) => require('node:fs').existsSync(p));
        expect(abs, `${f.family}: ${rel}`).toBeTruthy();
        const licence = await fsp.readFile(path.join(path.dirname(abs!), 'OFL.txt'), 'utf8');
        expect(licence).toMatch(/SIL Open Font License,? Version 1\.1/i);
        expect((await fsp.stat(abs!)).size).toBeGreaterThan(5000);
      }
    }
  });
});
