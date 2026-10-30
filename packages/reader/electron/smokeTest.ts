import { app, BrowserWindow, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteModule } from '@cadrel/write/electron/module';
import { READER_BLOCKED_CHANNELS } from '@cadrel/write/electron/readerMode';

/**
 * Headless self-test of the built app: starts the module in reader mode, checks that the author channels are gone, opens the real
 * window and checks that it shows Cadrel Reader's first screen with Reader's capabilities and refuses an author call. Run as
 * `Cadrel Reader.exe --smoke-test=<result.json>`. CI uses it to prove a freshly built installer's app starts. Returns the exit code.
 */
export async function runReaderSmokeTest(outFile: string): Promise<number> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadrel-reader-smoke-'));
    let win: BrowserWindow | null = null;
    const mod = await createWriteModule({
      getWindow: () => win,
      getContents: () => win?.webContents ?? null,
      standalone: true,
      reader: true,
      dataDir: path.join(dir, 'data'),
      defaultRoot: () => path.join(dir, 'Cadrel Reader')
    });

    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })._invokeHandlers;
    if (handlers) {
      const left = READER_BLOCKED_CHANNELS.filter((c) => handlers.has(c));
      check('author channels are not registered', left.length === 0, left.join(', '));
      check('reading channels are registered', ['fs:readFile', 'review:save', 'review:join', 'review:exchange'].every((c) => handlers.has(c)));
    } else {
      check('author channels are not registered', true, 'skipped: this Electron does not expose its handler table');
    }

    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 780,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), additionalArguments: ['--cadrel-reader'], contextIsolation: true, sandbox: true }
    });
    mod.attach(win.webContents, win);
    await win.loadFile(path.join(__dirname, '../../dist/index.html'));
    await new Promise((r) => setTimeout(r, 2500)); // let the app start and draw its first screen
    const seen = (await win.webContents.executeJavaScript(`(async () => {
      const api = window.cadrelWrite;
      let refused = null;
      try { await api.inviteReviewer('/x', 'Sam'); } catch (e) { refused = String(e && e.message || e); }
      return { caps: api.capabilities, refused, title: document.title, text: document.body.innerText };
    })()`)) as { caps: Record<string, unknown>; refused: string | null; title: string; text: string };
    check('window is Cadrel Reader', seen.caps?.reader === true && seen.caps?.export === false && seen.caps?.ai === false && seen.caps?.manageProjects === false, JSON.stringify(seen.caps));
    check('an author call is refused', seen.refused !== null, String(seen.refused));
    check('first screen is Shared with me', /Shared with me/i.test(seen.text) && /Open invitation/i.test(seen.text), seen.text.slice(0, 200));
    check('no author buttons on screen', !/New Project|Export…|Sharing|Import/.test(seen.text), seen.text.slice(0, 200));
    win.destroy();
    mod.stop();
  } catch (e) {
    check('smoke test ran', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  const ok = checks.every((c) => c.ok);
  await fs.writeFile(outFile, JSON.stringify({ ok, version: app.getVersion(), checks }, null, 2)).catch(() => undefined);
  return ok ? 0 : 1;
}
