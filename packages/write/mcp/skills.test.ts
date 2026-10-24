import { readdirSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../src/shared/memoryFs';
// @ts-expect-error plain JS build script
import { skillsSource } from '../scripts/skills.mjs';
import { createServer } from './server';
import { SKILLS } from './skills.generated';

const folders = readdirSync('skills', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const read = (f: string) => readFileSync(`skills/${f}/SKILL.md`, 'utf8');

describe('the skills', () => {
  it('are the three editing passes, each signing with its own tag', () => {
    expect(SKILLS.map((s) => [s.id, s.tag])).toEqual([
      ['copy_edit', 'Copy edit'],
      ['developmental_edit', 'Developmental edit'],
      ['line_edit', 'Line edit'],
    ]);
  });

  it('are in step with the generated prompts (run `npm run build:skills` if this fails)', () => {
    expect(readFileSync('mcp/skills.generated.ts', 'utf8')).toBe(skillsSource());
  });

  it('share one identical "Working in MDEdit" section, so a fix to it can’t miss a skill', () => {
    const section = (f: string) => /## Working in MDEdit[\s\S]*?(?=\nUse `skill:)/.exec(read(f))?.[0];
    const [first, ...rest] = folders.map(section);
    expect(first).toContain('add_notes');
    for (const other of rest) expect(other).toBe(first);
  });

  it('are not specific to one genre', () => {
    for (const f of folders) expect(read(f), f).not.toMatch(/litrpg|progression|harem|\bXP\b|stat block|romance|fantasy/i);
  });

  it('only use tools the server has, and are valid skill files', async () => {
    const server = createServer({ fs: new MemoryFs(), root: '/books' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'x', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const f of folders) {
      expect(read(f)).toMatch(new RegExp(`^---\\nname: ${f}\\ndescription: ".+"\\n---\\n`));
      for (const name of read(f).match(/`(list_\w+|read_chapter|get_notes|add_notes|search_text|reply_to_note|withdraw_note)`/g) ?? []) expect(tools, `${f} mentions ${name}`).toContain(name.replace(/`/g, ''));
    }
    await client.close();
  });

  it('are offered as MCP prompts for clients without skills', async () => {
    const server = createServer({ fs: new MemoryFs(), root: '/books' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'openai-mcp', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['copy_edit', 'developmental_edit', 'line_edit']);
    const withArgs = await client.getPrompt({ name: 'line_edit', arguments: { project: 'Novel', file: 'Manuscript/Book.md' } });
    const text = (withArgs.messages[0].content as { text: string }).text;
    expect(text).toContain('# Line Edit (MDEdit)');
    expect(text).toContain('Review the project "Novel", file "Manuscript/Book.md"');
    expect(text).toContain('skill "Line edit"');
    const bare = (await client.getPrompt({ name: 'copy_edit' })).messages[0].content as { text: string };
    expect(bare.text).toContain('Ask me which project to review.');
    await client.close();
  });
});
