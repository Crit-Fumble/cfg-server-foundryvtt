/**
 * Connection banner — which connection states it surfaces (#699).
 *
 * The banner is the one platform-wide surface every seat sees, so what it
 * shows is a deliberate choice, not a default. Only `offline` is
 * infrastructure-level; every credential outcome — `auth-failed` (dead key)
 * and `forbidden` (alive key, missing right) alike — stays silent here. A
 * missing scope on one courier must not paint a banner onto every player's
 * screen.
 */

import { jest } from '@jest/globals'

async function loadBanner() {
  jest.resetModules()
  return await import('../../scripts/views/connection-banner.js')
}

function fakeEl() {
  return { dataset: {}, style: {} }
}

describe('connection banner — which states surface', () => {
  it("shows on 'offline'", async () => {
    const { __internals } = await loadBanner()
    const el = fakeEl()
    __internals._refresh(el, { status: 'offline' })
    expect(el.dataset.visible).toBe('true')
    expect(el.style.display).toBe('block')
  })

  it.each(['forbidden', 'auth-failed', 'server-error', 'client-error', 'online', 'unknown'])(
    "stays hidden on '%s'",
    async (status) => {
      const { __internals } = await loadBanner()
      const el = fakeEl()
      __internals._refresh(el, { status, lastStatusCode: 403 })
      expect(el.dataset.visible).toBe('false')
      expect(el.style.display).toBe('none')
    },
  )
})
