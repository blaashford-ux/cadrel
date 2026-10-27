// The built server as a child process: it must leave when it should, so it never lingers and never holds the installed program's files open.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const PKG = path.resolve(__dirname, '..');
const BUNDLE = path.join(PKG, 'dist', 'mcp.mjs');
beforeAll(() => execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' }), 60000);

function start(extra: string[] = []): { child: ChildProcess; ready: Promise<void>; exited: Promise<number | null> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-life-'));
  fs.mkdirSync(path.join(dir, 'books'));
  const child = spawn('node', [BUNDLE, '--root', path.join(dir, 'books'), '--studio', path.join(dir, 'studio.json'), ...extra], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CADREL_WRITE_ROOT: '', APPDATA: dir, HOME: dir } });
  let err = '';
  const ready = new Promise<void>((resolve, reject) => {
    child.stderr!.on('data', (d: Buffer) => {
      err += d.toString();
      if (/server ready/i.test(err)) resolve();
    });
    child.on('exit', () => reject(new Error(`exited before it was ready: ${err}`)));
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, ready: ready.catch(() => undefined), exited };
}
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

describe('the server leaves when it should', () => {
  it('when its connection closes (the AI app quit, or the launcher in between was killed)', async () => {
    const s = start();
    await s.ready;
    s.child.stdin!.end();
    expect(await within(s.exited, 8000)).toBe(0);
  }, 30000);

  it('when an update writes the marker next to the program', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-marker-')), '.cadrel-retire');
    const s = start(['--retire-file', marker]);
    await s.ready;
    expect(await within(s.exited, 2500)).toBe('timeout'); // still serving
    fs.writeFileSync(marker, '');
    expect(await within(s.exited, 8000)).toBe(0);
  }, 30000);

  it('at once when it is started during an update', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-marker-')), '.cadrel-retire');
    fs.writeFileSync(marker, '');
    const s = start(['--retire-file', marker]);
    expect(await within(s.exited, 10000)).toBe(0);
  }, 30000);

  it('when told to stop', async () => {
    const s = start();
    await s.ready;
    s.child.kill('SIGTERM');
    expect(await within(s.exited, 8000)).toBe(0);
  }, 30000);
});
