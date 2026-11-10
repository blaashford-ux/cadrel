import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Its own id, so Cadrel Reader installs beside the Cadrel apps instead of replacing them.
  appId: 'com.blaashford.cadrel.reader',
  appName: 'Cadrel Reader',
  webDir: 'dist-mobile',
  server: {
    androidScheme: 'https',
    // Anything the app loads from a host not listed here is handed to the phone's browser instead of staying in the page.
    allowNavigation: ['accounts.google.com']
  },
  android: { allowMixedContent: false },
  // fetch() goes through the native HTTP stack (no browser CORS rules), which is what the Google Drive calls want.
  plugins: { CapacitorHttp: { enabled: true } }
};

export default config;
