/**
 * The working views for Home and the Dashboard (docs/GAPS-PLAN.md, slice B): what an Author, an Editor and a Director each want first, worked out
 * from the passes the person may see and the tasks on the plan. Pure: the caller reads the records and passes them in, so this is tested without
 * them. Nothing here widens access: the passes and tasks it is given are already what the service lets this person read.
 */
import { LENS_CAPABILITIES, lensesFor } from '@cadrel/kernel';
import type { EditingPassRow, EditingState, LensAsset, LensDue, LensNotReady, LensPass, LensState, LensViews, PlanState } from '../shared/api';

type Task = Extract<PlanState, { available: true }>['tasks'][number];

const DAY = 86_400_000;
const dayNumber = (isoDate: string): number => Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / DAY);
const between = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

export interface LensInput {
  me: string;
  /** Today as 2026-11-16. */
  today: string;
  passes: EditingPassRow[];
  tasks: Task[];
  /** Canon proposals this person may approve. */
  canonWaiting?: number;
  /** What the person may see of art and Preflight. */
  art?: ArtLensInput;
}
/** What the art views are built from: the assets and briefs the service lets this person read, and the latest Preflight run of each EPUB. */
export interface ArtLensInput {
  assets: { id: string; name: string; projectId: string; projectName: string; state: string; licenceDaysLeft: number | null; needUpdate: number }[];
  briefs: { id: string; title: string; projectId: string; projectName: string; submitted: number; chosen: boolean }[];
  runs: { fileId: string; path: string; projectId: string; projectName: string; errors: number }[];
}

const pass = (p: EditingPassRow, today: string): LensPass => ({
  passId: p.id,
  projectId: p.projectId,
  projectName: p.projectName,
  kind: p.kind,
  title: p.title,
  editorName: p.editorName,
  waitingDays: between(p.deliveredAt ?? p.createdAt, today),
  unanswered: p.unanswered,
  undecided: p.undecided
});
const due = (t: Task, today: string): LensDue => ({ id: t.id, title: t.title, projectId: t.projectId, projectName: t.projectName, due: t.due!, daysLate: between(t.due!, today) });
const longestWait = (a: LensPass, b: LensPass) => (b.waitingDays ?? 0) - (a.waitingDays ?? 0) || a.projectName.localeCompare(b.projectName);

/** Builds the views for the lenses a person holds. A view that is not asked for is not built. */
export function buildLens(lenses: readonly ('director' | 'editor' | 'author' | 'art')[], i: LensInput): LensViews {
  const views: LensViews = {};
  const live = i.passes.filter((p) => p.state !== 'closed' && p.state !== 'cancelled');
  const openTasks = i.tasks.filter((t) => t.state === 'open' && t.due);

  if (lenses.includes('author')) {
    // `next` is what the service says waits on this person, so an Author is shown exactly what they may act on
    const mine = live.filter((p) => p.next === 'answer' || p.next === 'respond');
    views.author = {
      answer: mine.filter((p) => p.next === 'answer').map((p) => pass(p, i.today)).sort(longestWait),
      respond: mine.filter((p) => p.next === 'respond').map((p) => pass(p, i.today)).sort(longestWait),
      tasks: openTasks.filter((t) => t.assigneeId === i.me && between(i.today, t.due!) <= 7).map((t) => due(t, i.today)).sort((a, b) => b.daysLate - a.daysLate)
    };
  }

  if (lenses.includes('editor')) {
    const mine = live.filter((p) => p.editorId === i.me);
    views.editor = {
      toStart: mine.filter((p) => p.state === 'planned').map((p) => pass(p, i.today)).sort(longestWait),
      toDeliver: mine.filter((p) => p.state === 'in_progress').map((p) => pass(p, i.today)).sort(longestWait),
      withAuthor: mine.filter((p) => p.state === 'delivered').map((p) => pass(p, i.today)).sort(longestWait),
      answered: mine.reduce((n, p) => n + p.counts.answered, 0)
    };
  }

  if (lenses.includes('director')) {
    const byBook = new Map<string, { name: string; deadlines: LensDue[] }>();
    for (const t of openTasks) {
      if (t.kind !== 'deadline' || t.due! >= i.today) continue; // a book is late when a deadline of it has passed and is still open
      const b = byBook.get(t.projectId) ?? { name: t.projectName, deadlines: [] };
      b.deadlines.push(due(t, i.today));
      byBook.set(t.projectId, b);
    }
    const lateBooks = [...byBook].map(([projectId, b]) => ({ projectId, name: b.name, deadlines: b.deadlines.sort((x, y) => y.daysLate - x.daysLate), daysLate: Math.max(...b.deadlines.map((d) => d.daysLate)) })).sort((a, b) => b.daysLate - a.daysLate || a.name.localeCompare(b.name));
    const waiting = new Map<string, { name: string; queries: number; passes: number; oldest: number | null }>();
    for (const p of live.filter((x) => x.state === 'delivered' && x.unanswered > 0)) {
      const w = waiting.get(p.projectId) ?? { name: p.projectName, queries: 0, passes: 0, oldest: null };
      w.queries += p.unanswered;
      w.passes += 1;
      const days = between(p.deliveredAt ?? p.createdAt, i.today);
      w.oldest = w.oldest === null ? days : Math.max(w.oldest, days);
      waiting.set(p.projectId, w);
    }
    const unanswered = [...waiting].map(([projectId, w]) => ({ projectId, name: w.name, queries: w.queries, passes: w.passes, oldestDays: w.oldest })).sort((a, b) => (b.oldestDays ?? 0) - (a.oldestDays ?? 0) || a.name.localeCompare(b.name));
    const art = i.art;
    views.director = {
      lateBooks, unanswered, totals: { lateBooks: lateBooks.length, unansweredQueries: unanswered.reduce((n, u) => n + u.queries, 0) }, canonWaiting: i.canonWaiting ?? 0,
      art: { inReview: art ? art.assets.filter((a) => a.state === 'in_review').length : 0, notReady: art ? art.runs.filter((r) => r.errors > 0).map((r): LensNotReady => ({ ...r })).sort((a, b) => b.errors - a.errors || a.path.localeCompare(b.path)) : [] }
    };
  }
  if (lenses.includes('art')) {
    const art = i.art ?? { assets: [], briefs: [], runs: [] };
    const ref = (a: ArtLensInput['assets'][number]): LensAsset => ({ assetId: a.id, name: a.name, projectId: a.projectId, projectName: a.projectName });
    views.art = {
      toApprove: art.assets.filter((a) => a.state === 'in_review').map(ref).sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name)),
      concepts: art.briefs.filter((b) => b.submitted > 0 && !b.chosen).map((b) => ({ briefId: b.id, title: b.title, projectId: b.projectId, projectName: b.projectName, waiting: b.submitted })).sort((a, b) => b.waiting - a.waiting || a.title.localeCompare(b.title)),
      licences: art.assets.filter((a) => a.state !== 'retired' && a.licenceDaysLeft !== null && a.licenceDaysLeft <= 60).map((a) => ({ ...ref(a), days: a.licenceDaysLeft! })).sort((a, b) => a.days - b.days),
      toUpdate: art.assets.filter((a) => a.needUpdate > 0).map((a) => ({ ...ref(a), uses: a.needUpdate })).sort((a, b) => b.uses - a.uses)
    };
  }
  return views;
}

/** What `loadLens` needs from the app: whether the person holds a capability anywhere, and the two reads the views are built from. */
export interface LensSources {
  mayAnywhere(capability: string): Promise<boolean>;
  editing(): Promise<EditingState>;
  plan(): Promise<PlanState>;
  /** How many canon proposals wait on this person (only asked for a Director's view). */
  canonWaiting?(): Promise<number>;
  /** What the person may see of art and Preflight (asked for a Director's or an Art view). */
  art?(): Promise<ArtLensInput>;
}

/**
 * The person's lenses (from what their roles hold) and the views for them. A person with no lens costs the Studio nothing: no pass or task is read.
 * A role that may not read editorial passes or the plan (a refusal comes back as "not available") simply has an empty list there.
 */
export async function loadLens(src: LensSources, me: string, today: string): Promise<LensState> {
  const [rolesManage, editApprove, editRun, manuscriptWrite, assetWrite, assetManage] = await Promise.all(
    [LENS_CAPABILITIES.rolesManage, LENS_CAPABILITIES.editApprove, LENS_CAPABILITIES.editRun, LENS_CAPABILITIES.manuscriptWrite, LENS_CAPABILITIES.assetWrite, LENS_CAPABILITIES.assetManage].map((c) => src.mayAnywhere(c).catch(() => false))
  );
  const lenses = lensesFor({ rolesManage, editApprove, editRun, manuscriptWrite, assetWrite, assetManage });
  if (!lenses.length) return { available: true, today, lenses, views: {} };
  const [editing, plan] = await Promise.all([src.editing().catch(() => null), src.plan().catch(() => null)]);
  const canonWaiting = lenses.includes('director') && src.canonWaiting ? await src.canonWaiting().catch(() => 0) : 0;
  const passes = editing && editing.available ? editing.passes : [];
  const tasks = plan && plan.available ? plan.tasks : [];
  const art = (lenses.includes('director') || lenses.includes('art')) && src.art ? await src.art().catch(() => undefined) : undefined;
  return { available: true, today, lenses, views: buildLens(lenses, { me, today, passes, tasks, canonWaiting, ...(art ? { art } : {}) }) };
}
