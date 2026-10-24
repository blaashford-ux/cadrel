import { describe, expect, it } from 'vitest';
import { canDeleteRole, canEditRole, canGrantRole, defaultRole, defaultRoles, keepsAnOwner, type Assignment, type PermissionContext, type Role, type ScopeRef } from '../src';

const studio: ScopeRef[] = [{ kind: 'studio', id: 's1' }];
const roles = new Map(defaultRoles().map((r) => [r.id, r]));
const NOW = '2026-10-24T00:00:00Z';
const as = (roleKey: string): PermissionContext => ({
  actor: { personId: 'p1', teamIds: [] },
  assignments: [{ id: 'x', subject: { kind: 'person', id: 'p1' }, roleId: `role_${roleKey}`, scope: { kind: 'studio', id: 's1' } }],
  roles,
  now: NOW
});

describe('guardrails', () => {
  it('an Owner can grant any role, including Owner', () => {
    for (const r of defaultRoles()) expect(canGrantRole(as('owner'), r, studio).ok).toBe(true);
  });

  it('an Admin can grant any ordinary role, even ones that write what the Admin only reads, but never Owner', () => {
    for (const k of ['director', 'series_lead', 'author', 'editor', 'artist', 'finance', 'guest', 'admin'] as const) {
      expect(canGrantRole(as('admin'), defaultRole(k), studio).ok, k).toBe(true);
    }
    expect(canGrantRole(as('admin'), defaultRole('owner'), studio)).toMatchObject({ ok: false });
  });

  // A custom "People manager": may manage people and roles but holds no security or break-glass powers.
  const hr: Role = { id: 'role_hr', name: 'People manager', description: '', templateKey: null, capabilities: ['people.read', 'people.invite', 'people.manage', 'roles.manage', 'teams.manage'] };
  const asHr = (): PermissionContext => ({
    actor: { personId: 'p1', teamIds: [] },
    assignments: [{ id: 'x', subject: { kind: 'person', id: 'p1' }, roleId: 'role_hr', scope: { kind: 'studio', id: 's1' } }],
    roles: new Map([...roles, ['role_hr', hr]]),
    now: NOW
  });

  it('governance powers cannot be handed on unless held', () => {
    const withSecurity: Role = { ...defaultRole('author'), id: 'role_x', capabilities: [...defaultRole('author').capabilities, 'security.policy'] };
    const r = canGrantRole(asHr(), withSecurity, studio);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain('security.policy');
    expect(canGrantRole(asHr(), defaultRole('admin'), studio)).toMatchObject({ ok: false });
    expect(canGrantRole(asHr(), defaultRole('author'), studio).ok).toBe(true);
  });

  it('nobody grants themselves a role, except an Owner', () => {
    expect(canGrantRole(asHr(), defaultRole('author'), studio, 'p1')).toMatchObject({ ok: false });
    expect(canGrantRole(asHr(), defaultRole('author'), studio, 'p2').ok).toBe(true);
    expect(canGrantRole(as('owner'), defaultRole('author'), studio, 'p1').ok).toBe(true);
  });

  it('unknown capabilities are refused', () => {
    const custom: Role = { ...defaultRole('author'), id: 'role_custom', capabilities: [...defaultRole('author').capabilities, 'finance.nonexistent'] };
    const r = canGrantRole(as('admin'), custom, studio);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain('finance.nonexistent');
  });

  it('without roles.manage you cannot grant at all', () => {
    expect(canGrantRole(as('editor'), defaultRole('guest'), studio)).toMatchObject({ ok: false });
  });

  it('editing a role cannot add governance powers the editor lacks, and Owner is read-only', () => {
    const author = defaultRole('author');
    expect(canEditRole(as('admin'), author, [...author.capabilities, 'task.assign'], studio).ok).toBe(true);
    expect(canEditRole(asHr(), author, [...author.capabilities, 'vault.force'], studio)).toMatchObject({ ok: false });
    expect(canEditRole(as('admin'), author, [...author.capabilities, 'made.up'], studio)).toMatchObject({ ok: false });
    expect(canEditRole(as('owner'), defaultRole('owner'), [], studio)).toMatchObject({ ok: false });
  });

  it('the last Owner cannot be removed, expired or demoted', () => {
    const owner: Assignment = { id: 'o1', subject: { kind: 'person', id: 'p1' }, roleId: 'role_owner', scope: { kind: 'studio', id: 's1' } };
    const other: Assignment = { id: 'o2', subject: { kind: 'person', id: 'p2' }, roleId: 'role_owner', scope: { kind: 'studio', id: 's1' } };
    expect(keepsAnOwner([owner], roles, 'o1', NOW)).toMatchObject({ ok: false });
    expect(keepsAnOwner([owner, other], roles, 'o1', NOW).ok).toBe(true);
    const expired = { ...other, expiresAt: '2026-01-01T00:00:00Z' };
    expect(keepsAnOwner([owner, expired], roles, 'o1', NOW)).toMatchObject({ ok: false });
  });

  it('a role that is still assigned cannot be deleted', () => {
    const a: Assignment = { id: 'a', subject: { kind: 'person', id: 'p1' }, roleId: 'role_author', scope: { kind: 'studio', id: 's1' } };
    expect(canDeleteRole([a], 'role_author')).toMatchObject({ ok: false });
    expect(canDeleteRole([a], 'role_editor').ok).toBe(true);
  });
});
