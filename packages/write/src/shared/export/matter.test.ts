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

  it('keeps typed line breaks inside a back-matter paragraph', () => {
    const d = base();
    d.back.about = { enabled: true, heading: '', text: 'Line one\nLine two\n\nSecond para' };
    const blocks = buildBackMatter(d, [])[0].blocks;
    expect(blocks.slice(1)).toEqual([{ t: 'para', text: 'Line one\nLine two' }, { t: 'para', text: 'Second para' }]);
  });

  it('builds each enabled page with its heading (also used for the contents list)', () => {
    const d = base();
    d.back.links = { enabled: true, heading: '', intro: 'Join us.', items: [{ label: 'Newsletter', url: 'https://example.com/n' }, { label: 'Plain', url: '' }] };
    d.back.alsoBy = { enabled: true, heading: '', items: [{ title: 'Book Two', url: 'https://example.com/2', blurb: 'A sequel.\n\nMore peril.' }, { title: 'Book Three', url: '', blurb: '' }, { title: '', url: '', blurb: '' }] };
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
    expect(pages[1].blocks.filter((b) => b.t === 'para').map((b) => (b as { text: string }).text)).toEqual(['A sequel.', 'More peril.']);
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

describe('the Patreon page, from the author’s profile', () => {
  const on = () => {
    const d = base();
    d.back.patreon.enabled = true;
    return d;
  };
  const profile = { patreonUrl: 'https://www.patreon.com/penname', patreonCta: 'Get chapters early.\n\nJoin us.' };

  it('is off unless switched on, and then says the profile’s words with its link', () => {
    expect(buildBackMatter(base(), [], profile).map((p) => p.id)).not.toContain('patreon');
    const w: string[] = [];
    const page = buildBackMatter(on(), w, profile).find((p) => p.id === 'patreon')!;
    expect(page.heading).toBe('SUPPORT ME ON PATREON');
    expect(page.blocks).toEqual([
      { t: 'heading', text: 'SUPPORT ME ON PATREON' },
      { t: 'para', text: 'Get chapters early.' },
      { t: 'para', text: 'Join us.' },
      { t: 'link', label: 'Patreon', url: 'https://www.patreon.com/penname' }
    ]);
    expect(w).toEqual([]);
  });

  it('uses the book’s own heading when it has one', () => {
    const d = on();
    d.back.patreon.heading = 'BECOME A PATRON';
    expect(buildBackMatter(d, [], profile).find((p) => p.id === 'patreon')!.heading).toBe('BECOME A PATRON');
  });

  it('leaves the page out and says why when the profile has no usable link', () => {
    const none: string[] = [];
    expect(buildBackMatter(on(), none, { patreonUrl: '', patreonCta: 'x' }).some((p) => p.id === 'patreon')).toBe(false);
    expect(none[0]).toMatch(/no Patreon link/);
    const bad: string[] = [];
    expect(buildBackMatter(on(), bad, { patreonUrl: 'javascript:alert(1)', patreonCta: '' }).some((p) => p.id === 'patreon')).toBe(false);
    expect(bad[0]).toMatch(/Patreon.*isn’t a web or email address/);
    expect(buildBackMatter(on(), [], null).some((p) => p.id === 'patreon')).toBe(false);
  });

  it('comes before About the author and is listed in the contents', () => {
    const d = on();
    d.back.about = { enabled: true, heading: 'ABOUT THE AUTHOR', text: 'Hi.' };
    expect(buildBackMatter(d, [], profile).map((p) => p.id)).toEqual(['patreon', 'about']);
  });
});

describe('the Community links page', () => {
  const communities = [
    { id: 'a', name: 'Reader Discord', url: 'https://discord.gg/readers' },
    { id: 'b', name: 'Facebook Group', url: 'https://www.facebook.com/groups/readers' },
    { id: 'c', name: 'Bad One', url: 'javascript:alert(1)' }
  ];
  const page = (d = base(), w: string[] = []) => buildBackMatter(d, w, { communities }).find((p) => p.id === 'community');

  it('is on by default and lists each community as its name and its address, one to a line', () => {
    const w: string[] = [];
    const p = page(base(), w)!;
    expect(p.heading).toBe('JOIN THE COMMUNITY');
    expect(p.blocks).toEqual([
      { t: 'heading', text: 'JOIN THE COMMUNITY' },
      { t: 'address', name: 'Reader Discord', url: 'https://discord.gg/readers' },
      { t: 'address', name: 'Facebook Group', url: 'https://www.facebook.com/groups/readers' }
    ]);
    expect(w).toHaveLength(1); // the one that is not a web address is left out, and says so
    expect(w[0]).toMatch(/Bad One/);
  });

  it('leaves out the communities this book switches off, and a new one is on until it is', () => {
    const d = base();
    d.back.community.off = ['a'];
    expect(page(d)!.blocks.filter((b) => b.t === 'address').map((b) => (b as { name: string }).name)).toEqual(['Facebook Group']);
    d.back.community.off = ['a', 'b', 'c'];
    expect(page(d)).toBeUndefined(); // nothing left, so no page and no heading on its own
  });

  it('is left out when switched off for the book, when the Studio has none, or with no list at all', () => {
    const d = base();
    d.back.community.enabled = false;
    expect(page(d)).toBeUndefined();
    expect(buildBackMatter(base(), [], { communities: [] }).some((p) => p.id === 'community')).toBe(false);
    expect(buildBackMatter(base(), [], null).some((p) => p.id === 'community')).toBe(false);
  });

  it('takes the book’s own heading, and sits between Patreon and About the author', () => {
    const d = base();
    d.back.community.heading = 'FIND US';
    d.back.patreon.enabled = true;
    d.back.about = { enabled: true, heading: 'ABOUT THE AUTHOR', text: 'Hi.' };
    const pages = buildBackMatter(d, [], { communities, patreonUrl: 'https://www.patreon.com/a', patreonCta: '' });
    expect(pages.map((p) => p.id)).toEqual(['patreon', 'community', 'about']);
    expect(pages[1]!.heading).toBe('FIND US');
  });
});
