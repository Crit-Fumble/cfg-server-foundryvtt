import { launchWorld, waitForWorldActive } from './helpers/foundry-admin'

/**
 * Activate the seeded test world before the suite runs. The wrapper boots into
 * setup mode (Foundry 14 doesn't auto-launch from options.world), so we drive
 * the admin-API launch once, here, for every spec to share.
 */
const PORT = process.env.E2E_FOUNDRY_PORT ?? '30001'
const BASE = `http://localhost:${PORT}`
const WORLD = process.env.FOUNDRY_WORLD ?? 'test-world'

export default async function globalSetup(): Promise<void> {
  await launchWorld(BASE, WORLD)
  await waitForWorldActive(BASE)
  // eslint-disable-next-line no-console
  console.log(`[e2e] world '${WORLD}' is active`)
}
