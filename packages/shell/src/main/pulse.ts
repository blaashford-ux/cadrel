/**
 * The studio at a glance for Home and the Dashboard, worked out from the Studio's records: how work and projects stand (the plan), what is
 * waiting for a sign-off, the latest decisions, and the catalogue's books. Pure: the caller reads the records and passes them in, so this
 * is tested without any of them. Nothing here is stored.
 */
import type { ApprovalRecord, DecisionRecord } from '@cadrel/kernel';
import type { CatalogueList, OnProject, PlanState, Pulse } from '../shared/api';

type Ready = Extract<PlanState, { available: true }>;
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export interface PulseInput {
  plan: PlanState;
  /** Sign-offs still waiting, any project, each with its project's name. */
  approvals: OnProject<ApprovalRecord>[];
  /** The ledger's current decisions, newest first. */
  decisions: OnProject<Omit<DecisionRecord, 'projectId'> & { projectId: string | null }>[];
  catalogue: CatalogueList;
}

export function buildPulse({ plan, approvals, decisions, catalogue }: PulseInput): Pulse {
  if (!plan.available) return { available: false, reason: plan.reason };
  const p: Ready = plan;
  const open = p.tasks.filter((t) => t.state === 'open');
  const dated = open.filter((t) => t.due).sort((a, b) => a.due!.localeCompare(b.due!) || a.title.localeCompare(b.title));
  const late = dated.filter((t) => t.due! < p.today);
  const soon = dated.filter((t) => t.due! >= p.today && t.due! <= addDays(p.today, 14));
  const brief = (t: Ready['tasks'][number]) => ({ id: t.id, title: t.title, kind: t.kind, due: t.due, projectId: t.projectId, projectName: t.projectName, assigneeId: t.assigneeId });

  const pending = approvals.filter((a) => a.state === 'pending');
  const books = catalogue.available ? catalogue.books : [];
  const published = books.filter((b) => b.asin);
  const inProduction = books.filter((b) => b.projectId && b.stage && !(b.stageCategory === 'done'));
  // royalties: the most recent month any book has, summed across the books that have it; "estimated" if any of them rests on an estimate
  let month: string | null = null;
  for (const b of books) if (b.market?.money?.lastMonth && (!month || b.market.money.lastMonth > month)) month = b.market.money.lastMonth;
  const that = month ? books.filter((b) => b.market?.money?.lastMonth === month) : [];
  const money = catalogue.financeVisible && month ? { month, usd: that.reduce((a, b) => a + (b.market?.money?.lastMonthUsd ?? 0), 0), estimated: that.some((b) => b.market?.money?.lastMonthState !== 'final') } : null;

  return {
    available: true,
    today: p.today,
    work: { open: open.length, late: late.length, dueSoon: soon.length, approvalsPending: pending.length, doneThisWeek: p.tasks.filter((t) => t.state === 'done' && t.doneAt && t.doneAt.slice(0, 10) > addDays(p.today, -7)).length },
    late: late.slice(0, 6).map(brief),
    upcoming: soon.slice(0, 8).map(brief),
    approvals: pending.slice(0, 6).map((a) => ({ id: a.id, label: a.label, projectId: a.projectId, projectName: a.projectName, waiting: a.approvers.filter((x) => !x.response).map((x) => x.personId) })),
    decisions: decisions.slice(0, 5).map((d) => ({ id: d.id, title: d.title, outcome: d.outcome, projectName: d.projectName || null, decidedAt: d.decidedAt })),
    pipeline: p.workflows.map((w) => ({
      id: w.id, name: w.name,
      stages: w.stages.map((s) => ({ key: s.key, name: s.name, color: s.color, category: s.category, count: p.projects.filter((x) => x.workflowId === w.id && x.stage === s.key).length })),
      total: p.projects.filter((x) => x.workflowId === w.id).length
    })),
    books: { total: books.length, published: published.length, unpublished: books.length - published.length, series: new Set(books.map((b) => b.seriesId).filter(Boolean)).size, inProduction: inProduction.length, unlisted: catalogue.unlisted.length, money },
    people: p.people
  };
}
