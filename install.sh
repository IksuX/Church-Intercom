#!/usr/bin/env bash
# Interkom – instalator dla Ubuntu Server 24.04 LTS
# Użycie:  sudo ./install.sh            (pierwsza instalacja lub aktualizacja)
#          sudo ./install.sh --reconfigure  (ponowne pytania o domenę / tryb)
#          sudo ./install.sh --pco          (podłączenie / zmiana tokenu Planning Center)
#
# Ustawienia, klucze i dane trzymamy POZA folderem programu – w /var/lib/interkom (zmienna IK_HOME).
# W folderze programu są tylko dowiązania (.env, config, data). Dzięki temu aktualizacja – nawet do świeżo
# rozpakowanego folderu albo po jego usunięciu – niczego nie kasuje i nie trzeba ponownie wpisywać kluczy.
set -euo pipefail
cd "$(dirname "$0")"

IK_VERSION="0.47.0"
c_ok="\033[32m"; c_warn="\033[33m"; c_err="\033[31m"; c_0="\033[0m"
say()  { echo -e "${c_ok}==>${c_0} $*"; }
warn() { echo -e "${c_warn}[!]${c_0} $*"; }
die()  { echo -e "${c_err}[x]${c_0} $*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Uruchom przez sudo: sudo ./install.sh"
. /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" ]] || warn "Testowane na Ubuntu 24.04 – ten system (${PRETTY_NAME:-?}) może wymagać poprawek."

say "Interkom ${IK_VERSION} – instalacja"

# ---------- trwałe ustawienia poza folderem programu ----------
IK_HOME="${IK_HOME:-/var/lib/interkom}"
persist() { # $1 = .env | config | data
  local item="$1" target="${IK_HOME}/$1"
  if [[ -L "$item" ]]; then
    [[ "$(readlink "$item")" == "$target" ]] && return 0
    rm -f "$item"
  elif [[ -e "$item" ]]; then
    if [[ ! -e "$target" ]]; then
      mv "$item" "$target"; say "Przeniesiono ${item} do ${IK_HOME} (ustawienia przetrwają aktualizacje)."
    else
      local old="${item}.stare-$(date +%Y%m%d-%H%M%S)"
      mv "$item" "$old"; warn "W ${IK_HOME} są już zapisane ustawienia – używam ich. Lokalny ${item} odłożono jako ${old}."
    fi
  fi
  [[ "$item" == ".env" ]] || mkdir -p "$target"
  ln -sfn "$target" "$item"
}
mkdir -p "$IK_HOME"; chmod 700 "$IK_HOME"
# przenoszenie danych działającego interkomu – najpierw go zatrzymaj (zapis w trakcie przenoszenia)
if { [[ -e data && ! -L data ]] || [[ -e config && ! -L config ]]; } && command -v docker >/dev/null 2>&1; then
  docker compose stop >/dev/null 2>&1 || true
fi
persist .env; persist config; persist data
if [[ -s "${IK_HOME}/.env" ]]; then say "Ustawienia: ${IK_HOME} (zachowane)"; fi

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "Instaluję Dockera…"
  apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Brak 'docker compose'. Zainstaluj pakiet docker-compose-plugin."
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------- adres IP w sieci lokalnej ----------
LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[[ -n "$LAN_IP" ]] || die "Nie udało się ustalić adresu IP serwera. Czy jest podłączony do sieci?"
DETECTED_LAN_IP=$LAN_IP # .env (wczytywany niżej) ma adres z poprzedniej instalacji – po przeniesieniu serwera liczy się wykryty

# bez „| head” – przy pipefail przerwany potok (SIGPIPE) zatrzymywał cały skrypt
rand() { local s; s=$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:$1}"; }
pin()  { local s; s=$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc '0-9');      printf '%s' "${s:0:$1}"; }
trap 'echo -e "\033[31m[x]\033[0m Instalator przerwany w linii $LINENO (polecenie: $BASH_COMMAND)."' ERR

# ---------- konfiguracja (.env) ----------
if [[ ! -f .env || "${1:-}" == "--reconfigure" ]]; then
  [[ -f .env ]] && . ./.env
  echo
  echo "Adres IP serwera w sieci lokalnej: ${LAN_IP}"
  echo "Upewnij się, że router ma REZERWACJĘ DHCP dla tego adresu (stały IP)."
  echo
  echo "Jak telefony mają łączyć się z serwerem (HTTPS jest wymagany dla mikrofonu)?"
  echo "  1) Przez domenę w Cloudflare, np. interkom.mojaparafia.pl  (zalecane – nic nie trzeba instalować na telefonach)"
  echo "  2) Przez adres IP z własnym certyfikatem  (trzeba zainstalować certyfikat na każdym urządzeniu)"
  echo "  3) Serwer w internecie (VPS / wirtualna maszyna w chmurze) – do testów, darmowy adres *.sslip.io"
  echo "  4) Przez darmową subdomenę DuckDNS, np. interkom-cme.duckdns.org  (bez kosztów, nic nie trzeba instalować na telefonach)"
  read -rp "Wybór [1/2/3/4]: " MODE
  if [[ "$MODE" == "3" ]]; then
    TLS_MODE=public; CF_API_TOKEN=""
    PUBLIC_IP=$(curl -fsS4 --max-time 5 https://api.ipify.org || curl -fsS4 --max-time 5 https://ifconfig.me || true)
    [[ -n "$PUBLIC_IP" ]] || die "Nie udało się ustalić publicznego adresu IP."
    DEF_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
    echo "Publiczny IP: ${PUBLIC_IP}"
    read -rp "Domena [Enter = ${DEF_DOMAIN}]: " DOMAIN; DOMAIN=${DOMAIN:-$DEF_DOMAIN}
    read -rp "E-mail do Let's Encrypt (można pominąć): " ACME_EMAIL
  elif [[ "$MODE" == "1" ]]; then
    TLS_MODE=cloudflare
    read -rp "Domena (np. interkom.mojaparafia.pl): " DOMAIN
    read -rp "E-mail do Let's Encrypt: " ACME_EMAIL
    read -rsp "Token API Cloudflare (uprawnienie Zone:DNS:Edit): " CF_API_TOKEN; echo
    [[ -n "$DOMAIN" && -n "$CF_API_TOKEN" ]] || die "Domena i token są wymagane."
  elif [[ "$MODE" == "4" ]]; then
    TLS_MODE=duckdns; CF_API_TOKEN=""
    echo "Na duckdns.org: zaloguj się, dodaj subdomenę (add domain) i skopiuj token z góry strony."
    read -rp "Subdomena (np. interkom-cme): " SUB
    SUB=${SUB%.duckdns.org}; SUB=${SUB#https://}
    read -rsp "Token DuckDNS: " DUCKDNS_TOKEN; echo
    read -rp "E-mail do Let's Encrypt (można pominąć): " ACME_EMAIL
    [[ -n "$SUB" && -n "$DUCKDNS_TOKEN" ]] || die "Subdomena i token są wymagane."
    DOMAIN="${SUB}.duckdns.org"
  else
    TLS_MODE=internal; DOMAIN="$LAN_IP"; ACME_EMAIL=""; CF_API_TOKEN=""
  fi
  LIVEKIT_API_KEY=${LIVEKIT_API_KEY:-API$(rand 12)}
  LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET:-$(rand 48)}
  SESSION_SECRET=${SESSION_SECRET:-$(rand 48)}
  cat > .env <<EOF
# Wygenerowane przez install.sh – nie udostępniaj tego pliku.
TLS_MODE=${TLS_MODE}
DOMAIN=${DOMAIN}
LAN_IP=${LAN_IP}
PUBLIC_IP=${PUBLIC_IP:-}
ACME_EMAIL=${ACME_EMAIL}
CF_API_TOKEN=${CF_API_TOKEN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN:-}
REMOTE_DOMAIN=${REMOTE_DOMAIN:-}
LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}
SESSION_SECRET=${SESSION_SECRET}
EOF
  chmod 600 .env
fi
. ./.env

# ---------- Planning Center (opcjonalnie) ----------
# ---------- nadajnik dźwięku na serwerze (usługa „audio”) – tylko gdy jest karta dźwiękowa ----------
audio_profile() {
  if [[ -d /dev/snd ]] && ls /dev/snd/pcmC*c >/dev/null 2>&1; then
    if grep -q "^COMPOSE_PROFILES=" .env; then sed -i --follow-symlinks "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=audio|" .env; else echo "COMPOSE_PROFILES=audio" >> .env; fi
    say "Wykryto wejście audio – włączam nadajnik dźwięku na serwerze (panel → Transmisja → Dźwięk transmisji)."
  fi
}
audio_profile
# klucze wpisane w panelu (config/secrets.json) – instalator nie pyta o nie ponownie
if [[ -z "${PCO_ASKED:-}" ]] && grep -q '"pcoAppId"' config/secrets.json 2>/dev/null; then PCO_ASKED=1; fi
set_env() { if grep -q "^$1=" .env; then sed -i --follow-symlinks "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
if [[ "${1:-}" == "--pco" || ( -z "${PCO_ASKED:-}" && -t 0 ) ]]; then
  echo
  echo "Planning Center: interkom może pobierać plan nabożeństwa, obsadę i zespoły."
  echo "Potrzebny jest Personal Access Token: https://api.planningcenteronline.com/oauth/applications"
  echo "  → „Personal Access Tokens” → „Create one now” (zaznacz dostęp do Services)."
  read -rp "Podłączyć Planning Center? [t/N]: " yn
  if [[ "$yn" =~ ^[tTyY] ]]; then
    read -rp "Application ID: " PCO_APP_ID
    read -rsp "Secret: " PCO_SECRET; echo
    set_env PCO_APP_ID "$PCO_APP_ID"; set_env PCO_SECRET "$PCO_SECRET"
    say "Zapisano token Planning Center."
  fi
  set_env PCO_ASKED 1
  . ./.env
fi
if [[ "${LAN_IP:-}" != "$DETECTED_LAN_IP" ]]; then
  warn "Adres serwera w sieci lokalnej zmienił się (${LAN_IP:-?} → ${DETECTED_LAN_IP}). Aktualizuję ustawienia."
  LAN_IP=$DETECTED_LAN_IP
fi
if [[ "$TLS_MODE" == "internal" && "$DOMAIN" != "$LAN_IP" ]]; then
  warn "Adres IP zmienił się (${DOMAIN} → ${LAN_IP}). Aktualizuję."
  sed -i --follow-symlinks "s/^DOMAIN=.*/DOMAIN=${LAN_IP}/" .env; DOMAIN=$LAN_IP
fi
sed -i --follow-symlinks "s/^LAN_IP=.*/LAN_IP=${LAN_IP}/" .env
# DuckDNS: subdomena wskazuje adres serwera W SIECI LOKALNEJ (telefony w Wi-Fi łączą się bezpośrednio, z internetu nic nie widać)
if [[ "$TLS_MODE" == "duckdns" ]]; then
  R=$(curl -fsS --max-time 10 "https://www.duckdns.org/update?domains=${DOMAIN%.duckdns.org}&token=${DUCKDNS_TOKEN}&ip=${LAN_IP}" || true)
  if [[ "$R" == OK* ]]; then say "DuckDNS: ${DOMAIN} → ${LAN_IP}"; else warn "DuckDNS nie przyjął aktualizacji (odpowiedź: ${R:-brak}). Sprawdź subdomenę i token: sudo ./install.sh --reconfigure"; fi
fi

# ---------- dostęp spoza sieci kościoła (przekierowanie portów na routerze) ----------
# Druga nazwa DuckDNS wskazuje PUBLICZNY adres kościoła (aktualizowany co 5 min), pierwsza – adres w sieci lokalnej.
if [[ "${1:-}" == "--remote-off" ]]; then
  set_env REMOTE_DOMAIN ""; REMOTE_DOMAIN=""
  systemctl disable --now interkom-ddns.timer >/dev/null 2>&1 || true
  say "Dostęp spoza sieci wyłączony. Usuń też przekierowania portów w routerze."
fi
if [[ "${1:-}" == "--remote" ]]; then
  [[ "$TLS_MODE" == "duckdns" ]] || die "Dostęp spoza sieci instalator ustawia w trybie DuckDNS (4). Zmień tryb: sudo ./install.sh --reconfigure"
  echo
  echo "Dostęp spoza sieci kościoła: na duckdns.org dodaj DRUGĄ subdomenę (np. ${DOMAIN%%.*}-zdalnie)."
  echo "Instalator ustawi w niej publiczny adres kościoła i będzie go aktualizować co 5 minut."
  read -rp "Druga subdomena DuckDNS: " RSUB
  RSUB=${RSUB%.duckdns.org}; RSUB=${RSUB#https://}
  [[ -n "$RSUB" && "${RSUB}.duckdns.org" != "$DOMAIN" ]] || die "Podaj inną subdomenę niż ${DOMAIN}."
  set_env REMOTE_DOMAIN "${RSUB}.duckdns.org"; REMOTE_DOMAIN="${RSUB}.duckdns.org"
fi
if [[ -n "${REMOTE_DOMAIN:-}" && "$TLS_MODE" == "duckdns" ]]; then
  cat > /usr/local/sbin/interkom-ddns <<EOF
#!/bin/bash
# Aktualizuje publiczny adres kościoła w DuckDNS (${REMOTE_DOMAIN}) – dostęp do interkomu spoza sieci.
curl -4 -fsS --max-time 15 "https://www.duckdns.org/update?domains=${REMOTE_DOMAIN%.duckdns.org}&token=${DUCKDNS_TOKEN}&ip=" >/dev/null
EOF
  chmod 700 /usr/local/sbin/interkom-ddns
  cat > /etc/systemd/system/interkom-ddns.service <<EOF
[Unit]
Description=Interkom – aktualizacja publicznego adresu w DuckDNS
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/interkom-ddns
EOF
  cat > /etc/systemd/system/interkom-ddns.timer <<EOF
[Unit]
Description=Interkom – aktualizacja publicznego adresu co 5 minut
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now interkom-ddns.timer >/dev/null 2>&1 || warn "Nie udało się włączyć aktualizacji adresu publicznego."
  if /usr/local/sbin/interkom-ddns; then
    PUB=$(curl -4 -fsS --max-time 5 https://api.ipify.org || true)
    say "Dostęp spoza sieci: ${REMOTE_DOMAIN} → ${PUB:-publiczny adres}"
  else warn "DuckDNS nie przyjął drugiej subdomeny ${REMOTE_DOMAIN} – sprawdź, czy ją dodałeś na duckdns.org."; fi
fi
# adres, który LiveKit podaje klientom do połączenia audio
if [[ "$TLS_MODE" == "public" ]]; then NODE_IP="${PUBLIC_IP}"; else NODE_IP="${LAN_IP}"; fi

# ---------- config.json (kanały, PIN-y) ----------
mkdir -p config data/app data/caddy data/caddy-config data/stt-models livekit
if [[ ! -f config/config.json ]]; then
  ACCESS=$(pin 4); SPEAK=$(pin 6); ADMIN=$(pin 8)
  sed -e "s/\"accessPin\": \"1234\"/\"accessPin\": \"${ACCESS}\"/" \
      -e "s/\"speakerPin\": \"5678\"/\"speakerPin\": \"${SPEAK}\"/" \
      -e "s/\"adminPin\": \"9999\"/\"adminPin\": \"${ADMIN}\"/" \
      app/config/config.example.json > config/config.json
  say "Utworzono config/config.json z losowymi PIN-ami."
fi

# ---------- LiveKit ----------
# sumy kontrolne konfiguracji LiveKit i Caddy – po zmianie trzeba te usługi uruchomić ponownie (plik jest tylko podmontowany)
cfg_sum() { { cat livekit/livekit.yaml caddy/Caddyfile 2>/dev/null || true; } | sha256sum | cut -c1-16; } # przy pierwszej instalacji plików jeszcze nie ma
CFG_BEFORE=$(cfg_sum)
cat > livekit/livekit.yaml <<EOF
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
$(if [[ -n "${REMOTE_DOMAIN:-}" ]]; then printf '  use_external_ip: true\n  advertise_internal_ip: true'; else printf '  use_external_ip: false\n  node_ip: %s' "${NODE_IP}"; fi)
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
room:
  auto_create: true
  empty_timeout: 600
logging:
  level: info
EOF

# ---------- Caddy ----------
ROUTES='	@livekit path /rtc*
	handle @livekit {
		reverse_proxy 127.0.0.1:7880
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}'
if [[ "$TLS_MODE" == "cloudflare" ]]; then
  cat > caddy/Caddyfile <<EOF
{
	email ${ACME_EMAIL}
}
${DOMAIN} {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
		resolvers 1.1.1.1
	}
${ROUTES}
}
EOF
elif [[ "$TLS_MODE" == "duckdns" ]]; then
  : > caddy/Caddyfile
  [[ -n "$ACME_EMAIL" ]] && printf '{\n\temail %s\n}\n' "$ACME_EMAIL" > caddy/Caddyfile
  cat >> caddy/Caddyfile <<EOF
${DOMAIN}${REMOTE_DOMAIN:+, ${REMOTE_DOMAIN}} {
	tls {
		dns duckdns {env.DUCKDNS_TOKEN}
		resolvers 1.1.1.1
		propagation_timeout 5m
	}
${ROUTES}
}
EOF
elif [[ "$TLS_MODE" == "public" ]]; then
  : > caddy/Caddyfile
  [[ -n "$ACME_EMAIL" ]] && printf '{\n\temail %s\n}\n' "$ACME_EMAIL" > caddy/Caddyfile
  cat >> caddy/Caddyfile <<EOF
${DOMAIN} {
${ROUTES}
}
EOF
else
  cat > caddy/Caddyfile <<EOF
{
	skip_install_trust
}
http://${DOMAIN} {
	handle /ca.crt {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		redir https://{host}{uri}
	}
}
https://${DOMAIN} {
	tls internal
${ROUTES}
}
EOF
fi
# inne aplikacje na tym serwerze: własne strony w caddy/sites/*.caddy (instalator ich nie nadpisuje)
mkdir -p caddy/sites
[[ -f caddy/sites/00-przyklad.caddy ]] || cat > caddy/sites/00-przyklad.caddy <<'EOF'
# Przykład: druga aplikacja pod własną nazwą (np. druga subdomena DuckDNS), działająca na porcie 8080.
# Usuń znaki # z sześciu linii poniżej, wpisz swoją nazwę i port, potem: sudo docker compose restart caddy
#
# twoja-nazwa.duckdns.org {
# 	tls {
# 		dns duckdns {env.DUCKDNS_TOKEN}
# 	}
# 	reverse_proxy 127.0.0.1:8080
# }
EOF
printf '\n# dodatkowe strony (inne aplikacje na tym serwerze)\nimport /etc/caddy/sites/*.caddy\n' >> caddy/Caddyfile

# ---------- ogłaszanie w sieci lokalnej (aplikacja na telefon sama znajdzie serwer) ----------
if [[ "$TLS_MODE" != "public" ]]; then
  if ! command -v avahi-daemon >/dev/null; then
    say "Instaluję avahi (wyszukiwanie serwera w sieci przez aplikację)…"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq avahi-daemon >/dev/null 2>&1 || warn "Nie udało się zainstalować avahi – w aplikacji trzeba będzie wpisać adres ręcznie."
  fi
  if [[ -d /etc/avahi/services ]]; then
    ORG=$(grep -o '"orgName": *"[^"]*"' config/config.json | cut -d'"' -f4 | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    cat > /etc/avahi/services/interkom.service <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Interkom (%h)</name>
  <service>
    <type>_interkom._tcp</type>
    <port>443</port>
    <txt-record>url=https://${DOMAIN}</txt-record>
    <txt-record>org=${ORG:-Interkom}</txt-record>
    <txt-record>v=${IK_VERSION}</txt-record>
  </service>
</service-group>
EOF
    systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
    systemctl restart avahi-daemon >/dev/null 2>&1 || true
    command -v ufw >/dev/null && ufw status | grep -q "Status: active" && ufw allow 5353/udp >/dev/null
  fi
fi

# ---------- sterowanie serwerem z panelu (restart interkomu / komputera, wyłączenie) ----------
# Aplikacja zapisuje polecenie do pliku, a ta usługa systemd je wykonuje – kontener nie ma uprawnień do hosta.
CTL_DIR="${IK_HOME}/data/app/control"
mkdir -p "$CTL_DIR"
cat > /usr/local/sbin/interkom-control <<EOF
#!/bin/bash
# Wykonuje polecenie zlecone w panelu administracyjnym interkomu (plik ${CTL_DIR}/request).
F="${CTL_DIR}/request"
[ -f "\$F" ] || exit 0
A=\$(grep -o '"action": *"[a-z-]*"' "\$F" | head -1 | cut -d'"' -f4)
rm -f "\$F"
logger -t interkom "polecenie z panelu: \$A"
DIR="$(pwd)"
OWNER=\$(stat -c %U "\$DIR")
case "\$A" in
  restart)  cd "\$DIR" && docker compose restart ;;
  reboot)   systemctl reboot ;;
  poweroff) systemctl poweroff ;;
  update-check)
    # git jako właściciel folderu (jego klucz do GitHuba; root dostałby „dubious ownership”)
    runuser -u "\$OWNER" -- "\$DIR/update.sh" --status > "${CTL_DIR}/update.json.tmp" 2>/dev/null \\
      || printf '{"git":true,"error":"Sprawdzanie nie powiodło się – uruchom na serwerze: ./update.sh --check"}\\n' > "${CTL_DIR}/update.json.tmp"
    chmod 644 "${CTL_DIR}/update.json.tmp"; mv -f "${CTL_DIR}/update.json.tmp" "${CTL_DIR}/update.json" ;;
  update)
    # osobna jednostka systemd z kopii skryptu: instalator podmienia pliki w /usr/local/sbin i restartuje kontenery
    cp /usr/local/sbin/interkom-update /run/interkom-update.sh
    systemd-run --unit=interkom-update --collect --quiet /bin/bash /run/interkom-update.sh \\
      || logger -t interkom "aktualizacja już trwa" ;;
esac
EOF
chmod 755 /usr/local/sbin/interkom-control
cat > /usr/local/sbin/interkom-update <<EOF
#!/bin/bash
# Aktualizacja z GitHuba zlecona w panelu (zakładka Serwer). Dziennik: ${CTL_DIR}/update.log
CTL="${CTL_DIR}"; DIR="$(pwd)"
OWNER=\$(stat -c %U "\$DIR")
ver() { grep -m1 '^IK_VERSION=' "\$DIR/install.sh" | cut -d'"' -f2; }
st() { printf '{"state":"%s","from":"%s","to":"%s","code":%s,"at":"%s"}\\n' "\$1" "\$FROM" "\$(ver)" "\${2:-null}" "\$(date -Is)" > "\$CTL/update-state.json.tmp"; chmod 644 "\$CTL/update-state.json.tmp"; mv -f "\$CTL/update-state.json.tmp" "\$CTL/update-state.json"; }
FROM=\$(ver)
st running
{
  echo "=== \$(date '+%Y-%m-%d %H:%M:%S') aktualizacja z panelu (zainstalowana \$FROM)"
  cd "\$DIR" && runuser -u "\$OWNER" -- ./update.sh --no-install && ./install.sh
} > "\$CTL/update.log" 2>&1 < /dev/null
CODE=\$?
sed -i 's/\\x1b\\[[0-9;]*m//g' "\$CTL/update.log"; chmod 644 "\$CTL/update.log"
if [ \$CODE -eq 0 ]; then st done 0; else st failed \$CODE; fi
logger -t interkom "aktualizacja z panelu: \$FROM -> \$(ver), kod \$CODE"
runuser -u "\$OWNER" -- "\$DIR/update.sh" --status > "\$CTL/update.json.tmp" 2>/dev/null && chmod 644 "\$CTL/update.json.tmp" && mv -f "\$CTL/update.json.tmp" "\$CTL/update.json"
EOF
chmod 755 /usr/local/sbin/interkom-update
cat > /etc/systemd/system/interkom-control.service <<EOF
[Unit]
Description=Interkom – polecenia z panelu administracyjnego
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/interkom-control
EOF
cat > /etc/systemd/system/interkom-control.path <<EOF
[Unit]
Description=Interkom – oczekiwanie na polecenia z panelu
[Path]
PathExists=${CTL_DIR}/request
[Install]
WantedBy=multi-user.target
EOF
rm -f "${CTL_DIR}/request"
systemctl daemon-reload
systemctl enable --now interkom-control.path >/dev/null 2>&1 && echo "${IK_VERSION}" > "${CTL_DIR}/helper" && echo "update" > "${CTL_DIR}/features" || warn "Nie udało się włączyć sterowania serwerem z panelu."

# ---------- zapora ----------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Otwieram porty w ufw (80, 443, 7881/tcp, 7882/udp)…"
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw allow 7881/tcp >/dev/null; ufw allow 7882/udp >/dev/null
fi

# ---------- start ----------
say "Buduję i uruchamiam kontenery (pierwszy raz może potrwać kilka minut)…"
docker compose up -d --build --remove-orphans
if [[ "$(cfg_sum)" != "$CFG_BEFORE" ]]; then
  say "Zmieniła się konfiguracja głosu / HTTPS – uruchamiam ponownie LiveKit i Caddy…"
  docker compose restart livekit caddy >/dev/null 2>&1 || warn "Nie udało się zrestartować LiveKit/Caddy – zrób to ręcznie: sudo docker compose restart livekit caddy"
fi

sleep 3
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then say "Aplikacja działa."; else warn "Aplikacja jeszcze nie odpowiada – sprawdź: docker compose logs app"; fi
if [[ -n "${PCO_APP_ID:-}" ]]; then
  sleep 2
  docker compose exec -T app node src/pco-check.js || warn "Sprawdź token Planning Center: sudo bash install.sh --pco"
fi
if ! curl -fsS http://127.0.0.1:8001/health 2>/dev/null | grep -q '"ready": true'; then
  say "Model rozpoznawania mowy pobiera się w tle (ok. 500 MB, jednorazowo)."
  say "Transkrypcja ruszy za kilka minut. Podgląd: sudo docker compose logs -f stt"
fi

ACCESS=$(grep -o '"accessPin": *"[^"]*"' config/config.json | cut -d'"' -f4)
SPEAK=$(grep -o '"speakerPin": *"[^"]*"' config/config.json | cut -d'"' -f4)
ADMIN=$(grep -o '"adminPin": *"[^"]*"' config/config.json | cut -d'"' -f4)
echo
echo "================================================================"
echo "  Interkom ${IK_VERSION} uruchomiony"
echo "  Adres:           https://${DOMAIN}"
echo "  PIN ekipy:       ${ACCESS}"
echo "  PIN mówiącego:   ${SPEAK}"
echo "  PIN admina:      ${ADMIN}   (wpisywany w pole PIN mówiącego)"
if [[ "$TLS_MODE" == "public" ]]; then
echo
echo "  UWAGA: serwer jest dostępny z internetu – nie podawaj PIN-ów publicznie."
echo "  W zaporze dostawcy chmury otwórz: 80/tcp, 443/tcp, 7881/tcp, 7882/udp."
elif [[ "$TLS_MODE" == "cloudflare" ]]; then
echo
echo "  W Cloudflare DNS dodaj rekord:  A  ${DOMAIN}  →  ${LAN_IP}  (bez pomarańczowej chmurki / DNS only)"
elif [[ "$TLS_MODE" == "duckdns" ]]; then
echo
echo "  ${DOMAIN} wskazuje ${LAN_IP} – działa tylko w sieci lokalnej (tak ma być)."
echo "  Certyfikat pobiera się w tle (do 2–3 minut przy pierwszym uruchomieniu)."
if [[ -n "${REMOTE_DOMAIN:-}" ]]; then
echo
echo "  DOSTĘP SPOZA SIECI: https://${REMOTE_DOMAIN}"
echo "  W routerze przekieruj na ${LAN_IP}:  443/TCP, 7881/TCP, 7882/UDP"
echo "  W Planning Center dodaj też Redirect URI https://${REMOTE_DOMAIN}/auth/pco/callback"
echo "  Spoza sieci logowanie tylko kontem Planning Center (zmienisz w panelu: Ogólne → Dostęp spoza sieci)."
else
echo "  Dostęp spoza sieci (operatorzy zdalni): sudo ./install.sh --remote"
fi
echo "  Logowanie Planning Center: w Planning Center dodaj Redirect URI https://${DOMAIN}/auth/pco/callback"
else
echo
echo "  Na każdym urządzeniu najpierw pobierz i zainstaluj certyfikat:"
echo "     http://${DOMAIN}/ca.crt     (instrukcja w README.md)"
fi
echo "  Panel administracyjny: https://${DOMAIN}/admin  (PIN admina)"
echo "  Tam zmienisz PIN-y, kanały, przyciski i ustawienia Planning Center."
echo "================================================================"
