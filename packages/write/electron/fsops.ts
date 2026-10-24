import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isMarkdownName, validateName, withMarkdownExt } from '../src/shared/paths';

function checkName(name: string): string {
  const bad = validateName(name);
  if (bad) throw new Error(bad);
  return name.trim();
}

const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false
  );

/** Creates a new Markdown file; never overwrites. Returns its path. */
export async function createFile(dir: string, name: string, content = ''): Promise<string> {
  const target = path.join(dir, withMarkdownExt(checkName(name)));
  try {
    await fs.writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`"${path.basename(target)}" already exists.`);
    throw e;
  }
  return target;
}

export async function createFolder(dir: string, name: string): Promise<string> {
  const target = path.join(dir, checkName(name));
  try {
    await fs.mkdir(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`"${path.basename(target)}" already exists.`);
    throw e;
  }
  return target;
}

/** Renames in place. Files keep a Markdown extension. Never overwrites another item. */
export async function renameNode(from: string, newName: string): Promise<string> {
  const st = await fs.lstat(from);
  const clean = checkName(newName);
  const name = st.isDirectory() ? clean : withMarkdownExt(clean);
  if (!st.isDirectory() && !isMarkdownName(name)) throw new Error('Files must keep a .md extension.');
  const to = path.join(path.dirname(from), name);
  const caseOnly = to.toLowerCase() === from.toLowerCase();
  if (!caseOnly && (await exists(to))) throw new Error(`"${name}" already exists.`);
  await fs.rename(from, to);
  return to;
}
