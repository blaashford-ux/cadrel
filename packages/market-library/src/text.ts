import crypto from 'node:crypto';

export const TARGET_CHARS = 900;

export const hashText = (t: string) => crypto.createHash('sha1').update(t).digest('hex');
/** Rough token estimate (English prose averages about four characters per token). */
export const estimateTokens = (t: string) => Math.max(1, Math.ceil(t.length / 4));

/**
 * Split prose into pieces of roughly `target` characters on paragraph, then sentence boundaries.
 * Short paragraphs are merged so a one-line paragraph never becomes a chunk of its own.
 */
export function chunkText(text: string, target = TARGET_CHARS): string[] {
  const paras = text.split(/\n\s*\n|\r\n\s*\r\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= target) {
      pieces.push(p);
      continue;
    }
    let cur = '';
    for (const s of p.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)\s*/g) ?? [p]) {
      if (cur && cur.length + s.length > target) {
        pieces.push(cur.trim());
        cur = '';
      }
      cur += s;
      // a single sentence longer than the target is hard-split on spaces
      while (cur.length > target * 1.5) {
        const cut = cur.lastIndexOf(' ', target);
        const at = cut > target / 2 ? cut : target;
        pieces.push(cur.slice(0, at).trim());
        cur = cur.slice(at);
      }
    }
    if (cur.trim()) pieces.push(cur.trim());
  }
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length < target / 3 && last.length + p.length + 1 <= target * 1.3) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}
