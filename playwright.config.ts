import { defineConfig } from '@playwright/test'

/**
 * e2e config for the cfg-server-foundryvtt wrapper. The standalone Foundry
 * container (e2e/compose.yml) publishes 30000 on the host port below; these
 * tests drive a real browser against it to prove the wrapper serves Foundry.
 * Orchestration (compose up/down) is handled by e2e/run.sh, not webServer,
 * so a failed test still tears the container down.
 */
const PORT = process.env.E2E_FOUNDRY_PORT ?? '30001'

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['line']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
})
