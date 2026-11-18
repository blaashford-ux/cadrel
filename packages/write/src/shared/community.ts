/**
 * Community links: the places a Studio's readers can gather (a Discord, a Facebook group, a mailing list), defined once for the Studio and
 * switched on or off book by book. Each prints in the back matter as the community's name and its web address spelled out, linked in ebooks.
 */
import { safeUrl } from './export/matter';

export interface CommunityLink {
  id: string;
  name: string;
  url: string;
}

export const MAX_COMMUNITIES = 100;
export const MAX_COMMUNITY_NAME = 80;
export const MAX_COMMUNITY_URL = 500;

export class CommunityError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** What a saved file may hold: well-formed entries only (a bad address is dropped, not repaired), none twice, up to the limit. */
export function sanitizeCommunities(raw: unknown): CommunityLink[] {
  const list = isObj(raw) && Array.isArray(raw.links) ? raw.links : Array.isArray(raw) ? raw : [];
  const out: CommunityLink[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    if (!isObj(x) || typeof x.id !== 'string' || !x.id || seen.has(x.id)) continue;
    const name = typeof x.name === 'string' ? x.name.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_COMMUNITY_NAME) : '';
    const url = typeof x.url === 'string' ? safeUrl(x.url.replace(CONTROL, '')) : '';
    if (!name || !url || url.length > MAX_COMMUNITY_URL || !/^https?:\/\//i.test(url)) continue;
    seen.add(x.id);
    out.push({ id: x.id, name, url });
    if (out.length >= MAX_COMMUNITIES) break;
  }
  return out;
}

/**
 * Checks a list someone is saving and says what is wrong, instead of quietly dropping it: every community needs a name and a web address
 * (http or https; "discord.gg/abc" gets https:// put in front). Returns the cleaned list, in the order given.
 */
export function checkCommunities(input: unknown, newId: () => string): CommunityLink[] {
  if (!Array.isArray(input)) throw new CommunityError('That is not a list of communities.');
  if (input.length > MAX_COMMUNITIES) throw new CommunityError(`A Studio keeps up to ${MAX_COMMUNITIES} communities.`);
  const ids = new Set<string>();
  return input.map((x, i) => {
    const row = isObj(x) ? x : {};
    const name = typeof row.name === 'string' ? row.name.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '';
    let url = typeof row.url === 'string' ? row.url.replace(CONTROL, '').trim() : '';
    const n = `Community ${i + 1}${name ? ` (${name})` : ''}`;
    if (!name) throw new CommunityError(`${n} needs a name.`);
    if (name.length > MAX_COMMUNITY_NAME) throw new CommunityError(`${n}: a name is up to ${MAX_COMMUNITY_NAME} characters.`);
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(url) || !safeUrl(url)) throw new CommunityError(`${n} needs a web address (for example https://discord.gg/yourserver).`);
    if (url.length > MAX_COMMUNITY_URL) throw new CommunityError(`${n}: the address is too long.`);
    let id = typeof row.id === 'string' && row.id && !ids.has(row.id) ? row.id : newId();
    while (ids.has(id)) id = newId();
    ids.add(id);
    return { id, name, url };
  });
}

/** The communities a book includes: the Studio's, less those the book has switched off (new ones are on, since only the off ones are kept). */
export const communitiesFor = (all: readonly CommunityLink[], off: readonly string[]): CommunityLink[] => all.filter((c) => !off.includes(c.id));
