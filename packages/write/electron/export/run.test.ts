import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ExportProgress } from '../../src/shared/api';
import { defaultBookDetails, type BookDetails } from '../../src/shared/export/model';
import { planExport, runExport, type ExportDeps } from './run';

const MD = '/proj/Novels/book.md';
const SRC = '# Chapter 1: One\n\n"Hi," she said.\n\n# Chapter 2: Two\n\nBye.\n';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function setup(edit: (d: BookDetails) => void = () => undefined, source = SRC) {
  const details = defaultBookDetails({ title: 'The Lost King', author: 'A. Writer', year: 2031 });
  details.export.outputs = { epub: true, pdf: true, docx: true };
  edit(details);
  const files = new Map<string, Uint8Array | string>([[MD, source]]);
  const dirs: string[] = [];
  const pdfCalls: string[] = [];
  const deps: ExportDeps = {
    readText: async (p) => {
      const v = files.get(p);
      if (typeof v !== 'string') throw new Error('ENOENT ' + p);
      return v;
    },
    readBytes: async (p) => {
      const v = files.get(p);
      if (!(v instanceof Uint8Array)) throw new Error('ENOENT ' + p);
      return v;
    },
    writeBytes: async (p, b) => void files.set(p, b),
    mkdirp: async (d) => void dirs.push(d),
    exists: async (p) => files.has(p),
    loadDetails: async () => details,
    buildPdf: async (book, say) => {
      say('Laying out…');
      pdfCalls.push(book.meta.title);
      return { bytes: new Uint8Array([37, 80, 68, 70]), pages: 120, gutter: 0.375, warnings: [] };
    },
    now: () => new Date('2031-05-06T07:08:09Z'),
    uuid: () => 'abc'
  };
  return { deps, files, dirs, details, pdfCalls };
}

describe('runExport', () => {
  it('builds all three outputs into <manuscript folder>/Exports with the skill’s file names', async () => {
    const { deps, files, dirs } = setup();
    const events: ExportProgress[] = [];
    const r = await runExport(MD, deps, (e) => events.push(e));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(dirs).toEqual(['/proj/Novels/Exports']);
    expect(r.outputs.map((o) => [o.kind, o.path])).toEqual([
      ['epub', '/proj/Novels/Exports/The Lost King - Ebook.epub'],
      ['pdf', '/proj/Novels/Exports/The Lost King - Print Interior.pdf'],
      ['docx', '/proj/Novels/Exports/The Lost King - Ebook.docx']
    ]);
    for (const o of r.outputs) {
      expect(files.has(o.path)).toBe(true);
      expect(o.bytes).toBe((files.get(o.path) as Uint8Array).length);
    }
    expect(r.outputs[1]).toMatchObject({ pages: 120, gutter: 0.375 });
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['prepare', 'epub', 'pdf', 'docx']));
    expect(events.some((e) => e.message === 'Laying out…')).toBe(true);
  });

  it('the EPUB written is valid and reflects the saved details; the manuscript is read as saved', async () => {
    const { deps, files } = setup((d) => (d.subtitle = 'A Tale'));
    await runExport(MD, deps);
    const epub = unzipSync(files.get('/proj/Novels/Exports/The Lost King - Ebook.epub') as Uint8Array);
    expect(strFromU8(epub['OEBPS/content.opf'])).toContain('A Tale');
    expect(strFromU8(epub['OEBPS/text/chapter1.xhtml'])).toContain('“Hi,”');
  });

  it('only builds the outputs that are ticked', async () => {
    const { deps, files, pdfCalls } = setup((d) => (d.export.outputs = { epub: false, pdf: false, docx: true }));
    const r = await runExport(MD, deps);
    expect(r.outputs.map((o) => o.kind)).toEqual(['docx']);
    expect(pdfCalls).toEqual([]);
    expect([...files.keys()].filter((k) => k.includes('Exports'))).toHaveLength(1);
  });

  it('fails fast, writing nothing, when nothing is ticked, the title/author is missing, or there are no chapters', async () => {
    const none = setup((d) => (d.export.outputs = { epub: false, pdf: false, docx: false }));
    expect((await runExport(MD, none.deps)).errors[0]).toMatch(/at least one output/);
    const notitle = setup((d) => (d.title = ' '));
    const r = await runExport(MD, notitle.deps);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/needs a title/);
    expect(notitle.dirs).toEqual([]);
    const nochap = setup(() => undefined, 'no headings at all');
    expect((await runExport(MD, nochap.deps)).errors[0]).toMatch(/no chapters/);
    expect([...nochap.files.keys()]).toEqual([MD]);
  });

  it('one failing output does not stop the others, and is reported by name', async () => {
    const { deps, files } = setup();
    deps.buildPdf = async () => {
      throw new Error('layout window crashed');
    };
    const r = await runExport(MD, deps);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['PDF: layout window crashed']);
    expect(r.outputs.map((o) => o.kind)).toEqual(['epub', 'docx']);
    expect(files.has('/proj/Novels/Exports/The Lost King - Ebook.epub')).toBe(true);
  });

  it('reports a failure to create or write the output folder instead of throwing', async () => {
    const { deps } = setup();
    deps.mkdirp = async () => {
      throw new Error('EACCES');
    };
    const r = await runExport(MD, deps);
    expect(r.errors[0]).toMatch(/Could not create the output folder .*EACCES/);
  });

  it('honours an absolute output folder', async () => {
    const { deps, dirs } = setup((d) => (d.export.outputDir = 'D:\\Books\\Out'));
    const r = await runExport(MD, deps);
    expect(dirs).toEqual(['D:\\Books\\Out']);
    expect(r.outputs[0].path).toBe('D:\\Books\\Out\\The Lost King - Ebook.epub');
  });

  it('sanitises the title for the file name but not for the book itself', async () => {
    const { deps, files } = setup((d) => (d.title = 'What? A "Story": Part 1'));
    const r = await runExport(MD, deps);
    expect(r.outputs[0].path).toBe('/proj/Novels/Exports/What A Story Part 1 - Ebook.epub');
    const epub = unzipSync(files.get(r.outputs[0].path) as Uint8Array);
    expect(strFromU8(epub['OEBPS/content.opf'])).toContain('<dc:title id="dc-title">What? A &quot;Story&quot;: Part 1</dc:title>');
  });

  it('embeds a valid cover; warns (and skips it) for a missing or non-image cover', async () => {
    const good = setup((d) => (d.export.epub.coverImage = '/covers/c.png'));
    good.files.set('/covers/c.png', PNG);
    const r = await runExport(MD, good.deps);
    expect(r.outputs[0].warnings).toEqual([]);
    expect(Object.keys(unzipSync(good.files.get(r.outputs[0].path) as Uint8Array))).toContain('OEBPS/images/cover.png');

    const bad = setup((d) => (d.export.epub.coverImage = '/covers/c.gif'));
    bad.files.set('/covers/c.gif', Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0]));
    expect((await runExport(MD, bad.deps)).outputs[0].warnings[0]).toMatch(/isn’t a JPEG or PNG/);

    const missing = setup((d) => (d.export.epub.coverImage = '/nope.jpg'));
    const m = await runExport(MD, missing.deps);
    expect(m.outputs[0].warnings[0]).toMatch(/couldn’t be read/);
    expect(m.ok).toBe(true); // a bad cover is a warning, not a failure
  });

  it('carries manuscript warnings through (text before the first heading, excluded chapters, bad links)', async () => {
    const { deps } = setup((d) => {
      d.export.excludedChapters = ['Chapter 2: Two'];
      d.back.links = { enabled: true, heading: '', intro: '', items: [{ label: 'x', url: 'ftp://nope' }] };
    }, 'Stray intro.\n\n' + SRC);
    const r = await runExport(MD, deps);
    expect(r.warnings.some((w) => /before the first Heading 1/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /1 chapter was excluded/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /isn’t a web or email address/.test(w))).toBe(true);
  });

  it('stops between outputs when cancelled', async () => {
    const { deps, files } = setup();
    const ctl = new AbortController();
    const orig = deps.writeBytes;
    deps.writeBytes = async (p, b) => {
      await orig(p, b);
      ctl.abort(); // cancel right after the first file is written
    };
    const r = await runExport(MD, deps, () => undefined, ctl.signal);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['The export was cancelled.']);
    expect(r.outputs.map((o) => o.kind)).toEqual(['epub']);
    expect([...files.keys()].filter((k) => k.includes('Exports'))).toHaveLength(1);
  });

  it('does not touch the manuscript', async () => {
    const { deps, files } = setup();
    await runExport(MD, deps);
    expect(files.get(MD)).toBe(SRC);
  });
});

describe('planExport', () => {
  it('lists the ticked outputs with their full paths and whether each would replace a file', async () => {
    const { deps, files } = setup((d) => (d.export.outputs = { epub: true, pdf: false, docx: true }));
    files.set('/proj/Novels/Exports/The Lost King - Ebook.docx', new Uint8Array(1));
    const plan = await planExport(MD, deps);
    expect(plan.dir).toBe('/proj/Novels/Exports');
    expect(plan.outputs).toEqual([
      { kind: 'epub', path: '/proj/Novels/Exports/The Lost King - Ebook.epub', exists: false },
      { kind: 'docx', path: '/proj/Novels/Exports/The Lost King - Ebook.docx', exists: true }
    ]);
  });
});

describe('runExport with a chapter heading level setting', () => {
  const SRC2 = '# Book Title\n\n## Part One\n\nHello.\n\n## Part Two\n\nBye.\n';

  it('splits chapters at the configured level', async () => {
    const { deps, pdfCalls } = setup((d) => void (d.export.outputs = { epub: false, pdf: true, docx: false }), SRC2);
    let titles: string[] = [];
    deps.buildPdf = async (book) => {
      titles = book.chapters.map((c) => c.title);
      pdfCalls.push('x');
      return { bytes: new Uint8Array([37]), pages: 30, gutter: 0.375, warnings: [] };
    };
    deps.chapterLevel = () => 2;
    const r = await runExport(MD, deps);
    expect(r.errors).toEqual([]);
    expect(titles).toEqual(['Part One', 'Part Two']);
  });

  it('defaults to level 1 when the dependency is absent', async () => {
    const { deps } = setup((d) => void (d.export.outputs = { epub: true, pdf: false, docx: false }), SRC2);
    const r = await runExport(MD, deps);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).not.toMatch(/Heading 2/);
  });
});

describe('runExport fonts', () => {
  const only = (kind: 'epub' | 'pdf') => (d: BookDetails) => void (d.export.outputs = { epub: kind === 'epub', pdf: kind === 'pdf', docx: false });
  const files4 = () => ({ 'Regular.ttf': new Uint8Array([1]), 'Italic.ttf': new Uint8Array([2]), 'Bold.ttf': new Uint8Array([3]), 'BoldItalic.ttf': new Uint8Array([4]) });

  it('embeds a bundled family in the EPUB and says nothing about it', async () => {
    const { deps, files } = setup((d) => {
      only('epub')(d);
      d.export.epub.font = 'Libre Baskerville';
    });
    let asked = '';
    deps.loadBundledFont = async (f) => ((asked = f), files4());
    const r = await runExport(MD, deps);
    expect(r.errors).toEqual([]);
    expect(asked).toBe('Libre Baskerville');
    expect(r.warnings.join(' ')).not.toMatch(/font/i);
    const zip = unzipSync(files.get(r.outputs[0].path) as Uint8Array);
    expect(Object.keys(zip).filter((n) => n.startsWith('OEBPS/fonts/'))).toHaveLength(4);
  });

  it('a system font in the EPUB is named but not embedded, with a warning', async () => {
    const { deps, files } = setup((d) => {
      only('epub')(d);
      d.export.epub.font = 'Georgia';
    });
    deps.loadBundledFont = async () => files4();
    const r = await runExport(MD, deps);
    expect(r.warnings.join(' ')).toMatch(/“Georgia” is installed on your computer but isn’t embedded in the EPUB/);
    expect(Object.keys(unzipSync(files.get(r.outputs[0].path) as Uint8Array)).some((n) => n.startsWith('OEBPS/fonts/'))).toBe(false);
  });

  it('a PDF font that is not installed falls back to EB Garamond with a warning', async () => {
    const { deps } = setup((d) => {
      only('pdf')(d);
      d.export.pdf.font = 'Papyrus';
    });
    deps.installedFonts = async () => ['Georgia', 'Times New Roman'];
    let used = '';
    deps.buildPdf = async (book) => ((used = book.settings.pdf.font), { bytes: new Uint8Array([37]), pages: 30, gutter: 0.375, warnings: [] });
    const r = await runExport(MD, deps);
    expect(used).toBe('EB Garamond');
    expect(r.warnings.join(' ')).toMatch(/“Papyrus” isn’t installed on this computer/);
  });

  it('an installed PDF font is used as chosen (case-insensitively); an unknown font list never blocks', async () => {
    for (const list of [['georgia'], []]) {
      const { deps } = setup((d) => {
        only('pdf')(d);
        d.export.pdf.font = 'Georgia';
      });
      deps.installedFonts = async () => list;
      let used = '';
      deps.buildPdf = async (book) => ((used = book.settings.pdf.font), { bytes: new Uint8Array([37]), pages: 30, gutter: 0.375, warnings: [] });
      const r = await runExport(MD, deps);
      expect(used).toBe('Georgia');
      expect(r.warnings.join(' ')).not.toMatch(/isn’t installed/);
    }
  });

  it('a bundled PDF font never needs the installed list', async () => {
    const { deps } = setup((d) => {
      only('pdf')(d);
      d.export.pdf.font = 'Crimson Pro';
    });
    deps.installedFonts = async () => ['Georgia'];
    let used = '';
    deps.buildPdf = async (book) => ((used = book.settings.pdf.font), { bytes: new Uint8Array([37]), pages: 30, gutter: 0.375, warnings: [] });
    await runExport(MD, deps);
    expect(used).toBe('Crimson Pro');
  });
});
