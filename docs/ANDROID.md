# Android apps

Cadrel Write and Cadrel Reader each have an Android app. Both are Capacitor apps (the same web UI as the desktop apps, in a phone shell) and **both use one shared native layer**, `packages/android-native`. They are distributed as **APK files on GitHub releases only** (no Play Store) and update themselves from there.

| App | Id | Version | Release it rides on | APK |
|---|---|---|---|---|
| Cadrel Write (`packages/write-mobile`, connected to a Studio) | `com.blaashford.cadrel` | `VERSION` | Cadrel's own, `vX.Y.Z` | `Cadrel-<version>.apk` |
| Cadrel Reader | `com.blaashford.cadrel.reader` | `packages/reader/VERSION` | Reader's own, `reader-vX.Y.Z` | `CadrelReader-<version>.apk` |

The file names are what the in-app updater looks for (`ASSET_PATTERN` in `packages/write/src/shared/update.ts`). A development build `X.Y.Z-dev.N` is attached to the matching pre-release and reports that version.

## There is no checked-in Android project

Capacitor generates it (`cap add android`) and `packages/*/android/` is git-ignored. What is ours lives in `packages/android-native` and is applied to the generated project by one script:

```
node packages/android-native/prepare.mjs write     # or: reader   (add --skip-web to reuse the last web build)
cd packages/write/android && ./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

What `prepare.mjs` does, in order: generate the project if there is none, build the web bundle (`build:mobile`), `cap sync`, copy in the plugins, then patch `MainActivity` (registers the plugins), `AndroidManifest.xml` (the app's link scheme and the permission to open Android's installer), `app/build.gradle` (version, signing, Google sign-in), and replace the launcher icons with the app's own (`packages/<app>/build/android-res`). Every patch is idempotent and fails loudly if Capacitor's template stops looking the way it expects (tests: `lib.test.mjs`).

Needs JDK 21 and the Android SDK (platform 36). CI installs both.

### The three plugins (`packages/android-native/java`)

| Plugin | Does | Contract |
|---|---|---|
| `AppUpdate` | Downloads the release's APK, checks it against the release's `SHA256SUMS.txt`, opens Android's installer. Only downloads from this repository's releases, only over https, never installs a file whose checksum is missing or wrong. Rejects with `NEEDS_PERMISSION` (and opens the Settings page) until the person has allowed installs from this app. | `packages/write/src/mobile/appUpdate.ts` |
| `DriveAuth` | Google authorization for the `drive.file` scope, giving the web code an access token for Drive. Cadrel Reader uses it (invitations and comments go through Drive); Cadrel Write does not. | `driveAuth.ts` |
| `ExternalBrowser` | Opens Google's file picker in the phone's browser, which hands the choice back through `cadrel-write://picked?...` / `cadrel-reader://picked?...`. | `externalBrowser.ts` |

## Signing: one key, made once

Android only updates an installed app with a build signed by the **same key**, forever. With no Play Store there is no copy of it anywhere else. **If the key is lost, every installed copy has to be uninstalled and installed again, and the apps' data on the phone goes with it.**

1. Run `scripts/make-android-keystore.sh` on your own computer. It makes `cadrel-release.keystore` and prints the four secrets to create.
2. Store the keystore file and its password **offline and backed up** (a password manager's attachment and a second copy). Never commit it.
3. Create the four repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

Both apps are signed with this one key. The build's log prints the key's SHA-1 so it can be checked against Google Cloud (next section).

**Without the secrets** the build still runs and signs with Android's debug key, and attaches the APK as `…-android-apk-debug` to the run. That is for trying a build on a phone; it is **never published**, and an app signed with the debug key cannot later be updated to a release-signed one. With the secrets present, a missing or wrong key fails the build instead of falling back (`CADREL_REQUIRE_RELEASE_KEY`).

## Google sign-in for Drive

**Only Cadrel Reader signs in to Google** (Cadrel Write talks to the Studio, not Drive). For Reader, Google needs to know the app: in the Google Cloud project that has the Drive API enabled (the one the desktop apps' OAuth client belongs to), create an **OAuth client ID of type Android** for `com.blaashford.cadrel.reader`, with the **SHA-1** printed by `make-android-keystore.sh` (or by the build's log). The `drive.file` scope must be on the consent screen. Until this is done Reader installs and runs, but *Connect Google Drive* fails with a sign-in error. Cadrel Write needs nothing from Google. A build signed with the debug key has a different SHA-1 and will not work with the release key's client.

## CI and releases

`.github/workflows/build.yml` has an `android` job for each app. It builds the APK, then checks it: signature valid, the package, version name and version code are the ones expected, there is a launcher activity, it can open Android's installer, and all three plugins are in the dex. It does not yet install the APK on an emulator.

`release.yml` attaches the APK to the same release as the Windows installer (`Cadrel-<version>.apk` to Cadrel's, `CadrelReader-<version>.apk` to Reader's), adds it to `SHA256SUMS.txt` and adds an Android section to the release notes. If the job only had the debug key, there is no APK to attach and the release is made without one.

### Version codes

Android needs a number that rises with every install: `versionCode` is `((MAJOR*1000 + MINOR)*100 + FIX)*1000 + BUILD`, where BUILD is the `-dev.N` number (up to 998) and 999 for a release. So 0.10.0 is `1000999`, and a release is above its own development builds and below the next version's. Limits: major 20, minor 999, fix 99.

## Cadrel Write is the Studio app

`packages/write-mobile` is the phone app that signs in to a Cadrel Studio ([its README](../packages/write-mobile/README.md)). The older Drive-based phone entry that lives in `packages/write/src/mobile` (and `capacitor.config.ts` there) is no longer built or released; Cadrel Reader still imports its storage, dialogs and plugin wrappers from there. Invitation links open the app through the `cadrel://` scheme.

## Not done

- A smoke test that installs the APK on an emulator and opens it. The checks above catch a wrong package, version or missing plugin, not a crash on start.
- Nothing here has been built on a machine with the Android SDK yet: the first CI run is the first real build of the Java plugins. Expect to fix compile errors there.
