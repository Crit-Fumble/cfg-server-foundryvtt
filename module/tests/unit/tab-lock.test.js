/**
 * services/tab-lock.js — one tab per browser runs the heartbeat + provision drain.
 */

import { jest } from '@jest/globals'
import { tabTurn } from '../../scripts/services/tab-lock.js'

describe('tabTurn — one tab per browser', () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true })
  afterEach(() => {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
    else delete globalThis.navigator
    jest.restoreAllMocks()
  })

  it('without navigator.locks every tab runs, as before', async () => {
    setNavigator({})
    await expect(tabTurn('w:u')).resolves.toBeUndefined()
    setNavigator(undefined)
    await expect(tabTurn('w:u')).resolves.toBeUndefined()
  })

  it('requests cfg-pollers:<world>:<user> and holds it for the life of the tab', async () => {
    let held
    const request = jest.fn((name, cb) => {
      held = cb()
      return held
    })
    setNavigator({ locks: { request } })
    await tabTurn('world1:user1')
    expect(request).toHaveBeenCalledWith('cfg-pollers:world1:user1', expect.any(Function))
    // The callback's promise is the lock lifetime: it must never settle.
    const outcome = await Promise.race([held.then(() => 'released'), new Promise((r) => setTimeout(() => r('held'), 20))])
    expect(outcome).toBe('held')
  })

  it('a second tab waits until the lock is granted', async () => {
    let grant
    setNavigator({
      locks: {
        request: (_name, cb) =>
          new Promise(() => {
            grant = cb
          }),
      },
    })
    let started = false
    tabTurn('w:u').then(() => {
      started = true
    })
    await Promise.resolve()
    expect(started).toBe(false)
    grant()
    await Promise.resolve()
    expect(started).toBe(true)
  })

  it('a lock that fails falls back to running here', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    setNavigator({ locks: { request: () => Promise.reject(new Error('SecurityError')) } })
    await expect(tabTurn('w:u')).resolves.toBeUndefined()
    setNavigator({
      locks: {
        request: () => {
          throw new Error('boom')
        },
      },
    })
    await expect(tabTurn('w:u')).resolves.toBeUndefined()
  })
})
