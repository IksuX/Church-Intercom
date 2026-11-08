#!/usr/bin/env bash
# Uzupełnia Info.plist aplikacji iOS: dźwięk w tle, opisy uprawnień. Bezpieczne do wielokrotnego uruchamiania.
set -euo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)/ios/App/App/Info.plist"
[ -f "$P" ] || { echo "Brak $P – najpierw: npx cap add ios"; exit 1; }
PB=/usr/libexec/PlistBuddy
set_str() { $PB -c "Set :$1 $2" "$P" 2>/dev/null || $PB -c "Add :$1 string $2" "$P"; }
set_str NSMicrophoneUsageDescription "Interkom potrzebuje mikrofonu, żeby można było mówić do zespołu."
set_str NSBluetoothAlwaysUsageDescription "Interkom obsługuje słuchawki i przyciski PTT Bluetooth."
$PB -c "Print :UIBackgroundModes" "$P" >/dev/null 2>&1 || $PB -c "Add :UIBackgroundModes array" "$P"
$PB -c "Print :UIBackgroundModes" "$P" | grep -q "audio" || $PB -c "Add :UIBackgroundModes: string audio" "$P"
set_str NSLocalNetworkUsageDescription "Interkom szuka serwerów interkomu w sieci Wi-Fi kościoła."
$PB -c "Print :NSBonjourServices" "$P" >/dev/null 2>&1 || $PB -c "Add :NSBonjourServices array" "$P"
$PB -c "Print :NSBonjourServices" "$P" | grep -q "_interkom._tcp" || $PB -c "Add :NSBonjourServices: string _interkom._tcp" "$P"
$PB -c "Print :NSAppTransportSecurity" "$P" >/dev/null 2>&1 || $PB -c "Add :NSAppTransportSecurity dict" "$P"
$PB -c "Set :NSAppTransportSecurity:NSAllowsLocalNetworking true" "$P" 2>/dev/null || $PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$P"
echo "Info.plist gotowy: $P"
