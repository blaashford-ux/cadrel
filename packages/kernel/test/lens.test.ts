import { describe, expect, it } from 'vitest';
import { LENS_CAPABILITIES, ROLE_KEYS, defaultRole, lensesFor, type LensCapabilities } from '../src';

const of = (key: (typeof ROLE_KEYS)[number]): LensCapabilities => {
  const r = defaultRole(key);
  const has = (c: string) => r.all === true || r.capabilities.includes(c);
  return { rolesManage: has(LENS_CAPABILITIES.rolesManage), editApprove: has(LENS_CAPABILITIES.editApprove), editRun: has(LENS_CAPABILITIES.editRun), manuscriptWrite: has(LENS_CAPABILITIES.manuscriptWrite), assetWrite: has(LENS_CAPABILITIES.assetWrite), assetManage: has(LENS_CAPABILITIES.assetManage) };
};

describe('the working view a role leads with', () => {
  it.each([
    ['owner', ['director', 'editor', 'author', 'art']], // the Owner leads with the Director's view and may switch to the others
    ['admin', ['director']],
    ['director', ['director']],
    ['series_lead', ['director']],
    ['editor', ['editor', 'author']], // an Editor writes too, but leads with editing
    ['author', ['author']],
    ['art_director', ['art']],
    ['artist', ['art']], // an Artist uploads art and writes no manuscripts
    ['marketing', []],
    ['analyst', []],
    ['finance', []],
    ['guest', []],
    ['beta_reader', []]
  ] as const)('%s: %j', (key, lenses) => {
    expect(lensesFor(of(key))).toEqual(lenses);
  });

  it('covers every default role, so a new one cannot be forgotten', () => {
    expect(ROLE_KEYS.length).toBe(13);
  });

  it('is empty for a person who holds none of the four, so their Home is unchanged', () => {
    expect(lensesFor({ rolesManage: false, editApprove: false, editRun: false, manuscriptWrite: false })).toEqual([]);
  });
});
