/**
 * One tab per browser sends the GM-presence beacon (module.js); without it, every tab a GM has
 * open on the world would send one. `tabTurn()` resolves only in the tab holding a Web Lock,
 * which it never releases; the browser hands the lock to the next waiting tab when the holder
 * closes, so the role moves without any coordination of ours.
 *
 * The lock name is per world AND per user: two GMs in one browser each keep their own beacon.
 *
 * Where `navigator.locks` is missing (an insecure origin, an old browser) every tab runs: a lock
 * we cannot take must never silence the beacon, because an inactive world with no GM seen stops.
 */

'use strict'

const LOG = 'CFG Core | tab lock'

/**
 * Resolves once this tab holds the lock for `key`. Never rejects.
 *
 * @param {string} key  e.g. `${game.world.id}:${game.user.id}`
 * @returns {Promise<void>}
 */
export function tabTurn(key) {
  const locks = globalThis.navigator?.locks
  if (typeof locks?.request !== 'function') return Promise.resolve()
  return new Promise((granted) => {
    const fallback = (err) => {
      console.warn(`${LOG} failed, running in this tab:`, err?.message || err)
      granted()
    }
    try {
      // The callback's promise never settles, so the lock is held for the life of the tab.
      locks
        .request(`cfg-pollers:${key}`, () => {
          granted()
          return new Promise(() => {})
        })
        .catch(fallback)
    } catch (err) {
      fallback(err)
    }
  })
}
