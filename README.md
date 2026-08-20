# cfg-server-foundryvtt

CFG's **server-side wrapper image** for FoundryVTT hosting — the server half of the
`cfg-server-*` convention (alongside `cfg-server-disrecord`, `cfg-server-factorio`,
`cfg-server-terraria`). FoundryVTT was the only hosted game-server kind without one;
it ran the prebuilt `felddy/foundryvtt` image directly from `cfg-core-server`.

Because **FoundryVTT _is_ a webserver** that serves its own client UI, this single
repo owns *both halves*: the server runtime **and** what's served to the client.
Unlike TaleSpire — whose client is a separate native app needing a separate
symbiote — Foundry needs no separate client companion.

## The CFG Server Manager module (`module/`)

The platform's Foundry module lives here too — **CFG Server Manager**, module id
`crit-fumble-core` (the id predates the title and MUST stay: Foundry worlds store
their enable flag in `core.moduleConfiguration` keyed by id, so changing it
orphans every world's setting). It carries campaign linking, runtime player
provisioning, the world↔platform document sync couriers, and session reporting —
for CFG-hosted **and** self-hosted worlds alike. It was extracted from
`cfg-foundry-plugin` at module 2.48.3; the **3D overlay** went to
`cfg-app-playtable` as the separate **`cfg-playtable`** module (2026-08-16), and
`cfg-foundry-plugin` is now archived — nothing "stays behind" there.

⚠️ `cfg-playtable` **requires** `crit-fumble-core` at runtime: the extraction
deliberately kept writing flags in the `crit-fumble-core` namespace, which is what
made it a pure move with no data migration. It is declared in the module's
`relationships.requires`, not hidden.

**Delivery channel:** each `v*` release of this repo attaches `module.json` +
`module.zip` as GitHub release assets, and the manifest's own URLs point at
`releases/latest/download/…` — so a release here *is* a module publish (a
curated default, replacing "every hosted launch installs whatever is on `main`").

> ✅ **Flipped 2026-08-07 — this repo's release assets ARE the live channel.**
> `foundryPluginManifestUrl` points at
> `cfg-server-foundryvtt/releases/latest/download/module.json` in every config
> location, production override included, and `cfg-foundry-plugin` is archived.
> Verified 2026-08-16: `v0.4.1` serves `crit-fumble-core` 3.0.0.
>
> ⚠️ This block used to forbid restructuring `cfg-foundry-plugin` because it was
> still the live channel. That prohibition outlived the work by nine days — long
> enough that a reader today would refuse a correct change. Left as a correction
> rather than deleted, because a stale *prohibition* is the costly kind of drift:
> nobody questions a warning.

```bash
cd module
npm ci               # tokenless — zero @crit-fumble deps since 2026-08-19
npm test              # jest unit suite
npm run build:zip     # dist/module.json + dist/module.zip (+ versioned zip)
npm run test:foundry:up && npm run test:foundry   # integration (licensed Foundry)
```

## Design: a strict additive felddy superset

This image is a **superset of `felddy/foundryvtt`, pinned to a digest** — never a
fork or a from-scratch rebuild. felddy keeps owning the hard, fragile parts (the
licensed binary download/cache, license host-binding, `Config/admin.txt`, the
`/auth /join /setup` surface, the `/data` layout, `uid 1000:1000`). We only *add*,
and every addition is gated behind a **default-OFF** env flag, so the image stays
provably byte-identical to felddy until a capability is turned on. That makes the
`cfg-core-server` image swap (`foundryImage`) a one-config, instantly-reversible
change with felddy as the documented rollback.

**Why own it at all:**
- **Consolidation** — one repo for Foundry server-side complexity + a clean,
  deterministic Playwright e2e environment for testing + feature work.
- **Co-located service-GM** — the runtime player-provisioning helper becomes a
  headless Foundry client running *inside* this container against `localhost:30000`,
  deleting the cross-network / proxy plumbing an external worker required.
- **Deterministic lifecycle** — a custom entrypoint (later) can own world-load,
  lock cleanup, and offline user bootstrap.

## Status — additive migration (risk-ascending, each step reversible)

- [x] **Passthrough** — `FROM felddy@<digest>`, zero additions. Provably identical
      to felddy; proves the image swap before anything is added.
- [x] **CI-assert the felddy passthrough + hard contract** — `check-felddy-contract.mjs`,
      required via CI Gate, with **no license and no secrets**. Three families, none
      redundant: the Dockerfile SOURCE stayed additive (the "DO NOT add an ENTRYPOINT"
      rule is now *executable* — a comment is not a guard); the IMAGE is an additive
      superset of the pinned base (base layers an unmodified prefix, every `Config`
      field compared by union sweep so a field nobody enumerated is still checked,
      felddy's 13 `/home/node` scripts byte-identical); and the values cfg-core-server
      depends on are intact (uid 1000:1000, WORKDIR, non-empty CMD carrying
      `--dataPath=/data`, a present HEALTHCHECK, `FOUNDRY_VERSION` agreeing with this
      Dockerfile's own header, core-server's verbatim entrypoint override, PID 1 =
      felddy's bash supervisor, and a prompt SIGTERM rather than a force-kill).
      ⚠️ It proves ONE platform per run (the pinned base is a 4-platform list).
- [ ] **Boot tier — needs a booted, mostly licensed Foundry. OWNER CALL: the Foundry
      zip on a runner is an EULA question, and activations are a limited resource.**
      Still asserted NOWHERE in CI: `admin.txt` being hashed *and* accepted by `/auth`,
      the `FOUNDRY_*` → `Config/options.json` mapping, `check_health.sh`'s route-prefixed
      request, the license host-binding (`signature`), the `/data` runtime tree, and the
      world's LevelDB actually unlocking on shutdown. These need `e2e/`, which is
      deliberately not in CI. ⚠️ Note `e2e/` does **not** cover the route prefix either —
      `compose.yml` sets no `FOUNDRY_ROUTE_PREFIX` and the specs hard-code `''`.
- [ ] Swap `cfg-core-server` `foundryImage` in dev → prod (still pure passthrough).
- [ ] Co-located service-GM agent, gated by `SERVICE_GM_ENABLED` (default off).
- [x] **Module source in-repo** (`module/`) + release-asset delivery channel.
- [x] **Flip `foundryPluginManifestUrl` to this repo's release assets** — done 2026-08-07,
      all config locations incl. the production override.
- ~~Bake the `crit-fumble-core` plugin into the image (collapse `syncCfgPlugin`)~~ —
      **rejected, [#1](https://github.com/Crit-Fumble/cfg-server-foundryvtt/issues/1)
      closed 2026-08-15.** `VOLUME /data` shadows anything baked to
      `Data/modules/`, and a bake needs a runtime copy step that this image's
      no-`ENTRYPOINT` rule leaves nowhere to live. Writing from the host before
      the container starts is strictly better; see the Dockerfile header.

Tracked under the [FoundryVTT Hosting epic](https://github.com/Crit-Fumble/cfg-core-server/issues/71).

## Build & run

```bash
# Build (pure passthrough — no npm/secret needed yet)
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

⚠️ **No test boots the published image.** That gap is how v0.3.0 shipped Chromium
151 in place of 149: `agent/Dockerfile` pinned its base by digest while
`"^1.49.0"` re-resolved a layer below, and every check stayed green. v0.3.1 fixed
the pin; the missing rung is still missing.

The probe below is the license-free stand-in — it needs no Foundry, no `.env` and
no `.dev-state`, and runs the image under the launcher's exact hardening:

```bash
docker run --rm --platform linux/amd64 --read-only \
  --tmpfs /tmp:rw,nosuid,size=512m --tmpfs /home/node/.cache:rw,nosuid,size=128m \
  --cap-drop ALL -w /app --entrypoint node \
  ghcr.io/crit-fumble/cfg-foundry-service-gm:latest \
  -e 'import("@playwright/test").then(async m=>{const b=await m.chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});console.log(b.version());await b.close()})'
```

⚠️ **Read what it proves narrowly.** v0.2.0, v0.3.0 *and* v0.3.1 all pass it — so
it catches an image that cannot start a browser at all, not a browser version
Foundry's login and drain UI has never been driven with. Verify a tag by
extracting the published layer, never by reading the Dockerfile.

License: AGPL-3.0-only.
