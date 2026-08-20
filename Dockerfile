# syntax=docker/dockerfile:1.7
#
# cfg-server-foundryvtt — CFG's server-side wrapper image for FoundryVTT hosting.
#
# Strict ADDITIVE SUPERSET of felddy/foundryvtt. This first cut IS felddy, pinned
# to an exact digest and re-tagged under CFG's registry — so pointing
# cfg-core-server's `foundryImage` at it is a provably byte-identical, one-config
# change that reverts to felddy in one line. felddy keeps owning the licensed
# binary download/cache, the license host-binding, Config/admin.txt, the
# /auth /join /setup surface, the /data layout, and uid 1000:1000.
#
# ⚠️ THE UID IS 1000:1000, NOT 1000:1001 — this line said 1001 until 2026-08-15,
# and so does README.md. 1001 is CFG_DATA_GID, a SUPPLEMENTARY group cfg-core-server
# adds at launch (`groupAdd`), never the image's own gid. Verified: `id` in this
# image reports uid=1000(node) gid=1000(node). check-felddy-contract.mjs asserts
# the real values, so a reader who "fixes" the image to match the old prose fails CI.
#
# Why pin the DIGEST, not the rolling `:14` tag: felddy's :14 shifts under you
# (cfg-core-server already documents felddy rolling 14.361 -> 14.364 stranding
# installs). A digest makes the image reproducible + the swap/rollback symmetric.
#
# ── THE PIN BELOW IS felddy 14.367 ──────────────────────────────────────────
# Verified against the registry, not Docker Hub's tag JSON: both `:14` and
# `:14.366` resolve to e494b6ad…, and the previous pin bb8402d7… is `:14.365`.
#
# ⛔ THIS DIGEST IS THE ONLY VERSION KNOB THIS FILE MAY EVER HAVE. `ARG
# FOUNDRY_VERSION` is a permanent anti-pattern here: the Foundry APP version is
# per-install platform state, resolved at launch by the activation/updater flow
# (`resolveLaunchFoundryVersion`, foundry-management.ts), because a BYO-license
# install owns one-way world migrations and its own module compatibility. An
# image-level version pin would move every user's worlds at once. Bumping this
# digest changes the felddy DEFAULT the image ships with; it does not change
# what any launch runs.
#
# The daily `upstream-watch` in cfg-core-dev-tools now watches this line and
# opens a bump PR when felddy's `:14` moves — before that it rotted silently for
# a month. It rewrites the FROM digest and nothing else; if you restructure this
# line, update the `foundryvtt` case in that workflow or its sed will hard-fail
# (deliberately loud, never a quiet no-op).
#
# Future additive capabilities land behind default-OFF env flags, each on its own
# prove-passthrough cycle: a CO-LOCATED headless service-GM provisioning agent
# (SERVICE_GM_ENABLED, talking to localhost:30000). NOT present yet.
#
# ⛔ BAKING THE crit-fumble-core PLUGIN IN WAS INVESTIGATED AND REJECTED (#1,
# closed 2026-08-15). It is NOT a pending capability — it cannot work here, and
# both reasons are already visible in this file:
#   1. felddy declares VOLUME /data, and the plugin lives at
#      <vttDataPath>/Data/modules/crit-fumble-core. Anything COPY'd there is
#      SHADOWED the moment the bind mount lands.
#   2. A bake needs a copy step at RUNTIME, and the ENTRYPOINT rule immediately
#      below means there is nowhere for one to live.
# core-server's `syncCfgPlugin` writes from the HOST before the container starts
# — no volume, no entrypoint, full filesystem access. That is strictly better
# than a bake, not a workaround for lacking one. If the launch-time network fetch
# is the thing you want gone, `CFG_FOUNDRY_PLUGIN_PATH` is already wired and
# unset: it takes the local-source branch with no image change at all.
#
# DO NOT add an ENTRYPOINT here. cfg-core-server launches the container with its
# own `entrypoint` (FOUNDRY_GROUP_WRITABLE_ENTRYPOINT) that `exec`s felddy's
# entrypoint.sh, so any image ENTRYPOINT is overridden and dead. felddy's
# entrypoint + bash supervisor stays PID 1 — load-bearing: a clean SIGTERM is the
# only thing that unlocks the world's LevelDB on shutdown.

FROM felddy/foundryvtt@sha256:5004a67fbbef8e3f5f82afb01c8dbe06626c57519cad541a59b1bdce3c2a97ac

LABEL org.opencontainers.image.title="cfg-server-foundryvtt"
LABEL org.opencontainers.image.description="CFG server-side wrapper for FoundryVTT hosting — additive felddy superset"
LABEL org.opencontainers.image.source="https://github.com/Crit-Fumble/cfg-server-foundryvtt"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
