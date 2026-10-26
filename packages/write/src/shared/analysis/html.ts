import type { Analysis, Example } from './analyze';
import { findings } from './report';

export interface HtmlOptions {
  source: string;
  generated: string;
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (n: number, d = 0): string => (Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const pct = (n: number, d = 1): string => `${num(n * 100, d)}%`;
const compact = (n: number): string => (Math.abs(n) >= 1000 ? `${num(n / 1000, n >= 10000 ? 0 : 1)}K` : num(n, n % 1 ? 1 : 0));

function gradeLabel(g: number): string {
  const grade = Math.max(0, Math.round(g));
  if (grade >= 13) return 'college level';
  if (grade <= 0) return 'kindergarten level';
  return `grade ${grade} (ages ${grade + 5}–${grade + 6})`;
}

/** A ramp from the page surface to the series colour, as an opacity. */
const wash = (v: number, max: number): number => (max > 0 && v > 0 ? 0.14 + 0.86 * Math.min(1, v / max) : 0);

/** The sentence with the matched phrase picked out. */
function excerpt(text: string, mark?: string, width = 200): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const at = mark ? t.toLowerCase().indexOf(mark.toLowerCase()) : -1;
  let from = 0;
  let to = t.length;
  if (t.length > width) {
    const centre = at >= 0 ? at + mark!.length / 2 : width / 2;
    from = Math.max(0, Math.min(t.length - width, Math.round(centre - width / 2)));
    to = from + width;
  }
  const piece = t.slice(from, to);
  const idx = mark ? piece.toLowerCase().indexOf(mark.toLowerCase()) : -1;
  const body = idx < 0 || !mark ? esc(piece) : `${esc(piece.slice(0, idx))}<mark>${esc(piece.slice(idx, idx + mark.length))}</mark>${esc(piece.slice(idx + mark.length))}`;
  return `${from > 0 ? '…' : ''}${body}${to < t.length ? '…' : ''}`;
}

// ---- chart pieces ------------------------------------------------------------------------

interface BarRow {
  label: string;
  value: number;
  text?: string;
  tip?: string;
}

/** Horizontal bars: label, track, value. Thin bars with a rounded end, growing from one baseline. */
function hbars(rows: BarRow[], opts: { max?: number; labelWidth?: number } = {}): string {
  if (!rows.length) return '';
  const max = opts.max ?? Math.max(...rows.map((r) => r.value), 0);
  const lw = opts.labelWidth ?? 170;
  return `<div class="hbars" style="--lw:${lw}px" role="list">${rows
    .map(
      (r) =>
        `<div class="hb" role="listitem" title="${esc(r.tip ?? `${r.label}: ${r.text ?? num(r.value)}`)}"><span class="hb-l">${esc(r.label)}</span><span class="hb-t"><i style="width:${max > 0 ? Math.max(r.value > 0 ? 0.6 : 0, Math.min(100, (r.value / max) * 100)).toFixed(2) : 0}%"></i></span><span class="hb-v">${esc(r.text ?? num(r.value))}</span></div>`
    )
    .join('')}</div>`;
}

interface Col {
  label: string;
  value: number;
  tip: string;
  /** Second, stacked part (e.g. narration on top of dialogue). */
}

/** Vertical bars with an axis, optional reference line, and a hover title on each. */
function columns(cols: Col[], opts: { height?: number; ref?: { value: number; label: string }; fmt?: (n: number) => string; max?: number } = {}): string {
  if (!cols.length) return '';
  const H = opts.height ?? 150;
  const fmt = opts.fmt ?? compact;
  const left = 38;
  const right = 34;
  const bottom = 22;
  const top = 12;
  const W = Math.max(640, left + right + cols.length * 18);
  const max = niceMax(Math.max(opts.max ?? 0, ...cols.map((c) => c.value), opts.ref?.value ?? 0));
  const ph = H - top - bottom;
  const slot = (W - left - right) / cols.length;
  const bw = Math.min(24, Math.max(3, slot * 0.62));
  const y = (v: number) => top + ph - (v / max) * ph;
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(cols.length / Math.floor((W - left) / 26)));
  const bars = cols
    .map((c, i) => {
      const x = left + i * slot + (slot - bw) / 2;
      const h = Math.max(c.value > 0 ? 1.5 : 0, (c.value / max) * ph);
      const r = Math.min(4, bw / 2, h);
      const path = h <= 0 ? '' : `M${x.toFixed(1)},${(top + ph).toFixed(1)}V${(top + ph - h + r).toFixed(1)}Q${x.toFixed(1)},${(top + ph - h).toFixed(1)} ${(x + r).toFixed(1)},${(top + ph - h).toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${(top + ph - h).toFixed(1)} ${(x + bw).toFixed(1)},${(top + ph - h + r).toFixed(1)}V${(top + ph).toFixed(1)}Z`;
      return `<g class="col"><rect x="${(left + i * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${ph + bottom}" fill="transparent"/><path d="${path}" class="mark"/><title>${esc(c.tip)}</title></g>${i % every === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" class="ax" text-anchor="middle">${esc(c.label)}</text>` : ''}`;
    })
    .join('');
  const grid = ticks
    .map((t) => `<line x1="${left}" x2="${W - right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/><text x="${left - 6}" y="${(y(t) + 3.5).toFixed(1)}" class="ax" text-anchor="end">${esc(fmt(t))}</text>`)
    .join('');
  const ref = opts.ref
    ? `<line x1="${left}" x2="${W - right}" y1="${y(opts.ref.value).toFixed(1)}" y2="${y(opts.ref.value).toFixed(1)}" class="ref"/><text x="${W - 2}" y="${(y(opts.ref.value) + 3.5).toFixed(1)}" class="ax" text-anchor="end">${esc(opts.ref.label)}</text>`
    : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMinYMid meet" style="max-width:${W * 1.35}px">${grid}${ref}${bars}</svg>`;
}

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** A small line for one measure across the chapters, with a dot on the last value. */
function spark(title: string, values: number[], fmt: (n: number) => string, tips: string[]): string {
  const W = 220;
  const H = 54;
  const pad = 6;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, max);
  const span = max - min || 1;
  const x = (i: number) => (values.length <= 1 ? W / 2 : pad + (i * (W - 2 * pad - 38)) / (values.length - 1));
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  const hits = values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="6" fill="transparent"><title>${esc(tips[i])}</title></circle>`).join('');
  return `<figure class="spark"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} across chapters">${values.length > 1 ? `<polyline points="${pts}" class="ln"/>` : ''}<circle cx="${x(last).toFixed(1)}" cy="${y(values[last] ?? 0).toFixed(1)}" r="4" class="dot"/><text x="${(x(last) + 9).toFixed(1)}" y="${(y(values[last] ?? 0) + 4).toFixed(1)}" class="ax">${esc(fmt(values[last] ?? 0))}</text>${hits}</svg></figure>`;
}

/** A single stacked bar for parts of a whole, with a legend. */
function stacked(parts: { label: string; value: number; cls: string; text?: string }[]): string {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return `<div class="stack" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${pct(p.value / total)}`).join(', '))}">${parts
    .filter((p) => p.value > 0)
    .map((p) => `<i class="${p.cls}" style="flex:${p.value}" title="${esc(`${p.label}: ${p.text ?? pct(p.value / total)}`)}">${p.value / total > 0.12 ? `<b>${esc(p.text ?? pct(p.value / total, 0))}</b>` : ''}</i>`)
    .join('')}</div><ul class="legend">${parts.map((p) => `<li><span class="sw ${p.cls}"></span>${esc(p.label)} <b>${esc(p.text ?? pct(p.value / total))}</b></li>`).join('')}</ul>`;
}

/** A grid of squares, darker for more. */
function heat(rows: { label: string; cells: number[]; tip: (i: number, v: number) => string }[], colLabels: string[]): string {
  if (!rows.length) return '';
  const cols = colLabels.length;
  const cell = Math.max(10, Math.min(22, Math.floor(620 / Math.max(1, cols))));
  const left = 128;
  const top = 18;
  const W = left + cols * cell + 6;
  const H = top + rows.length * cell + 4;
  const every = Math.max(1, Math.ceil(cols / Math.floor((W - left) / 24)));
  const out: string[] = [];
  colLabels.forEach((l, i) => {
    if (i % every === 0) out.push(`<text x="${left + i * cell + cell / 2}" y="${top - 6}" class="ax" text-anchor="middle">${esc(l)}</text>`);
  });
  rows.forEach((r, ri) => {
    const max = Math.max(...r.cells, 1);
    out.push(`<text x="${left - 8}" y="${top + ri * cell + cell / 2 + 3.5}" class="ax" text-anchor="end">${esc(r.label.length > 18 ? r.label.slice(0, 17) + '…' : r.label)}</text>`);
    r.cells.forEach((v, ci) => {
      out.push(`<rect x="${left + ci * cell}" y="${top + ri * cell}" width="${cell - 2}" height="${cell - 2}" rx="2" class="cellbg"/>${v > 0 ? `<rect x="${left + ci * cell}" y="${top + ri * cell}" width="${cell - 2}" height="${cell - 2}" rx="2" class="mark" fill-opacity="${wash(v, max).toFixed(2)}"><title>${esc(r.tip(ci, v))}</title></rect>` : `<rect x="${left + ci * cell}" y="${top + ri * cell}" width="${cell - 2}" height="${cell - 2}" fill="transparent"><title>${esc(r.tip(ci, v))}</title></rect>`}`);
    });
  });
  return `<svg class="chart heat" viewBox="0 0 ${W} ${H}" role="img" style="max-width:${W * 1.6}px">${out.join('')}</svg>`;
}

/** The reading-level strip: where the book sits on grades 0–16, against the usual range for fiction. */
function gauge(grade: number): string {
  const W = 560;
  const H = 70;
  const L = 14;
  const R = W - 14;
  const x = (g: number) => L + (Math.max(0, Math.min(16, g)) / 16) * (R - L);
  const ticks = [0, 4, 8, 12, 16].map((g) => `<line x1="${x(g)}" x2="${x(g)}" y1="30" y2="40" class="grid"/><text x="${x(g)}" y="54" class="ax" text-anchor="middle">${g === 16 ? '16+' : g}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Reading level, grade ${num(grade, 1)}" style="max-width:${W * 1.4}px"><rect x="${L}" y="24" width="${R - L}" height="10" rx="5" class="track"/><rect x="${x(4)}" y="24" width="${x(8) - x(4)}" height="10" class="band"><title>Most commercial fiction: grades 4–8</title></rect><text x="${(x(4) + x(8)) / 2}" y="16" class="ax" text-anchor="middle">usual for fiction</text><circle cx="${x(grade)}" cy="29" r="8" class="dot ring"><title>This text: grade ${num(grade, 1)}</title></circle>${ticks}</svg>`;
}

function table(head: string[], rows: (string | number)[][], align: ('l' | 'r')[] = [], raw = false): string {
  if (!rows.length) return '';
  const c = (v: string | number) => (raw ? String(v) : esc(v));
  return `<div class="tw"><table><thead><tr>${head.map((h, i) => `<th class="${align[i] === 'r' ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td class="${align[i] === 'r' ? 'r' : ''}">${c(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function readingTime(words: number): string {
  const min = Math.round(words / 250);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

const tile = (label: string, value: string, sub = ''): string => `<div class="tile"><span class="tl">${esc(label)}</span><span class="tv">${esc(value)}</span>${sub ? `<span class="ts">${esc(sub)}</span>` : ''}</div>`;

const section = (id: string, title: string, body: (string | false | undefined)[], intro = ''): string =>
  `<section id="${id}" class="card"><h2>${esc(title)}</h2>${intro ? `<p class="intro">${intro}</p>` : ''}${body.filter(Boolean).join('')}</section>`;

const sub = (t: string): string => `<h3>${esc(t)}</h3>`;
const note = (t: string): string => `<p class="note">${t}</p>`;

function examples(list: Example[], titles: string[]): string {
  if (!list.length) return '';
  return `<ul class="ex">${list.map((e) => `<li><span class="tag">${esc(titles[e.chapter] ?? `Chapter ${e.chapter + 1}`)}</span> ${excerpt(e.text, e.mark)}</li>`).join('')}</ul>`;
}

function flags(items: string[]): string {
  if (!items.length) return '';
  return `<ul class="ex">${items
    .map((f) => {
      const [n, title, ...rest] = f.split('|');
      return `<li><span class="tag">${esc(`${n}. ${title}`)}</span> ${esc(rest.join('|'))}</li>`;
    })
    .join('')}</ul>`;
}

const CSS = `
:root{color-scheme:light;--bg:#f6f5f2;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#7a7873;--line:#e4e2dc;--track:#ecebe6;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--look:#d03b3b;--note:#2a78d6;--hi:#fff3b8}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#121211;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#99978d;--line:#2e2e2c;--track:#2a2a28;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--look:#ec6b6b;--note:#6da7ec;--hi:#5a4c00}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:20px 16px 56px}
header.top{padding:18px 0 6px}header.top h1{margin:0;font-size:26px;line-height:1.2}header.top p{margin:4px 0 0;color:var(--ink2)}
nav.toc{position:sticky;top:0;z-index:5;display:flex;gap:4px 14px;flex-wrap:wrap;padding:8px 0;margin:8px 0 14px;background:var(--bg);border-bottom:1px solid var(--line);font-size:13px}
nav.toc a{color:var(--ink2);text-decoration:none}nav.toc a:hover{color:var(--ink);text-decoration:underline}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 16px;scroll-margin-top:48px}.anchor{scroll-margin-top:48px}
.card h2{margin:0 0 6px;font-size:19px}.card h3{margin:20px 0 8px;font-size:14px;color:var(--ink2);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.intro,.note{color:var(--ink2);margin:4px 0 12px}.note{font-size:13.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.tl{font-size:12.5px;color:var(--ink2)}.tv{font-size:26px;font-weight:650;line-height:1.15}.ts{font-size:12px;color:var(--muted)}
.tile.hero .tv{font-size:34px}
.hbars{display:flex;flex-direction:column;gap:5px;margin:8px 0}
.hb{display:grid;grid-template-columns:var(--lw) 1fr auto;gap:10px;align-items:center;min-height:22px}
.hb-l{font-size:13px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb-t{height:12px;background:transparent;display:block}.hb-t i{display:block;height:100%;background:var(--s1);border-radius:0 4px 4px 0}
.hb:hover .hb-t i{filter:brightness(1.12)}.hb-v{font-size:13px;font-variant-numeric:tabular-nums;color:var(--ink);min-width:3ch;text-align:right}
.s2 .hb-t i{background:var(--s2)}
.chart{display:block;width:100%;height:auto;margin:8px 0}.chart .ax{font-size:10.5px;fill:var(--muted)}.chart .grid{stroke:var(--line);stroke-width:1}
.chart .ref{stroke:var(--muted);stroke-width:1;stroke-dasharray:0}.chart .mark{fill:var(--s1)}.col:hover .mark{fill:var(--s2)}
.chart .cellbg{fill:var(--track)}.chart .track{fill:var(--track)}.chart .band{fill:var(--s1);fill-opacity:.25}.chart .dot{fill:var(--s1)}.chart .ring{stroke:var(--surface);stroke-width:2.5}
.sparks{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.spark{margin:0}.spark figcaption{font-size:12.5px;color:var(--ink2)}
.spark svg{width:100%;height:auto;display:block}.spark .ln{fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.spark .dot{fill:var(--s1);stroke:var(--surface);stroke-width:2}.spark .ax{font-size:11px;fill:var(--ink2)}
.stack{display:flex;gap:2px;height:30px;margin:10px 0 6px}.stack i{display:flex;align-items:center;justify-content:center;min-width:3px;font-style:normal;color:#fff;font-size:12.5px}
.stack i:first-child{border-radius:6px 0 0 6px}.stack i:last-child{border-radius:0 6px 6px 0}.stack i:only-child{border-radius:6px}
.c1{background:var(--s1)}.c2{background:var(--s2)}.c3{background:var(--s3)}.c4{background:var(--s4);color:#0b0b0b}
.legend{list-style:none;display:flex;gap:6px 18px;flex-wrap:wrap;padding:0;margin:4px 0 10px;font-size:13px;color:var(--ink2)}.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
.tw{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
td:first-child{white-space:normal}th{font-weight:600;color:var(--ink2);font-size:12.5px}th.r,td.r{text-align:right;font-variant-numeric:tabular-nums}tbody tr:hover{background:var(--track)}
.finds{list-style:none;padding:0;margin:8px 0}.finds li{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}.finds li:last-child{border:0}
.badge{flex:none;min-width:54px;text-align:center;font-size:11.5px;font-weight:650;border-radius:999px;padding:1px 9px;height:20px;margin-top:2px}.badge.look{background:var(--look);color:#fff}.badge.note{background:var(--note);color:#fff}
.ex{list-style:none;padding:0;margin:8px 0}.ex li{padding:6px 0;border-bottom:1px solid var(--line);color:var(--ink)}.ex li:last-child{border:0}
.tag{display:inline-block;font-size:11.5px;color:var(--ink2);background:var(--track);border-radius:6px;padding:0 7px;margin-right:6px}mark{background:var(--hi);color:inherit;border-radius:3px;padding:0 2px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:4px 28px}
.pill{display:inline-block;border-radius:999px;padding:0 9px;font-size:12px;background:var(--track);color:var(--ink2)}.pill.warn{background:var(--look);color:#fff}
.mini{display:inline-block;height:8px;border-radius:0 3px 3px 0;background:var(--s1);vertical-align:middle;margin-left:6px}
footer.method{color:var(--muted);font-size:13px}footer.method li{margin:3px 0}
@media (max-width:560px){.hb{grid-template-columns:110px 1fr auto}.card{padding:14px}}
@media print{:root{color-scheme:light;--bg:#fff;--surface:#fff;--ink:#0b0b0b;--ink2:#52514e;--muted:#7a7873;--line:#e4e2dc;--track:#ecebe6;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--look:#d03b3b;--note:#2a78d6;--hi:#fff3b8}body{background:#fff}nav.toc{display:none}.card{break-inside:avoid;border-color:#ccc}.wrap{max-width:none;padding:0}}
`;

/** A complete, self-contained HTML page for the analysis: charts are inline SVG, there is no script, and it follows the viewer's light or dark setting. */
export function renderReportHtml(a: Analysis, opts: HtmlOptions): string {
  const t = a.totals;
  const titles = a.chapters.map((c) => c.title);
  const chNo = a.chapters.map((_c, i) => String(i + 1));
  const chTip = (i: number, extra: string) => `${i + 1}. ${titles[i]}: ${extra}`;
  const perK = (n: number, words: number) => (n / Math.max(1, words)) * 1000;
  const body: string[] = [];

  if (!t.words) {
    return page(opts, [section('summary', 'Nothing to analyse', [`<p>There is no prose in <b>${esc(opts.source)}</b>.</p>`])], []);
  }
  const dlg = t.dialogueWords / t.words;
  const fs = findings(a);
  const nav: [string, string][] = [];
  const add = (id: string, title: string, html: string) => {
    nav.push([id, title]);
    body.push(`<div id="${id}" class="anchor">${html}</div>`);
  };

  // summary
  add(
    'summary',
    'Summary',
    `<div class="tiles">${[
      tile('Words', num(t.words), `${a.chapters.length} chapters · ${num(t.scenes)} scenes`),
      tile('Dialogue', pct(dlg, 0), 'of all words'),
      tile('Average sentence', `${num(a.sentenceLengths.average, 1)}`, 'words'),
      tile('Reading level', `Grade ${num(Math.max(0, a.readability.grade), 1)}`, gradeLabel(a.readability.grade).replace(/^grade \d+ /, '')),
      tile('Adverbs', num(a.adverbs.per1000, 1), 'per 1,000 words'),
      tile('Passive', pct(a.passive.share, 0), 'of sentences'),
      tile('Point of view', a.pov.person === 'unclear' ? '–' : `${a.pov.person[0].toUpperCase()}${a.pov.person.slice(1)}`, a.pov.tense === 'unclear' ? '' : `${a.pov.tense} tense`)
    ].join('')}</div>` +
      section('summary-finds', 'Worth a look', [
        fs.length
          ? `<ul class="finds">${fs.map((f) => `<li><span class="badge ${f.level}">${f.level === 'look' ? '! Look' : 'Note'}</span><span>${esc(f.text)}</span></li>`).join('')}</ul>`
          : '<p>Nothing stands out against the usual rules of thumb.</p>',
        note('These checks are automatic and will sometimes be wrong. They tell you where to look, not what to change.')
      ])
  );

  // overview
  const maxW = Math.max(...a.chapters.map((c) => c.words));
  add(
    'overview',
    'Overview',
    section('overview-in', 'Overview', [
      `<div class="two"><div>${table(['Measure', 'Value'], [
        ['Words', num(t.words)],
        ['Unique words', `${num(t.uniqueWords)} (${pct(t.uniqueWords / t.words, 0)} of all words)`],
        ['Sentences', num(t.sentences)],
        ['Paragraphs', num(t.paragraphs)]
      ], ['l', 'r'])}</div><div>${table(['Measure', 'Value'], [
        ['Reading time (250 wpm)', readingTime(t.words)],
        ['Average chapter', `${num(t.words / a.chapters.length)} words`],
        ['Average paragraph', `${num(a.paragraphLengths.average, 1)} words`],
        ['Short paragraphs (≤12 words)', `${num(t.oneLineParagraphs)} (${pct(t.oneLineParagraphs / Math.max(1, t.paragraphs), 0)})`],
        ['Longest paragraph', `${num(t.longestParagraph)} words`]
      ], ['l', 'r'])}</div></div>`,
      sub('Chapter length (words)'),
      columns(a.chapters.map((c, i) => ({ label: chNo[i], value: c.words, tip: chTip(i, `${num(c.words)} words`) }))),
      sub('Across the chapters'),
      `<div class="sparks">${[
        spark('Words', a.chapters.map((c) => c.words), compact, a.chapters.map((c, i) => chTip(i, `${num(c.words)} words`))),
        spark('Dialogue share', a.chapters.map((c) => (c.words ? c.dialogueWords / c.words : 0)), (n) => pct(n, 0), a.chapters.map((c, i) => chTip(i, pct(c.words ? c.dialogueWords / c.words : 0, 0)))),
        spark('Sentence length', a.chapters.map((c) => c.avgSentence), (n) => num(n, 1), a.chapters.map((c, i) => chTip(i, `${num(c.avgSentence, 1)} words`))),
        spark('Reading grade', a.chapters.map((c) => c.grade), (n) => num(n, 1), a.chapters.map((c, i) => chTip(i, `grade ${num(c.grade, 1)}`))),
        spark('Adverbs per 1,000', a.chapters.map((c) => perK(c.adverbs, c.words)), (n) => num(n, 1), a.chapters.map((c, i) => chTip(i, `${num(perK(c.adverbs, c.words), 1)}`))),
        spark('Passive sentences', a.chapters.map((c) => (c.sentences ? c.passive / c.sentences : 0)), (n) => pct(n, 0), a.chapters.map((c, i) => chTip(i, pct(c.sentences ? c.passive / c.sentences : 0, 0)))),
        spark('Filler words per 1,000', a.chapters.map((c) => perK(c.filler, c.words)), (n) => num(n, 1), a.chapters.map((c, i) => chTip(i, num(perK(c.filler, c.words), 1)))),
        spark('Filter words per 1,000', a.chapters.map((c) => perK(c.crutch, c.words)), (n) => num(n, 1), a.chapters.map((c, i) => chTip(i, num(perK(c.crutch, c.words), 1))))
      ].join('')}</div>`,
      sub('Chapter by chapter'),
      table(
        ['#', 'Chapter', 'Words', 'Dialogue', 'Avg sentence', 'Grade', 'Adverbs/1k', 'Passive', 'Filler/1k', 'Filter/1k'],
        a.chapters.map((c, i) => [
          i + 1,
          esc(c.title),
          `${num(c.words)}<span class="mini" style="width:${Math.round((c.words / maxW) * 60)}px"></span>`,
          pct(c.words ? c.dialogueWords / c.words : 0, 0),
          num(c.avgSentence, 1),
          num(c.grade, 1),
          num(perK(c.adverbs, c.words), 1),
          pct(c.sentences ? c.passive / c.sentences : 0, 0),
          num(perK(c.filler, c.words), 1),
          num(perK(c.crutch, c.words), 1)
        ]),
        ['r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
        true
      )
    ])
  );

  // dialogue
  add(
    'dialogue',
    'Dialogue',
    section('dialogue-in', 'Dialogue', [
      stacked([
        { label: 'Dialogue', value: t.dialogueWords, cls: 'c1' },
        { label: 'Narration', value: t.narrationWords, cls: 'c2' }
      ]),
      `<p class="intro"><b>${pct(t.dialogueParagraphs / Math.max(1, t.paragraphs), 0)}</b> of paragraphs contain dialogue.</p>`,
      sub('Dialogue share by chapter'),
      columns(a.chapters.map((c, i) => ({ label: chNo[i], value: c.words ? c.dialogueWords / c.words : 0, tip: chTip(i, pct(c.words ? c.dialogueWords / c.words : 0, 0)) })), { fmt: (n) => pct(n, 0) }),
      a.dialogue.speechTags.length > 0 &&
        sub('Dialogue tags') +
          `<p class="intro">Plain "said / asked / replied" make up <b>${pct(a.dialogue.plainShare, 0)}</b> of ${num(a.dialogue.tagTotal)} tags. The rest are showier verbs.</p>` +
          hbars(a.dialogue.speechTags.map((x) => ({ label: x.word, value: x.count })), { labelWidth: 110 }),
      a.dialogue.tagAdverbs.length > 0 && sub('Tags carrying adverbs') + `<p>${a.dialogue.tagAdverbs.map((x) => `<span class="pill">${esc(x.word)} · ${x.count}</span>`).join(' ')}</p>`
    ])
  );

  // sentences
  const hist = a.sentenceLengths.histogram;
  const ph = a.paragraphLengths.histogram;
  add(
    'sentences',
    'Sentences',
    section('sentences-in', 'Sentences and rhythm', [
      `<div class="tiles">${[tile('Average', `${num(a.sentenceLengths.average, 1)}`, 'words'), tile('Median', num(a.sentenceLengths.median), 'words'), tile('Spread', num(a.sentenceLengths.deviation, 1), 'standard deviation')].join('')}</div>`,
      `<div class="two"><div>${sub('Sentence length')}${columns(hist.map((b) => ({ label: b.label, value: b.count, tip: `${b.label} words: ${num(b.count)} sentences (${pct(b.count / Math.max(1, t.sentences), 0)})` })), { height: 140 })}</div><div>${sub('Paragraph length')}${columns(ph.map((b) => ({ label: b.label, value: b.count, tip: `${b.label} words: ${num(b.count)} paragraphs` })), { height: 140 })}</div></div>`,
      a.sentenceLengths.longest.length > 0 && sub('Longest sentences') + `<ul class="ex">${a.sentenceLengths.longest.map((e) => `<li><span class="tag">${esc(titles[e.chapter])} · ${e.words} words</span> ${excerpt(e.text, undefined, 280)}</li>`).join('')}</ul>`,
      sub('How sentences begin'),
      `<p class="intro"><b>${pct(a.openers.pronounShare, 0)}</b> start with a pronoun (he, she, they, I, we, it, you).</p>`,
      hbars(a.openers.top.map((o) => ({ label: o.word, value: o.count, text: `${num(o.count)} · ${pct(o.count / Math.max(1, t.sentences))}` })), { labelWidth: 110 }),
      a.openers.runs.length > 0 && `<p class="note">Runs of four or more sentences with the same opening word:</p>${examples(a.openers.runs, titles)}`
    ])
  );

  // reading level
  const r = a.readability;
  add(
    'reading',
    'Reading level',
    section(
      'reading-in',
      'Reading level',
      [
        gauge(r.grade),
        table(
          ['Formula', 'Score', 'Meaning'],
          [
            ['Flesch Reading Ease', num(r.fleschEase, 1), 'higher is easier; 60–70 is plain English'],
            ['Flesch–Kincaid', num(r.fleschKincaid, 1), gradeLabel(r.fleschKincaid)],
            ['Gunning Fog', num(r.gunningFog, 1), gradeLabel(r.gunningFog)],
            ['Coleman–Liau', num(r.colemanLiau, 1), gradeLabel(r.colemanLiau)],
            ['Automated Readability Index', num(r.ari, 1), gradeLabel(r.ari)],
            ...(r.smog === null ? [] : [['SMOG', num(r.smog, 1), gradeLabel(r.smog)]]),
            ['Average grade', num(r.grade, 1), gradeLabel(r.grade)]
          ],
          ['l', 'r', 'l']
        ),
        a.chapters.length > 1 && sub('Grade by chapter'),
        a.chapters.length > 1 && columns(a.chapters.map((c, i) => ({ label: chNo[i], value: Math.max(0, c.grade), tip: chTip(i, `grade ${num(c.grade, 1)}`) })), { fmt: (n) => num(n, 0), ref: { value: 8, label: 'grade 8' } })
      ],
      `About <b>${esc(gradeLabel(r.grade))}</b>. Fiction usually sits between grades 4 and 8; plain, dialogue-heavy prose scores low and that is normal.`
    )
  );

  // repeated words and phrases
  add(
    'words',
    'Repeated words',
    section(
      'words-in',
      'Repeated words and phrases',
      [
        hbars(a.repeatedWords.slice(0, 25).map((w) => ({ label: w.word, value: w.count, text: `${num(w.count)} · ${num(w.per10k, 0)}/10k`, tip: `${w.word}: ${num(w.count)} times, in ${w.chapters} of ${a.chapters.length} chapters` })), { labelWidth: 120 }),
        a.echoes.length > 0 && sub('Echoes: the same word within about 25 words'),
        a.echoes.length > 0 && hbars(a.echoes.map((e) => ({ label: e.word, value: e.count })), { labelWidth: 120 }),
        a.echoes.length > 0 && examples(a.echoes.slice(0, 6).map((e) => e.example), titles),
        sub('Two-word phrases'),
        a.bigrams.length ? hbars(a.bigrams.slice(0, 20).map((g) => ({ label: g.phrase, value: g.count, tip: `"${g.phrase}": ${g.count} times in ${g.chapters} chapters` })), { labelWidth: 170 }) : '<p class="note">None repeat often enough to list.</p>',
        sub('Three-word phrases'),
        a.trigrams.length ? hbars(a.trigrams.slice(0, 20).map((g) => ({ label: g.phrase, value: g.count, tip: `"${g.phrase}": ${g.count} times in ${g.chapters} chapters` })), { labelWidth: 220 }) : '<p class="note">None repeat often enough to list.</p>'
      ],
      'Content words once common words and character names are set aside. Look for words that are not part of your story’s vocabulary but keep showing up.'
    )
  );

  // adverbs
  add(
    'adverbs',
    'Adverbs',
    section(
      'adverbs-in',
      'Adverbs',
      [
        `<div class="two"><div>${hbars(a.adverbs.top.map((x) => ({ label: x.word, value: x.count })), { labelWidth: 110 })}</div><div>${sub('Per 1,000 words, by chapter')}${columns(a.chapters.map((c, i) => ({ label: chNo[i], value: perK(c.adverbs, c.words), tip: chTip(i, `${num(perK(c.adverbs, c.words), 1)} per 1,000`) })), { ref: { value: 10, label: '10' }, fmt: (n) => num(n, 0) })}</div></div>`
      ],
      `<b>${num(a.adverbs.total)}</b> “-ly” adverbs: ${num(a.adverbs.per1000, 1)} per 1,000 words, ${num(a.adverbs.distinct)} different ones. Many writers aim for under about 10.`
    )
  );

  // passive
  add(
    'passive',
    'Passive voice',
    section(
      'passive-in',
      'Passive voice',
      [
        columns(a.chapters.map((c, i) => ({ label: chNo[i], value: c.sentences ? c.passive / c.sentences : 0, tip: chTip(i, pct(c.sentences ? c.passive / c.sentences : 0, 1)) })), { fmt: (n) => pct(n, 0), ref: { value: 0.1, label: '10%' } }),
        a.passive.examples.length > 0 && sub('Examples'),
        examples(a.passive.examples, titles)
      ],
      `<b>${num(a.passive.count)}</b> sentences (${pct(a.passive.share)}) look passive; ${num(a.passive.withAgent)} name who did it (“by…”). This is a pattern match, so it has false positives and misses. Passive is not wrong; it suits moments where the doer is unknown or unimportant.`
    )
  );

  // filler
  const groupHeat = a.wordGroups.map((g) => g.title);
  add(
    'filler',
    'Filler and filter words',
    section(
      'filler-in',
      'Filler, filter and crutch words',
      [
        ...a.wordGroups.map((g) => sub(g.title) + `<p class="intro">${esc(g.hint)} <b>${num(g.total)}</b> in all (${num(g.per1000, 1)} per 1,000 words).</p>` + (g.items.length ? hbars(g.items.slice(0, 18).map((x) => ({ label: x.label, value: x.count, text: `${num(x.count)} · ${num(x.per1000, 1)}/1k` })), { labelWidth: 130 }) : '<p class="note">None found.</p>')),
        sub('The word “that”'),
        `<p class="intro">Appears <b>${num(a.that.total)}</b> times (${num(a.that.per1000, 1)} per 1,000 words). About <b>${num(a.that.optional)}</b> follow a verb like “knew”, “said” or “felt” and could probably go (“She knew that he was lying” → “She knew he was lying”).</p>`,
        examples(a.that.examples, titles),
        a.chapters.length > 1 && sub('By chapter, per 1,000 words'),
        a.chapters.length > 1 &&
          heat(
            [
              { label: groupHeat[0] ?? 'Filler', cells: a.chapters.map((c) => perK(c.filler, c.words)), tip: (i, v) => chTip(i, `${num(v, 1)} filler words per 1,000`) },
              { label: groupHeat[1] ?? 'Filter', cells: a.chapters.map((c) => perK(c.crutch, c.words)), tip: (i, v) => chTip(i, `${num(v, 1)} filter words per 1,000`) }
            ],
            chNo
          )
      ],
      'Counted wherever they appear. Characters can say “just” and “really” naturally; narration is where they weaken the prose.'
    )
  );

  // POV
  const P = a.pov.first + a.pov.second + a.pov.third;
  add(
    'pov',
    'Point of view',
    section(
      'pov-in',
      'Point of view and tense',
      [
        P >= 20 &&
          stacked([
            { label: 'First person (I, we)', value: a.pov.first, cls: 'c1', text: num(a.pov.first) },
            { label: 'Second (you)', value: a.pov.second, cls: 'c3', text: num(a.pov.second) },
            { label: 'Third (he, she, they)', value: a.pov.third, cls: 'c2', text: num(a.pov.third) }
          ]),
        sub('Chapter by chapter'),
        table(
          ['#', 'Chapter', 'Person', 'Tense', 'Whose thoughts are reported', 'Scenes'],
          a.chapters.map((c, i) => {
            const tense = c.tenseMarkers < 8 ? '–' : c.presentShare > 0.7 ? 'present' : c.presentShare < 0.3 ? 'past' : 'mixed';
            const bad = (x: string, base: string) => (x !== '–' && base !== 'unclear' && x !== base ? `<span class="pill warn">${esc(x)}</span>` : esc(x));
            return [i + 1, esc(c.title), bad(c.person === 'unclear' ? '–' : c.person, a.pov.person), bad(tense, a.pov.tense), c.povCharacters.length ? c.povCharacters.map((x) => `${esc(x.name)} (${x.count})`).join(', ') : '–', c.scenes];
          }),
          ['r', 'l', 'l', 'l', 'l', 'r'],
          true
        ),
        sub('Consistency checks'),
        a.pov.personFlags.length ? `<p class="note">Person</p>${flags(a.pov.personFlags)}` : '<p>No chapter breaks the book’s point of view.</p>',
        a.pov.tenseFlags.length ? `<p class="note">Tense</p>${flags(a.pov.tenseFlags)}` : '<p>No chapter drifts from the book’s main tense.</p>',
        a.pov.person === 'third' && (a.pov.headHopping.length ? `<p class="note">Possible head-hopping: more than one character’s thoughts or feelings reported in one scene</p>${flags(a.pov.headHopping)}` : '<p>No scene shows more than one character’s thoughts or feelings.</p>'),
        a.pov.slips.length > 0 && `<p class="note">Paragraphs whose narration uses the wrong person</p>${examples(a.pov.slips, titles)}`,
        a.pov.tenseSlips.length > 0 && `<p class="note">Paragraphs that look like a slip into another tense</p>${examples(a.pov.tenseSlips, titles)}`
      ],
      P < 20 ? 'There is too little narration to judge the point of view.' : `The narration reads as <b>${esc(a.pov.person)} person, ${esc(a.pov.tense)} tense</b>. Pronouns are counted in narration only, not in speech or italic thoughts.`
    )
  );

  // characters
  if (a.characters.length) {
    const shown = a.characters.slice(0, 15);
    add(
      'characters',
      'Characters',
      section(
        'characters-in',
        'Characters',
        [
          hbars(shown.map((c) => ({ label: c.name, value: c.mentions, text: `${num(c.mentions)}`, tip: `${c.name}: ${num(c.mentions)} mentions, ${c.chapters} chapters` })), { labelWidth: 150 }),
          sub('Who appears where'),
          heat(shown.map((c) => ({ label: c.name, cells: c.perChapter, tip: (i, v) => `${c.name} · ${i + 1}. ${titles[i]}: ${num(v)} mentions` })), chNo),
          sub('Details'),
          table(
            ['Character', 'Mentions', 'Per 1,000', 'Chapters', 'First appears', 'Lines tagged', 'Also called'],
            shown.map((c) => [esc(c.name), num(c.mentions), num((c.mentions / t.words) * 1000, 1), `${c.chapters} of ${a.chapters.length}`, c.firstChapter >= 0 ? esc(`${c.firstChapter + 1}. ${titles[c.firstChapter]}`) : '–', num(c.speaks), esc(c.aliases.join(', '))]),
            ['l', 'r', 'r', 'r', 'l', 'r', 'l'],
            true
          )
        ],
        'Names are found automatically (capitalised words that are rarely seen in lower case), so check the list: a place can appear here, and a character only ever called by a title may not.'
      )
    );
  }

  // punctuation
  add(
    'punctuation',
    'Punctuation',
    section('punctuation-in', 'Punctuation habits', [hbars(a.punctuation.map((p) => ({ label: p.label, value: p.per1000, text: `${num(p.per1000, 1)}/1k · ${num(p.count)}` })), { labelWidth: 190 })], 'Per 1,000 words.')
  );

  body.push(
    `<footer class="method card"><h2>How this was measured</h2><ul><li><b>Prose only.</b> Headings, scene breaks, comments, code and tables are ignored. Sentences end at . ! ? or … (not after “Mr.” and the like).</li><li><b>Dialogue</b> is whatever sits inside quotation marks, followed across paragraph breaks.</li><li><b>Reading level</b> averages the Flesch–Kincaid, Gunning Fog, Coleman–Liau and ARI grade formulas (plus SMOG when there are enough sentences). Syllables are estimated.</li><li><b>Passive voice</b> is a form of “to be” plus a past participle; states like “was tired” are not counted.</li><li><b>Point of view</b> counts pronouns in narration only; tense compares was/were/had/did with is/are/am/has/does. <b>Head-hopping</b> flags scenes where two named characters each have several “thought / felt / knew” verbs.</li><li><b>Characters</b> are capitalised words rarely seen in lower case; “Mara Voss” is merged with “Mara” and “Voss”.</li></ul></footer>`
  );
  return page(opts, body, nav);
}

function page(opts: HtmlOptions, body: string[], nav: [string, string][]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Text analysis: ${esc(opts.source)}</title><style>${CSS}</style></head><body><div class="wrap"><header class="top"><h1>Text analysis</h1><p>${esc(opts.source)} · generated ${esc(opts.generated)}</p></header>${nav.length ? `<nav class="toc" aria-label="Sections">${nav.map(([id, title]) => `<a href="#${id}">${esc(title)}</a>`).join('')}</nav>` : ''}${body.join('')}</div></body></html>`;
}
