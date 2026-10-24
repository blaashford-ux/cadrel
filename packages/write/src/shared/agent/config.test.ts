import { describe, expect, it } from 'vitest';
import { newReviewFile, serializeReviewFile, type ReviewItem } from '../review/comments';
import { aiConfigSnippets, aiReviewers } from './config';

const item = (o: Partial<ReviewItem>): ReviewItem => ({ id: 'a', kind: 'comment', file: 'f.md', anchor: { quote: 'q', prefix: '', suffix: '', start: 0 }, body: 'b', status: 'open', author: 'x', createdAt: '', updatedAt: '', replies: [], ...o });
const file = (id: string, name: string, items: ReviewItem[]) => ({ id, text: serializeReviewFile({ ...newReviewFile('P', { id, name }), items }) });

describe('config snippets', () => {
  const win = { root: 'C:\\Users\\me\\MDEdit', command: 'C:\\Program Files\\MDEdit\\MDEdit.exe', args: ['C:\\Program Files\\MDEdit\\resources\\app.asar.unpacked\\mdedit-mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };

  it('quotes paths with spaces for the command line', () => {
    expect(aiConfigSnippets(win).claudeCode).toBe(
      'claude mcp add --env ELECTRON_RUN_AS_NODE=1 mdedit -- "C:\\Program Files\\MDEdit\\MDEdit.exe" "C:\\Program Files\\MDEdit\\resources\\app.asar.unpacked\\mdedit-mcp.js"'
    );
  });

  it('writes valid JSON for Claude Desktop', () => {
    expect(JSON.parse(aiConfigSnippets(win).claudeDesktop)).toEqual({ mcpServers: { mdedit: { command: win.command, args: win.args, env: win.env } } });
  });

  it('writes TOML with literal strings for Codex, and leaves out empty env', () => {
    expect(aiConfigSnippets(win).codex).toBe(
      "[mcp_servers.mdedit]\ncommand = 'C:\\Program Files\\MDEdit\\MDEdit.exe'\nargs = ['C:\\Program Files\\MDEdit\\resources\\app.asar.unpacked\\mdedit-mcp.js']\nenv = { ELECTRON_RUN_AS_NODE = '1' }"
    );
    const plain = aiConfigSnippets({ root: '/r', command: 'node', args: ['/x/mdedit-mcp.js'] });
    expect(plain.claudeCode).toBe('claude mcp add mdedit -- node /x/mdedit-mcp.js');
    expect(plain.codex).not.toContain('env');
    expect(JSON.parse(plain.claudeDesktop).mcpServers.mdedit.env).toBeUndefined();
  });
});

describe('AI reviewers in a project', () => {
  it('lists the AI review files with open and total counts, and skips people and deleted notes', () => {
    const list = aiReviewers([
      file('owner', 'Me', [item({}), item({ id: 'x', origin: 'ai' })]), // never listed, whatever its notes say
      file('ai-claude', 'Claude', [item({ id: '1' }), item({ id: '2', status: 'resolved' }), item({ id: '3', status: 'deleted' })]),
      file('ai-gpt-line', 'GPT · Line edit', [item({ id: '4', origin: 'ai' })]),
      { id: 'broken', text: 'not json' },
    ]);
    expect(list).toEqual([
      { id: 'ai-claude', name: 'Claude', open: 1, total: 2 },
      { id: 'ai-gpt-line', name: 'GPT · Line edit', open: 1, total: 1 },
    ]);
  });
});
