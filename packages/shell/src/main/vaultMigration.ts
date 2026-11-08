/**
 * Before this, a Studio's vault had a working folder of its own (<Studio>\Vault) beside the Projects folder, so a file had to be added to the
 * vault by hand, as a second copy. The vault now works in the Projects folder itself (see projectSync.ts). This brings what the old folder held
 * across, once, and never overwrites or deletes anything:
 *  - a file the old folder holds that the Projects folder lacks is copied to the same path there;
 *  - a file that is in both and the same needs nothing;
 *  - a file that is in both and differs stays in the old folder, and the vault's record of it is dropped from this computer's notes, so the
 *    first pass keeps both (the Projects copy is saved beside the vault's version, named "(changes <date> <computer>)");
 *  - what the vault knew about each copy (`.cadrel-vault\state.json`) moves to the Studio's own folder.
 * The old folder is left where it is. A note says what was done and what stayed, and the migration does not run again.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const STATE_DIR = '.cadrel-vault';

export interface MigrationNote {
  at: string;
  copied: number;
  same: number;
  /** Paths (relative) that differ in the two folders and stayed in the old one. */
  differing: string[];
}

const hashOf = async (f: string): Promise<string | null> => fsp.readFile(f).then((b) => createHash('sha256').update(b).digest('hex'), () => null);

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.name === STATE_DIR) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Runs once per Studio (`marker` records that it has). Returns what was done, or null when there was nothing to do or it had already run. */
export async function migrateVaultFolder(o: { oldDir: string; newDir: string; stateDir: string; marker: string; now?: () => Date }): Promise<MigrationNote | null> {
  if (await fsp.access(o.marker).then(() => true, () => false)) return null;
  const note: MigrationNote = { at: (o.now?.() ?? new Date()).toISOString(), copied: 0, same: 0, differing: [] };
  const oldState = await fsp.readFile(path.join(o.oldDir, STATE_DIR, 'state.json'), 'utf8').then((t) => JSON.parse(t) as { files?: Record<string, unknown>; orphans?: unknown[] }, () => null);
  if (oldState || (await fsp.access(o.oldDir).then(() => true, () => false))) {
    for (const rel of await walk(o.oldDir)) {
      const from = path.join(o.oldDir, ...rel.split('/'));
      const to = path.join(o.newDir, ...rel.split('/'));
      const there = await hashOf(to);
      if (there === null) {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(from, to);
        await fsp.chmod(to, 0o644).catch(() => undefined);
        note.copied++;
      } else if (there === (await hashOf(from))) note.same++;
      else {
        note.differing.push(rel);
        if (oldState?.files) delete oldState.files[rel]; // no claim about which version this copy is based on: the first pass keeps both
      }
    }
    if (oldState) {
      const f = path.join(o.stateDir, 'state.json');
      if (!(await fsp.access(f).then(() => true, () => false))) {
        await fsp.mkdir(o.stateDir, { recursive: true });
        await fsp.writeFile(f, JSON.stringify({ files: oldState.files ?? {}, orphans: oldState.orphans ?? [] }, null, 2));
      }
    }
  }
  await fsp.mkdir(path.dirname(o.marker), { recursive: true });
  await fsp.writeFile(o.marker, JSON.stringify(note, null, 2));
  return note.copied + note.same + note.differing.length > 0 ? note : null;
}
