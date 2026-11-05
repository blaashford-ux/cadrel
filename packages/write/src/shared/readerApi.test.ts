import { describe, expect, it, vi } from 'vitest';
import { READER_CAPABILITIES, READER_MOBILE_CAPABILITIES } from './api';
import { READER_REFUSED_CALLS, withoutAuthorCalls } from './readerApi';

describe('Cadrel Reader’s API', () => {
  it('refuses every author call and leaves the rest alone', async () => {
    const readFile = vi.fn(async () => 'text');
    const writeFile = vi.fn(async () => ({}));
    const api = withoutAuthorCalls({ readFile, writeFile, saveReview: vi.fn(), inviteReviewer: vi.fn() });
    await expect(api.writeFile()).rejects.toThrow(/Cadrel Reader/);
    await expect(api.inviteReviewer()).rejects.toThrow(/can’t do that/);
    expect(writeFile).not.toHaveBeenCalled();
    expect(await api.readFile()).toBe('text');
    expect(new Set(READER_REFUSED_CALLS).size).toBe(READER_REFUSED_CALLS.length);
  });

  it('turns off everything that writes, shares, exports or connects an AI', () => {
    for (const caps of [READER_CAPABILITIES, READER_MOBILE_CAPABILITIES]) {
      expect(caps).toMatchObject({ reader: true, export: false, importDocx: false, ai: false, manageProjects: false, folderPicker: false, fonts: false, launchFiles: false });
      expect(caps).toMatchObject({ review: true, sync: true, update: true });
    }
    expect(READER_CAPABILITIES.windowChrome).toBe(true);
    expect(READER_MOBILE_CAPABILITIES.windowChrome).toBe(false);
  });
});
