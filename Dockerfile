# syntax=docker/dockerfile:1

# --- Builder stage: fetch sources and install deps ---
FROM node:22-alpine AS builder

ARG GIT_REPO=https://github.com/iptv-org/epg.git
ARG GIT_BRANCH=master

WORKDIR /epg

# Only the builder needs git to fetch sources
RUN apk add --no-cache git

# Clone requested branch with shallow history
RUN git clone --depth 1 -b "$GIT_BRANCH" "$GIT_REPO" .

# Overlay our PM2 config (kept in this repo) onto upstream sources
COPY pm2.config.js ./pm2.config.js

# Install dependencies (respect lockfile if present)
ENV npm_config_update_notifier=false \
    npm_config_fund=false
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Remove VCS data to keep copy size small
RUN rm -rf .git


# --- Runtime stage: minimal files needed to run ---
FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    CRON_SCHEDULE="0 0 * * *" \
    GZIP=false \
    MAX_CONNECTIONS=1 \
    DAYS= \
    RUN_AT_STARTUP=true

WORKDIR /epg

# Optional: timezone data for correct scheduling
RUN apk add --no-cache tzdata

# Copy only the essentials from builder
COPY --from=builder /epg/node_modules ./node_modules
COPY --from=builder /epg/scripts ./scripts
COPY --from=builder /epg/sites ./sites
COPY --from=builder /epg/package.json ./package.json
COPY --from=builder /epg/tsconfig.json ./tsconfig.json
COPY pm2.config.js ./pm2.config.js

# Static files directory served by the app
RUN mkdir -p /epg/public && chown -R node:node /epg

EXPOSE 3000

# Drop root privileges
USER node

# Use local pm2 from node_modules to avoid global installs
CMD [ "./node_modules/.bin/pm2-runtime", "pm2.config.js" ]
