import { registerPlugin } from '@capacitor/core';

interface DriveAuthPlugin {
  /** A fresh access token for Drive's `drive.file` scope. The first call shows Google's account and consent screens. */
  authorize(): Promise<{ accessToken: string }>;
}

/** Native Google sign-in (android/.../DriveAuthPlugin.java). Only exists inside the Android app. */
export const DriveAuth = registerPlugin<DriveAuthPlugin>('DriveAuth');
