import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.blaashford.mdedit',
  appName: 'MDEdit',
  webDir: 'dist-mobile',
  server: {
    androidScheme: 'https',
    // Anything the app loads from a host not listed here is handed to the phone's browser instead of staying in the page. The review
    // invitation flow embeds the invitation page (GitHub Pages), which embeds Google's file picker; if either leaves the app, Google
    // opens the picker alone in Chrome and rejects its API key ("The API developer key is invalid"). Keep in step with JOIN_PAGE.
    allowNavigation: ['blaashford-ux.github.io', 'docs.google.com', 'apis.google.com', 'accounts.google.com', 'content.googleapis.com'],
  },
  android: { allowMixedContent: false },
  // fetch() goes through the native HTTP stack (no browser CORS rules), which is what the Google Drive calls want.
  plugins: { CapacitorHttp: { enabled: true } },
};

export default config;
