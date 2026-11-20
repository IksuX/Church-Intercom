#!/usr/bin/env bash
# Przygotowuje projekt iOS (folder ios/ powstaje przez „npx cap add ios” i nie jest w repozytorium):
# Info.plist (dźwięk w tle, opisy uprawnień, szyfrowanie), wersja i numer kompilacji, manifest prywatności,
# ikona i ekran startowy. Bezpieczne do wielokrotnego uruchamiania.
# Podpisywanie (Team) ustawiasz w Xcode – nic z tego nie trafia do repozytorium.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/ios/App/App"
P="$APP/Info.plist"
PBX="$ROOT/ios/App/App.xcodeproj/project.pbxproj"
[ -f "$P" ] || { echo "Brak $P – najpierw: npx cap add ios"; exit 1; }
PB=/usr/libexec/PlistBuddy
set_str() { $PB -c "Set :$1 $2" "$P" 2>/dev/null || $PB -c "Add :$1 string $2" "$P"; }
set_bool() { $PB -c "Set :$1 $2" "$P" 2>/dev/null || $PB -c "Add :$1 bool $2" "$P"; }

# --- opisy uprawnień (tylko te, z których korzystamy) ---
set_str NSMicrophoneUsageDescription "Interkom potrzebuje mikrofonu, żeby można było mówić do zespołu."
set_str NSBluetoothAlwaysUsageDescription "Interkom obsługuje słuchawki i przyciski PTT Bluetooth."
set_str NSLocalNetworkUsageDescription "Interkom szuka serwerów interkomu w sieci Wi-Fi kościoła."
$PB -c "Print :NSBonjourServices" "$P" >/dev/null 2>&1 || $PB -c "Add :NSBonjourServices array" "$P"
$PB -c "Print :NSBonjourServices" "$P" | grep -q "_interkom._tcp" || $PB -c "Add :NSBonjourServices: string _interkom._tcp" "$P"
# uprawnienia, których aplikacja nie używa – recenzja Apple sprawdza, czy każde jest potrzebne
for k in NSCameraUsageDescription NSPhotoLibraryUsageDescription NSPhotoLibraryAddUsageDescription NSLocationWhenInUseUsageDescription \
         NSLocationAlwaysUsageDescription NSLocationAlwaysAndWhenInUseUsageDescription NSContactsUsageDescription NSSpeechRecognitionUsageDescription \
         NSUserTrackingUsageDescription; do
  $PB -c "Delete :$k" "$P" 2>/dev/null && echo "Usunięto nieużywane uprawnienie: $k" || true
done

# --- tryby w tle: tylko „audio” (słuchanie i mówienie przy zablokowanym ekranie) ---
$PB -c "Delete :UIBackgroundModes" "$P" 2>/dev/null || true
$PB -c "Add :UIBackgroundModes array" "$P"
$PB -c "Add :UIBackgroundModes: string audio" "$P"

# --- sieć: HTTPS wszędzie, wyjątek tylko dla sieci lokalnej (serwer w kościele po adresie IP) ---
$PB -c "Print :NSAppTransportSecurity" "$P" >/dev/null 2>&1 || $PB -c "Add :NSAppTransportSecurity dict" "$P"
$PB -c "Set :NSAppTransportSecurity:NSAllowsLocalNetworking true" "$P" 2>/dev/null || $PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$P"

# --- szyfrowanie (export compliance): tylko standardowe szyfrowanie systemu (HTTPS, WebRTC/DTLS w LiveKit) – zwolnione ---
set_bool ITSAppUsesNonExemptEncryption false

# --- wersja (z package.json) i numer kompilacji (plik build-number, podnosi go „npm run bump-build”) ---
VERSION=$(node -p "require('$ROOT/package.json').version")
BUILD=$(tr -dc '0-9' < "$ROOT/build-number")
[ -n "$BUILD" ] || BUILD=1
if [ -f "$PBX" ]; then
  perl -pi -e "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = $VERSION;/g; s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = $BUILD;/g" "$PBX"
fi
set_str CFBundleShortVersionString '$(MARKETING_VERSION)'
set_str CFBundleVersion '$(CURRENT_PROJECT_VERSION)'
echo "Wersja $VERSION, kompilacja $BUILD"

# --- manifest prywatności (PrivacyInfo.xcprivacy) – plik w App/ i wpis w projekcie Xcode (zasoby aplikacji) ---
cp "$ROOT/resources/PrivacyInfo.xcprivacy" "$APP/PrivacyInfo.xcprivacy"
if [ -f "$PBX" ] && ! grep -q "PrivacyInfo.xcprivacy" "$PBX"; then
  REF=1A1C0DE00000000000000001; BLD=1A1C0DE00000000000000002
  perl -0pi -e "s|(/\\* Begin PBXBuildFile section \\*/\\n)|\$1\t\t$BLD /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = $REF /* PrivacyInfo.xcprivacy */; };\\n|" "$PBX"
  perl -0pi -e "s|(/\\* Begin PBXFileReference section \\*/\\n)|\$1\t\t$REF /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = \"<group>\"; };\\n|" "$PBX"
  perl -0pi -e "s|(504EC3131FED79650016851F /\\* Info.plist \\*/,\\n)|\$1\t\t\t\t$REF /* PrivacyInfo.xcprivacy */,\\n|" "$PBX"
  perl -0pi -e "s|(isa = PBXResourcesBuildPhase;\\n\\s*buildActionMask = \\d+;\\n\\s*files = \\(\\n)|\$1\t\t\t\t$BLD /* PrivacyInfo.xcprivacy in Resources */,\\n|" "$PBX"
  grep -q "$BLD /\* PrivacyInfo.xcprivacy in Resources \*/," "$PBX" && echo "Dodano PrivacyInfo.xcprivacy do projektu Xcode" \
    || { echo "UWAGA: nie udało się dodać PrivacyInfo.xcprivacy do projektu – dodaj plik ręcznie w Xcode (App → Add Files)"; }
fi

# --- ikona (1024×1024, bez przezroczystości) i ekran startowy ---
if [ -f "$ROOT/resources/icon.png" ]; then
  cp "$ROOT/resources/icon.png" "$APP/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
  for f in "$APP"/Assets.xcassets/Splash.imageset/splash-2732x2732*.png; do [ -f "$f" ] && cp "$ROOT/resources/splash.png" "$f"; done
  echo "Ikona i ekran startowy z resources/"
fi
echo "Projekt iOS gotowy: $P"
