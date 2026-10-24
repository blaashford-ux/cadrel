import { describe, expect, it } from 'vitest';
import { captureState } from '../src/renderer/capture';

const base = { ok: true, libraryRoot: '/lib', serverRunning: true, serverError: null, port: 4545, categories: [], queued: 0, error: null };

describe('captureState', () => {
  it('waiting, not broken, before a library is chosen', () => {
    expect(captureState({ ...base, libraryRoot: null, serverRunning: false })).toEqual({ tone: 'wait', text: 'The capture server starts once you choose a library' });
  });
  it('listening', () => {
    expect(captureState(base)).toEqual({ tone: 'on', text: 'Listening for captures on port 4545' });
  });
  it('a stopped server is an error, with its reason when known', () => {
    expect(captureState({ ...base, serverRunning: false })).toEqual({ tone: 'off', text: 'Not listening for captures' });
    expect(captureState({ ...base, serverRunning: false, serverError: 'port 4545 is in use' })).toEqual({ tone: 'off', text: 'Not listening: port 4545 is in use' });
  });
});
