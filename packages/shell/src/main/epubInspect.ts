/**
 * Reads an EPUB and reports what Preflight's rules need to know about it (`EpubFacts` in the kernel): the zip's own rules, the package, the
 * navigation, each content document's links and ids, the cover image and the title page. It judges nothing: the rules do that, over these facts,
 * and are the same wherever they run. A file that is not a readable zip yields facts that say so.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { imageInfo, type DocumentFacts, type EpubFacts, type NavEntry } from '@cadrel/kernel';

type El = Element;
const XHTML = 'application/xhtml+xml';

function parse(text: string): { doc: Document | null; error?: string } {
  const problems: string[] = [];
  try {
    const doc = new DOMParser({
      onError: (level: string, msg: string) => {
        if (level !== 'warning') problems.push(msg.split('\n')[0]!);
      }
    }).parseFromString(text, 'text/xml') as unknown as Document;
    if (problems.length || !doc?.documentElement) return { doc: null, error: problems[0] ?? 'no root element' };
    return { doc };
  } catch (e) {
    return { doc: null, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}
function walk(n: Node, f: (e: El) => void): void {
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      f(c as El);
      walk(c, f);
    }
  }
}
const local = (e: El) => (e.localName ?? e.tagName).replace(/^.*:/, '').toLowerCase();
const attr = (e: El, name: string) => e.getAttribute(name) ?? e.getAttribute(name.replace(/^.*:/, '')) ?? '';
const textOf = (e: El) => (e.textContent ?? '').replace(/\s+/g, ' ').trim();
const resolve = (from: string, href: string) => path.posix.normalize(path.posix.join(path.posix.dirname(from), safeDecode(href)));
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The first local file header of a zip: is it "mimetype", and is it stored (no compression)? */
function mimetypeHeader(b: Uint8Array): { first: string | null; stored: boolean } {
  if (b.length < 30) return { first: null, stored: false };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) return { first: null, stored: false };
  const nameLen = dv.getUint16(26, true);
  return { first: new TextDecoder().decode(b.subarray(30, 30 + nameLen)), stored: dv.getUint16(8, true) === 0 };
}

export function inspectEpub(bytes: Uint8Array): EpubFacts {
  const empty = (error: string): EpubFacts => ({ zip: { readable: false, error, entries: [], mimetypeFirst: false, mimetypeStored: false, mimetypeText: null }, rootfile: null, opf: null, nav: null, ncx: false, documents: [], cover: null, titlePage: null, bytes: bytes.length });
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }
  const entries = Object.keys(files);
  const head = mimetypeHeader(bytes);
  const read = (n: string) => (files[n] ? strFromU8(files[n]) : null);
  const out: EpubFacts = {
    zip: { readable: true, entries, mimetypeFirst: head.first === 'mimetype', mimetypeStored: head.stored, mimetypeText: read('mimetype')?.trim() ?? null },
    rootfile: null,
    opf: null,
    nav: null,
    ncx: false,
    documents: [],
    cover: null,
    titlePage: null,
    bytes: bytes.length
  };

  const container = read('META-INF/container.xml');
  if (container) {
    const c = parse(container).doc;
    if (c) walk(c, (e) => local(e) === 'rootfile' && !out.rootfile && (out.rootfile = attr(e, 'full-path') || null));
  }
  if (!out.rootfile) return out;
  const opfText = read(out.rootfile);
  if (opfText === null) return out;
  const p = parse(opfText);
  if (!p.doc) {
    out.opf = { path: out.rootfile, wellFormed: false, error: p.error, version: null, title: null, creators: [], language: null, identifiers: [], publisher: null, modified: null, series: null, seriesIndex: null, manifest: [], spine: [], duplicateIds: [] };
    return out;
  }
  const opfPath = out.rootfile;
  const manifest: { id: string; href: string; mediaType: string; properties: string[]; present: boolean; path: string }[] = [];
  const spineRefs: string[] = [];
  const titles: { id: string; text: string }[] = [];
  const mainTitleIds = new Set<string>();
  const creators: string[] = [];
  const identifiers: string[] = [];
  let language: string | null = null;
  let publisher: string | null = null;
  let modified: string | null = null;
  let series: string | null = null;
  let seriesIndex: string | null = null;
  let coverMeta: string | null = null;
  walk(p.doc, (e) => {
    const n = local(e);
    if (n === 'item' && e.parentNode && local(e.parentNode as El) === 'manifest') {
      const href = attr(e, 'href');
      const full = resolve(opfPath, href);
      manifest.push({ id: attr(e, 'id'), href, mediaType: attr(e, 'media-type'), properties: attr(e, 'properties').split(/\s+/).filter(Boolean), present: !!files[full], path: full });
    } else if (n === 'itemref') spineRefs.push(attr(e, 'idref'));
    else if (n === 'title') titles.push({ id: attr(e, 'id'), text: textOf(e) });
    else if (n === 'creator') creators.push(textOf(e));
    else if (n === 'identifier') identifiers.push(textOf(e));
    else if (n === 'language') language ||= textOf(e);
    else if (n === 'publisher') publisher ||= textOf(e);
    else if (n === 'meta') {
      const prop = attr(e, 'property');
      const name = attr(e, 'name');
      if (prop === 'dcterms:modified') modified = textOf(e);
      else if (prop === 'belongs-to-collection') series ||= textOf(e);
      else if (prop === 'group-position') seriesIndex ||= textOf(e);
      else if (prop === 'title-type' && textOf(e) === 'main') mainTitleIds.add(attr(e, 'refines').replace(/^#/, ''));
      else if (name === 'calibre:series') series ||= attr(e, 'content');
      else if (name === 'calibre:series_index') seriesIndex ||= attr(e, 'content');
      else if (name === 'cover') coverMeta = attr(e, 'content');
    }
  });
  const root = p.doc.documentElement as El;
  const byId = new Map<string, number>();
  for (const m of manifest) byId.set(m.id, (byId.get(m.id) ?? 0) + 1);
  const title = titles.find((t) => mainTitleIds.has(t.id))?.text ?? titles[0]?.text ?? null;
  out.opf = {
    path: opfPath,
    wellFormed: true,
    version: attr(root, 'version') || null,
    title: title || null,
    creators: creators.filter(Boolean),
    language,
    identifiers: identifiers.filter(Boolean),
    publisher,
    modified,
    series,
    seriesIndex,
    manifest: manifest.map(({ path: _p, ...m }) => m),
    spine: spineRefs.map((idref) => ({ idref, known: byId.has(idref) })),
    duplicateIds: [...byId].filter(([, n]) => n > 1).map(([id]) => id)
  };

  out.ncx = manifest.some((m) => m.mediaType === 'application/x-dtbncx+xml' && m.present);

  // content documents, in reading order
  const docs = new Map<string, { facts: DocumentFacts; dom: Document | null }>();
  const order: string[] = [];
  for (const ref of spineRefs) {
    const item = manifest.find((m) => m.id === ref);
    if (!item || !item.present || (item.mediaType !== XHTML && !/\.x?html?$/i.test(item.path)) || docs.has(item.path)) continue;
    const r = parse(read(item.path) ?? '');
    docs.set(item.path, { facts: { path: item.path, wellFormed: !!r.doc, ...(r.error ? { error: r.error } : {}), brokenLinks: [], missingImages: [], duplicateIds: [], heading: null, types: [] }, dom: r.doc });
    order.push(item.path);
  }
  const idsOf = new Map<string, Set<string>>();
  for (const [file, { facts, dom }] of docs) {
    const ids = new Set<string>();
    if (dom) {
      walk(dom, (e) => {
        const id = attr(e, 'id');
        if (id) {
          if (ids.has(id) && !facts.duplicateIds.includes(id)) facts.duplicateIds.push(id);
          ids.add(id);
        }
      });
    }
    idsOf.set(file, ids);
  }
  for (const [file, { facts, dom }] of docs) {
    if (!dom) continue;
    walk(dom, (e) => {
      const n = local(e);
      if (!facts.heading && /^h[1-3]$/.test(n)) facts.heading = textOf(e) || null;
      for (const t of attr(e, 'epub:type').split(/\s+/).filter(Boolean)) if (!facts.types.includes(t)) facts.types.push(t);
      if (n === 'a') {
        const href = attr(e, 'href');
        if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
        const [target, frag] = href.split('#') as [string, string | undefined];
        const full = target ? resolve(file, target) : file;
        if (!files[full]) facts.brokenLinks.push(href);
        else if (frag && idsOf.has(full) && !idsOf.get(full)!.has(safeDecode(frag))) facts.brokenLinks.push(href);
      } else if (n === 'img' || n === 'image') {
        const src = attr(e, 'src') || attr(e, 'xlink:href') || attr(e, 'href');
        if (!src || /^(data|https?):/i.test(src)) return;
        if (!files[resolve(file, src)]) facts.missingImages.push(src);
      }
    });
  }
  out.documents = order.map((f) => docs.get(f)!.facts);

  // navigation
  const navItem = manifest.find((m) => m.properties.includes('nav') && m.present);
  if (navItem) {
    const r = parse(read(navItem.path) ?? '');
    const nav = { path: navItem.path, hasToc: false, entries: [] as NavEntry[], landmarks: [] as string[] };
    if (r.doc) {
      walk(r.doc, (e) => {
        if (local(e) !== 'nav') return;
        const kind = attr(e, 'epub:type');
        if (/\btoc\b/.test(kind)) {
          nav.hasToc = true;
          walk(e, (a) => {
            if (local(a) !== 'a') return;
            const href = attr(a, 'href');
            const [target] = href.split('#') as [string];
            const full = target ? resolve(navItem.path, target) : null;
            nav.entries.push({ label: textOf(a), href, target: full, resolved: !!full && !!files[full] });
          });
        } else if (/\blandmarks\b/.test(kind)) walk(e, (a) => local(a) === 'a' && nav.landmarks.push(attr(a, 'epub:type')));
      });
    }
    out.nav = nav;
  }

  // the cover image
  const coverItem = manifest.find((m) => m.properties.includes('cover-image')) ?? manifest.find((m) => !!coverMeta && m.id === coverMeta);
  if (coverItem?.present) {
    const b = files[coverItem.path]!;
    const info = imageInfo(b);
    out.cover = { path: coverItem.path, format: info?.format ?? null, width: info?.width ?? null, height: info?.height ?? null, bytes: b.length, hash: createHash('sha256').update(b).digest('hex'), colour: info?.colour ?? null, dpi: info?.dpi ?? null };
  }

  // the title page: the document typed as one, or the one called title
  const tp = order.find((f) => docs.get(f)!.facts.types.includes('titlepage')) ?? order.find((f) => /(^|\/)title\.x?html?$/i.test(f));
  const tdom = tp ? docs.get(tp)!.dom : null;
  if (tdom) {
    let t: string | null = null;
    let a: string | null = null;
    walk(tdom, (e) => {
      const cls = attr(e, 'class');
      if (!t && /\bbooktitle\b/.test(cls)) t = textOf(e);
      if (!a && /\bbookauthor\b/.test(cls)) a = textOf(e);
    });
    out.titlePage = { title: t, author: a };
  }
  return out;
}
