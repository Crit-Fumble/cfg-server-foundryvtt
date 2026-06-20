import { join } from 'node:path'
import { launchWorld, waitForWorldActive } from './helpers/foundry-admin'
import { seedFoundryUser, resolveUsersDir } from './helpers/foundry-users'
import { SERVICE_GM } from './helpers/service-gm'

/**
 * Prepare the world before the suite runs:
 *  1. seed the service-GM role-4 doc on disk while the world is OFFLINE (Foundry
 *     locks users/ once active, so this has to happen before launch);
 *  2. activate the world via the admin API (Foundry 14 doesn't auto-launch from
 *     options.world).
 */
const PORT = process.env.E2E_FOUNDRY_PORT ?? '30001'
const BASE = `http://localhost:${PORT}`
const WORLD = process.env.FOUNDRY_WORLD ?? 'test-world'
// run.sh runs playwright from the repo root, so the data dir is e2e/.e2e-data.
const E2E_DATA = join(process.cwd(), 'e2e', '.e2e-data')

export default async function globalSetup(): Promise<void> {
  await seedFoundryUser(resolveUsersDir(E2E_DATA, WORLD), { ...SERVICE_GM })
  await launchWorld(BASE, WORLD)
  await waitForWorldActive(BASE)
  // eslint-disable-next-line no-console
  console.log(`[e2e] world '${WORLD}' active; service-GM doc seeded`)
}
