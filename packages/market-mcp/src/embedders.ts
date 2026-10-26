import path from 'node:path';
import { HashingEmbedder, type Embedder } from '@cadrel/market-library';

/**
 * The embedder that produced a stored model id such as "hashing-v1:256", if it can be run in this process.
 * The neural model is loaded offline from the library's models folder; if it is not there, search falls back to keywords.
 */
export async function embedderForModel(model: string, libraryRoot: string): Promise<Embedder | null> {
  const [name, dim] = model.split(':');
  if (name === 'hashing-v1') return new HashingEmbedder(Number(dim) || 256);
  try {
    const { MODEL_ID, TransformersEmbedder, isModelCached } = await import('@cadrel/market-embedder');
    const cacheDir = path.join(libraryRoot, 'models');
    if (name === MODEL_ID && isModelCached(cacheDir)) return new TransformersEmbedder({ cacheDir, offline: true });
  } catch {
    /* embedder not installed or failed to load: keyword search only */
  }
  return null;
}
