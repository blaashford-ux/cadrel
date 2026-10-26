import { describe, expect, it } from 'vitest';
import { BUILT_IN_KINDS, IMAGE_EXTENSIONS, builtInKind, folderKindByName, kindGlossary, kindRegistry, suggestKind, type FileKind } from '../src/kinds';
import { AREAS } from '../src/capabilities';

describe('file kinds', () => {
  it('has the built-in kinds, with image among them', () => {
    expect(BUILT_IN_KINDS.map((k) => k.id)).toEqual([
      'manuscript', 'matter', 'outline', 'premise', 'character', 'world', 'research', 'style', 'brief', 'copy', 'image', 'asset', 'export', 'reference', 'other'
    ]);
    expect(new Set(BUILT_IN_KINDS.map((k) => k.id)).size).toBe(BUILT_IN_KINDS.length);
  });

  it('image is a picture: not prose, not counted, not exported by itself, readable by the assistant, under assets', () => {
    expect(builtInKind('image')).toMatchObject({ prose: false, counts: false, exportable: false, ai: 'read', area: 'assets', folder: 'Images' });
    expect(builtInKind('image')!.ext).toEqual(expect.arrayContaining(['.png', '.jpg', '.webp', '.svg']));
  });

  it('only manuscripts count toward goals, and only manuscripts and matter are part of a book build', () => {
    expect(BUILT_IN_KINDS.filter((k) => k.counts).map((k) => k.id)).toEqual(['manuscript']);
    expect(BUILT_IN_KINDS.filter((k) => k.exportable).map((k) => k.id)).toEqual(['manuscript', 'matter']);
  });

  it('prose kinds are Markdown; the rest never claim .md only', () => {
    for (const k of BUILT_IN_KINDS.filter((x) => x.prose)) expect(k.ext).toEqual(expect.arrayContaining(['.md']));
    expect(builtInKind('image')!.ext.every((e) => !e.startsWith('.md'))).toBe(true);
  });

  it('every kind names a permission area the roles know, or none', () => {
    const areas = new Set(AREAS.map((a) => a.id));
    for (const k of BUILT_IN_KINDS) {
      if (k.area === 'none') continue;
      // Each must be a row of the permission matrix.
      expect(areas.has(k.area), `${k.id} -> ${k.area}`).toBe(true);
    }
  });

  it('suggests from the nearest folder that has a kind, else from the extension; never from nothing', () => {
    const folders = { 'Book 1/Manuscript': 'manuscript', 'Book 1/Characters': 'character' };
    expect(suggestKind('Book 1/Manuscript/Draft.md', folders)).toMatchObject({ kind: 'manuscript', confidence: 'folder' });
    expect(suggestKind('Book 1/Characters/Mira.md', folders)).toMatchObject({ kind: 'character', confidence: 'folder' });
    expect(suggestKind('Book 1/Manuscript/Sub/Part.md', folders)).toMatchObject({ kind: 'manuscript' });
    for (const e of IMAGE_EXTENSIONS) expect(suggestKind(`Misc/pic${e}`)).toMatchObject({ kind: 'image', confidence: 'guess' });
    expect(suggestKind('Misc/cover.PNG')).toMatchObject({ kind: 'image' });
    expect(suggestKind('Book 1/Characters/portrait.png', folders)).toMatchObject({ kind: 'character' }); // the folder wins; the person can override one file
    expect(suggestKind('Misc/art.psd').kind).toBe('asset');
    expect(suggestKind('Misc/notes.md')).toMatchObject({ kind: 'other', confidence: 'guess' });
    expect(suggestKind('noext')).toMatchObject({ kind: 'other' });
  });

  it('maps template folder names to kinds', () => {
    expect(folderKindByName('Manuscript')).toBe('manuscript');
    expect(folderKindByName('characters')).toBe('character');
    expect(folderKindByName('Images')).toBe('image');
    expect(folderKindByName('Series Bible')).toBe('world');
    expect(folderKindByName('Whatever')).toBeNull();
  });

  it('a studio can add kinds but cannot replace a built-in one', () => {
    const magic: FileKind = { id: 'magic', name: 'Magic system', description: 'Rules of magic.', prose: true, counts: false, exportable: false, canon: true, area: 'canon', ai: 'read', ext: ['.md'], folder: 'Magic', builtin: false };
    const fake: FileKind = { ...magic, id: 'manuscript', description: 'hijack' };
    const reg = kindRegistry([magic, fake]);
    expect(reg.get('magic')).toBeDefined();
    expect(reg.get('manuscript')!.description).not.toBe('hijack');
    expect(folderKindByName('Magic', reg)).toBe('magic');
    expect(kindGlossary(reg)).toContain('- magic: Rules of magic.');
    expect(kindGlossary(reg)).toContain('- image: A picture');
  });
});
