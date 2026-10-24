#!/usr/bin/env node
// Throwaway spike: do two OAuth clients in one Google Cloud project share `drive.file` visibility?
// Node 18+, no dependencies. See README.md. Tokens are kept in ./tokens/<name>.json (git-ignored).
import fs from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const [, , cmd, name, ...rest] = process.argv;
const clients = JSON.parse(fs.readFileSync(new URL('./clients.json', import.meta.url), 'utf8'));
const tokenFile = n => new URL(`./tokens/${n}.json`, import.meta.url);
const form = o => new URLSearchParams(o).toString();
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) })).json();

async function login(n) {
  const c = clients[n];
  if (!c) throw new Error(`no client "${n}" in clients.json`);
  const dc = await post('https://oauth2.googleapis.com/device/code', { client_id: c.client_id, scope: SCOPE });
  if (!dc.device_code) throw new Error(JSON.stringify(dc));
  console.log(`\n[${n}] Open ${dc.verification_url} and enter code: ${dc.user_code}\n`);
  for (;;) {
    await new Promise(r => setTimeout(r, (dc.interval ?? 5) * 1000));
    const t = await post('https://oauth2.googleapis.com/token', { client_id: c.client_id, client_secret: c.client_secret, device_code: dc.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (t.access_token) { fs.mkdirSync(new URL('./tokens/', import.meta.url), { recursive: true }); fs.writeFileSync(tokenFile(n), JSON.stringify(t)); console.log(`[${n}] signed in`); return; }
    if (t.error !== 'authorization_pending' && t.error !== 'slow_down') throw new Error(JSON.stringify(t));
  }
}

async function api(n, path, init = {}) {
  const c = clients[n];
  let t = JSON.parse(fs.readFileSync(tokenFile(n), 'utf8'));
  const call = tok => fetch(`https://www.googleapis.com/${path}`, { ...init, headers: { authorization: `Bearer ${tok}`, ...(init.headers ?? {}) } });
  let r = await call(t.access_token);
  if (r.status === 401 && t.refresh_token) {
    const nt = await post('https://oauth2.googleapis.com/token', { client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
    t = { ...t, ...nt }; fs.writeFileSync(tokenFile(n), JSON.stringify(t)); r = await call(t.access_token);
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const FIELDS = 'id,name,mimeType,md5Checksum,headRevisionId,parents,modifiedTime';
const J = { 'content-type': 'application/json' };

const cmds = {
  login: () => login(name),
  // Creates folder "MDEdit-spike" with a file inside, as client <name>.
  async create() {
    const f = await api(name, 'drive/v3/files?fields=' + FIELDS, { method: 'POST', headers: J, body: JSON.stringify({ name: 'MDEdit-spike', mimeType: 'application/vnd.google-apps.folder' }) });
    const boundary = 'b' + Date.now();
    const body = `--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name: 'chapter1.md', parents: [f.id] })}\r\n--${boundary}\r\ncontent-type: text/markdown\r\n\r\n# Chapter 1\r\nhello from ${name}\r\n--${boundary}--`;
    const file = await api(name, 'upload/drive/v3/files?uploadType=multipart&fields=' + FIELDS, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
    console.log('folder', f, '\nfile', file);
  },
  // TEST 1: can client <name> see what another client created?
  async list() {
    const r = await api(name, 'drive/v3/files?fields=files(' + FIELDS + ')&q=' + encodeURIComponent("trashed=false"));
    console.log(`[${name}] sees ${r.files.length} item(s):`); for (const f of r.files) console.log(' ', f.name, f.id, f.md5Checksum ?? '');
  },
  // TEST 2: change list token, then rename + edit by another client, then poll changes.
  async token() { const r = await api(name, 'drive/v3/changes/startPageToken'); console.log(r.startPageToken); },
  async changes() { const r = await api(name, `drive/v3/changes?pageToken=${rest[0]}&fields=newStartPageToken,changes(fileId,removed,file(${FIELDS}))`); console.log(JSON.stringify(r, null, 2)); },
  // TEST 3: can client <name> update a file made by another client?
  async update() {
    const id = rest[0];
    const r = await api(name, `upload/drive/v3/files/${id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', headers: { 'content-type': 'text/markdown' }, body: `# Chapter 1\r\nedited by ${name}\r\n` });
    console.log(r);
  },
  async rename() { console.log(await api(name, `drive/v3/files/${rest[0]}?fields=${FIELDS}`, { method: 'PATCH', headers: J, body: JSON.stringify({ name: rest[1] }) })); },
  async revisions() { console.log(await api(name, `drive/v3/files/${rest[0]}/revisions`)); },
};
if (!cmds[cmd]) { console.log('usage: node spike.mjs <login|create|list|token|changes|update|rename|revisions> <clientName> [args]'); process.exit(1); }
await cmds[cmd]().catch(e => { console.error(e.message); process.exit(1); });
