import type { Db } from './schema.js';

export interface Embedder {
  /** Identifies the model; vectors from different models are never mixed. */
  readonly name: string;
  readonly dim: number;
  /** Returns one L2-normalised vector per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

const asBytes = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/**
 * Works with no model files at all: hashes words and word pairs into a fixed-size vector. Far weaker than a neural
 * model but captures shared vocabulary, so it is the fallback before the real model is downloaded, and the
 * deterministic embedder for tests.
 */
export class HashingEmbedder implements Embedder {
  readonly name = 'hashing-v1';
  constructor(readonly dim = 256) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      const words = t.toLowerCase().match(/[a-z0-9']+/g) ?? [];
      const add = (s: string, w: number) => {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
        const at = (h >>> 1) % this.dim;
        v[at] = (v[at] ?? 0) + (h & 1 ? 1 : -1) * w;
      };
      words.forEach((w, i) => {
        add(w, 1);
        if (i > 0) add(`${words[i - 1]} ${w}`, 0.5);
      });
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    });
  }
}

function setModel(db: Db, e: Embedder): void {
  const want = `${e.name}:${e.dim}`;
  const have = db.scalar<string>("SELECT value FROM kv WHERE key = 'embedding_model'");
  if (have === want) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[${e.dim}])`);
    return;
  }
  // different model: its vectors are meaningless here, so the index starts over (cached embeddings are keyed by model)
  db.exec('DROP TABLE IF EXISTS chunk_vec');
  db.exec(`CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[${e.dim}])`);
  db.prepare("INSERT INTO kv (key, value) VALUES ('embedding_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(want);
}

export interface EmbedProgress {
  done: number;
  total: number;
}

/** Embed every chunk that has no vector yet. Returns how many chunks were indexed. */
export async function embedPending(
  db: Db,
  embedder: Embedder,
  opts: { batch?: number; onProgress?: (p: EmbedProgress) => void } = {},
): Promise<number> {
  if (!db.vecEnabled) throw new Error('vector search is unavailable (sqlite-vec could not be loaded)');
  setModel(db, embedder);
  const batch = opts.batch ?? 32;
  const model = `${embedder.name}:${embedder.dim}`; // the cache key includes the size, so a resized model never reuses old vectors
  const pending = db
    .prepare('SELECT id, text, text_hash AS hash FROM chunk WHERE id NOT IN (SELECT rowid FROM chunk_vec) ORDER BY id')
    .all() as unknown as { id: number; text: string; hash: string }[];
  const cached = db.prepare('SELECT vec FROM embedding WHERE text_hash = ? AND model = ?');
  const putCache = db.prepare('INSERT OR REPLACE INTO embedding (text_hash, model, dim, vec) VALUES (?,?,?,?)');
  const putVec = db.prepare('INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)');
  let done = 0;
  for (let i = 0; i < pending.length; i += batch) {
    const rows = pending.slice(i, i + batch);
    const vecs = new Map<string, Uint8Array>();
    const todo: typeof rows = [];
    for (const r of rows) {
      const hit = cached.get(r.hash, model) as { vec: Uint8Array } | undefined;
      if (hit) vecs.set(r.hash, hit.vec);
      else if (!todo.some((t) => t.hash === r.hash)) todo.push(r);
    }
    if (todo.length) {
      const out = await embedder.embed(todo.map((t) => t.text));
      if (out.length !== todo.length || out.some((v) => v.length !== embedder.dim)) throw new Error('embedder returned the wrong shape');
      todo.forEach((t, k) => vecs.set(t.hash, asBytes(out[k]!)));
    }
    db.transaction(() => {
      for (const r of rows) {
        const bytes = vecs.get(r.hash)!;
        if (todo.some((t) => t.hash === r.hash)) putCache.run(r.hash, model, embedder.dim, bytes);
        putVec.run(BigInt(r.id), bytes);
      }
    })();
    done += rows.length;
    opts.onProgress?.({ done, total: pending.length });
  }
  return done;
}

export function embeddingStatus(db: Db): { chunks: number; embedded: number; model: string | null; vectorSearch: boolean } {
  const chunks = db.scalar<number>('SELECT count(*) FROM chunk') ?? 0;
  const model = db.scalar<string>("SELECT value FROM kv WHERE key = 'embedding_model'") ?? null;
  let embedded = 0;
  if (db.vecEnabled && model) {
    try {
      embedded = db.scalar<number>('SELECT count(*) FROM chunk_vec') ?? 0;
    } catch {
      embedded = 0;
    }
  }
  return { chunks, embedded, model, vectorSearch: db.vecEnabled };
}

/** Forget all vectors (chunk ids are about to change); the per-text cache makes re-indexing cheap. */
export function resetVectors(db: Db): void {
  if (db.vecEnabled) db.exec('DROP TABLE IF EXISTS chunk_vec');
  db.exec("DELETE FROM kv WHERE key = 'embedding_model'");
}
