/**
 * "Follow the active Studio". An AI app's configuration (the Claude Desktop extension, a line in claude_desktop_config.json, Claude Code's or
 * Codex's settings) is written once, but which Studio is active changes. So that configuration carries only `--active <file>`, and the app keeps
 * that file up to date with the arguments of whichever Studio it is running (--root, --studio, --records, --library, ...). The server reads it
 * when it starts; the extension's launcher restarts the server when the file changes, so a switch is followed without reinstalling anything.
 */
import { readFileSync } from 'node:fs';

/** What the app writes: the active Studio's name (for people reading the file) and the server arguments that belong to it. */
export interface ActiveStudioFile {
  studio?: string;
  args: string[];
}

export function parseActive(text: string): ActiveStudioFile {
  const v: unknown = JSON.parse(text);
  const args = (v as { args?: unknown } | null)?.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new Error('it has no list of arguments');
  const studio = (v as { studio?: unknown }).studio;
  return { ...(typeof studio === 'string' ? { studio } : {}), args: args as string[] };
}

/** The flag names (`--root`) among arguments; a value never starts with `--` in anything the app writes. */
const namesOf = (args: string[]) => new Set(args.filter((a) => a.startsWith('--')).map((a) => (a.includes('=') ? a.slice(0, a.indexOf('=')) : a)));

/**
 * The arguments after removing `--active <file>` and expanding it. The file's arguments win: any flag it sets is dropped from the rest, so a
 * path baked into an old configuration (or added by an extension setting) can never pull the server back to another Studio.
 * `read` and `report` are for tests. A file that cannot be read leaves the other arguments as they were, and says why.
 */
export function expandActive(args: string[], read: (file: string) => string = (f) => readFileSync(f, 'utf8'), report: (m: string) => void = () => undefined): string[] {
  const rest: string[] = [];
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--active') file = args[++i];
    else if (a.startsWith('--active=')) file = a.slice('--active='.length);
    else rest.push(a);
  }
  if (!file) return args;
  let active: ActiveStudioFile;
  try {
    active = parseActive(read(file));
  } catch (e) {
    report(`The active Studio file ${file} could not be used (${e instanceof Error ? e.message : String(e)}); open Cadrel once so it can write it.`);
    return rest;
  }
  const set = namesOf(active.args);
  const kept: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (!set.has(name)) {
      kept.push(a);
      continue;
    }
    if (!a.includes('=') && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) i++; // its value goes with it
  }
  report(`Following the active Studio${active.studio ? ` "${active.studio}"` : ''} (${file}).`);
  return [...active.args, ...kept];
}
