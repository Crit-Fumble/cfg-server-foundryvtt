# cfg-server-foundryvtt

CFG's **server-side wrapper image** for FoundryVTT hosting — the server half of the
`cfg-server-*` convention (alongside `cfg-server-disrecord`, `cfg-server-factorio`,
`cfg-server-terraria`).

Because **FoundryVTT _is_ a webserver** that serves its own client UI, this single
repo owns *both halves*: the server runtime **and** what's served to the client.

## The CFG Server Manager module (`module/`)

The platform's Foundry module lives here too — **CFG Server Manager**, module id
`crit-fumble-core` (the id predates the title and MUST stay: Foundry worlds store
their enable flag in `core.moduleConfiguration` keyed by id, so changing it
orphans every world's setting). It carries campaign linking, runtime player
provisioning, and session reporting (it does not sync world documents — owner, 2026-10-03) —
for worlds Crit-Fumble hosts. Connecting a world you host yourself is not
currently supported.

**Delivery channel:** each `v*` release of this repo attaches `module.json` +
`module.zip` as GitHub release assets, and the manifest's own URLs point at
`releases/latest/download/…` — so a release here *is* a module publish.
cfg-core-server's `foundryPluginManifestUrl` points at this manifest in every config
(the production override included), and every hosted launch reinstalls the module
from it, so a release reaches hosted worlds at their next launch, with no staging tier.

```bash
cd module
npm ci               # tokenless — zero @crit-fumble deps since 2026-08-19
npm test              # jest unit suite
npm run build:zip     # dist/module.json + dist/module.zip (+ versioned zip)
npm run test:foundry:up && npm run test:foundry   # integration (licensed Foundry)
```

**Support:** report bugs and ask questions in
[this repo's issues](https://github.com/Crit-Fumble/cfg-server-foundryvtt/issues). The
community Discord is at <https://core.crit-fumble.com/join>, which always serves the
current invite; never link a raw `discord.gg` invite, because invites expire.

## Design: a strict additive felddy superset

This image is a **superset of `felddy/foundryvtt`, pinned to a digest** — never a
fork or a from-scratch rebuild. felddy keeps owning the hard, fragile parts (the
licensed binary download/cache, license host-binding, `Config/admin.txt`, the
`/auth /join /setup` surface, the `/data` layout, `uid 1000:1000`). We only *add*:
every runtime capability is gated behind a **default-OFF** env flag, and the one
filesystem addition — a static `ffmpeg` at `/usr/local/bin/ffmpeg`, which nothing
in felddy ever calls — is declared exactly in `felddy-contract-rules.mjs`
(`STATIC_FFMPEG` + `ADDITIONS`). So the image behaves byte-for-byte like felddy
until a capability is turned on or the binary is run on purpose. That keeps the
`cfg-core-server` image swap (`foundryImage`) a one-config, instantly-reversible
change with felddy as the documented rollback (which loses only ffmpeg).

`check-felddy-contract.mjs` enforces this in CI Gate — CONTRIBUTING.md says what a green
does and does not prove; the Dockerfile header explains the ffmpeg addition.

**Why own it at all:** consolidation — one repo for Foundry server-side complexity + a
clean, deterministic Playwright e2e environment for testing + feature work.

## Build & run

```bash
# Build (felddy + one static ffmpeg layer; no npm auth or secrets)
docker build -t cfg-server-foundryvtt:local .

# Runs exactly like felddy/foundryvtt (same env contract: FOUNDRY_*, CONTAINER_CACHE, ...)
# In CFG, cfg-core-server launches it; locally:
docker run --rm -p 30000:30000 -v "$PWD/data:/data" cfg-server-foundryvtt:local
```

## Verifying the service-GM driver image

`ghcr.io/crit-fumble/cfg-foundry-service-gm` is the one-shot headless Chromium
container `foundry-service-gm-launcher.ts` spawns, and it pulls `:latest` with
`imagePull: always` on every launch — so what that tag holds reaches users
without a deploy.

Two guards, and it is worth knowing what each does **not** cover:

| guard | covers | blind to |
|---|---|---|
| `npm ci` in `agent/Dockerfile` | `agent/package.json` ↔ `agent/package-lock.json` | the root lock |
| `npm run test:agent` (CI) | all three Playwright pins agree, and the agent pin is exact | whether the built image actually runs |
| `e2e/tests/driver.spec.ts` | the driver SOURCE drains a real world | runs on the HOST — not the image |

⚠️ **No test boots the published image.**

The probe below is the license-free stand-in — it needs no Foundry, no `.env` and
no `.dev-state`, and runs the image under the launcher's exact hardening:

```bash
docker run --rm --platform linux/amd64 --read-only \
  --tmpfs /tmp:rw,nosuid,size=512m --tmpfs /home/node/.cache:rw,nosuid,size=128m \
  --cap-drop ALL -w /app --entrypoint node \
  ghcr.io/crit-fumble/cfg-foundry-service-gm:latest \
  -e 'import("@playwright/test").then(async m=>{const b=await m.chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});console.log(b.version());await b.close()})'
```

⚠️ **Read what it proves narrowly.** It catches an image that cannot start a
browser at all, not a browser version Foundry's login and drain UI has never been
driven with. Verify a tag by extracting the published layer, never by reading the
Dockerfile.

License: AGPL-3.0-only.
