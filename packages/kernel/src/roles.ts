import { AREAS, capsForLevel, type Level } from './capabilities';

export interface Role {
  id: string;
  name: string;
  description: string;
  /** Holds every capability, including ones added later. Only the Owner role. */
  all?: boolean;
  /** Which shipped template this came from; null for roles the studio made. */
  templateKey: string | null;
  capabilities: string[];
}

export const ROLE_KEYS = ['owner', 'admin', 'director', 'series_lead', 'author', 'editor', 'art_director', 'artist', 'marketing', 'analyst', 'finance', 'guest'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const META: Record<RoleKey, { name: string; description: string }> = {
  owner: { name: 'Owner', description: 'Everything, always. Creates and changes Owners. At least one must exist.' },
  admin: { name: 'Admin', description: 'Runs studio setup (people, roles, security, workflows, vault) and can see everything.' },
  director: { name: 'Studio Director', description: 'Portfolio, schedule, approvals, finance and agreements across the studio.' },
  series_lead: { name: 'Series Lead', description: 'Creative owner of a series: approves canon, manuscripts, covers.' },
  author: { name: 'Author', description: 'Writes assigned books and responds to editorial queries.' },
  editor: { name: 'Editor', description: 'Runs editorial passes on assigned books.' },
  art_director: { name: 'Art Director', description: 'Owns briefs, assets and covers; approves artwork.' },
  artist: { name: 'Artist', description: 'Produces assigned artwork and campaign assets.' },
  marketing: { name: 'Marketing', description: 'Plans and runs launches and campaigns.' },
  analyst: { name: 'Analyst', description: 'Market research and captures.' },
  finance: { name: 'Finance', description: 'Royalties, payments, costs and agreements.' },
  guest: { name: 'Guest', description: 'Freelancer or reader with a scoped, expiring grant on specific books or files.' }
};

/**
 * The default role matrix: one level letter (or '-') per area, in AREAS order.
 * docs/PERMISSIONS.md carries the same table; test/roles.test.ts fails if the two differ.
 */
type Cell = Level | '-';
export const DEFAULT_MATRIX: Record<RoleKey, Cell[]> = {
  //             people settings audit force conf  cat   wflow tasks manu  edit  canon assets pre   launch market sales roy   biz   asst
  owner:        ['M', 'M', 'R', 'A', 'A', 'M', 'M', 'M', 'M', 'M', 'M', 'M', 'M', 'M', 'M', 'M', 'M', 'M', 'W'],
  admin:        ['M', 'M', 'R', 'A', 'A', 'M', 'M', 'M', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'W'],
  director:     ['R', '-', 'R', '-', '-', 'M', 'M', 'M', 'R', 'A', 'R', 'A', 'R', 'A', 'R', 'R', 'R', 'M', 'W'],
  series_lead:  ['-', '-', '-', '-', '-', 'W', '-', 'M', 'A', 'A', 'A', 'A', 'R', 'C', 'R', 'R', '-', '-', 'W'],
  author:       ['-', '-', '-', '-', '-', 'R', '-', 'W', 'W', 'C', 'W', 'C', 'R', 'R', 'R', 'R', 'R', 'R', 'W'],
  editor:       ['-', '-', '-', '-', '-', 'R', '-', 'W', 'W', 'M', 'W', 'R', 'W', '-', '-', '-', '-', '-', 'W'],
  art_director: ['-', '-', '-', '-', '-', 'R', '-', 'M', 'R', '-', 'R', 'M', 'W', 'C', 'R', '-', '-', '-', 'W'],
  artist:       ['-', '-', '-', '-', '-', 'R', '-', 'W', '-', '-', 'R', 'W', 'R', 'C', 'R', '-', '-', '-', 'W'],
  marketing:    ['-', '-', '-', '-', '-', 'R', '-', 'M', 'R', '-', 'R', 'R', 'R', 'M', 'W', 'R', '-', '-', 'W'],
  analyst:      ['-', '-', '-', '-', '-', 'R', '-', 'W', '-', '-', '-', 'R', '-', 'R', 'M', 'R', '-', '-', 'W'],
  finance:      ['-', '-', '-', '-', '-', 'R', '-', 'W', '-', '-', '-', '-', '-', '-', '-', 'R', 'M', 'M', 'W'],
  guest:        ['-', '-', '-', '-', '-', '-', '-', 'W', 'C', 'C', '-', 'C', '-', '-', '-', '-', '-', '-', '-']
};

export function defaultRole(key: RoleKey): Role {
  const caps = new Set<string>();
  const row = DEFAULT_MATRIX[key];
  AREAS.forEach((area, i) => {
    const cell = row[i];
    if (cell && cell !== '-') capsForLevel(area, cell).forEach((c) => caps.add(c));
  });
  return {
    id: `role_${key}`,
    name: META[key].name,
    description: META[key].description,
    all: key === 'owner' ? true : undefined,
    templateKey: key,
    capabilities: [...caps].sort()
  };
}

export function defaultRoles(): Role[] {
  return ROLE_KEYS.map(defaultRole);
}
