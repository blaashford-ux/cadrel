/**
 * Moves a Studio's records from the owner's computer to the Studio's server, once: every record, the vault's file contents, and the project
 * tree. Afterwards the Studio is used through its server, by everyone including its owner, and the file here is kept as a copy. It is safe to
 * run again if it stops half way (the server starts over each time), and it changes nothing here until it has finished.
 * Electron-free; tested against the real Worker code in test/remote.test.ts.
 */
import type { ProjectTree } from '@cadrel/kernel';
import { DirBlobs, openStudioDb } from '@cadrel/store';
import type { StudioClient } from './studioClient';

/** The tables the server takes, parents first (the Worker's own list is the authority; a table it does not know is refused). */
const TABLES = [
  'person', 'pen_name', 'pen_name_person', 'team', 'team_member', 'role', 'role_capability', 'assignment', 'capability_seen',
  'workflow', 'workflow_stage', 'workflow_transition', 'workflow_transition_role',
  'ip', 'series', 'book', 'edition', 'book_project', 'task', 'task_dependency', 'approval', 'approval_approver', 'decision',
  'vault_file', 'file_version', 'checkout', 'orphan', 'file_reference', 'file_card',
  'contribution', 'credit', 'rights', 'revenue_share', 'audit'
];
const CHUNK = 300;

export interface MoveResult {
  rows: number;
  files: number;
  /** File contents the vault records but this computer no longer holds. */
  missing: string[];
}

export async function moveRecordsToServer(o: {
  client: StudioClient;
  /** A consistent copy of the records (the live file is in use). */
  recordsCopy: string;
  /** The person using this computer: the Studio's owner, in the records. */
  ownerPersonId: string;
  blobsDir: string;
  tree: ProjectTree;
  step?: (text: string) => void;
}): Promise<MoveResult> {
  const say = o.step ?? (() => undefined);
  await o.client.me(); // before anything is changed: the server must answer, and be the owner's
  const db = await openStudioDb(o.recordsCopy);
  try {
    const tables = new Set((await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name));
    say('Clearing what the server holds');
    await o.client.request('POST', '/v1/records/import', { phase: 'start' });
    let rows = 0;
    for (const t of TABLES.filter((x) => tables.has(x))) {
      say(`Sending ${t.replace(/_/g, ' ')}`);
      const all = await db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
      for (let i = 0; i < all.length; i += CHUNK) {
        await o.client.request('POST', '/v1/records/import', { phase: 'rows', table: t, rows: all.slice(i, i + CHUNK) });
        rows += Math.min(CHUNK, all.length - i);
      }
    }
    await o.client.request('POST', '/v1/records/import', { phase: 'finish', owner: o.ownerPersonId });

    const hashes = tables.has('file_version') ? (await db.all<{ hash: string }>('SELECT DISTINCT hash FROM file_version')).map((h) => h.hash) : [];
    const blobs = new DirBlobs(o.blobsDir);
    const missing: string[] = [];
    let files = 0;
    for (const h of hashes) {
      say(`Sending files (${files + 1} of ${hashes.length})`);
      const bytes = await blobs.get(h);
      if (!bytes) {
        missing.push(h);
        continue;
      }
      await o.client.putBlob(h, bytes);
      files++;
    }
    say('Sending the projects');
    await o.client.publishTree(o.tree);
    return { rows, files, missing };
  } finally {
    db.close();
  }
}
