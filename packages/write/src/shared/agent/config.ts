import { parseReviewFile } from '../review/comments';

/** How to start the MDEdit MCP server: what an AI app puts in its settings. */
export interface AiServerInfo {
  /** The folder holding the projects (where the server looks). */
  root: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** Ready-to-paste settings for the AI apps we know. TOML uses literal strings so Windows backslashes need no escaping. */
export function aiConfigSnippets(s: AiServerInfo): { claudeCode: string; claudeDesktop: string; codex: string } {
  const env = Object.entries(s.env ?? {});
  const toml = (v: string) => (v.includes("'") ? JSON.stringify(v) : `'${v}'`);
  return {
    claudeCode: ['claude mcp add', ...env.map(([k, v]) => `--env ${k}=${v}`), 'mdedit --', quote(s.command), ...s.args.map(quote)].join(' '),
    claudeDesktop: JSON.stringify({ mcpServers: { mdedit: { command: s.command, args: s.args, ...(env.length ? { env: s.env } : {}) } } }, null, 2),
    codex: [
      '[mcp_servers.mdedit]',
      `command = ${toml(s.command)}`,
      `args = [${s.args.map(toml).join(', ')}]`,
      ...(env.length ? [`env = { ${env.map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`] : []),
    ].join('\n'),
  };
}

export interface AiReviewerSummary {
  /** The review file's id (also its file name). */
  id: string;
  name: string;
  open: number;
  total: number;
}

/**
 * The AI reviewers among a project's review files, for the "Connect AI" dialog. Only files the MCP server names `ai-…` count:
 * the dialog can delete them, so nothing else (the author's own notes, a person's file) may ever be listed.
 */
export function aiReviewers(files: { id: string; text: string }[]): AiReviewerSummary[] {
  const out: AiReviewerSummary[] = [];
  for (const { id, text } of files) {
    const f = parseReviewFile(text);
    if (!f) continue;
    const items = f.items.filter((i) => i.status !== 'deleted');
    if (!id.startsWith('ai-')) continue;
    out.push({ id, name: f.reviewer.name || id, open: items.filter((i) => i.status === 'open').length, total: items.length });
  }
  return out;
}

/** The online-access switch, as the "Connect AI" dialog shows it. */
export interface AiRemoteStatus {
  /** The user turned it on. */
  enabled: boolean;
  /** The server is listening now (it may not be, if the port was taken). */
  running: boolean;
  port: number;
  /** The secret every request must carry. */
  token: string;
  mcpUrl: string;
  apiUrl: string;
  openApiUrl: string;
  error: string | null;
}
