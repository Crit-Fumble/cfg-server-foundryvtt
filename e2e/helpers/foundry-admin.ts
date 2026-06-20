import { request as pwRequest } from '@playwright/test'

/**
 * Admin-side helpers for the standalone Foundry wrapper — the same `/auth` →
 * `launchWorld` handshake core-server's loadWorldViaAdminApi uses. FOUNDRY_WORLD
 * baking does NOT activate a world in Foundry 14 (it only writes options.world),
 * so the harness launches the world explicitly via the admin API.
 */

const ADMIN_KEY = process.env.FOUNDRY_ADMIN_KEY ?? 'e2eadminkey000000'

/**
 * Authenticate as the Foundry admin and activate `worldId`. Idempotent: once a
 * world is loaded, a re-launch comes back 302/403 (Foundry's "a world is already
 * loaded" response), which we treat as success.
 */
export async function launchWorld(baseURL: string, worldId: string): Promise<void> {
  const ctx = await pwRequest.newContext({ baseURL })
  try {
    // 1. anonymous session cookie (the context's jar carries it forward)
    await ctx.get('/auth')
    // 2. admin auth — Foundry 302s on both success and failure; the context jar
    //    picks up the rotated session cookie from the Set-Cookie either way.
    await ctx.post('/auth', { form: { adminPassword: ADMIN_KEY, adminKey: ADMIN_KEY } })
    // 3. launch the world (Foundry's setup-UI submit shape)
    const r = await ctx.post('/setup', {
      form: { action: 'launchWorld', world: worldId },
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      maxRedirects: 0,
    })
    const status = r.status()
    if (![200, 302, 403].includes(status)) {
      throw new Error(`launchWorld(${worldId}) failed: HTTP ${status} ${(await r.text()).slice(0, 200)}`)
    }
  } finally {
    await ctx.dispose()
  }
}

/**
 * Poll `/join` until the world is active. While no world is loaded Foundry serves
 * its "no active game session" page; once the world is live the join form renders.
 */
export async function waitForWorldActive(baseURL: string, timeoutMs = 90_000): Promise<void> {
  const ctx = await pwRequest.newContext({ baseURL })
  const start = Date.now()
  try {
    for (;;) {
      const r = await ctx.get('/join').catch(() => null)
      const body = r ? await r.text().catch(() => '') : ''
      if (r && r.ok() && !body.includes('no active game session')) return
      if (Date.now() - start > timeoutMs) {
        throw new Error(`world did not become active within ${timeoutMs}ms (last status ${r?.status() ?? 'none'})`)
      }
      await new Promise((res) => setTimeout(res, 2000))
    }
  } finally {
    await ctx.dispose()
  }
}
