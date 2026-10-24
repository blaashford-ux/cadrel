import path from 'node:path';

/**
 * The Markdown file named on the command line, if any: what Windows passes when you double-click a
 * `.md` file or choose "Open with MDEdit". Flags (`--no-sandbox`, `--smoke-test=…`) are ignored and a
 * relative path is resolved against `cwd`.
 */
export function fileFromArgv(args: string[], cwd: string): string | null {
  for (const raw of args) {
    const a = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!a || a.startsWith('-')) continue;
    if (/\.(md|markdown)$/i.test(a)) return path.isAbsolute(a) ? path.normalize(a) : path.resolve(cwd, a);
  }
  return null;
}
