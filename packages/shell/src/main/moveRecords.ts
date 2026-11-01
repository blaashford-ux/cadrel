/**
 * Moves a Studio's records from the owner's computer to the Studio's server, once: every record, the vault's file contents, and the project
 * tree. Afterwards the Studio is used through its server, by everyone including its owner, and the file here is kept as a copy. It is safe to
 * run again if it stops half way (the server starts over each time), and it changes nothing here until it has finished.
 * Electron-free; tested against the real Worker code in test/remote.test.ts.
 */
import { promises as fsp } from 'node:fs';
import { STUDIO_SCHEMA_VERSION, type ProjectTree } from '@cadrel/kernel';
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

const FORMAT = 'cadrel-server-records';

/**
 * A copy of the Studio's records as they are on its server, written to one file: every record table, who the owner is, and the project tree.
 * The files' contents are not in it: they stay in the Studio's file store, where no version is ever deleted. Only the owner can ask.
 */
export async function backupServerRecords(o: { client: StudioClient; file: string; studio: { id: string; name: string }; step?: (text: string) => void }): Promise<{ rows: number; bytes: number }> {
  const say = o.step ?? (() => undefined);
  const head = await o.client.request<{ owner: string | null; schemaVersion: number }>('POST', '/v1/records/export', { table: '_owner' });
  const tables: Record<string, Record<string, unknown>[]> = {};
  let rows = 0;
  for (const t of TABLES) {
    say(`Reading ${t.replace(/_/g, ' ')}`);
    tables[t] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page: { rows: Record<string, unknown>[]; next: number | null } = await o.client.request('POST', '/v1/records/export', { table: t, offset });
      tables[t]!.push(...page.rows);
      rows += page.rows.length;
      offset = page.next;
    }
  }
  const tree = await o.client.tree();
  const text = JSON.stringify({ format: FORMAT, version: 1, studio: o.studio, takenAt: new Date().toISOString(), schema: head.schemaVersion, owner: head.owner, tables, tree });
  await fsp.writeFile(o.file, text);
  return { rows, bytes: Buffer.byteLength(text) };
}

/** Puts a backup made by `backupServerRecords` back on the server, replacing what it holds. Refused if it is from a newer Cadrel than this one. */
export async function restoreServerRecords(o: { client: StudioClient; file: string; step?: (text: string) => void }): Promise<{ rows: number }> {
  const say = o.step ?? (() => undefined);
  let d: { format?: string; schema?: number; owner?: string | null; tables?: Record<string, Record<string, unknown>[]>; tree?: ProjectTree };
  try {
    d = JSON.parse(await fsp.readFile(o.file, 'utf8'));
  } catch {
    throw new Error('That file is not a backup of a Studio’s records.');
  }
  if (d.format !== FORMAT || !d.tables || typeof d.tables !== 'object') throw new Error('That file is not a backup of a Studio’s records.');
  if ((d.schema ?? 0) > STUDIO_SCHEMA_VERSION) throw new Error('That backup is from a newer Cadrel than this one. Update Cadrel to restore it.');
  if (!d.owner) throw new Error('That backup does not say who the Studio’s owner is.');
  await o.client.me();
  say('Clearing what the server holds');
  await o.client.request('POST', '/v1/records/import', { phase: 'start' });
  let rows = 0;
  for (const t of TABLES) {
    const all = d.tables[t] ?? [];
    say(`Sending ${t.replace(/_/g, ' ')}`);
    for (let i = 0; i < all.length; i += CHUNK) {
      await o.client.request('POST', '/v1/records/import', { phase: 'rows', table: t, rows: all.slice(i, i + CHUNK) });
      rows += Math.min(CHUNK, all.length - i);
    }
  }
  await o.client.request('POST', '/v1/records/import', { phase: 'finish', owner: d.owner });
  if (d.tree) await o.client.publishTree(d.tree);
  return { rows };
}
