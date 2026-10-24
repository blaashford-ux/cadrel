export type PickOutcome =
  | { done: true }
  /** The person closed or cancelled the picker (nothing to report). */
  | { done: false; cancelled: true }
  /** Google kept returning other files than the ones asked for. `got` is what each round returned. */
  | { done: false; cancelled: false; missing: string[]; got: string[][] };

/**
 * Collects access to every file in `need`. The picker is asked for the files still missing, so someone who picks only one of
 * the two (selecting several needs a ctrl/shift-click or a tick) is asked for the other instead of being sent back to the
 * start. Each pick grants access to that file for good, so the rounds add up. Stops after `maxRounds`.
 */
export async function pickAll(need: string[], pick: (missing: string[]) => Promise<string[] | null>, maxRounds = 4): Promise<PickOutcome> {
  const have = new Set<string>();
  const got: string[][] = [];
  for (let round = 0; round < maxRounds; round++) {
    const missing = need.filter((id) => !have.has(id));
    if (!missing.length) return { done: true };
    const ids = await pick(missing);
    if (ids === null) return { done: false, cancelled: true };
    got.push(ids);
    for (const id of ids) if (need.includes(id)) have.add(id);
  }
  const missing = need.filter((id) => !have.has(id));
  return missing.length ? { done: false, cancelled: false, missing, got } : { done: true };
}

/** First characters of ids, enough to compare by eye without printing whole ids. */
export const shortIds = (ids: string[]): string => (ids.length ? ids.map((i) => `${i.slice(0, 6)}…`).join(', ') : 'nothing');
