import { errorCode, type FsPort } from '../fsPort';
import { basename, dirname, isMarkdownName, joinPath, withMarkdownExt } from '../paths';
import { complianceError } from '../sync/names';

function checkName(name: string): string {
  const bad = complianceError(name.trim());
  if (bad) throw new Error(bad);
  return name.trim();
}

export function makeFsops(fs: FsPort) {
  const exists = async (p: string) => (await fs.stat(p)) !== null;

  /** Creates a new Markdown file; never overwrites. Returns its path. */
  async function createFile(dir: string, name: string, content = ''): Promise<string> {
    const target = joinPath(dir, withMarkdownExt(checkName(name)));
    try {
      await fs.writeText(target, content, { exclusive: true });
    } catch (e) {
      if (errorCode(e) === 'EEXIST') throw new Error(`"${basename(target)}" already exists.`);
      throw e;
    }
    return target;
  }

  async function createFolder(dir: string, name: string): Promise<string> {
    const target = joinPath(dir, checkName(name));
    try {
      await fs.mkdir(target);
    } catch (e) {
      if (errorCode(e) === 'EEXIST') throw new Error(`"${basename(target)}" already exists.`);
      throw e;
    }
    return target;
  }

  /** Renames in place. Files keep a Markdown extension. Never overwrites another item. */
  async function renameNode(from: string, newName: string): Promise<string> {
    const st = await fs.stat(from);
    if (!st) throw Object.assign(new Error(`"${basename(from)}" no longer exists.`), { code: 'ENOENT' });
    const clean = checkName(newName);
    const name = st.isDirectory ? clean : withMarkdownExt(clean);
    if (!st.isDirectory && !isMarkdownName(name)) throw new Error('Files must keep a .md extension.');
    const to = joinPath(dirname(from), name);
    const caseOnly = to.toLowerCase() === from.toLowerCase();
    if (!caseOnly && (await exists(to))) throw new Error(`"${name}" already exists.`);
    await fs.rename(from, to);
    return to;
  }

  return { createFile, createFolder, renameNode };
}
