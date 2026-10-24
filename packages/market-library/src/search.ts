import type { Db } from './schema.js';
import type { Embedder } from './embeddings.js';
import { excludedAsins } from './removal.js';

export interface SearchOptions {
  query: string;
  /** Without an embedder (or before any vectors exist) search is keyword-only. */
  embedder?: Embedder;
  kinds?: string[];
  asins?: string[];
  categoryKey?: string;
  limit?: number;
}

export interface Hit {
  chunkId: number;
  asin: string;
  title: string | null;
  kind: string;
  ordinal: number;
  text: string;
  /** When the page this text came from was captured. */
  capturedAt: string;
  /** For community text: subreddit, permalink, score, flair, post date and thread title. */
  meta: Record<string, unknown> | null;
  score: number;
  matched: ('keyword' | 'meaning')[];
}

const RRF_K = 60;

/** Asins in a category: on its newest list capture, or ranked in it on their newest snapshot; never one the user took out of it. */
export function asinsInCategory(db: Db, categoryKey: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.asin FROM list_entry e JOIN list_capture l ON l.id = e.list_capture_id
         WHERE l.category_key = ?1 AND l.captured_at = (SELECT max(captured_at) FROM list_capture x
           WHERE x.category_key = l.category_key AND x.list_kind = l.list_kind AND x.page = l.page)
       UNION
       SELECT s.asin FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id
         WHERE r.category_key = ?1 AND s.captured_at = (SELECT max(captured_at) FROM snapshot y WHERE y.asin = s.asin)`,
    )
    .all(categoryKey) as unknown as { asin: string }[];
  const out = excludedAsins(db, categoryKey);
  return new Set(rows.map((r) => r.asin).filter((a) => !out.has(a)));
}

/** Turn free text into a safe FTS5 query: quoted terms OR-ed together. */
export function ftsQuery(q: string): string | null {
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((t) => t.length > 1).slice(0, 24);
  return terms.length ? terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ') : null;
}

export async function searchText(db: Db, o: SearchOptions): Promise<Hit[]> {
  const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
  const pool = limit * 8;
  let asinFilter: Set<string> | null = null;
  if (o.categoryKey) {
    asinFilter = asinsInCategory(db, o.categoryKey);
    // subreddits linked to the category stand in for books: their text is filed under "r/<name>"
    for (const r of db.prepare('SELECT subreddit FROM community_source WHERE category_key = ?').all(o.categoryKey) as unknown as { subreddit: string }[]) asinFilter.add(`r/${r.subreddit}`);
  }
  if (o.asins) asinFilter = asinFilter ? new Set(o.asins.filter((a) => asinFilter!.has(a))) : new Set(o.asins);

  const fused = new Map<number, { score: number; matched: Set<'keyword' | 'meaning'> }>();
  const bump = (id: number, rank: number, via: 'keyword' | 'meaning') => {
    const e = fused.get(id) ?? { score: 0, matched: new Set() };
    e.score += 1 / (RRF_K + rank);
    e.matched.add(via);
    fused.set(id, e);
  };

  const keep = (row: { asin: string; kind: string }) =>
    (!asinFilter || asinFilter.has(row.asin)) && (!o.kinds || o.kinds.includes(row.kind));

  const fq = ftsQuery(o.query);
  if (fq) {
    const rows = db
      .prepare('SELECT c.id, c.asin, c.kind FROM chunk_fts f JOIN chunk c ON c.id = f.rowid WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?')
      .all(fq, pool) as unknown as { id: number; asin: string; kind: string }[];
    rows.filter(keep).forEach((r, i) => bump(r.id, i + 1, 'keyword'));
  }

  if (o.embedder && db.vecEnabled && db.scalar<string>("SELECT value FROM kv WHERE key = 'embedding_model'") === `${o.embedder.name}:${o.embedder.dim}`) {
    const [qv] = await o.embedder.embed([o.query]);
    const near = db
      .prepare('SELECT rowid AS id, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance')
      .all(new Uint8Array(qv!.buffer, qv!.byteOffset, qv!.byteLength), Math.min(pool * 4, 4000)) as unknown as { id: number }[];
    const meta = db.prepare('SELECT asin, kind FROM chunk WHERE id = ?');
    let rank = 0;
    for (const n of near) {
      const m = meta.get(n.id) as { asin: string; kind: string } | undefined;
      if (m && keep(m)) bump(n.id, ++rank, 'meaning');
      if (rank >= pool) break;
    }
  }

  const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  const get = db.prepare(
    `SELECT c.id, c.asin, c.kind, c.ordinal, c.text, c.meta, COALESCE(s.captured_at, m.created_at, json_extract(c.meta, '$.created')) AS capturedAt, COALESCE(s.title, b.title) AS title
       FROM chunk c
       LEFT JOIN snapshot s ON s.id = c.snapshot_id
       LEFT JOIN manuscript m ON m.asin = c.asin AND m.source = CASE c.kind WHEN 'manuscript' THEN 'upload' WHEN 'sample_text' THEN 'sample' END
       LEFT JOIN book b ON b.asin = c.asin
       WHERE c.id = ?`,
  );
  return top.map(([id, e]) => {
    const r = get.get(id) as unknown as Omit<Hit, 'chunkId' | 'score' | 'matched' | 'meta'> & { id: number; meta: string | null };
    const community = r.kind === 'community_post' || r.kind === 'community_comment';
    const meta = community && r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null;
    return { chunkId: id, asin: r.asin, title: community ? ((meta?.postTitle as string | null) ?? null) : r.title, kind: r.kind, ordinal: r.ordinal, text: r.text, capturedAt: r.capturedAt, meta, score: e.score, matched: [...e.matched] };
  });
}
