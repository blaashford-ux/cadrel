// @vitest-environment jsdom
// The Cover Designer drawn for real (React in jsdom) over a stand-in bridge: what a person is offered, what their clicks and drags do to the
// design, what is saved, and what the Create asset menu gives. Drawing the picture itself needs a browser and is checked apart (coverExport.mjs).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, type Design, type TextLayer } from '../src/shared/cover/doc';
import { fixedMeasure } from '../src/shared/cover/text';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
URL.createObjectURL = () => 'blob:test';
URL.revokeObjectURL = () => undefined;

const cover = { context: vi.fn(), open: vi.fn(), image: vi.fn(), importPicture: vi.fn(), save: vi.fn(), fonts: vi.fn(async () => []) };
let Designer: typeof import('../src/renderer/cover/CoverDesigner').CoverDesigner;
let Menu: typeof import('../src/renderer/cover/CreateAssetMenu').CreateAssetMenu;
let Runtime: typeof import('../src/renderer/cover/runtime');
let root: Root;
let host: HTMLElement;
const onClose = vi.fn();
const render = vi.fn(async () => ({ image: Uint8Array.from([137, 80, 78, 71]), front: null as Uint8Array | null }));

beforeAll(async () => {
  (window as unknown as { cadrel: unknown }).cadrel = { cover };
  Designer = (await import('../src/renderer/cover/CoverDesigner')).CoverDesigner;
  Menu = (await import('../src/renderer/cover/CreateAssetMenu')).CreateAssetMenu;
  Runtime = await import('../src/renderer/cover/runtime');
});
beforeEach(() => {
  for (const m of Object.values(cover)) m.mockReset();
  cover.fonts.mockResolvedValue([]);
  onClose.mockReset();
  render.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pic = (path: string) => ({ path, mime: 'image/png', bytes: Uint8Array.from([1, 2, 3]), width: 1000, height: 1500, version: 1, hash: `h-${path}` });
const deps = () => ({
  pics: new Runtime.Pictures(async (p) => pic(p)),
  fonts: new Runtime.FontBook(async () => []),
  measure: fixedMeasure,
  render,
  thumb: vi.fn(async () => 'data:image/png;base64,AAAA'),
  palette: vi.fn(async () => ['#aa3322', '#223388']),
  system: () => ['Georgia'],
  pdf: vi.fn(async () => ({ png: Uint8Array.from([137, 80, 78, 71]), width: 3000, height: 2000, pages: 2 }))
});
const mount = async (props: Partial<React.ComponentProps<typeof Designer>> = {}) => {
  const d = deps();
  await act(async () => {
    root.render(<Designer projectId="p1" projectName="Book Four" kind="ebook" fields={{ title: 'Book Four', series: 'Dragon Rider', author: '' }} pictures={[{ fileId: 'f1', path: 'Art/Book Four/Pictures/sky.png', version: 1 }]} may={{ write: true }} onClose={onClose} deps={d} {...props} />);
  });
  return d;
};
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const button = (text: string | RegExp) => [...host.querySelectorAll('button')].find((b) => (typeof text === 'string' ? b.textContent === text || b.getAttribute('aria-label') === text : text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''))) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => {
  expect(el, 'the control is there').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const set = async (el: Element | null, value: string) => {
  const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};
const check = async (el: Element | null) => click(el);
const pick = (name: string) => [...host.querySelectorAll('.cv-layers li .cv-pick')].find((b) => b.textContent!.trim().endsWith(name)) as HTMLElement | undefined;
const layers = () => [...host.querySelectorAll('.cv-layers li .cv-pick')].map((b) => b.textContent!.replace(/^[^\s]+\s/, '').trim());
const art = () => q('[data-testid="cover-art"]')!.innerHTML;
const key = async (k: string, init: KeyboardEventInit = {}) => act(async () => { q('.cv-stage')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); });
const pointer = async (type: string, x: number, y: number, init: MouseEventInit = {}) => act(async () => { q('.cv-stage')!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...init })); });
const stageBox = () => {
  const st = q('.cv-stage')!;
  const w = parseFloat(st.style.width), h = parseFloat(st.style.height);
  st.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) });
  return { w, h };
};

describe('the Create asset menu', () => {
  it('is a button that opens Cover, which opens eBook and Paperback, and each makes that kind', async () => {
    const make = vi.fn();
    await act(async () => root.render(<Menu onCreate={make} />));
    expect(q('[role=menu]')).toBeNull();
    await click(button(/^Create asset/));
    expect([...host.querySelectorAll('[role=menuitem]')].map((e) => e.textContent!.trim())).toEqual(['Cover ▸']);
    expect(button(/^Cover/)!.getAttribute('aria-expanded')).toBe('false');
    await click(button(/^Cover/));
    expect([...host.querySelectorAll('[role=menuitem]')].map((e) => e.textContent!.trim())).toEqual(['Cover ▸', 'eBook', 'Paperback']);
    await click(button('Paperback'));
    expect(make).toHaveBeenCalledWith('paperback');
    expect(q('[role=menu]')).toBeNull(); // it closes once chosen
    await click(button(/^Create asset/));
    await click(button(/^Cover/));
    await click(button('eBook'));
    expect(make).toHaveBeenLastCalledWith('ebook');
  });
  it('closes on Escape and when something else is clicked, and can be turned off', async () => {
    await act(async () => root.render(<Menu onCreate={() => undefined} />));
    await click(button(/^Create asset/));
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(q('[role=menu]')).toBeNull();
    await click(button(/^Create asset/));
    await act(async () => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(q('[role=menu]')).toBeNull();
    await act(async () => root.render(<Menu onCreate={() => undefined} disabled />));
    expect(button(/^Create asset/)!.disabled).toBe(true);
  });
});

describe('making a cover', () => {
  it('starts empty, and adds words, shapes and library pieces that are selected, listed and drawn', async () => {
    await mount();
    expect(host.textContent).toContain('Nothing on the cover yet');
    await click(button('Add a title'));
    expect(layers()).toEqual(['Title']);
    expect(byLabel('Settings for Title')).toBeTruthy();
    await click(button('Box'));
    await click(button('Library'));
    await click(button('Add Plain rule'));
    await click(button('Symbols'));
    await click(button('Add Crown'));
    expect(layers()).toEqual(['Crown', 'Plain rule', 'Rectangle', 'Title']); // newest in front, first in the list
    expect(art()).toContain('Title');
    expect(art()).toContain('M0 4h300v2H0Z');
  });
  it('edits the words and the font and size, and the picture changes', async () => {
    await mount();
    await click(button('Add a title'));
    await set(byLabel('Words'), 'The Last Dragon');
    expect(layers()).toEqual(['The Last Dragon']);
    expect(art()).toContain('The Last</tspan>'); // wrapped to the layer's width
    expect(art()).toContain('Dragon</tspan>');
    await set(byLabel('Font'), 'Bebas Neue');
    expect(art()).toContain("font-family=\"'Bebas Neue'");
    await set(host.querySelector('select[aria-label="Size"]'), 'xxl');
    expect(art()).toMatch(/font-size="307\.2"/); // 12% of 2560
    await click(button('Bigger'));
    expect(art()).toMatch(/font-size="435\.2"/);
  });
  it('darkens behind text with one click, keeps it under the text, and takes it away with Undo', async () => {
    await mount();
    await click(button('Add a title'));
    await click(button('Darken behind this text'));
    expect(layers()).toEqual(['Title', 'Darken behind Title']);
    expect(host.textContent).toContain('Behind the words');
    expect(art().indexOf('layer-s')).toBeLessThan(art().indexOf('<text'));
    await click(button('Undo'));
    expect(layers()).toEqual(['Title']);
    expect(button('Undo')!.disabled).toBe(false);
    await click(button('Redo'));
    expect(layers()).toEqual(['Title', 'Darken behind Title']);
  });
  it('adds glow, a shadow and a texture by their own switches, and they are in the picture', async () => {
    await mount();
    await click(button('Add a title'));
    expect(art()).not.toContain('filter id="fx-');
    await check(host.querySelector('input[type=checkbox]:not([aria-label])') && [...host.querySelectorAll('.cv-check')].find((l) => l.textContent!.includes('Glow'))!.querySelector('input'));
    await check([...host.querySelectorAll('.cv-check')].find((l) => l.textContent!.includes('Drop shadow'))!.querySelector('input'));
    await check([...host.querySelectorAll('.cv-check')].find((l) => l.textContent!.includes('Texture'))!.querySelector('input'));
    expect(art()).toContain('filter id="fx-');
    expect(art()).toContain('feTurbulence');
    expect(art()).toContain('feGaussianBlur');
    await set(host.querySelector('select[aria-label="Texture kind"]'), 'foil');
    expect(art()).toContain('mode="overlay"');
    await set(byLabel('Glow size'), '0.02');
    expect(byLabel('Glow size')!.closest('label')!.textContent).toContain('20');
  });
  it('lays out a title block from the project’s names, with a font pairing', async () => {
    await mount();
    await click(button('Title block'));
    expect((byLabel('Block title') as HTMLInputElement).value).toBe('Book Four');
    expect((byLabel('Block series') as HTMLInputElement).value).toBe('Dragon Rider');
    expect((byLabel('Block author') as HTMLInputElement).value).toBe('Author Name');
    await set(byLabel('Block title'), 'The Last Dragon Rider');
    await set(byLabel('Font pairing'), 'thriller');
    await click(button('Title high'));
    await click(button('Lay out the title block'));
    expect(layers().sort()).toEqual(['Author', 'Series line', 'Title']);
    expect(art()).toContain('RIDER</tspan>');
    expect(art()).toContain('THE LAST');
    expect(art()).toContain("'Bebas Neue'");
    await click(button('Lay out the title block'));
    expect(layers()).toHaveLength(3); // replaced, not doubled
  });
  it('adds a picture from the project, fills the cover with it and offers its colours', async () => {
    const d = await mount();
    await set(byLabel('Picture from the project'), 'Art/Book Four/Pictures/sky.png');
    expect(layers()).toEqual(['sky']);
    expect(art()).toContain('<image');
    expect(art()).toContain('href="blob:test"');
    await act(async () => void (await d.pics.load('x')));
    expect(host.querySelector('[aria-label="Text fill colours from the picture"]')).toBeNull();
    expect(d.palette).toHaveBeenCalled();
    await click(button('Add a title'));
    expect([...host.querySelectorAll('.cv-swatch')].map((s) => s.getAttribute('aria-label'))).toEqual(['Use #aa3322', 'Use #223388']);
    await click(host.querySelector('.cv-swatch'));
    expect(art()).toContain('fill="#aa3322"');
  });
  it('imports a picture from the computer into the project and puts it on the cover', async () => {
    cover.importPicture.mockResolvedValue({ path: 'Art/Book Four/Pictures/moon.png', width: 800, height: 600, hash: 'hm' });
    await mount();
    const input = byLabel('Add a picture from your computer') as HTMLInputElement;
    const file = new File([Uint8Array.from([1, 2, 3])], 'moon.png', { type: 'image/png' });
    await act(async () => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => undefined);
    expect(cover.importPicture).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', name: 'moon.png', role: 'picture' }));
    expect(layers()).toEqual(['moon']);
  });
});

describe('layers', () => {
  it('hides, locks, reorders and deletes, and a locked layer cannot be picked or moved', async () => {
    await mount();
    await click(button('Box'));
    await click(button('Add a title'));
    expect(layers()).toEqual(['Title', 'Rectangle']);
    await click(button('Send Title back'));
    expect(layers()).toEqual(['Rectangle', 'Title']);
    await click(button('Hide Title'));
    expect(art()).not.toContain('<text');
    await click(button('Show Title'));
    expect(art()).toContain('<text');
    await click(button('Lock Title'));
    const { w, h } = stageBox();
    await pointer('pointerdown', w * 0.5, h * 0.42);
    expect(host.querySelector('.cv-layers li.on .cv-pick')?.textContent).not.toContain('Title'); // the locked layer was not picked
    await key('Escape');
    await click(pick('Rectangle'));
    await key('Delete');
    expect(layers()).toEqual(['Title']);
  });
});

describe('moving and snapping', () => {
  it('drags a layer, snaps it to the middle with a guide line, and a nudge moves it a little', async () => {
    await mount();
    await click(button('Box'));
    const { w, h } = stageBox();
    const at = () => parse(JSON.stringify({ format: 1, layers: [] })) && JSON.parse(save()).layers[0].frame as { x: number; y: number; w: number; h: number };
    const save = () => (cover.save.mock.calls.at(-1)![0] as { design: string }).design;
    // the box starts at x .3..7, y .4..: pick its middle and drag it right so its centre is near the middle of the cover
    await pointer('pointerdown', w * 0.5, h * 0.5);
    expect(host.querySelector('.cv-layers li.on')).toBeTruthy();
    await pointer('pointermove', w * 0.5 + 3, h * 0.5);
    expect(host.querySelector('.cv-hit')).toBeTruthy(); // a guide shows while it is on the middle
    await pointer('pointerup', w * 0.5 + 3, h * 0.5);
    expect(host.querySelector('.cv-hit')).toBeNull();
    await set(byLabel('Cover name'), 'Snap');
    await click(button('Save'));
    expect(Math.abs(at().x + at().w / 2 - 0.5)).toBeLessThan(1e-6); // exactly centred, not 3 pixels off
    // Alt moves freely
    await pointer('pointerdown', w * 0.5, h * 0.5);
    await pointer('pointermove', w * 0.5 + 3, h * 0.5, { altKey: true });
    await pointer('pointerup', w * 0.5 + 3, h * 0.5);
    await click(button('Save'));
    expect(at().x + at().w / 2).toBeGreaterThan(0.5);
    // arrow keys nudge, Shift a larger step
    const before = at().x;
    await key('ArrowRight');
    await key('ArrowRight', { shiftKey: true });
    await click(button('Save'));
    expect(at().x - before).toBeCloseTo(0.012, 4);
  });
  it('one drag is one undo step, and a rectangle selected by a drag over it is picked', async () => {
    await mount();
    await click(button('Box'));
    const { w, h } = stageBox();
    await pointer('pointerdown', w * 0.5, h * 0.5);
    for (const dx of [10, 20, 30, 40]) await pointer('pointermove', w * 0.5 + dx, h * 0.5 + dx);
    await pointer('pointerup', w * 0.5 + 40, h * 0.5 + 40);
    await click(button('Undo'));
    await click(button('Undo')); // the add
    expect(layers()).toEqual([]);
    await click(button('Redo'));
    await key('Escape');
    expect(host.querySelector('.cv-layers li.on')).toBeNull();
    await pointer('pointerdown', 2, 2);
    await pointer('pointermove', w - 2, h - 2);
    await pointer('pointerup', w - 2, h - 2);
    expect(host.querySelector('.cv-layers li.on')).toBeTruthy(); // the marquee took it in
  });
  it('arranges: centres a layer across the cover and stacks two', async () => {
    await mount();
    await click(button('Box'));
    await click(button('Centre across'));
    await click(button('Oval'));
    await click(button('Centre across'));
    await click(pick('Ellipse'));
    expect(button('Stack')!.disabled).toBe(true); // needs two
    const { w, h } = stageBox();
    await pointer('pointerdown', w * 0.5, h * 0.5, { shiftKey: false });
    await pointer('pointerup', w * 0.5, h * 0.5);
    await key('Escape');
    await click(pick('Rectangle'));
    await act(async () => void pick('Ellipse')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(host.textContent).toContain('2 layers selected');
    expect(button('Stack')!.disabled).toBe(false);
    expect(button('Space evenly across')!.disabled).toBe(true); // needs three
    await click(button('Stack'));
    expect(layers()).toHaveLength(2);
  });
});

describe('saving', () => {
  it('asks for a name, then saves the design and the picture of it, and says where it went', async () => {
    cover.save.mockResolvedValue({ assetId: 'a1', designPath: 'Art/Book Four/Front.cadrel-cover.json', imagePath: 'Art/Book Four/Front.png', frontPath: null, version: 1 });
    await mount();
    await click(button('Add a title'));
    await click(button('Save'));
    expect(host.textContent).toContain('Give the cover a name first');
    expect(cover.save).not.toHaveBeenCalled();
    await set(byLabel('Cover name'), 'Front');
    await click(button('Save'));
    expect(render).toHaveBeenCalledTimes(1);
    const sent = cover.save.mock.calls[0]![0] as { projectId: string; name: string; designPath: string | null; design: string; image: Uint8Array };
    expect(sent).toMatchObject({ projectId: 'p1', name: 'Front', designPath: null });
    expect(sent.image).toEqual(Uint8Array.from([137, 80, 78, 71]));
    const d: Design = parse(sent.design);
    expect(d.kind).toBe('ebook');
    expect(d.canvas).toEqual({ w: 1600, h: 2560 });
    expect((d.layers[0] as TextLayer).text).toBe('Title');
    expect(host.textContent).toContain('Saved as version 1');
    expect(host.textContent).toContain('waiting for someone to approve');
    expect(button('Saved')!.disabled).toBe(true); // nothing to save until it changes
    expect(host.querySelector('.cv-title')!.textContent).toBe('Front');
    await set(byLabel('Words'), 'Changed');
    await click(button('Save'));
    expect(cover.save.mock.calls[1]![0]).toMatchObject({ designPath: 'Art/Book Four/Front.cadrel-cover.json' });
  });
  it('shows the refusal in the Studio’s words and stays open', async () => {
    cover.save.mockRejectedValue(new Error("Error invoking remote method 'shell:cover:save': Error: Your role does not let you make art in this project."));
    await mount();
    await set(byLabel('Cover name'), 'Front');
    await click(button('Add a title'));
    await click(button('Save'));
    expect(q('[role=alert]')!.textContent).toBe('Your role does not let you make art in this project.');
    expect(button('Save')!.disabled).toBe(false);
  });
  it('does not let a role that may not write save, and says so', async () => {
    await mount({ may: { write: false } });
    expect(host.textContent).toContain('your role does not let you change it');
    expect(button('Save')!.disabled).toBe(true);
  });
  it('asks before leaving with unsaved changes, and leaves at once when there are none', async () => {
    await mount();
    await click(button(/Back to Art/));
    expect(onClose).toHaveBeenCalledWith(false);
    onClose.mockClear();
    await click(button('Add a title'));
    await click(button(/Back to Art/));
    expect(onClose).not.toHaveBeenCalled();
    expect(q('[role=alertdialog]')!.textContent).toContain('not saved');
    await click(button('Keep working'));
    expect(q('[role=alertdialog]')).toBeNull();
    await click(button(/Back to Art/));
    await click(button('Leave without saving'));
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

describe('opening a design', () => {
  const text = JSON.stringify({ format: 1, kind: 'ebook', canvas: { w: 1600, h: 2560 }, layers: [
    { id: 't1', type: 'text', name: 'Title', text: 'Old Title', frame: { x: 0.1, y: 0.4, w: 0.8, h: 0.1, rot: 0 } },
    { id: 'i1', type: 'image', name: 'sky', src: { path: 'Art/Book Four/Pictures/sky.png', hash: 'old' }, natural: { w: 10, h: 10 }, frame: { x: 0, y: 0, w: 1, h: 1, rot: 0 } }
  ] });
  it('shows the design, and says which pictures are missing or newer than when it was saved', async () => {
    cover.open.mockResolvedValue({ text, path: 'Art/Book Four/Front.cadrel-cover.json', fileId: 'f', version: 3, assetId: 'a1', pictures: [{ path: 'Art/Book Four/Pictures/sky.png', state: 'changed' }, { path: 'Art/Book Four/Pictures/gone.png', state: 'missing' }] });
    await mount({ openPath: 'Art/Book Four/Front.cadrel-cover.json' });
    expect(cover.open).toHaveBeenCalledWith('Art/Book Four/Front.cadrel-cover.json');
    expect(layers().sort()).toEqual(['Title', 'sky']);
    expect(host.querySelector('.cv-title')!.textContent).toBe('Front');
    expect(host.textContent).toContain('sky.png has a newer version');
    expect(host.textContent).toContain('gone.png is not in the files any more');
    expect(button('Saved')!.disabled).toBe(true);
    await click(pick('Title'));
    expect((byLabel('Words') as HTMLTextAreaElement).value).toBe('Old Title');
  });
  it('says so when the design cannot be opened', async () => {
    cover.open.mockRejectedValue(new Error('Your role does not let you see the art of this project.'));
    await mount({ openPath: 'x.cadrel-cover.json' });
    expect(q('[role=alert]')!.textContent).toContain('does not let you see');
  });
});

describe('a paperback', () => {
  it('imports the KDP template as a PDF, sizes the cover to it, lays it over the cover and never into the picture', async () => {
    cover.importPicture.mockResolvedValue({ path: 'Art/Book Four/Templates/template.png', width: 3000, height: 2000, hash: 'ht' });
    cover.save.mockResolvedValue({ assetId: 'a', designPath: 'Art/Book Four/Wrap.cadrel-cover.json', imagePath: 'Art/Book Four/Wrap.png', frontPath: 'Art/Book Four/Wrap-front.png', version: 1 });
    const d = await mount({ kind: 'paperback' });
    expect(host.textContent).toContain('Paperback wrap');
    await click(button('Wrap'));
    expect(host.textContent).toContain('Until a template is added');
    const input = byLabel('Import the KDP template') as HTMLInputElement;
    const file = new File([Uint8Array.from([37, 80, 68, 70])], 'template.pdf', { type: 'application/pdf' });
    await act(async () => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => undefined);
    expect(d.pdf).toHaveBeenCalled();
    expect(cover.importPicture).toHaveBeenCalledWith(expect.objectContaining({ name: 'template.png', role: 'template' }));
    expect(host.textContent).toContain('3000 × 2000');
    expect(host.textContent).toContain('more than one page');
    expect(art()).toContain('id="template"');
    expect(q('.cv-spine')).toBeTruthy();
    expect(q('.cv-regions.on')).toBeTruthy(); // marking starts straight away
    // hiding the template takes it off the cover
    await click(button('Hide template'));
    expect(art()).not.toContain('id="template"');
    await click(button('Show template'));
    // dragging a region line moves the spine's edge
    const { w, h } = stageBox();
    await pointer('pointerdown', w * 0.46, h * 0.5);
    await pointer('pointermove', w * 0.4, h * 0.5);
    await pointer('pointerup', w * 0.4, h * 0.5);
    expect(host.textContent).toContain('Back cover to 40%');
    await set(byLabel('Template strength'), '0.6');
    expect(art()).toContain('opacity="0.6"');
    // saving sends the design with the template, and what the page rendered for the picture and the front
    render.mockResolvedValueOnce({ image: Uint8Array.from([1]), front: Uint8Array.from([2]) });
    await set(byLabel('Cover name'), 'Wrap');
    await click(button('Save'));
    const sent = cover.save.mock.calls[0]![0] as { design: string; front: Uint8Array };
    expect(parse(sent.design).template).toMatchObject({ src: { path: 'Art/Book Four/Templates/template.png' }, back: 0.4, front: 0.54, opacity: 0.6 });
    expect(sent.front).toEqual(Uint8Array.from([2]));
    expect(parse(sent.design).canvas).toEqual({ w: 3000, h: 2000 });
  });
  it('has no template controls on an eBook', async () => {
    await mount();
    await click(button('Cover'));
    expect(byLabel('Import the KDP template')).toBeNull();
    expect(host.textContent).toContain('1,600 × 2,560');
  });
});

describe('the library and the fonts', () => {
  it('offers dividers, frames, ornaments, badges and symbols, each as a picture to click', async () => {
    await mount();
    await click(button('Library'));
    for (const g of ['Dividers', 'Frames', 'Ornaments', 'Badges', 'Symbols']) {
      await click(button(g));
      expect(host.querySelectorAll('.cv-lib').length).toBeGreaterThan(2);
    }
    expect(host.querySelectorAll('.cv-lib svg path').length).toBeGreaterThan(2);
  });
  it('offers the starter fonts first and the computer’s own after, and names a font that is not here', async () => {
    await mount();
    await click(button('Add a title'));
    const groups = [...host.querySelectorAll('select[aria-label="Font"] optgroup')].map((g) => g.getAttribute('label'));
    expect(groups).toEqual(['Starter fonts', 'On this computer']);
    expect([...host.querySelectorAll('select[aria-label="Font"] option')].map((o) => o.textContent)).toContain('Georgia');
  });
});
