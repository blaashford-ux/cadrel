/**
 * Art and assets as the Art page sees them (docs/M5-PLAN.md): the assets of the project in view with their approvals, licences and uses, the
 * cover and art briefs with the concepts offered against them, and a picture of any version of a file. Electron-free; tested in test/art.test.ts.
 *
 * Who may do what is the service's to say, not this file's: every change goes through it and a refusal comes back as it is. What this adds is
 * what the page needs to arrange itself, and names for people.
 */
import {
  imageInfo, licenceDaysLeft, licenceExpired, psdComposite, encodePng, subtreeIds, type Asset, type FileVersion, type ProjectTree
} from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import {
  ART_CALLS, type ArtBriefRow, type ArtCallName, type ArtCandidate, type ArtMay, type ArtState, type AssetRow, type AssetView, type BriefView, type ConceptRow, type FeedbackRow, type PreviewView
} from '../shared/api';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';

export class ArtError extends Error {}

/** What the page needs from the vault. Given by the vault host (see vaultHost.ts). */
export interface ArtFiles {
  files(): Promise<{ fileId: string; path: string; version: number; projectId: string | null; size: number | null }[]>;
  bytesOf(fileId: string, version: number): Promise<Uint8Array>;
  versionsOf(fileId: string): Promise<FileVersion[]>;
}

/** Files an Art Director would put in the asset register: pictures and design files, not manuscripts or exports. */
export const DESIGN_FILE = /\.(png|jpe?g|gif|webp|tiff?|psd|psb|ai|svg|indd|eps|xcf|kra|afdesign|afphoto)$/i;
const PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
const PSD_MAX_BYTES = 300 * 1024 * 1024;
const LICENCE_SOON_DAYS = 60;

export class Art {
  constructor(private readonly studio: StudioService, private readonly people: PeopleHost, private readonly files: ArtFiles | null = null) {}

  private as() {
    const svc = this.people.service;
    return svc ? svc.as(this.people.me) : null;
  }
  private need() {
    const as = this.as();
    if (!as) throw new ArtError('Art for this Studio is managed by its owner.');
    return as;
  }
  private async names(): Promise<Map<string, string>> {
    return new Map((await this.people.peopleList().catch(() => [] as { id: string; name: string }[])).map((p) => [p.id, p.name]));
  }
  private nameOf(names: Map<string, string>, id: string): string {
    return id === this.people.me ? 'you' : names.get(id) ?? 'someone';
  }
  private async may(projectId: string): Promise<ArtMay> {
    const m = (c: string) => this.people.mayOn(c, projectId).catch(() => false);
    const [read, write, comment, approve, manage, brief] = await Promise.all([m('asset.read'), m('asset.write'), m('asset.comment'), m('asset.approve'), m('asset.manage'), m('brief.write')]);
    return { read, write, comment, approve, manage, brief };
  }

  // ---- the project's assets -----------------------------------------------------------------------------------------------

  async state(projectRef?: string): Promise<ArtState> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Art for this Studio is managed by its owner.' };
    try {
      const tree = await this.studio.tree();
      const project = this.project(tree, projectRef);
      if (!project) return { available: false, reason: projectRef ? 'That project is not there.' : tree.projects.length ? 'Pick a project to see its art.' : 'There are no projects yet.' };
      const may = await this.may(project.id);
      if (!may.read) return { available: false, reason: 'Your role does not let you see the art of this project.' };
      const ids = subtreeIds(tree, project.id);
      const [assets, covers, arts, vault, names] = await Promise.all([
        as.assets.list({ projectIds: ids }),
        as.briefs.list({ kind: 'cover' }),
        as.briefs.list({ kind: 'art' }),
        this.files ? this.files.files() : Promise.resolve([]),
        this.names()
      ]);
      const byFile = new Map(vault.map((f) => [f.fileId, f]));
      const rows = await Promise.all(assets.map((a) => this.row(as, tree, a, byFile, names)));
      const taken = new Set(assets.map((a) => a.fileId));
      const inside = new Set(ids);
      const candidates: ArtCandidate[] = vault
        .filter((f) => !taken.has(f.fileId) && !!f.projectId && inside.has(f.projectId) && DESIGN_FILE.test(f.path))
        .map((f) => ({ fileId: f.fileId, path: f.path, version: f.version }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const briefs: ArtBriefRow[] = [];
      for (const b of [...covers, ...arts].filter((x) => inside.has(x.projectId))) {
        const concepts = await as.assets.concepts(b.id).catch(() => []);
        briefs.push({ id: b.id, title: b.title, kind: b.kind as 'cover' | 'art', version: b.current.n, concepts: concepts.length, chosen: concepts.some((c) => c.state === 'chosen'), updatedAt: b.current.writtenAt });
      }
      briefs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const licencesDue = rows
        .filter((r) => r.state !== 'retired' && r.licenceDaysLeft !== null && r.licenceDaysLeft <= LICENCE_SOON_DAYS)
        .map((r) => ({ assetId: r.id, name: r.name, days: r.licenceDaysLeft! }))
        .sort((a, b) => a.days - b.days);
      return { available: true, me: this.people.me, project: { id: project.id, name: project.name }, may, assets: rows, briefs, candidates, licencesDue };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see the art of this project.' };
      throw e;
    }
  }

  private project(tree: ProjectTree, ref?: string) {
    if (ref) return tree.projects.find((p) => p.id === ref && p.status !== 'archived') ?? null;
    return tree.projects.filter((p) => !p.parentId && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
  }

  private async row(as: NonNullable<ReturnType<Art['as']>>, tree: ProjectTree, a: Asset, byFile: Map<string, { path: string; version: number }>, names: Map<string, string>): Promise<AssetRow> {
    const [approved, uses, feedback] = await Promise.all([as.assets.approved(a.id), as.assets.uses(a.id), as.assets.feedback('asset', a.id)]);
    const file = byFile.get(a.fileId);
    const latest = file?.version ?? 0;
    const now = approved.length ? approved[approved.length - 1]!.version : null;
    return {
      ...a,
      projectName: tree.projects.find((p) => p.id === a.projectId)?.name ?? '',
      path: file?.path ?? '',
      latestVersion: latest,
      approved: approved.map((r) => ({ version: r.version, hash: r.hash, at: r.decidedAt, byName: this.nameOf(names, r.decidedBy) })),
      approvedNow: now,
      licenceDaysLeft: licenceDaysLeft(a.licence, new Date().toISOString()),
      licenceExpired: licenceExpired(a.licence, new Date().toISOString()),
      needUpdate: uses.filter((u) => u.state === 'needs_update').length,
      uses: uses.length,
      openFeedback: feedback.filter((f) => f.state === 'open').length,
      newerThanApproved: now !== null && latest > now
    };
  }

  /** One asset with its versions, approvals, uses, replacements and feedback. */
  async asset(id: string): Promise<AssetView> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Art for this Studio is managed by its owner.' };
    try {
      const a = await as.assets.get(String(id));
      if (!a) return { available: false, reason: 'That asset is not there.' };
      const [tree, vault, names, approvals, where, replacements, feedback, may] = await Promise.all([
        this.studio.tree(),
        this.files ? this.files.files() : Promise.resolve([]),
        this.names(),
        as.assets.approvals(a.id),
        as.assets.whereUsed(a.id),
        as.assets.replacements(a.id),
        as.assets.feedback('asset', a.id),
        this.may(a.projectId)
      ]);
      const row = await this.row(as, tree, a, new Map(vault.map((f) => [f.fileId, f])), names);
      const standing = new Set(row.approved.map((r) => r.version));
      const versions = this.files ? (await this.files.versionsOf(a.fileId)).map((v) => ({ n: v.n, hash: v.hash, at: v.createdAt, byName: this.nameOf(names, v.author), comment: v.comment, approved: standing.has(v.n) })) : [];
      return {
        available: true,
        asset: row,
        may,
        versions,
        approvals: approvals.map((r) => ({ ...r, byName: this.nameOf(names, r.decidedBy) })),
        uses: where.declared,
        fileUses: where.files,
        replacements: replacements.map((r) => ({ ...r, proposerName: this.nameOf(names, r.proposedBy) })),
        feedback: feedback.map((f) => ({ ...f, byName: this.nameOf(names, f.by) }))
      };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see this asset.' };
      throw e;
    }
  }

  // ---- briefs and concepts ------------------------------------------------------------------------------------------------

  async brief(id: string): Promise<BriefView> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Art for this Studio is managed by its owner.' };
    try {
      const b = await as.briefs.get(String(id));
      if (!b || (b.kind !== 'cover' && b.kind !== 'art')) return { available: false, reason: 'That brief is not there.' };
      const [versions, concepts, names, vault, tree, may] = await Promise.all([
        as.briefs.versions(b.id),
        as.assets.concepts(b.id),
        this.names(),
        this.files ? this.files.files() : Promise.resolve([]),
        this.studio.tree(),
        this.may(b.projectId)
      ]);
      const path = new Map(vault.map((f) => [f.fileId, f.path]));
      const rows: ConceptRow[] = await Promise.all(
        concepts.map(async (c) => ({
          ...c,
          path: path.get(c.fileId) ?? '',
          byName: this.nameOf(names, c.submittedBy),
          feedback: (await as.assets.feedback('concept', c.id)).map((f): FeedbackRow => ({ ...f, byName: this.nameOf(names, f.by) }))
        }))
      );
      const inside = new Set(subtreeIds(tree, b.projectId));
      const taken = new Set(concepts.map((c) => `${c.fileId}:${c.fileVersion}`));
      const candidates = vault.filter((f) => !!f.projectId && inside.has(f.projectId) && DESIGN_FILE.test(f.path) && !taken.has(`${f.fileId}:${f.version}`)).map((f) => ({ fileId: f.fileId, path: f.path, version: f.version })).sort((x, y) => x.path.localeCompare(y.path));
      const sorted = [...versions].sort((x, y) => y.n - x.n);
      return {
        available: true,
        brief: { id: b.id, title: b.title, kind: b.kind as 'cover' | 'art', projectId: b.projectId, version: b.current.n, body: b.current.body, note: b.current.note, writtenAt: b.current.writtenAt, writtenByName: this.nameOf(names, b.current.writtenBy) },
        versions: sorted.map((v) => ({ n: v.n, body: v.body, note: v.note, writtenAt: v.writtenAt, writtenByName: this.nameOf(names, v.writtenBy) })),
        concepts: rows,
        may,
        candidates
      };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see this brief.' };
      throw e;
    }
  }

  // ---- changes -----------------------------------------------------------------------------------------------------------------

  /** One change, by name. A list, so inherited names such as `constructor` are not reachable. */
  async call(name: string, args: unknown[]): Promise<unknown> {
    if (!(ART_CALLS as readonly string[]).includes(name)) throw new ArtError('That is not something the Art page can do.');
    const as = this.need();
    const a = args as never[];
    const n = name as ArtCallName;
    switch (n) {
      case 'create': return as.assets.create(a[0]);
      case 'update': return as.assets.update(String(a[0]), a[1]);
      case 'submit': return as.assets.submit(String(a[0]));
      case 'retire': return as.assets.retire(String(a[0]), a[1]);
      case 'approve': return as.assets.approve(String(a[0]), a[1], a[2]);
      case 'revoke': return as.assets.revoke(String(a[0]), a[1], a[2]);
      case 'addUse': return as.assets.addUse(String(a[0]), a[1]);
      case 'setUseState': return as.assets.setUseState(String(a[0]), a[1]);
      case 'proposeReplacement': return as.assets.proposeReplacement(String(a[0]), a[1]);
      case 'decideReplacement': return as.assets.decideReplacement(String(a[0]), a[1]);
      case 'withdrawReplacement': return as.assets.withdrawReplacement(String(a[0]));
      case 'comment': return as.assets.comment(a[0]);
      case 'resolveFeedback': return as.assets.resolveFeedback(String(a[0]));
      case 'createBrief': {
        const i = a[0] as { projectId: string; kind: string; title: string; body: string };
        if (i?.kind !== 'cover' && i?.kind !== 'art') throw new ArtError('The Art page writes cover and art briefs.');
        return as.briefs.create(i as never);
      }
      case 'reviseBrief': return as.briefs.revise(String(a[0]), a[1]);
      case 'submitConcept': return as.assets.submitConcept(a[0]);
      case 'decideConcept': return as.assets.decideConcept(String(a[0]), a[1], a[2]);
      case 'chooseConcept': return as.assets.chooseConcept(String(a[0]));
    }
  }

  // ---- pictures ----------------------------------------------------------------------------------------------------------------

  /** A picture of one version of a file. The person must be able to read the asset (or a concept) that file is. */
  async preview(fileId: string, version: number): Promise<PreviewView> {
    const as = this.need();
    if (!this.files) return { kind: 'none', reason: 'The files of this Studio are kept by its owner.' };
    const asset = await as.assets.ofFile(String(fileId));
    if (!asset) {
      // not an asset: a concept's file, in a project the person can read assets of
      const vault = await this.files.files();
      const f = vault.find((x) => x.fileId === fileId);
      if (!f?.projectId || !(await this.people.mayOn('asset.read', f.projectId))) return { kind: 'none', reason: 'That file is not there.' };
    }
    const v = Number(version);
    const bytes = await this.files.bytesOf(String(fileId), v).catch(() => null);
    if (!bytes) return { kind: 'none', reason: 'That version is not here yet. Get the latest from the Files page.' };
    return previewOf(bytes);
  }
}

/** What can be shown of a file's bytes: itself if it is a small picture, the composite of a Photoshop file, otherwise only what its header says. */
export function previewOf(bytes: Uint8Array): PreviewView {
  const info = imageInfo(bytes);
  if (!info) return { kind: 'none', reason: 'This kind of file has no picture to show.' };
  const base = { format: info.format, width: info.width || null, height: info.height || null };
  if (info.format === 'psd') {
    if (bytes.length > PSD_MAX_BYTES) return { kind: 'none', reason: 'This Photoshop file is too large to preview here.', ...base };
    const px = psdComposite(bytes, 800);
    if (!px) return { kind: 'none', reason: 'This Photoshop file carries no flattened picture (it was saved without Maximize Compatibility). Link a preview image to it.', ...base };
    const png = encodePng(px);
    return { kind: 'image', mime: 'image/png', dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, ...base, note: 'The picture saved inside the Photoshop file.' };
  }
  if (info.format === 'tiff') return { kind: 'none', reason: 'A TIFF cannot be shown here; its size is below.', ...base };
  if (bytes.length > PREVIEW_MAX_BYTES) return { kind: 'none', reason: 'This picture is too large to preview here.', ...base };
  const mime = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[info.format as 'jpeg'];
  return { kind: 'image', mime, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, ...base };
}
