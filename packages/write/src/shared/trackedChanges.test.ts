import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importTracked } from './trackedChanges';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const ins = (t: string, a = 'Sam') => `<w:ins w:id="1" w:author="${a}" w:date="2026-03-01T10:00:00Z"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:ins>`;
const del = (t: string, a = 'Sam') => `<w:del w:id="2" w:author="${a}" w:date="2026-03-01T10:00:00Z"><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:del>`;

function docx(paragraphs: string[], comments = ''): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${paragraphs.map((p) => `<w:p>${p}</w:p>`).join('')}</w:body></w:document>`)
  };
  if (comments) files['word/comments.xml'] = strToU8(`<?xml version="1.0"?><w:comments ${W}>${comments}</w:comments>`);
  return zipSync(files);
}

describe('importTracked', () => {
  it('makes the manuscript from the original text: insertions out, deletions back in', () => {
    const r = importTracked(docx([run('She ') + del('walked slowly') + ins('crept') + run(' to the door.'), run('Plain.')]));
    expect(r.markdown).toBe('She walked slowly to the door.\n\nPlain.\n');
  });

  it('turns a deletion with an insertion into one replacement suggestion', () => {
    const r = importTracked(docx([run('She ') + del('walked slowly') + ins('crept') + run(' to the door.')]));
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({ kind: 'suggestion', quote: 'walked slowly', replacement: 'crept', author: 'Sam', date: '2026-03-01T10:00:00Z', before: 'She ', after: ' to the door.' });
  });

  it('reads a replacement written insertion-first as the same single suggestion', () => {
    const r = importTracked(docx([run('She ') + ins('crept') + del('walked slowly') + run(' to the door.')]));
    expect(r.notes.map((n) => [n.quote, n.replacement])).toEqual([['walked slowly', 'crept']]);
  });

  it('turns a plain deletion into a suggestion with nothing in its place', () => {
    const r = importTracked(docx([run('It was ') + del('very ') + run('cold.')]));
    expect(r.notes[0]).toMatchObject({ kind: 'suggestion', quote: 'very ', replacement: '' });
  });

  it('turns an insertion into a suggestion that repeats the words before it', () => {
    const r = importTracked(docx([run('The river ran') + ins(' very') + run(' cold.')]));
    expect(r.notes[0]).toMatchObject({ kind: 'suggestion', quote: 'The river ran', replacement: 'The river ran very' });
    expect(r.markdown).toBe('The river ran cold.\n');
  });

  it('anchors an insertion at the start of a paragraph on the words after it', () => {
    const r = importTracked(docx([ins('Suddenly, ') + run('the river ran cold.')]));
    expect(r.notes[0]).toMatchObject({ kind: 'suggestion', replacement: expect.stringMatching(/^Suddenly, the river/) });
    expect(r.notes[0]!.quote.startsWith('the river')).toBe(true);
  });

  it('turns Word comments into comments on the text they cover', () => {
    const c = '<w:comment w:id="7" w:author="Pat" w:date="2026-03-02T09:00:00Z"><w:p><w:r><w:t>Cold how?</w:t></w:r></w:p></w:comment>';
    const r = importTracked(docx([run('The ') + '<w:commentRangeStart w:id="7"/>' + run('river') + '<w:commentRangeEnd w:id="7"/>' + run(' ran cold.')], c));
    expect(r.notes).toEqual([{ kind: 'comment', quote: 'river', body: 'Cold how?', before: 'The ', after: ' ran cold.', author: 'Pat', date: '2026-03-02T09:00:00Z' }]);
  });

  it('counts what it found and gives no notes for a file with no changes', () => {
    const r = importTracked(docx([run('Just text.')]));
    expect(r).toEqual({ markdown: 'Just text.\n', notes: [], found: 0 });
  });

  it('refuses a file that is not a .docx', () => {
    expect(() => importTracked(strToU8('hello'))).toThrow(/not a valid .docx/);
    expect(() => importTracked(zipSync({ 'x.txt': strToU8('hi') }))).toThrow(/not a valid .docx/);
  });
});
