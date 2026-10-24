import { describe, expect, it } from 'vitest';
import { moduleBounds, RAIL_WIDTH } from '../src/main/layout';
import { isModule, isPage, PAGES } from '../src/shared/api';

describe('layout', () => {
  it('a module fills everything to the right of the rail', () => {
    expect(moduleBounds({ width: 1200, height: 800 })).toEqual({ x: RAIL_WIDTH, y: 0, width: 1200 - RAIL_WIDTH, height: 800 });
  });
  it('never goes negative in a window narrower than the rail', () => {
    expect(moduleBounds({ width: 10, height: 0 })).toEqual({ x: RAIL_WIDTH, y: 0, width: 0, height: 0 });
  });
});

describe('pages', () => {
  it('knows which pages are modules', () => {
    expect(PAGES.filter(isModule)).toEqual(['write', 'market']);
  });
  it('rejects anything that is not a page', () => {
    expect(isPage('home')).toBe(true);
    expect(isPage('settings')).toBe(true);
    expect(isPage('billing')).toBe(false);
    expect(isPage(42)).toBe(false);
    expect(isPage(null)).toBe(false);
  });
});
