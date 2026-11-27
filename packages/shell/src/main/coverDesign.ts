/**
 * The Cover Designer's main-process side (docs/COVER-DESIGNER-PLAN.md): what the designer is offered for the project in view, opening a design,
 * reading and importing pictures, the starter fonts, and saving. A save is two vault files, the editable design and the flattened picture, and
 * the picture is the asset the Art page governs. Electron-free; tested in test/coverDesign.test.ts.
 *
 * Who may do what is the vault's and the service's to say: this file adds only the checks that make a design what it says it is (the picture's
 * size is the canvas's size, the design is a design) and names for the files.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { encodePng, imageInfo, psdComposite, subtreeIds } from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import type { CoverContext, CoverFontData, CoverImageData, CoverImportInput, CoverOpened, CoverSaved, CoverSaveInput } from '../shared/api';
import { DESIGN_SUFFIX, DesignError, parse, serialize, type Design } from '../shared/cover/doc';
import { STARTER_FONTS, starterOf } from '../shared/cover/fonts';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';
import type { VaultHost } from './vaultHost';

export class CoverError extends Error {}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const MAX_PICTURE = 60 * 1024 * 1024;
const PICTURE = /\.(png|jpe?g|webp|gif|svg|psd)$/i;
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/** A name that is safe as a file or folder name on any system. */
export function safeName(raw: string, fallback = 'Cover'): string {
  const n = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60);
  return n && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n) ? n : fallback;
}
const imageOf = (designPath: string): string => designPath.slice(0, -DESIGN_SUFFIX.length) + '.png';

export class CoverDesign {
  constructor(
    private readonly studio: StudioService,
    private readonly people: PeopleHost,
    private readonly vault: VaultHost | null,
    /** The vault's working folder: files are written here and then put in the vault. */
    private readonly dir: string,
    /** The app's assets folder, where the starter fonts are. */
    private readonly assetsDir: string
  ) {}

  private as() {
    const svc = this.people.service;
    if (!svc) throw new CoverError('Art for this Studio is managed by its owner.');
    return svc.as(this.people.me);
  }
  private files(): VaultHost {
    return this.vault ?? (() => { throw new CoverError('The files of this Studio are kept by its owner.'); })();
  }
  private async mustWrite(projectId: string): Promise<void> {
    if (!(await this.people.mayOn('asset.write', projectId).catch(() => false))) throw new CoverError('Your role does not let you make art in this project.');
  }
  private async projectName(projectId: string): Promise<string> {
    return (await this.studio.tree()).projects.find((p) => p.id === projectId)?.name ?? 'Project';
  }

  // ---- what the designer is offered -------------------------------------------------------------------------------------------

  async context(projectRef?: string): Promise<CoverContext> {
    if (!this.people.service) return { available: false, reason: 'Art for this Studio is managed by its owner.' };
    const tree = await this.studio.tree();
    const project = projectRef ? tree.projects.find((p) => p.id === projectRef && p.status !== 'archived') : tree.projects.filter((p) => !p.parentId && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name))[0];
    if (!project) return { available: false, reason: projectRef ? 'That project is not there.' : 'Pick a project to design a cover for.' };
    const write = await this.people.mayOn('asset.write', project.id).catch(() => false);
    if (!(await this.people.mayOn('asset.read', project.id).catch(() => false))) return { available: false, reason: 'Your role does not let you see the art of this project.' };
    const inside = new Set(subtreeIds(tree, project.id));
    const all = this.vault ? await this.vault.files().catch(() => []) : [];
    const mine = all.filter((f) => !!f.projectId && inside.has(f.projectId));
    const designs = mine
      .filter((f) => f.path.endsWith(DESIGN_SUFFIX))
      .map((f) => ({ fileId: f.fileId, path: f.path, imagePath: imageOf(f.path), version: f.version, name: path.posix.basename(f.path).slice(0, -DESIGN_SUFFIX.length) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const pictures = mine.filter((f) => PICTURE.test(f.path) && !f.path.endsWith('.cadrel-cover.png')).map((f) => ({ fileId: f.fileId, path: f.path, version: f.version })).sort((a, b) => a.path.localeCompare(b.path));
    // a book's title is its project's name, its series the project above it
    const parent = project.parentId ? tree.projects.find((p) => p.id === project.parentId) : null;
    return { available: true, project: { id: project.id, name: project.name }, may: { write }, pictures, designs, fields: { title: parent ? project.name : '', series: parent ? parent.name : project.name, author: '' } };
  }

  // ---- reading -----------------------------------------------------------------------------------------------------------------

  private async entry(rel: string) {
    const e = (await this.files().files()).find((f) => f.path.toLowerCase() === rel.toLowerCase());
    if (!e) throw new CoverError(`${rel} is not in the vault, or your role cannot see it.`);
    return e;
  }

  async open(rel: string): Promise<CoverOpened> {
    const e = await this.entry(String(rel));
    if (!e.path.endsWith(DESIGN_SUFFIX)) throw new CoverError('That is not a Cover Designer file.');
    if (e.projectId && !(await this.people.mayOn('asset.read', e.projectId).catch(() => false))) throw new CoverError('Your role does not let you see the art of this project.');
    const bytes = await this.files().bytesOf(e.fileId, e.version);
    const text = new TextDecoder().decode(bytes);
    let design: Design;
    try {
      design = parse(text);
    } catch (err) {
      throw new CoverError(err instanceof DesignError ? err.message : 'This design could not be read.');
    }
    const all = await this.files().files();
    const refs = [...new Set([...design.layers.flatMap((l) => (l.type === 'image' ? [l.src] : [])), ...(design.template ? [design.template.src] : [])].map((r) => `${r.path}\u0000${r.hash}`))].map((k) => k.split('\u0000') as [string, string]);
    const pictures: CoverOpened['pictures'] = [];
    for (const [p, hash] of refs) {
      const f = all.find((x) => x.path === p);
      if (!f) {
        pictures.push({ path: p, state: 'missing' });
        continue;
      }
      const cur = (await this.files().versionsOf(f.fileId).catch(() => []))[0];
      pictures.push({ path: p, state: hash && cur && cur.hash !== hash ? 'changed' : 'ok' });
    }
    const asset = design.render ? await this.as().assets.ofFile((all.find((f) => f.path === design.render!.path) ?? { fileId: '' }).fileId).catch(() => null) : null;
    return { text, path: e.path, fileId: e.fileId, version: e.version, assetId: asset?.id ?? null, pictures };
  }

  /** One vault picture, ready to draw: a Photoshop file as its saved composite, everything else as it is. */
  async image(rel: string): Promise<CoverImageData> {
    const e = await this.entry(String(rel));
    if (e.projectId && !(await this.people.mayOn('asset.read', e.projectId).catch(() => false))) throw new CoverError('Your role does not let you see the art of this project.');
    if ((e.size ?? 0) > MAX_PICTURE) throw new CoverError('That picture is too large to use here.');
    const bytes = await this.files().bytesOf(e.fileId, e.version);
    const hash = (await this.files().versionsOf(e.fileId).catch(() => []))[0]?.hash ?? sha(bytes);
    const info = imageInfo(bytes);
    if (!info) throw new CoverError('This kind of file cannot be drawn on a cover.');
    if (info.format === 'psd') {
      const px = psdComposite(bytes, 3000);
      if (!px) throw new CoverError('This Photoshop file carries no flattened picture (it was saved without Maximize Compatibility). Export a PNG from it and use that.');
      const png = encodePng(px);
      return { path: e.path, mime: 'image/png', bytes: png, width: info.width, height: info.height, version: e.version, hash };
    }
    const mime = MIME[info.format];
    if (!mime) throw new CoverError(`A ${info.format.toUpperCase()} cannot be drawn on a cover. Save it as PNG or JPEG first.`);
    return { path: e.path, mime, bytes, width: info.width, height: info.height, version: e.version, hash };
  }

  // ---- writing -----------------------------------------------------------------------------------------------------------------

  /** Puts bytes in the working folder as the path, and in the vault: a first version, or a new one over an existing file. */
  private async put(rel: string, bytes: Uint8Array, comment: string, projectId: string): Promise<{ fileId: string; version: number }> {
    const v = this.files();
    const abs = path.join(this.dir, ...rel.split('/'));
    const there = (await v.files()).find((f) => f.path === rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (!there) {
      await fsp.chmod(abs, 0o666).catch(() => undefined);
      await fsp.writeFile(abs, bytes);
      await v.call('add', [rel, comment, projectId]);
    } else {
      await v.call('checkOut', [rel]);
      await fsp.writeFile(abs, bytes);
      await v.call('checkIn', [rel, comment]);
    }
    const now = (await v.files()).find((f) => f.path === rel);
    if (!now) throw new CoverError('The file was not saved to the vault.');
    return { fileId: now.fileId, version: now.version };
  }

  async importPicture(i: CoverImportInput): Promise<{ path: string; width: number; height: number; hash: string }> {
    await this.mustWrite(i.projectId);
    const bytes = i.bytes instanceof Uint8Array ? i.bytes : new Uint8Array(i.bytes as ArrayBufferLike);
    if (bytes.length > MAX_PICTURE) throw new CoverError('That picture is too large to use here.');
    const info = imageInfo(bytes);
    if (!info || !(info.format in MIME || info.format === 'psd')) throw new CoverError('Cadrel cannot read that as a picture. Use PNG, JPEG, WebP, GIF or SVG.');
    const ext = info.format === 'jpeg' ? 'jpg' : info.format;
    const base = safeName(i.name.replace(/\.[A-Za-z0-9]+$/, ''), 'Picture');
    const folder = `Art/${safeName(await this.projectName(i.projectId), 'Project')}/${i.role === 'template' ? 'Templates' : 'Pictures'}`;
    const taken = new Set((await this.files().files()).map((f) => f.path.toLowerCase()));
    let n = 1;
    let rel = `${folder}/${base}.${ext}`;
    while (taken.has(rel.toLowerCase())) rel = `${folder}/${base} (${++n}).${ext}`;
    await this.put(rel, bytes, i.role === 'template' ? 'KDP template' : 'Picture for a cover', i.projectId);
    return { path: rel, width: info.width, height: info.height, hash: sha(bytes) };
  }

  async save(i: CoverSaveInput): Promise<CoverSaved> {
    await this.mustWrite(i.projectId);
    let design: Design;
    try {
      design = parse(String(i.design));
    } catch (e) {
      throw new CoverError(e instanceof DesignError ? e.message : 'That is not a design.');
    }
    const image = i.image instanceof Uint8Array ? i.image : new Uint8Array(i.image as ArrayBufferLike);
    const info = imageInfo(image);
    // the picture is the render of this design: it has to be a PNG at the design's own size, and nothing else
    if (!info || info.format !== 'png') throw new CoverError('The picture of the cover must be a PNG.');
    if (info.width !== design.canvas.w || info.height !== design.canvas.h) throw new CoverError(`The picture is ${info.width} × ${info.height}; this design is ${design.canvas.w} × ${design.canvas.h}.`);
    const front = i.front ? (i.front instanceof Uint8Array ? i.front : new Uint8Array(i.front as ArrayBufferLike)) : null;
    if (front && imageInfo(front)?.format !== 'png') throw new CoverError('The front cover must be a PNG.');
    if (design.kind === 'ebook' && front) throw new CoverError('An ebook cover has no separate front picture.');
    const folder = `Art/${safeName(await this.projectName(i.projectId), 'Project')}`;
    let designPath = i.designPath ? String(i.designPath) : '';
    if (designPath) {
      if (!designPath.endsWith(DESIGN_SUFFIX)) throw new CoverError('That is not a Cover Designer file.');
      const e = await this.entry(designPath);
      if (e.projectId && e.projectId !== i.projectId) throw new CoverError('That design belongs to another project.');
    } else {
      const base = safeName(i.name);
      const taken = new Set((await this.files().files()).map((f) => f.path.toLowerCase()));
      let n = 1;
      designPath = `${folder}/${base}${DESIGN_SUFFIX}`;
      while (taken.has(designPath.toLowerCase())) designPath = `${folder}/${base} (${++n})${DESIGN_SUFFIX}`;
    }
    const imagePath = imageOf(designPath);
    const frontPath = front ? imagePath.replace(/\.png$/, '-front.png') : null;
    const comment = (i.comment ?? '').trim() || 'Saved from the Cover Designer';
    // the picture first, so the design can say which picture it is
    const pic = await this.put(imagePath, image, comment, i.projectId);
    if (front && frontPath) await this.put(frontPath, front, comment, i.projectId);
    design.render = { path: imagePath, hash: sha(image) };
    const doc = await this.put(designPath, new TextEncoder().encode(serialize(design)), comment, i.projectId);
    // where each file is used: the design uses its pictures and template, and it made the cover
    const v = this.files();
    const uses = new Set([...design.layers.flatMap((l) => (l.type === 'image' ? [l.src.path] : [])), ...(design.template ? [design.template.src.path] : [])]);
    for (const p of uses) await v.call('addReference', [designPath, p, null, 'used in the design']).catch(() => undefined);
    await v.call('addReference', [imagePath, designPath, null, 'made from this design']).catch(() => undefined);
    // the first save makes the cover an asset (in review by people, not by this tool)
    const as = this.as();
    let asset = await as.assets.ofFile(pic.fileId);
    if (!asset) {
      try {
        asset = await as.assets.create({ projectId: i.projectId, fileId: pic.fileId, kind: 'cover', name: path.posix.basename(designPath).slice(0, -DESIGN_SUFFIX.length) });
      } catch (e) {
        if (e instanceof PermissionDenied) throw new CoverError('The cover was saved, but your role may not add it to the Art page as an asset.');
        throw e;
      }
    }
    return { assetId: asset.id, designPath, imagePath, frontPath, version: doc.version };
  }

  // ---- fonts -------------------------------------------------------------------------------------------------------------------

  async fonts(families: string[]): Promise<CoverFontData[]> {
    const out: CoverFontData[] = [];
    for (const family of [...new Set(families.map(String))]) {
      const f = starterOf(family);
      if (!f) continue;
      for (const w of [400, 700] as const) {
        const rel = f.files[w];
        if (!rel) continue;
        const bytes = await fsp.readFile(path.join(this.assetsDir, ...rel.split('/'))).catch(() => null);
        if (!bytes) continue;
        out.push({ family, weight: w, dataUrl: `data:${rel.endsWith('.woff2') ? 'font/woff2' : 'font/ttf'};base64,${bytes.toString('base64')}` });
      }
    }
    return out;
  }
}

export { STARTER_FONTS };
