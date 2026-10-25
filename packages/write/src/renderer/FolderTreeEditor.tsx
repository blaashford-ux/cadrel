import { validateName } from '../shared/paths';
import type { FolderNode } from '../shared/projects';
import { MAX_FOLDER_DEPTH } from '../shared/projects';
import { Icon } from './Icon';

interface Props {
  nodes: FolderNode[];
  onChange(nodes: FolderNode[]): void;
}

const blank = (): FolderNode => ({ name: '', counts: true, children: [] });

function edit(nodes: FolderNode[], path: number[], fn: (list: FolderNode[], i: number) => FolderNode[]): FolderNode[] {
  if (path.length === 1) return fn(nodes, path[0]);
  const [head, ...rest] = path;
  return nodes.map((n, i) => (i === head ? { ...n, children: edit(n.children, rest, fn) } : n));
}

/** Edits a nested list of folder names: rename, reorder, add a sub-folder, remove, and whether each counts toward the goal. */
export function FolderTreeEditor({ nodes, onChange }: Props) {
  const rows = (list: FolderNode[], path: number[], siblings: FolderNode[]): JSX.Element[] =>
    list.flatMap((n, i) => {
      const here = [...path, i];
      const problem = n.name === '' ? 'Needs a name' : validateName(n.name) ?? (siblings.some((o, j) => j !== i && o.name.trim().toLowerCase() === n.name.trim().toLowerCase()) ? 'Appears twice' : null);
      const depth = path.length;
      const move = (d: -1 | 1) =>
        onChange(
          edit(nodes, here, (l, k) => {
            const j = k + d;
            if (j < 0 || j >= l.length) return l;
            const next = l.slice();
            [next[k], next[j]] = [next[j], next[k]];
            return next;
          })
        );
      return [
        <div className="folder-row" key={here.join('.')} style={{ paddingLeft: depth * 22 }}>
          <Icon name="folder" size={15} className="kind-dir" />
          <input
            className={'folder-name' + (problem ? ' bad-input' : '')}
            aria-label="Folder name"
            aria-invalid={problem ? true : undefined}
            value={n.name}
            placeholder="Folder name"
            onChange={(e) => onChange(edit(nodes, here, (l, k) => l.map((x, j) => (j === k ? { ...x, name: e.target.value } : x))))}
          />
          <label className="folder-counts" title="Words in this folder count toward the project's word goal">
            <input type="checkbox" checked={n.counts} onChange={(e) => onChange(edit(nodes, here, (l, k) => l.map((x, j) => (j === k ? { ...x, counts: e.target.checked } : x))))} />
            counts
          </label>
          <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(-1)}>
            <Icon name="up" size={14} />
          </button>
          <button type="button" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(1)}>
            <Icon name="down" size={14} />
          </button>
          <button
            type="button"
            aria-label="Add a sub-folder"
            title="Add a sub-folder"
            disabled={depth + 1 >= MAX_FOLDER_DEPTH}
            onClick={() => onChange(edit(nodes, here, (l, k) => l.map((x, j) => (j === k ? { ...x, children: [...x.children, blank()] } : x))))}
          >
            <Icon name="folderPlus" size={14} />
          </button>
          <button type="button" aria-label="Remove folder" onClick={() => onChange(edit(nodes, here, (l, k) => l.filter((_, j) => j !== k)))}>
            <Icon name="close" size={14} />
          </button>
          {problem && <span className="bad small">{problem}</span>}
        </div>,
        ...rows(n.children, here, n.children)
      ];
    });

  return (
    <div className="folder-tree-editor">
      {nodes.length === 0 && <p className="muted small">No folders: projects made from this template start empty.</p>}
      {rows(nodes, [], nodes)}
      <button type="button" className="add-row" onClick={() => onChange([...nodes, blank()])}>
        <Icon name="plus" size={14} /> Add a folder
      </button>
    </div>
  );
}
