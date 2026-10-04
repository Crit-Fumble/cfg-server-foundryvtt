/**
 * Cross-origin journal iframes keep working but cannot navigate the tab (cs#455).
 *
 * The owner's constraint: 5e.tools and Google Docs / Sheets / Maps embeds in journal
 * pages must keep working. So the sandbox keeps scripts, same-origin storage, popups
 * and forms, and drops only top navigation (and modals). It never widens a sandbox
 * Foundry already set, and it leaves Foundry's own same-origin frames alone.
 */
import { jest } from '@jest/globals'
import {
  EXTERNAL_IFRAME_SANDBOX,
  externalIframeAttributes,
  hardenExternalIframes,
} from '../../scripts/views/journal-iframes.js'

const PAGE = 'https://foundryvtt.crit-fumble.com'
const FULL = EXTERNAL_IFRAME_SANDBOX.join(' ')

describe('externalIframeAttributes', () => {
  it.each([
    ['5e.tools', 'https://5e.tools/bestiary.html#goblin_mm'],
    ['Google Docs', 'https://docs.google.com/document/d/e/2PACX-abc/pub?embedded=true'],
    ['Google Sheets', 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml?widget=true'],
    ['Google Maps', 'https://www.google.com/maps/embed?pb=!1m18'],
  ])('%s with no sandbox → the full allowlist + no-referrer', (_label, src) => {
    expect(externalIframeAttributes(src, PAGE, null)).toEqual({ sandbox: FULL, referrerpolicy: 'no-referrer' })
  })

  it('the allowlist keeps the embeds working and blocks only top navigation', () => {
    for (const keep of ['allow-scripts', 'allow-same-origin', 'allow-popups', 'allow-forms']) {
      expect(EXTERNAL_IFRAME_SANDBOX).toContain(keep)
    }
    expect(FULL).not.toMatch(/allow-top-navigation/)
    expect(FULL).not.toMatch(/allow-modals/)
  })

  it('never WIDENS a sandbox Foundry already set (its untrusted-host default)', () => {
    expect(externalIframeAttributes('https://5e.tools/x', PAGE, 'allow-scripts allow-forms')).toEqual({
      sandbox: 'allow-scripts allow-forms',
      referrerpolicy: 'no-referrer',
    })
  })

  it('drops top-navigation tokens a GM wrote into the sandbox', () => {
    const got = externalIframeAttributes('https://5e.tools/x', PAGE, 'allow-scripts allow-top-navigation ALLOW-SAME-ORIGIN')
    expect(got.sandbox).toBe('allow-scripts allow-same-origin')
  })

  it('an empty sandbox stays empty (the strictest one)', () => {
    expect(externalIframeAttributes('https://5e.tools/x', PAGE, '').sandbox).toBe('')
  })

  it.each([
    ['youtube.com', 'https://www.youtube.com/embed/abc'],
    ['youtube-nocookie.com', 'https://www.youtube-nocookie.com/embed/abc'],
  ])('%s gets strict-origin — its player refuses an embed with no Referer', (_label, src) => {
    expect(externalIframeAttributes(src, PAGE, null).referrerpolicy).toBe('strict-origin')
  })

  it('a lookalike of youtube is not youtube', () => {
    expect(externalIframeAttributes('https://notyoutube.com/embed/abc', PAGE, null).referrerpolicy).toBe('no-referrer')
  })

  it.each([
    ['a relative path (Foundry’s own pdf.js viewer)', 'scripts/pdfjs/web/viewer.html?file=x.pdf'],
    ['an absolute same-origin URL', `${PAGE}/servers/foundryvtt/w/scripts/pdfjs/web/viewer.html`],
    ['about:blank', 'about:blank'],
    ['a data: URL', 'data:text/html,<p>hi</p>'],
    ['javascript:', 'javascript:alert(1)'],
    ['an empty src', ''],
    ['no src', null],
  ])('leaves %s alone', (_label, src) => {
    expect(externalIframeAttributes(src, PAGE, null)).toBeNull()
  })
})

/** A frame the guard can read and write, with the navigations it would cause. */
function fakeFrame(attrs, { connected = true } = {}) {
  const a = new Map(Object.entries(attrs))
  const navigations = []
  return {
    isConnected: connected,
    navigations,
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    setAttribute: jest.fn((k, v) => {
      a.set(k, String(v))
      if (k === 'src') navigations.push(String(v))
    }),
  }
}
const rootOf = (...frames) => ({ querySelectorAll: () => frames })

describe('hardenExternalIframes', () => {
  it('sets both attributes and RE-NAVIGATES a connected frame, so the sandbox applies now', () => {
    const f = fakeFrame({ src: 'https://5e.tools/x' })
    expect(hardenExternalIframes(rootOf(f), PAGE)).toBe(1)
    expect(f.getAttribute('sandbox')).toBe(FULL)
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(f.navigations).toEqual(['https://5e.tools/x'])
  })

  it('a DETACHED frame (first render) is not reloaded: it has not started loading', () => {
    const f = fakeFrame({ src: 'https://5e.tools/x' }, { connected: false })
    hardenExternalIframes(rootOf(f), PAGE)
    expect(f.getAttribute('sandbox')).toBe(FULL)
    expect(f.navigations).toEqual([])
  })

  it('an already-hardened frame is left alone — a re-render does not reload it again', () => {
    const f = fakeFrame({ src: 'https://5e.tools/x', sandbox: FULL, referrerpolicy: 'no-referrer' })
    expect(hardenExternalIframes(rootOf(f), PAGE)).toBe(0)
    expect(f.setAttribute).not.toHaveBeenCalled()
  })

  it('touches only the cross-origin frames', () => {
    const pdf = fakeFrame({ src: 'scripts/pdfjs/web/viewer.html?file=a.pdf' })
    const doc = fakeFrame({ src: 'https://docs.google.com/document/d/e/x/pub?embedded=true' })
    expect(hardenExternalIframes(rootOf(pdf, doc), PAGE)).toBe(1)
    expect(pdf.setAttribute).not.toHaveBeenCalled()
    expect(doc.getAttribute('sandbox')).toBe(FULL)
  })

  it('tolerates no root', () => {
    expect(hardenExternalIframes(null, PAGE)).toBe(0)
  })
})
