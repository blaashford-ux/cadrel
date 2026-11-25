/**
 * Assets: art, covers and other design files, governed (docs/M5-PLAN.md). An asset is a vault file plus what the vault does not know: what it is
 * for, which exact version is approved, its licence, and where it is used. Records and rules over the kernel's async `Db`; nothing here decides who
 * may do what (the service checks first), it decides what is valid.
 *
 *   - **Approval is of an exact version and its hash.** A new version of the file is not approved until someone approves it, and a revocation is a
 *     later row, never an edit. An expired licence blocks a *new* approval (and nothing else).
 *   - **A replacement is a proposal that moves nothing.** Approving one marks every current use "needs update"; each use's owner marks it done.
 *   - **A concept is an exact version of a file against an exact version of a brief.** Choosing one makes its file an asset in review.
 *   - **Feedback is pinned to a region of the image at an exact version**, in fractions of its width and height.
 * Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';

export const ASSET_KINDS = ['cover', 'banner', 'ad', 'interior', 'character', 'map', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_STATES = ['draft', 'in_review', 'approved', 'retired'] as const;
export type AssetState = (typeof ASSET_STATES)[number];
export const USE_KINDS = ['edition', 'listing', 'ad', 'banner', 'release', 'other'] as const;
export type UseKind = (typeof USE_KINDS)[number];

const MAX_NAME = 200;
const MAX_TEXT = 1000;
const MAX_NOTE = 2000;

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
const clean = (v: unknown, what: string, max: number, required: boolean): string => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};
const isUnique = (e: unknown) => /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(String((e as Error)?.message ?? e));

// ---- licence ---------------------------------------------------------------------------------------------------------------------

export interface Licence {
  kind: string;
  licensor: string;
  ref: string;
  /** A date, YYYY-MM-DD, or null for none. */
  expires: string | null;
  territory: string;
  creditLine: string;
  /** The licence document, a vault file. */
  fileId: string | null;
}
export type LicenceInput = Partial<Licence>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function cleanLicence(l: LicenceInput | undefined, base: Licence): Licence {
  const o = l ?? {};
  const expires = o.expires === undefined ? base.expires : o.expires;
  if (expires !== null && (typeof expires !== 'string' || !DATE.test(expires) || Number.isNaN(Date.parse(expires)))) fail('invalid', 'A licence runs to a date, written YYYY-MM-DD.');
  return {
    kind: o.kind === undefined ? base.kind : clean(o.kind, 'The licence kind', 100, false),
    licensor: o.licensor === undefined ? base.licensor : clean(o.licensor, 'The licensor', MAX_NAME, false),
    ref: o.ref === undefined ? base.ref : clean(o.ref, 'The licence reference', 200, false),
    expires,
    territory: o.territory === undefined ? base.territory : clean(o.territory, 'The territory', 200, false),
    creditLine: o.creditLine === undefined ? base.creditLine : clean(o.creditLine, 'The credit line', 300, false),
    fileId: o.fileId === undefined ? base.fileId : o.fileId
  };
}
const NO_LICENCE: Licence = { kind: '', licensor: '', ref: '', expires: null, territory: '', creditLine: '', fileId: null };
/** A licence that has run out as of `now` (the last day counts). */
export const licenceExpired = (l: Pick<Licence, 'expires'>, now: string): boolean => !!l.expires && l.expires < now.slice(0, 10);
/** Days until the licence runs out (negative when it has), or null when it does not. */
export function licenceDaysLeft(l: Pick<Licence, 'expires'>, now: string): number | null {
  if (!l.expires) return null;
  return Math.round((Date.parse(l.expires) - Date.parse(now.slice(0, 10))) / 86_400_000);
}

// ---- assets ----------------------------------------------------------------------------------------------------------------------

export interface Asset {
  id: string;
  projectId: string;
  fileId: string;
  kind: AssetKind;
  name: string;
  channel: string;
  state: AssetState;
  licence: Licence;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}
interface AssetRow {
  id: string;
  projectId: string;
  fileId: string;
  kind: AssetKind;
  name: string;
  channel: string;
  state: AssetState;
  lKind: string;
  lLicensor: string;
  lRef: string;
  lExpires: string | null;
  lTerritory: string;
  lCredit: string;
  lFile: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}
const ACOLS =
  'id, project_id AS projectId, file_id AS fileId, kind, name, channel, state, licence_kind AS lKind, licensor AS lLicensor, licence_ref AS lRef, licence_expires AS lExpires, territory AS lTerritory, credit_line AS lCredit, licence_file_id AS lFile, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt';
const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  projectId: r.projectId,
  fileId: r.fileId,
  kind: r.kind,
  name: r.name,
  channel: r.channel,
  state: r.state,
  licence: { kind: r.lKind, licensor: r.lLicensor, ref: r.lRef, expires: r.lExpires, territory: r.lTerritory, creditLine: r.lCredit, fileId: r.lFile },
  createdAt: r.createdAt,
  createdBy: r.createdBy,
  updatedAt: r.updatedAt
});

export async function getAsset(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Asset | null> {
  const r = await db.first<AssetRow>(`SELECT ${ACOLS} FROM asset WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toAsset(r) : null;
}
export async function assetOfFile(db: Db, c: Pick<Ctx, 'studioId'>, fileId: string): Promise<Asset | null> {
  const r = await db.first<AssetRow>(`SELECT ${ACOLS} FROM asset WHERE file_id = ? AND studio_id = ?`, [fileId, c.studioId]);
  return r ? toAsset(r) : null;
}
export interface AssetFilter {
  projectId?: string;
  projectIds?: string[];
  kind?: AssetKind;
  /** A state, or 'live' (the default: everything but retired), or 'any'. */
  state?: AssetState | 'live' | 'any';
}
export async function listAssets(db: Db, c: Pick<Ctx, 'studioId'>, f: AssetFilter = {}): Promise<Asset[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.kind) (where.push('kind = ?'), params.push(f.kind));
  const state = f.state ?? 'live';
  if (state === 'live') where.push("state <> 'retired'");
  else if (state !== 'any') (where.push('state = ?'), params.push(state));
  return (await db.all<AssetRow>(`SELECT ${ACOLS} FROM asset WHERE ${where.join(' AND ')} ORDER BY kind, lower(name)`, params)).map(toAsset);
}

export interface NewAsset {
  projectId: string;
  fileId: string;
  kind: AssetKind;
  name?: string;
  channel?: string;
  licence?: LicenceInput;
}
async function fileOf(db: Db, c: Pick<Ctx, 'studioId'>, fileId: string, what = 'The file') {
  const f = await db.first<{ id: string; path: string; current: number }>('SELECT id, path, current_version AS current FROM vault_file WHERE id = ? AND studio_id = ?', [fileId, c.studioId]);
  return f ?? fail('not-found', `${what} is not in the vault.`);
}
async function versionOf(db: Db, fileId: string, n: number): Promise<{ n: number; hash: string }> {
  if (!Number.isInteger(n) || n < 1) return fail('invalid', 'A version is a whole number from 1.');
  const v = await db.first<{ n: number; hash: string }>('SELECT n, hash FROM file_version WHERE file_id = ? AND n = ?', [fileId, n]);
  return v ?? fail('not-found', 'That version of the file is not there.');
}

/** Makes a vault file an asset, in draft. A file is one asset. */
export async function createAsset(db: Db, c: Ctx, i: NewAsset): Promise<Asset> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A project is needed.');
  if (!ASSET_KINDS.includes(i.kind)) fail('invalid', `An asset is one of: ${ASSET_KINDS.join(', ')}.`);
  const file = await fileOf(db, c, i.fileId);
  const name = clean(i.name ?? file.path.split('/').pop() ?? file.path, 'The name', MAX_NAME, true);
  const licence = cleanLicence(i.licence, NO_LICENCE);
  if (licence.fileId) await fileOf(db, c, licence.fileId, 'The licence document');
  const id = newRecordId();
  try {
    await db.batch([
      {
        sql: `INSERT INTO asset (id, studio_id, project_id, file_id, kind, name, channel, state, licence_kind, licensor, licence_ref, licence_expires, territory, credit_line, licence_file_id, created_at, created_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, c.studioId, i.projectId, file.id, i.kind, name, clean(i.channel, 'The channel', 200, false), licence.kind, licence.licensor, licence.ref, licence.expires, licence.territory, licence.creditLine, licence.fileId, c.now, c.actor, c.now]
      },
      audit(c, 'asset.create', id, { projectId: i.projectId, fileId: file.id, kind: i.kind, name })
    ]);
  } catch (e) {
    if (isUnique(e)) return fail('exists', 'That file is already an asset.');
    throw e;
  }
  return (await getAsset(db, c, id))!;
}

/** Name, channel and licence. Needs the asset to be live. */
export async function updateAsset(db: Db, c: Ctx, id: string, i: { name?: string; channel?: string; licence?: LicenceInput }): Promise<Asset> {
  const a = await getAsset(db, c, id);
  if (!a) return fail('not-found', 'That asset is not there.');
  if (a.state === 'retired') return fail('conflict', 'That asset is retired.');
  const name = i.name === undefined ? a.name : clean(i.name, 'The name', MAX_NAME, true);
  const channel = i.channel === undefined ? a.channel : clean(i.channel, 'The channel', 200, false);
  const licence = cleanLicence(i.licence, a.licence);
  if (licence.fileId && licence.fileId !== a.licence.fileId) await fileOf(db, c, licence.fileId, 'The licence document');
  await db.batch([
    {
      sql: 'UPDATE asset SET name = ?, channel = ?, licence_kind = ?, licensor = ?, licence_ref = ?, licence_expires = ?, territory = ?, credit_line = ?, licence_file_id = ?, updated_at = ? WHERE id = ? AND studio_id = ?',
      params: [name, channel, licence.kind, licence.licensor, licence.ref, licence.expires, licence.territory, licence.creditLine, licence.fileId, c.now, id, c.studioId]
    },
    audit(c, 'asset.update', id, { name, channel, licence })
  ]);
  return (await getAsset(db, c, id))!;
}

/** Draft to in review: someone has asked for a decision. */
export async function submitForReview(db: Db, c: Ctx, id: string): Promise<Asset> {
  const a = await getAsset(db, c, id);
  if (!a) return fail('not-found', 'That asset is not there.');
  if (a.state !== 'draft') return fail('conflict', `That asset is ${a.state.replace('_', ' ')}.`);
  await db.batch([
    { sql: "UPDATE asset SET state = 'in_review', updated_at = ? WHERE id = ? AND studio_id = ? AND state = 'draft'", params: [c.now, id, c.studioId] },
    audit(c, 'asset.submit', id, {})
  ]);
  return (await getAsset(db, c, id))!;
}

/** Retiring is for good: the asset stays on record (uses and approvals are history) but nothing new can be done with it. */
export async function retireAsset(db: Db, c: Ctx, id: string, reason: string): Promise<Asset> {
  const a = await getAsset(db, c, id);
  if (!a) return fail('not-found', 'That asset is not there.');
  if (a.state === 'retired') return a;
  const why = clean(reason, 'The reason', MAX_TEXT, true);
  await db.batch([
    { sql: "UPDATE asset SET state = 'retired', updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, id, c.studioId] },
    audit(c, 'asset.retire', id, { reason: why })
  ]);
  return (await getAsset(db, c, id))!;
}

// ---- approval --------------------------------------------------------------------------------------------------------------------

export interface AssetApproval {
  id: string;
  assetId: string;
  version: number;
  hash: string;
  state: 'approved' | 'revoked';
  note: string;
  decidedBy: string;
  decidedAt: string;
}
const APCOLS = 'id, asset_id AS assetId, version, hash, state, note, decided_by AS decidedBy, decided_at AS decidedAt';
export const approvalsOf = (db: Db, c: Pick<Ctx, 'studioId'>, assetId: string): Promise<AssetApproval[]> =>
  db.all<AssetApproval>(`SELECT ${APCOLS} FROM asset_approval WHERE asset_id = ? AND studio_id = ? ORDER BY decided_at, rowid`, [assetId, c.studioId]);

/** Versions that stand approved now: approved and not revoked since (a later row for the same version wins). */
export function approvedVersions(rows: AssetApproval[]): AssetApproval[] {
  const last = new Map<number, AssetApproval>();
  for (const r of rows) last.set(r.version, r);
  return [...last.values()].filter((r) => r.state === 'approved').sort((a, b) => a.version - b.version);
}
/** The newest approved version, or null. */
export async function approvedVersion(db: Db, c: Pick<Ctx, 'studioId'>, assetId: string): Promise<AssetApproval | null> {
  const a = approvedVersions(await approvalsOf(db, c, assetId));
  return a.length ? a[a.length - 1]! : null;
}

/** Approves one exact version (and its hash). An expired licence blocks a new approval; a retired asset cannot be approved. */
export async function approveVersion(db: Db, c: Ctx, assetId: string, version: number, note = ''): Promise<AssetApproval> {
  const a = await getAsset(db, c, assetId);
  if (!a) return fail('not-found', 'That asset is not there.');
  if (a.state === 'retired') return fail('conflict', 'That asset is retired.');
  if (licenceExpired(a.licence, c.now)) return fail('blocked', `The licence ran out on ${a.licence.expires}, so a new version cannot be approved until it is renewed.`);
  const v = await versionOf(db, a.fileId, version);
  const standing = approvedVersions(await approvalsOf(db, c, assetId));
  if (standing.some((s) => s.version === v.n)) return fail('conflict', `Version ${v.n} is already approved.`);
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO asset_approval (id, studio_id, asset_id, version, hash, state, note, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)", params: [id, c.studioId, assetId, v.n, v.hash, clean(note, 'The note', MAX_TEXT, false), c.actor, c.now] },
    { sql: "UPDATE asset SET state = 'approved', updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, assetId, c.studioId] },
    audit(c, 'asset.approve', assetId, { version: v.n, hash: v.hash })
  ]);
  return (await approvalsOf(db, c, assetId)).find((r) => r.id === id)!;
}

/** Takes an approval back, with a reason. When no approved version is left the asset goes back to review. */
export async function revokeApproval(db: Db, c: Ctx, assetId: string, version: number, reason: string): Promise<AssetApproval> {
  const a = await getAsset(db, c, assetId);
  if (!a) return fail('not-found', 'That asset is not there.');
  const why = clean(reason, 'The reason', MAX_TEXT, true);
  const standing = approvedVersions(await approvalsOf(db, c, assetId));
  const was = standing.find((s) => s.version === version);
  if (!was) return fail('conflict', `Version ${version} is not approved.`);
  const id = newRecordId();
  const left = standing.filter((s) => s.version !== version).length;
  await db.batch([
    { sql: "INSERT INTO asset_approval (id, studio_id, asset_id, version, hash, state, note, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, 'revoked', ?, ?, ?)", params: [id, c.studioId, assetId, version, was.hash, why, c.actor, c.now] },
    ...(left === 0 && a.state === 'approved' ? [{ sql: "UPDATE asset SET state = 'in_review', updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, assetId, c.studioId] }] : []),
    audit(c, 'asset.revoke', assetId, { version, reason: why })
  ]);
  return (await approvalsOf(db, c, assetId)).find((r) => r.id === id)!;
}

// ---- uses and where-used -----------------------------------------------------------------------------------------------------------

export interface AssetUse {
  id: string;
  assetId: string;
  /** The version the use names, or null for "the latest approved". */
  version: number | null;
  userKind: UseKind;
  userRef: string;
  label: string;
  note: string;
  state: 'current' | 'needs_update' | 'done';
  addedBy: string;
  addedAt: string;
  updatedAt: string;
}
const UCOLS = 'id, asset_id AS assetId, version, user_kind AS userKind, user_ref AS userRef, label, note, state, added_by AS addedBy, added_at AS addedAt, updated_at AS updatedAt';
export const usesOf = (db: Db, c: Pick<Ctx, 'studioId'>, assetId: string): Promise<AssetUse[]> =>
  db.all<AssetUse>(`SELECT ${UCOLS} FROM asset_use WHERE asset_id = ? AND studio_id = ? ORDER BY added_at, rowid`, [assetId, c.studioId]);

export async function addUse(db: Db, c: Ctx, assetId: string, i: { kind: UseKind; label: string; ref?: string; version?: number | null; note?: string }): Promise<AssetUse> {
  const a = await getAsset(db, c, assetId);
  if (!a) return fail('not-found', 'That asset is not there.');
  if (a.state === 'retired') return fail('conflict', 'That asset is retired.');
  if (!USE_KINDS.includes(i.kind)) fail('invalid', `A use is one of: ${USE_KINDS.join(', ')}.`);
  const label = clean(i.label, 'The label', MAX_NAME, true);
  const version = i.version ?? null;
  if (version !== null) await versionOf(db, a.fileId, version);
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO asset_use (id, studio_id, asset_id, version, user_kind, user_ref, label, note, state, added_by, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?)", params: [id, c.studioId, assetId, version, i.kind, clean(i.ref, 'The reference', 500, false), label, clean(i.note, 'The note', MAX_TEXT, false), c.actor, c.now, c.now] },
    audit(c, 'asset.use_add', assetId, { kind: i.kind, label })
  ]);
  return (await usesOf(db, c, assetId)).find((u) => u.id === id)!;
}

/** The use's owner says it now shows the new version (needs_update to done), or that it is current again. */
export async function setUseState(db: Db, c: Ctx, useId: string, state: 'current' | 'done'): Promise<AssetUse> {
  const u = await db.first<AssetUse>(`SELECT ${UCOLS} FROM asset_use WHERE id = ? AND studio_id = ?`, [useId, c.studioId]);
  if (!u) return fail('not-found', 'That use is not there.');
  if (state !== 'current' && state !== 'done') return fail('invalid', 'A use is current or done.');
  await db.batch([
    { sql: 'UPDATE asset_use SET state = ?, updated_at = ? WHERE id = ? AND studio_id = ?', params: [state, c.now, useId, c.studioId] },
    audit(c, 'asset.use_state', u.assetId, { useId, state })
  ]);
  return (await db.first<AssetUse>(`SELECT ${UCOLS} FROM asset_use WHERE id = ?`, [useId]))!;
}

export interface FileUse {
  fileId: string;
  path: string;
  /** The version of the asset's file it names, or null for the latest. */
  version: number | null;
  note: string;
}
export interface AssetWhereUsed {
  declared: AssetUse[];
  files: FileUse[];
}
/** Everything that uses the asset: the declared uses, and the vault files that reference it. */
export async function assetWhereUsed(db: Db, c: Pick<Ctx, 'studioId'>, assetId: string): Promise<AssetWhereUsed> {
  const a = await getAsset(db, c, assetId);
  if (!a) return fail('not-found', 'That asset is not there.');
  const files = await db.all<FileUse>(
    `SELECT r.file_id AS fileId, f.path AS path, r.version AS version, r.note AS note
       FROM file_reference r JOIN vault_file f ON f.id = r.file_id WHERE r.refers_to_id = ? AND f.studio_id = ? ORDER BY f.path`,
    [a.fileId, c.studioId]
  );
  return { declared: await usesOf(db, c, assetId), files };
}

// ---- replacements ----------------------------------------------------------------------------------------------------------------

export interface AssetReplacement {
  id: string;
  assetId: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
  state: 'open' | 'approved' | 'rejected' | 'withdrawn';
  decisionReason: string | null;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}
const RCOLS = 'id, asset_id AS assetId, from_version AS fromVersion, to_version AS toVersion, reason, state, decision_reason AS decisionReason, proposed_by AS proposedBy, proposed_at AS proposedAt, decided_by AS decidedBy, decided_at AS decidedAt';
export const getReplacement = (db: Db, c: Pick<Ctx, 'studioId'>, id: string) =>
  db.first<AssetReplacement>(`SELECT ${RCOLS} FROM asset_replacement WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
export const replacementsOf = (db: Db, c: Pick<Ctx, 'studioId'>, assetId: string) =>
  db.all<AssetReplacement>(`SELECT ${RCOLS} FROM asset_replacement WHERE asset_id = ? AND studio_id = ? ORDER BY proposed_at, rowid`, [assetId, c.studioId]);

/** "This version should replace that one." The new version must be approved to be proposed as the replacement; the old one must be. */
export async function proposeReplacement(db: Db, c: Ctx, assetId: string, i: { fromVersion: number; toVersion: number; reason: string }): Promise<AssetReplacement> {
  const a = await getAsset(db, c, assetId);
  if (!a) return fail('not-found', 'That asset is not there.');
  if (a.state === 'retired') return fail('conflict', 'That asset is retired.');
  const reason = clean(i.reason, 'The reason', MAX_TEXT, true);
  if (i.fromVersion === i.toVersion) return fail('invalid', 'A replacement is a different version.');
  await versionOf(db, a.fileId, i.toVersion);
  const standing = approvedVersions(await approvalsOf(db, c, assetId));
  if (!standing.some((s) => s.version === i.fromVersion)) return fail('conflict', `Version ${i.fromVersion} is not the approved one.`);
  if (!standing.some((s) => s.version === i.toVersion)) return fail('conflict', `Version ${i.toVersion} is not approved yet; approve it first.`);
  if ((await replacementsOf(db, c, assetId)).some((r) => r.state === 'open' && r.fromVersion === i.fromVersion)) return fail('exists', 'A replacement for that version is already waiting.');
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO asset_replacement (id, studio_id, asset_id, from_version, to_version, reason, state, proposed_by, proposed_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)", params: [id, c.studioId, assetId, i.fromVersion, i.toVersion, reason, c.actor, c.now] },
    audit(c, 'asset.replace_propose', assetId, { from: i.fromVersion, to: i.toVersion, reason })
  ]);
  return (await getReplacement(db, c, id))!;
}

/**
 * Approving moves nothing: every current use of the old version (and every use that follows the latest) is marked "needs update", and the old
 * version stays approved until someone revokes it. Returns the proposal and the uses now waiting on their owners.
 */
export async function decideReplacement(db: Db, c: Ctx, id: string, d: { approve: boolean; reason?: string }): Promise<{ replacement: AssetReplacement; needUpdate: AssetUse[] }> {
  const r = await getReplacement(db, c, id);
  if (!r) return fail('not-found', 'That replacement is not there.');
  if (r.state !== 'open') return fail('conflict', `That replacement has already been ${r.state}.`);
  if (!d.approve) {
    const reason = clean(d.reason, 'The reason', MAX_TEXT, true);
    await db.batch([
      { sql: "UPDATE asset_replacement SET state = 'rejected', decision_reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'", params: [reason, c.actor, c.now, id] },
      audit(c, 'asset.replace_reject', r.assetId, { id, reason })
    ]);
    return { replacement: (await getReplacement(db, c, id))!, needUpdate: [] };
  }
  await db.batch([
    { sql: "UPDATE asset_replacement SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'", params: [c.actor, c.now, id] },
    { sql: "UPDATE asset_use SET state = 'needs_update', updated_at = ? WHERE asset_id = ? AND studio_id = ? AND state = 'current' AND (version IS NULL OR version = ?)", params: [c.now, r.assetId, c.studioId, r.fromVersion] },
    audit(c, 'asset.replace_approve', r.assetId, { id, from: r.fromVersion, to: r.toVersion })
  ]);
  return { replacement: (await getReplacement(db, c, id))!, needUpdate: (await usesOf(db, c, r.assetId)).filter((u) => u.state === 'needs_update') };
}

export async function withdrawReplacement(db: Db, c: Ctx, id: string): Promise<AssetReplacement> {
  const r = await getReplacement(db, c, id);
  if (!r) return fail('not-found', 'That replacement is not there.');
  if (r.state !== 'open') return fail('conflict', `That replacement has already been ${r.state}.`);
  await db.batch([
    { sql: "UPDATE asset_replacement SET state = 'withdrawn', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'", params: [c.actor, c.now, id] },
    audit(c, 'asset.replace_withdraw', r.assetId, { id })
  ]);
  return (await getReplacement(db, c, id))!;
}

// ---- concepts --------------------------------------------------------------------------------------------------------------------

export const CONCEPT_STATES = ['submitted', 'shortlisted', 'chosen', 'rejected'] as const;
export type ConceptState = (typeof CONCEPT_STATES)[number];
export interface Concept {
  id: string;
  projectId: string;
  briefId: string;
  briefVersion: number;
  fileId: string;
  fileVersion: number;
  state: ConceptState;
  note: string;
  submittedBy: string;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  assetId: string | null;
}
const CCOLS = 'id, project_id AS projectId, brief_id AS briefId, brief_version AS briefVersion, file_id AS fileId, file_version AS fileVersion, state, note, submitted_by AS submittedBy, submitted_at AS submittedAt, decided_by AS decidedBy, decided_at AS decidedAt, asset_id AS assetId';
export const getConcept = (db: Db, c: Pick<Ctx, 'studioId'>, id: string) => db.first<Concept>(`SELECT ${CCOLS} FROM concept WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
export const conceptsOf = (db: Db, c: Pick<Ctx, 'studioId'>, briefId: string) =>
  db.all<Concept>(`SELECT ${CCOLS} FROM concept WHERE brief_id = ? AND studio_id = ? ORDER BY submitted_at, rowid`, [briefId, c.studioId]);

/** Offers an exact version of a file against an exact version of a (cover or art) brief. */
export async function submitConcept(db: Db, c: Ctx, i: { briefId: string; briefVersion?: number; fileId: string; fileVersion?: number; note?: string }): Promise<Concept> {
  const b = await db.first<{ id: string; projectId: string; kind: string; current: number }>(
    'SELECT b.id AS id, b.project_id AS projectId, b.kind AS kind, (SELECT MAX(n) FROM brief_version WHERE brief_id = b.id) AS current FROM brief b WHERE b.id = ? AND b.studio_id = ?',
    [i.briefId, c.studioId]
  );
  if (!b) return fail('not-found', 'That brief is not there.');
  if (b.kind !== 'cover' && b.kind !== 'art') return fail('invalid', 'Concepts are made against a cover or art brief.');
  const briefVersion = i.briefVersion ?? b.current;
  if (!Number.isInteger(briefVersion) || briefVersion < 1 || briefVersion > b.current) return fail('not-found', 'That version of the brief is not there.');
  const file = await fileOf(db, c, i.fileId);
  const v = await versionOf(db, file.id, i.fileVersion ?? file.current);
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO concept (id, studio_id, project_id, brief_id, brief_version, file_id, file_version, state, note, submitted_by, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)", params: [id, c.studioId, b.projectId, b.id, briefVersion, file.id, v.n, clean(i.note, 'The note', MAX_TEXT, false), c.actor, c.now] },
    audit(c, 'concept.submit', id, { briefId: b.id, briefVersion, fileId: file.id, fileVersion: v.n })
  ]);
  return (await getConcept(db, c, id))!;
}

/** Shortlist or reject (a rejection needs a reason, kept in the note). Choosing is `chooseConcept`. */
export async function decideConcept(db: Db, c: Ctx, id: string, state: 'shortlisted' | 'rejected', note = ''): Promise<Concept> {
  const k = await getConcept(db, c, id);
  if (!k) return fail('not-found', 'That concept is not there.');
  if (k.state === 'chosen') return fail('conflict', 'That concept has been chosen.');
  if (state !== 'shortlisted' && state !== 'rejected') return fail('invalid', 'A concept is shortlisted or rejected here.');
  const n = clean(note, 'The note', MAX_TEXT, state === 'rejected');
  await db.batch([
    { sql: 'UPDATE concept SET state = ?, note = CASE WHEN ? = \'\' THEN note ELSE ? END, decided_by = ?, decided_at = ? WHERE id = ? AND studio_id = ?', params: [state, n, n, c.actor, c.now, id, c.studioId] },
    audit(c, `concept.${state}`, id, {})
  ]);
  return (await getConcept(db, c, id))!;
}

/**
 * Chooses a concept: its file becomes an asset in review (or the existing asset of that file goes to review), of the kind the brief is for.
 * Choosing is not approving: the cover still needs `approveVersion`. Other concepts of the brief are left as they are.
 */
export async function chooseConcept(db: Db, c: Ctx, id: string): Promise<{ concept: Concept; asset: Asset }> {
  const k = await getConcept(db, c, id);
  if (!k) return fail('not-found', 'That concept is not there.');
  if (k.state === 'chosen') return fail('conflict', 'That concept has already been chosen.');
  if (k.state === 'rejected') return fail('conflict', 'That concept was rejected.');
  const brief = await db.first<{ kind: string }>('SELECT kind FROM brief WHERE id = ?', [k.briefId]);
  let asset = await assetOfFile(db, c, k.fileId);
  if (!asset) asset = await createAsset(db, c, { projectId: k.projectId, fileId: k.fileId, kind: brief?.kind === 'cover' ? 'cover' : 'other' });
  if (asset.state === 'draft') asset = await submitForReview(db, c, asset.id);
  await db.batch([
    { sql: "UPDATE concept SET state = 'chosen', decided_by = ?, decided_at = ?, asset_id = ? WHERE id = ? AND studio_id = ?", params: [c.actor, c.now, asset.id, id, c.studioId] },
    audit(c, 'concept.choose', id, { assetId: asset.id })
  ]);
  return { concept: (await getConcept(db, c, id))!, asset };
}

// ---- feedback pinned to a region ----------------------------------------------------------------------------------------------------

/** A rectangle on an image, in fractions of its width and height, so it holds at any size. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
export function cleanRegion(r: unknown): Region {
  const o = r as Region;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!o || !ok(o.x) || !ok(o.y) || !ok(o.w) || !ok(o.h)) return fail('invalid', 'A region is x, y, width and height, as fractions of the image.');
  if (o.x < 0 || o.y < 0 || o.w <= 0 || o.h <= 0 || o.x + o.w > 1.0001 || o.y + o.h > 1.0001) return fail('invalid', 'A region lies inside the image.');
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}
export interface Feedback {
  id: string;
  projectId: string;
  targetKind: 'asset' | 'concept';
  targetId: string;
  /** The version of the file the pin is on. */
  fileVersion: number;
  region: Region | null;
  body: string;
  state: 'open' | 'resolved';
  by: string;
  at: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}
interface FeedbackRow extends Omit<Feedback, 'region'> {
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
}
const FBCOLS = 'id, project_id AS projectId, target_kind AS targetKind, target_id AS targetId, file_version AS fileVersion, x, y, w, h, body, state, by, at, resolved_by AS resolvedBy, resolved_at AS resolvedAt';
const toFeedback = ({ x, y, w, h, ...r }: FeedbackRow): Feedback => ({ ...r, region: x === null || y === null || w === null || h === null ? null : { x, y, w, h } });

export async function addFeedback(db: Db, c: Ctx, i: { targetKind: 'asset' | 'concept'; targetId: string; fileVersion?: number; region?: Region | null; body: string }): Promise<Feedback> {
  let fileId: string, projectId: string, current: number;
  if (i.targetKind === 'asset') {
    const a = await getAsset(db, c, i.targetId);
    if (!a) return fail('not-found', 'That asset is not there.');
    fileId = a.fileId;
    projectId = a.projectId;
    current = (await fileOf(db, c, fileId)).current;
  } else if (i.targetKind === 'concept') {
    const k = await getConcept(db, c, i.targetId);
    if (!k) return fail('not-found', 'That concept is not there.');
    fileId = k.fileId;
    projectId = k.projectId;
    current = k.fileVersion; // a concept is one exact version
  } else return fail('invalid', 'Feedback is on an asset or a concept.');
  const version = i.fileVersion ?? current;
  await versionOf(db, fileId, version);
  const region = i.region ? cleanRegion(i.region) : null;
  const body = clean(i.body, 'The feedback', MAX_NOTE, true);
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO asset_feedback (id, studio_id, project_id, target_kind, target_id, file_version, x, y, w, h, body, state, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'open\', ?, ?)', params: [id, c.studioId, projectId, i.targetKind, i.targetId, version, region?.x ?? null, region?.y ?? null, region?.w ?? null, region?.h ?? null, body, c.actor, c.now] },
    audit(c, 'asset.feedback', i.targetId, { kind: i.targetKind, version, pinned: !!region })
  ]);
  return toFeedback((await db.first<FeedbackRow>(`SELECT ${FBCOLS} FROM asset_feedback WHERE id = ?`, [id]))!);
}
export async function feedbackOf(db: Db, c: Pick<Ctx, 'studioId'>, targetKind: 'asset' | 'concept', targetId: string): Promise<Feedback[]> {
  return (await db.all<FeedbackRow>(`SELECT ${FBCOLS} FROM asset_feedback WHERE studio_id = ? AND target_kind = ? AND target_id = ? ORDER BY at, rowid`, [c.studioId, targetKind, targetId])).map(toFeedback);
}
export async function resolveFeedback(db: Db, c: Ctx, id: string): Promise<Feedback> {
  const f = await db.first<FeedbackRow>(`SELECT ${FBCOLS} FROM asset_feedback WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  if (!f) return fail('not-found', 'That feedback is not there.');
  if (f.state === 'resolved') return toFeedback(f);
  await db.batch([
    { sql: "UPDATE asset_feedback SET state = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND studio_id = ?", params: [c.actor, c.now, id, c.studioId] },
    audit(c, 'asset.feedback_resolve', f.targetId, { id })
  ]);
  return toFeedback((await db.first<FeedbackRow>(`SELECT ${FBCOLS} FROM asset_feedback WHERE id = ?`, [id]))!);
}

// ---- readiness (what Launch will read) ----------------------------------------------------------------------------------------------

export interface ApprovedAsset {
  asset: Asset;
  version: number;
  hash: string;
  approvedAt: string;
  approvedBy: string;
  /** The licence has run out since approval: still the approved version, but flagged. */
  licenceExpired: boolean;
}
/** The approved assets of a kind inside some projects, each with its newest approved version. */
export async function approvedAssets(db: Db, c: Pick<Ctx, 'studioId' | 'now'>, projectIds: string[], kind?: AssetKind): Promise<ApprovedAsset[]> {
  const out: ApprovedAsset[] = [];
  for (const a of await listAssets(db, c, { projectIds, kind, state: 'approved' })) {
    const v = await approvedVersion(db, c, a.id);
    if (v) out.push({ asset: a, version: v.version, hash: v.hash, approvedAt: v.decidedAt, approvedBy: v.decidedBy, licenceExpired: licenceExpired(a.licence, c.now) });
  }
  return out;
}
