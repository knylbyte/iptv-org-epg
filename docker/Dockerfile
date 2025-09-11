# --- Global ARGs ---
ARG NODE_VERSION=24
ARG PM2_VER=5.4.2
ARG SERVE_VER=14.2.5
ARG TSX_VER=4.19.1
ARG CHRONOS_VER=0.0.1
ARG BB_VERSION=1.36.0

# --- Builder stage: use local repo and install deps ---
FROM node:${NODE_VERSION:-24}-alpine AS builder

ARG PM2_VER
ARG SERVE_VER
ARG TSX_VER
ARG CHRONOS_VER

RUN apk update \
 && apk upgrade \
 && apk add --no-cache tzdata ca-certificates

RUN npm install -g npm@latest

RUN mkdir -p /epg/public /epg/sites/ /_stash

WORKDIR /epg

# Keep npm quiet and deterministic
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

# Copy lockfile and manifest first to leverage Docker cache
COPY package*.json ./

# Install only production deps, skip lifecycle scripts
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# Install runtime tools locally 
RUN npm install --no-audit --no-fund --omit=dev --no-save \
    pm2@${PM2_VER} \
    serve@${SERVE_VER} \
    tsx@${TSX_VER} \
    @freearhey/chronos@${CHRONOS_VER}

# Copy only runtime-relevant sources
COPY scripts                ./scripts
COPY sites                  ./sites
COPY docker/pm2.config.js   ./pm2.config.js
COPY tsconfig.json          ./tsconfig.json
COPY package.json           ./package.json
COPY all.channels.xml       ./sites/all.channels.xml

# Manually repeat the post-installation step (loads temp/data/*.json)
RUN npm run api:load

# Stash tzdata (and CA certs if you want to be explicit)
RUN cp -a /usr/share/zoneinfo                /_stash/zoneinfo \
 && cp -a /etc/ssl/certs/ca-certificates.crt /_stash/ca-certificates.crt

# --- Helper stage: prepare BusyBox (provides /bin/sh and /bin/getconf)
FROM busybox:${BB_VERSION}-uclibc AS bb
# Copy the static busybox binary and create the symlinks we need.
# PM2 (via pidusage) executes `getconf` through `/bin/sh`, which distroless doesn't ship.
RUN mkdir -p /out/bin \
 && cp /bin/busybox /out/bin/busybox \
 && ln -s /out/bin/busybox /out/bin/sh \
 && ln -s /out/bin/busybox /out/bin/getconf

# ---------- Runner (Distroless) ----------
FROM gcr.io/distroless/nodejs${NODE_VERSION:-24} AS runner

# Default settings, can be overridden via env vars

ENV NODE_ENV=production  \
    CRON_SCHEDULE="0 0 * * *" \
    PORT=3000 \
    RUN_AT_STARTUP=true \
    MAX_CONNECTIONS=1 \
    GZIP=false \
    CURL=false \
    DAYS= \
    TIMEOUT=0 \
    DELAY=0 \
    TZ=UTC

# Provide tzdata (and CA bundle) to the distroless image
COPY --from=builder /_stash/zoneinfo /usr/share/zoneinfo
COPY --from=builder /_stash/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# Provide a minimal /bin with sh + getconf so PM2/pidusage can run.
# Distroless doesn't allow RUN, so we just COPY the prepared tools in.
COPY --from=bb /out/bin /bin

# Ensure /bin is in PATH (distroless usually has it, but this makes it explicit).
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

WORKDIR /epg

# Copy only the essentials from builder
COPY --from=builder /epg /epg

EXPOSE 3000

# Drop root privileges
# USER node # deacticated for test purpose

# Distroless-Node has ENTRYPOINT ["node"]; we therefore specify the JS file:
# pm2-runtime directly from node_modules, without PATH or shell.
CMD ["node_modules/pm2/bin/pm2-runtime","--home","/epg/.pm2","pm2.config.js"]