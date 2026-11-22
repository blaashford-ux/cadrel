/**
 * The Editing Report: what an editor hands the author after a pass. Part of it writes itself from the notes (counts, themes, what is still open,
 * where the notes cluster), part comes from a text analysis attached to it, and part is typed by the editor. The automatic part is recomputed from
 * the notes whenever the report is opened, so it is always current; what the editor typed is kept as it was written.
 *
 * Pure: notes and chapters in, statistics, Markdown and a printable HTML page out. The desk stores the typed part with the manuscript.
 */
import { findings, type Finding } from '../analysis/report';
import type { Analysis } from '../analysis/analyze';
import { EDIT_TYPES, type ItemStatus, type ReviewItem } from './comments';

export const REPORT_VERSION = 1;
export const REPORT_SECTIONS_MAX = 30;
export const REPORT_TEXT_MAX = 20000;

export interface AnalysisSummary {
  /** The day it was made, `YYYY-MM-DD`. */
  generated: string;
  words: number;
  sentences: number;
  readingGrade: number;
  averageSentence: number;
  dialogueShare: number;
  adverbsPer1000: number;
  passiveShare: number;
  findings: Finding[];
}

export interface ReportSection {
  id: string;
  title: string;
  /** Plain paragraphs separated by blank lines; lines starting with "- " are a list. */
  body: string;
}

/** What is stored: the part the editor typed or attached. The numbers are not stored; they are worked out from the notes. */
export interface ReportData {
  version: number;
  manuscript: string;
  editor: string;
  /** The round this report is for ("First read"); the numbers count only that round's notes when it is set. */
  round?: string;
  /** The editor's own summary, if they wrote one; absent means the automatic summary is shown. */
  summary?: string;
  sections: ReportSection[];
  analysis?: AnalysisSummary;
  updatedAt: string;
}

export function emptyReport(manuscript: string, editor: string, now: string): ReportData {
  return { version: REPORT_VERSION, manuscript, editor, sections: [], updatedAt: now };
}

/** The analysis boiled down to what a report shows. */
export function summarizeAnalysis(a: Analysis, generated: string): AnalysisSummary {
  const words = a.totals.words;
  return {
    generated,
    words,
    sentences: a.totals.sentences,
    readingGrade: a.readability.grade,
    averageSentence: a.sentenceLengths.average,
    dialogueShare: words ? a.totals.dialogueWords / words : 0,
    adverbsPer1000: a.adverbs.per1000,
    passiveShare: a.passive.share,
    findings: findings(a)
  };
}

export interface NoteStats {
  total: number;
  byStatus: Record<'open' | 'accepted' | 'rejected' | 'resolved', number>;
  byKind: { comment: number; suggestion: number };
  byEditType: Record<string, number>;
  byRound: Record<string, number>;
  bySource: { human: number; ai: number; outside: number };
  suggestions: { open: number; accepted: number; rejected: number };
  /** Topics, most used first, each with what the notes under it say. */
  themes: { topic: string; count: number; examples: string[] }[];
  perChapter: { index: number; title: string; count: number; open: number }[];
  open: { chapter: number; chapterTitle: string; kind: 'comment' | 'suggestion'; editType?: string; quote: string; body: string }[];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The numbers of a report. `chapterOf` says which chapter each note is on (notes it does not list are left out, as those are on other files).
 * With `round`, only that round's notes are counted.
 */
export function computeStats(items: readonly ReviewItem[], chapters: readonly { title: string }[], chapterOf: ReadonlyMap<string, number>, round?: string): NoteStats {
  const live = items.filter((i) => i.status !== 'deleted' && chapterOf.has(i.id) && (!round || (i.round ?? '').toLowerCase() === round.toLowerCase()));
  const s: NoteStats = {
    total: live.length,
    byStatus: { open: 0, accepted: 0, rejected: 0, resolved: 0 },
    byKind: { comment: 0, suggestion: 0 },
    byEditType: {},
    byRound: {},
    bySource: { human: 0, ai: 0, outside: 0 },
    suggestions: { open: 0, accepted: 0, rejected: 0 },
    themes: [],
    perChapter: chapters.map((c, index) => ({ index, title: c.title, count: 0, open: 0 })),
    open: []
  };
  const topics = new Map<string, { count: number; examples: string[] }>();
  for (const i of live) {
    const st = i.status as Exclude<ItemStatus, 'deleted'>;
    s.byStatus[st]++;
    s.byKind[i.kind]++;
    const type = i.editType ?? 'untagged';
    s.byEditType[type] = (s.byEditType[type] ?? 0) + 1;
    const round = i.round ?? 'No round';
    s.byRound[round] = (s.byRound[round] ?? 0) + 1;
    s.bySource[i.origin === 'ai' ? 'ai' : i.origin === 'outside' ? 'outside' : 'human']++;
    if (i.kind === 'suggestion') {
      if (st === 'open') s.suggestions.open++;
      else if (st === 'accepted') s.suggestions.accepted++;
      else if (st === 'rejected') s.suggestions.rejected++;
    }
    const ch = chapterOf.get(i.id)!;
    const pc = s.perChapter[ch];
    if (pc) {
      pc.count++;
      if (st === 'open') pc.open++;
    }
    const topic = i.category ?? (i.editType ? `${i.editType} edit` : 'general');
    const t = topics.get(topic) ?? { count: 0, examples: [] };
    t.count++;
    const text = oneLine(i.body || (i.replacement !== undefined ? `“${i.anchor.quote}” → “${i.replacement}”` : i.anchor.quote));
    if (t.examples.length < 2 && text) t.examples.push(clip(text, 140));
    topics.set(topic, t);
    if (st === 'open' && s.open.length < 60) s.open.push({ chapter: ch, chapterTitle: chapters[ch]?.title ?? '', kind: i.kind, ...(i.editType ? { editType: i.editType } : {}), quote: clip(oneLine(i.anchor.quote), 90), body: clip(oneLine(i.body), 200) });
  }
  s.themes = [...topics.entries()].map(([topic, v]) => ({ topic, ...v })).sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)).slice(0, 8);
  s.open.sort((a, b) => a.chapter - b.chapter);
  return s;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** The summary the report opens with when the editor has not written one. */
export function autoSummary(stats: NoteStats, data: Pick<ReportData, 'manuscript' | 'round'>): string {
  if (!stats.total) return `There are no notes on ${data.manuscript}${data.round ? ` in ${data.round}` : ''} yet.`;
  const parts: string[] = [];
  parts.push(`${plural(stats.total, 'note')} on ${data.manuscript}${data.round ? ` in ${data.round}` : ''}: ${plural(stats.byKind.comment, 'comment')} and ${plural(stats.byKind.suggestion, 'suggestion')}.`);
  const done = stats.byStatus.accepted + stats.byStatus.rejected + stats.byStatus.resolved;
  parts.push(`${done} of ${stats.total} are dealt with (${stats.byStatus.accepted} accepted, ${stats.byStatus.rejected} rejected, ${stats.byStatus.resolved} resolved) and ${stats.byStatus.open} are still open.`);
  if (stats.suggestions.accepted + stats.suggestions.rejected) {
    const decided = stats.suggestions.accepted + stats.suggestions.rejected;
    parts.push(`Of the ${decided} suggestions decided, ${Math.round((stats.suggestions.accepted / decided) * 100)}% were accepted.`);
  }
  const top = stats.themes[0];
  if (top) parts.push(`The most common topic is ${top.topic} (${plural(top.count, 'note')}).`);
  const busiest = [...stats.perChapter].sort((a, b) => b.count - a.count)[0];
  if (busiest && busiest.count > 0 && stats.perChapter.length > 1) parts.push(`Most notes fall in “${busiest.title || `chapter ${busiest.index + 1}`}” (${busiest.count}).`);
  return parts.join(' ');
}

// ---- Markdown -------------------------------------------------------------------------------------------------------------------

const TYPE_LABEL: Record<string, string> = { developmental: 'Developmental', line: 'Line', copy: 'Copy', proof: 'Proof', untagged: 'Untagged' };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (x: number, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toString();

/** The report as Markdown (what is kept beside the manuscript, and what an assistant reads). */
export function renderReportMarkdown(data: ReportData, stats: NoteStats): string {
  const out: string[] = [`# Editing Report: ${data.manuscript}`, ''];
  out.push(`Editor: ${data.editor || 'not named'}${data.round ? ` · ${data.round}` : ''} · Updated ${data.updatedAt.slice(0, 10)}`, '');
  out.push('## Summary', '', data.summary?.trim() || autoSummary(stats, data), '');
  for (const sec of data.sections) out.push(`## ${sec.title}`, '', sec.body.trim(), '');
  out.push('## The notes in numbers', '');
  out.push(`- Open ${stats.byStatus.open} · Accepted ${stats.byStatus.accepted} · Rejected ${stats.byStatus.rejected} · Resolved ${stats.byStatus.resolved}`);
  out.push(`- Comments ${stats.byKind.comment} · Suggestions ${stats.byKind.suggestion}`);
  const types = Object.entries(stats.byEditType).map(([k, v]) => `${TYPE_LABEL[k] ?? k} ${v}`);
  if (types.length) out.push(`- By edit type: ${types.join(' · ')}`);
  out.push(`- By source: Editor ${stats.bySource.human} · AI ${stats.bySource.ai} · Outside editor ${stats.bySource.outside}`);
  const rounds = Object.entries(stats.byRound).map(([k, v]) => `${k} ${v}`);
  if (rounds.length > 1 || (rounds.length === 1 && rounds[0] !== `No round ${stats.total}`)) out.push(`- By round: ${rounds.join(' · ')}`);
  out.push('');
  if (stats.themes.length) {
    out.push('## Themes in the feedback', '');
    for (const t of stats.themes) out.push(`- **${t.topic}** (${t.count})${t.examples.length ? `: ${t.examples.join(' / ')}` : ''}`);
    out.push('');
  }
  if (stats.perChapter.some((c) => c.count)) {
    out.push('## Notes by chapter', '');
    for (const c of stats.perChapter) if (c.count) out.push(`- ${c.title || `Chapter ${c.index + 1}`}: ${c.count} (${c.open} open)`);
    out.push('');
  }
  if (data.analysis) {
    const a = data.analysis;
    out.push(`## Text analysis (${a.generated})`, '');
    out.push(`- ${num(a.words, 0)} words in ${num(a.sentences, 0)} sentences; reading grade ${num(a.readingGrade)}; sentences average ${num(a.averageSentence)} words`);
    out.push(`- Dialogue ${pct(a.dialogueShare)} · Adverbs ${num(a.adverbsPer1000)} per 1,000 words · Passive sentences ${pct(a.passiveShare)}`);
    for (const f of a.findings) out.push(`- ${f.level === 'look' ? 'Worth a look: ' : ''}${f.text}`);
    out.push('');
  }
  if (stats.open.length) {
    out.push('## Still open', '');
    for (const o of stats.open) out.push(`- ${o.chapterTitle || `Chapter ${o.chapter + 1}`} · ${o.kind}${o.editType ? ` · ${o.editType}` : ''}: “${o.quote}”${o.body ? ` — ${o.body}` : ''}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** The stored part of a report rides at the end of its Markdown file, so the file can be read as text and still be edited back in. */
const EMBED = /\n?<!-- cadrel-editing-report ([\s\S]*?) -->\s*$/;

export function embedReport(markdown: string, data: ReportData): string {
  return `${markdown.replace(EMBED, '').trimEnd()}\n\n<!-- cadrel-editing-report ${JSON.stringify(data).replace(/--/g, '\\u002d\\u002d')} -->\n`;
}

/** The stored part of a report, or null when the text has none or it is damaged. */
export function extractReport(text: string): ReportData | null {
  const m = EMBED.exec(text);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]!) as Partial<ReportData>;
    if (!d || d.version !== REPORT_VERSION || typeof d.manuscript !== 'string' || !Array.isArray(d.sections)) return null;
    return {
      version: REPORT_VERSION,
      manuscript: d.manuscript,
      editor: typeof d.editor === 'string' ? d.editor : '',
      ...(typeof d.round === 'string' && d.round ? { round: d.round } : {}),
      ...(typeof d.summary === 'string' && d.summary ? { summary: d.summary.slice(0, REPORT_TEXT_MAX) } : {}),
      sections: d.sections
        .filter((s): s is ReportSection => !!s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.body === 'string')
        .slice(0, REPORT_SECTIONS_MAX)
        .map((s) => ({ id: s.id, title: s.title.slice(0, 120), body: s.body.slice(0, REPORT_TEXT_MAX) })),
      ...(d.analysis && typeof d.analysis === 'object' ? { analysis: d.analysis as AnalysisSummary } : {}),
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : ''
    };
  } catch {
    return null;
  }
}

// ---- HTML (for the PDF) ---------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain paragraphs and "- " lists as HTML. */
function bodyHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(esc).join('<br>')}</p>`;
    })
    .join('');
}

function bars(rows: { label: string; value: number }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="bars">${rows.map((r) => `<div class="bar"><span class="bl">${esc(r.label)}</span><span class="bt"><i style="width:${Math.round((r.value / max) * 100)}%"></i></span><span class="bv">${r.value}</span></div>`).join('')}</div>`;
}

/** A self-contained, print-ready page: a cover block, the summary, the typed sections, the numbers and the analysis. */
export function renderReportHtml(data: ReportData, stats: NoteStats): string {
  const h: string[] = [];
  h.push(`<header class="cover"><p class="kicker">Editing Report</p><h1>${esc(data.manuscript)}</h1><p class="meta">${esc(data.editor || 'Editor')}${data.round ? ` · ${esc(data.round)}` : ''} · ${esc(data.updatedAt.slice(0, 10))}</p></header>`);
  h.push(`<h2>Summary</h2>${bodyHtml(data.summary?.trim() || autoSummary(stats, data))}`);
  for (const sec of data.sections) h.push(`<h2>${esc(sec.title)}</h2>${bodyHtml(sec.body)}`);
  h.push('<h2>The notes in numbers</h2>');
  h.push(`<div class="tiles"><div><b>${stats.total}</b><span>notes</span></div><div><b>${stats.byStatus.open}</b><span>open</span></div><div><b>${stats.byStatus.accepted}</b><span>accepted</span></div><div><b>${stats.byStatus.rejected}</b><span>rejected</span></div><div><b>${stats.byStatus.resolved}</b><span>resolved</span></div></div>`);
  const types = EDIT_TYPES.map((t) => ({ label: TYPE_LABEL[t]!, value: stats.byEditType[t] ?? 0 }));
  if (stats.byEditType['untagged']) types.push({ label: 'Untagged', value: stats.byEditType['untagged'] });
  h.push('<h3>By edit type</h3>', bars(types));
  h.push('<h3>By source</h3>', bars([{ label: 'Editor', value: stats.bySource.human }, { label: 'AI', value: stats.bySource.ai }, { label: 'Outside editor', value: stats.bySource.outside }]));
  if (Object.keys(stats.byRound).length > 1) h.push('<h3>By round</h3>', bars(Object.entries(stats.byRound).map(([label, value]) => ({ label, value }))));
  if (stats.themes.length) h.push('<h2>Themes in the feedback</h2><ul>' + stats.themes.map((t) => `<li><b>${esc(t.topic)}</b> (${t.count})${t.examples.length ? `<br><span class="ex">${esc(t.examples.join(' / '))}</span>` : ''}</li>`).join('') + '</ul>');
  if (stats.perChapter.some((c) => c.count)) h.push('<h2>Notes by chapter</h2>', bars(stats.perChapter.filter((c) => c.count).map((c) => ({ label: c.title || `Chapter ${c.index + 1}`, value: c.count }))));
  if (data.analysis) {
    const a = data.analysis;
    h.push(`<h2>Text analysis <small>${esc(a.generated)}</small></h2>`);
    h.push(`<div class="tiles"><div><b>${num(a.words, 0)}</b><span>words</span></div><div><b>${num(a.readingGrade)}</b><span>reading grade</span></div><div><b>${num(a.averageSentence)}</b><span>words per sentence</span></div><div><b>${pct(a.dialogueShare)}</b><span>dialogue</span></div><div><b>${num(a.adverbsPer1000)}</b><span>adverbs per 1,000</span></div><div><b>${pct(a.passiveShare)}</b><span>passive</span></div></div>`);
    if (a.findings.length) h.push('<ul>' + a.findings.map((f) => `<li>${f.level === 'look' ? '<b>Worth a look.</b> ' : ''}${esc(f.text)}</li>`).join('') + '</ul>');
  }
  if (stats.open.length) h.push('<h2>Still open</h2><ul class="open">' + stats.open.map((o) => `<li><b>${esc(o.chapterTitle || `Chapter ${o.chapter + 1}`)}</b> · ${o.kind}${o.editType ? ` · ${esc(o.editType)}` : ''}<br>“${esc(o.quote)}”${o.body ? `<br><span class="ex">${esc(o.body)}</span>` : ''}</li>`).join('') + '</ul>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Editing Report: ${esc(data.manuscript)}</title><style>${CSS}</style></head><body>${h.join('\n')}</body></html>`;
}

const CSS = `
@page{margin:18mm}
*{box-sizing:border-box}
body{font:11pt/1.5 Georgia,'Times New Roman',serif;color:#1b1b1f;max-width:46em;margin:0 auto;padding:0}
h1,h2,h3,.kicker,.meta,.tiles,.bars,small{font-family:'Segoe UI',system-ui,sans-serif}
.cover{border-bottom:3px solid #3b4a6b;padding:0 0 12pt;margin:0 0 14pt}
.kicker{margin:0;text-transform:uppercase;letter-spacing:.12em;font-size:9pt;color:#3b4a6b}
h1{margin:4pt 0;font-size:24pt}
.meta{margin:0;color:#555;font-size:10pt}
h2{font-size:14pt;margin:18pt 0 6pt;border-bottom:1px solid #ccd;padding-bottom:2pt;break-after:avoid}
h3{font-size:11pt;margin:10pt 0 4pt;color:#3b4a6b;break-after:avoid}
h2 small{font-weight:400;color:#666;font-size:9pt}
p{margin:0 0 7pt}
ul{margin:0 0 8pt;padding-left:1.3em}li{margin:0 0 4pt;break-inside:avoid}
.ex{color:#555;font-size:10pt}
.tiles{display:flex;flex-wrap:wrap;gap:8pt;margin:4pt 0 8pt}
.tiles div{flex:1 1 70pt;border:1px solid #ccd;border-radius:4pt;padding:6pt 8pt;text-align:center}
.tiles b{display:block;font-size:16pt}.tiles span{font-size:8.5pt;color:#555}
.bars{margin:0 0 8pt}.bar{display:flex;align-items:center;gap:6pt;margin:2pt 0;font-size:9.5pt;break-inside:avoid}
.bl{flex:0 0 8.5em}.bt{flex:1;background:#eceef4;height:8pt;border-radius:4pt;overflow:hidden}.bt i{display:block;height:100%;background:#3b4a6b}.bv{flex:0 0 2.5em;text-align:right}
@media print{body{max-width:none}}
`;
