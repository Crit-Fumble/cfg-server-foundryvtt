/**
 * Linked Campaigns dialog — what a failed campaigns load tells the GM.
 *
 * The dialog is where a rights 403 used to end as a bare "HTTP 403". With a
 * rights code the server has written the explanation FOR the user (which
 * right is missing, and never "re-pair"), so the dialog relays it; every
 * other failure keeps the status-only wording. The bodies below are verbatim
 * what cfg-core-server sends — file named on each — same as the fetchCfg
 * fixtures in connection-state.test.js.
 */

import { jest } from '@jest/globals'

async function loadDialog() {
  jest.resetModules()
  return await import('../../scripts/views/cfg-campaign-links.js')
}

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

function respond(status, text) {
  globalThis.fetch = jest.fn(async () => ({ ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text) }))
}

describe('CfgCampaignLinksDialog — _loadData failure copy', () => {
  beforeEach(() => {
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: 'cfk_secret', installationId: 'inst_1' })
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { origin: 'https://foundry.local' }
    game.user.isGM = true
  })

  it('relays the server explanation on a 403 INSTALLATION_OWNER_REQUIRED — not "HTTP 403", not a re-pair', async () => {
    // cfg-core-server src/routes/v1/account/foundry-installed-modules.ts (+ foundry-system-schema.ts twin)
    respond(
      403,
      '{"error":"Installation-level sync is owner-only — this key is bound to an installation you do not own","code":"INSTALLATION_OWNER_REQUIRED"}',
    )
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe(
      "Couldn't load campaigns: Installation-level sync is owner-only — this key is bound to an installation you do not own",
    )
    expect(dialog.errorMessage).not.toMatch(/HTTP 403|re-pair|regenerate/i)
    expect(dialog.campaigns).toEqual([])
    expect(dialog.loading).toBe(false)
  })

  it('relays the server explanation on a 403 SCOPE_REQUIRED', async () => {
    // cfg-core-server src/routes/v1/_lib/auth.ts, requireScope / requireScopeIfApiKey
    respond(403, '{"error":"Scope required: foundry:write","code":"SCOPE_REQUIRED","scope":"foundry:write"}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe("Couldn't load campaigns: Scope required: foundry:write")
  })

  it('keeps "HTTP 403" for a 403 with code FORBIDDEN — the unbound-key case where re-pairing IS the answer', async () => {
    // cfg-core-server src/routes/v1/account/foundry-installed-modules.ts, key bound to no installation
    respond(403, '{"error":"API key is not bound to a Foundry installation — re-pair the plugin","code":"FORBIDDEN"}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe("Couldn't load campaigns: HTTP 403")
  })

  it('keeps the status-only wording for a 401 and a 5xx', async () => {
    const { CfgCampaignLinksDialog } = await loadDialog()

    respond(401, '{"error":"Invalid API key"}')
    let dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()
    expect(dialog.errorMessage).toBe("Couldn't load campaigns: HTTP 401")

    respond(503, 'Service Unavailable')
    dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()
    expect(dialog.errorMessage).toBe("Couldn't load campaigns: HTTP 503")
  })

  it('names the reason when there is no status at all (offline)', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.')
    })
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe("Couldn't load campaigns: offline")
  })

  it('loads the campaign list on a 2xx', async () => {
    respond(200, '{"data":[{"id":"c1","name":"Tomb"}]}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBeNull()
    expect(dialog.campaigns).toEqual([{ id: 'c1', name: 'Tomb' }])
    expect(dialog.installationId).toBe('inst_1')
  })
})
