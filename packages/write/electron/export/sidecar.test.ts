import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeAppDefaults } from '../../src/shared/appDefaults';
import { defaultBookDetails } from '../../src/shared/export/model';
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
    expect(saved).toMatchObject({ marked: true, author: 'Template Author', title: 'my-book' });
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
    expect(onDisk.copyright).toMatchObject({ contentWarning: true, contentWarningText: 'Contains peril.' });
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
