import type { DetailCapture } from '@cadrel/market-core';
import type { Db } from './schema.js';
import { chunkText, estimateTokens, hashText } from './text.js';

export type BlockKind = 'title' | 'blurb' | 'editorial_review' | 'about_author' | 'review';

/** Chunk kinds that come from page captures; manuscript and sample text are managed separately. */
const PAGE_KINDS_SQL = "kind NOT IN ('manuscript','sample_text')";

interface Block {
  kind: BlockKind;
  ordinal: number;
  body: string;
  meta?: Record<string, unknown>;
}

/** The pieces of a detail capture worth searching, as typed blocks. */
export function textBlocksOf(d: DetailCapture): Block[] {
  const out: Block[] = [];
  const authors = d.authors.map((a) => a.name).join(', ');
  const head = [d.title, d.series ? `${d.series.name} #${d.series.position}` : null, authors && `by ${authors}`].filter(Boolean).join(' — ');
  if (head) out.push({ kind: 'title', ordinal: 0, body: head });
  if (d.description) out.push({ kind: 'blurb', ordinal: 0, body: d.description });
  if (d.editorialReviews) out.push({ kind: 'editorial_review', ordinal: 0, body: d.editorialReviews });
  if (d.aboutAuthor) out.push({ kind: 'about_author', ordinal: 0, body: d.aboutAuthor });
  d.reviews.forEach((r, i) => {
    const body = [r.title, r.body].filter(Boolean).join('\n\n');
    if (body) out.push({ kind: 'review', ordinal: i, body, meta: { stars: r.stars, date: r.date, verified: r.verified } });
  });
  return out;
}

export function saveTextBlocks(db: Db, snapshotId: number, d: DetailCapture): void {
  const st = db.prepare('INSERT INTO text_block (snapshot_id, kind, ordinal, body, meta) VALUES (?,?,?,?,?)');
  for (const b of textBlocksOf(d)) st.run(snapshotId, b.kind, b.ordinal, b.body, b.meta ? JSON.stringify(b.meta) : null);
}

/**
 * Re-derive a book's chunks from the text blocks of its newest snapshot. Chunks whose text is unchanged are kept
 * as they are (so their original capture reference and any embedding survive); changed ones are replaced.
 */
export function rechunkBook(db: Db, asin: string): void {
  const snap = db.prepare('SELECT id FROM snapshot WHERE asin = ? ORDER BY captured_at DESC LIMIT 1').get(asin) as { id: number } | undefined;
  if (!snap) {
    db.prepare(`DELETE FROM chunk WHERE asin = ? AND ${PAGE_KINDS_SQL}`).run(asin);
    return;
  }
  const blocks = db
    .prepare('SELECT kind, ordinal, body, meta FROM text_block WHERE snapshot_id = ? ORDER BY kind, ordinal')
    .all(snap.id) as unknown as { kind: string; ordinal: number; body: string; meta: string | null }[];

  const want: { kind: string; ordinal: number; text: string; hash: string; meta: string | null }[] = [];
  for (const b of blocks) {
    const parts = b.kind === 'title' ? [b.body] : chunkText(b.body);
    // reviews keep their own ordinal space: review 3 piece 1 -> 3*100+1
    parts.forEach((text, i) => want.push({ kind: b.kind, ordinal: b.kind === 'review' ? b.ordinal * 100 + i : i, text, hash: hashText(text), meta: b.meta }));
  }

  const have = db.prepare(`SELECT id, kind, ordinal, text_hash FROM chunk WHERE asin = ? AND ${PAGE_KINDS_SQL}`).all(asin) as unknown as {
    id: number; kind: string; ordinal: number; text_hash: string;
  }[];
  const key = (k: string, o: number, h: string) => `${k}|${o}|${h}`;
  const keep = new Set(want.map((w) => key(w.kind, w.ordinal, w.hash)));
  const del = db.prepare('DELETE FROM chunk WHERE id = ?');
  const present = new Set<string>();
  for (const h of have) {
    const k = key(h.kind, h.ordinal, h.text_hash);
    if (keep.has(k) && !present.has(k)) present.add(k);
    else {
      del.run(h.id);
      removeVec(db, h.id);
    }
  }
  const ins = db.prepare('INSERT INTO chunk (asin, snapshot_id, kind, ordinal, text, text_hash, token_count, meta) VALUES (?,?,?,?,?,?,?,?)');
  for (const w of want) {
    if (!present.has(key(w.kind, w.ordinal, w.hash))) ins.run(asin, snap.id, w.kind, w.ordinal, w.text, w.hash, estimateTokens(w.text), w.meta);
  }
}

/** Drop a chunk's vector, if the vector table exists. */
export function removeVec(db: Db, chunkId: number): void {
  if (!db.vecEnabled) return;
  try {
    db.prepare('DELETE FROM chunk_vec WHERE rowid = ?').run(BigInt(chunkId));
  } catch {
    /* table not created yet */
  }
}
