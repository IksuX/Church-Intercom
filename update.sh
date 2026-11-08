#!/usr/bin/env bash
# Aktualizacja interkomu z GitHuba.
#   ./update.sh            – najnowsza wersja
#   ./update.sh 0.44.1     – konkretna wersja (np. powrót do poprzedniej)
#   ./update.sh --check    – tylko sprawdź, czy jest coś nowego
# Ustawienia (/var/lib/interkom) zostają nietknięte – aktualizowany jest tylko program.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
say()  { echo -e "\033[32m[✓]\033[0m $*"; }
warn() { echo -e "\033[33m[!]\033[0m $*"; }
die()  { echo -e "\033[31m[x]\033[0m $*"; exit 1; }

[[ -d .git ]] || die "Ten folder nie jest połączony z GitHubem – zob. README, rozdział „Aktualizacje z GitHuba”."
cur=$(grep -m1 '^IK_VERSION=' install.sh | cut -d'"' -f2)
git fetch --quiet --tags origin || die "Nie udało się połączyć z GitHubem (internet? klucz wdrożeniowy?)."
latest=$(git show origin/main:install.sh | grep -m1 '^IK_VERSION=' | cut -d'"' -f2)
echo "Zainstalowana: ${cur} · najnowsza na GitHubie: ${latest}"

if [[ "${1:-}" == "--check" ]]; then
  [[ "$cur" == "$latest" ]] && say "Masz najnowszą wersję." || { echo; echo "Zmiany:"; git log --oneline HEAD..origin/main | head -20; }
  exit 0
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  bk="zmiany-lokalne-$(date +%Y%m%d-%H%M%S).patch"
  git diff > "$bk"
  warn "Pliki programu były zmieniane ręcznie – zmiany zapisano w ${bk} i zostaną nadpisane."
fi

if [[ -n "${1:-}" ]]; then
  want="${1#v}"
  # wersja = ostatnia zmiana opisana „Interkom X.Y.Z …” (albo znacznik vX.Y.Z, jeśli ktoś go założył)
  ref=$(git log origin/main --format='%H %s' | awk -v v="$want" '$2=="Interkom" && $3==v {print $1; exit}')
  [[ -n "$ref" ]] || ref=$(git rev-parse -q --verify "refs/tags/v${want}" || true)
  [[ -n "$ref" ]] || die "Nie ma wersji ${want} na GitHubie. Dostępne: $(git log origin/main --format='%s' | awk '$1=="Interkom"{print $2}' | head -10 | tr '\n' ' ')"
  git checkout --quiet -f -B main "$ref"
  warn "Ustawiono wersję ${1}. Kolejne ./update.sh wróci do najnowszej."
else
  [[ "$cur" == "$latest" ]] && { say "Masz najnowszą wersję – instaluję ponownie dla pewności."; }
  git checkout --quiet -f -B main origin/main
fi
chmod +x install.sh update.sh
say "Program: $(grep -m1 '^IK_VERSION=' install.sh | cut -d'"' -f2) – uruchamiam instalator (ustawienia zostają)…"
exec sudo ./install.sh
