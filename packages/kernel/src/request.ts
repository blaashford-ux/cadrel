/**
 * Campaign asset requests (docs/M6-PLAN.md): what a campaign asks Art for (a banner of a size, an ad in a format), from a brief. A request is a task for
 * whoever it is given to, plus a **spec**. It is *fulfilled* only when an asset's file meets the spec **as measured** (from the file's header) and a
 * version of that asset is approved; a file of the wrong size is refused with what was found and what was wanted.
 */
import { approvedVersions, approvalsOf, getAsset } from './asset';
import type { Ctx } from './catalogue';
import { newRecordId } from './ids';
import type { ImageFormat, ImageInfo } from './imageInfo';
import type { Db } from './vault';
import { WorkError, createTask, getTask, setTaskState } from './work';

export const REQUEST_KINDS = ['banner', 'ad', 'social', 'cover_variant', 'other'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export interface RequestSpec {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  formats?: ImageFormat[];
  maxBytes?: number;
  /** Where it will run ("Facebook feed"), in words. */
  channel?: string;
}
export type RequestState = 'open' | 'delivered' | 'cancelled';
export interface AssetRequest {
  id: string;
  projectId: string;
  planId: string | null;
  briefId: string | null;
  kind: RequestKind;
  title: string;
  spec: RequestSpec;
  due: string | null;
  assigneeId: string | null;
  taskId: string | null;
  state: RequestState;
  assetId: string | null;
  deliveredVersion: number | null;
  measured: ImageInfo | null;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
}
interface Row extends Omit<AssetRequest, 'spec' | 'measured'> {
  spec: string;
  measured: string | null;
}
const COLS = `id, project_id AS projectId, plan_id AS planId, brief_id AS briefId, kind, title, spec, due, assignee_id AS assigneeId, task_id AS taskId, state, asset_id AS assetId, delivered_version AS deliveredVersion, measured, requested_by AS requestedBy, requested_at AS requestedAt, updated_at AS updatedAt`;
const toRequest = (r: Row): AssetRequest => ({ ...r, spec: JSON.parse(r.spec) as RequestSpec, measured: r.measured ? (JSON.parse(r.measured) as ImageInfo) : null });
const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string, reasons: string[] = []): never => {
  throw new WorkError(code, m, reasons);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});

const posInt = (v: unknown, what: string, max = 20_000): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) return fail('invalid', `${what} is a whole number of pixels from 1.`);
  return v as number;
};
export function cleanSpec(s: unknown): RequestSpec {
  const o = (s ?? {}) as RequestSpec;
  const out: RequestSpec = {};
  const w = posInt(o.width, 'The width');
  const h = posInt(o.height, 'The height');
  const mw = posInt(o.minWidth, 'The least width');
  const mh = posInt(o.minHeight, 'The least height');
  if (w) out.width = w;
  if (h) out.height = h;
  if (mw) out.minWidth = mw;
  if (mh) out.minHeight = mh;
  if (o.formats !== undefined) {
    const known = ['jpeg', 'png', 'gif', 'webp', 'tiff', 'psd', 'svg'];
    if (!Array.isArray(o.formats) || o.formats.some((f) => !known.includes(f))) fail('invalid', `The formats are among: ${known.join(', ')}.`);
    if (o.formats.length) out.formats = [...new Set(o.formats)];
  }
  if (o.maxBytes !== undefined && o.maxBytes !== null) {
    if (!Number.isInteger(o.maxBytes) || o.maxBytes < 1) fail('invalid', 'The most bytes is a whole number from 1.');
    out.maxBytes = o.maxBytes;
  }
  if (typeof o.channel === 'string' && o.channel.trim()) out.channel = o.channel.trim().slice(0, 100);
  return out;
}
const describeSpec = (s: RequestSpec): string =>
  [s.width && s.height ? `${s.width} × ${s.height} pixels` : s.width ? `${s.width} pixels wide` : s.height ? `${s.height} pixels tall` : '', s.minWidth ? `at least ${s.minWidth} wide` : '', s.minHeight ? `at least ${s.minHeight} tall` : '', s.formats?.length ? s.formats.map((f) => f.toUpperCase()).join(' or ') : '', s.maxBytes ? `at most ${Math.round(s.maxBytes / 1024)} KB` : ''].filter(Boolean).join(', ') || 'no particular size';

/** How a file's header measures against a spec: each shortfall as what was found and what was wanted. Empty means it meets it. */
export function checkSpec(spec: RequestSpec, info: ImageInfo): string[] {
  const out: string[] = [];
  const size = `${info.width} × ${info.height} pixels`;
  if (spec.width && info.width !== spec.width) out.push(`Found ${size}; wanted ${spec.width} pixels wide.`);
  if (spec.height && info.height !== spec.height) out.push(`Found ${size}; wanted ${spec.height} pixels tall.`);
  if (spec.minWidth && info.width < spec.minWidth) out.push(`Found ${info.width} pixels wide; wanted at least ${spec.minWidth}.`);
  if (spec.minHeight && info.height < spec.minHeight) out.push(`Found ${info.height} pixels tall; wanted at least ${spec.minHeight}.`);
  if (spec.formats?.length && !spec.formats.includes(info.format)) out.push(`Found ${info.format.toUpperCase()}; wanted ${spec.formats.map((f) => f.toUpperCase()).join(' or ')}.`);
  if (spec.maxBytes && info.bytes > spec.maxBytes) out.push(`Found ${Math.round(info.bytes / 1024)} KB; wanted at most ${Math.round(spec.maxBytes / 1024)} KB.`);
  return out;
}

export async function getRequest(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<AssetRequest | null> {
  const r = await db.first<Row>(`SELECT ${COLS} FROM asset_request WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toRequest(r) : null;
}
export interface RequestFilter {
  projectId?: string;
  projectIds?: string[];
  planId?: string;
  assigneeId?: string;
  /** 'live' (the default: not cancelled), a state, or 'any'. */
  state?: RequestState | 'live' | 'any';
}
export async function listRequests(db: Db, c: Pick<Ctx, 'studioId'>, f: RequestFilter = {}): Promise<AssetRequest[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.planId) (where.push('plan_id = ?'), params.push(f.planId));
  if (f.assigneeId) (where.push('assignee_id = ?'), params.push(f.assigneeId));
  const state = f.state ?? 'live';
  if (state === 'live') where.push("state <> 'cancelled'");
  else if (state !== 'any') (where.push('state = ?'), params.push(state));
  return (await db.all<Row>(`SELECT ${COLS} FROM asset_request WHERE ${where.join(' AND ')} ORDER BY due IS NULL, due, requested_at`, params)).map(toRequest);
}

export interface NewRequest {
  projectId: string;
  planId?: string | null;
  briefId?: string | null;
  kind: RequestKind;
  title: string;
  spec?: RequestSpec;
  due?: string | null;
  assigneeId?: string | null;
}
/** Asks for something. It is also a task for whoever it is given to, so it shows in their plan. */
export async function createRequest(db: Db, c: Ctx, i: NewRequest): Promise<AssetRequest> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A book is needed.');
  if (!(REQUEST_KINDS as readonly string[]).includes(i.kind)) fail('invalid', `A request is for one of: ${REQUEST_KINDS.join(', ')}.`);
  const title = typeof i.title === 'string' ? i.title.trim() : '';
  if (!title) fail('invalid', 'The request needs a title.');
  if (title.length > 200) fail('invalid', 'The title is too long (200 characters at most).');
  const spec = cleanSpec(i.spec);
  if (i.briefId) {
    const b = await db.first<{ id: string }>('SELECT id FROM brief WHERE id = ? AND studio_id = ?', [i.briefId, c.studioId]);
    if (!b) return fail('not-found', 'That brief is not there.');
  }
  const task = await createTask(db, c, { projectId: i.projectId, title: `Campaign art: ${title}`, due: i.due ?? null, assigneeId: i.assigneeId ?? null, notes: `Wanted: ${describeSpec(spec)}.${spec.channel ? ` For ${spec.channel}.` : ''}` });
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO asset_request (id, studio_id, project_id, plan_id, brief_id, kind, title, spec, due, assignee_id, task_id, state, requested_by, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)", params: [id, c.studioId, i.projectId, i.planId ?? null, i.briefId ?? null, i.kind, title, JSON.stringify(spec), task.due, i.assigneeId ?? null, task.id, c.actor, c.now, c.now] },
    audit(c, 'launch.request_create', id, { projectId: i.projectId, kind: i.kind, title })
  ]);
  return (await getRequest(db, c, id))!;
}

/**
 * Offers an asset's version against a request. `info` is what the file's header says (the caller measured it). A file that does not meet the spec is
 * refused, with what was found and what was wanted; the request stays open.
 */
export async function deliverRequest(db: Db, c: Ctx, id: string, d: { assetId: string; version: number; info: ImageInfo }): Promise<AssetRequest> {
  const q = await getRequest(db, c, id);
  if (!q) return fail('not-found', 'That request is not there.');
  if (q.state === 'cancelled') return fail('conflict', 'That request was cancelled.');
  const a = await getAsset(db, c, d.assetId);
  if (!a) return fail('not-found', 'That asset is not there.');
  if (a.projectId !== q.projectId) return fail('invalid', 'That asset belongs to another book.');
  const v = await db.first<{ n: number }>('SELECT n FROM file_version WHERE file_id = ? AND n = ?', [a.fileId, d.version]);
  if (!v) return fail('not-found', 'That version of the asset is not there.');
  const problems = checkSpec(q.spec, d.info);
  if (problems.length) return fail('invalid', `That file does not meet what was asked for (${describeSpec(q.spec)}). ${problems.join(' ')}`, problems);
  await db.batch([
    { sql: "UPDATE asset_request SET state = 'delivered', asset_id = ?, delivered_version = ?, measured = ?, updated_at = ? WHERE id = ? AND studio_id = ?", params: [a.id, d.version, JSON.stringify(d.info), c.now, id, c.studioId] },
    audit(c, 'launch.request_deliver', id, { assetId: a.id, version: d.version, measured: `${d.info.width}×${d.info.height} ${d.info.format}` })
  ]);
  return (await getRequest(db, c, id))!;
}

export interface RequestView {
  request: AssetRequest;
  /** Delivered, meets the spec as measured, and that version of the asset is approved. */
  fulfilled: boolean;
  /** What is still missing, in words. */
  reasons: string[];
}
export async function requestView(db: Db, c: Pick<Ctx, 'studioId'>, q: AssetRequest): Promise<RequestView> {
  if (q.state === 'cancelled') return { request: q, fulfilled: false, reasons: ['Cancelled.'] };
  if (q.state !== 'delivered' || !q.assetId || q.deliveredVersion === null) return { request: q, fulfilled: false, reasons: [`Nothing has been delivered yet (${describeSpec(q.spec)}).`] };
  const approved = approvedVersions(await approvalsOf(db, c, q.assetId));
  if (!approved.some((a) => a.version === q.deliveredVersion)) return { request: q, fulfilled: false, reasons: [`Version ${q.deliveredVersion} was delivered and is waiting to be approved.`] };
  return { request: q, fulfilled: true, reasons: [] };
}
/** Fulfilment of each request by id, with its title: what a plan's "campaign art" item is judged by. */
export async function requestFacts(db: Db, c: Pick<Ctx, 'studioId'>, ids: string[]): Promise<Record<string, { fulfilled: boolean; title: string }>> {
  const out: Record<string, { fulfilled: boolean; title: string }> = {};
  for (const id of ids) {
    const q = await getRequest(db, c, id);
    if (q) out[id] = { fulfilled: (await requestView(db, c, q)).fulfilled, title: q.title };
  }
  return out;
}
/** Marks the request's task done once it is fulfilled (never reopens it). */
export async function syncRequest(db: Db, c: Ctx, id: string): Promise<boolean> {
  const q = await getRequest(db, c, id);
  if (!q?.taskId) return false;
  const v = await requestView(db, c, q);
  const t = await getTask(db, c, q.taskId);
  if (v.fulfilled && t?.state === 'open') {
    await setTaskState(db, c, q.taskId, 'done');
    return true;
  }
  return false;
}
export async function cancelRequest(db: Db, c: Ctx, id: string, reason: string): Promise<AssetRequest> {
  const q = await getRequest(db, c, id);
  if (!q) return fail('not-found', 'That request is not there.');
  if (q.state === 'cancelled') return q;
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) return fail('invalid', 'A reason is needed.');
  await db.batch([
    { sql: "UPDATE asset_request SET state = 'cancelled', updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, id, c.studioId] },
    ...(q.taskId ? [{ sql: "UPDATE task SET state = 'cancelled', updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [c.now, c.actor, q.taskId, c.studioId] }] : []),
    audit(c, 'launch.request_cancel', id, { reason: why })
  ]);
  return (await getRequest(db, c, id))!;
}
