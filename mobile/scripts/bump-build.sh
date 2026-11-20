#!/usr/bin/env bash
# Podnosi numer kompilacji (iOS: CFBundleVersion / CURRENT_PROJECT_VERSION, Android: versionCode) o 1.
# Uruchamiaj przed każdym archiwum wysyłanym do TestFlight / każdym nowym APK. Numer jest w pliku build-number
# (w repozytorium – kolejne kompilacje z różnych komputerów nie powtórzą numeru).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/build-number"
N=$(( $(tr -dc '0-9' < "$F" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$F"
echo "Numer kompilacji: $N (wersja $(node -p "require('$ROOT/package.json').version"))"
[ -d "$ROOT/ios" ] && bash "$ROOT/scripts/ios-setup.sh" >/dev/null && echo "iOS: zaktualizowano"
[ -d "$ROOT/android" ] && bash "$ROOT/scripts/android-setup.sh" >/dev/null && echo "Android: zaktualizowano"
exit 0
