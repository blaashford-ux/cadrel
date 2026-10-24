import type { Overview } from '../shared/api';

export type CaptureTone = 'on' | 'off' | 'wait';

/** What to tell the user about Market's capture server. It only starts once a library is chosen, so no library is waiting, not broken. */
export function captureState(m: Overview['market']): { tone: CaptureTone; text: string } {
  if (!m.libraryRoot) return { tone: 'wait', text: 'The capture server starts once you choose a library' };
  if (m.serverRunning) return { tone: 'on', text: `Listening for captures on port ${m.port}` };
  return { tone: 'off', text: m.serverError ? `Not listening: ${m.serverError}` : 'Not listening for captures' };
}
