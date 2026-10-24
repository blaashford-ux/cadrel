import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildKit } from '../src/shared/agent/kit';
import { SKILLS } from './skills.generated';

const BUNDLE = 'dist-electron/mcp/mdedit-mcp.js';

// Needs the built server (`npm run build:electron`); skipped when it hasn't been built.
describe.skipIf(!existsSync(BUNDLE))('the AI Kit with the real server', () => {
  it('writes an extension whose server starts from inside it and reviews a project', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mdedit-kit-'));
    const root = path.join(dir, 'books');
    mkdirSync(path.join(root, 'Novel', '.mdedit'), { recursive: true });
    writeFileSync(path.join(root, 'Novel', '.mdedit', 'project.json'), '{"status":"editing"}');
    writeFileSync(path.join(root, 'Novel', 'Book.md'), '# One\n\nShe walked slowly to the door.\n');

    const kit = buildKit({ skills: SKILLS, server: readFileSync(BUNDLE), version: '0.6.0', root, serverPath: path.join(dir, 'mdedit-mcp.js') });
    const out = path.join(dir, 'kit');
    for (const f of kit) {
      const target = path.join(out, ...f.path.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, f.data);
    }
    // Unpack the extension as Claude Desktop would, and start the server the way its manifest says.
    const ext = path.join(dir, 'ext');
    for (const [name, data] of Object.entries(unzipSync(readFileSync(path.join(out, 'mdedit.mcpb'))))) {
      mkdirSync(path.dirname(path.join(ext, name)), { recursive: true });
      writeFileSync(path.join(ext, name), data);
    }
    const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8')) as { server: { mcp_config: { command: string; args: string[] } } };
    const args = manifest.server.mcp_config.args.map((a) => a.replace('${__dirname}', ext).replace('${user_config.root_folder}', root));
    const client = new Client({ name: 'claude-ai', version: '1' });
    await client.connect(new StdioClientTransport({ command: manifest.server.mcp_config.command, args }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('add_notes');
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
    expect(JSON.parse(text(await client.callTool({ name: 'list_projects', arguments: {} })))).toEqual([{ project: 'Novel', status: 'editing' }]);
    await client.callTool({ name: 'add_notes', arguments: { project: 'Novel', skill: 'Line edit', notes: [{ file: 'Book.md', kind: 'comment', quote: 'slowly', body: 'Adverb.' }] } });
    expect(readFileSync(path.join(root, 'Novel', '.mdedit', 'review', 'ai-claude-line.json'), 'utf8')).toContain('Claude · Line edit');
    await client.close();
  }, 30000);
});
