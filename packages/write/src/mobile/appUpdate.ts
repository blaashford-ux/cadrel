import { registerPlugin } from '@capacitor/core';

interface AppUpdatePlugin {
  /** Downloads the APK, verifies it and opens Android's installer. Rejects with code NEEDS_PERMISSION the first time. */
  install(opts: { url: string; name: string; sumsUrl: string | null }): Promise<void>;
  addListener(event: 'progress', cb: (p: { received: number; total: number }) => void): Promise<{ remove(): Promise<void> }>;
}

/** Updating from GitHub releases (android/.../AppUpdatePlugin.java). Only exists inside the Android app. */
export const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate');
