import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkError, ProjectError, ancestorsOf, encodePng, getProject, imageInfo, licenceDaysLeft, pathOf, psdComposite, subtreeIds, type ProjectTree, type VaultStore } from '@cadrel/kernel';
import { PermissionDenied, type StudioService } from '@cadrel/service';
import type { BlobStore } from '@cadrel/store';
import type { Studio } from '@cadrel/studio';
import { agentFromClient } from '@cadrel/write/mcp/server';
import type { McpModule } from '../server.js';
import { STUDIO_HINT } from '@cadrel/write/src/shared/agent/tools';

export const ART_INSTRUCTIONS =
  'These tools are for the studio\'s art (covers, banners, ad art and other design files) and for the results of Preflight, the check an EPUB goes through before upload. ' +
  'asset_list and asset_read show what the studio holds and which exact version is approved; asset_read can show you the picture. asset_where_used says what uses an asset. brief_read gives the cover and art briefs. ' +
  'asset_comment pins a note to a region of a picture at an exact version. preflight_read gives the latest graded results for an EPUB, each with what was measured and what was expected. ' +
  'You cannot approve a version, choose a concept, retire an asset, run or waive a Preflight result: those are people\'s decisions, made in Cadrel. Never say a version is approved unless asset_read says so, and never promise an upload will be accepted: Preflight lists what it checked and what it did not.';

export interface ArtToolOptions {
  service: StudioService;
  personId: string;
  studio: Studio;
  vault: Pick<VaultStore, 'list' | 'versions'>;
  /** Where the contents of every version are kept. Without it a picture cannot be shown. */
  blobs?: BlobStore;
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof PermissionDenied || e instanceof WorkError || e instanceof ProjectError) return failure(e.message);
    if (e instanceof Error && /^(There is|That |This computer|The text|Quote|A region|The Studio|The feedback)/.test(e.message)) return failure(e.message);
    throw e;
  }
}
const IMAGE_MAX = 6 * 1024 * 1024;

export function artModule(o: ArtToolOptions): McpModule {
  return { id: 'art', title: 'Art, assets and Preflight', instructions: ART_INSTRUCTIONS, register: (server) => registerArtTools(server, o) };
}

export function registerArtTools(server: McpServer, o: ArtToolOptions): void {
  const as = () => o.service.as(o.personId);
  const agent = () => agentFromClient(server.server.getClientVersion()?.name).agentName;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const allowed = async () => {
    if (!(await as().canOn('assistant.use'))) throw new PermissionDenied('assistant.use', 'your role does not include using the assistant');
    await as().assistant.check(); // and the Studio has not turned the assistant off (its security policy)
  };
  const viaAssistant = async (tool: string, target: string) => as().assistant.note(tool, agent(), target);
  const resolveProject = (t: ProjectTree, ref: string): string => {
    if (getProject(t, ref)) return ref;
    const want = ref.split('/').map((s) => s.trim().toLowerCase());
    const hits = t.projects.filter((p) => {
      const path = [...ancestorsOf(t, p.id), p].map((x) => x.name.toLowerCase());
      return path.length >= want.length && want.every((w, i) => path[path.length - want.length + i] === w);
    });
    if (hits.length === 1) return hits[0]!.id;
    throw new Error(hits.length ? `There is more than one project "${ref}". Use a fuller path or the id.` : `There is no project "${ref}". Use studio_projects to see the names.${STUDIO_HINT}`);
  };
  const filePaths = async () => new Map((await o.vault.list()).map((f) => [f.id, f.path] as const));
  const people = async () => as().people.list().catch(() => [{ id: o.personId, name: 'me' }]);
  const nameOf = (list: { id: string; name: string }[], id: string) => (id === o.personId ? 'me' : list.find((p) => p.id === id)?.name ?? id);
  /** An asset by its id, or its name inside a project. */
  const findAsset = async (ref: string, project?: string) => {
    const direct = await as().assets.get(ref).catch(() => null);
    if (direct) return direct;
    const { tree } = await o.studio.read();
    const ids = project ? subtreeIds(tree, resolveProject(tree, project)) : undefined;
    const hits = (await as().assets.list({ projectIds: ids })).filter((a) => a.name.toLowerCase() === ref.trim().toLowerCase() || a.name.toLowerCase().includes(ref.trim().toLowerCase()));
    const exact = hits.filter((a) => a.name.toLowerCase() === ref.trim().toLowerCase());
    const pick = exact.length === 1 ? exact : hits;
    if (pick.length !== 1) throw new Error(pick.length ? `More than one asset matches "${ref}". Use its id (asset_list shows them).` : `There is no asset "${ref}", or your role cannot see it. Use asset_list.`);
    return pick[0]!;
  };

  server.registerTool(
    'asset_list',
    {
      description: 'The studio\'s art assets, with what each is for, its state, which versions are approved, its newest version and its licence. `project` limits it to a book or series (its id, name or path); `kind` to covers, banners and so on.',
      inputSchema: { project: z.string().optional(), kind: z.enum(['cover', 'banner', 'ad', 'interior', 'character', 'map', 'other']).optional(), state: z.enum(['live', 'draft', 'in_review', 'approved', 'retired', 'any']).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const ids = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
        const assets = await as().assets.list({ projectIds: ids, kind: a.kind, state: a.state ?? 'live' });
        const paths = await filePaths();
        const files = new Map((await o.vault.list()).map((f) => [f.id, f] as const));
        const now = new Date().toISOString();
        return Promise.all(
          assets.map(async (x) => {
            const approved = await as().assets.approved(x.id);
            return {
              id: x.id, name: x.name, kind: x.kind, state: x.state, book: pathOf(tree, x.projectId), file: paths.get(x.fileId), newestVersion: files.get(x.fileId)?.currentVersion,
              approvedVersions: approved.map((r) => r.version), licence: x.licence.kind || x.licence.expires ? { kind: x.licence.kind || undefined, licensor: x.licence.licensor || undefined, expires: x.licence.expires ?? undefined, daysLeft: licenceDaysLeft(x.licence, now) ?? undefined } : undefined
            };
          })
        );
      })
  );

  server.registerTool(
    'asset_read',
    {
      description: 'One asset: its approvals (who approved which exact version and when), its licence, and what it is used for. With `picture` it also shows you the image of one version (the newest by default; a Photoshop file shows the picture saved inside it). Say which version you looked at.',
      inputSchema: { asset: z.string().describe('The asset\'s id, or its name.'), project: z.string().optional(), version: z.number().int().min(1).optional(), picture: z.boolean().optional() },
      annotations: readOnly
    },
    async (a) => {
      try {
        await allowed();
        const x = await findAsset(a.asset, a.project);
        const { tree } = await o.studio.read();
        const [approvals, names, files] = await Promise.all([as().assets.approvals(x.id), people(), o.vault.list()]);
        const file = files.find((f) => f.id === x.fileId);
        const version = a.version ?? file?.currentVersion ?? 1;
        const info = {
          id: x.id, name: x.name, kind: x.kind, state: x.state, book: pathOf(tree, x.projectId), file: file?.path, newestVersion: file?.currentVersion, version,
          approvals: approvals.map((r) => ({ version: r.version, state: r.state, by: nameOf(names, r.decidedBy), at: r.decidedAt.slice(0, 10), note: r.note || undefined })),
          licence: x.licence, picture: undefined as string | undefined
        };
        const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
        if (a.picture) {
          const v = o.blobs ? (await o.vault.versions(x.fileId)).find((s) => s.n === version) : undefined;
          const bytes = v && o.blobs ? await o.blobs.get(v.hash) : null;
          const im = bytes ? imageInfo(bytes) : null;
          if (!bytes) info.picture = 'That version is not on this computer. Open it from Files in Cadrel (Get latest) first.';
          else if (!im) info.picture = 'This file is not a picture.';
          else if (im.format === 'psd') {
            const px = bytes.length < 300 * 1024 * 1024 ? psdComposite(bytes, 1000) : null;
            if (px) content.push({ type: 'image', data: Buffer.from(encodePng(px)).toString('base64'), mimeType: 'image/png' });
            else info.picture = 'This Photoshop file carries no flattened picture to show.';
          } else if (['jpeg', 'png', 'gif', 'webp'].includes(im.format) && bytes.length <= IMAGE_MAX) content.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: `image/${im.format}` });
          else info.picture = `This ${im.format.toUpperCase()} (${im.width} × ${im.height} pixels, ${Math.round(bytes.length / 1024)} KB) cannot be shown here.`;
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }, ...content] };
      } catch (e) {
        if (e instanceof PermissionDenied || e instanceof WorkError) return failure(e.message);
        if (e instanceof Error && /^(There is|That |More than)/.test(e.message)) return failure(e.message);
        throw e;
      }
    }
  );

  server.registerTool(
    'asset_where_used',
    {
      description: 'What uses an asset: the listings, ads and banners someone recorded, whether each shows the right version or needs updating, and the files in the vault (an EPUB) that reference it.',
      inputSchema: { asset: z.string(), project: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const x = await findAsset(a.asset, a.project);
        const w = await as().assets.whereUsed(x.id);
        return { asset: x.name, declared: w.declared.map((u) => ({ what: u.label, kind: u.userKind, version: u.version ?? 'the latest approved', state: u.state })), files: w.files.map((f) => ({ file: f.path, version: f.version ?? 'the latest' })) };
      })
  );

  server.registerTool(
    'brief_read',
    {
      description: 'The studio\'s cover and art briefs for a project: each with its newest text and the concepts offered against it (which exact file version, and where each stands). Give a `brief` id or title to read one with all its versions.',
      inputSchema: { project: z.string().optional(), brief: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const ids = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
        const briefs = [...(await as().briefs.list({ kind: 'cover', projectIds: ids })), ...(await as().briefs.list({ kind: 'art', projectIds: ids }))];
        const want = a.brief?.trim().toLowerCase();
        const shown = want ? briefs.filter((b) => b.id === a.brief || b.title.toLowerCase().includes(want)) : briefs;
        if (want && shown.length !== 1) throw new Error(shown.length ? `More than one brief matches "${a.brief}". Use its id.` : `There is no brief "${a.brief}", or your role cannot see it.`);
        const paths = await filePaths();
        return Promise.all(
          shown.map(async (b) => {
            const concepts = await as().assets.concepts(b.id).catch(() => []);
            return {
              id: b.id, kind: b.kind, title: b.title, book: pathOf(tree, b.projectId), version: b.current.n, brief: b.current.body,
              earlier: want ? (await as().briefs.versions(b.id)).filter((v) => v.n !== b.current.n).map((v) => ({ version: v.n, brief: v.body, note: v.note || undefined })) : undefined,
              concepts: concepts.map((c) => ({ id: c.id, file: paths.get(c.fileId), fileVersion: c.fileVersion, againstBriefVersion: c.briefVersion, state: c.state, note: c.note || undefined }))
            };
          })
        );
      })
  );

  server.registerTool(
    'asset_comment',
    {
      description: 'Pins a note to an asset (or a concept) at an exact version, optionally to a region of the picture given as fractions of its width and height (x, y from the top left; w, h the size). Say what you see and what you would change. A person decides what to do with it.',
      inputSchema: {
        kind: z.enum(['asset', 'concept']),
        id: z.string().describe('The asset\'s or concept\'s id.'),
        version: z.number().int().min(1).optional().describe('The file version you looked at (the newest by default).'),
        region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) }).optional(),
        text: z.string().min(1).max(2000)
      },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const f = await as().assets.comment({ targetKind: a.kind, targetId: a.id, ...(a.version ? { fileVersion: a.version } : {}), ...(a.region ? { region: a.region } : {}), body: a.text });
        await viaAssistant('asset_comment', a.id);
        return { comment: f.id, onVersion: f.fileVersion, pinned: !!f.region };
      })
  );

  server.registerTool(
    'preflight_read',
    {
      description: 'The latest Preflight result for an EPUB in the vault (by its path or id), or the latest for each EPUB in a project: errors, warnings and suggestions, each saying where, what was measured and what the rule expects, with the rule pack\'s date and what it does not check. You cannot run Preflight or waive a result; a person does that in Cadrel.',
      inputSchema: { file: z.string().optional().describe('The EPUB\'s path in the vault, or its id.'), project: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const files = await o.vault.list();
        let runs;
        if (a.file) {
          const want = a.file.trim().toLowerCase().replace(/\\/g, '/');
          const hits = files.filter((f) => f.id === a.file || f.path.toLowerCase() === want || f.path.toLowerCase().endsWith(`/${want}`));
          if (hits.length !== 1) throw new Error(hits.length ? `More than one file matches "${a.file}". Give its full path.` : `There is no file "${a.file}" in the vault. Use files_list to see the paths.`);
          runs = [await as().preflight.latest({ fileId: hits[0]!.id })];
        } else {
          const ids = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
          const all = await as().preflight.list({ projectIds: ids, limit: 200 });
          const seen = new Set<string>();
          runs = all.filter((r) => (seen.has(r.fileId) ? false : (seen.add(r.fileId), true)));
        }
        const out = [];
        for (const r of runs.filter((x): x is NonNullable<typeof x> => !!x)) {
          const g = await as().preflight.get(r.id);
          if (!g) continue;
          out.push({
            file: files.find((f) => f.id === r.fileId)?.path, fileVersion: r.fileVersion, book: pathOf(tree, r.projectId), checkedAt: r.at.slice(0, 10), ready: r.ready, rules: `${r.packId} version ${r.packVersion}, limits last read from the retailer ${r.packVerified || 'never'}`,
            counts: { errors: r.errors, warnings: r.warnings, suggestions: r.suggestions }, notChecked: r.notChecked,
            results: g.results.map((x) => ({ grade: x.grade, rule: x.ruleId, what: x.what, where: x.location || undefined, measured: x.measured || undefined, expected: x.expected || undefined, waived: x.state === 'waived' ? x.waivedReason : undefined }))
          });
        }
        if (!out.length) return { note: 'No Preflight run has been made for that yet. A person runs it from the Preflight page in Cadrel.' };
        return out;
      })
  );
}
