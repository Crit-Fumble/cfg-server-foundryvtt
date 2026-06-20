# cfg-server-foundryvtt

CFG's **server-side wrapper image** for FoundryVTT hosting — the server half of the
`cfg-server-*` convention (alongside `cfg-server-disrecord`, `cfg-server-factorio`,
`cfg-server-terraria`). FoundryVTT was the only hosted game-server kind without one;
it ran the prebuilt `felddy/foundryvtt` image directly from `cfg-core-server`.

Because **FoundryVTT _is_ a webserver** that serves its own client UI, this single
repo owns *both halves*: the server runtime **and** what's served to the client
(it can bake + serve the `crit-fumble-core` plugin itself). Unlike TaleSpire — whose
client is a separate native app needing a separate symbiote — Foundry needs no
separate client companion. (The standalone `cfg-foundry-plugin` repo remains, for
**self-hosted** Foundry users who install the module themselves.)

## Design: a strict additive felddy superset

This image is a **superset of `felddy/foundryvtt`, pinned to a digest** — never a
fork or a from-scratch rebuild. felddy keeps owning the hard, fragile parts (the
licensed binary download/cache, license host-binding, `Config/admin.txt`, the
`/auth /join /setup` surface, the `/data` layout, `uid 1000:1001`). We only *add*,
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
- [ ] Build + CI-assert the felddy hard-contract is byte-identical (uid, `/data`
      layout, `admin.txt`, license host-binding, route-prefixed surface, SIGTERM).
- [ ] Swap `cfg-core-server` `foundryImage` in dev → prod (still pure passthrough).
- [ ] Co-located service-GM agent, gated by `SERVICE_GM_ENABLED` (default off).
- [ ] Bake the `crit-fumble-core` plugin (collapse `syncCfgPlugin`).

Tracked under the [FoundryVTT Hosting epic](https://github.com/Crit-Fumble/cfg-core-server/issues/71).

## Build & run

```bash
# Build (pure passthrough — no npm/secret needed yet)
docker build -t cfg-server-foundryvtt:local .

# Runs exactly like felddy/foundryvtt (same env contract: FOUNDRY_*, CONTAINER_CACHE, ...)
# In CFG, cfg-core-server launches it; locally:
docker run --rm -p 30000:30000 -v "$PWD/data:/data" cfg-server-foundryvtt:local
```

License: AGPL-3.0-only.
