/**
 * Tests for the module version bump guard.
 *
 * The cases that matter are the ones that must FAIL, and the ones that must NOT
 * — a guard that demands a bump for every release trains people to bump
 * meaninglessly, which is its own kind of broken.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decideVersionBump, PACKED_PATHSPECS } from './check-version-bump.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(MODULE_DIR, 'check-version-bump.mjs')

/** A released 3.0.0, with a packed file changed since — the bump-required shape. */
const CHANGED = {
  localVersion: '3.1.0',
  baseline: { tag: 'v0.3.1', version: '3.0.0' },
  changedPackedFiles: ['module/scripts/module.js'],
}

test('a bumped version over a changed packed tree is clean', () => {
  assert.deepEqual(decideVersionBump(CHANGED), [])
})

test('a changed packed tree with an UNCHANGED version fails — the whole point', () => {
  // Self-hosted Foundry compares the manifest version to decide an update
  // exists. Shipping code under the same version leaves them on the old build
  // while Foundry reports them up to date.
  const problems = decideVersionBump({ ...CHANGED, localVersion: '3.0.0' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /version is unchanged at 3\.0\.0/)
  assert.match(problems[0], /SELF-HOSTED/)
  assert.match(problems[0], /module\/scripts\/module\.js/)
})

test('a BACKWARDS version fails too, and says so distinctly', () => {
  const problems = decideVersionBump({ ...CHANGED, localVersion: '2.48.3' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /goes BACKWARDS to 2\.48\.3/)
  assert.match(problems[0], /released: 3\.0\.0/)
})

test('an UNCHANGED packed tree needs no bump — v0.3.1 verbatim', () => {
  // v0.3.1 shipped an agent Playwright pin and touched zero module files.
  // Demanding a module bump there would be wrong, and would make every release
  // churn the version for nothing.
  assert.deepEqual(decideVersionBump({ ...CHANGED, localVersion: '3.0.0', changedPackedFiles: [] }), [])
})

test('no baseline at all is a genuine pass, not a hidden skip', () => {
  // Tags before the module moved here (v0.1.0, v0.2.0) are wrapper-only.
  assert.deepEqual(decideVersionBump({ localVersion: '3.0.0', baseline: null, changedPackedFiles: [] }), [])
})

test('a baseline whose manifest could not be READ fails instead of passing', () => {
  // "Could not verify" must never render as "verified" — the same collapse that
  // let a 403 render as a clean board and an `abandoned` job render as success.
  const problems = decideVersionBump({
    ...CHANGED,
    baseline: { tag: 'v0.3.1', version: null },
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cannot verify the bump, so this is a FAILURE, not a skip/)
})

test('an unreadable baseline is reported even when nothing changed', () => {
  // Otherwise a broken baseline hides behind the legitimate "no changes" pass
  // and the guard silently stops guarding.
  const problems = decideVersionBump({
    localVersion: '3.0.0',
    baseline: { tag: 'v0.3.1', version: null },
    changedPackedFiles: [],
  })
  assert.match(problems[0], /cannot verify/)
})

test('a missing local version is named as such', () => {
  assert.match(decideVersionBump({ ...CHANGED, localVersion: null })[0], /declares no "version"/)
})

test('a non-semver local version fails — Foundry cannot order it', () => {
  const problems = decideVersionBump({ ...CHANGED, localVersion: 'v3' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not a major\.minor\.patch semver/)
})

test('a non-semver RELEASED version is reported as unorderable, not as agreement', () => {
  const problems = decideVersionBump({ ...CHANGED, baseline: { tag: 'v0.3.1', version: 'latest' } })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cannot order/)
})

test('ordering is numeric, not lexicographic', () => {
  // '3.10.0' < '3.9.0' as strings. A string compare here would reject a real
  // bump and, worse, accept a real regression.
  assert.deepEqual(decideVersionBump({ ...CHANGED, localVersion: '3.10.0', baseline: { tag: 'v1', version: '3.9.0' } }), [])
  assert.match(
    decideVersionBump({ ...CHANGED, localVersion: '3.9.0', baseline: { tag: 'v1', version: '3.10.0' } })[0],
    /goes BACKWARDS/,
  )
})

test('a prerelease suffix orders on its numeric core rather than failing', () => {
  assert.deepEqual(decideVersionBump({ ...CHANGED, localVersion: '3.1.0-rc.1' }), [])
})

test('the watched pathspecs mirror build-zip PACK_DIRS/PACK_FILES', () => {
  // If the packer starts shipping a new directory and this list does not follow,
  // changes to it ship unversioned — the exact hole this guard exists to close.
  const packer = execFileSync('node', ['-e', `
    import(${JSON.stringify(resolve(MODULE_DIR, 'scripts/build-zip.js'))})
  `], { encoding: 'utf8', cwd: MODULE_DIR })
  assert.match(packer, /wrote \d+ files/)

  const src = execFileSync('cat', [join(MODULE_DIR, 'scripts/build-zip.js')], { encoding: 'utf8' })
  const dirs = /const PACK_DIRS = \[([^\]]*)\]/.exec(src)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))
  const files = /const PACK_FILES = \[([^\]]*)\]/.exec(src)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))
  for (const entry of [...dirs, ...files]) {
    assert.ok(
      PACKED_PATHSPECS.includes(`module/${entry}`),
      `build-zip packs "${entry}" but PACKED_PATHSPECS does not watch module/${entry}`,
    )
  }
})

test('the real repo satisfies the guard — run against the committed tree', () => {
  const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' })
  assert.match(out, /^✓ module /m)
})

test('importing the module runs no check and prints nothing', () => {
  const out = execFileSync('node', ['-e', `import(${JSON.stringify(resolve(SCRIPT))}).then(() => console.log('QUIET'))`], {
    encoding: 'utf8',
  })
  assert.equal(out.trim(), 'QUIET')
})
