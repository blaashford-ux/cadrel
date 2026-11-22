/**
 * Reads the tracked changes and comments of a Word (.docx) file, for an outside editor's work to come into Cadrel as notes.
 *
 * The manuscript that is made from the file is the text *before* the editor's changes (their insertions left out, their deletions kept), so
 * every change is a note on text that is really in the manuscript, which the author can accept or reject:
 *   - a deletion, or a deletion with an insertion in its place, becomes a suggestion (the quote and what replaces it);
 *   - an insertion becomes a suggestion that replaces the words just before it with those words and the insertion;
 *   - a Word comment becomes a comment on the text it covers.
 * Pure: bytes in, text and changes out.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { docxToMarkdown, kid, kids, parseXml, type XNode } from './importDocx';

export interface TrackedNote {
  kind: 'comment' | 'suggestion';
  /** The text the note is about, as it is in the original. */
  quote: string;
  /** Suggestions: what replaces the quote (empty means delete). */
  replacement?: string;
  /** Comments: what the editor wrote. Suggestions: a one-line description of the change. */
  body: string;
  /** A little of the paragraph either side of the quote, to find the right place when the quote is repeated. */
  before: string;
  after: string;
  /** Who made the change in Word, and when (ISO), when the file says. */
  author: string;
  date?: string;
}

export interface TrackedImport {
  /** The Markdown of the original: the document with the editor's changes taken out. */
  markdown: string;
  notes: TrackedNote[];
  /** How many tracked changes and comments were found in all (notes may be fewer: a change with nothing to anchor to is not made a note). */
  found: number;
}

const CONTEXT = 40;
/** The words kept as the quote for an insertion, at most. */
const INSERT_QUOTE_MAX = 40;

const INS_OPEN = /<w:(ins|moveTo)\b(?=[\s>/])[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)/g;

/** The document.xml of the original: insertions (and moved-to text) removed, deletions (and moved-from text) turned back into text. */
function originalXml(xml: string): string {
  return xml
    .replace(INS_OPEN, '')
    .replace(/<w:(?:del|moveFrom)\b(?=[\s>/])[^>]*\/>/g, '')
    .replace(/<\/?w:(?:del|moveFrom)\b(?=[\s>/])[^>]*>/g, '')
    .replace(/<(\/?)w:delText\b/g, '<$1w:t');
}

interface Event {
  at: number;
  kind: 'ins' | 'del' | 'cstart' | 'cend';
  text?: string;
  author?: string;
  date?: string;
  id?: string;
}

/** One paragraph read for its original text and what happened where. `text` is the original; offsets index into it. */
function readParagraph(p: XNode): { text: string; events: Event[] } {
  let text = '';
  const events: Event[] = [];
  const walk = (n: XNode, ctx: { ins?: { author: string; date?: string }; del?: { author: string; date?: string } }) => {
    for (const c of n.children) {
      if (c.name === 'w:ins' || c.name === 'w:moveTo') {
        const info = { author: c.attrs['w:author'] ?? '', date: c.attrs['w:date'] };
        const start = text.length;
        let inserted = '';
        const collect = (m: XNode) => {
          for (const r of m.children) {
            if (r.name === 'w:t') inserted += r.text;
            else if (r.name === 'w:tab') inserted += ' ';
            else collect(r);
          }
        };
        collect(c);
        if (inserted) events.push({ at: start, kind: 'ins', text: inserted, ...info });
      } else if (c.name === 'w:del' || c.name === 'w:moveFrom') {
        const info = { author: c.attrs['w:author'] ?? '', date: c.attrs['w:date'] };
        const start = text.length;
        const collect = (m: XNode) => {
          for (const r of m.children) {
            if (r.name === 'w:delText' || r.name === 'w:t') text += r.text;
            else if (r.name === 'w:tab') text += ' ';
            else collect(r);
          }
        };
        collect(c);
        if (text.length > start) events.push({ at: start, kind: 'del', text: text.slice(start), ...info });
      } else if (c.name === 'w:r') {
        for (const t of c.children) {
          if (t.name === 'w:t') text += t.text;
          else if (t.name === 'w:tab') text += ' ';
        }
      } else if (c.name === 'w:commentRangeStart') events.push({ at: text.length, kind: 'cstart', id: c.attrs['w:id'] });
      else if (c.name === 'w:commentRangeEnd') events.push({ at: text.length, kind: 'cend', id: c.attrs['w:id'] });
      else if (c.name === 'w:pPr' || c.name === 'w:rPr') continue;
      else walk(c, ctx);
    }
  };
  walk(p, {});
  return { text, events };
}

function paragraphs(n: XNode, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (c.name === 'w:p') out.push(c);
    else paragraphs(c, out);
  }
  return out;
}

const textOf = (n: XNode): string => (n.name === 'w:t' ? n.text : n.name === 'w:tab' ? ' ' : n.name === 'w:p' ? n.children.map(textOf).join('') + '\n' : n.children.map(textOf).join(''));

/** The comments of the file: id to who wrote it, when, and what it says. */
function readComments(xml: string | undefined): Map<string, { author: string; date?: string; text: string }> {
  const out = new Map<string, { author: string; date?: string; text: string }>();
  if (!xml) return out;
  const root = kid(parseXml(xml), 'w:comments');
  for (const c of kids(root, 'w:comment')) {
    const text = textOf(c).replace(/\s+/g, ' ').trim();
    out.set(c.attrs['w:id'], { author: c.attrs['w:author'] ?? '', date: c.attrs['w:date'], text });
  }
  return out;
}

const singleLine = (s: string) => s.replace(/\s+/g, ' ');

/** Reads a .docx for its original text and the editor's changes. Throws a plain sentence for a file that is not a .docx. */
export function importTracked(bytes: Uint8Array): TrackedImport {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('That file is not a valid .docx document.');
  }
  const docBytes = files['word/document.xml'];
  if (!docBytes) throw new Error('That file is not a valid .docx document.');
  const xml = strFromU8(docBytes);
  const comments = readComments(files['word/comments.xml'] ? strFromU8(files['word/comments.xml']) : undefined);

  // the manuscript is the original: the same file with the editor's insertions out and deletions back in
  const markdown = docxToMarkdown(zipSync({ ...files, 'word/document.xml': strToU8(originalXml(xml)) }));

  const body = kid(kid(parseXml(xml), 'w:document'), 'w:body');
  const notes: TrackedNote[] = [];
  let found = 0;
  for (const p of body ? paragraphs(body) : []) {
    const { text, events } = readParagraph(p);
    if (!events.length) continue;
    const around = (a: number, b: number) => ({ before: singleLine(text.slice(Math.max(0, a - CONTEXT), a)), after: singleLine(text.slice(b, b + CONTEXT)) });
    // a comment that covers a tracked change is that change's reason, not a note of its own
    const reasons = new Map<Event, string>();
    const covering = new Set<string>();
    const starts = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.kind === 'cstart' && e.id !== undefined) starts.set(e.id, i);
      else if (e.kind === 'cend' && e.id !== undefined && starts.has(e.id)) {
        const inside = events.slice(starts.get(e.id)! + 1, i).find((x) => x.kind === 'del' || x.kind === 'ins');
        const c = comments.get(e.id);
        if (inside && c) {
          covering.add(e.id);
          if (c.text) reasons.set(inside, c.text);
        }
      }
    });
    const open = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.kind === 'cstart' && e.id !== undefined) open.set(e.id, e.at);
      else if (e.kind === 'cend' && e.id !== undefined) {
        const c = comments.get(e.id);
        const from = open.get(e.id);
        open.delete(e.id);
        if (!c || from === undefined) continue;
        found++;
        if (covering.has(e.id)) continue;
        let a = from;
        let b = e.at;
        if (b <= a) {
          // a comment on a point: on the word before it
          a = Math.max(0, text.lastIndexOf(' ', Math.max(0, e.at - 2)) + 1);
          b = e.at;
        }
        const quote = text.slice(a, b);
        if (!quote.trim() || !c.text) continue;
        notes.push({ kind: 'comment', quote, body: c.text, ...around(a, b), author: c.author, ...(c.date ? { date: c.date } : {}) });
      } else if (e.kind === 'del') {
        found++;
        // a deletion with an insertion at the same place is one replacement
        const next = events[i + 1];
        const ins = next && next.kind === 'ins' && next.at === e.at + (e.text?.length ?? 0) ? next : events[i - 1]?.kind === 'ins' && events[i - 1]!.at === e.at ? events[i - 1] : undefined;
        if (ins && ins === next) i++;
        const quote = e.text ?? '';
        if (!quote.trim()) continue;
        const replacement = ins?.text ?? '';
        notes.push({
          kind: 'suggestion',
          quote,
          replacement,
          body: reasons.get(e) ?? reasons.get(ins as Event) ?? (replacement ? `Change “${singleLine(quote)}” to “${singleLine(replacement)}”.` : `Delete “${singleLine(quote)}”.`),
          ...around(e.at, e.at + quote.length),
          author: e.author ?? '',
          ...(e.date ? { date: e.date } : {})
        });
      } else if (e.kind === 'ins') {
        // an insertion that follows a deletion is part of that replacement (handled above)
        if (events[i - 1]?.kind === 'del' && events[i - 1]!.at + (events[i - 1]!.text?.length ?? 0) === e.at) continue;
        if (events[i + 1]?.kind === 'del' && events[i + 1]!.at === e.at) continue; // written before its deletion: still one replacement
        found++;
        const ins = e.text ?? '';
        if (!ins.trim()) continue;
        // the words just before it; at the start of a paragraph, the words just after
        let a = Math.max(0, e.at - INSERT_QUOTE_MAX);
        const cut = text.indexOf(' ', a);
        if (a > 0 && cut >= 0 && cut < e.at) a = cut + 1;
        let quote = text.slice(a, e.at);
        let replacement: string;
        let from = a;
        let to = e.at;
        if (quote.trim()) replacement = quote + ins;
        else {
          to = Math.min(text.length, e.at + INSERT_QUOTE_MAX);
          const stop = text.lastIndexOf(' ', to);
          if (to < text.length && stop > e.at) to = stop;
          from = e.at;
          quote = text.slice(from, to);
          if (!quote.trim()) continue; // nothing to anchor it to
          replacement = ins + quote;
        }
        notes.push({ kind: 'suggestion', quote, replacement, body: reasons.get(e) ?? `Insert “${singleLine(ins)}”.`, ...around(from, to), author: e.author ?? '', ...(e.date ? { date: e.date } : {}) });
      }
    }
  }
  return { markdown, notes, found };
}
