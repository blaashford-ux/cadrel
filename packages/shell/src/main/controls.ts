/** The shell window's own minimise / maximise / close buttons (Windows). They sit in a small view above every other view, so they
 * are on top of Write and Market too, and the corner they fill is rounded to match the window. */
export const CONTROLS_WIDTH = 138;
export const CONTROLS_HEIGHT = 40;
/** Radius of the window's own corners (the same as Windows 11 uses for its own windows). */
export const WINDOW_RADIUS = 8;
/** Radius of the buttons' inner (bottom-left) corner, where they meet the page's floating card. */
export const INNER_RADIUS = 14;

export interface ControlsLook {
  /** The window's border colour; the buttons share it so they read as part of the border. */
  shell: string;
  fg: string;
  hover: string;
  maximized: boolean;
}

const ICONS = {
  minimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>',
  maximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5v-2h7v7h-2"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/></svg>'
};

const hex = (v: string) => (/^#[0-9a-f]{3,8}$/i.test(v) ? v : '#888888');

/** The page for the buttons view. Plain HTML: it only needs the shell's preload, for `window.cadrel.windowControl`. */
export function controlsHtml(look: ControlsLook): string {
  const radius = look.maximized ? 0 : WINDOW_RADIUS;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:none;user-select:none;-webkit-user-select:none}
/* The colour goes on a box, not on body: a body background would spread over the whole page and the corners could not be see-through. */
.bar{display:flex;height:100%;background:${hex(look.shell)};border-radius:0 ${radius}px 0 ${INNER_RADIUS}px;overflow:hidden}
button{width:46px;height:${CONTROLS_HEIGHT}px;border:0;padding:0;margin:0;background:transparent;color:${hex(look.fg)};display:grid;place-items:center;cursor:default;border-radius:0}
button:hover{background:${hex(look.hover)}}
button.close:hover{background:#c42b1c;color:#fff}
</style></head><body><div class="bar">
<button id="min" aria-label="Minimize" title="Minimize">${ICONS.minimize}</button>
<button id="max" aria-label="${look.maximized ? 'Restore' : 'Maximize'}" title="${look.maximized ? 'Restore' : 'Maximize'}">${look.maximized ? ICONS.restore : ICONS.maximize}</button>
<button id="close" class="close" aria-label="Close" title="Close">${ICONS.close}</button></div>
<script>
const c = (a) => window.cadrel && window.cadrel.windowControl(a);
document.getElementById('min').onclick = () => c('minimize');
document.getElementById('max').onclick = () => c('maximize');
document.getElementById('close').onclick = () => c('close');
</script></body></html>`;
}

export const controlsUrl = (look: ControlsLook) => `data:text/html;charset=utf-8,${encodeURIComponent(controlsHtml(look))}`;

/** Where the buttons view sits: the window's top-right corner. */
export function controlsBounds(content: { width: number }) {
  return { x: Math.max(0, content.width - CONTROLS_WIDTH), y: 0, width: CONTROLS_WIDTH, height: CONTROLS_HEIGHT };
}
