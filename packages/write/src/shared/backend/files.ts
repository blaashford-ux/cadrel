import type { FileStamp } from '../api';
import { errorCode, type FsPort } from '../fsPort';

/** A short number for temp-file names; the digits matter (sync's junk filter looks for `.mdedit-<digits>.tmp`). */
const randomTempId = () => Math.floor(Math.random() * 1e9);

export function makeFiles(fs: FsPort, tempId: () => number = randomTempId) {
  /** Null when the file does not exist. */
  async function statStamp(file: string): Promise<FileStamp | null> {
    const st = await fs.stat(file);
    return st ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  }

  async function readWithStamp(file: string): Promise<{ text: string; stamp: FileStamp }> {
    const text = await fs.readText(file);
    const stamp = await statStamp(file);
    if (!stamp) throw new Error(`File disappeared while reading: ${file}`);
    return { text, stamp };
  }

  /** Writes via a temp file + rename so a crash mid-write can't leave a truncated .md. */
  async function writeFileAtomic(target: string, content: string): Promise<FileStamp> {
    const tmp = `${target}.mdedit-${tempId()}.tmp`;
    try {
      await fs.writeText(tmp, content);
      await fs.rename(tmp, target);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    const stamp = await statStamp(target);
    if (!stamp) throw new Error(`File disappeared after writing: ${target}`);
    return stamp;
  }

  return { statStamp, readWithStamp, writeFileAtomic };
}

export { errorCode };
