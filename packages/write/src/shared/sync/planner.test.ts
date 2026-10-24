import { describe, expect, it } from 'vitest';
import { plan, planRemoteRenames, type BaseFile, type LocalFile, type PlanInput, type RemoteFile } from './planner';

const L = (path: string, md5: string, modifiedMs = 1000): LocalFile => ({ path, md5, modifiedMs });
const R = (path: string, id: string, md5: string, modifiedMs = 1000): RemoteFile => ({ path, id, md5, modifiedMs });
const B = (path: string, id: string, md5: string): BaseFile => ({ path, id, md5 });

const run = (p: Partial<PlanInput>) => plan({ local: [], remote: [], base: [], device: 'Pixel', today: '2026-10-05', ...p });
const A = 'Novel/Manuscript/Ch 1.md';

describe('first sight of a file (no base)', () => {
  it('uploads a file that is only here', () => {
    expect(run({ local: [L(A, 'a')] }).actions).toEqual([{ type: 'upload', path: A, id: null }]);
  });
  it('downloads a file that is only on Drive', () => {
    expect(run({ remote: [R(A, 'id1', 'a')] }).actions).toEqual([{ type: 'download', path: A, id: 'id1' }]);
  });
  it('just records identical files on both sides', () => {
    expect(run({ local: [L(A, 'a')], remote: [R(A, 'id1', 'a')] }).actions).toEqual([{ type: 'markSynced', path: A, id: 'id1', md5: 'a' }]);
  });
  it('keeps both when different prose exists on both sides', () => {
    const { actions } = run({ local: [L(A, 'x')], remote: [R(A, 'id1', 'y')] });
    expect(actions).toEqual([{ type: 'keepBoth', path: A, id: 'id1', copyPath: 'Novel/Manuscript/Ch 1 (conflict - Pixel - 2026-10-05).md' }]);
  });
});

describe('a file already in sync', () => {
  const base = [B(A, 'id1', 'a')];
  it('does nothing when nothing changed', () => {
    expect(run({ local: [L(A, 'a')], remote: [R(A, 'id1', 'a')], base }).actions).toEqual([]);
  });
  it('uploads a local edit', () => {
    expect(run({ local: [L(A, 'b')], remote: [R(A, 'id1', 'a')], base }).actions).toEqual([{ type: 'upload', path: A, id: 'id1' }]);
  });
  it('downloads a remote edit', () => {
    expect(run({ local: [L(A, 'a')], remote: [R(A, 'id1', 'b')], base }).actions).toEqual([{ type: 'download', path: A, id: 'id1' }]);
  });
  it('is not a conflict when both sides made the same edit', () => {
    expect(run({ local: [L(A, 'b')], remote: [R(A, 'id1', 'b')], base }).actions).toEqual([{ type: 'markSynced', path: A, id: 'id1', md5: 'b' }]);
  });
  it('keeps both when both sides edited prose differently, Drive keeping the name', () => {
    const { actions } = run({ local: [L(A, 'x')], remote: [R(A, 'id1', 'y')], base });
    expect(actions).toEqual([{ type: 'keepBoth', path: A, id: 'id1', copyPath: 'Novel/Manuscript/Ch 1 (conflict - Pixel - 2026-10-05).md' }]);
  });
  it('gives each conflict copy its own name', () => {
    const b2 = 'Novel/Manuscript/Ch 2.md';
    const { actions } = run({
      local: [L(A, 'x'), L(b2, 'x')], remote: [R(A, 'id1', 'y'), R(b2, 'id2', 'y')], base: [B(A, 'id1', 'a'), B(b2, 'id2', 'a')],
    });
    const copies = actions.map((a) => (a.type === 'keepBoth' ? a.copyPath : ''));
    expect(new Set(copies).size).toBe(2);
  });
  it('does not reuse a conflict-copy name that is already there', () => {
    const existing = 'Novel/Manuscript/Ch 1 (conflict - Pixel - 2026-10-05).md';
    const { actions } = run({ local: [L(A, 'x'), L(existing, 'q')], remote: [R(A, 'id1', 'y')], base: [B(A, 'id1', 'a')] });
    const k = actions.find((a) => a.type === 'keepBoth');
    expect(k && k.type === 'keepBoth' && k.copyPath).toBe('Novel/Manuscript/Ch 1 (conflict - Pixel - 2026-10-05) 2.md');
  });
});

describe('conflicts in non-prose files', () => {
  const meta = 'Novel/.mdedit/project.json';
  const base = [B(meta, 'm1', 'a')];
  it('last writer wins for settings: local newer uploads', () => {
    expect(run({ local: [L(meta, 'x', 2000)], remote: [R(meta, 'm1', 'y', 1000)], base }).actions).toEqual([{ type: 'upload', path: meta, id: 'm1' }]);
  });
  it('last writer wins for settings: remote newer (or tied) downloads', () => {
    expect(run({ local: [L(meta, 'x', 1000)], remote: [R(meta, 'm1', 'y', 2000)], base }).actions).toEqual([{ type: 'download', path: meta, id: 'm1' }]);
    expect(run({ local: [L(meta, 'x', 1000)], remote: [R(meta, 'm1', 'y', 1000)], base }).actions).toEqual([{ type: 'download', path: meta, id: 'm1' }]);
  });
  it('never makes a conflict copy of settings or assets', () => {
    const png = 'Novel/Research/map.png';
    const { actions } = run({ local: [L(png, 'x')], remote: [R(png, 'p1', 'y')], base: [B(png, 'p1', 'a')] });
    expect(actions.some((a) => a.type === 'keepBoth')).toBe(false);
  });
  it('merges edited-chapter marks instead of copying them', () => {
    const marks = 'Novel/.mdedit/edited.json';
    expect(run({ local: [L(marks, 'x')], remote: [R(marks, 'g1', 'y')], base: [B(marks, 'g1', 'a')] }).actions).toEqual([{ type: 'mergeMarks', path: marks, id: 'g1' }]);
  });
  it('merges progress history instead of copying it', () => {
    const prog = 'Novel/.mdedit/progress.json';
    expect(run({ local: [L(prog, 'x')], remote: [R(prog, 'g1', 'y')], base: [B(prog, 'g1', 'a')] }).actions).toEqual([{ type: 'mergeProgress', path: prog, id: 'g1' }]);
  });
});

describe('deletes', () => {
  const base = [B(A, 'id1', 'a')];
  it('propagates a delete from Drive when the local copy is unchanged', () => {
    expect(run({ local: [L(A, 'a')], base }).actions).toEqual([{ type: 'deleteLocal', path: A }]);
  });
  it('propagates a local delete to Drive when Drive is unchanged', () => {
    expect(run({ remote: [R(A, 'id1', 'a')], base }).actions).toEqual([{ type: 'deleteRemote', path: A, id: 'id1' }]);
  });
  it('an edit beats a delete: edited here, deleted on Drive → upload as new', () => {
    expect(run({ local: [L(A, 'b')], base }).actions).toEqual([{ type: 'upload', path: A, id: null }]);
  });
  it('an edit beats a delete: edited on Drive, deleted here → download', () => {
    expect(run({ remote: [R(A, 'id1', 'b')], base }).actions).toEqual([{ type: 'download', path: A, id: 'id1' }]);
  });
  it('forgets a file that vanished from both sides', () => {
    expect(run({ base }).actions).toEqual([{ type: 'forget', path: A }]);
  });
  it('asks for confirmation when a large share of the files would be deleted', () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `Novel/${n}.md`);
    const p = run({ remote: names.map((n, i) => R(n, `i${i}`, 'h')), base: names.map((n, i) => B(n, `i${i}`, 'h')) });
    expect(p.actions.every((a) => a.type === 'deleteRemote')).toBe(true);
    expect(p.confirmDeletes).toBe(true);
  });
  it('does not ask for a single ordinary delete', () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `Novel/${n}.md`);
    const local = names.slice(1).map((n) => L(n, 'h'));
    const remote = names.map((n, i) => R(n, `i${i}`, 'h'));
    expect(run({ local, remote, base: names.map((n, i) => B(n, `i${i}`, 'h')) }).confirmDeletes).toBe(false);
  });
});

describe('renames', () => {
  it('follows a rename made on Drive by file ID', () => {
    const p = run({ local: [L('Novel/old.md', 'a')], remote: [R('Novel/new.md', 'id1', 'a')], base: [B('Novel/old.md', 'id1', 'a')] });
    expect(p.actions).toEqual([{ type: 'renameLocal', from: 'Novel/old.md', to: 'Novel/new.md' }]);
  });
  it('still downloads a remote edit that came with the rename', () => {
    const p = run({ local: [L('Novel/old.md', 'a')], remote: [R('Novel/new.md', 'id1', 'b')], base: [B('Novel/old.md', 'id1', 'a')] });
    expect(p.actions).toEqual([{ type: 'renameLocal', from: 'Novel/old.md', to: 'Novel/new.md' }, { type: 'download', path: 'Novel/new.md', id: 'id1' }]);
  });
  it('turns a local rename into a rename on Drive so the file keeps its ID', () => {
    const p = run({ local: [L('Novel/new.md', 'a')], remote: [R('Novel/old.md', 'id1', 'a')], base: [B('Novel/old.md', 'id1', 'a')] });
    expect(p.actions).toEqual([{ type: 'renameRemote', id: 'id1', from: 'Novel/old.md', to: 'Novel/new.md' }]);
  });
  it('treats a local rename plus an edit as delete + new file', () => {
    const p = run({ local: [L('Novel/new.md', 'b')], remote: [R('Novel/old.md', 'id1', 'a')], base: [B('Novel/old.md', 'id1', 'a')] });
    expect(p.actions.map((a) => a.type).sort()).toEqual(['deleteRemote', 'upload']);
  });
  it('matches names regardless of case', () => {
    expect(run({ local: [L('Novel/ch1.md', 'a')], remote: [R('Novel/Ch1.md', 'id1', 'a')], base: [B('Novel/Ch1.md', 'id1', 'a')] }).actions).toEqual([]);
  });
});

describe('what never syncs', () => {
  it('ignores temp files, per-device data and Exports', () => {
    const p = run({ local: [L('Novel/a.md.mdedit-9.tmp', 'x'), L('Novel/.mdedit/drafts/d.json', 'x'), L('Novel/Exports/b.epub', 'x')] });
    expect(p.actions).toEqual([]);
    expect(p.skipped).toEqual([]);
  });
  it('syncs Exports when asked', () => {
    expect(run({ local: [L('Novel/Exports/b.epub', 'x')], includeExports: true }).actions).toHaveLength(1);
  });
  it('skips, and reports, names that are not valid on Windows', () => {
    const p = run({ local: [L('Novel/bad:name.md', 'x')], remote: [R('Novel/CON.md', 'i', 'y')] });
    expect(p.actions).toEqual([]);
    expect(p.skipped.map((s) => s.path).sort()).toEqual(['Novel/CON.md', 'Novel/bad:name.md']);
  });
  it('skips paths too long for Windows', () => {
    const p = run({ local: [L('Novel/' + ('d'.repeat(100) + '/').repeat(2) + 'x.md', 'x')] });
    expect(p.actions).toEqual([]);
    expect(p.skipped).toHaveLength(1);
  });
});

describe('ordering and determinism', () => {
  it('runs renames first, then content, then deletes', () => {
    const p = run({
      local: [L('Novel/old.md', 'a'), L('Novel/up.md', 'z'), L('Novel/gone.md', 'g')],
      remote: [R('Novel/new.md', 'i1', 'a'), R('Novel/up.md', 'i2', 'u'), R('Novel/down.md', 'i3', 'd')],
      base: [B('Novel/old.md', 'i1', 'a'), B('Novel/up.md', 'i2', 'u'), B('Novel/gone.md', 'i4', 'g')],
    });
    const types = p.actions.map((a) => a.type);
    expect(types[0]).toBe('renameLocal');
    expect(types.indexOf('deleteLocal')).toBeGreaterThan(types.indexOf('upload'));
  });
  it('gives the same plan for the same input', () => {
    const input = { local: [L(A, 'x')], remote: [R(A, 'id1', 'y')], base: [B(A, 'id1', 'a')] };
    expect(run(input)).toEqual(run(input));
  });
});

describe('planRemoteRenames', () => {
  it('leaves compliant, unique names alone', () => {
    expect(planRemoteRenames([R('Novel/a.md', '1', 'x'), R('Novel/b.md', '2', 'x')])).toEqual([]);
  });
  it('renames invalid names to compliant ones', () => {
    expect(planRemoteRenames([R('Novel/Act 1: Fall?.md', '1', 'x'), R('Novel/CON.md', '2', 'x')])).toEqual([
      { id: '1', from: 'Novel/Act 1: Fall?.md', to: 'Novel/Act 1_ Fall_.md' },
      { id: '2', from: 'Novel/CON.md', to: 'Novel/CON_.md' },
    ]);
  });
  it('numbers the later of two names that differ only by case', () => {
    expect(planRemoteRenames([R('Novel/Ch1.md', 'old', 'x', 1), R('Novel/ch1.md', 'new', 'x', 2)])).toEqual([{ id: 'new', from: 'Novel/ch1.md', to: 'Novel/ch1 2.md' }]);
  });
  it('avoids a name that a renamed file would collide with', () => {
    expect(planRemoteRenames([R('Novel/a_.md', '1', 'x'), R('Novel/a?.md', '2', 'x')])).toEqual([{ id: '2', from: 'Novel/a?.md', to: 'Novel/a_ 2.md' }]);
  });
  it('fixes a folder segment for every file inside it', () => {
    const out = planRemoteRenames([R('Book: One/a.md', '1', 'x'), R('Book: One/b.md', '2', 'x')]);
    expect(out.map((r) => r.to)).toEqual(['Book_ One/a.md', 'Book_ One/b.md']);
  });
});
