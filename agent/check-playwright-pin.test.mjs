/**
 * Tests for the Playwright pin guard.
 *
 * The cases that matter are the ones that must FAIL. A guard whose tests only
 * assert the happy path is the same shape as the check it replaces: agreement
 * with nothing, reported as agreement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { comparePins } from './check-playwright-pin.mjs'

const AGENT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(AGENT_DIR, 'check-playwright-pin.mjs')

/** The all-agree baseline; each test perturbs one field. */
const AGREED = { agentSpec: '1.61.0', agentLock: '1.61.0', rootLock: '1.61.0' }

test('three agreeing exact pins are clean', () => {
  assert.deepEqual(comparePins(AGREED), [])
})

test('a drifted ROOT lock is caught — the gap npm ci cannot see', () => {
  // `npm ci` compares agent/package.json to agent/package-lock.json only, so
  // this exact divergence builds green and ships a Playwright no e2e run has
  // exercised. It is the reason this file exists.
  const problems = comparePins({ ...AGREED, rootLock: '1.62.1' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /pins disagree/)
  assert.match(problems[0], /1\.62\.1/)
})

test('a drifted AGENT pair is caught too — drift is not one-directional', () => {
  const problems = comparePins({ agentSpec: '1.62.1', agentLock: '1.62.1', rootLock: '1.61.0' })
  assert.match(problems[0], /pins disagree/)
})

test('a caret range fails even when every resolved version agrees', () => {
  // v0.3.0 verbatim: the lock said 1.61.0 and the spec said ^1.49.0, so the
  // next install re-resolved and Chromium moved underneath a pinned-looking file.
  const problems = comparePins({ ...AGREED, agentSpec: '^1.61.0' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /must be an EXACT version/)
})

test('a tilde range is a range as well', () => {
  assert.match(comparePins({ ...AGREED, agentSpec: '~1.61.0' })[0], /EXACT/)
})

test('an unreadable lock entry FAILS instead of skipping', () => {
  // "Could not verify" must never render as "verified". Same rule the registry
  // 401 broke when it arrived disguised as an unreachable network.
  assert.match(comparePins({ ...AGREED, rootLock: null })[0], /cannot verify the pin/)
  assert.match(comparePins({ ...AGREED, agentLock: null })[0], /cannot verify the pin/)
})

test('a missing lock entry does not also report a bogus mismatch', () => {
  // One clear cause, not two — the mismatch message would name `null` as a
  // version and send the reader looking for a pin nobody set.
  const problems = comparePins({ ...AGREED, rootLock: null })
  assert.equal(problems.length, 1)
})

test('a missing dependency is named as such', () => {
  assert.match(comparePins({ ...AGREED, agentSpec: null })[0], /declares no/)
})

test('the real repo agrees — run against the committed files', () => {
  // The offline cases above prove the LOGIC; this proves the repo currently
  // satisfies it, which is the claim the Dockerfile comment makes in prose.
  const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' })
  assert.match(out, /✓ @playwright\/test pinned at/)
})

test('importing the module runs no check and prints nothing', () => {
  // A guard that executes on import cannot be unit-tested, and would fire
  // inside unrelated tooling that merely imports it.
  const out = execFileSync('node', ['-e', `import(${JSON.stringify(resolve(SCRIPT))}).then(() => console.log('QUIET'))`], {
    encoding: 'utf8',
  })
  assert.equal(out.trim(), 'QUIET')
})
