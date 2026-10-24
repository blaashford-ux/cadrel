import { themeCss, type ThemeCustom } from '../shared/theme';

const ID = 'mdedit-custom-theme';

/** Puts the user's custom light/dark colours on the page (or removes them). Which one shows follows the colour scheme. */
export function applyThemeCustom(custom: ThemeCustom | undefined): void {
  if (typeof document === 'undefined') return;
  const css = themeCss(custom);
  let el = document.getElementById(ID);
  if (!css) return void el?.remove();
  if (!el) {
    el = document.createElement('style');
    el.id = ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}
