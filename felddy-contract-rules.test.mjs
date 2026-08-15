/**
 * Mutation tests for felddy-contract-rules — the pure decisions behind
 * check-felddy-contract.
 *
 * ⛔ THE POINT OF THIS FILE IS THAT THE CHECK CAN GO RED. A guard that only ever
 * sees a healthy image proves nothing — this repo has shipped two checks that
 * passed against live bugs (a fixture with no Foundry data dir passed a demotion
 * test AND its ordering guard; an alert sweep called the board clean while a HIGH
 * advisory sat open, because a 403 rendered as an empty list). So every assertion
 * in the check gets a fixture here that BREAKS it, and the test fails if the check
 * stays green.
 *
 * Offline by construction: no Docker, no registry, no network. The check's IO shell
 * assembles these same shapes from `docker image inspect` and probe containers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDITIONS,
  HARD_CONTRACT,
  checkDockerfile,
  checkHardContract,
  checkHarnessBase,
  checkPassthrough,
  parseDockerfile,
  parseLabelLine,
} from './felddy-contract-rules.mjs'

// ── fixtures ────────────────────────────────────────────────────────────────

const GOOD_DOCKERFILE = `# a comment
# ── THE PIN BELOW IS felddy 14.365 ─────────────────────────────────────────
# more prose about why the digest is pinned

FROM felddy/foundryvtt@sha256:${'b'.repeat(64)}

LABEL org.opencontainers.image.title="cfg-server-foundryvtt"
LABEL org.opencontainers.image.description="CFG server-side wrapper for FoundryVTT hosting — additive felddy superset"
LABEL org.opencontainers.image.source="https://github.com/Crit-Fumble/cfg-server-foundryvtt"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
`

const BASE_ENV = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'NODE_VERSION=24.18.0',
  'FOUNDRY_VERSION=14.365',
  'HOME=/home/node',
]

const BASE_LABELS = {
  'com.foundryvtt.version': '14.365',
  'org.opencontainers.image.authors': 'felddy',
  'org.opencontainers.image.title': 'foundryvtt-docker',
  'org.opencontainers.image.description': 'An easy-to-deploy containerized Foundry Virtual Tabletop server.',
  'org.opencontainers.image.source': 'https://github.com/felddy/foundryvtt-docker',
  'org.opencontainers.image.licenses': 'MIT',
}

const clone = (o) => JSON.parse(JSON.stringify(o))

function baseImage() {
  return {
    Architecture: 'amd64',
    Os: 'linux',
    RootFS: { Layers: ['sha256:l1', 'sha256:l2', 'sha256:l3'] },
    Config: {
      User: 'node',
      WorkingDir: '/home/node',
      Entrypoint: ['./entrypoint.sh'],
      Cmd: ['resources/app/main.mjs', '--port=30000', '--headless', '--noupdate', '--dataPath=/data'],
      Env: [...BASE_ENV],
      Labels: clone(BASE_LABELS),
      Volumes: { '/data': {} },
      ExposedPorts: { '30000/tcp': {} },
      Healthcheck: { Test: ['CMD-SHELL', './check_health.sh'], Interval: 30000000000 },
    },
  }
}

function wrapperImage() {
  const w = baseImage()
  w.Config.Labels = { ...clone(BASE_LABELS), ...ADDITIONS.labels }
  return w
}

const scriptMap = () => Object.fromEntries(HARD_CONTRACT.scripts.map((s, i) => [s, String(i).padStart(64, 'a')]))

function goodProbes() {
  return {
    uid: '1000',
    gid: '1000',
    dataEntries: '',
    entrypointExecutable: 'yes',
    scriptDigests: scriptMap(),
    overrideExit: 0,
    pid1: '/bin/bash ./entrypoint.sh resources/app/main.mjs --port=30000',
    stopMs: 39,
    stopExitCode: '143',
  }
}

/** Assert the check fired, and that at least one message names the expected rule. */
function fires(problems, rule) {
  assert.ok(problems.length > 0, `expected a problem for ${rule}, got none — THE CHECK IS BLIND HERE`)
  assert.ok(
    problems.some((p) => p.startsWith(rule)),
    `expected a ${rule} problem, got:\n  ${problems.join('\n  ')}`,
  )
}

// ── baseline: the healthy case must be silent, or every test below is vacuous ──

test('healthy fixtures produce no problems at all', () => {
  assert.deepEqual(checkDockerfile(GOOD_DOCKERFILE), [])
  assert.deepEqual(checkPassthrough(wrapperImage(), baseImage()), [])
  assert.deepEqual(
    checkHardContract(wrapperImage(), goodProbes(), scriptMap(), HARD_CONTRACT, GOOD_DOCKERFILE),
    [],
  )
})

// ── FAMILY C — the Dockerfile source ────────────────────────────────────────

test('C4 catches an added ENTRYPOINT — the exact case Config comparison cannot see', () => {
  const mutant = `${GOOD_DOCKERFILE}\nENTRYPOINT ["./entrypoint.sh"]\n`
  fires(checkDockerfile(mutant), 'C4')
  // And prove the premise: this mutant is INVISIBLE to the passthrough family,
  // because the value it sets is identical to the base's.
  assert.deepEqual(checkPassthrough(wrapperImage(), baseImage()), [], 'premise: Config stays identical')
})

test('C4 is case-insensitive and indentation-tolerant (`   entrypoint [...]` builds and applies)', () => {
  fires(checkDockerfile(`${GOOD_DOCKERFILE}\n   entrypoint ["/x"]\n`), 'C4')
  fires(checkDockerfile(`${GOOD_DOCKERFILE}\nEnTrYpOiNt ["/x"]\n`), 'C4')
})

test('C4 catches every other contract-overriding instruction', () => {
  const forbidden = [
    'CMD ["x"]', 'USER root', 'WORKDIR /tmp', 'VOLUME /data', 'HEALTHCHECK NONE',
    'ARG FOUNDRY_VERSION=14', 'STOPSIGNAL SIGKILL', 'SHELL ["/bin/sh"]', 'ONBUILD RUN x', 'EXPOSE 1',
  ]
  for (const instr of forbidden) {
    fires(checkDockerfile(`${GOOD_DOCKERFILE}\n${instr}\n`), 'C4')
  }
})

test('C6 refuses an allowlist widened to permit a forbidden instruction', () => {
  const widened = { ...ADDITIONS, instructions: [...ADDITIONS.instructions, /^ENTRYPOINT\s/i] }
  fires(checkDockerfile(GOOD_DOCKERFILE, widened), 'C6')
})

test('C1 catches a floating tag, a wrong image, and a second FROM', () => {
  fires(checkDockerfile(GOOD_DOCKERFILE.replace(/@sha256:[0-9a-f]{64}/, ':14')), 'C1')
  fires(checkDockerfile(GOOD_DOCKERFILE.replace('felddy/foundryvtt', 'someoneelse/foundryvtt')), 'C1')
  fires(checkDockerfile(`${GOOD_DOCKERFILE}\nFROM scratch\n`), 'C1')
})

test('C2 catches a missing, altered, duplicated or undeclared LABEL', () => {
  fires(checkDockerfile(GOOD_DOCKERFILE.replace(/LABEL org\.opencontainers\.image\.licenses.*\n/, '')), 'C2')
  fires(checkDockerfile(GOOD_DOCKERFILE.replace('AGPL-3.0-only', 'MIT')), 'C2')
  fires(checkDockerfile(`${GOOD_DOCKERFILE}\nLABEL org.opencontainers.image.title="sneaky"\n`), 'C2')
  fires(checkDockerfile(`${GOOD_DOCKERFILE}\nLABEL com.example.extra="x"\n`), 'C2')
})

test('C3 catches an undeclared instruction (a COPY nobody declared)', () => {
  fires(checkDockerfile(`${GOOD_DOCKERFILE}\nCOPY entrypoint.sh /home/node/entrypoint.sh\n`), 'C3')
  fires(checkDockerfile(`${GOOD_DOCKERFILE}\nRUN echo hi\n`), 'C3')
})

test('parseDockerfile joins continuations, so a hidden instruction cannot slip past', () => {
  const { logical } = parseDockerfile('FROM x \\\n  AS builder\nLABEL a="b"\n')
  assert.equal(logical.length, 2)
  assert.match(logical[0], /^FROM x\s+AS builder$/)
})

test('parseLabelLine rejects a shape it cannot understand rather than silently passing it', () => {
  assert.equal(parseLabelLine('LABEL a=b c=d'), null)
  assert.deepEqual(parseLabelLine('LABEL a="b"'), { key: 'a', value: 'b' })
})

// ── FAMILY P — passthrough vs the base ──────────────────────────────────────

test('P1 refuses to compare across platforms instead of reporting noise', () => {
  const w = wrapperImage()
  w.Architecture = 'arm64'
  const problems = checkPassthrough(w, baseImage())
  fires(problems, 'P1')
  assert.equal(problems.length, 1, 'must stop at P1 — downstream diffs would be platform noise')
})

test('P2 catches a modified base layer and an undeclared added layer', () => {
  const modified = wrapperImage()
  modified.RootFS.Layers = ['sha256:l1', 'sha256:TAMPERED', 'sha256:l3']
  fires(checkPassthrough(modified, baseImage()), 'P2')

  const extra = wrapperImage()
  extra.RootFS.Layers = [...extra.RootFS.Layers, 'sha256:new']
  fires(checkPassthrough(extra, baseImage()), 'P2')
})

test('P3 union sweep catches a field NOBODY ENUMERATED — the check\'s own blind-spot guard', () => {
  const w = wrapperImage()
  w.Config.StopSignal = 'SIGKILL' // absent from the base entirely
  fires(checkPassthrough(w, baseImage()), 'P3')

  const dropped = wrapperImage()
  delete dropped.Config.Volumes // present in base, gone from wrapper
  fires(checkPassthrough(dropped, baseImage()), 'P3')
})

test('P4 catches a changed inherited label and an undeclared extra label', () => {
  const changed = wrapperImage()
  changed.Config.Labels['org.opencontainers.image.authors'] = 'someone-else'
  fires(checkPassthrough(changed, baseImage()), 'P4')

  const extra = wrapperImage()
  extra.Config.Labels['com.example.injected'] = 'x'
  fires(checkPassthrough(extra, baseImage()), 'P4')
})

test('P5 catches a rewritten base ENV and an undeclared added ENV', () => {
  const rewritten = wrapperImage()
  rewritten.Config.Env = rewritten.Config.Env.map((e) => (e.startsWith('PATH=') ? 'PATH=/hijack' : e))
  fires(checkPassthrough(rewritten, baseImage()), 'P5')

  const added = wrapperImage()
  added.Config.Env = [...added.Config.Env, 'SERVICE_GM_ENABLED=1']
  fires(checkPassthrough(added, baseImage()), 'P5')
})

test('P5 makes "byte-identical until a capability is turned on" machine-checked', () => {
  const additions = { ...ADDITIONS, env: { SERVICE_GM_ENABLED: '0' } }
  const shippedOff = wrapperImage()
  shippedOff.Config.Env = [...shippedOff.Config.Env, 'SERVICE_GM_ENABLED=0']
  assert.deepEqual(checkPassthrough(shippedOff, baseImage(), additions), [], 'declared + OFF is fine')

  const shippedOn = wrapperImage()
  shippedOn.Config.Env = [...shippedOn.Config.Env, 'SERVICE_GM_ENABLED=1']
  fires(checkPassthrough(shippedOn, baseImage(), additions), 'P5')
})

// ── FAMILY H — the hard contract ────────────────────────────────────────────

const hc = (w = wrapperImage(), p = goodProbes(), base = scriptMap(), df = GOOD_DOCKERFILE) =>
  checkHardContract(w, p, base, HARD_CONTRACT, df)

test('H_USER catches a renumbered uid — including "fixing" it to the docs\' wrong 1000:1001', () => {
  const p = goodProbes()
  p.gid = '1001' // what README.md and the Dockerfile header both claim
  fires(hc(wrapperImage(), p), 'H_USER')

  const p2 = goodProbes()
  p2.uid = '0'
  fires(hc(wrapperImage(), p2), 'H_USER')
})

test('H_CMD catches an empty Cmd and a moved data root', () => {
  const empty = wrapperImage()
  empty.Config.Cmd = []
  fires(hc(empty), 'H_CMD')

  const moved = wrapperImage()
  moved.Config.Cmd = ['resources/app/main.mjs', '--dataPath=/foundrydata']
  fires(hc(moved), 'H_CMD')
})

test('H_HEALTH catches a dropped healthcheck — core-server reads health `none` as READY', () => {
  const gone = wrapperImage()
  delete gone.Config.Healthcheck
  fires(hc(gone), 'H_HEALTH')

  const none = wrapperImage()
  none.Config.Healthcheck = { Test: ['NONE'] }
  fires(hc(none), 'H_HEALTH')
})

test('H_DATA_EMPTY catches anything baked under the VOLUME (why issue #1 was rejected)', () => {
  const p = goodProbes()
  p.dataEntries = 'modules'
  fires(hc(wrapperImage(), p), 'H_DATA_EMPTY')
})

test('H_SCRIPTS catches THE COPY HIJACK, which every other family passes', () => {
  const base = scriptMap()
  const p = goodProbes()
  p.scriptDigests = { ...base, 'entrypoint.sh': 'f'.repeat(64) }

  fires(hc(wrapperImage(), p, base), 'H_SCRIPTS')
  // Premise: the hijack is invisible everywhere else.
  assert.deepEqual(checkPassthrough(wrapperImage(), baseImage()), [], 'premise: Config identical')
})

test('H_SCRIPTS catches a removed or added felddy file (exact key set)', () => {
  const base = scriptMap()
  const removed = goodProbes()
  delete removed.scriptDigests['launcher.sh']
  fires(hc(wrapperImage(), removed, base), 'H_SCRIPTS')

  const added = goodProbes()
  added.scriptDigests['payload.sh'] = 'c'.repeat(64)
  fires(hc(wrapperImage(), added, base), 'H_SCRIPTS')
})

test('H_PROBE treats a MISSING probe result as failure, never as a pass', () => {
  for (const field of ['uid', 'gid', 'entrypointExecutable', 'overrideExit', 'pid1']) {
    const p = goodProbes()
    delete p[field]
    const problems = hc(wrapperImage(), p)
    assert.ok(
      problems.some((x) => x.startsWith('H_PROBE')),
      `a missing ${field} must FAIL, not silently pass — empty-output-parses-as-clean is this repo's signature bug`,
    )
  }
  const noScripts = goodProbes()
  noScripts.scriptDigests = {}
  fires(hc(wrapperImage(), noScripts), 'H_PROBE')
})

test('H_OVERRIDE catches core-server\'s verbatim entrypoint override failing', () => {
  const p = goodProbes()
  p.overrideExit = 127
  fires(hc(wrapperImage(), p), 'H_OVERRIDE')
})

test('H_VERSION catches a digest bump that silently moved the Foundry version', () => {
  // upstream-watch rewrites the FROM digest and NOTHING else, so the header goes stale.
  const bumped = wrapperImage()
  bumped.Config.Env = bumped.Config.Env.map((e) => (e.startsWith('FOUNDRY_VERSION=') ? 'FOUNDRY_VERSION=14.999' : e))
  fires(hc(bumped), 'H_VERSION')
})

test('H_VERSION fails loudly if the header line it depends on is deleted', () => {
  const noHeader = GOOD_DOCKERFILE.replace(/THE PIN BELOW IS felddy 14\.365/, 'pinned')
  fires(hc(wrapperImage(), goodProbes(), scriptMap(), noHeader), 'H_VERSION')
})

test('H_PID1 and H_SIGTERM catch a displaced supervisor and a force-kill', () => {
  const p = goodProbes()
  p.pid1 = '/usr/bin/tini -- node main.mjs'
  fires(hc(wrapperImage(), p), 'H_PID1')

  const killed = goodProbes()
  killed.stopExitCode = '137'
  fires(hc(wrapperImage(), killed), 'H_SIGTERM')

  const slow = goodProbes()
  slow.stopMs = 30000
  fires(hc(wrapperImage(), slow), 'H_SIGTERM')
})

test('H_ENTRYPOINT and H_WORKDIR catch a relative-path break', () => {
  const moved = wrapperImage()
  moved.Config.WorkingDir = '/opt/foundry'
  fires(hc(moved), 'H_WORKDIR')

  const swapped = wrapperImage()
  swapped.Config.Entrypoint = ['/usr/local/bin/other.sh']
  fires(hc(swapped), 'H_ENTRYPOINT')
})

// ── FAMILY C, second file — the module integration harness's base ───────────

const DIGEST = `sha256:${'b'.repeat(64)}`
const GOOD_COMPOSE = `services:
  foundry:
    image: felddy/foundryvtt@${DIGEST}
    platform: linux/amd64
    environment:
      FOUNDRY_VERSION: \${FOUNDRY_VERSION:-14.361}
`

test('C7 is silent when the harness pins exactly what the Dockerfile ships', () => {
  assert.deepEqual(checkHarnessBase(GOOD_DOCKERFILE, GOOD_COMPOSE), [])
})

test('C7 catches the ROLLING tag the harness used to use', () => {
  const rolling = GOOD_COMPOSE.replace(`felddy/foundryvtt@${DIGEST}`, 'felddy/foundryvtt:14')
  fires(checkHarnessBase(GOOD_DOCKERFILE, rolling), 'C7')
})

test('C7 catches the two pins drifting apart — the whole point of pinning', () => {
  const drifted = GOOD_COMPOSE.replace(DIGEST, `sha256:${'c'.repeat(64)}`)
  fires(checkHarnessBase(GOOD_DOCKERFILE, drifted), 'C7')
})

test('C7 fails loudly rather than silently passing if the harness stops naming felddy', () => {
  const moved = GOOD_COMPOSE.replace(`felddy/foundryvtt@${DIGEST}`, 'someoneelse/foundry:1')
  fires(checkHarnessBase(GOOD_DOCKERFILE, moved), 'C7')
})

test('C7 does NOT police FOUNDRY_VERSION — the app version is per-install state', () => {
  const otherVersion = GOOD_COMPOSE.replace('14.361', '14.999')
  assert.deepEqual(
    checkHarnessBase(GOOD_DOCKERFILE, otherVersion),
    [],
    'pinning the app version to the image is the ARG FOUNDRY_VERSION anti-pattern the Dockerfile forbids',
  )
})
