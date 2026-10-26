import { describe, expect, it } from 'vitest';
import { CONTROLS_HEIGHT, CONTROLS_WIDTH, INNER_RADIUS, WINDOW_RADIUS, controlsBounds, controlsHtml } from '../src/main/controls';

const look = { shell: '#e8e4da', fg: '#172a36', hover: '#172a361f', maximized: false };

describe('window buttons', () => {
  it('sit in the top-right corner of the window', () => {
    expect(controlsBounds({ width: 1280 })).toEqual({ x: 1280 - CONTROLS_WIDTH, y: 0, width: CONTROLS_WIDTH, height: CONTROLS_HEIGHT });
    expect(controlsBounds({ width: 50 }).x).toBe(0);
  });

  it('share the border colour and round the window corner, except when maximised', () => {
    const html = controlsHtml(look);
    expect(html).toContain('background:#e8e4da');
    expect(html).toContain(`border-radius:0 ${WINDOW_RADIUS}px 0 ${INNER_RADIUS}px`);
    expect(html).toContain('aria-label="Maximize"');
    const max = controlsHtml({ ...look, maximized: true });
    expect(max).toContain(`border-radius:0 0px 0 ${INNER_RADIUS}px`);
    expect(max).toContain('aria-label="Restore"');
  });

  it('never puts an unchecked colour into the page', () => {
    expect(controlsHtml({ ...look, shell: 'red;}</style><script>x()</script>' })).not.toContain('x()');
  });
});
