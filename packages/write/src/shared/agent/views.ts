/**
 * Fills the self-contained HTML templates (shipped as assets of the tracker skills) with a view's data. A template is a
 * complete page whose data is one JSON block marked `__CADREL_DATA__`; everything is drawn in the page by its own script, so the
 * result opens in any browser with no network, and can be published as an artifact as it is.
 */
export const DATA_MARK = '__CADREL_DATA__';
export const TITLE_MARK = '__CADREL_TITLE__';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON that can sit inside a script element: nothing in it can close the element or open a comment. */
export const safeJson = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderView(template: string, title: string, data: unknown): string {
  if (template.split(DATA_MARK).length !== 2) throw new Error('The view template must contain its data marker exactly once.');
  return template.split(TITLE_MARK).join(escapeHtml(title)).replace(DATA_MARK, () => safeJson(data));
}
