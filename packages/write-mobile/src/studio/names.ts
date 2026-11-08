/** A folder name that is safe on the phone and in a vault path: nothing the vault refuses, no leading or trailing dot or space, never empty. */
export function safeName(raw: string, fallback = 'Project'): string {
  const n = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 100)
    .trim();
  return n || fallback;
}

/** `name`, or `name 2`, `name 3`… if that is taken (compared ignoring case, as Windows does and the vault does). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const c = `${name} ${i}`;
    if (!used.has(c.toLowerCase())) return c;
  }
}

/** "Chapter 1.md" → "Chapter 1 (conflict Pixel 8 2026-11-06).md" */
export function conflictName(file: string, device: string, date: Date): string {
  const dot = file.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  return `${stem} (conflict ${safeName(device, 'phone')} ${date.toISOString().slice(0, 10)})${ext}`;
}
