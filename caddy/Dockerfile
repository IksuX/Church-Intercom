# Caddy z modułami DNS Cloudflare i DuckDNS (potrzebny do certyfikatu Let's Encrypt dla serwera w sieci lokalnej)
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare --with github.com/caddy-dns/duckdns
FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
