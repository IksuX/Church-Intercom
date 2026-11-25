#!/usr/bin/env bash
# Buduje podpisany plik APK do wgrania w panelu: mobile/build/Interkom-<wersja>-<kompilacja>.apk
# Klucz: scripts/android-key.sh (raz). Przed nową wersją podnieś numer: npm run bump-build
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/android-env.sh"
[ -f "$IK_KEYSTORE" ] || { echo "Brak klucza $IK_KEYSTORE – najpierw: npm run android-key"; exit 1; }
[ -d "$ROOT/android" ] || { echo "Brak folderu android – najpierw: npx cap add android"; exit 1; }
if [ -z "${IK_KS_PASS:-}" ]; then
  IK_KS_PASS="$(security find-generic-password -a interkom -s interkom-android-key -w 2>/dev/null || true)"
  if [ -z "$IK_KS_PASS" ]; then read -r -s -p "Hasło do klucza: " IK_KS_PASS; echo; fi
fi
export IK_KS_PASS
"$JAVA_HOME/bin/keytool" -list -keystore "$IK_KEYSTORE" -alias interkom -storepass:env IK_KS_PASS >/dev/null 2>&1 || { echo "Nieprawidłowe hasło do klucza."; exit 1; }
cd "$ROOT"
npx cap sync android >/dev/null
bash scripts/android-setup.sh >/dev/null
# bez demona Gradle – hasło nie zostaje w pamięci procesu po zakończeniu
(cd android && ./gradlew -q --no-daemon assembleRelease)
VERSION=$(node -p "require('$ROOT/package.json').version"); BUILD=$(tr -dc '0-9' < "$ROOT/build-number")
SRC="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$SRC" ] || { echo "Nie powstał podpisany plik APK."; exit 1; }
SDK="${ANDROID_HOME:-$(sed -n 's/^sdk\.dir=//p' android/local.properties 2>/dev/null)}"; SDK="${SDK:-$HOME/Library/Android/sdk}"
SIGNER="$(ls "$SDK"/build-tools/*/apksigner 2>/dev/null | tail -1)"
[ -n "$SIGNER" ] || { echo "Nie znaleziono apksigner w $SDK/build-tools"; exit 1; }
CERT="$("$SIGNER" verify --print-certs "$SRC")"
echo "$CERT" | grep -q 'CN=Android Debug' && { echo "Plik podpisany kluczem testowym – nie używaj go."; exit 1; }
mkdir -p build
OUT="$ROOT/build/Interkom-$VERSION-$BUILD.apk"
cp "$SRC" "$OUT"
echo "Podpisany APK: $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
echo "$CERT" | grep -m1 'SHA-256' || true
echo "Wgraj go w panelu: Ogólne → Aplikacja na telefon → Wgraj plik APK (na każdym serwerze osobno)."
