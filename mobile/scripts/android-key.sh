#!/usr/bin/env bash
# Tworzy (raz) klucz, którym podpisujesz aplikację Android. Klucz i hasło zostają poza repozytorium:
#   ~/.interkom/interkom-release.jks – plik klucza, hasło – w Pęku kluczy macOS (wpis „interkom-android-key”).
# Zrób kopię obu: bez nich nie wydasz aktualizacji, którą telefony zainstalują na istniejącą aplikację.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/android-env.sh"
[ ! -e "$IK_KEYSTORE" ] || { echo "Klucz już istnieje: $IK_KEYSTORE – nie nadpisuję (nowy klucz = każdy musi odinstalować aplikację)."; exit 1; }
[ -t 0 ] || { echo "Uruchom w Terminalu – skrypt pyta o hasło."; exit 1; }
echo "Hasło do klucza aplikacji: co najmniej 8 znaków, bez polskich liter, cudzysłowu i ukośnika \\."
echo "Nie chcesz wymyślać? Naciśnij sam Enter – skrypt wylosuje hasło i zapisze je w Pęku kluczy."
while :; do
  read -r -s -p "Hasło (nic nie widać w trakcie wpisywania): " P; echo
  if [ -z "$P" ]; then P="$(openssl rand -hex 16)"; GEN=1; break; fi
  if [ "${#P}" -lt 8 ] || [ "${#P}" -gt 64 ]; then echo "→ Hasło musi mieć od 8 do 64 znaków. Spróbuj jeszcze raz."; continue; fi
  if printf '%s' "$P" | LC_ALL=C grep -q '[^ -~]'; then echo "→ W haśle jest polska litera albo inny znak spoza klawiatury angielskiej. Spróbuj jeszcze raz."; continue; fi
  case "$P" in *\"*|*\\*) echo "→ Hasło nie może zawierać cudzysłowu ani ukośnika \\. Spróbuj jeszcze raz."; continue;; esac
  read -r -s -p "Powtórz hasło: " P2; echo
  [ "$P" = "$P2" ] && break
  echo "→ Hasła są różne. Spróbuj jeszcze raz."
done
mkdir -p "$(dirname "$IK_KEYSTORE")"; chmod 700 "$(dirname "$IK_KEYSTORE")"
export IK_KS_PASS="$P"
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$IK_KEYSTORE" -storetype PKCS12 -alias interkom -keyalg RSA -keysize 4096 -validity 12000 \
  -dname "CN=Interkom" -storepass:env IK_KS_PASS -keypass:env IK_KS_PASS
chmod 600 "$IK_KEYSTORE"
# przez wejście standardowe – hasła nie widać na liście procesów
printf 'add-generic-password -U -a interkom -s interkom-android-key -w "%s"\n' "$P" | security -i >/dev/null 2>&1 || true
if [ "$(security find-generic-password -a interkom -s interkom-android-key -w 2>/dev/null)" = "$P" ]; then
  echo "Hasło zapisane w Pęku kluczy macOS (interkom-android-key)."
elif [ -n "${GEN:-}" ]; then # wylosowanego hasła nikt nie zna – taki klucz byłby bezużyteczny
  rm -f "$IK_KEYSTORE"
  echo "Nie udało się zapisać wylosowanego hasła w Pęku kluczy – klucz nie powstał. Uruchom ponownie i wpisz własne hasło."; exit 1
else
  echo "UWAGA: hasła nie udało się zapisać w Pęku kluczy – „npm run apk” o nie zapyta."
fi
[ -z "${GEN:-}" ] || echo "Wylosowane hasło zobaczysz w aplikacji Dostęp do pęku kluczy: wpis „interkom-android-key” → Pokaż hasło."
echo "Gotowe: $IK_KEYSTORE"
echo "Zrób teraz kopię tego pliku i hasła w bezpiecznym miejscu (menedżer haseł, dysk). Potem: npm run apk"
