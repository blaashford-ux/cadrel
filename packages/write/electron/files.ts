import { promises as fs } from 'node:fs';
import type { FileStamp } from '../src/shared/api';

/** Null when the file does not exist. */
export async function statStamp(file: string): Promise<FileStamp | null> {
  try {
    const st = await fs.stat(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function readWithStamp(file: string): Promise<{ text: string; stamp: FileStamp }> {
  const text = await fs.readFile(file, 'utf8');
  const stamp = await statStamp(file);
  if (!stamp) throw new Error(`File disappeared while reading: ${file}`);
  return { text, stamp };
}

/** Writes via a temp file + rename so a crash mid-write can't leave a truncated .md. */
export async function writeFileAtomic(target: string, content: string): Promise<FileStamp> {
  const tmp = `${target}.mdedit-${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  const stamp = await statStamp(target);
  if (!stamp) throw new Error(`File disappeared after writing: ${target}`);
  return stamp;
}

/** Like writeFileAtomic, for binary output (EPUB, PDF, DOCX). */
export async function writeBytesAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${target}.mdedit-${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
