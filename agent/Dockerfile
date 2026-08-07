# Service-GM drain driver — a one-shot headless Chromium container the platform
# spawns (sibling to a Foundry container) to drain the runtime-provision queue
# when a live world has invited players but no human GM connected. Kept OFF the
# wrapper image; launched on demand, reaped on exit (AutoRemove).
#
# Chromium-ONLY on a slim Node base — NOT the full mcr.microsoft.com/playwright
# image, which also ships Firefox + WebKit (the real on-disk delta is ~848MB ->
# ~650MB). Uses Playwright's OWN bundled Chromium. The hand-picked apt libs are
# Chromium's runtime deps — lighter than `playwright install --with-deps`.
#
# Base pinned by DIGEST, same rule as the wrapper's felddy base. A `v*` tag
# republishes :latest, and kind-image.ts pulls :latest with imagePull: always on
# EVERY user container launch — so a floating `22-bookworm-slim` would let a tag
# that changes no source still ship a different image to a live game night. This
# is the OCI index digest, so buildx still resolves the linux/amd64 child.
# Bump deliberately:
#   docker buildx imagetools inspect node:22-bookworm-slim   # take the top Digest
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# ⚠️ The base digest above pins ONLY the base. Playwright is the other half, and
# it decides which Chromium `playwright install` downloads — so an unpinned range
# floats the browser this driver steers Foundry with, one layer BELOW a file that
# reads as pinned. That is exactly what happened at v0.3.0: `^1.49.0` re-resolved
# 1.61.0 -> 1.62.1 and swapped Chromium 149 -> 151, a jump no test had seen, onto
# a `:latest` the launcher pulls with imagePull: always.
#
# So: an EXACT version + a committed package-lock.json + `npm ci` (which fails,
# rather than silently resolving, if the two disagree). The pin tracks the root
# package-lock.json, because e2e/tests/driver.spec.ts runs driver.mjs from the
# HOST — so the root lock is the Playwright that has actually driven Foundry.
# ⚠️ Bump BOTH together, and re-run `npm run e2e`; they are one decision.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install chromium \
 && rm -rf /root/.npm

COPY driver.mjs ./

# Non-root (defense in depth — this session is role-4 and loads arbitrary
# world/module JS). The browsers live in /ms-playwright (world-readable).
USER node

ENTRYPOINT ["node", "driver.mjs"]
