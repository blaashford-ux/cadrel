import type { DirNode, TreeNode } from '../shared/api';
import type { MarkdownDoc } from '../shared/chapters';
import { countWords } from '../shared/words';

export interface Row {
  /** Unique key: the path, or `path#index` for a chapter. */
  key: string;
  kind: 'dir' | 'file' | 'chapter';
  path: string;
  chapter?: number;
  depth: number;
  label: string;
  expandable: boolean;
  expanded: boolean;
  parentKey: string | null;
  /** Word count, for chapters of files that have been read. */
  words?: number;
  /** File marked for export. */
  marked?: boolean;
  /** File that can't be marked because another file with the same name owns the export settings. */
  exportBlocked?: boolean;
}

/**
 * Keeps items whose name matches, plus the folders leading to them. A folder whose own name
 * matches is kept whole (empty or not). Null when nothing matches.
 */
export function filterTree(node: TreeNode, query: string): TreeNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;
  const nameMatches = node.name.toLowerCase().includes(q);
  if (node.kind === 'file') return nameMatches ? node : null;
  if (nameMatches) return node;
  const children = node.children.map((c) => filterTree(c, q)).filter((c): c is TreeNode => c !== null);
  return children.length > 0 ? { ...node, children } : null;
}

export const chapterKey = (file: string, i: number) => `${file}#${i}`;

export function chapterLabel(c: { title: string; isPreamble: boolean }): string {
  if (c.isPreamble) return '(Preamble)';
  return c.title || '(untitled)';
}

/** The visible rows of the tree, in order. While filtering, folders are shown expanded. */
export function buildRows(
  root: DirNode,
  expanded: Set<string>,
  docs: Map<string, MarkdownDoc>,
  filter: string
): Row[] {
  const filtered = filterTree(root, filter);
  if (!filtered || filtered.kind !== 'dir') return [];
  const filtering = filter.trim() !== '';
  const rows: Row[] = [];

  const walk = (nodes: TreeNode[], depth: number, parentKey: string | null) => {
    for (const n of nodes) {
      // An empty folder has nothing to expand, so it gets no arrow.
      const expandable = n.kind === 'file' || n.children.length > 0;
      const open = expandable && (n.kind === 'dir' ? filtering || expanded.has(n.path) : expanded.has(n.path));
      rows.push({
        key: n.path,
        kind: n.kind,
        path: n.path,
        depth,
        label: n.name,
        expandable,
        expanded: open,
        parentKey,
        ...(n.kind === 'file' && n.marked ? { marked: true } : {}),
        ...(n.kind === 'file' && n.exportBlocked ? { exportBlocked: true } : {})
      });
      if (!open) continue;
      if (n.kind === 'dir') {
        walk(n.children, depth + 1, n.path);
      } else {
        docs.get(n.path)?.chapters.forEach((c, i) =>
          rows.push({
            key: chapterKey(n.path, i),
            kind: 'chapter',
            path: n.path,
            chapter: i,
            depth: depth + 1,
            label: chapterLabel(c),
            expandable: false,
            expanded: false,
            parentKey: n.path,
            words: countWords(c.raw)
          })
        );
      }
    }
  };
  walk(filtered.children, 0, null);
  return rows;
}

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Enter';
export interface NavResult {
  focus?: string;
  expand?: string;
  collapse?: string;
  activate?: string;
}

/** What a key press does on the focused row of a tree (WAI-ARIA tree pattern). */
export function navigate(rows: Row[], focusKey: string | null, key: NavKey): NavResult {
  if (rows.length === 0) return {};
  const i = rows.findIndex((r) => r.key === focusKey);
  const cur = i >= 0 ? rows[i] : null;
  switch (key) {
    case 'ArrowDown':
      return { focus: rows[Math.min(i + 1, rows.length - 1)].key };
    case 'ArrowUp':
      return { focus: rows[Math.max(i - 1, 0)].key };
    case 'Home':
      return { focus: rows[0].key };
    case 'End':
      return { focus: rows[rows.length - 1].key };
    case 'ArrowRight':
      if (!cur) return { focus: rows[0].key };
      if (cur.expandable && !cur.expanded) return { expand: cur.key };
      if (cur.expanded && rows[i + 1] && rows[i + 1].depth > cur.depth) return { focus: rows[i + 1].key };
      return {};
    case 'ArrowLeft':
      if (!cur) return {};
      if (cur.expandable && cur.expanded) return { collapse: cur.key };
      return cur.parentKey ? { focus: cur.parentKey } : {};
    case 'Enter':
      return cur ? { activate: cur.key } : {};
  }
}
