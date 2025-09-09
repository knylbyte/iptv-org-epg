# --- Global ARGs ---
ARG NODE_IMAGE=:22-alpine

# --- Builder stage: use local repo and install deps ---
FROM node:${NODE_IMAGE} AS builder

WORKDIR /epg

# Keep npm quiet and deterministic
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

# Copy lockfile and manifest first to leverage Docker cache
COPY package*.json ./

# Install only production deps, skip lifecycle scripts
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  || npm install --omit=dev --ignore-scripts --no-audit --no-fund

# Copy only runtime-relevant sources
COPY scripts ./scripts
COPY sites ./sites
COPY pm2.config.js ./pm2.config.js
COPY tsconfig.json ./tsconfig.json


# --- Runtime stage: minimal files needed to run ---
FROM node:${NODE_IMAGE} AS runner

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
COPY --from=builder /epg/pm2.config.js ./pm2.config.js

# Static files directory served by the app
RUN mkdir -p /epg/public && chown -R node:node /epg

EXPOSE 3000

# Drop root privileges
USER node

# Use local pm2 from node_modules to avoid global installs
CMD [ "./node_modules/.bin/pm2-runtime", "pm2.config.js" ]
