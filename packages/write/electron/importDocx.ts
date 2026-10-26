import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ImportDocxResult } from '../src/shared/api';
import { docxToMarkdown } from '../src/shared/importDocx';
import { createFile } from './fsops';

/** Converts each .docx to a Markdown file of the same name in `dir`; a taken name gets " (2)", " (3)" … */
export async function importDocxFiles(dir: string, sources: string[]): Promise<ImportDocxResult> {
  const result: ImportDocxResult = { created: [], failed: [] };
  for (const src of sources) {
    const base = path.basename(src, path.extname(src));
    try {
      const markdown = docxToMarkdown(new Uint8Array(await fsp.readFile(src)));
      for (let n = 1; ; n++) {
        try {
          result.created.push(await createFile(dir, n === 1 ? base : `${base} (${n})`, markdown));
          break;
        } catch (e) {
          if (n < 50 && /already exists/.test(String(e instanceof Error ? e.message : e))) continue;
          throw e;
        }
      }
    } catch (e) {
      result.failed.push(`${path.basename(src)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
