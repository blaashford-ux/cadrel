import { describe, expect, it } from 'vitest';
import { PLAY_SERVICES_AUTH, patchAppGradle, patchMainActivity, patchManifest, versionCode } from './lib.mjs';

const mainActivity = `package com.blaashford.cadrel.reader;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;
const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <activity android:name=".MainActivity">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
            </intent-filter>

        </activity>
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`;
const gradle = `android {
    defaultConfig {
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
        }
    }
}
dependencies {
    implementation project(':capacitor-android')
}`;

describe('versionCode', () => {
  it('rises with the version, and a release is above its own development builds', () => {
    expect(versionCode('0.10.0')).toBe(1_000_999);
    expect(versionCode('0.10.0-dev.17')).toBe(1_000_017);
    expect(versionCode('0.10.0-dev.998')).toBeLessThan(versionCode('0.10.0'));
    expect(versionCode('0.10.1-dev.1')).toBeGreaterThan(versionCode('0.10.0'));
    expect(versionCode('1.0.0-dev.1')).toBeGreaterThan(versionCode('0.999.99'));
  });
  it('refuses what cannot be a version', () => {
    expect(() => versionCode('v0.10.0')).toThrow();
    expect(() => versionCode('0.10.0-beta.1')).toThrow();
    expect(() => versionCode('0.10.0-dev.999')).toThrow(/too large/);
    expect(() => versionCode('0.1000.0')).toThrow(/too large/);
    expect(() => versionCode('0.1.100')).toThrow(/too large/);
    expect(versionCode('20.999.99')).toBeLessThan(2_100_000_000);
  });
});

describe('patchMainActivity', () => {
  it('registers the three plugins before the bridge starts, once', () => {
    const out = patchMainActivity(mainActivity);
    for (const p of ['AppUpdatePlugin', 'DriveAuthPlugin', 'ExternalBrowserPlugin']) {
      expect(out).toContain(`import com.blaashford.cadrel.nativeplugins.${p};`);
      expect(out).toContain(`registerPlugin(${p}.class);`);
    }
    expect(out.indexOf('registerPlugin(AppUpdatePlugin.class)')).toBeLessThan(out.indexOf('super.onCreate'));
    expect(patchMainActivity(out)).toBe(out);
  });
  it('fails if the template changed', () => {
    expect(() => patchMainActivity('public class MainActivity extends Other {}')).toThrow(/changed/);
  });
});

describe('patchManifest', () => {
  it('adds the install permission and one link filter per scheme, once', () => {
    const out = patchManifest(manifest, ['cadrel-reader']);
    expect(out).toContain('REQUEST_INSTALL_PACKAGES');
    expect(out).toContain('<data android:scheme="cadrel-reader" />');
    expect(out).toContain('android.intent.category.BROWSABLE');
    expect(patchManifest(out, ['cadrel-reader'])).toBe(out);
    expect(patchManifest(out, ['cadrel-reader', 'cadrel']).match(/android:scheme=/g)).toHaveLength(2);
  });
  it('fails if the template changed', () => {
    expect(() => patchManifest('<manifest/>', ['x'])).toThrow(/changed/);
  });
});

describe('patchAppGradle', () => {
  const opts = { versionName: '0.10.0', versionCode: 1_000_999 };
  it('sets the version, signing from the environment and Google sign-in, once', () => {
    const out = patchAppGradle(gradle, opts);
    expect(out).toContain('versionCode 1000999\n');
    expect(out).toContain('versionName "0.10.0"');
    expect(out).toContain("System.getenv('CADREL_KEYSTORE_FILE')");
    expect(out).toContain('signingConfig signingConfigs.release.storeFile != null');
    expect(out).toContain(PLAY_SERVICES_AUTH);
    expect(patchAppGradle(out, opts)).toBe(out);
  });
  it('can be run again for a new version', () => {
    const again = patchAppGradle(patchAppGradle(gradle, opts), { versionName: '0.10.1', versionCode: 1_001_999 });
    expect(again).toContain('versionName "0.10.1"');
    expect(again).not.toContain('0.10.0');
  });
  it('never puts a secret in the file', () => {
    expect(patchAppGradle(gradle, opts)).not.toMatch(/storePassword ['"]/);
  });
  it('fails if the template changed', () => {
    expect(() => patchAppGradle('android {}', opts)).toThrow(/changed/);
  });
});
