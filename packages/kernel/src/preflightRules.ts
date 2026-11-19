/**
 * Preflight's rules (docs/M5-PLAN.md): pure functions over facts that the computer holding the files extracts, so they run the same in the app,
 * in tests and anywhere else. A rule says what it measured and what it expected, never just "wrong". Retailer limits are not buried in the rules:
 * they are a **rule pack**, data with a version, the date each limit was last read from the retailer and where, so the page can say how old they
 * are. Where a retailer's own pages disagree, the pack grades the strict reading as an error only when every page agrees, and the other as a warning.
 */
import type { Finding } from './preflight';
import type { ColourModel, ImageFormat } from './imageInfo';

// ---- facts -----------------------------------------------------------------------------------------------------------------------

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
  /** The file is in the zip. */
  present: boolean;
}
export interface NavEntry {
  label: string;
  href: string;
  /** The file the link points into (the part before #), and whether that file is in the zip. */
  target: string | null;
  resolved: boolean;
}
export interface DocumentFacts {
  path: string;
  wellFormed: boolean;
  error?: string;
  /** Internal links that point at a file or an id that is not there. */
  brokenLinks: string[];
  missingImages: string[];
  duplicateIds: string[];
  /** The first heading, or null. */
  heading: string | null;
  /** `epub:type` values on the body and its sections (titlepage, copyright-page, bodymatter, chapter…). */
  types: string[];
}
export interface EpubFacts {
  zip: { readable: boolean; error?: string; entries: string[]; mimetypeFirst: boolean; mimetypeStored: boolean; mimetypeText: string | null };
  rootfile: string | null;
  opf: null | {
    path: string;
    wellFormed: boolean;
    error?: string;
    version: string | null;
    title: string | null;
    creators: string[];
    language: string | null;
    identifiers: string[];
    publisher: string | null;
    modified: string | null;
    series: string | null;
    seriesIndex: string | null;
    manifest: ManifestItem[];
    spine: { idref: string; known: boolean }[];
    duplicateIds: string[];
  };
  nav: null | { path: string; hasToc: boolean; entries: NavEntry[]; landmarks: string[] };
  ncx: boolean;
  /** Content documents in reading order. */
  documents: DocumentFacts[];
  /** The cover image inside the EPUB. */
  cover: null | { path: string; format: ImageFormat | null; width: number | null; height: number | null; bytes: number; hash: string; colour: ColourModel | null; dpi: number | null };
  /** What the title page of the EPUB says. */
  titlePage: { title: string | null; author: string | null } | null;
  /** The size of the whole EPUB file. */
  bytes: number;
}

/** What the Studio's records say about the edition being checked. */
export interface BookFacts {
  title: string;
  subtitle: string;
  author: string;
  series: string | null;
  seriesNumber: number | null;
  isbn: string | null;
  asin: string | null;
  language: string | null;
  price: number | null;
  publishedOn: string | null;
  /** The blurb and keywords as the Studio's marketing files hold them, or null when there is no such file. */
  blurb: string | null;
  keywords: string[] | null;
}
/** The approved cover for the edition, as the records hold it, and the image file itself. */
export interface ApprovedCoverFacts {
  assetId: string;
  version: number;
  hash: string;
  format: ImageFormat | null;
  width: number | null;
  height: number | null;
  colour: ColourModel | null;
  dpi: number | null;
  bytes: number;
}
export interface PreflightFacts {
  epub: EpubFacts;
  book: BookFacts;
  /** The approved cover, or null when the book has none. */
  approvedCover: ApprovedCoverFacts | null;
}

// ---- rule packs ------------------------------------------------------------------------------------------------------------------

export interface PackSource {
  /** What the limit is for ("cover.min"). */
  rule: string;
  url: string;
  /** The date the limit was read from that page. */
  read: string;
  note?: string;
}
export interface RulePack {
  id: string;
  title: string;
  version: string;
  /** The newest date any limit was read from the retailer's pages. */
  verified: string;
  sources: PackSource[];
  cover: {
    /** Below this on the longest side the retailer rejects the image. */
    rejectLongestBelow: number;
    /** At or above this on any side the retailer rejects it. */
    rejectAbove: number;
    maxBytes: number;
    formats: ImageFormat[];
    /** Accepted but known to give a poor result below these (shortest side, longest side). */
    warnShortestBelow: number;
    warnLongestBelow: number;
    /** The size and height-to-width ratio the retailer recommends. */
    recommended: { width: number; height: number };
    ratioTolerance: number;
    recommendedDpi: number;
  };
  metadata: { descriptionMax: number; keywordsMax: number; keywordMaxChars: number; titleWithSubtitleMax: number };
  epub: { maxBytes: number | null };
  /** What this pack does not check, said on every run. */
  notChecked: string[];
}

/**
 * Amazon KDP, for Kindle eBooks, read from KDP's help pages on 19 November 2026. The two KDP pages on cover images disagree on the minimum (500 pixels
 * on the longest side on one; 625 by 1,000 on the other), so the lower figure is the error and the higher a warning. Keywords are limited to seven
 * by KDP's page; the 50 characters each is the Studio's own keywords rule and has not been read from a KDP page.
 */
export const KDP_PACK: RulePack = {
  id: 'kdp-ebook',
  title: 'Amazon KDP, Kindle eBook',
  version: '1',
  verified: '2026-11-19',
  sources: [
    { rule: 'cover.sizes, cover.formats, cover.bytes, cover.recommended', url: 'https://kdp.amazon.com/en_US/help/topic/G6GTK3T3NUHKLEFX', read: '2026-11-19', note: '500 pixels on the longest side at least; 10,000 at most; 50 MB; JPEG, PNG, GIF or TIFF; 2,560 by 1,600 recommended.' },
    { rule: 'cover.warn', url: 'https://kdp.amazon.com/en_US/help/topic/G200645690', read: '2026-11-19', note: 'An older page: at least 1,000 pixels tall by 625 wide.' },
    { rule: 'metadata.description, metadata.keywords, metadata.title', url: 'https://kdp.amazon.com/en_US/help/topic/G201189630', read: '2026-11-19', note: 'Description at most 4,000 characters; up to seven keywords; title and subtitle together at most 200 characters.' },
    { rule: 'metadata.keywordMaxChars', url: 'docs/M5-PLAN.md', read: '', note: 'The Studio’s own keywords rule (50 characters each); not re-read from a KDP page.' }
  ],
  cover: { rejectLongestBelow: 500, rejectAbove: 10_000, maxBytes: 50 * 1024 * 1024, formats: ['jpeg', 'png', 'gif', 'tiff'], warnShortestBelow: 625, warnLongestBelow: 1000, recommended: { width: 1600, height: 2560 }, ratioTolerance: 0.1, recommendedDpi: 300 },
  metadata: { descriptionMax: 4000, keywordsMax: 7, keywordMaxChars: 50, titleWithSubtitleMax: 200 },
  epub: { maxBytes: null },
  notChecked: [
    'Print interiors and print covers (spine, bleed)',
    'Whether the text reads correctly on a Kindle (only the file’s structure is checked)',
    'Accessibility metadata and alt text',
    'Retailers other than Amazon KDP',
    'Anything epubcheck reports, unless epubcheck is installed on this computer'
  ]
};
export const PACKS: Record<string, RulePack> = { [KDP_PACK.id]: KDP_PACK };

/** Whole months between the date a pack was verified and now, for "rules last verified N months ago". */
export function packAgeMonths(p: Pick<RulePack, 'verified'>, now: string): number | null {
  if (!p.verified) return null;
  const a = new Date(p.verified);
  const b = new Date(now);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0));
}

// ---- rules -----------------------------------------------------------------------------------------------------------------------

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const short = (h: string) => h.slice(0, 12);
const list = (xs: string[], n = 5) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));

export function runPreflight(f: PreflightFacts, pack: RulePack = KDP_PACK): Finding[] {
  return [...zipRules(f), ...packageRules(f), ...navRules(f), ...documentRules(f), ...matterRules(f), ...consistencyRules(f), ...coverRules(f, pack), ...metadataRules(f, pack)];
}

function zipRules({ epub }: PreflightFacts): Finding[] {
  const z = epub.zip;
  if (!z.readable) return [{ ruleId: 'epub.zip', grade: 'error', what: 'The file cannot be opened as an EPUB (it is not a readable zip).', location: '', measured: z.error ?? 'unreadable', expected: 'a zip archive' }];
  const out: Finding[] = [];
  if (!z.mimetypeFirst) out.push({ ruleId: 'epub.mimetype', grade: 'error', what: 'The first entry in the zip must be "mimetype".', location: 'mimetype', measured: z.entries[0] ?? 'nothing', expected: 'mimetype first' });
  if (z.mimetypeText !== 'application/epub+zip') out.push({ ruleId: 'epub.mimetype', grade: 'error', what: 'The "mimetype" file must say application/epub+zip.', location: 'mimetype', measured: z.mimetypeText ?? 'missing', expected: 'application/epub+zip' });
  if (z.mimetypeFirst && !z.mimetypeStored) out.push({ ruleId: 'epub.mimetype', grade: 'error', what: 'The "mimetype" entry must be stored, not compressed.', location: 'mimetype', measured: 'compressed', expected: 'stored' });
  return out;
}

function packageRules({ epub }: PreflightFacts): Finding[] {
  if (!epub.zip.readable) return [];
  const out: Finding[] = [];
  if (!epub.rootfile) return [{ ruleId: 'epub.container', grade: 'error', what: 'META-INF/container.xml does not point to a package file.', location: 'META-INF/container.xml', measured: 'no rootfile', expected: 'a rootfile with a full-path' }];
  const o = epub.opf;
  if (!o) return [{ ruleId: 'epub.package', grade: 'error', what: 'The package file named by container.xml is missing.', location: epub.rootfile, measured: 'absent', expected: 'present' }];
  if (!o.wellFormed) return [{ ruleId: 'epub.package', grade: 'error', what: 'The package file is not well-formed XML.', location: o.path, measured: o.error ?? 'parse error', expected: 'well-formed XML' }];
  const missing = o.manifest.filter((m) => !m.present).map((m) => m.href);
  for (const href of missing) out.push({ ruleId: 'epub.manifest', grade: 'error', what: 'A manifest item is not in the zip.', location: o.path, measured: `${href} is absent`, expected: 'every manifest item present' });
  for (const s of o.spine.filter((x) => !x.known)) out.push({ ruleId: 'epub.spine', grade: 'error', what: 'A spine entry is not in the manifest.', location: o.path, measured: s.idref, expected: 'every spine entry in the manifest' });
  for (const id of o.duplicateIds) out.push({ ruleId: 'epub.ids', grade: 'error', what: 'Two manifest items share an id.', location: o.path, measured: id, expected: 'unique ids' });
  if (!o.title) out.push({ ruleId: 'epub.metadata', grade: 'error', what: 'The package has no title (dc:title).', location: o.path, measured: 'none', expected: 'a title' });
  if (!o.language) out.push({ ruleId: 'epub.metadata', grade: 'error', what: 'The package has no language (dc:language).', location: o.path, measured: 'none', expected: 'a language code' });
  if (!o.identifiers.length) out.push({ ruleId: 'epub.metadata', grade: 'error', what: 'The package has no identifier (dc:identifier).', location: o.path, measured: 'none', expected: 'an identifier' });
  if (!o.modified) out.push({ ruleId: 'epub.metadata', grade: 'error', what: 'The package has no dcterms:modified date.', location: o.path, measured: 'none', expected: 'a modified date' });
  if (!o.creators.length) out.push({ ruleId: 'epub.metadata', grade: 'warning', what: 'The package names no author (dc:creator).', location: o.path, measured: 'none', expected: 'the author' });
  if (o.version && !o.version.startsWith('3')) out.push({ ruleId: 'epub.version', grade: 'suggestion', what: 'The EPUB is not version 3.', location: o.path, measured: o.version, expected: '3.x' });
  return out;
}

function navRules({ epub }: PreflightFacts): Finding[] {
  if (!epub.zip.readable || !epub.opf?.wellFormed) return [];
  const out: Finding[] = [];
  const nav = epub.nav;
  if (!nav) {
    out.push({ ruleId: 'nav.missing', grade: 'error', what: 'There is no navigation document in the manifest.', location: epub.opf.path, measured: 'none', expected: 'an item with the nav property' });
  } else {
    if (!nav.hasToc) out.push({ ruleId: 'nav.toc', grade: 'error', what: 'The navigation document has no table of contents.', location: nav.path, measured: 'no <nav epub:type="toc">', expected: 'a toc' });
    for (const e of nav.entries.filter((x) => !x.resolved)) out.push({ ruleId: 'nav.link', grade: 'error', what: `The contents entry “${e.label}” points to something that is not there.`, location: nav.path, measured: e.href, expected: 'a file in the EPUB' });
    if (nav.hasToc && nav.entries.length === 0) out.push({ ruleId: 'nav.empty', grade: 'error', what: 'The table of contents has no entries.', location: nav.path, measured: '0 entries', expected: 'at least one' });
    // reading order: the contents lists files in the order they are read
    const order = new Map(epub.documents.map((d, i) => [d.path, i]));
    let last = -1;
    for (const e of nav.entries) {
      const at = e.target ? order.get(e.target) : undefined;
      if (at === undefined) continue;
      if (at < last) {
        out.push({ ruleId: 'nav.order', grade: 'warning', what: `The contents entry “${e.label}” comes before something that is read earlier.`, location: nav.path, measured: `${e.target} is earlier in the reading order`, expected: 'contents in reading order' });
        break;
      }
      last = at;
    }
    const chapters = epub.documents.filter((d) => d.types.some((t) => t === 'chapter' || t === 'bodymatter' || /^chapter/.test(t)) || (!!d.heading && !d.types.length)).length;
    if (chapters > 0 && nav.entries.length > 0 && nav.entries.length < Math.ceil(chapters / 2)) out.push({ ruleId: 'nav.coverage', grade: 'warning', what: 'The table of contents lists far fewer entries than the book has chapters.', location: nav.path, measured: `${nav.entries.length} entries for about ${chapters} chapters`, expected: 'an entry for each chapter' });
  }
  if (!epub.ncx) out.push({ ruleId: 'nav.ncx', grade: 'suggestion', what: 'There is no toc.ncx, which older Kindle firmware reads.', location: epub.opf.path, measured: 'none', expected: 'a toc.ncx alongside the nav document' });
  return out;
}

function documentRules({ epub }: PreflightFacts): Finding[] {
  const out: Finding[] = [];
  for (const d of epub.documents) {
    if (!d.wellFormed) out.push({ ruleId: 'doc.xml', grade: 'error', what: 'A content document is not well-formed XHTML.', location: d.path, measured: d.error ?? 'parse error', expected: 'well-formed XHTML' });
    if (d.brokenLinks.length) out.push({ ruleId: 'doc.links', grade: 'error', what: 'A content document links to something that is not there.', location: d.path, measured: list(d.brokenLinks), expected: 'links that resolve' });
    if (d.missingImages.length) out.push({ ruleId: 'doc.images', grade: 'error', what: 'A content document shows an image that is not in the EPUB.', location: d.path, measured: list(d.missingImages), expected: 'images present' });
    if (d.duplicateIds.length) out.push({ ruleId: 'doc.ids', grade: 'error', what: 'A content document repeats an id.', location: d.path, measured: list(d.duplicateIds), expected: 'unique ids' });
  }
  return out;
}

function matterRules({ epub }: PreflightFacts): Finding[] {
  if (!epub.opf?.wellFormed || !epub.documents.length) return [];
  const has = (re: RegExp) => epub.documents.some((d) => d.types.some((t) => re.test(t)) || re.test(d.path) || re.test(d.heading ?? ''));
  const out: Finding[] = [];
  if (!has(/title/i)) out.push({ ruleId: 'matter.titlepage', grade: 'warning', what: 'There is no title page.', location: '', measured: 'none found', expected: 'a title page' });
  if (!has(/copyright/i)) out.push({ ruleId: 'matter.copyright', grade: 'warning', what: 'There is no copyright page.', location: '', measured: 'none found', expected: 'a copyright page' });
  if (!has(/about[-\s]*(the)?[-\s]*author|author[-\s]*bio/i)) out.push({ ruleId: 'matter.about', grade: 'suggestion', what: 'There is no “About the author” page.', location: '', measured: 'none found', expected: 'an about-the-author page' });
  if (!has(/also[-\s]*by|other[-\s]*books|by[-\s]*the[-\s]*same/i)) out.push({ ruleId: 'matter.alsoby', grade: 'suggestion', what: 'There is no “Also by” page.', location: '', measured: 'none found', expected: 'an also-by page, for a book with others to offer' });
  return out;
}

function consistencyRules({ epub, book }: PreflightFacts): Finding[] {
  const o = epub.opf;
  if (!o?.wellFormed) return [];
  const out: Finding[] = [];
  const want = norm(book.title);
  if (want && norm(o.title) && norm(o.title) !== want && norm(o.title) !== norm(`${book.title} ${book.subtitle}`)) {
    out.push({ ruleId: 'names.title', grade: 'error', what: 'The title in the EPUB is not the title in the catalogue.', location: o.path, measured: o.title ?? '', expected: book.subtitle ? `${book.title} (or ${book.title}: ${book.subtitle})` : book.title });
  }
  const tp = epub.titlePage;
  if (tp?.title && want && !norm(tp.title).includes(want) && !norm(o.title).includes(norm(tp.title))) {
    out.push({ ruleId: 'names.titlepage', grade: 'error', what: 'The title page does not say the title in the catalogue.', location: 'title page', measured: tp.title, expected: book.title });
  }
  const author = norm(book.author);
  if (author) {
    if (o.creators.length && !o.creators.some((c) => norm(c) === author)) out.push({ ruleId: 'names.author', grade: 'error', what: 'The author in the EPUB is not the pen name in the catalogue.', location: o.path, measured: list(o.creators), expected: book.author });
    if (tp?.author && !norm(tp.author).includes(author)) out.push({ ruleId: 'names.authorpage', grade: 'warning', what: 'The title page names a different author from the catalogue.', location: 'title page', measured: tp.author, expected: book.author });
  }
  if (book.series) {
    if (!o.series) out.push({ ruleId: 'names.series', grade: 'suggestion', what: 'The catalogue puts this book in a series, but the EPUB does not say so.', location: o.path, measured: 'no series metadata', expected: book.series });
    else if (norm(o.series) !== norm(book.series)) out.push({ ruleId: 'names.series', grade: 'error', what: 'The series in the EPUB is not the series in the catalogue.', location: o.path, measured: o.series, expected: book.series });
    if (book.seriesNumber !== null && o.series && o.seriesIndex !== null && Number(o.seriesIndex) !== book.seriesNumber) out.push({ ruleId: 'names.seriesnumber', grade: 'error', what: 'The book’s number in the series differs from the catalogue.', location: o.path, measured: o.seriesIndex, expected: String(book.seriesNumber) });
  } else if (o.series) {
    out.push({ ruleId: 'names.series', grade: 'warning', what: 'The EPUB names a series, but the catalogue does not.', location: o.path, measured: o.series, expected: 'no series' });
  }
  if (book.isbn) {
    const wantIsbn = book.isbn.replace(/[^0-9Xx]/g, '');
    if (o.identifiers.length && !o.identifiers.some((i) => i.replace(/[^0-9Xx]/g, '') === wantIsbn)) out.push({ ruleId: 'names.isbn', grade: 'warning', what: 'None of the EPUB’s identifiers is the catalogue’s ISBN.', location: o.path, measured: list(o.identifiers), expected: book.isbn });
  }
  if (book.language && o.language && o.language.toLowerCase().split('-')[0] !== book.language.toLowerCase().split('-')[0]) out.push({ ruleId: 'names.language', grade: 'error', what: 'The language in the EPUB is not the catalogue’s.', location: o.path, measured: o.language, expected: book.language });
  return out;
}

function coverRules({ epub, approvedCover }: PreflightFacts, pack: RulePack): Finding[] {
  const c = epub.cover;
  const out: Finding[] = [];
  if (!c) {
    out.push({ ruleId: 'cover.missing', grade: 'error', what: 'The EPUB has no cover image.', location: epub.opf?.path ?? '', measured: 'none', expected: 'a manifest item with the cover-image property' });
  } else {
    const k = pack.cover;
    const long = Math.max(c.width ?? 0, c.height ?? 0);
    const sh = Math.min(c.width ?? 0, c.height ?? 0);
    if (c.format === null || !c.width || !c.height) out.push({ ruleId: 'cover.unreadable', grade: 'error', what: 'The cover image cannot be read as an image.', location: c.path, measured: 'unrecognised', expected: 'a JPEG, PNG, GIF or TIFF' });
    else {
      const dims = `${c.width} × ${c.height} pixels`;
      if (!k.formats.includes(c.format)) out.push({ ruleId: 'cover.format', grade: 'error', what: `A ${c.format.toUpperCase()} cover is not accepted.`, location: c.path, measured: c.format, expected: k.formats.join(', ') });
      if (long < k.rejectLongestBelow) out.push({ ruleId: 'cover.size', grade: 'error', what: 'The cover is too small to be accepted.', location: c.path, measured: dims, expected: `at least ${k.rejectLongestBelow} pixels on the longest side` });
      else if (sh < k.warnShortestBelow || long < k.warnLongestBelow) out.push({ ruleId: 'cover.size', grade: 'warning', what: 'The cover is smaller than the size KDP’s guidance asks for.', location: c.path, measured: dims, expected: `at least ${k.warnShortestBelow} × ${k.warnLongestBelow} pixels` });
      if (long > k.rejectAbove) out.push({ ruleId: 'cover.size', grade: 'error', what: 'The cover is larger than is accepted.', location: c.path, measured: dims, expected: `at most ${k.rejectAbove} pixels on a side` });
      const ratio = c.height / c.width;
      const want = k.recommended.height / k.recommended.width;
      if (long >= k.warnLongestBelow && Math.abs(ratio - want) / want > k.ratioTolerance) out.push({ ruleId: 'cover.ratio', grade: 'suggestion', what: 'The cover’s shape differs from the recommended one.', location: c.path, measured: `height to width ${ratio.toFixed(2)}`, expected: `about ${want.toFixed(2)} (${k.recommended.width} × ${k.recommended.height})` });
      else if (long >= k.warnLongestBelow && long < k.recommended.height) out.push({ ruleId: 'cover.recommended', grade: 'suggestion', what: 'The cover is smaller than the recommended size.', location: c.path, measured: dims, expected: `${k.recommended.width} × ${k.recommended.height} pixels` });
    }
    if (c.bytes > k.maxBytes) out.push({ ruleId: 'cover.bytes', grade: 'error', what: 'The cover file is too large.', location: c.path, measured: `${(c.bytes / 1048576).toFixed(1)} MB`, expected: `at most ${k.maxBytes / 1048576} MB` });
    if (c.colour === 'cmyk') out.push({ ruleId: 'cover.colour', grade: 'suggestion', what: 'The cover is CMYK; KDP converts it, and the colours may shift.', location: c.path, measured: 'CMYK', expected: 'RGB' });
    if (c.dpi && c.dpi < k.recommendedDpi && (c.width ?? 0) < k.recommended.width) out.push({ ruleId: 'cover.dpi', grade: 'suggestion', what: 'The cover declares a low resolution.', location: c.path, measured: `${c.dpi} dpi`, expected: `${k.recommendedDpi} dpi` });
  }
  // the cover in the EPUB is the approved one (docs/M5-PLAN.md: "used in Preflight")
  if (!approvedCover) {
    out.push({ ruleId: 'cover.approved', grade: 'warning', what: 'This book has no approved cover in the Studio, so the EPUB’s cover cannot be checked against one.', location: '', measured: 'no approved cover', expected: 'an approved cover asset' });
  } else if (c && approvedCover.hash !== c.hash) {
    out.push({ ruleId: 'cover.approved', grade: 'warning', what: `The cover in the EPUB is not the approved cover (version ${approvedCover.version}).`, location: c.path, measured: `file ${short(c.hash)}`, expected: `approved version ${approvedCover.version}, file ${short(approvedCover.hash)}` });
  }
  return out;
}

function metadataRules({ book }: PreflightFacts, pack: RulePack): Finding[] {
  const m = pack.metadata;
  const out: Finding[] = [];
  const t = `${book.title}${book.subtitle ? ` ${book.subtitle}` : ''}`;
  if (t.length > m.titleWithSubtitleMax) out.push({ ruleId: 'meta.title', grade: 'error', what: 'The title and subtitle together are too long.', location: 'catalogue', measured: `${t.length} characters`, expected: `at most ${m.titleWithSubtitleMax}` });
  if (!book.isbn && !book.asin) out.push({ ruleId: 'meta.identifier', grade: 'suggestion', what: 'The edition has neither an ISBN nor an ASIN in the catalogue.', location: 'catalogue', measured: 'none', expected: 'an ISBN, or leave it to KDP’s free ASIN' });
  if (book.price === null) out.push({ ruleId: 'meta.price', grade: 'warning', what: 'The edition has no price in the catalogue.', location: 'catalogue', measured: 'none', expected: 'a price' });
  if (book.blurb === null) out.push({ ruleId: 'meta.blurb', grade: 'warning', what: 'No blurb was found for this book.', location: 'Marketing/Blurb.md', measured: 'no file', expected: 'a blurb of at most ' + m.descriptionMax + ' characters' });
  else if (book.blurb.length > m.descriptionMax) out.push({ ruleId: 'meta.blurb', grade: 'error', what: 'The blurb is too long for KDP’s description.', location: 'Marketing/Blurb.md', measured: `${book.blurb.length} characters`, expected: `at most ${m.descriptionMax}` });
  if (book.keywords === null) out.push({ ruleId: 'meta.keywords', grade: 'warning', what: 'No keywords were found for this book.', location: 'Marketing/Keywords.md', measured: 'no file', expected: `up to ${m.keywordsMax} keywords` });
  else {
    if (book.keywords.length > m.keywordsMax) out.push({ ruleId: 'meta.keywords', grade: 'error', what: 'There are more keywords than KDP takes.', location: 'Marketing/Keywords.md', measured: `${book.keywords.length}`, expected: `at most ${m.keywordsMax}` });
    else if (book.keywords.length < m.keywordsMax) out.push({ ruleId: 'meta.keywords', grade: 'suggestion', what: 'Not all seven keyword slots are used.', location: 'Marketing/Keywords.md', measured: `${book.keywords.length}`, expected: `${m.keywordsMax}` });
    for (const k of book.keywords.filter((x) => x.length > m.keywordMaxChars)) out.push({ ruleId: 'meta.keywordlength', grade: 'error', what: 'A keyword is longer than the Studio’s limit.', location: 'Marketing/Keywords.md', measured: `${k.length} characters: ${k.slice(0, 40)}…`, expected: `at most ${m.keywordMaxChars}` });
  }
  return out;
}
