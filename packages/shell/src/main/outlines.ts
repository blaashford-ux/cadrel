import { nodeFs } from '@cadrel/write/electron/nodeFs';
import { listOutlines, readOutline, type AgentContext } from '@cadrel/write/src/shared/agent/tools';
import type { OutlineSource } from '@cadrel/market-library';

/** The outline documents in the Studio's projects folder, for Market's keyword suggestions. The projects folder is asked for each time, since the person can move it. */
export function projectOutlines(root: () => string): OutlineSource {
  const ctx = (): AgentContext => ({ fs: nodeFs, root: root(), agent: 'cadrel', agentName: 'Cadrel' });
  return {
    list: async () => (await listOutlines(ctx())).map((o) => ({ project: o.project, file: o.file, title: o.title, words: o.words })),
    read: async (ref) => (await readOutline(ctx(), ref.project, ref.file).catch(() => null))?.text ?? null
  };
}
