# One small image for the whole backend: API, stream listener and background jobs.
# Deliberately portable (plain Node, no platform SDK), so it runs on Railway or any container host.
FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app

# Lockfile only, so the layer caches: there are no runtime dependencies yet (phase 2 adds pg).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY public/ ./public/

# Map tiles and sounds (npm run assets, about 120 MB) stay out of the image: Cloudflare serves them.
# su-exec drops root in the entrypoint once the mounted volume's ownership has been fixed.
RUN apk add --no-cache su-exec \
  && mkdir -p /data && chown -R node:node /data /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
