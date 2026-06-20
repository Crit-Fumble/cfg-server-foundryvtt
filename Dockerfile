# syntax=docker/dockerfile:1.7
#
# cfg-server-foundryvtt — CFG's server-side wrapper image for FoundryVTT hosting.
#
# Strict ADDITIVE SUPERSET of felddy/foundryvtt. This first cut IS felddy, pinned
# to an exact digest and re-tagged under CFG's registry — so pointing
# cfg-core-server's `foundryImage` at it is a provably byte-identical, one-config
# change that reverts to felddy in one line. felddy keeps owning the licensed
# binary download/cache, the license host-binding, Config/admin.txt, the
# /auth /join /setup surface, the /data layout, and uid 1000:1001.
#
# Why pin the DIGEST, not the rolling `:14` tag: felddy's :14 shifts under you
# (cfg-core-server already documents felddy rolling 14.361 -> 14.364 stranding
# installs). A digest makes the image reproducible + the swap/rollback symmetric.
#
# Future additive capabilities land behind default-OFF env flags, each on its own
# prove-passthrough cycle: a CO-LOCATED headless service-GM provisioning agent
# (SERVICE_GM_ENABLED, talking to localhost:30000), and the baked crit-fumble-core
# plugin (collapsing the launch-time syncCfgPlugin copy). NONE are present yet.
#
# DO NOT add an ENTRYPOINT here. cfg-core-server launches the container with its
# own `entrypoint` (FOUNDRY_GROUP_WRITABLE_ENTRYPOINT) that `exec`s felddy's
# entrypoint.sh, so any image ENTRYPOINT is overridden and dead. felddy's
# entrypoint + bash supervisor stays PID 1 — load-bearing: a clean SIGTERM is the
# only thing that unlocks the world's LevelDB on shutdown.

FROM felddy/foundryvtt@sha256:097f876d9c79f074380e219bf93753fa1916f31624637776fcf23c2dd3bb07fa

LABEL org.opencontainers.image.title="cfg-server-foundryvtt"
LABEL org.opencontainers.image.description="CFG server-side wrapper for FoundryVTT hosting — additive felddy superset"
LABEL org.opencontainers.image.source="https://github.com/Crit-Fumble/cfg-server-foundryvtt"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
