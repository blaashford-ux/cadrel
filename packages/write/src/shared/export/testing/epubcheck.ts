import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Locates epubcheck.jar (EPUBCHECK_JAR, or the pip `epubcheck` package) and a Java runtime. */
function findJar(): string | null {
  const candidates = [process.env.EPUBCHECK_JAR, '/usr/local/lib/python3.11/dist-packages/epubcheck/epubcheck.jar'];
  const py = spawnSync('python3', ['-c', 'import epubcheck,os;print(os.path.dirname(epubcheck.__file__))'], { encoding: 'utf8' });
  if (py.status === 0) candidates.push(path.join(py.stdout.trim(), 'epubcheck.jar'));
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

const jar = findJar();
const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
export const epubcheckAvailable = !!jar && java.status === 0;

export interface EpubcheckResult {
  ok: boolean;
  output: string;
}

/** Runs the real epubcheck validator on an EPUB. */
export function runEpubcheck(bytes: Uint8Array): EpubcheckResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'epubcheck-'));
  try {
    const file = path.join(dir, 'book.epub');
    writeFileSync(file, bytes);
    const r = spawnSync('java', ['-jar', jar!, file], { encoding: 'utf8', timeout: 120_000 });
    const output = `${r.stdout}\n${r.stderr}`.replace(/Picked up JAVA_TOOL_OPTIONS.*\n/g, '');
    return { ok: r.status === 0 && /No errors or warnings detected/.test(output), output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
