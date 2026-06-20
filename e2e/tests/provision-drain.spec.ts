import { test, expect } from '@playwright/test'
import { SERVICE_GM } from '../helpers/service-gm'
import { joinWorldAsUser } from '../helpers/foundry-admin'
import { startStubCoreApi, type StubCoreApi } from '../helpers/stub-core-api'

/**
 * In-repo rung 3: with ONLY the service-GM in the live world (no human GM), the
 * real cfg-foundry-plugin ProvisionDrain — the exact class a human GM's browser
 * runs — creates + confirms a queued player's Foundry User. Proven standalone: a
 * stub stands in for core-server's runtime-provision queue endpoints.
 */
const INSTALLATION_ID = 'e2e-install'
const QUEUED = {
  nativeUserId: 'E2EPlayerSeat01A', // 16-char [A-Za-z0-9]
  foundryUsername: 'E2E Player',
  role: 1, // PLAYER
  password: 'e2e-player-password',
}

let stub: StubCoreApi
test.beforeAll(async () => {
  stub = await startStubCoreApi([QUEUED])
})
test.afterAll(async () => {
  await stub?.close()
})

test('the in-world ProvisionDrain creates + confirms a queued player', async ({ page }) => {
  await joinWorldAsUser(page, SERVICE_GM.nativeUserId, SERVICE_GM.password)

  // Drive the REAL plugin ProvisionDrain once against the stub queue. (The drain
  // is idempotent — the user persists in the world across runs, so we assert the
  // post-state + the confirm rather than a "didn't exist before" precondition.)
  const created = await page.evaluate(
    async ({ stubUrl, installationId, queuedId }) => {
      const { CoreAPIClient } = await import('/modules/crit-fumble-core/scripts/clients/api-client.js')
      const { ProvisionDrain } = await import('/modules/crit-fumble-core/scripts/services/provision-drain.js')
      const drain = new ProvisionDrain(new CoreAPIClient(stubUrl, 'e2e-key'), installationId)
      await drain._tick()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u = (globalThis as any).game.users.get(queuedId)
      return u ? { name: u.name, role: u.role } : null
    },
    { stubUrl: stub.url, installationId: INSTALLATION_ID, queuedId: QUEUED.nativeUserId },
  )

  expect(created, 'queued player User created in-world by the drain').not.toBeNull()
  expect(created?.role).toBe(QUEUED.role)
  expect(stub.confirmedIds, 'drain confirmed the seat back to core').toContain(QUEUED.nativeUserId)
})
