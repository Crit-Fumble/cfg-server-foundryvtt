# Service-GM drain driver — a one-shot headless Chromium container the platform
# spawns (sibling to a Foundry container) to drain the runtime-provision queue
# when a live world has invited players but no human GM connected. Kept OFF the
# wrapper image; launched on demand, reaped on exit (AutoRemove).
#
# Chromium-ONLY on a slim Node base — NOT the full mcr.microsoft.com/playwright
# image, which also ships Firefox + WebKit (the real on-disk delta is ~848MB ->
# ~650MB). Uses Playwright's OWN bundled Chromium so it stays the exact build the
# e2e validates against Foundry. The hand-picked apt libs are Chromium's runtime
# deps — lighter than `playwright install --with-deps`.
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright install chromium \
 && rm -rf /root/.npm

COPY driver.mjs ./

# Non-root (defense in depth — this session is role-4 and loads arbitrary
# world/module JS). The browsers live in /ms-playwright (world-readable).
USER node

ENTRYPOINT ["node", "driver.mjs"]
