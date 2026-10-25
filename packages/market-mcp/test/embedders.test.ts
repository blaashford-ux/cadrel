import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_ID } from '@cadrel/market-embedder';
import { embedderForModel } from '../src/embedders.js';

describe('embedderForModel', () => {
  it('rebuilds the hashing embedder from its id', async () => {
    expect(await embedderForModel('hashing-v1:128', '/x')).toMatchObject({ name: 'hashing-v1', dim: 128 });
  });
  it('returns null (keyword-only search) when the neural model is not downloaded or unknown', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-emb-'));
    expect(await embedderForModel(`${MODEL_ID}:384`, d)).toBeNull();
    expect(await embedderForModel('mystery:10', d)).toBeNull();
    fs.rmSync(d, { recursive: true });
  });
  it('returns the neural embedder once the model files are in <library>/models', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-emb-'));
    const m = path.join(d, 'models', 'Xenova', 'all-MiniLM-L6-v2');
    fs.mkdirSync(path.join(m, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(m, 'config.json'), '{}');
    fs.writeFileSync(path.join(m, 'onnx', 'model_quantized.onnx'), 'x');
    expect(await embedderForModel(`${MODEL_ID}:384`, d)).toMatchObject({ name: MODEL_ID, dim: 384 });
    fs.rmSync(d, { recursive: true });
  });
});
