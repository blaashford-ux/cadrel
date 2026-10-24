// Pure helpers shared by the service worker, the popup and the tests.

export const DEFAULT_PORT = 47321;

/** @returns {'detail' | 'list' | 'search' | null} */
export function classifyUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'www.amazon.com' && url.hostname !== 'amazon.com')) return null;
  if (/\/(?:zgbs|gp\/bestsellers|gp\/new-releases|gp\/movers-and-shakers)\b/.test(url.pathname)) return 'list';
  if (/\/(?:dp|gp\/product)\/[A-Z0-9]{10}/.test(url.pathname)) return 'detail';
  if (/^\/s\/?$/.test(url.pathname) && url.searchParams.get('k')) return 'search';
  return null;
}

/** Appended (as a fragment, which Amazon never sees) to the search URLs the BookScout app opens, so the extension knows to capture them without a click. */
export const AUTO_CAPTURE_HASH = '#bookscout-capture';

/** True for an amazon.com search page the app opened for capture. */
export function wantsAutoCapture(u) {
  return classifyUrl(u) === 'search' && u.endsWith(AUTO_CAPTURE_HASH);
}

/** The URL as Amazon knows it: without the fragment. */
export function withoutHash(u) {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
}

/** Hi-res cover URL from the page source: the colorImages script first, the main image tag second. */
export function extractCoverUrl(html) {
  const hi = /"hiRes"\s*:\s*"(https:[^"]+)"/.exec(html);
  if (hi) return hi[1].replace(/\\\//g, '/');
  const old = /data-old-hires="(https:[^"]+)"/.exec(html);
  return old ? old[1] : null;
}

export function isImageHost(u) {
  try {
    const h = new URL(u).hostname;
    return u.startsWith('https:') && (h === 'm.media-amazon.com' || h === 'images-na.ssl-images-amazon.com');
  } catch {
    return false;
  }
}

export function extForType(contentType) {
  if (/png/i.test(contentType)) return 'png';
  if (/webp/i.test(contentType)) return 'webp';
  if (/gif/i.test(contentType)) return 'gif';
  return 'jpg';
}

export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Map a failed or successful response from the app to a short toolbar message. */
export function describeResult(r) {
  if (r.ok) {
    const what = r.kind === 'list' ? `list ${r.category ?? ''}`.trim() : r.kind === 'search' ? `search "${r.query ?? ''}"` : `book ${r.asin ?? ''}`.trim();
    return { badge: '✓', title: `Saved ${what}${r.replaced ? ' (replaced)' : ''}` };
  }
  return { badge: '!', title: r.error };
}

// ---- assisted sample capture -------------------------------------------------------------------------------

/** Mean absolute difference between two grayscale signatures (0 to 255). */
export function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

export const SAMPLE_CHANGE = 3; // a new page differs from the last saved one by at least this
export const SAMPLE_STABLE = 1; // two consecutive looks closer than this count as "the page has settled"

/**
 * Decide whether the current look of the reader should be saved. A page is saved once it has changed from the last
 * saved page and then stayed still for one more look (so page-turn animations are skipped).
 * @param {{lastSaved: Uint8Array | null, pending: Uint8Array | null}} state
 * @param {Uint8Array | null} sig null when the reader is not on screen
 * @returns {{save: boolean, state: {lastSaved: Uint8Array | null, pending: Uint8Array | null}}}
 */
export function decideSample(state, sig) {
  if (!sig) return { save: false, state: { ...state, pending: null } };
  if (state.lastSaved && signatureDistance(state.lastSaved, sig) < SAMPLE_CHANGE) return { save: false, state: { ...state, pending: null } };
  if (state.pending && signatureDistance(state.pending, sig) < SAMPLE_STABLE) return { save: true, state: { lastSaved: sig, pending: null } };
  return { save: false, state: { ...state, pending: sig } };
}

/** "20261019T100000Z" */
export function sessionId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The ASIN in an amazon.com book URL. */
export function asinOf(u) {
  const m = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/.exec(u);
  return m ? m[1] : null;
}

/** Chrome allows two captureVisibleTab calls a second and refuses the rest with a quota error. Keep well under it. */
export const SHOT_GAP_MS = 700;

/** How long to wait before the next screenshot is allowed (0 = go now). */
export function shotWait(lastShotAt, now, gap = SHOT_GAP_MS) {
  return lastShotAt == null ? 0 : Math.max(0, lastShotAt + gap - now);
}

/** True for Chrome's "exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota" refusal. */
export function isCaptureQuotaError(message) {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|exceeds .*quota/i.test(String(message ?? ''));
}
