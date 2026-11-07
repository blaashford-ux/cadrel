#!/usr/bin/env bash
# Makes the Android release key ONCE and prints the four GitHub secrets to create from it (docs/ANDROID.md).
#   scripts/make-android-keystore.sh [output-dir]      (default: the current directory; needs `keytool`, which comes with any JDK)
# Keep cadrel-release.keystore and its password somewhere safe and offline: Android will only update an installed app with a build signed by
# the SAME key, so if this key is lost, everyone has to uninstall and reinstall. Never commit it.
set -euo pipefail
out="${1:-.}"; ks="$out/cadrel-release.keystore"; alias="cadrel"
[ -e "$ks" ] && { echo "$ks already exists; refusing to replace a release key." >&2; exit 1; }
read -r -s -p "Choose a password for the key (at least 8 characters): " pw; echo
[ "${#pw}" -ge 8 ] || { echo "Too short." >&2; exit 1; }
keytool -genkeypair -v -keystore "$ks" -alias "$alias" -keyalg RSA -keysize 4096 -validity 10950 \
  -storepass "$pw" -keypass "$pw" -dname "CN=Cadrel, O=blaashford-ux"
echo
echo "Made $ks (valid about 30 years). Create these four repository secrets (Settings -> Secrets and variables -> Actions):"
echo "  ANDROID_KEYSTORE_BASE64    the output of:  base64 -w0 \"$ks\""
echo "  ANDROID_KEYSTORE_PASSWORD  the password you just chose"
echo "  ANDROID_KEY_ALIAS          $alias"
echo "  ANDROID_KEY_PASSWORD       the same password"
echo
echo "Register this SHA-1 with the Android OAuth client for Google Drive sign-in (docs/ANDROID.md):"
keytool -list -v -keystore "$ks" -alias "$alias" -storepass "$pw" | grep -E "SHA1|SHA256"
