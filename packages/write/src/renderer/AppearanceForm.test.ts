// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THEMES, type ThemeCustom } from '../shared/theme';
import { AppearanceForm } from './AppearanceForm';
import { applyThemeCustom } from './applyTheme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let latest: ThemeCustom | undefined;
beforeEach(() => {
  latest = undefined;
  host = document.createElement('div');
  document.body.appendChild(host);
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => {
  host.remove();
  applyThemeCustom(undefined);
});

function Harness({ start }: { start?: ThemeCustom }) {
  const [c, setC] = useState(start);
  latest = c;
  return createElement(AppearanceForm, { custom: c, onChange: (n) => (latest = n, setC(n)) });
}
const mount = async (start?: ThemeCustom) => {
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness, { start })));
};
const typeInto = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const tab = (name: RegExp) => [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) => name.test(b.textContent ?? ''))!;
const hex = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label} hex value"]`)!;

describe('AppearanceForm', () => {
  it('edits the light and dark themes independently', async () => {
    await mount();
    await act(async () => tab(/Light/).click());
    await typeInto(hex('Page'), '#ffffff');
    await act(async () => tab(/Dark/).click());
    expect(hex('Page').value).toBe(DEFAULT_THEMES.dark.bg); // the dark theme was not touched
    await typeInto(hex('Accent'), '#ff8800');
    expect(latest).toEqual({ light: { bg: '#ffffff' }, dark: { accent: '#ff8800' } });
  });

  it('ignores half-typed colours and accepts short ones', async () => {
    await mount();
    await act(async () => tab(/Light/).click());
    await typeInto(hex('Text'), '#12');
    expect(latest).toBeUndefined();
    await typeInto(hex('Text'), '#123');
    expect(latest).toEqual({ light: { fg: '#112233' } });
  });

  it('applies a preset to the theme being edited, and resets one theme', async () => {
    await mount({ light: { bg: '#ffffff' }, dark: { bg: '#000000' } });
    await act(async () => tab(/Light/).click());
    await act(async () => [...host.querySelectorAll('button')].find((b) => /Paper/.test(b.textContent ?? ''))!.click());
    expect(latest?.light?.bg).toBe('#fbf8f0');
    expect(latest?.dark).toEqual({ bg: '#000000' });
    await act(async () => [...host.querySelectorAll('button')].find((b) => /Shipped light/.test(b.textContent ?? ''))!.click());
    expect(latest).toEqual({ dark: { bg: '#000000' } });
  });

  it('warns when the text is hard to read on the page', async () => {
    await mount();
    await act(async () => tab(/Light/).click());
    await typeInto(hex('Text'), '#f0f0f0');
    expect(host.textContent).toMatch(/too close to read/);
  });
});

describe('applyThemeCustom', () => {
  it('adds, updates and removes the stylesheet', () => {
    applyThemeCustom({ light: { bg: '#ffffff' } });
    expect(document.getElementById('mdedit-custom-theme')!.textContent).toContain('--bg: #ffffff');
    applyThemeCustom({ light: { bg: '#eeeeee' } });
    expect(document.querySelectorAll('#mdedit-custom-theme')).toHaveLength(1);
    applyThemeCustom(undefined);
    expect(document.getElementById('mdedit-custom-theme')).toBeNull();
  });
});
