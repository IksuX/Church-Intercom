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
