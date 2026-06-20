import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { SERVICE_GM } from '../helpers/service-gm'
import { startStubCoreApi, type StubCoreApi } from '../helpers/stub-core-api'

/**
 * In-repo rung 4: the PRODUCTION driver (agent/driver.mjs) — the standalone
 * one-shot the platform will spawn as a sibling container — joins the live world
 * as the service-GM and drains a queued player. Same drain the rung-3 spec
 * drives inline, but exercised through the real driver entrypoint (its own
 * Chromium, env-configured), proving the deployable artifact works.
 */
const execFileP = promisify(execFile)
const PORT = process.env.E2E_FOUNDRY_PORT ?? '30001'
const INSTALLATION_ID = 'e2e-install'
const QUEUED = {
  nativeUserId: 'E2EDriverSeat001', // 16-char [A-Za-z0-9]
  foundryUsername: 'Driver Player',
  role: 1,
  password: 'e2e-driver-password',
}

let stub: StubCoreApi
test.beforeAll(async () => {
  stub = await startStubCoreApi([QUEUED])
})
test.afterAll(async () => {
  await stub?.close()
})

test('the production service-GM driver joins + drains the queue', async () => {
  const driver = join(process.cwd(), 'agent', 'driver.mjs')
  const { stdout } = await execFileP('node', [driver], {
    env: {
      ...process.env,
      FOUNDRY_URL: `http://localhost:${PORT}`,
      SERVICE_GM_USERID: SERVICE_GM.nativeUserId,
      SERVICE_GM_PASSWORD: SERVICE_GM.password,
      CORE_API_URL: stub.url,
      // A key makes CoreAPIClient send Authorization: Bearer (no cookies), so the
      // stub can answer with Allow-Origin:* — credentialed CORS (no key) can't.
      // Production supplies the real installation/paired key here.
      CORE_API_KEY: 'e2e-key',
      INSTALLATION_ID,
      DRAIN_IDLE_TICKS: '2',
      DRAIN_INTERVAL_MS: '1000',
    },
    timeout: 150_000,
  })

  // The driver ran the real plugin drain and confirmed the seat back to (stub) core.
  expect(stdout).toContain('drain idle')
  expect(stub.confirmedIds, 'driver confirmed the queued seat').toContain(QUEUED.nativeUserId)
})
