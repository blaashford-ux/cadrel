import type { FileNode, TreeNode } from './api';

/** Every folder and file path in the tree, including the root. */
export function flattenPaths(node: TreeNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode) => {
    out.add(n.path);
    if (n.kind === 'dir') n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** Every file in the tree for which `pred` holds. */
export function collectFiles(node: TreeNode, pred: (f: FileNode) => boolean): FileNode[] {
  if (node.kind === 'file') return pred(node) ? [node] : [];
  return node.children.flatMap((c) => collectFiles(c, pred));
}

/** Export-settings files whose manuscript is gone, anywhere in the tree. */
export function collectOrphans(node: TreeNode): string[] {
  if (node.kind === 'file') return [];
  return [...(node.orphanSidecars ?? []), ...node.children.flatMap(collectOrphans)];
}

export function findNode(node: TreeNode, path: string): TreeNode | null {
  if (node.path === path) return node;
  if (node.kind === 'dir') {
    for (const c of node.children) {
      const hit = findNode(c, path);
      if (hit) return hit;
    }
  }
  return null;
}
