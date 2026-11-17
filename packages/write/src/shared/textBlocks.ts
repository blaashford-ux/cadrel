/**
 * Saved text blocks for the Book Details form: wording used again and again (a copyright notice, a dedication, a call to action, an author bio)
 * saved once under a name and put back into any book. Blocks are grouped by where they belong, so the list offered beside a field is the one for it.
 */

export const BLOCK_KINDS = ['front', 'copyright', 'back'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const BLOCK_KIND_LABEL: Record<BlockKind, string> = { front: 'Front matter', copyright: 'Copyright page', back: 'Back matter' };

export interface TextBlock {
  id: string;
  kind: BlockKind;
  name: string;
  text: string;
  updatedAt: string;
}

export const MAX_BLOCKS = 500;
export const MAX_BLOCK_TEXT = 20000;
export const MAX_BLOCK_NAME = 80;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** What a saved file may hold: only well-formed blocks, none twice, no more than the limit. */
export function sanitizeBlocks(raw: unknown): TextBlock[] {
  const list = isObj(raw) && Array.isArray(raw.blocks) ? raw.blocks : [];
  const out: TextBlock[] = [];
  const seen = new Set<string>();
  for (const b of list) {
    if (!isObj(b) || typeof b.id !== 'string' || !b.id || seen.has(b.id)) continue;
    if (!(BLOCK_KINDS as readonly string[]).includes(b.kind as string)) continue;
    const name = typeof b.name === 'string' ? b.name.replace(CONTROL, '').trim().slice(0, MAX_BLOCK_NAME) : '';
    if (!name || typeof b.text !== 'string') continue;
    seen.add(b.id);
    out.push({ id: b.id, kind: b.kind as BlockKind, name, text: b.text.replace(CONTROL, '').slice(0, MAX_BLOCK_TEXT), updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : '' });
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}

export class BlockError extends Error {}

/**
 * Saves a block. A name is unique within its kind (ignoring case): saving under a name already there replaces that block, so "update my bio"
 * is the same act as "save my bio".
 */
export function upsertBlock(blocks: TextBlock[], input: { kind: unknown; name: unknown; text: unknown }, now: string, newId: () => string): { blocks: TextBlock[]; saved: TextBlock; replaced: boolean } {
  if (!(BLOCK_KINDS as readonly string[]).includes(input.kind as string)) throw new BlockError('A block belongs to the front matter, the copyright page or the back matter.');
  const name = typeof input.name === 'string' ? input.name.replace(CONTROL, '').trim().slice(0, MAX_BLOCK_NAME) : '';
  if (!name) throw new BlockError('Give the block a name.');
  const text = typeof input.text === 'string' ? input.text.replace(CONTROL, '') : '';
  if (!text.trim()) throw new BlockError('There is no text to save.');
  if (text.length > MAX_BLOCK_TEXT) throw new BlockError(`A block is up to ${MAX_BLOCK_TEXT.toLocaleString('en-US')} characters.`);
  const kind = input.kind as BlockKind;
  const at = blocks.findIndex((b) => b.kind === kind && b.name.toLowerCase() === name.toLowerCase());
  if (at < 0 && blocks.length >= MAX_BLOCKS) throw new BlockError('There are too many saved blocks. Delete some first.');
  const saved: TextBlock = { id: at >= 0 ? blocks[at]!.id : newId(), kind, name, text, updatedAt: now };
  const next = at >= 0 ? blocks.map((b, i) => (i === at ? saved : b)) : [...blocks, saved];
  return { blocks: next, saved, replaced: at >= 0 };
}

export const removeBlock = (blocks: TextBlock[], id: string): TextBlock[] => blocks.filter((b) => b.id !== id);

/** The blocks for one place in the form, by name. */
export const blocksFor = (blocks: TextBlock[], kind: BlockKind): TextBlock[] => blocks.filter((b) => b.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
