/**
 * Preflight as the Preflight page sees it (docs/M5-PLAN.md): choose an EPUB in the project in view, check it against the edition's records and
 * the book's approved cover, and keep the graded result. The checking happens here, on the computer that has the file: the EPUB is read, the
 * rules (the kernel's, over facts this reads) judge it, and the service keeps the run. Electron-free; tested in test/preflight.test.ts.
 */
import { createHash } from 'node:crypto';
import {
  KDP_PACK, imageInfo, packAgeMonths, runPreflight, subtreeIds, type ApprovedCoverFacts, type BookFacts, type Finding, type PreflightResult, type PreflightRun, type RulePack
} from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import type { PackInfo, PreflightEdition, PreflightFileRow, PreflightRunView, PreflightState } from '../shared/api';
import type { ArtFiles } from './art';
import { inspectEpub } from './epubInspect';
import { epubcheckInstalled, runEpubcheck, type EpubcheckRunner } from './epubcheck';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';

export class PreflightError extends Error {}

/** What Preflight needs from the vault: the files, their bytes and (for the blurb and keywords) their text. */
export interface PreflightFiles extends ArtFiles {
  textOf(fileId: string, version: number): Promise<string>;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export function packInfo(pack: RulePack, now: string): PackInfo {
  return { id: pack.id, title: pack.title, version: pack.version, verified: pack.verified, ageMonths: packAgeMonths(pack, now), sources: pack.sources, notChecked: pack.notChecked };
}

/** The keywords in a Keywords.md: bullet or numbered lines (the file's own heading and notes are not keywords). Null when there are none. */
export function keywordsOf(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(l)?.[1]).filter((l): l is string => !!l);
  const clean = lines.map((l) => l.replace(/^\*\*|\*\*$/g, '').replace(/^`|`$/g, '').trim()).filter(Boolean);
  return clean.length ? clean : null;
}
/** The sales blurb of a Blurb.md: what comes before its structured block (a rule, or a heading for tropes or details). */
export function blurbOf(text: string): string {
  const cut = text.search(/^\s*(?:-{3,}|#{1,4}\s*(?:tropes|details|structured|metadata|book details)\b.*)$/im);
  return (cut >= 0 ? text.slice(0, cut) : text).replace(/^#{1,6}\s.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export class Preflight {
  constructor(
    private readonly studio: StudioService,
    private readonly people: PeopleHost,
    private readonly files: PreflightFiles | null = null,
    private readonly epubcheck: EpubcheckRunner = runEpubcheck,
    private readonly installed: () => boolean = epubcheckInstalled,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly pack: RulePack = KDP_PACK
  ) {}

  private as() {
    const svc = this.people.service;
    return svc ? svc.as(this.people.me) : null;
  }
  private need() {
    const as = this.as();
    if (!as) throw new PreflightError('Preflight for this Studio is managed by its owner.');
    return as;
  }
  private async names(): Promise<Map<string, string>> {
    return new Map((await this.people.peopleList().catch(() => [] as { id: string; name: string }[])).map((p) => [p.id, p.name]));
  }

  async state(projectRef?: string): Promise<PreflightState> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Preflight for this Studio is managed by its owner.' };
    try {
      const tree = await this.studio.tree();
      const project = projectRef ? tree.projects.find((p) => p.id === projectRef && p.status !== 'archived') : tree.projects.filter((p) => !p.parentId && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name))[0];
      if (!project) return { available: false, reason: projectRef ? 'That project is not there.' : tree.projects.length ? 'Pick a project to check its books.' : 'There are no projects yet.' };
      const [read, run] = await Promise.all([this.people.mayOn('preflight.read', project.id).catch(() => false), this.people.mayOn('preflight.run', project.id).catch(() => false)]);
      if (!read) return { available: false, reason: 'Your role does not let you see Preflight for this project.' };
      const inside = new Set(subtreeIds(tree, project.id));
      const vault = this.files ? await this.files.files() : [];
      const epubs = vault.filter((f) => /\.epub$/i.test(f.path) && !!f.projectId && inside.has(f.projectId)).sort((a, b) => a.path.localeCompare(b.path));
      const rows: PreflightFileRow[] = [];
      for (const f of epubs) rows.push({ fileId: f.fileId, path: f.path, version: f.version, latest: await as.preflight.latest({ fileId: f.fileId }) });
      const editions = await this.editions(as, inside, tree);
      return { available: true, me: this.people.me, project: { id: project.id, name: project.name }, may: { read, run }, files: rows, editions, pack: packInfo(this.pack, this.now()), epubcheck: this.installed() };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see Preflight for this project.' };
      throw e;
    }
  }

  private async editions(as: NonNullable<ReturnType<Preflight['as']>>, inside: Set<string>, tree: Awaited<ReturnType<StudioService['tree']>>): Promise<PreflightEdition[]> {
    try {
      const [links, books] = await Promise.all([as.catalogue.projectLinks(), as.catalogue.books()]);
      const where = new Map(links.map((l) => [l.bookId, l.projectId]));
      const out: PreflightEdition[] = [];
      for (const b of books) {
        const pid = where.get(b.id) ?? null;
        if (!pid || !inside.has(pid)) continue;
        for (const e of b.editions.filter((x) => !x.archivedAt)) out.push({ id: e.id, label: `${b.title}, ${e.format}${e.asin ? ` (${e.asin})` : e.isbn ? ` (${e.isbn})` : ''}`, bookTitle: b.title, projectId: pid });
      }
      void tree;
      return out.sort((a, b) => a.label.localeCompare(b.label));
    } catch {
      return []; // a role without catalogue.read still runs Preflight; the names are not compared
    }
  }

  // ---- a run -------------------------------------------------------------------------------------------------------------------

  async run(fileId: string, editionId: string | null): Promise<PreflightRunView> {
    const as = this.need();
    if (!this.files) throw new PreflightError('The files of this Studio are kept by its owner.');
    const vault = await this.files.files();
    const file = vault.find((f) => f.fileId === String(fileId));
    if (!file) throw new PreflightError('That file is not in the vault.');
    if (!/\.epub$/i.test(file.path)) throw new PreflightError('Preflight checks EPUB files.');
    if (!file.projectId) throw new PreflightError('That file belongs to no project. Give it a project on the Files page first.');
    const bytes = await this.files.bytesOf(file.fileId, file.version).catch(() => null);
    if (!bytes) throw new PreflightError('That version is not on this computer yet. Get the latest from the Files page.');
    const epub = inspectEpub(bytes);
    const tree = await this.studio.tree();
    const inside = subtreeIds(tree, file.projectId);

    const { book, edition, extra } = await this.bookFacts(as, file.projectId, editionId, vault, inside);
    const approved = await this.approvedCover(as, file.projectId);
    const check = await this.epubcheck(bytes);
    const found: Finding[] = [...runPreflight({ epub, book, approvedCover: approved?.facts ?? null }, this.pack), ...extra, ...(check.status === 'used' ? check.findings : [])];
    const notChecked = this.pack.notChecked.filter((n) => !(check.status === 'used' && /epubcheck/i.test(n)));
    const recorded = await as.preflight.record({
      projectId: file.projectId,
      editionId: edition,
      fileId: file.fileId,
      fileVersion: file.version,
      fileHash: sha(bytes),
      coverAssetId: approved?.assetId ?? null,
      coverVersion: approved?.version ?? null,
      metadataHash: sha(JSON.stringify(book)),
      packId: this.pack.id,
      packVersion: this.pack.version,
      packVerified: this.pack.verified,
      notChecked,
      findings: found
    });
    return this.view(recorded.run, recorded.results, check.status === 'used' ? 'used' : check.status === 'failed' ? 'failed' : 'not installed');
  }

  private async bookFacts(as: NonNullable<ReturnType<Preflight['as']>>, projectId: string, editionId: string | null, vault: { fileId: string; path: string; version: number; projectId: string | null }[], inside: string[]) {
    const empty: BookFacts = { title: '', subtitle: '', author: '', series: null, seriesNumber: null, isbn: null, asin: null, language: null, price: null, publishedOn: null, blurb: null, keywords: null };
    const extra: Finding[] = [];
    let book = empty;
    let edition: string | null = null;
    try {
      const [books, series, links] = await Promise.all([as.catalogue.books(), as.catalogue.series(), as.catalogue.projectLinks()]);
      const linked = new Set(links.filter((l) => inside.includes(l.projectId)).map((l) => l.bookId));
      const all = books.flatMap((b) => b.editions.filter((e) => !e.archivedAt).map((e) => ({ b, e })));
      const pick = editionId ? all.find((x) => x.e.id === editionId) : all.find((x) => linked.has(x.b.id) && x.e.format === 'ebook') ?? all.find((x) => linked.has(x.b.id));
      if (editionId && !pick) throw new PreflightError('That edition is not there.');
      if (pick) {
        edition = pick.e.id;
        const s = series.find((x) => x.id === pick.b.seriesId);
        book = { ...empty, title: pick.b.title, subtitle: pick.b.subtitle, author: pick.b.penName, series: s?.name ?? null, seriesNumber: pick.b.position, isbn: pick.e.isbn, asin: pick.e.asin, price: pick.e.price, publishedOn: pick.e.publishedOn };
      }
    } catch (e) {
      if (e instanceof PreflightError) throw e;
    }
    if (!edition) extra.push({ ruleId: 'names.nocatalogue', grade: 'suggestion', what: 'No catalogue edition was chosen or linked to this project, so the EPUB’s names, series and price were not compared with the catalogue.', location: '', measured: 'no edition', expected: 'an edition of this book in the catalogue, linked to its project' });
    // the blurb and the keywords as the marketing files hold them
    const find = (re: RegExp) => vault.filter((f) => re.test(f.path) && !!f.projectId && inside.includes(f.projectId)).sort((a, b) => a.path.length - b.path.length)[0];
    const [blurb, keys] = [find(/(^|\/)Marketing\/Blurb\.md$/i), find(/(^|\/)Marketing\/Keywords\.md$/i)];
    if (this.files && blurb) book = { ...book, blurb: blurbOf(await this.files.textOf(blurb.fileId, blurb.version).catch(() => '')) };
    if (this.files && keys) book = { ...book, keywords: keywordsOf(await this.files.textOf(keys.fileId, keys.version).catch(() => '')) };
    void projectId;
    return { book, edition, extra };
  }

  /** The approved cover of the project: its newest approved version and what that file's header says. */
  private async approvedCover(as: NonNullable<ReturnType<Preflight['as']>>, projectId: string): Promise<{ assetId: string; version: number; facts: ApprovedCoverFacts } | null> {
    try {
      const { assets } = await as.assets.readiness(projectId, 'cover');
      const a = assets[0];
      if (!a || !this.files) return null;
      const bytes = await this.files.bytesOf(a.asset.fileId, a.version).catch(() => null);
      const info = bytes ? imageInfo(bytes) : null;
      return { assetId: a.asset.id, version: a.version, facts: { assetId: a.asset.id, version: a.version, hash: a.hash, format: info?.format ?? null, width: info?.width ?? null, height: info?.height ?? null, colour: info?.colour ?? null, dpi: info?.dpi ?? null, bytes: info?.bytes ?? 0 } };
    } catch {
      return null; // a role that cannot read assets is not told about the cover; the check says there is none
    }
  }

  private async view(run: PreflightRun, results: PreflightResult[], epubcheck: 'used' | 'not installed' | 'failed' | null): Promise<PreflightRunView> {
    const [names, vault] = await Promise.all([this.names(), this.files ? this.files.files() : Promise.resolve([])]);
    const path = vault.find((f) => f.fileId === run.fileId)?.path ?? '';
    let coverPath: string | null = null;
    if (run.coverAssetId) coverPath = (await this.as()?.assets.get(run.coverAssetId).catch(() => null))?.name ?? null;
    let editionLabel: string | null = null;
    if (run.editionId) {
      const tree = await this.studio.tree();
      const as = this.as();
      if (as) editionLabel = (await this.editions(as, new Set(tree.projects.map((p) => p.id)), tree)).find((e) => e.id === run.editionId)?.label ?? null;
    }
    return { available: true, run, results, path, editionLabel, pack: packInfo(this.pack, this.now()), may: { run: await this.people.mayOn('preflight.run', run.projectId).catch(() => false) }, byName: run.runBy === this.people.me ? 'you' : names.get(run.runBy) ?? 'someone', coverPath, epubcheck };
  }

  async get(runId: string): Promise<PreflightRunView> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Preflight for this Studio is managed by its owner.' };
    try {
      const g = await as.preflight.get(String(runId));
      if (!g) return { available: false, reason: 'That run is not there.' };
      return this.view(g.run, g.results, null);
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see Preflight for this project.' };
      throw e;
    }
  }

  async waive(runId: string, seq: number, reason: string): Promise<PreflightRunView> {
    const as = this.need();
    const g = await as.preflight.waive(String(runId), Number(seq), String(reason ?? ''));
    return this.view(g.run, g.results, null);
  }
}
