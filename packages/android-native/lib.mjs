// Pure text patches that turn a freshly generated Capacitor Android project into Cadrel's app. Each one is idempotent (running it twice
// changes nothing the second time) and throws if the Capacitor template no longer looks the way it expects, so an upgrade of Capacitor
// fails the build loudly instead of producing an app with a plugin missing.

export const PLUGIN_PACKAGE = 'com.blaashford.cadrel.nativeplugins';
export const PLUGINS = ['AppUpdatePlugin', 'DriveAuthPlugin', 'ExternalBrowserPlugin'];
export const PLAY_SERVICES_AUTH = 'com.google.android.gms:play-services-auth:21.4.0';

/**
 * Where each app comes from. `apk` is the file name the in-app updater looks for in the release (`ASSET_PATTERN` in
 * packages/write/src/shared/update.ts): Cadrel Write's APK rides on Cadrel's own releases, Reader's on its `reader-v` ones.
 */
export const APPS = {
  write: { dir: 'packages/write', versionFile: 'VERSION', schemes: ['cadrel-write'], apk: (v) => `Cadrel-${v}.apk` },
  reader: { dir: 'packages/reader', versionFile: 'packages/reader/VERSION', schemes: ['cadrel-reader'], apk: (v) => `CadrelReader-${v}.apk` }
};

/**
 * Android only needs `versionCode` to rise from one install to the next. It is MAJOR (up to 20), MINOR (3 digits), FIX (2 digits) and a
 * 3-digit build: a development build `-dev.N` is N (up to 998) and a release is 999, so a release is above its own development builds and
 * below the next version's. 0.10.0 is 1000999. The largest, 20.999.99, is 2099999999: under Android's limit of 2100000000.
 */
export function versionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(version);
  if (!m) throw new Error(`"${version}" is not MAJOR.MINOR.FIX or MAJOR.MINOR.FIX-dev.N`);
  const [major, minor, fix] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major > 20 || minor > 999 || fix > 99) throw new Error(`"${version}" is too large for an Android version code`);
  if (m[4] !== undefined && Number(m[4]) > 998) throw new Error(`Development build number ${m[4]} is too large (the limit is 998); raise the version instead`);
  const build = m[4] === undefined ? 999 : Number(m[4]);
  return ((major * 1000 + minor) * 100 + fix) * 1000 + build;
}

const need = (text, anchor, what) => {
  if (!text.includes(anchor)) throw new Error(`The generated Android project has changed: could not find ${what}.`);
};

/** MainActivity registers the plugins before the bridge starts (Capacitor loads them while the activity is created). */
export function patchMainActivity(src) {
  if (src.includes('registerPlugin(AppUpdatePlugin.class)')) return src;
  need(src, 'public class MainActivity extends BridgeActivity {}', 'the empty MainActivity');
  const imports = [...PLUGINS.map((p) => `import ${PLUGIN_PACKAGE}.${p};`), 'import android.os.Bundle;'].join('\n');
  const body = `public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
${PLUGINS.map((p) => `        registerPlugin(${p}.class);`).join('\n')}
        super.onCreate(savedInstanceState);
    }
}`;
  return src.replace('import com.getcapacitor.BridgeActivity;', `import com.getcapacitor.BridgeActivity;\n${imports}`).replace('public class MainActivity extends BridgeActivity {}', body);
}

/** The app's own link schemes (the picker's hand-back, invitations) and the permission to open Android's installer for updates. */
export function patchManifest(src, schemes) {
  let out = src;
  if (!out.includes('REQUEST_INSTALL_PACKAGES')) {
    const anchor = '<uses-permission android:name="android.permission.INTERNET" />';
    need(out, anchor, 'the INTERNET permission');
    out = out.replace(anchor, `${anchor}\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`);
  }
  for (const scheme of schemes) {
    if (out.includes(`android:scheme="${scheme}"`)) continue;
    const close = '            </intent-filter>\n';
    need(out, close, 'the launcher intent filter');
    const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${scheme}" />
            </intent-filter>
`;
    out = out.replace(close, close + filter);
  }
  return out;
}

/**
 * Version, signing and Google sign-in for the app module. Signing reads the key from the environment (CADREL_KEYSTORE_FILE, _PASSWORD,
 * CADREL_KEY_ALIAS, CADREL_KEY_PASSWORD) so no secret is ever written to a file. Without a key the build is signed with Android's debug key,
 * which is fine for trying it on a phone but never for a release: set CADREL_REQUIRE_RELEASE_KEY=1 (the publishing job does) and a build
 * without the real key fails instead.
 */
export function patchAppGradle(src, { versionName, versionCode: code }) {
  let out = src;
  if (!/versionCode \d+\n/.test(out) || !/versionName "[^"]*"/.test(out)) throw new Error('The generated Android project has changed: could not find versionCode / versionName.');
  out = out.replace(/versionCode \d+\n/, `versionCode ${code}\n`).replace(/versionName "[^"]*"/, `versionName "${versionName}"`);

  if (!out.includes('CADREL_KEYSTORE_FILE')) {
    const anchor = '    buildTypes {';
    need(out, anchor, 'buildTypes');
    out = out.replace(
      anchor,
      `    signingConfigs {
        release {
            def keystore = System.getenv('CADREL_KEYSTORE_FILE')
            if (keystore) {
                storeFile file(keystore)
                storePassword System.getenv('CADREL_KEYSTORE_PASSWORD')
                keyAlias System.getenv('CADREL_KEY_ALIAS')
                keyPassword System.getenv('CADREL_KEY_PASSWORD')
            } else if (System.getenv('CADREL_REQUIRE_RELEASE_KEY')) {
                throw new GradleException('CADREL_REQUIRE_RELEASE_KEY is set but CADREL_KEYSTORE_FILE is not: refusing to sign a release with the debug key.')
            }
        }
    }
${anchor}`
    );
    const release = 'minifyEnabled false';
    need(out, release, 'the release build type');
    out = out.replace(release, `${release}\n            signingConfig signingConfigs.release.storeFile != null ? signingConfigs.release : signingConfigs.debug`);
  }

  if (!out.includes(PLAY_SERVICES_AUTH)) {
    const anchor = "    implementation project(':capacitor-android')";
    need(out, anchor, 'the capacitor-android dependency');
    out = out.replace(anchor, `${anchor}\n    implementation "${PLAY_SERVICES_AUTH}"`);
  }
  return out;
}
