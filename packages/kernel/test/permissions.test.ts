import { describe, expect, it } from 'vitest';
import { can, defaultRoles, explain, type Assignment, type PermissionContext, type Resource, type ScopeRef } from '../src';

const studio: ScopeRef = { kind: 'studio', id: 's1' };
const series1: ScopeRef = { kind: 'project', id: 'ser1' };
const book1: ScopeRef = { kind: 'project', id: 'b1' };
const book2: ScopeRef = { kind: 'project', id: 'b2' };
const roles = new Map(defaultRoles().map((r) => [r.id, r]));
const NOW = '2026-10-24T00:00:00Z';

function ctx(assignments: Assignment[], personId = 'p1', teamIds: string[] = []): PermissionContext {
  return { actor: { personId, teamIds }, assignments, roles, now: NOW };
}
const person = (id: string, roleKey: string, scope: { kind: any; id: string }, extra: Partial<Assignment> = {}): Assignment => ({
  id, subject: { kind: 'person', id: 'p1' }, roleId: `role_${roleKey}`, scope, ...extra
});
const at = (...path: ScopeRef[]): Resource => ({ path });

describe('can / explain', () => {
  it('a role applies to its scope and everything below, not beside it', () => {
    const c = ctx([person('a1', 'author', book1)]);
    expect(can(c, 'manuscript.write', at(studio, series1, book1))).toBe(true);
    expect(can(c, 'manuscript.write', at(studio, series1, book2))).toBe(false);
    expect(can(c, 'manuscript.write', at(studio))).toBe(false);
  });

  it('a studio-wide role reaches every book', () => {
    const c = ctx([person('a1', 'admin', studio)]);
    expect(can(c, 'royalties.read', at(studio, series1, book2))).toBe(true);
  });

  it('no role means no access', () => {
    const d = explain(ctx([]), 'catalogue.read', at(studio));
    expect(d).toMatchObject({ allowed: false, why: 'no-assignment' });
  });

  it('expired assignments stop applying', () => {
    const c = ctx([person('a1', 'guest', book1, { expiresAt: '2026-10-23T00:00:00Z' })]);
    expect(can(c, 'manuscript.comment', at(studio, series1, book1))).toBe(false);
    const live = ctx([person('a1', 'guest', book1, { expiresAt: '2026-11-01T00:00:00Z' })]);
    expect(can(live, 'manuscript.comment', at(studio, series1, book1))).toBe(true);
  });

  it('a team assignment applies to its members only', () => {
    const a: Assignment = { id: 't1', subject: { kind: 'team', id: 'editors' }, roleId: 'role_editor', scope: studio };
    expect(can(ctx([a], 'p1', ['editors']), 'edit.run', at(studio, series1, book1))).toBe(true);
    expect(can(ctx([a], 'p1', []), 'edit.run', at(studio, series1, book1))).toBe(false);
  });

  it('roles only add: two assignments give the union', () => {
    const c = ctx([person('a1', 'author', book1), person('a2', 'editor', book2)]);
    expect(can(c, 'manuscript.write', at(studio, series1, book1))).toBe(true);
    expect(can(c, 'edit.run', at(studio, series1, book2))).toBe(true);
    expect(can(c, 'edit.run', at(studio, series1, book1))).toBe(false);
  });

  it('a confidential book hides itself from studio-wide roles but not from people assigned at it', () => {
    const secret: ScopeRef = { ...book1, confidential: true };
    const wide = ctx([person('a1', 'director', studio)]);
    const d = explain(wide, 'catalogue.read', at(studio, series1, secret));
    expect(d).toMatchObject({ allowed: false, why: 'confidential' });
    const direct = ctx([person('a2', 'author', book1)]);
    expect(can(direct, 'manuscript.write', at(studio, series1, secret))).toBe(true);
  });

  it('confidential.access (Owner, Admin) sees through confidentiality', () => {
    const secret: ScopeRef = { ...series1, confidential: true };
    expect(can(ctx([person('a1', 'admin', studio)]), 'catalogue.read', at(studio, secret, book1))).toBe(true);
    expect(can(ctx([person('a1', 'owner', studio)]), 'catalogue.read', at(studio, secret, book1))).toBe(true);
  });

  it('the deepest confidential node decides', () => {
    const s: ScopeRef = { ...series1, confidential: true };
    const b: ScopeRef = { ...book1, confidential: true };
    const seriesLead = ctx([person('a1', 'series_lead', series1)]);
    expect(can(seriesLead, 'manuscript.approve', at(studio, s, b))).toBe(false);
    expect(can(seriesLead, 'manuscript.approve', at(studio, s, book2))).toBe(true);
  });

  it('a workflow state can make a capability unavailable even to the Owner', () => {
    const r: Resource = { path: [studio, series1, book1], stateDenies: { state: 'Approved', capabilities: ['manuscript.write'] } };
    const d = explain(ctx([person('a1', 'owner', studio)]), 'manuscript.write', r);
    expect(d).toMatchObject({ allowed: false, why: 'workflow-state' });
    expect(can(ctx([person('a1', 'owner', studio)]), 'manuscript.read', r)).toBe(true);
  });

  it('explain names the grant that allows an action', () => {
    const d = explain(ctx([person('a1', 'editor', book1)]), 'edit.run', at(studio, series1, book1));
    expect(d.allowed && d.reason).toContain('Editor on project b1');
  });

  it('can and explain always agree', () => {
    const c = ctx([person('a1', 'author', book1), person('a2', 'guest', book2)]);
    for (const cap of ['manuscript.write', 'manuscript.comment', 'royalties.read', 'edit.run']) {
      for (const b of [book1, book2]) expect(can(c, cap, at(studio, b))).toBe(explain(c, cap, at(studio, b)).allowed);
    }
  });
});
