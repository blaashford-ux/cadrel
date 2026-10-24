import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeAppDefaults } from '../../src/shared/appDefaults';
import { assembleBook } from '../../src/shared/export/assemble';
import { defaultBookDetails } from '../../src/shared/export/model';
import { effectiveDefaults, sanitizeProjectMeta } from '../../src/shared/projects';
import { existingSidecar, loadDetails, renameSidecar, saveDetails, setMarked } from './sidecar';

let dir: string;
let md: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mdedit-'));
  md = path.join(dir, 'my-book.md');
  await writeFile(md, '# One\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const sidecar = () => path.join(dir, 'my-book.export.json');

describe('loadDetails / saveDetails', () => {
  it('returns defaults (title = file name verbatim, author blank) when there is no sidecar', async () => {
    const l = await loadDetails(md);
    expect(l).toMatchObject({ exists: false, damaged: false });
    expect(l.details.title).toBe('my-book');
    expect(l.details.author).toBe('');
  });

  it('round-trips and writes pretty JSON ending in a newline', async () => {
    const d = defaultBookDetails({ title: 'T', author: 'A' });
    d.subtitle = 'S';
    await saveDetails(md, d);
    const text = await readFile(sidecar(), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "title": "T"');
    expect((await loadDetails(md)).details).toEqual(d);
    expect((await loadDetails(md)).exists).toBe(true);
  });

  it('a corrupt sidecar loads as defaults, flagged, and is backed up (not lost) when saved over', async () => {
    await writeFile(sidecar(), '{not json');
    const l = await loadDetails(md);
    expect(l).toMatchObject({ exists: true, damaged: true });
    await saveDetails(md, defaultBookDetails({ title: 'New', author: 'A' }));
    expect(await readFile(sidecar() + '.bak', 'utf8')).toBe('{not json');
    expect((await loadDetails(md)).details.title).toBe('New');
  });

  it('cleans up hand-edited junk on save', async () => {
    await saveDetails(md, { title: 'T', author: 'A', export: { pdf: { fontSize: 999 } } } as never);
    expect((await loadDetails(md)).details.export.pdf.fontSize).toBe(16);
  });
});

describe('setMarked', () => {
  it('marking creates the sidecar; unmarking keeps the details', async () => {
    await setMarked(md, true);
    expect((await loadDetails(md)).details.marked).toBe(true);
    const d = (await loadDetails(md)).details;
    await saveDetails(md, { ...d, subtitle: 'kept' });
    await setMarked(md, false);
    const after = (await loadDetails(md)).details;
    expect(after.marked).toBe(false);
    expect(after.subtitle).toBe('kept');
  });

  it('marking over a corrupt sidecar reports the backup instead of hiding it', async () => {
    await writeFile(sidecar(), '{broken');
    expect(await setMarked(md, true)).toEqual({ backedUp: true });
    expect(await readFile(sidecar() + '.bak', 'utf8')).toBe('{broken');
    expect((await loadDetails(md)).details.marked).toBe(true);
    expect(await setMarked(md, true)).toEqual({ backedUp: false });
  });

  it('unmarking a file that was never marked creates nothing', async () => {
    await setMarked(md, false);
    expect(await readdir(dir)).toEqual(['my-book.md']);
  });
});

describe('renameSidecar / existingSidecar', () => {
  it('moves the sidecar with its manuscript', async () => {
    await setMarked(md, true);
    expect(await existingSidecar(md)).toBe(sidecar());
    await renameSidecar(md, path.join(dir, 'renamed.md'));
    expect((await readdir(dir)).sort()).toEqual(['my-book.md', 'renamed.export.json']);
    expect(await existingSidecar(md)).toBeNull();
  });

  it('is a no-op without a sidecar, and never overwrites an existing one', async () => {
    await renameSidecar(md, path.join(dir, 'x.md'));
    expect(await readdir(dir)).toEqual(['my-book.md']);
    await setMarked(md, true);
    await writeFile(path.join(dir, 'x.export.json'), 'precious');
    await renameSidecar(md, path.join(dir, 'x.md'));
    expect(await readFile(path.join(dir, 'x.export.json'), 'utf8')).toBe('precious');
    expect(await existingSidecar(md)).toBe(sidecar());
  });
});

describe('new books start from the Settings template', () => {
  it('a file with no sidecar is seeded from the defaults (and the template is not saved until the book is)', async () => {
    const defaults = sanitizeAppDefaults({ book: { author: 'Template Author', about: undefined, back: { about: { enabled: true, text: 'Bio' } } } });
    const l = await loadDetails(md, defaults);
    expect(l.exists).toBe(false);
    expect(l.details).toMatchObject({ title: 'my-book', author: 'Template Author' });
    expect(l.details.back.about).toMatchObject({ enabled: true, text: 'Bio' });
    expect(await readdir(dir)).toEqual(['my-book.md']);
  });

  it('marking a file for the first time saves the template-based details', async () => {
    const defaults = sanitizeAppDefaults({ book: { author: 'Template Author' } });
    await setMarked(md, true, defaults);
    const saved = JSON.parse(await readFile(sidecar(), 'utf8'));
    // the author comes from the template each time it is read; the book stores only its identity and what it sets itself
    expect(saved).toMatchObject({ marked: true, title: 'my-book' });
    expect(Object.keys(saved.overrides)).toEqual(['copyright.year']);
    expect((await loadDetails(md, defaults)).details.author).toBe('Template Author');
  });

  it('an existing sidecar is never changed by the template', async () => {
    await saveDetails(md, { ...defaultBookDetails({ title: 'Mine', author: 'Old Author' }) });
    const l = await loadDetails(md, sanitizeAppDefaults({ book: { author: 'Template Author' } }));
    expect(l.details.author).toBe('Old Author');
  });
});

describe('old export files are tidied on first read', () => {
  it('renames the content-warning keys and drops unknown ones, keeping the author’s wording', async () => {
    const old = defaultBookDetails({ title: 'Mine', author: 'Me' }) as unknown as Record<string, any>;
    old.copyright = { ...old.copyright, aiDisclosure: true, aiText: 'Contains peril.', extra: 'junk' };
    delete old.copyright.contentWarning;
    delete old.copyright.contentWarningText;
    await writeFile(sidecar(), JSON.stringify(old));
    const l = await loadDetails(md);
    expect(l.details.copyright).toMatchObject({ contentWarning: true, contentWarningText: 'Contains peril.' });
    const onDisk = JSON.parse(await readFile(sidecar(), 'utf8'));
    expect(onDisk.overrides).toMatchObject({ 'copyright.contentWarning': true, 'copyright.contentWarningText': 'Contains peril.' });
    expect(JSON.stringify(onDisk)).not.toMatch(/aiDisclosure|aiText|junk/);
    expect(onDisk.title).toBe('Mine');
  });

  it('a file that is already clean is not rewritten', async () => {
    await saveDetails(md, defaultBookDetails({ title: 'Clean', author: 'Me' }));
    const before = await readFile(sidecar(), 'utf8');
    const { statSync } = await import('node:fs');
    const m1 = statSync(sidecar()).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    await loadDetails(md);
    expect(statSync(sidecar()).mtimeMs).toBe(m1);
    expect(await readFile(sidecar(), 'utf8')).toBe(before);
  });
});

describe('layered settings', () => {
  const app = (book: Record<string, unknown>) => sanitizeAppDefaults({ book });
  const at = (...paths: string[]) => paths;

  it('a book follows its defaults until it sets a field itself, and a changed default reaches it', async () => {
    const before = app({ author: 'Old Author', back: { about: { enabled: true, text: 'Old bio' } } });
    await setMarked(md, true, before);
    const after = app({ author: 'New Author', back: { about: { enabled: true, text: 'New bio' } } });
    const l = await loadDetails(md, after);
    expect(l.details.author).toBe('New Author');
    expect(l.details.back.about.text).toBe('New bio');
    expect(l.overrides).toEqual(['copyright.year']);
  });

  it('a field the book sets stays its own when the defaults change, and Reset hands it back', async () => {
    const defaults = app({ author: 'App Author' });
    const l = await loadDetails(md, defaults);
    await saveDetails(md, { ...l.details, author: 'Pen Name' }, [...l.overrides, 'author'], defaults);
    const changed = app({ author: 'Other App Author' });
    const mine = await loadDetails(md, changed);
    expect(mine.details.author).toBe('Pen Name');
    expect(mine.overrides).toContain('author');
    await saveDetails(md, mine.details, mine.overrides.filter((p) => p !== 'author'), changed);
    expect((await loadDetails(md, changed)).details.author).toBe('Other App Author');
  });

  it('says whether each inherited field comes from the project or the app', async () => {
    const l = await loadDetails(md, app({}), at('copyright.publisher'));
    expect(l.origins['copyright.publisher']).toBe('project');
    expect(l.origins['copyright.isbn']).toBe('app');
    expect(l.inherited.title).toBe('');
  });

  it('the copyright year is pinned when the book is set up, so it does not move with the calendar', async () => {
    await setMarked(md, true, undefined);
    const stored = JSON.parse(await readFile(sidecar(), 'utf8'));
    expect(stored.overrides['copyright.year']).toBe(String(new Date().getFullYear()));
    const later = await loadDetails(md, undefined, [], new Date('2041-03-01T00:00:00Z'));
    expect(later.details.copyright.year).toBe(String(new Date().getFullYear()));
  });

  it('book-only fields (excluded chapters, cover image) are always stored with the book', async () => {
    const l = await loadDetails(md);
    const d = structuredClone(l.details);
    d.export.excludedChapters = ['Chapter 2'];
    await saveDetails(md, d, []);
    expect(JSON.parse(await readFile(sidecar(), 'utf8')).overrides['export.excludedChapters']).toEqual(['Chapter 2']);
  });

  it('a file saved before layering keeps what differs from its defaults, inherits the rest, and is backed up once', async () => {
    const old = defaultBookDetails({ title: 'Mine', author: 'Old Author', year: 2030 });
    old.back.about = { enabled: true, heading: 'ABOUT THE AUTHOR', text: 'Stale bio' };
    old.export.pdf.fontSize = 12;
    await writeFile(sidecar(), JSON.stringify(old));
    const defaults = app({ author: 'Old Author', back: { about: { enabled: true, text: 'Stale bio' } } });
    const l = await loadDetails(md, defaults);
    expect(l.details).toMatchObject({ title: 'Mine', author: 'Old Author' });
    expect(l.details.export.pdf.fontSize).toBe(12);
    expect(l.overrides).toContain('export.pdf.fontSize');
    expect(l.overrides).toContain('copyright.year');
    expect(l.overrides).not.toContain('author');
    expect(l.overrides).not.toContain('back.about.text');
    expect(JSON.parse(await readFile(sidecar() + '.v1.bak', 'utf8')).title).toBe('Mine');
    // converting again changes nothing
    expect((await loadDetails(md, defaults)).overrides.sort()).toEqual(l.overrides.sort());
    // and the converted book now follows a changed default
    const changed = app({ author: 'Old Author', back: { about: { enabled: true, text: 'Fresh bio' } } });
    expect((await loadDetails(md, changed)).details.back.about.text).toBe('Fresh bio');
  });
});

describe('the back matter set on a project reaches its books (the original bug)', () => {
  it('a book set up earlier exports with the project’s back matter, and its own choice still wins', async () => {
    const appDefs = sanitizeAppDefaults({});
    const project = (about: string) =>
      effectiveDefaults(appDefs, sanitizeProjectMeta({ overrides: { book: { 'back.about.enabled': true, 'back.about.text': about } } }, 'P', '2026-10-05'));
    await setMarked(md, true, project('First bio'));
    const edited = project('Second bio');
    const l = await loadDetails(md, edited, ['back.about.enabled', 'back.about.text']);
    expect(l.details.back.about).toMatchObject({ enabled: true, text: 'Second bio' });
    expect(l.origins['back.about.text']).toBe('project');
    const built = assembleBook('# One\n\nText.\n', { ...l.details, author: 'A' });
    expect(built.build!.back.map((p) => p.id)).toEqual(['about']);

    const d = structuredClone(l.details);
    d.back.about.text = 'Book-only bio';
    await saveDetails(md, d, [...l.overrides, 'back.about.text'], edited);
    expect((await loadDetails(md, project('Third bio'))).details.back.about.text).toBe('Book-only bio');
  });
});
