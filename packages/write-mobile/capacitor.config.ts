import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // The id Cadrel Write has always had; Cadrel Reader has its own, so both install on one phone.
  appId: 'com.blaashford.cadrel',
  appName: 'Cadrel Write',
  webDir: 'dist-mobile',
  server: { androidScheme: 'https' },
  android: { allowMixedContent: false },
  // fetch() goes through the native HTTP stack (no browser CORS rules), which is what the Studio's server and GitHub want.
  plugins: { CapacitorHttp: { enabled: true } }
};

export default config;
