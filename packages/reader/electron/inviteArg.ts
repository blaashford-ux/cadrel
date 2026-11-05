/**
 * The invitation link among a launch's arguments: what Windows passes when a `cadrel-reader:` link is clicked. Flags are ignored; only
 * a `cadrel-reader://…` argument counts, so no other program can hand the app something else this way.
 */
export function inviteFromArgv(args: string[]): string | null {
  for (const raw of args) {
    const a = raw.trim().replace(/^"(.*)"$/, '$1');
    if (/^cadrel-reader:/i.test(a)) return a;
  }
  return null;
}
