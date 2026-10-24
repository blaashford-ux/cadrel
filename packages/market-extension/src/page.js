// Runs inside the Amazon tab (injected by chrome.scripting.executeScript). Must be self-contained:
// it is serialised and nothing from this module's scope is available there.

/** Scroll until the page stops growing so lazy-loaded rows and sections exist in the DOM, then return the HTML. */
export async function preparePage(kind) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startY = window.scrollY;
  const measure = () =>
    kind === 'list' ? document.querySelectorAll('#gridItemRoot').length * 100000 + document.body.scrollHeight : document.body.scrollHeight;
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(350);
    const m = measure();
    if (m === last) stable++;
    else {
      stable = 0;
      last = m;
    }
  }
  window.scrollTo(0, startY);
  return {
    html: '<!DOCTYPE html>' + document.documentElement.outerHTML,
    url: location.href,
    rows: document.querySelectorAll('#gridItemRoot').length,
  };
}

/**
 * Injected while a sample session runs. Shows a small control in the page and, about once a second, tells the
 * extension where the reader is so it can take a screenshot. Self-contained, like preparePage.
 */
export function sampleLoop(session) {
  if (/** @type {any} */ (window).__bookscoutSample) return;
  const bar = document.createElement('div');
  bar.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#1d1d1b;color:#fff;font:13px system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 2px 10px #0006;display:flex;gap:10px;align-items:center');
  const label = document.createElement('span');
  label.textContent = 'BookScout: open the sample and turn the pages';
  const stop = document.createElement('button');
  stop.textContent = 'Finish';
  stop.setAttribute('style', 'font:inherit;padding:2px 10px;border-radius:5px;border:0;cursor:pointer');
  bar.append(label, stop);
  document.documentElement.appendChild(bar);

  const readerRect = () => {
    const dpr = window.devicePixelRatio || 1;
    let best = null;
    for (const f of document.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      if (r.width < 300 || r.height < 300 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (!/read\.amazon\.com|kindle|reader/i.test(f.src || f.id || '')) continue;
      if (!best || r.width * r.height > best.w * best.h) best = { left: r.left * dpr, top: r.top * dpr, width: r.width * dpr, height: r.height * dpr, w: r.width, h: r.height };
    }
    return best && { left: Math.max(0, best.left), top: Math.max(0, best.top), width: best.width, height: best.height };
  };

  let port = null;
  let timer = /** @type {any} */ (0);
  let done = false;
  const connect = () => {
    port = chrome.runtime.connect({ name: 'bookscout-sample' });
    port.postMessage({ type: 'hello', session });
    port.onMessage.addListener((m) => {
      if (m.type === 'status') label.textContent = m.text;
      if (m.type === 'stopped') end();
    });
    port.onDisconnect.addListener(() => {
      if (!done) setTimeout(connect, 500); // the extension's worker was restarted: reconnect, the session continues
    });
  };
  const end = () => {
    done = true;
    clearInterval(timer);
    bar.remove();
    delete /** @type {any} */ (window).__bookscoutSample;
    try { port && port.disconnect(); } catch { /* already gone */ }
  };
  stop.addEventListener('click', () => { try { port.postMessage({ type: 'finish' }); } catch { /* reconnecting */ } });
  /** @type {any} */ (window).__bookscoutSample = { end };
  connect();
  const note = (event, e) => { try { port.postMessage({ type: 'log', level: 'error', event, detail: String((e && e.message) || e) }); } catch { /* reconnecting */ } };
  timer = setInterval(() => {
    let rect = null;
    try { rect = readerRect(); } catch (e) { note('reader detection failed', e); }
    try { port.postMessage({ type: 'tick', rect }); } catch { /* reconnecting */ }
  }, 900);
}
