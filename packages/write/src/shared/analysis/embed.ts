import type { Analysis } from './analyze';

export interface ReportMeta {
  source: string;
  generated: string;
}

const MARK = 'mdedit-analysis v1';
const RE = /<!-- mdedit-analysis v1 (\{.*\}) -->/;

/**
 * The analysis results as a one-line HTML comment for the end of the Markdown report. The report viewer reads it back,
 * so the Markdown stays the only file (it syncs and edits like any other). `<`, `>` and `--` are escaped so the
 * comment is always well formed, and being a single tag-shaped line it adds nothing to the word count.
 */
export function embedAnalysis(a: Analysis, meta: ReportMeta): string {
  const json = JSON.stringify({ meta, analysis: a })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/--/g, '-\\u002d');
  return `\n<!-- ${MARK} ${json} -->\n`;
}

/** The analysis stored in a report, or null for any other text. */
export function extractAnalysis(text: string): { meta: ReportMeta; analysis: Analysis } | null {
  if (!text.includes(MARK)) return null;
  const m = RE.exec(text);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    const a = data?.analysis;
    if (!a || !Array.isArray(a.chapters) || !a.totals || typeof a.totals.words !== 'number' || !a.readability || !a.sentenceLengths) return null;
    return { meta: { source: String(data.meta?.source ?? ''), generated: String(data.meta?.generated ?? '') }, analysis: a as Analysis };
  } catch {
    return null;
  }
}
