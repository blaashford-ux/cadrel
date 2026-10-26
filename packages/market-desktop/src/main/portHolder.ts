import { execFile } from 'node:child_process';

/** The program that is listening on a TCP port: its process id and its name (for example "BookScout.exe"). */
export interface PortHolder {
  pid: number;
  name: string;
}

type Run = (cmd: string, args: string[]) => Promise<string>;

const run: Run = (cmd, args) =>
  new Promise((resolve) => {
    // Never throws: a missing tool (no lsof, no netstat) just means "cannot say who".
    execFile(cmd, args, { timeout: 4000, maxBuffer: 1 << 20, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? '')));
  });

/** The pid listening on `port` according to `netstat -ano -p TCP` (Windows). Loopback and wildcard listeners both count. */
export function parseNetstat(out: string, port: number): number | null {
  for (const line of out.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 5 || c[0]!.toUpperCase() !== 'TCP' || c[3]!.toUpperCase() !== 'LISTENING') continue;
    const local = c[1]!;
    if (!local.endsWith(`:${port}`)) continue;
    const host = local.slice(0, -(String(port).length + 1));
    if (host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '[::]' && host !== '[::1]' && host !== '*') continue;
    const pid = Number(c[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** The process name from `tasklist /FO CSV /NH` output: `"BookScout.exe","1234",...`. */
export function parseTasklist(out: string): string | null {
  const m = /^"([^"]+)"/m.exec(out);
  return m ? m[1]! : null;
}

/** The pid and command from `lsof -Fpc` output: lines `p<pid>` then `c<command>`. */
export function parseLsof(out: string): PortHolder | null {
  let pid = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c') && pid > 0) return { pid, name: line.slice(1) };
  }
  return null;
}

/**
 * Who is listening on `port` on this computer, or null when nobody is or it cannot be found out (no permission, no tool).
 * Best effort and quick: the answer only ever improves a message, so a failure must not stop anything.
 */
export async function findPortHolder(port: number, exec: Run = run, platform: NodeJS.Platform = process.platform): Promise<PortHolder | null> {
  if (platform === 'win32') {
    const pid = parseNetstat(await exec('netstat', ['-ano', '-p', 'TCP']), port);
    if (!pid) return null;
    const name = parseTasklist(await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']));
    return { pid, name: name ?? 'an unknown program' };
  }
  return parseLsof(await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']));
}

/** Short wording for a holder in a message: `BookScout.exe (process 1234)`. */
export function describeHolder(h: PortHolder): string {
  return `${h.name} (process ${h.pid})`;
}

/**
 * Asks `pid` to quit, and when it has not let go of the port after `graceMs`, ends it. Returns whether the port is free afterwards.
 * Windows has no polite signal for a background process, so there it ends at once.
 */
export async function stopPortHolder(pid: number, port: number, find: (port: number) => Promise<PortHolder | null> = findPortHolder, graceMs = 2000): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('refusing to stop that process');
  const holds = async () => (await find(port))?.pid === pid;
  try {
    process.kill(pid, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return !(await holds());
    throw new Error(`could not stop process ${pid}: ${(e as Error).message}`);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await holds())) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* it just exited */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return !(await holds());
}
