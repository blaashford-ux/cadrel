import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_DIM, MODEL_ID, TransformersEmbedder, isModelCached, type ExtractorLoader } from '../src/index.js';

const fakeLoader = (calls: { loads: number; batches: number[] }): ExtractorLoader => async () => {
  calls.loads++;
  return async (texts) => {
    calls.batches.push(texts.length);
    return { tolist: () => texts.map((t) => Array.from({ length: MODEL_DIM }, (_, i) => (i === t.length % MODEL_DIM ? 1 : 0))) };
  };
};

describe('TransformersEmbedder', () => {
  it('loads once, batches by 16, and returns float vectors of the right size', async () => {
    const calls = { loads: 0, batches: [] as number[] };
    const e = new TransformersEmbedder({ cacheDir: '/x', loader: fakeLoader(calls) });
    expect(e.name).toBe(MODEL_ID);
    const v = await e.embed(Array.from({ length: 40 }, (_, i) => 'a'.repeat(i + 1)));
    expect(v).toHaveLength(40);
    expect(v[0]).toBeInstanceOf(Float32Array);
    expect(v[0]!.length).toBe(MODEL_DIM);
    await e.embed(['one more']);
    expect(calls.loads).toBe(1);
    expect(calls.batches).toEqual([16, 16, 8, 1]);
  });

  it('rejects a model that returns the wrong size', async () => {
    const e = new TransformersEmbedder({ cacheDir: '/x', loader: async () => async (t) => ({ tolist: () => t.map(() => [1, 2, 3]) }) });
    await expect(e.embed(['x'])).rejects.toThrow(/dimensions/);
  });

  it('retries loading after a failure (network came back)', async () => {
    let n = 0;
    const e = new TransformersEmbedder({
      cacheDir: '/x',
      loader: async () => {
        if (n++ === 0) throw new Error('offline');
        return async (t) => ({ tolist: () => t.map(() => new Array(MODEL_DIM).fill(0)) });
      },
    });
    await expect(e.prepare()).rejects.toThrow('offline');
    await expect(e.embed(['x'])).resolves.toHaveLength(1);
  });

  it('passes offline mode and cache dir to the loader', async () => {
    let seen: any;
    const e = new TransformersEmbedder({ cacheDir: '/cache', offline: true, loader: async (o) => ((seen = o), async () => ({ tolist: () => [] })) });
    await e.prepare();
    expect(seen).toMatchObject({ cacheDir: '/cache', offline: true });
  });
});

describe('isModelCached', () => {
  it('needs config and an onnx file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-model-'));
    expect(isModelCached(d)).toBe(false);
    const m = path.join(d, 'Xenova', 'all-MiniLM-L6-v2');
    fs.mkdirSync(path.join(m, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(m, 'config.json'), '{}');
    expect(isModelCached(d)).toBe(false);
    fs.writeFileSync(path.join(m, 'onnx', 'model_quantized.onnx'), 'x');
    expect(isModelCached(d)).toBe(true);
    fs.rmSync(d, { recursive: true });
  });
});

describe('real loader module', () => {
  it('imports transformers.js without side effects', async () => {
    const m = await import('@huggingface/transformers');
    expect(typeof m.pipeline).toBe('function');
  }, 30000);
});
