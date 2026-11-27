// @vitest-environment jsdom
// The omnibus dialog drawn for real over a stand-in bridge: the books it offers and what it reads from their Book Details, putting them in order,
// what it asks for, what it sends, and what it says when something is wrong.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OmnibusBookInfo, OmnibusRecipe } from '../shared/export/omnibus';
import { OmnibusDialog } from './OmnibusDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const book = (path: string, title: string, o: Partial<OmnibusBookInfo> = {}): OmnibusBookInfo => ({ path, title, subtitle: '', author: 'A. Writer', chapters: 10, words: 50000, hasDetails: true, chapterLevel: 1, ...o });
const BOOKS = [book('Manuscripts/One.md', 'The Lost King', { subtitle: 'Book One' }), book('Manuscripts/Two.md', 'The Found Queen', { subtitle: 'Book Two', words: 60000 }), book('Notes/Draft.md', 'Draft', { hasDetails: false, author: '', chapters: 1, words: 500 })];
const bridge = {
  omnibusBooks: vi.fn(async (_p: string, files: string[]) => BOOKS.filter((b) => files.includes(b.path))),
  planOmnibus: vi.fn(async (_p: string, r: OmnibusRecipe) => ({ dir: '/proj/Manuscripts/Exports', outputs: r.outputs.epub ? [{ kind: 'epub' as const, path: `/proj/Manuscripts/Exports/${r.title} - Ebook.epub`, exists: false }] : [], errors: r.files.length < 2 ? ['An omnibus needs at least two manuscripts. Pick the books to put together.'] : r.title.trim() ? [] : ['The omnibus needs a title.'], warnings: [] })),
  runOmnibus: vi.fn(async (_p: string, _r: OmnibusRecipe) => ({ ok: true, errors: [], warnings: ['One chapter was left out.'], outputs: [{ kind: 'epub' as const, path: '/proj/Manuscripts/Exports/Saga - Ebook.epub', bytes: 2048 }] })),
  onExportProgress: vi.fn(() => () => undefined),
  cancelExport: vi.fn(),
  revealOutput: vi.fn(),
  openOutput: vi.fn(async () => ''),
  pickCoverImage: vi.fn(async () => 'C:/art/omnibus.png')
};
let root: Root;
let host: HTMLElement;
const onClose = vi.fn();
const onEditDetails = vi.fn();
const onSaveRecipe = vi.fn();
const saveFile = vi.fn(async (_f: string) => true);

beforeEach(() => {
  (window as unknown as { cadrelWrite: unknown }).cadrelWrite = bridge;
  for (const f of Object.values(bridge)) (f as ReturnType<typeof vi.fn>).mockClear();
  for (const f of [onClose, onEditDetails, onSaveRecipe, saveFile]) f.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = async (o: Partial<React.ComponentProps<typeof OmnibusDialog>> = {}) => {
  await act(async () => {
    root.render(<OmnibusDialog projectPath="/proj" projectName="The Saga" manuscripts={['Manuscripts/One.md', 'Manuscripts/Two.md']} otherFiles={['Notes/Draft.md']} saved={null} dirtyFiles={new Set()} saveFile={saveFile} onEditDetails={onEditDetails} detailsVersion={0} onSaveRecipe={onSaveRecipe} onClose={onClose} {...o} />);
  });
  await act(async () => new Promise((r) => setTimeout(r, 320))); // the form is planned after a short pause
};
const button = (text: string | RegExp) => [...host.querySelectorAll('button')].find((b) => (typeof text === 'string' ? b.textContent === text || b.getAttribute('aria-label') === text : text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''))) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => {
  expect(el, 'the control is there').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const type = async (el: Element | null, value: string) => {
  const input = el as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 320)));
};
const settle = () => act(async () => new Promise((r) => setTimeout(r, 320)));
const byLabel = (l: string) => host.querySelector(`[aria-label="${l}"]`) as HTMLInputElement | null;
const rows = () => [...host.querySelectorAll('.omni-books li')].map((li) => li.querySelector('.omni-title')!.textContent!.replace(/\s+/g, ' ').trim());

describe('the omnibus dialog', () => {
  it('offers the manuscripts with the title, subtitle, author and size from each one’s Book Details, and suggests a title from the project', async () => {
    await show();
    expect(bridge.omnibusBooks).toHaveBeenCalledWith('/proj', ['Manuscripts/One.md', 'Manuscripts/Two.md']);
    expect(rows()).toEqual(['The Lost King', 'The Found Queen']);
    expect(host.textContent).toContain('Book One · A. Writer · 10 chapters, 50,000 words');
    expect(byLabel('Omnibus title')!.value).toBe('The Saga Omnibus');
    expect(host.textContent).toContain('0 chosen');
    expect((button('Create the omnibus') as HTMLButtonElement).disabled).toBe(true); // nothing chosen yet, and the dialog says why
    expect(host.querySelector('[role=alert]')!.textContent).toContain('at least two manuscripts');
  });

  it('chooses books, numbers them in the order chosen, and moves one earlier or later', async () => {
    await show();
    await click(byLabel('Include The Found Queen'));
    await click(byLabel('Include The Lost King'));
    await settle();
    expect(rows()).toEqual(['1 The Found Queen', '2 The Lost King']); // in the order they were chosen
    expect(host.textContent).toContain('2 chosen, 110,000 words');
    await click(button('Move The Lost King earlier'));
    await settle();
    expect(rows()).toEqual(['1 The Lost King', '2 The Found Queen']);
    expect(button('Move The Lost King earlier')!.disabled).toBe(true);
    expect(button('Move The Found Queen later')!.disabled).toBe(true);
    expect(host.querySelector('[role=alert]')).toBeNull();
    expect((button('Create the omnibus') as HTMLButtonElement).disabled).toBe(false);
    expect(host.textContent).toContain('The Saga Omnibus - Ebook.epub');
  });

  it('can show every Markdown file, says when a file has no Book Details yet, and opens a book’s Book Details', async () => {
    await show();
    await click([...host.querySelectorAll('label.toggle')].find((l) => l.textContent!.includes('Show every Markdown file'))!.querySelector('input'));
    expect(rows()).toEqual(['The Lost King', 'The Found Queen', 'Draft']);
    expect(host.textContent).toContain('no Book Details yet: its title comes from the file name');
    await click([...host.querySelectorAll('.omni-books li')][0]!.querySelector('button.link'));
    expect(onEditDetails).toHaveBeenCalledWith('/proj/Manuscripts/One.md');
  });

  it('with no manuscripts set it shows every file and says how to set one', async () => {
    await show({ manuscripts: [] });
    expect(rows()).toEqual(['Draft']);
    await show({ manuscripts: [], otherFiles: [] });
    expect(host.textContent).toContain('Set as Manuscript');
  });

  it('sends what was asked for, remembers the recipe once it worked, and shows the files made and what to do with them', async () => {
    await show();
    await click(byLabel('Include The Lost King'));
    await click(byLabel('Include The Found Queen'));
    await settle();
    await type(byLabel('Omnibus title'), 'The Complete Saga');
    await type(byLabel('Omnibus subtitle'), 'Books One and Two');
    await type(byLabel('Omnibus ISBN'), '978-0-00-000000-0');
    await click(byLabel('Choose…') ?? button('Choose…'));
    expect(byLabel('Omnibus cover')!.value).toBe('C:/art/omnibus.png');
    await click([...host.querySelectorAll('label.toggle')].find((l) => l.textContent!.includes('Number the books'))!.querySelector('input'));
    // the print PDF starts on and the Word file off: turn them the other way round
    await click([...host.querySelectorAll('[aria-label=Outputs] label')].find((l) => l.textContent!.includes('Print PDF'))!.querySelector('input'));
    await click([...host.querySelectorAll('[aria-label=Outputs] label')].find((l) => l.textContent!.includes('Word'))!.querySelector('input'));
    await settle();
    await click(button('Create the omnibus'));
    await act(async () => undefined);
    expect(bridge.runOmnibus).toHaveBeenCalledWith('/proj', expect.objectContaining({ title: 'The Complete Saga', subtitle: 'Books One and Two', isbn: '978-0-00-000000-0', coverImage: 'C:/art/omnibus.png', files: ['Manuscripts/One.md', 'Manuscripts/Two.md'], numberBooks: false, outputs: { epub: true, pdf: false, docx: true } }));
    expect(onSaveRecipe).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('The omnibus was created.');
    expect(host.textContent).toContain('2 KB');
    expect(host.textContent).toContain('One chapter was left out.');
    await click(button('Show in folder'));
    expect(bridge.revealOutput).toHaveBeenCalledWith('/proj/Manuscripts/Exports/Saga - Ebook.epub');
    await click(button('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from the omnibus last made, keeping only files that are still there', async () => {
    await show({ saved: { title: 'Old Title', subtitle: '', author: 'Me', isbn: '', coverImage: '', files: ['Manuscripts/Two.md', 'Manuscripts/Gone.md', 'Manuscripts/One.md'], outputs: { epub: false, pdf: true, docx: true }, numberBooks: false, bookFront: false, allBackMatter: true } });
    expect(byLabel('Omnibus title')!.value).toBe('Old Title');
    expect(rows()).toEqual(['1 The Found Queen', '2 The Lost King']); // the saved order, without the file that is gone
  });

  it('saves any chosen book with unsaved edits first, and says so', async () => {
    await show({ dirtyFiles: new Set(['/proj/Manuscripts/One.md']) });
    await click(byLabel('Include The Lost King'));
    await click(byLabel('Include The Found Queen'));
    await settle();
    expect(host.textContent).toContain('One.md has unsaved edits');
    await click(button('Save the files and create'));
    await act(async () => undefined);
    expect(saveFile).toHaveBeenCalledWith('/proj/Manuscripts/One.md');
    expect(bridge.runOmnibus).toHaveBeenCalled();
  });

  it('does not build when a file cannot be saved, and shows what went wrong with a way back', async () => {
    saveFile.mockResolvedValueOnce(false);
    await show({ dirtyFiles: new Set(['/proj/Manuscripts/One.md']) });
    await click(byLabel('Include The Lost King'));
    await click(byLabel('Include The Found Queen'));
    await settle();
    await click(button('Save the files and create'));
    await act(async () => undefined);
    expect(bridge.runOmnibus).not.toHaveBeenCalled();
    expect(host.textContent).toContain('One.md could not be saved, so nothing was exported.');
    expect(onSaveRecipe).not.toHaveBeenCalled();
    await click(button('Back'));
    expect(host.querySelector('.omni-books')).toBeTruthy();
  });

  it('warns when the books name different authors', async () => {
    bridge.omnibusBooks.mockResolvedValueOnce([book('Manuscripts/One.md', 'The Lost King'), book('Manuscripts/Two.md', 'The Found Queen', { author: 'Someone Else' })]);
    await show({ saved: { ...({} as OmnibusRecipe), title: 'T', subtitle: '', author: '', isbn: '', coverImage: '', files: ['Manuscripts/One.md', 'Manuscripts/Two.md'], outputs: { epub: true, pdf: false, docx: false }, numberBooks: true, bookFront: true, allBackMatter: false } });
    expect(host.textContent).toContain('These books name different authors (A. Writer, Someone Else)');
  });

  it('closes on Cancel and on Escape', async () => {
    await show();
    await click(button('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
