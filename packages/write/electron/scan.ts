import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { DirNode, TreeNode } from '../src/shared/api';
import { isSidecarName, sidecarOwner, sidecarStem, stemOf } from '../src/shared/export/sidecar';

const MD_EXT = /\.(md|markdown)$/i;
const SKIP_DIRS = new Set(['node_modules']);

const byName = (a: TreeNode, b: TreeNode) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Recursively collects Markdown files and folders under `dir`. Folders come before files,
 * both sorted naturally. Empty folders are kept (so you can add files to them); hidden
 * folders, node_modules and symlinks are skipped (no loops).
 */
export async function scanFolder(dir: string): Promise<DirNode> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs: DirNode[] = [];
  const files: TreeNode[] = [];

  // Export settings live in `<name>.export.json` beside each manuscript.
  const sidecars = new Set(entries.filter((e) => e.isFile() && isSidecarName(e.name)).map((e) => sidecarStem(e.name)));
  const byStem = new Map<string, string[]>();
  for (const e of entries) {
    if (e.isFile() && MD_EXT.test(e.name)) byStem.set(stemOf(e.name), [...(byStem.get(stemOf(e.name)) ?? []), e.name]);
  }
  const readMarked = async (stem: string): Promise<boolean> => {
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, stem + '.export.json'), 'utf8')).marked === true;
    } catch {
      return false; // unreadable settings: treat as not marked (the Book Details dialog reports the damage)
    }
  };

  await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) return;
        try {
          dirs.push(await scanFolder(full));
        } catch {
          // unreadable folder (permissions): skip it
        }
      } else if (e.isFile() && MD_EXT.test(e.name)) {
        const stem = stemOf(e.name);
        const node: TreeNode = { kind: 'file', name: e.name, path: full };
        if (sidecars.has(stem)) {
          if (sidecarOwner(byStem.get(stem) ?? []) === e.name) node.marked = await readMarked(stem);
          else node.exportBlocked = true; // another file with the same name already owns this sidecar
        }
        files.push(node);
      }
    })
  );

  dirs.sort(byName);
  files.sort(byName);
  const orphans = [...sidecars].filter((stem) => !byStem.has(stem)).sort().map((stem) => path.join(dir, stem + '.export.json'));
  return {
    kind: 'dir',
    name: path.basename(dir) || dir,
    path: dir,
    children: [...dirs, ...files],
    ...(orphans.length ? { orphanSidecars: orphans } : {})
  };
}
