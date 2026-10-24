import { DEFAULT_PORT, asinOf, wantsAutoCapture, withoutHash, classifyUrl, decideSample, describeResult, extForType, extractCoverUrl, isCaptureQuotaError, isImageHost, sessionId, shotWait, toBase64 } from './lib.js';
import { preparePage, sampleLoop } from './page.js';

const MENU_ID = 'bookscout-send';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Send to BookScout',
    contexts: ['page', 'link', 'selection', 'image'],
    documentUrlPatterns: ['https://www.amazon.com/*', 'https://amazon.com/*'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab) void captureTab(tab);
});

// A search the BookScout app opened ("Search on Amazon") is captured once it has loaded, with no click.
/** @type {Map<number, string>} tab id -> the url already captured, so repeated "complete" events do not capture twice */
const autoCaptured = new Map();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !wantsAutoCapture(tab.url)) return;
  if (autoCaptured.get(tabId) === tab.url) return;
  autoCaptured.set(tabId, tab.url);
  void captureTab(tab);
});
chrome.tabs.onRemoved.addListener((tabId) => autoCaptured.delete(tabId));

async function getConfig() {
  const { token, port } = await chrome.storage.local.get(['token', 'port']);
  return { token: token ?? '', port: port || DEFAULT_PORT };
}

async function post(path, body, cfg) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({ ok: false, error: `app answered ${res.status}` }));
}

/** Exchange the 6-digit code shown in the BookScout app for the access token. */
export async function pairWithCode(code, port) {
  const p = Number(port) || DEFAULT_PORT;
  try {
    const res = await fetch(`http://127.0.0.1:${p}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: String(code).trim() }) });
    const r = await res.json().catch(() => ({ ok: false, error: `app answered ${res.status}` }));
    if (!r.ok) return r;
    await chrome.storage.local.set({ token: r.token, port: p });
    return { ok: true };
  } catch {
    return { ok: false, error: 'BookScout is not running (or the port is wrong)' };
  }
}

export async function ping() {
  const cfg = await getConfig();
  if (!cfg.token) return { ok: false, error: 'not paired: paste the token from the BookScout app' };
  try {
    return await post('/v1/ping', null, cfg);
  } catch {
    return { ok: false, error: 'BookScout is not running' };
  }
}

async function fetchCover(url) {
  if (!isImageHost(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;
    return { ext: extForType(type), dataBase64: toBase64(await res.arrayBuffer()) };
  } catch {
    return null;
  }
}

/**
 * Everything shown on the toolbar button as a problem is also sent to the app's log.
 * @param {number} tabId
 * @param {string} badge
 * @param {string} title
 * @param {string} color
 * @param {{asin: string | null, session: string | null} | null} [ctx]
 */
function show(tabId, badge, title, color, ctx = null) {
  if (ctx && (badge === '!' || badge === '?')) slog(ctx, 'error', 'error shown to user', title);
  void chrome.action.setBadgeText({ tabId, text: badge }).catch(() => {}); // the tab may have closed
  void chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {}); // the tab may have closed
  void chrome.action.setTitle({ tabId, title: `BookScout: ${title}` }).catch(() => {}); // the tab may have closed
  if (badge !== '…') {
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); // the tab may have closed
      void chrome.action.setTitle({ tabId, title: 'BookScout' }).catch(() => {}); // the tab may have closed
    }, 6000);
  }
}

/** Capture the tab and send it to the app. Always resolves; the result is also shown on the toolbar button. */
export async function captureTab(tab) {
  const tabId = tab.id;
  const kind = classifyUrl(tab.url ?? '');
  const ctx = { asin: asinOf(tab.url ?? ''), session: null };
  if (!kind) {
    show(tabId, '!', 'open an amazon.com book page, bestseller list or search first', '#b3261e', ctx);
    return { ok: false, error: 'not an amazon.com book, list or search page' };
  }
  const cfg = await getConfig();
  if (!cfg.token) {
    show(tabId, '?', 'not paired: open the BookScout popup and paste the token', '#b3261e', ctx);
    return { ok: false, error: 'not paired' };
  }
  show(tabId, '…', 'capturing', '#555555');
  try {
    const injected = await chrome.scripting.executeScript({ target: { tabId }, func: preparePage, args: [kind] });
    const result = injected[0]?.result;
    if (!result) throw new Error('could not read the page');
    const covers = [];
    if (kind === 'detail') {
      const coverUrl = extractCoverUrl(result.html);
      const cover = coverUrl ? await fetchCover(coverUrl) : null;
      if (cover) covers.push(cover);
    }
    const r = await post('/v1/capture', { kind, url: withoutHash(result.url), html: result.html, capturedAt: new Date().toISOString(), covers }, cfg);
    const d = describeResult(r);
    show(tabId, d.badge, d.title, r.ok ? '#1e7a3c' : '#b3261e', ctx);
    return r;
  } catch (e) {
    const msg = e instanceof TypeError ? 'BookScout is not running' : String(/** @type {Error} */ (e)?.message ?? e);
    show(tabId, '!', msg, '#b3261e', ctx);
    return { ok: false, error: msg };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'pair') {
    void pairWithCode(msg.code, msg.port).then(reply);
    return true;
  }
  if (msg?.type === 'ping') {
    void ping().then(reply);
    return true;
  }
  if (msg?.type === 'sample-start' || msg?.type === 'sample-finish' || msg?.type === 'sample-now') {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (!tab) return reply({ ok: false, error: 'no tab' });
      if (msg.type === 'sample-start') return reply(await startSample(tab));
      if (msg.type === 'sample-finish') return reply(await finishSample(tab.id));
      await sampleTick(tab.id, null, true);
      reply({ ok: true });
    });
    return true;
  }
  if (msg?.type === 'capture-active') {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => reply(tab ? await captureTab(tab) : { ok: false, error: 'no tab' }));
    return true;
  }
  return false;
});

// ---- assisted sample capture ---------------------------------------------------------------------------------
// The sample reader is a cross-origin iframe, so its text cannot be read from the page. Instead, while a session runs,
// the page reports where the reader is about once a second; we screenshot the tab, keep the picture when the page has
// changed and then settled, and the desktop app reads the pictures later.

/** @type {Map<number, {asin: string, session: string, windowId: number, state: {lastSaved: Uint8Array | null, pending: Uint8Array | null}, pages: number, busy: boolean, port: chrome.runtime.Port | null, lastNote?: Map<string, {key: string, level: string, detail: string, repeats: number}>, lastShot?: number, backoffUntil?: number}>} */
const samples = new Map();

async function signatureOf(dataUrl, rect, dpr) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const crop = rect ? { x: Math.max(0, rect.left), y: Math.max(0, rect.top), w: Math.min(bmp.width - rect.left, rect.width), h: Math.min(bmp.height - rect.top, rect.height) } : { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const N = 48;
  const c = new OffscreenCanvas(N, N);
  const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
  g.drawImage(bmp, crop.x, crop.y, Math.max(1, crop.w), Math.max(1, crop.h), 0, 0, N, N);
  const px = g.getImageData(0, 0, N, N).data;
  const sig = new Uint8Array(N * N);
  for (let i = 0; i < sig.length; i++) sig[i] = (px[i * 4] * 0.2126 + px[i * 4 + 1] * 0.7152 + px[i * 4 + 2] * 0.0722) | 0;
  bmp.close();
  return sig;
}

/**
 * Tell the app what the sample capture is seeing, so its sample-capture.log explains a session that went wrong.
 * Best effort: never throws, never waits on the app. A note identical to the last one of the same kind is not sent
 * again (a condition that lasts, such as "reader not found", would otherwise fill the log every second); the repeats
 * are counted and reported when the note changes or the session ends.
 * `s` is the session, or any { asin, session } for things that happen outside one.
 */
function slog(s, level, event, detail = '') {
  const key = `${event}|${detail}`;
  const notes = (s.lastNote ??= new Map());
  const prev = notes.get(event);
  if (prev?.key === key) {
    prev.repeats++;
    return;
  }
  if (prev?.repeats) sendNote(s, prev.level, `${event} (repeated)`, `${prev.repeats} more identical: ${prev.detail}`);
  notes.set(event, { key, level, detail, repeats: 0 });
  sendNote(s, level, event, detail);
}

function flushNotes(s) {
  for (const [event, n] of s.lastNote ?? []) if (n.repeats) sendNote(s, n.level, `${event} (repeated)`, `${n.repeats} more identical: ${n.detail}`);
  s.lastNote?.clear();
}

function sendNote(s, level, event, detail) {
  void getConfig()
    .then((cfg) => post('/v1/sample/log', { asin: s.asin, session: s.session, level, event, detail }, cfg))
    .catch(() => {});
}

// Anything the worker throws that nothing else caught.
const everyContext = () => (samples.size ? [...samples.values()] : [{ asin: null, session: null }]);
self.addEventListener('error', (e) => everyContext().forEach((s) => slog(s, 'error', 'unhandled error in extension', `${e.message ?? e} (${e.filename ?? ''}:${e.lineno ?? ''})`)));
self.addEventListener('unhandledrejection', (e) => everyContext().forEach((s) => slog(s, 'error', 'unhandled rejection in extension', String(e.reason?.message ?? e.reason))));

async function uploadPage(cfg, s, dataUrl, rect) {
  const r = await post('/v1/sample/page', { asin: s.asin, session: s.session, ext: 'png', image: dataUrl.split(',')[1], crop: rect, capturedAt: new Date().toISOString() }, cfg);
  return r;
}

function sampleStatus(tabId, s, text) {
  void chrome.action.setBadgeText({ tabId, text: String(s.pages) }).catch(() => {}); // the tab may have closed
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#1e7a3c' }).catch(() => {}); // the tab may have closed
  void chrome.action.setTitle({ tabId, title: `BookScout: ${text}` }).catch(() => {}); // the tab may have closed
  s.port?.postMessage({ type: 'status', text });
}

/** One look at the reader. `force` saves whatever is on screen (the manual capture). */
async function sampleTick(tabId, rect, force = false) {
  const s = samples.get(tabId);
  if (!s || s.busy) return;
  s.busy = true;
  try {
    // Chrome refuses more than two screenshots a second; ticks that queued up while the page was busy would break that
    const wait = shotWait(s.lastShot, Date.now());
    if (!force && (wait > 0 || Date.now() < (s.backoffUntil ?? 0))) return;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const cfg = await getConfig();
    if (force) slog(s, 'info', 'manual capture', 'saving whatever is on screen');
    // captureVisibleTab photographs whatever tab is showing in the window, which is not this one if the user switched away
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && !tab.active) slog(s, 'warn', 'book tab is not the active tab', 'screenshots now show a different tab; switch back to the book page');
    s.lastShot = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(s.windowId, { format: 'png' });
    const sig = rect || force ? await signatureOf(dataUrl, rect) : null;
    const d = force ? { save: true, state: { lastSaved: sig, pending: null } } : decideSample(s.state, sig);
    s.state = d.state;
    if (!d.save) {
      if (!rect) slog(s, 'warn', 'reader not found', 'no reader frame is visible on the page (is Read Sample open and large enough?)');
      else slog(s, 'info', 'reader state', d.state.pending ? `reader ${Math.round(rect.width)}x${Math.round(rect.height)} px found, page changing, waiting for it to settle` : `reader ${Math.round(rect.width)}x${Math.round(rect.height)} px found, page unchanged`);
      sampleStatus(tabId, s, s.pages ? `${s.pages} page${s.pages === 1 ? '' : 's'} saved. Turn the page; the next one is saved when it settles.` : rect ? 'Reader found. Waiting for the page to settle.' : 'Open the sample (Read Sample) and turn the pages.');
      return;
    }
    if (!rect) slog(s, 'warn', 'saving without a reader crop', 'the whole screenshot will be read, which may include page furniture');
    const r = await uploadPage(cfg, s, dataUrl, rect);
    if (r.ok) {
      s.pages = r.pages;
      slog(s, r.duplicate ? 'warn' : 'info', r.duplicate ? 'page already saved' : 'page saved', `#${r.index}, ${r.pages} in session`);
      sampleStatus(tabId, s, `${r.pages} page${r.pages === 1 ? '' : 's'} saved${r.duplicate ? ' (that one was already saved)' : ''}`);
    } else {
      slog(s, 'error', 'upload failed', String(r.error));
      sampleStatus(tabId, s, r.error);
    }
  } catch (e) {
    const msg = String(/** @type {Error} */ (e)?.message ?? e);
    if (isCaptureQuotaError(msg)) s.backoffUntil = Date.now() + 2000; // let Chrome's one-second window pass
    slog(s, 'error', isCaptureQuotaError(msg) ? 'capture rate limit hit' : 'capture failed', msg);
    sampleStatus(tabId, s, `could not capture: ${msg}`);
  } finally {
    s.busy = false;
  }
}

export async function startSample(tab) {
  const tabId = tab.id;
  if (classifyUrl(tab.url ?? '') !== 'detail') {
    show(tabId, '!', 'open the book page first', '#b3261e', { asin: asinOf(tab.url ?? ''), session: null });
    return { ok: false, error: 'open the book page first' };
  }
  const running = samples.get(tabId);
  if (running) return { ok: true, session: running.session, pages: running.pages };
  // the book's own page (and cover) go in first, so the sample has a book to belong to
  const page = await captureTab(tab);
  if (!page.ok) return page;
  const s = { asin: page.asin ?? asinOf(tab.url), session: sessionId(), windowId: tab.windowId, state: { lastSaved: null, pending: null }, pages: 0, busy: false, port: null };
  samples.set(tabId, s);
  slog(s, 'info', 'session started', `extension ${chrome.runtime.getManifest().version}, ${tab.url}`);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: sampleLoop, args: [s.session] });
  } catch (e) {
    samples.delete(tabId);
    const msg = String(/** @type {Error} */ (e)?.message ?? e);
    slog(s, 'error', 'could not start the page script', msg);
    show(tabId, '!', `could not start: ${msg}`, '#b3261e', s);
    return { ok: false, error: msg };
  }
  sampleStatus(tabId, s, 'Open the sample (Read Sample) and turn the pages.');
  return { ok: true, session: s.session, asin: s.asin };
}

export async function finishSample(tabId) {
  const s = samples.get(tabId);
  if (!s) return { ok: false, error: 'no sample capture is running in this tab' };
  samples.delete(tabId);
  s.port?.postMessage({ type: 'stopped' });
  flushNotes(s);
  const cfg = await getConfig();
  let r = { ok: true };
  try {
    if (s.pages) r = await post('/v1/sample/finish', { asin: s.asin, session: s.session }, cfg);
    else slog(s, 'warn', 'session finished with no pages', 'nothing was saved: the reader was never found, never settled, or every upload failed (see the lines above)');
    if (s.pages && r.ok) slog(s, 'info', 'session finished', `${s.pages} page${s.pages === 1 ? '' : 's'} sent for reading`);
    else if (s.pages) slog(s, 'error', 'finish failed', String(r.error));
  } catch {
    r = { ok: false, error: 'BookScout is not running' };
  }
  show(tabId, r.ok ? '✓' : '!', r.ok ? (s.pages ? `sample sent: ${s.pages} page${s.pages === 1 ? '' : 's'}` : 'no sample pages were captured') : r.error, r.ok ? '#1e7a3c' : '#b3261e', s);
  return { ...r, pages: s.pages };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bookscout-sample') return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  port.onMessage.addListener((m) => {
    let s = samples.get(tabId);
    if (m.type === 'hello') {
      // After the worker restarts its memory is gone; the page still knows the session id, so carry on with it.
      if (!s) {
        const tab = port.sender?.tab;
        const asin = asinOf(tab?.url ?? '');
        if (!asin || !tab) return;
        s = { asin, session: m.session, windowId: tab.windowId, state: { lastSaved: null, pending: null }, pages: 0, busy: false, port: null };
        samples.set(tabId, s);
        slog(s, 'warn', 'extension worker restarted', 'carried on with the same session; the extension\'s page count and change detection restarted from zero');
      }
      s.port = port;
    } else if (m.type === 'log' && s) slog(s, m.level === 'error' ? 'error' : 'warn', String(m.event ?? 'page script note').slice(0, 60), String(m.detail ?? '').slice(0, 500));
    else if (m.type === 'tick') void sampleTick(tabId, m.rect);
    else if (m.type === 'finish') void finishSample(tabId);
  });
  port.onDisconnect.addListener(() => {
    const s = samples.get(tabId);
    if (s && s.port === port) {
      s.port = null;
      slog(s, 'info', 'page script disconnected', 'normal if the page navigated or the extension restarted; it reconnects if the session is still running');
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const s = samples.get(tabId);
  if (s) slog(s, 'info', 'tab closed', 'finishing the session');
  if (s) void finishSample(tabId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-sample-page' && tab?.id != null) void sampleTick(tab.id, null, true);
});

// Exposed for tests (the context menu cannot be clicked from automation).
Object.assign(globalThis, { captureTab, ping, pairWithCode, startSample, finishSample, sampleTick });
