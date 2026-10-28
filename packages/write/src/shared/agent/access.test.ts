import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { accessReader, NO_AI_ACCESS, sanitizeAccess } from './access';

describe('AI access', () => {
  it('is off unless a permission is exactly true', () => {
    expect(sanitizeAccess(undefined)).toEqual(NO_AI_ACCESS);
    expect(sanitizeAccess({ createFiles: 'yes', editFiles: 1 })).toEqual(NO_AI_ACCESS);
    expect(sanitizeAccess({ createFiles: true })).toEqual({ createFiles: true, editFiles: false });
  });

  it('fails closed on a missing, damaged or unnamed file, and reads changes at once', async () => {
    const fs = new MemoryFs();
    expect(await accessReader(fs, undefined)()).toEqual(NO_AI_ACCESS);
    expect(await accessReader(fs, '/a.json')()).toEqual(NO_AI_ACCESS);
    fs.seed('/a.json', '{oops');
    expect(await accessReader(fs, '/a.json')()).toEqual(NO_AI_ACCESS);
    const read = accessReader(fs, '/a.json');
    fs.seed('/a.json', '{"createFiles":true,"editFiles":true}');
    expect(await read()).toEqual({ createFiles: true, editFiles: true });
    fs.seed('/a.json', '{"createFiles":true,"editFiles":false}');
    expect(await read()).toEqual({ createFiles: true, editFiles: false });
  });
});
