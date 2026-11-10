import { describe, expect, it } from 'vitest';
import config from '../../capacitor.config';

describe('the phone app’s navigation rules', () => {
  const allowed = config.server?.allowNavigation ?? [];

  it('no longer keep Google’s file picker or an invitation page inside the app (beta readers join through a Studio)', () => {
    for (const host of ['blaashford-ux.github.io', 'docs.google.com', 'apis.google.com']) expect(allowed).not.toContain(host);
  });

  it('are exact host names, not a blanket allowance', () => {
    for (const host of allowed) expect(host, host).toMatch(/^[a-z0-9.-]+$/);
    expect(allowed).not.toContain('*');
  });
});
