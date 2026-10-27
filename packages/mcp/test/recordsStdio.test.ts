// The built bundle as a child process, given the Studio's records file and the person to act for, the way the app launches it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapStudio } from '@cadrel/kernel';
import { openStudioDb } from '@cadrel/store';
import { Studio } from '@cadrel/studio';

const PKG = path.resolve(__dirname, '..');
const BUNDLE = path.join(PKG, 'dist', 'mcp.mjs');
beforeAll(() => execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' }), 60000);

async function start(args: (dir: string) => string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-rec-stdio-'));
  const db = await openStudioDb(path.join(dir, 'records.db'));
  await bootstrapStudio(db, { studioId: 'st', actor: 'ana', now: new Date().toISOString() } as never, { id: 'ana', name: 'Ana' });
  db.close();
  await new Studio(path.join(dir, 'studio.json')).createProject({ name: 'Series' });
  const t = new StdioClientTransport({ command: 'node', args: [BUNDLE, '--root', dir, '--studio', path.join(dir, 'studio.json'), ...args(dir)], stderr: 'pipe' });
  const c = new Client({ name: 'claude-ai', version: '1' });
  await c.connect(t);
  return c;
}

describe('the records tools over stdio', () => {
  it('are served when the app gives the records file and the person, and work as that person', async () => {
    const c = await start((d) => ['--records', path.join(d, 'records.db'), '--person', 'ana', '--studio-id', 'st']);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('work_add_task');
    const added = (await c.callTool({ name: 'work_add_task', arguments: { project: 'Series', title: 'Over stdio' } })) as { isError?: boolean };
    expect(added.isError).toBeFalsy();
    const list = (await c.callTool({ name: 'work_tasks', arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(list.content[0]!.text).tasks[0].title).toBe('Over stdio');
    await c.close();
  }, 60000);

  it('are left out without them (the projects and notes tools still work)', async () => {
    const c = await start(() => []);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('studio_projects');
    expect(names.some((n) => n.startsWith('work_'))).toBe(false);
    await c.close();
  }, 60000);
});
