# EANyra in a container: web UI + scheduler (+ optional MCP over HTTP).
# See docs/DEPLOYMENT.md. Publish the port on the host loopback only:
#   docker run -p 127.0.0.1:4450:4450 ...
#
# The Playwright image ships Chromium and its system libraries for exactly this
# Playwright version (keep the tag in sync with package-lock.json).
FROM mcr.microsoft.com/playwright:v1.58.2-noble

ENV NODE_ENV=production \
    EANYRA_CONTAINER=1 \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=4450 \
    INSTANCE_DIR=/app/instance \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BROWSER_HEADLESS=true \
    BROWSER_LOGIN_CHANNEL=

WORKDIR /app

COPY package.json package-lock.json ./
# Install scripts stay on: sqlite3 fetches its native binary; the postinstall
# finds Chromium already present in /ms-playwright and downloads nothing.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY instance_example ./instance_example
COPY .env.example ./

# The instance (database, vault, accounts, context) lives on a volume.
RUN mkdir -p /app/instance && chown -R pwuser:pwuser /app/instance
USER pwuser
VOLUME ["/app/instance"]

EXPOSE 4450
CMD ["node", "src/core/cli/index.js", "serve", "--schedule"]
