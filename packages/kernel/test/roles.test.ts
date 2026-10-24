import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AREAS, allCapabilities, DEFAULT_MATRIX, ROLE_KEYS, defaultRole, defaultRoles } from '../src';

/** docs/PERMISSIONS.md is the human-readable source of the default roles; the code must match it cell for cell. */
function docMatrix(): { header: string[]; rows: Map<string, string[]> } {
  const md = readFileSync(new URL('../../../docs/PERMISSIONS.md', import.meta.url), 'utf8');
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith('| Area |'));
  const cells = (l: string) => l.split('|').slice(1, -1).map((c) => c.trim());
  const header = cells(lines[start]!);
  const rows = new Map<string, string[]>();
  for (let i = start + 2; i < lines.length && lines[i]!.startsWith('|'); i++) {
    const c = cells(lines[i]!);
    rows.set(c[0]!, c.slice(1));
  }
  return { header, rows };
}

describe('default roles', () => {
  const { header, rows } = docMatrix();

  it('the doc has one row per area, in the same words', () => {
    expect([...rows.keys()]).toEqual(AREAS.map((a) => a.label));
  });

  it('the doc columns are the shipped roles, in order', () => {
    const names = ROLE_KEYS.map((k) => defaultRole(k).name.replace('Studio Director', 'Director').replace('Art Director', 'Art Dir'));
    expect(header.slice(1)).toEqual(names);
  });

  it('every cell of the code matrix equals the doc table', () => {
    ROLE_KEYS.forEach((key, col) => {
      AREAS.forEach((area, row) => {
        const doc = rows.get(area.label)![col]!;
        const code = DEFAULT_MATRIX[key][row]!;
        expect(code === '-' ? '—' : code, `${key} / ${area.label}`).toBe(doc);
      });
    });
  });

  it('every capability in a default role exists in the catalogue', () => {
    const all = new Set(allCapabilities());
    for (const r of defaultRoles()) for (const c of r.capabilities) expect(all.has(c), `${r.id} ${c}`).toBe(true);
  });

  it('Owner holds everything; Admin sees everything but cannot manage Owners', () => {
    expect(defaultRole('owner').all).toBe(true);
    const admin = defaultRole('admin');
    for (const c of ['royalties.read', 'business.read', 'confidential.access', 'vault.force', 'manuscript.read', 'audit.read']) expect(admin.capabilities).toContain(c);
    expect(admin.all).toBeUndefined();
  });

  it('a Guest holds no studio-wide read', () => {
    const g = defaultRole('guest').capabilities;
    for (const c of ['catalogue.read', 'people.read', 'sales.read', 'royalties.read']) expect(g).not.toContain(c);
  });
});
