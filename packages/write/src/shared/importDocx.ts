import { strFromU8, unzipSync } from 'fflate';

/**
 * Converts a Word (.docx) file to Markdown: headings, bold / italic / strikethrough, lists, links, block quotes and
 * tables. Pure (bytes in, text out) so the desktop app and the tests share it.
 */

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e]
  );

/** A minimal XML reader: enough for WordprocessingML (no DTDs, no mixed content that matters). */
function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decode(m[6]);
    else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const node: XNode = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root;
}

const kids = (n: XNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];
const kid = (n: XNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const val = (n: XNode | undefined) => n?.attrs['w:val'];

interface Fmt {
  b: boolean;
  i: boolean;
  s: boolean;
}
const NO_FMT: Fmt = { b: false, i: false, s: false };

const on = (n: XNode | undefined): boolean | undefined => {
  if (!n) return undefined;
  const v = val(n);
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
};

/** The formatting a <w:rPr> sets, layered over `base`. */
function applyRPr(rPr: XNode | undefined, base: Fmt): Fmt {
  if (!rPr) return base;
  return {
    b: on(kid(rPr, 'w:b')) ?? base.b,
    i: on(kid(rPr, 'w:i')) ?? base.i,
    s: on(kid(rPr, 'w:strike')) ?? base.s
  };
}

interface StyleInfo {
  name: string;
  basedOn?: string;
  fmt?: XNode;
}

interface Ctx {
  styles: Map<string, StyleInfo>;
  rels: Map<string, string>;
  /** numId → ilvl → is it a numbered (not bulleted) level? */
  numbered: Map<string, Map<string, boolean>>;
}

function styleChain(ctx: Ctx, id: string | undefined): StyleInfo[] {
  const chain: StyleInfo[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const st = ctx.styles.get(id);
    if (!st) break;
    chain.unshift(st);
    id = st.basedOn;
  }
  return chain;
}

function styleFmt(ctx: Ctx, id: string | undefined, base: Fmt): Fmt {
  return styleChain(ctx, id).reduce((f, st) => applyRPr(st.fmt, f), base);
}

/** 1–6 for a heading paragraph (Title counts as 1), else 0. */
function headingLevel(ctx: Ctx, pPr: XNode | undefined): number {
  for (const st of styleChain(ctx, val(kid(pPr, 'w:pStyle'))).reverse()) {
    const m = /^heading\s*([1-9])$/i.exec(st.name);
    if (m) return Math.min(6, +m[1]);
    if (/^title$/i.test(st.name)) return 1;
  }
  const outline = val(kid(pPr, 'w:outlineLvl'));
  if (outline !== undefined && +outline < 6) return +outline + 1;
  return 0;
}

interface Piece {
  text: string;
  fmt: Fmt;
}

const MARKS: Array<[keyof Fmt, string]> = [
  ['s', '~~'],
  ['b', '**'],
  ['i', '*']
];

/** Joins runs into Markdown, merging neighbours with identical formatting and keeping the markers off the spaces. */
function render(pieces: Piece[], plain = false): string {
  const merged: Piece[] = [];
  for (const p of pieces) {
    if (!p.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.fmt.b === p.fmt.b && prev.fmt.i === p.fmt.i && prev.fmt.s === p.fmt.s) prev.text += p.text;
    else merged.push({ text: p.text, fmt: p.fmt });
  }
  return merged
    .map(({ text, fmt }) => {
      const esc = escapeMd(text);
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(esc)!;
      if (!m[2] || plain) return esc;
      let core = m[2];
      for (const [k, mark] of MARKS) if (fmt[k]) core = mark + core + mark;
      return m[1] + core + m[3];
    })
    .join('');
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]~])/g, '\\$1').replace(/^(\s*)([#>])/, '$1\\$2');
}

function collectRuns(ctx: Ctx, node: XNode, base: Fmt, out: Piece[], link?: string): void {
  for (const c of node.children) {
    if (c.name === 'w:r') {
      const rPr = kid(c, 'w:rPr');
      let fmt = styleFmt(ctx, val(kid(rPr, 'w:rStyle')), base);
      fmt = applyRPr(rPr, fmt);
      let text = '';
      for (const t of c.children) {
        if (t.name === 'w:t') text += t.text;
        else if (t.name === 'w:tab') text += ' ';
        else if (t.name === 'w:br' || t.name === 'w:cr') text += t.attrs['w:type'] === 'page' ? '' : '  \n';
        else if (t.name === 'w:noBreakHyphen') text += '-';
        else if (t.name === 'w:sym') text += '';
      }
      if (link && text.trim()) {
        const inner = render([{ text, fmt }]);
        const lead = /^\s*/.exec(inner)![0];
        const trail = /\s*$/.exec(inner)![0];
        out.push({ text: `\u0000${lead}[${inner.trim()}](${link})${trail}\u0000`, fmt: NO_FMT });
      } else out.push({ text, fmt });
    } else if (c.name === 'w:hyperlink') {
      const target = c.attrs['r:id'] ? ctx.rels.get(c.attrs['r:id']) : c.attrs['w:anchor'] ? '#' + c.attrs['w:anchor'] : undefined;
      collectRuns(ctx, c, base, out, target);
    } else if (c.name === 'w:ins' || c.name === 'w:smartTag' || c.name === 'w:sdt' || c.name === 'w:sdtContent' || c.name === 'w:fldSimple') {
      collectRuns(ctx, c, base, out, link);
    }
  }
}

/** Link pieces are already Markdown; pass them through `render` untouched. */
function inline(ctx: Ctx, p: XNode, base: Fmt): string {
  const pieces: Piece[] = [];
  collectRuns(ctx, p, base, pieces);
  const parts: string[] = [];
  let buf: Piece[] = [];
  for (const piece of pieces) {
    if (piece.text.includes('\u0000')) {
      parts.push(render(buf));
      buf = [];
      parts.push(piece.text.replaceAll('\u0000', ''));
    } else buf.push(piece);
  }
  parts.push(render(buf));
  return parts.join('');
}

function paragraph(ctx: Ctx, p: XNode): { text: string; kind: 'heading' | 'list' | 'quote' | 'text'; level: number; numbered: boolean } {
  const pPr = kid(p, 'w:pPr');
  const styleId = val(kid(pPr, 'w:pStyle'));
  const level = headingLevel(ctx, pPr);
  const styleName = styleChain(ctx, styleId).map((s) => s.name).join(' ');
  const base = styleFmt(ctx, styleId, NO_FMT);
  const text = inline(ctx, p, base).replace(/[ \t]+$/g, '').replace(/^\s+(?=\S)/, '');
  if (level) return { text: text.replace(/\s*\n\s*/g, ' '), kind: 'heading', level, numbered: false };
  const numPr = kid(pPr, 'w:numPr');
  const numId = val(kid(numPr, 'w:numId'));
  if (numPr && numId && numId !== '0') {
    const ilvl = val(kid(numPr, 'w:ilvl')) ?? '0';
    return { text, kind: 'list', level: +ilvl, numbered: ctx.numbered.get(numId)?.get(ilvl) ?? false };
  }
  if (/list (bullet|number)/i.test(styleName)) return { text, kind: 'list', level: 0, numbered: /number/i.test(styleName) };
  if (/quote/i.test(styleName)) return { text, kind: 'quote', level: 0, numbered: false };
  return { text, kind: 'text', level: 0, numbered: false };
}

function table(ctx: Ctx, tbl: XNode): string {
  const rows = kids(tbl, 'w:tr').map((tr) =>
    kids(tr, 'w:tc').map((tc) =>
      kids(tc, 'w:p')
        .map((p) => paragraph(ctx, p).text)
        .filter(Boolean)
        .join('<br>')
        .replaceAll('|', '\\|')
    )
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => '| ' + Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(rows[0]), '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
}

function blocks(ctx: Ctx, body: XNode): string[] {
  const out: string[] = [];
  const counters: number[] = [];
  let lastKind = '';
  const flushList = () => (counters.length = 0);
  for (const node of body.children) {
    if (node.name === 'w:p') {
      const p = paragraph(ctx, node);
      if (!p.text.trim()) {
        flushList();
        lastKind = '';
        continue;
      }
      if (p.kind === 'heading') {
        flushList();
        out.push('#'.repeat(p.level) + ' ' + p.text);
      } else if (p.kind === 'list') {
        counters.length = p.level + 1;
        const n = (counters[p.level] ?? 0) + 1;
        counters[p.level] = n;
        const item = '  '.repeat(p.level) + (p.numbered ? `${n}. ` : '- ') + p.text;
        // consecutive items form one block (tight list)
        if (lastKind === 'list') out[out.length - 1] += '\n' + item;
        else out.push(item);
      } else if (p.kind === 'quote') {
        flushList();
        const q = '> ' + p.text;
        if (lastKind === 'quote') out[out.length - 1] += '\n>\n' + q;
        else out.push(q);
      } else {
        flushList();
        out.push(p.text);
      }
      lastKind = p.kind;
    } else if (node.name === 'w:tbl') {
      flushList();
      const t = table(ctx, node);
      if (t) out.push(t);
      lastKind = 'table';
    } else if (node.name === 'w:sdt') {
      const content = kid(node, 'w:sdtContent');
      if (content) out.push(...blocks(ctx, content));
    }
  }
  return out;
}

const WANTED = new Set(['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']);

export function docxToMarkdown(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => WANTED.has(f.name) });
  } catch {
    throw new Error('That file is not a valid .docx document.');
  }
  const read = (name: string) => (files[name] ? parseXml(strFromU8(files[name])) : undefined);
  const doc = read('word/document.xml');
  const body = kid(kid(doc, 'w:document'), 'w:body') ?? kid(doc, 'w:document');
  if (!body) throw new Error('That file is not a valid .docx document.');

  const styles = new Map<string, StyleInfo>();
  for (const st of kids(kid(read('word/styles.xml'), 'w:styles'), 'w:style')) {
    const id = st.attrs['w:styleId'];
    if (id) styles.set(id, { name: val(kid(st, 'w:name')) ?? id, basedOn: val(kid(st, 'w:basedOn')), fmt: kid(st, 'w:rPr') });
  }
  const rels = new Map<string, string>();
  for (const r of kids(read('word/_rels/document.xml.rels'), 'Relationships').flatMap((x) => kids(x, 'Relationship'))) {
    if (r.attrs['TargetMode'] === 'External') rels.set(r.attrs['Id'], r.attrs['Target']);
  }
  const numbered = new Map<string, Map<string, boolean>>();
  const numbering = kid(read('word/numbering.xml'), 'w:numbering');
  const abstracts = new Map<string, Map<string, boolean>>();
  for (const a of kids(numbering, 'w:abstractNum')) {
    const levels = new Map<string, boolean>();
    for (const l of kids(a, 'w:lvl')) levels.set(l.attrs['w:ilvl'], val(kid(l, 'w:numFmt')) !== 'bullet');
    abstracts.set(a.attrs['w:abstractNumId'], levels);
  }
  for (const n of kids(numbering, 'w:num')) {
    const levels = abstracts.get(val(kid(n, 'w:abstractNumId')) ?? '');
    if (levels) numbered.set(n.attrs['w:numId'], levels);
  }

  const md = blocks({ styles, rels, numbered }, body).join('\n\n');
  return md ? md + '\n' : '';
}
