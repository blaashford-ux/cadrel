import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../src/shared/memoryFs';
// @ts-expect-error plain JS build script
import { skillsSource } from '../scripts/skills.mjs';
import { createServer } from './server';
import { SKILLS } from './skills.generated';

// Paths are the package's own, so the test passes from the repo root as well as from this folder.
const at = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const allFolders = readdirSync(at('skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const REVIEW = ['cadrel-copy-edit', 'cadrel-developmental-edit', 'cadrel-line-edit'];
const AUTHOR = ['cadrel-litrpg-tracker', 'cadrel-outline-to-blurb', 'cadrel-outline-to-keywords', 'cadrel-premise-to-outline', 'cadrel-series-developer', 'cadrel-timeline-tracker'];
const folders = REVIEW;
const read = (f: string) => readFileSync(at(`skills/${f}/SKILL.md`), 'utf8');

describe('the skills', () => {
  it('are the three editing passes and the six authoring skills', () => {
    expect(allFolders).toEqual([...REVIEW, ...AUTHOR]);
    expect(SKILLS.filter((s) => s.kind === 'author').map((s) => s.name)).toEqual(AUTHOR);
  });

  it('sign the editing passes with their own tags', () => {
    expect(SKILLS.filter((s) => s.kind === 'review').map((s) => [s.id, s.tag])).toEqual([
      ['copy_edit', 'Copy edit'],
      ['developmental_edit', 'Developmental edit'],
      ['line_edit', 'Line edit'],
    ]);
  });

  it('are in step with the generated prompts (run `npm run build:skills` if this fails)', () => {
    expect(readFileSync(at('mcp/skills.generated.ts'), 'utf8')).toBe(skillsSource());
  });

  it('share one identical "Working in Cadrel Write" section, so a fix to it can’t miss a skill', () => {
    const section = (f: string) => /## Working in Cadrel Write[\s\S]*?(?=\nUse `skill:)/.exec(read(f))?.[0];
    const [first, ...rest] = folders.map(section);
    expect(first).toContain('add_notes');
    for (const other of rest) expect(other).toBe(first);
  });

  it('are not specific to one genre', () => {
    for (const f of folders) expect(read(f), f).not.toMatch(/litrpg|progression|harem|\bXP\b|stat block|romance|fantasy/i);
  });

  it('keep the authoring skills standalone: nothing in them points at another skill or at the orchestrator', () => {
    for (const f of AUTHOR) {
      expect(read(f).replace(/^name: .*$/m, ''), f).not.toMatch(/orchestrator|beat-to-prose|beat_to_prose|location-designer|voice-[a-z]|series-concept-developer|premise-to-outline|outline-to-blurb|outline-to-keywords|litrpg-tracker|timeline-tracker|create_file|present_files|ask_user_input|\/mnt\/|story-state|Visualizer/i);
    }
  });

  it('give each tracker its page templates, and the pages show only what the skill says they do', () => {
    const files = (n: string) => Object.keys(SKILLS.find((s) => s.name === n)!.files).sort();
    expect(files('cadrel-timeline-tracker')).toEqual(['assets/timeline-view.html']);
    expect(files('cadrel-litrpg-tracker')).toEqual(['assets/chapter-record.html', 'assets/character-sheet.html', 'assets/litrpg-dashboard.html']);
    for (const t of ['cadrel-timeline-tracker/assets/timeline-view.html', 'cadrel-litrpg-tracker/assets/litrpg-dashboard.html', 'cadrel-litrpg-tracker/assets/character-sheet.html', 'cadrel-litrpg-tracker/assets/chapter-record.html']) {
      const html = readFileSync(at(`skills/${t}`), 'utf8');
      expect(html.split('__CADREL_DATA__')).toHaveLength(2);
      expect(html.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\/|<script[^>]+src=/);
    }
    const sheet = readFileSync(at('skills/cadrel-litrpg-tracker/assets/character-sheet.html'), 'utf8');
    expect(sheet.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/source_quote|consistency|flag|note|declined/i);
  });

  it('only use tools the server has, and are valid skill files', async () => {
    const server = createServer({ fs: new MemoryFs(), root: '/books' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'x', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const f of allFolders) {
      expect(read(f)).toMatch(new RegExp(`^---\\nname: ${f}\\ndescription: ".+"\\n---\\n`));
      const mentioned = read(f).match(/`(list_\w+|read_\w+|get_notes|add_notes|search_text|reply_to_note|withdraw_note|write_project_file|edit_project_file|check_keywords|check_tracker|litrpg_log|litrpg_state|timeline_log|build_tracker_view)`/g) ?? [];
      for (const name of mentioned) expect(tools, `${f} mentions ${name}`).toContain(name.replace(/`/g, ''));
    }
    await client.close();
  });

  it('are offered as MCP prompts for clients without skills', async () => {
    const server = createServer({ fs: new MemoryFs(), root: '/books' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'openai-mcp', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['copy_edit', 'developmental_edit', 'line_edit', 'litrpg_tracker', 'outline_to_blurb', 'outline_to_keywords', 'premise_to_outline', 'series_developer', 'timeline_tracker']);
    const withArgs = await client.getPrompt({ name: 'line_edit', arguments: { project: 'Novel', file: 'Manuscript/Book.md' } });
    const text = (withArgs.messages[0].content as { text: string }).text;
    expect(text).toContain('# Line Edit (Cadrel Write)');
    expect(text).toContain('Review the project "Novel", file "Manuscript/Book.md"');
    expect(text).toContain('skill "Line edit"');
    const bare = (await client.getPrompt({ name: 'copy_edit' })).messages[0].content as { text: string };
    expect(bare.text).toContain('Ask me which project to review.');
    const author = (await client.getPrompt({ name: 'litrpg_tracker', arguments: { project: 'Novel', request: 'log chapters 1 to 5' } })).messages[0].content as { text: string };
    expect(author.text).toContain('# LitRPG Tracker (Cadrel)');
    expect(author.text).toContain('Work in the project "Novel".');
    expect(author.text).toContain('What I want: log chapters 1 to 5');
    expect(author.text).not.toContain('add_notes using skill');
    await client.close();
  });
});

describe('the skills know the series level from the Book level', () => {
  it('the series developer works at the series level: the project, never a Book', () => {
    const t = read('cadrel-series-developer');
    expect(t).toMatch(/work at the series level/);
    expect(t).toMatch(/leave `book` out/);
    expect(t).toMatch(/series' own folder, not in one Book's/);
  });

  it('the Book-level authoring skills read the series first, pass the Book, and save in the Book', () => {
    for (const f of ['cadrel-premise-to-outline', 'cadrel-outline-to-blurb', 'cadrel-outline-to-keywords']) {
      const t = read(f);
      expect(t, f).toMatch(/this work is for \*\*one Book\*\*/);
      expect(t, f).toMatch(/read first/);
      expect(t, f).toMatch(/starting with the series/);
      expect(t, f).toMatch(/pass the same `book`/);
      expect(t, f).toMatch(/closed Book is read-only/);
    }
  });

  it('the trackers work on one Book at a time, carry the earlier Books forward, and keep one ledger file for a series', () => {
    for (const f of ['cadrel-litrpg-tracker', 'cadrel-timeline-tracker']) expect(read(f), f).toMatch(/pass `book` on every call/);
    expect(read('cadrel-litrpg-tracker')).toMatch(/earlier Books' ledgers in front/);
    expect(read('cadrel-timeline-tracker')).toMatch(/one story clock/);
    expect(read('cadrel-timeline-tracker')).toMatch(/earlier Books' days in front/);
    for (const f of ['cadrel-litrpg-tracker', 'cadrel-timeline-tracker']) expect(read(f), f).toMatch(/series' own folder/);
  });

  it('the editing passes review one Book and read the series material first', () => {
    for (const f of REVIEW) {
      const t = read(f);
      expect(t, f).toMatch(/one Book's manuscript/);
      expect(t, f).toMatch(/`studio_context`/);
      expect(t, f).toMatch(/pass `book` on every call/);
      expect(t, f).toMatch(/closed Book can be read but not given notes/);
    }
  });

  it('every tool that names a project also takes a book', async () => {
    const server = createServer({ fs: new MemoryFs(), root: '/books' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'x', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    const withProject = tools.filter((t) => 'project' in ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}));
    expect(withProject.length).toBeGreaterThanOrEqual(20);
    for (const t of withProject) expect((t.inputSchema as { properties: Record<string, unknown> }).properties, t.name).toHaveProperty('book');
    await client.close();
  });
});
