# Interkom – nadajnik dźwięku transmisji na serwerze (ALSA → Opus → WebRTC / LiveKit)
# Etap 1: ik-publish (Go) – wysyła pakiety Opus do LiveKit jako ścieżkę stereo (biblioteka dla Node umie tylko mono).
FROM golang:1.25-bookworm AS publisher
WORKDIR /src
COPY publisher/ ./
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /ik-publish .

# Etap 2: usługa audio. Debian (glibc), bo biblioteki WebRTC i LiveKit mają gotowe binaria tylko dla glibc.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends alsa-utils ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /audio
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=publisher /ik-publish /usr/local/bin/ik-publish
COPY audio.mjs ./
CMD ["node", "audio.mjs"]
