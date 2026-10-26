import fs from 'node:fs';
import path from 'node:path';
import type { Embedder } from '@cadrel/market-library';

/** Short, stable id stored with the vectors. Changing the model means a new id (and a re-index). */
export const MODEL_ID = 'minilm-l6-v2-q8';
export const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_DIM = 384;

export interface DownloadProgress {
  file: string;
  /** 0 to 100 */
  percent: number;
}

/** The slice of transformers.js we use, so tests can stand in for it. */
export type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
export interface LoaderOptions {
  cacheDir: string;
  /** Never touch the network (query-time use). */
  offline: boolean;
  onProgress?: (p: DownloadProgress) => void;
}
export type ExtractorLoader = (o: LoaderOptions) => Promise<FeatureExtractor>;

/** Real loader: transformers.js with onnxruntime. The module is imported lazily because it is large. */
export const loadTransformers: ExtractorLoader = async ({ cacheDir, offline, onProgress }) => {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = !offline;
  const extractor = await pipeline('feature-extraction', MODEL_REPO, {
    dtype: 'q8',
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status === 'progress' && p.file) onProgress?.({ file: p.file, percent: Math.round(p.progress ?? 0) });
    },
  });
  return extractor as unknown as FeatureExtractor;
};

/** True when the model files are already in the cache, so no download is needed. */
export function isModelCached(cacheDir: string): boolean {
  const dir = path.join(cacheDir, ...MODEL_REPO.split('/'));
  try {
    return fs.existsSync(path.join(dir, 'config.json')) && fs.readdirSync(path.join(dir, 'onnx')).some((f) => f.endsWith('.onnx'));
  } catch {
    return false;
  }
}

export class TransformersEmbedder implements Embedder {
  readonly name = MODEL_ID;
  readonly dim = MODEL_DIM;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(private readonly opts: { cacheDir: string; offline?: boolean; onProgress?: (p: DownloadProgress) => void; loader?: ExtractorLoader }) {}

  private load(): Promise<FeatureExtractor> {
    this.extractor ??= (this.opts.loader ?? loadTransformers)({
      cacheDir: this.opts.cacheDir,
      offline: this.opts.offline ?? false,
      onProgress: this.opts.onProgress,
    }).catch((e) => {
      this.extractor = null; // let a later call retry (e.g. once the network is back)
      throw e;
    });
    return this.extractor;
  }

  /** Fetch the model now (first run), rather than on the first search. */
  async prepare(): Promise<void> {
    await this.load();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const run = await this.load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const rows = (await run(texts.slice(i, i + 16), { pooling: 'mean', normalize: true })).tolist();
      for (const r of rows) {
        if (r.length !== MODEL_DIM) throw new Error(`model returned ${r.length} dimensions, expected ${MODEL_DIM}`);
        out.push(Float32Array.from(r));
      }
    }
    return out;
  }
}
