/**
 * epubcheck, the standard EPUB validator, as a second opinion when it is installed on this computer (it needs Java). Found by the EPUBCHECK_JAR
 * setting, or an `epubcheck` command on the path. When it is absent Preflight still runs its own checks and says epubcheck was not used.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Finding, Grade } from '@cadrel/kernel';

export type EpubcheckOutcome = { status: 'used'; findings: Finding[] } | { status: 'not installed' } | { status: 'failed'; why: string };
export type EpubcheckRunner = (bytes: Uint8Array) => Promise<EpubcheckOutcome>;

const GRADE: Record<string, Grade> = { FATAL: 'error', ERROR: 'error', WARNING: 'warning', USAGE: 'suggestion', INFO: 'suggestion' };

/** The command that starts epubcheck, or null. */
export function epubcheckCommand(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } | null {
  const jar = env.EPUBCHECK_JAR;
  if (jar && existsSync(jar) && spawnSync('java', ['-version']).status === 0) return { cmd: 'java', args: ['-jar', jar] };
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['epubcheck']);
  return probe.status === 0 ? { cmd: 'epubcheck', args: [] } : null;
}
export const epubcheckInstalled = (): boolean => epubcheckCommand() !== null;

/** epubcheck's JSON report as findings, each with the rule it came from. */
export function epubcheckFindings(report: unknown): Finding[] {
  const msgs = ((report as { messages?: unknown[] })?.messages ?? []) as { ID?: string; severity?: string; message?: string; locations?: { path?: string; line?: number }[] }[];
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const m of msgs) {
    const grade = GRADE[String(m.severity).toUpperCase()];
    if (!grade || !m.message) continue;
    const loc = m.locations?.[0];
    const location = loc?.path ? `${loc.path}${loc.line && loc.line > 0 ? `:${loc.line}` : ''}` : '';
    const key = `${m.ID}|${location}|${m.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ruleId: `epubcheck.${m.ID ?? 'message'}`, grade, what: m.message, location, measured: m.ID ?? '', expected: 'no message from epubcheck' });
  }
  return out;
}

export const runEpubcheck: EpubcheckRunner = async (bytes) => {
  const c = epubcheckCommand();
  if (!c) return { status: 'not installed' };
  const dir = mkdtempSync(path.join(tmpdir(), 'cadrel-epubcheck-'));
  try {
    const file = path.join(dir, 'book.epub');
    const json = path.join(dir, 'report.json');
    writeFileSync(file, bytes);
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(c.cmd, [...c.args, file, '--json', json], { stdio: 'ignore' });
      const t = setTimeout(() => (p.kill(), resolve(null)), 120_000);
      p.on('exit', (x) => (clearTimeout(t), resolve(x)));
      p.on('error', () => (clearTimeout(t), resolve(null)));
    });
    if (!existsSync(json)) return { status: 'failed', why: code === null ? 'epubcheck did not finish' : `epubcheck stopped with code ${code}` };
    return { status: 'used', findings: epubcheckFindings(JSON.parse(readFileSync(json, 'utf8'))) };
  } catch (e) {
    return { status: 'failed', why: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
