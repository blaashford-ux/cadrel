/**
 * A manuscript with its notes as a Word (.docx) file, for an author who works in Word: every comment is a real Word comment on the text it is about,
 * and every suggestion is a tracked change (the quoted text deleted, the replacement inserted, both by the note's author) with the reason as a
 * comment beside it. Bold and italic are kept; the author accepts or rejects each change in Word.
 *
 * Pure: chapters and notes in, bytes out. Notes are located with `locateAnchor`, the way the app does, so one whose text has moved is still found
 * and one whose text is gone is left out (and counted).
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { CommentRangeEnd, CommentRangeStart, CommentReference, DeletedTextRun, Document, HeadingLevel, InsertedTextRun, Packer, Paragraph, TextRun, type ParagraphChild } from 'docx';
import { stripFences } from '../align';
import { locateAnchor, type ReviewItem } from './comments';

export interface ReviewChapter {
  title: string;
  markdown: string;
}

export interface ReviewDocxInput {
  title: string;
  chapters: ReviewChapter[];
  /** The notes to put in: those on this manuscript and still open. The caller chooses; this does not filter. */
  notes: ReviewItem[];
  /** The index of the chapter each note is on, by note id (so one quote that repeats in two chapters lands in the right one). */
  chapterOf: ReadonlyMap<string, number>;
}

export interface ReviewDocxResult {
  bytes: Uint8Array;
  /** Notes that went in, and those that could not be placed (their text was changed or cut). */
  placed: number;
  skipped: number;
}

interface Seg {
  text: string;
  bold?: boolean;
  italics?: boolean;
}
interface Blk {
  heading: boolean;
  segs: Seg[];
}
type Node = { type: string; value?: string; depth?: number; children?: Node[] };

/** The text blocks of a chapter, in the order `flattenMarkdown` joins them, each with its bold and italic runs. */
function blocksOf(markdown: string): Blk[] {
  const tree = fromMarkdown(stripFences(markdown.replace(/^﻿/, '')), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as Node;
  const out: Blk[] = [];
  const runs = (n: Node, st: { bold?: boolean; italics?: boolean }, acc: Seg[]) => {
    if (n.type === 'text' || n.type === 'inlineCode') acc.push({ text: n.value ?? '', ...st });
    else if (n.type === 'break' || n.type === 'image' || n.type === 'imageReference') acc.push({ text: '￼', ...st });
    else for (const c of n.children ?? []) runs(c, n.type === 'strong' ? { ...st, bold: true } : n.type === 'emphasis' ? { ...st, italics: true } : st, acc);
  };
  const walk = (n: Node) => {
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'tableCell') {
      const segs: Seg[] = [];
      runs(n, {}, segs);
      out.push({ heading: n.type === 'heading', segs });
    } else if (n.type === 'code') out.push({ heading: false, segs: [{ text: n.value ?? '' }] });
    else for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

interface Placed {
  item: ReviewItem;
  block: number;
  from: number;
  to: number;
  id: number;
}

export async function buildReviewDocx(input: ReviewDocxInput): Promise<ReviewDocxResult> {
  const comments: { id: number; author: string; date: Date; children: Paragraph[] }[] = [];
  let nextId = 1;
  let placed = 0;
  let skipped = 0;
  const body: Paragraph[] = [];

  input.chapters.forEach((ch, ci) => {
    const blocks = blocksOf(ch.markdown);
    const flat = blocks.map((b) => b.segs.map((s) => s.text).join(''));
    const starts: number[] = [];
    let at = 0;
    for (const t of flat) {
      starts.push(at);
      at += t.length + 1;
    }
    const whole = flat.join('\n');
    // where each note is, as block and offsets in it; a note across blocks is cut at the end of its first block
    const here: Placed[] = [];
    for (const item of input.notes) {
      if (input.chapterOf.get(item.id) !== ci) continue;
      const loc = item.anchor.gone ? null : locateAnchor(whole, item.anchor);
      if (!loc) {
        skipped++;
        continue;
      }
      let b = starts.findIndex((s, i) => loc.start >= s && loc.start <= s + flat[i]!.length);
      if (b < 0) b = 0;
      const from = loc.start - starts[b]!;
      const to = Math.min(loc.end - starts[b]!, flat[b]!.length);
      if (to <= from) {
        skipped++;
        continue;
      }
      here.push({ item, block: b, from, to, id: 0 });
    }
    here.sort((x, y) => x.block - y.block || x.from - y.from);
    // notes that overlap an earlier one cannot be drawn in the same text; they are left out and counted
    const kept: Placed[] = [];
    for (const p of here) {
      const last = kept[kept.length - 1];
      if (last && last.block === p.block && p.from < last.to) skipped++;
      else kept.push(p);
    }

    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(ch.title || 'Untitled')] }));
    blocks.forEach((blk, bi) => {
      if (blk.heading && bi === 0 && flat[0] === ch.title) return; // the chapter heading is the title above
      const mine = kept.filter((p) => p.block === bi);
      const children: ParagraphChild[] = [];
      let pos = 0;
      const plain = (text: string, from: number) => {
        // the runs of this block between `from` and `from + text.length`, with their bold and italic
        let o = 0;
        const out: TextRun[] = [];
        for (const s of blk.segs) {
          const a = Math.max(from, o);
          const z = Math.min(from + text.length, o + s.text.length);
          if (z > a) out.push(new TextRun({ text: s.text.slice(a - o, z - o), bold: s.bold, italics: s.italics }));
          o += s.text.length;
        }
        return out;
      };
      const author = (p: Placed) => p.item.author || 'Editor';
      const when = (p: Placed) => new Date(p.item.createdAt || Date.now());
      for (const p of mine) {
        children.push(...plain(flat[bi]!.slice(pos, p.from), pos));
        p.id = nextId++;
        const quote = flat[bi]!.slice(p.from, p.to);
        const who = author(p);
        const date = when(p);
        children.push(new CommentRangeStart(p.id));
        if (p.item.kind === 'suggestion') {
          // the change is tracked; the reason (if any) is the comment beside it
          children.push(new DeletedTextRun({ text: quote, id: 1000 + p.id * 2, author: who, date: date.toISOString() }));
          if (p.item.replacement) children.push(new InsertedTextRun({ text: p.item.replacement, id: 1001 + p.id * 2, author: who, date: date.toISOString() }));
        } else children.push(...plain(quote, p.from));
        children.push(new CommentRangeEnd(p.id), new TextRun({ children: [new CommentReference(p.id)] }));
        const head = [p.item.editType, p.item.category].filter(Boolean).join(' · ');
        const text = [head ? `[${head}]` : '', p.item.body, ...p.item.replies.map((r) => `${r.author}: ${r.body}`)].filter(Boolean).join('\n') || (p.item.kind === 'suggestion' ? 'Suggested change.' : '');
        comments.push({ id: p.id, author: who, date, children: text.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] })) });
        placed++;
        pos = p.to;
      }
      children.push(...plain(flat[bi]!.slice(pos), pos));
      body.push(new Paragraph({ heading: blk.heading ? HeadingLevel.HEADING_2 : undefined, children }));
    });
  });

  const doc = new Document({
    creator: 'Cadrel',
    title: input.title,
    comments: { children: comments },
    sections: [{ children: body }]
  });
  return { bytes: new Uint8Array(await Packer.toBuffer(doc)), placed, skipped };
}
