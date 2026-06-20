# Service-GM drain driver — a one-shot headless Playwright+Chromium container the
# platform spawns (sibling to a Foundry container) to drain the runtime-provision
# queue when a live world has invited players but no human GM connected. Kept OFF
# the wrapper image (Chromium is ~300-500MB) and launched on demand, reaped on
# exit (AutoRemove). The base image already ships Chromium + its deps, pinned to
# the @playwright/test version the driver uses.
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY driver.mjs ./

# The base image ships the non-root `pwuser`; run as it (defense in depth — this
# session is role-4 and loads arbitrary world/module JS).
USER pwuser

ENTRYPOINT ["node", "driver.mjs"]
