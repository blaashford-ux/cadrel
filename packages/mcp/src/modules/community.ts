/**
 * The Studio's community links (a reader Discord, a Facebook group, a mailing list) from the assistant: list them, add one, change one, delete one.
 * They are the same links the Community page of a book's back matter prints, kept in one file for the Studio by Write, so a change made here is
 * what the next export uses and what Book Details shows. Which links a particular book leaves out is that book's own setting and is not touched here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CommunityStore } from '@cadrel/write/electron/communityStore';
import { CommunityError, type CommunityLink } from '@cadrel/write/src/shared/community';

export const COMMUNITY_INSTRUCTIONS =
  'community_links lists the Studio\'s community links (name and web address), which print on the Community page of a book\'s back matter, one line each. community_add_link, community_update_link and community_delete_link change them for the whole Studio; each book can still switch a link off for itself in Book Details. A link is a name and an http(s) address (a bare "discord.gg/abc" gets https:// put in front).';

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof CommunityError) return failure(e.message);
    throw e;
  }
}

const lower = (s: string) => s.trim().toLowerCase();
const shown = (c: CommunityLink) => ({ id: c.id, name: c.name, url: c.url });

/** The one link a person means: by id, or by name (exact, ignoring case), or by a name that only one link starts with. */
function find(list: CommunityLink[], ref: string): CommunityLink {
  const r = lower(ref);
  const byId = list.find((c) => c.id === ref.trim());
  if (byId) return byId;
  const exact = list.filter((c) => lower(c.name) === r);
  if (exact.length === 1) return exact[0]!;
  const starts = exact.length ? exact : list.filter((c) => lower(c.name).startsWith(r));
  if (starts.length === 1) return starts[0]!;
  if (starts.length > 1) throw new CommunityError(`More than one community link matches "${ref}": ${starts.map((c) => `"${c.name}" (${c.id})`).join(', ')}. Use its id.`);
  throw new CommunityError(`There is no community link "${ref}". Use community_links to see them.`);
}

export function registerCommunityTools(server: McpServer, file: string): void {
  const store = new CommunityStore(file);
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const link = z.string().describe('A community link: its id, or its name.');

  server.registerTool(
    'community_links',
    { description: 'The Studio\'s community links, in the order they print: id, name and web address.', inputSchema: {}, annotations: readOnly },
    () => guarded(async () => ({ links: (await store.list()).map(shown) }))
  );

  server.registerTool(
    'community_add_link',
    {
      description: 'Adds a community link for the whole Studio (it goes on the Community page of every book that has not switched it off). A bare address such as discord.gg/abc gets https:// in front. Two links may not have the same name.',
      inputSchema: { name: z.string().describe('The community\'s name as readers should see it, e.g. "Reader Discord".'), url: z.string().describe('Its web address (http or https).') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    ({ name, url }) =>
      guarded(async () => {
        const list = await store.list();
        if (list.some((c) => lower(c.name) === lower(name))) throw new CommunityError(`There is already a community link called "${name.trim()}". Use community_update_link to change it.`);
        const saved = await store.save([...list, { name, url }]);
        return { added: shown(saved[saved.length - 1]!), total: saved.length };
      })
  );

  server.registerTool(
    'community_update_link',
    {
      description: 'Changes a community link\'s name and/or address, for the whole Studio. Give only what changes.',
      inputSchema: { link, name: z.string().optional().describe('The new name.'), url: z.string().optional().describe('The new web address.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    ({ link: ref, name, url }) =>
      guarded(async () => {
        if (name === undefined && url === undefined) throw new CommunityError('Say what to change: a new name, a new address, or both.');
        const list = await store.list();
        const c = find(list, ref);
        if (name !== undefined && list.some((x) => x.id !== c.id && lower(x.name) === lower(name))) throw new CommunityError(`There is already a community link called "${name.trim()}".`);
        const saved = await store.save(list.map((x) => (x.id === c.id ? { id: x.id, name: name ?? x.name, url: url ?? x.url } : x)));
        return { updated: shown(saved.find((x) => x.id === c.id)!) };
      })
  );

  server.registerTool(
    'community_delete_link',
    {
      description: 'Deletes a community link from the Studio: it no longer prints in any book\'s back matter. This cannot be undone from here (add it again to bring it back).',
      inputSchema: { link },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    ({ link: ref }) =>
      guarded(async () => {
        const list = await store.list();
        const c = find(list, ref);
        await store.save(list.filter((x) => x.id !== c.id));
        return { deleted: shown(c), remaining: list.length - 1 };
      })
  );
}
