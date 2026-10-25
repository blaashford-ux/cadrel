import { describe, expect, it } from 'vitest';
import { mergeManuscript, mergeText, sameChapters } from './merge';

describe('mergeText', () => {
  const base = 'one\ntwo\nthree\nfour\n';
  it('takes a change only one side made', () => {
    expect(mergeText(base, base, 'one\nTWO\nthree\nfour\n').text).toBe('one\nTWO\nthree\nfour\n');
    expect(mergeText(base, 'one\ntwo\nthree\nFOUR\n', base).text).toBe('one\ntwo\nthree\nFOUR\n');
  });
  it('combines changes in different places', () => {
    const m = mergeText(base, 'ONE\ntwo\nthree\nfour\n', 'one\ntwo\nthree\nFOUR\n');
    expect(m).toEqual({ text: 'ONE\ntwo\nthree\nFOUR\n', conflicts: 0 });
  });
  it('combines an insertion and an edit next to each other', () => {
    const m = mergeText(base, 'one\ntwo\nnew\nthree\nfour\n', 'one\nTWO\nthree\nfour\n');
    expect(m.conflicts).toBe(0);
    expect(m.text).toBe('one\nTWO\nnew\nthree\nfour\n');
  });
  it('accepts the same change made on both sides once', () => {
    expect(mergeText(base, 'one\nX\nthree\nfour\n', 'one\nX\nthree\nfour\n')).toEqual({ text: 'one\nX\nthree\nfour\n', conflicts: 0 });
  });
  it('keeps both versions between markers when both changed the same line', () => {
    const m = mergeText(base, 'one\nmine\nthree\nfour\n', 'one\ntheirs\nthree\nfour\n', { local: 'Yours', remote: 'Sam' });
    expect(m.conflicts).toBe(1);
    expect(m.text).toBe('one\n<<<<<<< Yours\nmine\n=======\ntheirs\n>>>>>>> Sam\nthree\nfour\n');
  });
  it('handles a last line without a newline', () => {
    const m = mergeText('a\nb', 'a\nB', 'A\nb');
    expect(m).toEqual({ text: 'A\nB', conflicts: 0 });
  });
});

describe('mergeManuscript', () => {
  const base = 'Intro\n\n# One\n\nAlpha\n\n# Two\n\nBeta\n\n# Three\n\nGamma\n';
  const merge = (local: string, remote: string, scope: Set<string> | null = null, b: string | null = base) => mergeManuscript({ base: b, local, remote, level: 1, scope });

  it('takes chapters each side edited without touching the rest', () => {
    const local = base.replace('Alpha', 'Alpha, edited here');
    const remote = base.replace('Gamma', 'Gamma, edited there');
    const m = merge(local, remote);
    expect(m.local).toBe(base.replace('Alpha', 'Alpha, edited here').replace('Gamma', 'Gamma, edited there'));
    expect(m.shared).toBe(m.local);
    expect(m.conflicts).toBe(0);
  });

  it('merges edits to different paragraphs of one chapter', () => {
    const b = '# One\n\nA\n\nB\n\nC\n';
    const m = merge('# One\n\nA1\n\nB\n\nC\n', '# One\n\nA\n\nB\n\nC1\n', null, b);
    expect(m.local).toBe('# One\n\nA1\n\nB\n\nC1\n');
  });

  it('brings in a chapter the other side added, after the one before it', () => {
    const remote = base.replace('# Three', '# Two and a half\n\nNew\n\n# Three');
    const m = merge(base, remote);
    expect(m.local).toBe(remote);
  });

  it('keeps a chapter added here and drops one the other side deleted unchanged', () => {
    const local = base + '\n# Four\n\nDelta\n';
    const remote = base.replace('# Two\n\nBeta\n\n', '');
    const m = merge(local, remote);
    expect(m.local).not.toContain('# Two');
    expect(m.local).toContain('# Four');
  });

  it('keeps a chapter that was deleted on one side and edited on the other', () => {
    const local = base.replace('Beta', 'Beta, edited');
    const remote = base.replace('# Two\n\nBeta\n\n', '');
    expect(merge(local, remote).local).toContain('Beta, edited');
  });

  it('reports a conflict inside a chapter and keeps both', () => {
    const m = merge(base.replace('Alpha', 'Mine'), base.replace('Alpha', 'Theirs'));
    expect(m.conflicts).toBe(1);
    expect(m.local).toContain('Mine');
    expect(m.local).toContain('Theirs');
  });

  it('with a scope leaves the other chapters of the local file alone and shares only the scoped ones', () => {
    const remote = '# Two\n\nBeta, edited there\n';
    const m = merge(base, remote, new Set(['Two']), '# Two\n\nBeta\n');
    expect(m.local).toBe(base.replace('Beta', 'Beta, edited there'));
    expect(sameChapters(m.shared, '# Two\n\nBeta, edited there\n', 1)).toBe(true);
  });

  it('with a scope takes in chapters the collaborator added', () => {
    const m = merge(base, '# Two\n\nBeta\n\n# Extra\n\nMore\n', new Set(['Two']), '# Two\n\nBeta\n');
    expect(m.local).toContain('# Extra\n\nMore');
    expect(m.local.indexOf('# Extra')).toBeGreaterThan(m.local.indexOf('# Two'));
    expect(m.local.indexOf('# Extra')).toBeLessThan(m.local.indexOf('# Three'));
  });

  it('without a base marks chapters that differ as conflicts rather than losing either', () => {
    const m = merge(base.replace('Beta', 'B1'), base.replace('Beta', 'B2'), null, null);
    expect(m.conflicts).toBeGreaterThan(0);
    expect(m.local).toContain('B1');
    expect(m.local).toContain('B2');
  });

  it('sameChapters ignores chapter order and trailing blank lines', () => {
    expect(sameChapters('# A\n\nx\n\n# B\n\ny\n', '# B\n\ny\n# A\n\nx\n', 1)).toBe(true);
    expect(sameChapters('# A\n\nx\n', '# A\n\nz\n', 1)).toBe(false);
  });
});
