/**
 * Who wrote a book. An Amazon page lists everyone credited with a role ("(Author)", "(Editor)", "(Illustrator)", "(Foreword)"...), and a
 * collaboration has several authors. Only people credited as an author count; a person with no role shown is taken to be an author, and
 * "(Author, Illustrator)" is an author.
 */

export interface Credit { name: string; role?: string | null }

export const isAuthorRole = (role: string | null | undefined): boolean => !role || /\bauthor\b/i.test(role);

/** The names of the authors in a stored credits list (JSON text or the parsed list), in order, without repeats. */
export function authorNamesOf(credits: string | Credit[] | null | undefined): string[] {
  let list: Credit[] = [];
  if (typeof credits === 'string') {
    try { list = JSON.parse(credits) as Credit[]; } catch { list = []; }
  } else if (Array.isArray(credits)) list = credits;
  const out: string[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (name && isAuthorRole(c.role) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The names in a report's author field, where a collaboration may be written "A & B", "A and B", "A; B" or "A, B". A single "Last, First"
 * is one name: a comma only separates names when each side is itself more than one word.
 */
export function splitPenNames(field: string | null | undefined): string[] {
  const parts = (field ?? '').split(/\s*(?:;|&|\+|\band\b|\s\/\s)\s*/i).flatMap((p) => {
    const bits = p.split(/\s*,\s*/);
    return bits.length > 1 && bits.every((b) => /\s/.test(b.trim())) ? bits : [p];
  });
  const out: string[] = [];
  for (const p of parts) {
    const n = p.replace(/\s+/g, ' ').trim();
    if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}
