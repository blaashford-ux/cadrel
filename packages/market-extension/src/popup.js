import { DEFAULT_PORT } from './lib.js';

const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
const status = (text, ok) => {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'bad';
};

const stored = await chrome.storage.local.get(['token', 'port']);
$('token').value = stored.token ?? '';
$('port').value = String(stored.port || DEFAULT_PORT);

$('pair').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'pair', code: $('code').value, port: Number($('port').value) || DEFAULT_PORT });
  status(r.ok ? 'Paired with BookScout' : r.error, r.ok);
  if (r.ok) {
    $('code').value = '';
    const t = await chrome.storage.local.get(['token']);
    $('token').value = t.token ?? '';
  }
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: $('token').value.trim(), port: Number($('port').value) || DEFAULT_PORT });
  const r = await chrome.runtime.sendMessage({ type: 'ping' });
  status(r.ok ? 'Connected to BookScout' : r.error, r.ok);
});

$('send').addEventListener('click', async () => {
  status('Capturing…', true);
  const r = await chrome.runtime.sendMessage({ type: 'capture-active' });
  status(r.ok ? `Saved ${r.kind === 'list' ? 'list' : r.kind === 'search' ? `search "${r.query}"` : r.asin}` : r.error, r.ok);
});

for (const [id, type] of [['sample-start', 'sample-start'], ['sample-now', 'sample-now'], ['sample-finish', 'sample-finish']]) {
  $(id).addEventListener('click', async () => {
    status('Working…', true);
    const r = await chrome.runtime.sendMessage({ type });
    status(r.ok ? (type === 'sample-start' ? 'Open the sample and turn the pages. Each page is saved when it settles.' : type === 'sample-finish' ? `Sent ${r.pages ?? 0} page(s) to BookScout` : 'Saved') : r.error, r.ok);
  });
}
