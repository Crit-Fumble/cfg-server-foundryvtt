#!/usr/bin/env node
/**
 * Module version bump guard — `module/module.json` version ↔ the packed tree.
 *
 * ## Why this exists
 *
 * `module.json`'s own `manifest`/`download` URLs point at
 * `releases/latest/download/`, so uploading a release IS publishing the module.
 * There is no separate publish step, and no staging tier between a `v*` tag and
 * a live game. What there also was, until 2026-08-10, was nothing at all
 * checking that the VERSION moved when the code did.
 *
 * The two consumers fail differently, and only one of them fails loudly:
 *
 *   - CFG-HOSTED worlds are fine by accident. `syncCfgPlugin` calls
 *     `ingestPackage(..., { force: true })` on every launch, so it reinstalls
 *     unconditionally and never consults the version.
 *   - SELF-HOSTED worlds are not. Foundry decides whether an update exists by
 *     comparing the installed version against the manifest's. Ship a fix without
 *     bumping `version` and every self-hosted install stays on the old code
 *     forever, with Foundry cheerfully reporting it is up to date. The module's
 *     own description advertises self-hosted support, so this is a real audience.
 *
 * That is the house failure mode verbatim: not a red check, but a green one over
 * a thing that never happened. This repo has paid for version drift twice
 * already (fp#47: 2.13.0 vs 2.14.0; dt#268: 2.42.0 vs 2.48.0).
 *
 * ## Why it keys on the PACKED tree, not on "was there a release"
 *
 * Requiring a bump on every `v*` tag would be wrong and would train people to
 * bump meaninglessly. v0.3.1 is the proof: it shipped an agent Playwright pin
 * and touched zero module files. A release that does not change what Foundry
 * loads does not need a new module version.
 *
 * So the rule is the narrow one: if anything `build-zip.js` actually PACKS has
 * changed since the last release, the version must have moved forward. The
 * watched set mirrors PACK_DIRS/PACK_FILES exactly, minus build-zip.js, which
 * lives under scripts/ but is excluded from the zip.
 *
 * ## Where it runs
 *
 * CI Gate, on pushes and PRs to main/next — deliberately BEFORE the tag exists.
 * Catching this at release time would mean deleting and re-cutting a pushed tag.
 *
 * Pure + offline: `decideVersionBump` takes the three facts and returns
 * problems, so every interesting case is testable without git, a network or a
 * release.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(MODULE_DIR, '..')

/**
 * Everything `build-zip.js` packs, expressed as git pathspecs from the repo
 * root. Keep in lockstep with PACK_DIRS + PACK_FILES over there.
 *
 * `build-zip.js` is excluded for the same reason the packer excludes it: it is
 * the build script, not module runtime, and Foundry never loads it. Without the
 * exclusion, editing this guard's sibling would demand a module version bump.
 */
export const PACKED_PATHSPECS = [
  'module/module.json',
  'module/scripts',
  'module/styles',
  'module/lang',
  ':(exclude)module/scripts/build-zip.js',
]

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/

/** `[major, minor, patch]`, or null when the string is not a semver we can order. */
function parseSemver(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v) : null
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** -1 / 0 / 1, or null when either side is unorderable. */
function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/**
 * The whole decision, as a pure function.
 *
 * `baseline` is the last release we are comparing against:
 *   null                        — no release carries a module yet; nothing to
 *                                 compare, and that is a genuine pass, not a skip
 *                                 that hides a failure.
 *   { tag, version: null }      — a release exists but its manifest could not be
 *                                 read. FAILURE. "Could not verify" and "verified"
 *                                 must never collapse into the same verdict.
 *   { tag, version: '3.0.0' }   — compare.
 *
 * `changedPackedFiles` is what changed in the packed tree since `baseline.tag`.
 * Empty means this change ships nothing Foundry loads, so the version may stand.
 */
export function decideVersionBump({ localVersion, baseline, changedPackedFiles }) {
  const problems = []

  if (!localVersion) {
    problems.push('module/module.json declares no "version" — the manifest is the ONLY version source')
    return problems
  }
  if (!parseSemver(localVersion)) {
    problems.push(
      `module/module.json version "${localVersion}" is not a major.minor.patch semver.\n` +
        "  Foundry orders versions to decide whether an update exists; a version it\n" +
        '  cannot order is a version it will not offer.',
    )
    return problems
  }

  if (baseline === null) return problems

  if (!baseline.version) {
    problems.push(
      `could not read module/module.json at ${baseline.tag} — cannot verify the bump, so this is a FAILURE, not a skip`,
    )
    return problems
  }

  // Nothing Foundry loads has moved, so neither must the version. This is the
  // v0.3.1 case: an agent-only release, zero module files touched.
  if (changedPackedFiles.length === 0) return problems

  const cmp = compareSemver(localVersion, baseline.version)
  if (cmp === null) {
    problems.push(
      `cannot order "${localVersion}" against the released "${baseline.version}" (${baseline.tag}) — one of them is not semver`,
    )
    return problems
  }
  if (cmp > 0) return problems

  const verb = cmp === 0 ? 'is unchanged at' : 'goes BACKWARDS to'
  problems.push(
    `${changedPackedFiles.length} packed module file(s) changed since ${baseline.tag}, but the version ${verb} ${localVersion}` +
      (cmp === 0 ? '' : ` (released: ${baseline.version})`) +
      ':\n' +
      changedPackedFiles.map((f) => `      ${f}`).join('\n') +
      '\n\n' +
      '  These files ship to users the moment the next `v*` tag is pushed —\n' +
      '  module.json\'s manifest/download URLs point at releases/latest/download/,\n' +
      '  so the release IS the publish.\n\n' +
      '  CFG-hosted worlds would still pick this up (syncCfgPlugin reinstalls with\n' +
      '  force: true every launch, ignoring the version). SELF-HOSTED worlds would\n' +
      '  NOT: Foundry compares the manifest version to decide an update exists, so\n' +
      '  it would report them up to date on the old code, indefinitely.\n\n' +
      `  Bump "version" in module/module.json above ${baseline.version}.`,
  )
  return problems
}

// ── git I/O ────────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

/** The newest `v*` tag reachable from HEAD, or null when there is none. */
function latestReleaseTag() {
  try {
    return git(['describe', '--tags', '--match', 'v*', '--abbrev=0', 'HEAD']) || null
  } catch {
    return null
  }
}

/**
 * The module version that tag published, or a baseline of null when the tag
 * predates the module living here at all (v0.1.0/v0.2.0 are wrapper-only).
 *
 * ⚠️ Only a MISSING path yields "no baseline". A path that exists but will not
 * parse yields `{ version: null }`, which fails — the distinction is the point.
 */
function baselineAt(tag) {
  let raw
  try {
    raw = git(['show', `${tag}:module/module.json`])
  } catch {
    return null // no module at that tag — wrapper-only release
  }
  try {
    return { tag, version: JSON.parse(raw).version ?? null }
  } catch {
    return { tag, version: null }
  }
}

function changedSince(tag) {
  const out = git(['diff', '--name-only', tag, 'HEAD', '--', ...PACKED_PATHSPECS])
  return out ? out.split('\n').filter(Boolean) : []
}

function main() {
  const localVersion = JSON.parse(readFileSync(resolve(MODULE_DIR, 'module.json'), 'utf8')).version ?? null

  const tag = latestReleaseTag()
  const baseline = tag ? baselineAt(tag) : null
  const changedPackedFiles = baseline ? changedSince(baseline.tag) : []

  const problems = decideVersionBump({ localVersion, baseline, changedPackedFiles })
  if (problems.length) {
    console.error('\n✗ Module version bump required\n')
    for (const p of problems) console.error(`  ${p}\n`)
    process.exit(1)
  }

  if (!baseline) {
    console.log(`✓ module ${localVersion} — no prior release carries a module, nothing to compare`)
  } else if (changedPackedFiles.length === 0) {
    console.log(`✓ module ${localVersion} — no packed file changed since ${baseline.tag}, no bump needed`)
  } else {
    console.log(
      `✓ module ${localVersion} > ${baseline.version} (${baseline.tag}) — ${changedPackedFiles.length} packed file(s) changed`,
    )
  }
}

// Importing this module for its pure half must not run the check or print.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
