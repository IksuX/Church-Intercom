#!/usr/bin/env bash
# Aktualizacja interkomu z GitHuba.
#   ./update.sh               – najnowsza wersja
#   ./update.sh 0.44.1        – konkretna wersja (np. powrót do poprzedniej)
#   ./update.sh --check       – tylko sprawdź, czy jest coś nowego
#   ./update.sh --status      – to samo dla panelu administracyjnego (JSON)
#   ./update.sh --no-install  – tylko pobierz program (instalator uruchamia osobno usługa sterowania z panelu)
# Ustawienia (/var/lib/interkom) zostają nietknięte – aktualizowany jest tylko program.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
say()  { echo -e "\033[32m[✓]\033[0m $*"; }
warn() { echo -e "\033[33m[!]\033[0m $*"; }
die()  { echo -e "\033[31m[x]\033[0m $*" >&2; exit 1; }
jstr() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/ }; printf '"%s"' "$s"; }

MODE="" WANT=""
for a in "$@"; do
  case "$a" in
    --check|--status|--no-install) MODE="$a" ;;
    *) WANT="${a#v}" ;;
  esac
done

if [[ ! -d .git ]]; then
  [[ "$MODE" == "--status" ]] && { echo '{"git":false}'; exit 0; }
  die "Ten folder nie jest połączony z GitHubem – zob. README, rozdział „Aktualizacje z GitHuba”."
fi
cur=$(grep -m1 '^IK_VERSION=' install.sh | cut -d'"' -f2)
if ! git fetch --quiet origin 2>/tmp/ik-fetch.$$; then
  err=$(tail -1 /tmp/ik-fetch.$$ 2>/dev/null || true); rm -f /tmp/ik-fetch.$$
  [[ "$MODE" == "--status" ]] && { printf '{"git":true,"current":%s,"error":%s}\n' "$(jstr "$cur")" "$(jstr "Brak połączenia z GitHubem: ${err}")"; exit 0; }
  die "Nie udało się połączyć z GitHubem (internet? klucz wdrożeniowy?)."
fi
rm -f /tmp/ik-fetch.$$
latest=$(git show origin/main:install.sh | grep -m1 '^IK_VERSION=' | cut -d'"' -f2)

if [[ "$MODE" == "--status" ]]; then
  changes=""
  while IFS= read -r line; do changes+="${changes:+,}$(jstr "$line")"; done < <(git log --format=%s HEAD..origin/main | head -30)
  printf '{"git":true,"current":%s,"latest":%s,"behind":%s,"changes":[%s],"at":%s}\n' \
    "$(jstr "$cur")" "$(jstr "$latest")" "$(git rev-list --count HEAD..origin/main)" "$changes" "$(jstr "$(date -Is)")"
  exit 0
fi

echo "Zainstalowana: ${cur} · najnowsza na GitHubie: ${latest}"
if [[ "$MODE" == "--check" ]]; then
  [[ "$cur" == "$latest" ]] && say "Masz najnowszą wersję." || { echo; echo "Zmiany:"; git log --oneline HEAD..origin/main | head -20; }
  exit 0
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  bk="zmiany-lokalne-$(date +%Y%m%d-%H%M%S).patch"
  git diff > "$bk"
  warn "Pliki programu były zmieniane ręcznie – zmiany zapisano w ${bk} i zostaną nadpisane."
fi

if [[ -n "$WANT" ]]; then
  # wersja = ostatnia zmiana opisana „Interkom X.Y.Z …” (albo znacznik vX.Y.Z, jeśli ktoś go założył)
  ref=$(git log origin/main --format='%H %s' | awk -v v="$WANT" '$2=="Interkom" && $3==v {print $1; exit}')
  [[ -n "$ref" ]] || ref=$(git rev-parse -q --verify "refs/tags/v${WANT}" || true)
  [[ -n "$ref" ]] || die "Nie ma wersji ${WANT} na GitHubie. Dostępne: $(git log origin/main --format='%s' | awk '$1=="Interkom"{print $2}' | head -10 | tr '\n' ' ')"
  git checkout --quiet -f -B main "$ref"
  warn "Ustawiono wersję ${WANT}. Kolejne ./update.sh wróci do najnowszej."
else
  [[ "$cur" == "$latest" ]] && say "Masz najnowszą wersję – instaluję ponownie dla pewności."
  git checkout --quiet -f -B main origin/main
fi
chmod +x install.sh update.sh
say "Program: $(grep -m1 '^IK_VERSION=' install.sh | cut -d'"' -f2)"
[[ "$MODE" == "--no-install" ]] && exit 0
say "Uruchamiam instalator (ustawienia zostają)…"
exec sudo ./install.sh
