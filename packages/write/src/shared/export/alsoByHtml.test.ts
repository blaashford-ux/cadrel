import { describe, expect, it } from 'vitest';
import { matterPageHtml } from './html';
import type { MatterPage } from './matter';

const page: MatterPage = {
  id: 'alsoBy',
  heading: 'ALSO BY',
  blocks: [
    { t: 'heading', text: 'ALSO BY ANN' },
    { t: 'subheading', text: 'Book <Two>' },
    { t: 'image', src: 'data:image/jpeg;base64,AAAA', alt: 'Cover of Book Two' },
    { t: 'weblink', url: 'https://example.com/2' },
    { t: 'para', text: 'A sequel.' }
  ]
};

describe('Also By page markup', () => {
  it('sets title, cover, clickable address and blurb in order for print', () => {
    const html = matterPageHtml(page, 'print');
    const at = (s: string) => html.indexOf(s);
    expect(at('<h2 class="bookhead">Book &lt;Two&gt;</h2>')).toBeGreaterThan(-1);
    expect(at('bookhead')).toBeLessThan(at('bookcover'));
    expect(at('bookcover')).toBeLessThan(at('weburl'));
    expect(at('weburl')).toBeLessThan(at('A sequel.'));
    expect(html).toContain('<a href="https://example.com/2">https://example.com/2</a>');
  });
  it('leaves the cover out of ebooks but keeps the link', () => {
    const html = matterPageHtml(page, 'ebook');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com/2"');
  });
});
