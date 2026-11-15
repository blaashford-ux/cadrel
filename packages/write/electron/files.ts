import { promises as fs } from 'node:fs';
import { makeFiles } from '../src/shared/backend/files';
import { nodeFs } from './nodeFs';

// The shared implementation over Node's fs (the temp file keeps the process id in its name, as before).
export const { statStamp, readWithStamp, writeFileAtomic } = makeFiles(nodeFs, () => process.pid);

/** Like writeFileAtomic, for binary output (EPUB, PDF, DOCX). An earlier export of the same name may have been made read-only by the vault (an output folder inside a project), which Windows will not rename over: it is generated, so it is replaced. */
export async function writeBytesAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${target}.cadrel-${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.chmod(target, 0o666).catch(() => undefined);
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
