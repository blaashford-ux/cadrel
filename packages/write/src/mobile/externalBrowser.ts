import { App as CapacitorApp } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';

interface ExternalBrowserPlugin {
  /** Opens MDEdit's invitation page in the phone's browser (android/.../ExternalBrowserPlugin.java). */
  open(opts: { url: string }): Promise<void>;
}

const ExternalBrowser = registerPlugin<ExternalBrowserPlugin>('ExternalBrowser');

/** Reads the file ids from an `mdedit://picked?...` link: the ids, an empty list when cancelled, null when it isn't such a link. */
export function parsePickedLink(url: string): string[] | null {
  const m = /^mdedit:\/\/picked\/?\?(.*)$/i.exec(url);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  return (q.get('ids') ?? '').split(',').filter((s) => /^[A-Za-z0-9_-]{2,128}$/.test(s));
}

/** Runs Google's file picker in the browser and waits for the app to be reopened by its mdedit://picked link. */
export async function pickInBrowser(url: string): Promise<string[] | null> {
  return new Promise<string[] | null>((resolve, reject) => {
    const handle = CapacitorApp.addListener('appUrlOpen', (e) => {
      const ids = parsePickedLink(e.url);
      if (!ids) return;
      void handle.then((h) => h.remove());
      resolve(ids.length ? ids : null);
    });
    ExternalBrowser.open({ url }).catch((err) => {
      void handle.then((h) => h.remove());
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
