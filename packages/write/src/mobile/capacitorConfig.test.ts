import { describe, expect, it } from 'vitest';
import config from '../../capacitor.config';
import { JOIN_PAGE } from '../shared/review/link';

describe('the phone app’s navigation rules', () => {
  const allowed = config.server?.allowNavigation ?? [];

  it('keep the invitation page and Google’s file picker inside the app, so the picker is not opened alone in the browser', () => {
    expect(allowed).toContain(new URL(JOIN_PAGE).host); // the page that runs the picker
    expect(allowed).toContain('docs.google.com'); // the picker itself
    expect(allowed).toContain('apis.google.com'); // its script
  });

  it('are exact host names, not a blanket allowance', () => {
    for (const host of allowed) expect(host, host).toMatch(/^[a-z0-9.-]+$/);
    expect(allowed).not.toContain('*');
  });
});
