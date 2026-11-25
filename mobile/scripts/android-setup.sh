#!/usr/bin/env bash
# MainActivity aplikacji Android: przy starcie wczytuje zapamiętany serwer interkomu (albo ekran wyboru serwera).
# Bezpieczne do wielokrotnego uruchamiania.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT/android" ] || { echo "Brak folderu android – najpierw: npx cap add android"; exit 1; }
F=$(find "$ROOT/android/app/src/main/java" -name MainActivity.java | head -1)
[ -n "$F" ] || { echo "Nie znaleziono MainActivity.java"; exit 1; }
PKG=$(grep -m1 '^package ' "$F")
cat > "$F" <<EOF
$PKG

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import pl.interkom.audio.IkServer;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        config = IkServer.config(this); // zapamiętany serwer interkomu; null = ekran wyboru serwera
        super.onCreate(savedInstanceState);
    }
}
EOF
echo "MainActivity gotowa: $F"

# LiveKit dla Androida potrzebuje biblioteki audioswitch z JitPack – projekt aplikacji szuka tylko w Google i Maven Central,
# więc dopisujemy JitPack do repozytoriów w android/build.gradle (bez tego: „Could not resolve com.github.davidliu:audioswitch”).
G="$ROOT/android/build.gradle"
if [ -f "$G" ] && ! grep -q 'jitpack.io' "$G"; then
  perl -pi -e "s|mavenCentral\(\)|mavenCentral()\n        maven { url 'https://jitpack.io' }|" "$G"
  echo "Dodano repozytorium JitPack: $G"
fi

# --- wersja (z package.json) i numer kompilacji (plik build-number → versionCode, podnosi go „npm run bump-build”) ---
VERSION=$(node -p "require('$ROOT/package.json').version")
BUILD=$(tr -dc '0-9' < "$ROOT/build-number"); [ -n "$BUILD" ] || BUILD=1
AG="$ROOT/android/app/build.gradle"
if [ -f "$AG" ]; then
  perl -pi -e "s/versionCode \d+/versionCode $BUILD/; s/versionName \"[^\"]*\"/versionName \"$VERSION\"/" "$AG"
  echo "Wersja $VERSION, versionCode $BUILD"
fi

# --- podpisywanie wersji release kluczem spoza repozytorium (ścieżka i hasło ze środowiska – ustawia je scripts/android-apk.sh) ---
if [ -f "$AG" ] && ! grep -q 'ik-signing' "$AG"; then
  perl -0pi -e 's|(    buildTypes \{\n        release \{\n)|    // ik-signing: bez klucza w środowisku wersja release powstaje niepodpisana\n    signingConfigs {\n        release {\n            if (System.getenv("IK_KEYSTORE")) {\n                storeFile file(System.getenv("IK_KEYSTORE"))\n                storePassword System.getenv("IK_KS_PASS")\n                keyAlias "interkom"\n                keyPassword System.getenv("IK_KS_PASS")\n            }\n        }\n    }\n$1            if (System.getenv("IK_KEYSTORE")) signingConfig signingConfigs.release\n|' "$AG"
  grep -q 'ik-signing' "$AG" && echo "Dodano podpisywanie wersji release" || echo "UWAGA: nie udało się dodać podpisywania do $AG"
fi

# --- ikona i ekran startowy z resources/ (sips – tylko na Macu; na innym systemie zostają dotychczasowe) ---
RES="$ROOT/android/app/src/main/res"
if command -v sips >/dev/null && [ -f "$ROOT/resources/icon.png" ] && [ -d "$RES" ]; then
  for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    dir="$RES/mipmap-${d%%:*}"; px=${d##*:}; fg=$((px * 9 / 4)) # warstwa przednia ikony adaptacyjnej: 108 dp
    [ -d "$dir" ] || continue
    sips -z "$px" "$px" "$ROOT/resources/icon.png" --out "$dir/ic_launcher.png" >/dev/null
    sips -z "$px" "$px" "$ROOT/resources/icon.png" --out "$dir/ic_launcher_round.png" >/dev/null
    sips -z "$fg" "$fg" "$ROOT/resources/icon-foreground.png" --out "$dir/ic_launcher_foreground.png" >/dev/null
  done
  BGX="$RES/values/ic_launcher_background.xml"
  [ -f "$BGX" ] && perl -pi -e 's|<color name="ic_launcher_background">[^<]*</color>|<color name="ic_launcher_background">#0B0D12</color>|' "$BGX"
  # ekran startowy: obraz kwadratowy przycięty do rozmiaru każdego pliku splash.png (bez zniekształceń)
  while IFS= read -r f; do
    w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}'); h=$(sips -g pixelHeight "$f" | awk '/pixelHeight/{print $2}')
    m=$(( w > h ? w : h ))
    sips -z "$m" "$m" "$ROOT/resources/splash.png" --out "$f" >/dev/null && sips -c "$h" "$w" "$f" >/dev/null
  done < <(find "$RES" -name splash.png)
  echo "Ikona i ekran startowy z resources/"
fi

# --- uprawnienia: biblioteka LiveKit deklaruje kamerę i udostępnianie ekranu – interkom ich nie używa, usuwamy je
# z manifestu aplikacji (recenzja sklepu sprawdza, czy każde uprawnienie jest potrzebne) ---
AM="$ROOT/android/app/src/main/AndroidManifest.xml"
if [ -f "$AM" ] && ! grep -q 'ik-unused-permissions' "$AM"; then
  grep -q 'xmlns:tools=' "$AM" || perl -0pi -e 's|<manifest xmlns:android="http://schemas.android.com/apk/res/android"|<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"|' "$AM"
  perl -0pi -e 's|(<application\b)|<!-- ik-unused-permissions: nieużywane uprawnienia z bibliotek -->\n    <uses-permission android:name="android.permission.CAMERA" tools:node="remove" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" tools:node="remove" />\n\n    $1|' "$AM"
  perl -0pi -e 's|(</application>)|    <service android:name="io.livekit.android.room.track.screencapture.ScreenCaptureService" tools:node="remove" />\n    $1|' "$AM"
  echo "Usunięto nieużywane uprawnienia (kamera, udostępnianie ekranu)"
fi
