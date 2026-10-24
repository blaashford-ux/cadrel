import { describe, expect, it } from 'vitest';
import { buildBackMatter, buildFrontMatter, safeUrl } from './matter';
import { CONTENT_WARNING_TEXT, defaultBookDetails, FICTION_TEXT, MATURE_TEXT, REPRODUCTION_TEXT } from './model';

const base = () => {
  const d = defaultBookDetails({ title: 'The Book', author: 'Pen Name', year: 2031 });
  d.subtitle = 'A Subtitle';
  return d;
};
const copyright = (d = base()) => buildFrontMatter(d).find((p) => p.id === 'copyright')!.blocks.map((b) => ('text' in b ? b.text : ''));

describe('title page', () => {
  it('has title, subtitle (only if given) and author, verbatim', () => {
    expect(buildFrontMatter(base())[0]).toEqual({
      id: 'title',
      blocks: [{ t: 'title', text: 'The Book' }, { t: 'subtitle', text: 'A Subtitle' }, { t: 'author', text: 'Pen Name' }]
    });
    const d = base();
    d.subtitle = '  ';
    expect(buildFrontMatter(d)[0].blocks.map((b) => b.t)).toEqual(['title', 'author']);
  });
});

describe('copyright page order (from the format-for-kdp skill)', () => {
  it('default: title, ©, rights, fiction disclaimer, reproduction, edition', () => {
    expect(copyright()).toEqual(['The Book', 'Copyright © 2031 by Pen Name', 'All rights reserved.', FICTION_TEXT, REPRODUCTION_TEXT, 'First Edition']);
  });

  it('full: mature notice (bold) then AI line directly below it, then publisher/ISBN/extras, then edition', () => {
    const d = base();
    d.copyright.matureNotice = true;
    d.copyright.contentWarning = true;
    d.copyright.publisher = 'Acme Press';
    d.copyright.isbn = '978-1-23456-789-7';
    d.copyright.extraLines = ['Cover by Z', '  ', 'Edited by Y'];
    d.copyright.edition = 'Second Edition';
    const lines = copyright(d);
    expect(lines).toEqual([
      'The Book', 'Copyright © 2031 by Pen Name', 'All rights reserved.', FICTION_TEXT, REPRODUCTION_TEXT, MATURE_TEXT, CONTENT_WARNING_TEXT,
      'Published by Acme Press', 'ISBN: 978-1-23456-789-7', 'Cover by Z', 'Edited by Y', 'Second Edition'
    ]);
    const blocks = buildFrontMatter(d)[1].blocks;
    expect(blocks.find((b) => b.t === 'para' && b.text === MATURE_TEXT)).toMatchObject({ bold: true });
  });

  it('every opt-out is honoured', () => {
    const d = base();
    d.copyright.fictionDisclaimer = false;
    d.copyright.edition = '';
    expect(copyright(d)).toEqual(['The Book', 'Copyright © 2031 by Pen Name', 'All rights reserved.', REPRODUCTION_TEXT]);
  });

  it('never mentions a brand or site', () => {
    expect(copyright().join(' ')).not.toMatch(/embre|\.net|\.com/i);
  });
});

describe('dedication and epigraph', () => {
  it('appear only when enabled and filled in', () => {
    const d = base();
    d.dedication = { enabled: true, text: '' };
    expect(buildFrontMatter(d).map((p) => p.id)).toEqual(['title', 'copyright']);
    d.dedication = { enabled: true, text: 'For my cat.' };
    d.epigraph = { enabled: true, text: 'Line one.\n\nLine two.', attribution: 'Someone' };
    const pages = buildFrontMatter(d);
    expect(pages.map((p) => p.id)).toEqual(['title', 'copyright', 'dedication', 'epigraph']);
    expect(pages[3].blocks.map((b) => ('text' in b ? b.text : ''))).toEqual(['Line one.', 'Line two.', '— Someone']);
  });
});

describe('back matter', () => {
  it('is empty by default', () => {
    expect(buildBackMatter(base(), [])).toEqual([]);
  });

  it('builds each enabled page with its heading (also used for the contents list)', () => {
    const d = base();
    d.back.links = { enabled: true, heading: '', intro: 'Join us.', items: [{ label: 'Newsletter', url: 'https://example.com/n' }, { label: 'Plain', url: '' }] };
    d.back.alsoBy = { enabled: true, heading: '', items: [{ title: 'Book Two', url: 'https://example.com/2' }, { title: 'Book Three', url: '' }, { title: '', url: '' }] };
    d.back.about = { enabled: true, heading: '', text: 'Bio para one.\n\nBio para two.' };
    d.back.custom = { enabled: true, heading: 'A NOTE', text: 'Thanks.' };
    const w: string[] = [];
    const pages = buildBackMatter(d, w);
    expect(pages.map((p) => [p.id, p.heading])).toEqual([
      ['links', 'CONTINUE THE STORY'], ['alsoBy', 'ALSO BY PEN NAME'], ['about', 'ABOUT THE AUTHOR'], ['custom', 'A NOTE']
    ]);
    expect(pages[0].blocks).toEqual([
      { t: 'heading', text: 'CONTINUE THE STORY' }, { t: 'para', text: 'Join us.' },
      { t: 'link', label: 'Newsletter', url: 'https://example.com/n' }, { t: 'line', text: 'Plain' }
    ]);
    expect(pages[1].blocks.filter((b) => b.t === 'link' || b.t === 'line')).toHaveLength(2);
    expect(w).toEqual([]);
  });

  it('only emits web/mail links the user typed, and warns about anything else', () => {
    const d = base();
    d.back.links = { enabled: true, heading: '', intro: '', items: [{ label: 'Bad', url: 'javascript:alert(1)' }, { label: 'Odd', url: 'ftp://x' }, { label: 'Good', url: ' mailto:me@x.com ' }] };
    const w: string[] = [];
    const [page] = buildBackMatter(d, w);
    expect(page.blocks.filter((b) => b.t === 'link')).toEqual([{ t: 'link', label: 'Good', url: 'mailto:me@x.com' }]);
    expect(w).toHaveLength(2);
    expect(JSON.stringify(page)).not.toMatch(/javascript|ftp/);
  });

  it('skips pages that are enabled but empty', () => {
    const d = base();
    d.back.about = { enabled: true, heading: '', text: '   ' };
    d.back.alsoBy = { enabled: true, heading: '', items: [] };
    expect(buildBackMatter(d, [])).toEqual([]);
  });
});

describe('safeUrl', () => {
  it.each([['https://a.b/c?d=1', 'https://a.b/c?d=1'], ['HTTP://A.B', 'HTTP://A.B'], ['  mailto:a@b.c ', 'mailto:a@b.c'], ['javascript:x', ''], ['//a.b', ''], ['https://a b', ''], ['', '']])(
    '%j → %j',
    (i, o) => expect(safeUrl(i)).toBe(o)
  );
});
