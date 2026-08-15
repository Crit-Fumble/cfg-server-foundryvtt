#!/usr/bin/env node
/**
 * check-felddy-contract — this image's contract, as an executable check.
 *
 * ## Why this exists
 *
 * The Dockerfile is `FROM` + four `LABEL`s, and its load-bearing rule —
 *
 *   > DO NOT add an ENTRYPOINT here. [...] felddy's entrypoint + bash supervisor
 *   > stays PID 1 — load-bearing: a clean SIGTERM is the only thing that unlocks
 *   > the world's LevelDB on shutdown.
 *
 * — was enforced by that comment and nothing else. The README calls this image a
 * "strict ADDITIVE SUPERSET [...] provably byte-identical to felddy until a
 * capability is turned on", and CONTRIBUTING says "a wrapper that diverges from
 * felddy's env/volume contract is a bug". Nothing proved any of it. Same shape as
 * the two guards this repo already ships (agent/check-playwright-pin.mjs,
 * module/check-version-bump.test.mjs): a comment is not a guard.
 *
 * ## THREE FAMILIES, and none is redundant
 *
 *   C. DOCKERFILE TEXT — the SOURCE stayed additive. No Docker, runs first, fails
 *      in <1s. This is the only family that can see a forbidden instruction whose
 *      value happens to equal the base's (see the ENTRYPOINT trap below).
 *   P. PASSTHROUGH — wrapper vs the base it names. Guards US. Structurally BLIND
 *      to upstream regressions: both sides move together on a digest bump.
 *   H. HARD CONTRACT — wrapper vs absolute values + live probes. Guards UPSTREAM.
 *      This is the family that goes red on the daily upstream-watch bump PR, which
 *      rewrites the FROM digest by sed and until now had nothing inspecting what
 *      came back.
 *
 * P alone would bless a base that dropped the HEALTHCHECK (both sides identical).
 * H alone would bless a wrapper that ships correct values while ALSO adding a dead
 * ENTRYPOINT. C alone cannot see a base bump at all.
 *
 * ## ⛔ THREE TRAPS THIS FILE IS BUILT AROUND — all three observed, not theorised
 *
 * 1. `docker image inspect` returns a JSON **ARRAY**. So `jq '.Config.Entrypoint'`
 *    is `null` for EVERY image, and a comparison written that way reports
 *    "IDENTICAL" for every field — including against an image with an injected
 *    ENTRYPOINT. Always `--format '{{json .}}'`, which emits one OBJECT.
 * 2. **Config comparison cannot enforce the no-ENTRYPOINT rule.** Adding
 *    `ENTRYPOINT ["./entrypoint.sh"]` leaves `Config.Entrypoint` deep-equal to the
 *    base — green. And `   entrypoint [...]`, lowercase and indented, builds and
 *    applies. Hence family C, case-insensitive and indentation-tolerant.
 * 3. **A COPY can hijack felddy's own scripts with zero Config drift.**
 *    `COPY entrypoint.sh /home/node/entrypoint.sh` passes Config comparison, every
 *    literal assertion and every probe. Only H_SCRIPTS (a sha256 map of felddy's
 *    13 /home/node files, wrapper vs base, exact key set) sees it.
 *
 * ## The uid the docs get wrong
 *
 * The image runs uid **1000:1000**, not the "1000:1001" README.md and the
 * Dockerfile header both claim. 1001 is CFG_DATA_GID — a SUPPLEMENTARY group
 * cfg-core-server adds at launch (`groupAdd`), never the image's own gid. A check
 * written from the prose fails against a correct image and invites "fixing" the
 * image to match a wrong doc.
 *
 * ## What a green here does NOT mean
 *
 * NO LICENSE is involved, so none of this is proven: license host-binding
 * (`license.json.signature`), admin.txt AUTHENTICATING against /auth, the
 * /join /setup surface, the world's LevelDB actually unlocking on shutdown, or the
 * /data runtime tree. Those need a licensed Foundry and live in e2e/, which is
 * deliberately not in CI. A green means: the committed Dockerfile still produces an
 * additive superset of the base it names, carrying the values cfg-core-server
 * depends on at launch. It does not mean Foundry works.
 *
 * ## Structure — TWO files, and the seam is load-bearing
 *
 *   felddy-contract-rules.mjs   PURE. Every function takes plain facts and returns
 *                               problem strings. No IO, ever.
 *   this file                   THE IO SHELL. Every docker call lives here, in main().
 *
 * That seam is what lets felddy-contract-rules.test.mjs mutate facts offline and
 * prove each rule can go RED without a Docker daemon. It was split out on
 * 2026-08-15 at 793 of the 800-line hard max — the cut this header already
 * described, so it moved code and changed no behaviour (33 offline cases and all
 * 8 live mutants re-run green either side of it).
 *
 * ⚠️ If you add a rule, it goes in the rules module. A decision made in here
 * cannot be mutation-tested, which is the one property this design exists for.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The pure decisions live next door so the offline mutation suite can exercise
// them without a Docker daemon. Re-exported below for that suite and any caller
// that already imported them from here.
import {
  ADDITIONS,
  CORE_SERVER_ENTRYPOINT_OVERRIDE,
  HARD_CONTRACT,
  checkDockerfile,
  checkHardContract,
  checkHarnessBase,
  checkPassthrough,
  parseDockerfile,
} from './felddy-contract-rules.mjs'

export * from './felddy-contract-rules.mjs'

export const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
const CHECK_TAG = 'cfg-server-foundryvtt:contract-check'

// ═══════════════════════════════════════════════════════════════════════════
// IO SHELL
// ═══════════════════════════════════════════════════════════════════════════

/** Synchronous sleep — no subprocess, no async plumbing in a linear script. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

function inspect(ref) {
  return JSON.parse(sh('docker', ['image', 'inspect', '--format', '{{json .}}', ref]))
}

/** Read felddy's /home/node file digests out of an image. One container. */
function scriptDigests(ref) {
  const out = sh('docker', [
    'run', '--rm', '--entrypoint', 'sh', ref, '-c',
    'cd /home/node && sha256sum *.sh *.js image_version.txt 2>/dev/null',
  ])
  const map = {}
  for (const line of out.trim().split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/)
    if (m) map[m[2].trim()] = m[1]
  }
  return map
}

function fatal(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function main() {
  const dockerfileText = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8')

  // ── FAMILY C first: no Docker, no pull. A forbidden instruction fails in <1s.
  // ⛔ A MISSING HARNESS IS A FAILURE, NOT A SKIP. Reading this with an
  // `existsSync ? … : ''` fallback meant deleting or moving the file silently
  // switched C7 off and the check still printed green — the same
  // empty-output-parses-as-clean shape H_PROBE exists to prevent. If the harness
  // genuinely moves, this check gets updated; it does not get to quietly lapse.
  const composePath = join(REPO_ROOT, 'module', 'tests', 'docker-compose.yml')
  const cProblems = [...checkDockerfile(dockerfileText)]
  if (existsSync(composePath)) {
    cProblems.push(...checkHarnessBase(dockerfileText, readFileSync(composePath, 'utf8')))
  } else {
    cProblems.push(
      `C7 ${composePath} is missing — the module integration harness is what C7 pins to the ` +
        'shipped base. If it moved, point this check at the new path rather than losing the guard.',
    )
  }

  // ⛔ STOP HERE IF THE SOURCE IS ALREADY INVALID. Family C needs no Docker, so a
  // forbidden instruction fails in <1s with no pull and no build. This is also a
  // correctness fix, not just a speed one: a Dockerfile with a bad ENTRYPOINT
  // produces an image whose probe containers cannot start, and the crash that
  // caused USED TO REPLACE the diagnosis with an execFileSync stack trace. The
  // mutation suite caught exactly that — the check failed for the wrong reason.
  if (cProblems.length > 0) {
    console.log('✗ C  Dockerfile source')
    for (const problem of cProblems) console.log(`    ${problem}`)
    console.error(`\n✗ felddy contract: ${cProblems.length} problem(s) in the Dockerfile itself. Image not built.`)
    process.exit(1)
  }
  console.log('✓ C  Dockerfile source')

  const from = (parseDockerfile(dockerfileText).logical.find((l) => /^FROM\s/i.test(l)) || '').replace(/^FROM\s+/i, '').trim()
  if (!from) fatal('no FROM line in the Dockerfile — cannot resolve the base to compare against')

  // ── Pull the base (retry: this is a required check and Docker Hub is a dependency)
  let pulled = false
  for (let attempt = 1; attempt <= 3 && !pulled; attempt++) {
    try {
      sh('docker', ['pull', '--quiet', from], { stdio: ['ignore', 'ignore', 'inherit'] })
      pulled = true
    } catch {
      if (attempt === 3) fatal(`could not pull the pinned base ${from} after 3 attempts`)
    }
  }

  sh('docker', ['build', '--quiet', '-t', CHECK_TAG, REPO_ROOT], { stdio: ['ignore', 'ignore', 'inherit'] })

  const wrapper = inspect(CHECK_TAG)
  const base = inspect(from)

  const pProblems = checkPassthrough(wrapper, base)

  // ── Probes. Every value is required; a missing one is a failure, never a skip.
  /**
   * Run a probe, converting ANY failure into a missing value.
   *
   * ⛔ NEVER let a probe throw. A broken image is precisely when probe containers
   * fail to start, so throwing here means the check crashes on the images it most
   * needs to diagnose. A missing value is not silently tolerated either — every
   * field is required, and `checkHardContract`'s `need()` turns absence into an
   * H_PROBE FAILURE. Missing must fail; it must never read as clean.
   */
  const probe = (name, fn) => {
    try {
      return fn()
    } catch (err) {
      console.error(`    (probe ${name} could not run: ${String(err.message || err).split('\n')[0]})`)
      return undefined
    }
  }

  const probes = {}
  // ⛔ KEY=VALUE, never positional lines. The first cut of this probe read results
  // by line INDEX, and `ls -A /data` on an empty dir emits NOTHING — not even a
  // newline — so every field below it shifted up by one and `/data is not empty:
  // "yes"` was reported against a perfectly good image. Positional parsing of
  // possibly-empty command output is a bug generator; the markers make a missing
  // value read as missing (which H_PROBE fails on) instead of as its neighbour.
  const PROBE_SCRIPT = [
    'echo "uid=$(id -u)"',
    'echo "gid=$(id -g)"',
    'echo "pwd=$(pwd)"',
    String.raw`echo "data=$(ls -A /data 2>/dev/null | tr '\n' ',')"`,
    'if test -x ./entrypoint.sh; then echo "exec=yes"; else echo "exec=no"; fi',
  ].join('; ')
  const idOut = probe('identity', () => sh('docker', ['run', '--rm', '--entrypoint', 'sh', CHECK_TAG, '-c', PROBE_SCRIPT])) || ''
  const kv = {}
  for (const line of idOut.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  probes.uid = kv.uid
  probes.gid = kv.gid
  probes.dataEntries = kv.data
  probes.entrypointExecutable = kv.exec

  probes.scriptDigests = probe('scriptDigests', () => scriptDigests(CHECK_TAG)) || {}
  const baseScripts = probe('baseScriptDigests', () => scriptDigests(from)) || {}

  // core-server's VERBATIM override; `--version` short-circuits entrypoint.sh
  // before any license, network or backoff work.
  try {
    sh(
      'docker',
      ['run', '--rm', '--entrypoint', '/bin/sh', CHECK_TAG, '-c', CORE_SERVER_ENTRYPOINT_OVERRIDE, 'cfg-perms', '--version'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    probes.overrideExit = 0
  } catch (err) {
    probes.overrideExit = err.status ?? 'no-exit-code'
  }

  // PID 1 + SIGTERM. CONTAINER_CACHE='' makes felddy's backoff sleep indefinitely
  // after its (expected, license-free) startup failure, which is what gives a
  // long-lived container with the real supervisor as PID 1 and no license.
  const name = `cfg-contract-probe-${process.pid}`
  try {
    probe('startForPid1', () => sh('docker', ['run', '-d', '--name', name, '-e', 'CONTAINER_CACHE=', CHECK_TAG], { stdio: ['ignore', 'ignore', 'pipe'] }))
    // Wait for PID 1 to settle into the supervisor.
    for (let i = 0; i < 40; i++) {
      try {
        const cmdline = sh('docker', ['exec', name, 'cat', '/proc/1/cmdline']).replace(/\0/g, ' ').trim()
        if (cmdline) { probes.pid1 = cmdline; break }
      } catch { /* container not ready yet */ }
      sleepSync(500)
    }
    const t0 = Date.now()
    if (probe('stop', () => sh('docker', ['stop', '-t', '30', name], { stdio: ['ignore', 'ignore', 'pipe'] })) !== undefined) {
      probes.stopMs = Date.now() - t0
      probes.stopExitCode = probe('exitCode', () => sh('docker', ['inspect', '-f', '{{.State.ExitCode}}', name]).trim())
    }
  } finally {
    try { sh('docker', ['rm', '-f', name], { stdio: 'ignore' }) } catch { /* already gone */ }
  }

  const hProblems = checkHardContract(wrapper, probes, baseScripts, HARD_CONTRACT, dockerfileText)

  // ── Report
  const families = [
    ['P  passthrough vs base', pProblems],
    ['H  hard contract', hProblems],
  ]
  let failed = 0
  for (const [label, problems] of families) {
    if (problems.length === 0) {
      console.log(`✓ ${label}`)
    } else {
      failed += problems.length
      console.log(`✗ ${label}`)
      for (const p of problems) console.log(`    ${p}`)
    }
  }
  console.log(`\nbase:    ${from}`)
  console.log(`platform: ${wrapper.Os}/${wrapper.Architecture} (the pinned base is a multi-platform list; this proves ONE platform)`)
  console.log(
    `probes:  uid=${probes.uid}:${probes.gid} pid1=${JSON.stringify(probes.pid1)} ` +
      `stop=${probes.stopMs}ms exit=${probes.stopExitCode} scripts=${Object.keys(probes.scriptDigests).length}`,
  )

  if (failed) {
    console.error(`\n✗ felddy contract: ${failed} problem(s). This image is not the additive superset it claims to be.`)
    process.exit(1)
  }
  console.log('\n✓ felddy contract holds — additive superset of the pinned base, and the values core-server depends on are intact.')
  console.log('  ⚠️  NOT proven here (needs a licensed Foundry, lives in e2e/): license host-binding,')
  console.log('      admin.txt authenticating, the LevelDB unlock on shutdown, the /join /setup surface.')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
