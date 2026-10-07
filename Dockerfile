# syntax=docker/dockerfile:1.7
#
# cfg-server-foundryvtt — CFG's server-side wrapper image for FoundryVTT hosting.
#
# Strict ADDITIVE SUPERSET of felddy/foundryvtt: felddy pinned to an exact digest,
# re-tagged under CFG's registry, plus exactly ONE declared addition (a static
# ffmpeg binary — see "THE ONE ADDITION" below). Pointing cfg-core-server's
# `foundryImage` at it is still a one-config change that reverts to felddy in one
# line (losing only ffmpeg). felddy keeps owning the licensed binary
# download/cache, the license host-binding, Config/admin.txt, the /auth /join
# /setup surface, the /data layout, and uid 1000:1000.
#
# ⚠️ THE UID IS 1000:1000, NOT 1000:1001. 1001 is CFG_DATA_GID, a SUPPLEMENTARY
# group cfg-core-server adds at launch (`groupAdd`), never the image's own gid.
# Verified: `id` in this image reports uid=1000(node) gid=1000(node).
# check-felddy-contract.mjs asserts the real values, so a reader who "fixes" the
# gid to 1001 fails CI.
#
# Why pin the DIGEST, not the rolling `:14` tag: felddy's :14 shifts under you,
# and a roll can strand installs. A digest makes the image reproducible + the
# swap/rollback symmetric.
#
# ── THE PIN BELOW IS felddy 14.368 ──────────────────────────────────────────
# Resolve it against the REGISTRY manifest endpoint, not Docker Hub's tag JSON:
# `:14` and `:14.<n>` must both answer with the digest on the FROM line below.
#
# ⛔ DO NOT RESTATE SPECIFIC DIGESTS IN THIS COMMENT. They rot at every bump —
# upstream-watch only rewrites the header line above. State the METHOD; the FROM
# line is the value.
#
# ⚠️ AND THE PIN HAS A SECOND HOME: module/tests/docker-compose.yml pins the
# same base for the licensed integration harness. C7 in check-felddy-contract
# ABORTS THE BUILD when the two disagree, so bump them together.
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
# The daily `upstream-watch` in cfg-core-dev-tools watches this line and opens a
# bump PR when felddy's `:14` moves. It rewrites the FROM digest, the same digest
# in module/tests/docker-compose.yml, and the version in the header line above —
# nothing else; if you restructure this line, update the `foundryvtt` case in that
# workflow or its sed will hard-fail (deliberately loud, never a quiet no-op).
#
# Any additive RUNTIME capability lands behind a default-OFF env flag, each on
# its own prove-passthrough cycle. The headless service-GM is not one of them:
# its drain driver is a separate one-shot image (agent/Dockerfile) the platform
# spawns as a sibling container, so it never touches this image.
#
# ── THE ONE ADDITION: a static ffmpeg at /usr/local/bin/ffmpeg ───────────────
# Owner decision (2026-09-06): ffmpeg lives in the Foundry image "for now"
# (shared media deps may be lifted across kinds later). Foundry animates WEBM
# tokens and never GIF, so GMs need a converter next to their world data. It
# is NOT a runtime switch and needs no env flag: nothing in felddy ever calls
# it, so the image behaves byte-for-byte like felddy until something runs the
# binary on purpose.
#
# HOW IT IS INVOKED — never `docker exec`. core-server reaches Docker through a
# socket proxy whose allowlist has no exec; instead it starts THIS image as an
# ephemeral job container (entrypoint /usr/local/bin/ffmpeg, validated argv,
# network none, read-only rootfs, cap-drop ALL, only the one installation's
# data dir mounted, uid 1000 + the install gid) and removes it when the job
# exits. The image already being on every host is the reason it lives here.
#
# WHY A STATIC BINARY VIA `COPY --from`, NOT `apt-get install ffmpeg`: ~130 MB
# in one layer with zero shared libraries, versus ~450 MB and ~200 packages via
# apt on this Debian base. The source is pinned by its manifest-LIST digest (not
# a platform digest) so the same line resolves arm64 on a dev Mac and amd64 in
# CI and prod — the contract check (P1) needs wrapper and base on one platform.
# 9.0.1, not 7.1, because 7.1 predates the 2026 batch of
# demuxer/decoder CVEs (CVE-2026-39210..39218); the sandbox contains a decoder
# bug, a current build avoids it. upstream-watch never bumps this digest — a
# codec binary bump is a reviewed change (re-run the argv template + the
# playlist-named-.gif refusal against the new build before pinning it).
#
# LICENSE: /usr/local/bin/ffmpeg is a GPLv3 static build (--enable-gpl
# --enable-version3, no nonfree components) redistributed inside this AGPL-3.0
# image as an aggregated component; its source is mwader/static-ffmpeg plus the
# versions.json that build embeds.
#
# ⛔ NEVER COPY it under /data (shadowed by the bind mount — H_DATA_EMPTY) or
# /home/node (H_SCRIPTS reads any changed file there as felddy's scripts being
# hijacked). /usr/local/bin is outside both. The line is declared, EXACTLY, in
# felddy-contract-rules.mjs (STATIC_FFMPEG + ADDITIONS): C3 refuses any other
# COPY — a floating `:7.1` tag, another digest, another destination; P2 counts
# exactly one added layer; H_FFMPEG proves the binary actually runs. Bumping
# ffmpeg means a new index digest in BOTH places, and the mutation suite goes
# red if they disagree.
#
# ⛔ BAKING THE crit-fumble-core PLUGIN IN WAS INVESTIGATED AND REJECTED (#1).
# It is NOT a pending capability — it cannot work here, and
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

FROM felddy/foundryvtt@sha256:8ec86078b0c461644d896cbe3a9f9bcae7d1ce8dc8d91eeb0b0f1d94c91c072f

# static ffmpeg 9.0.1 (mwader/static-ffmpeg:9.0.1, manifest-list digest) — see
# the header. Declared verbatim in felddy-contract-rules.mjs STATIC_FFMPEG.
COPY --from=mwader/static-ffmpeg@sha256:54e55b0cb8f672870fc38ceb2e6c411855cb3b39c505f5f3b2505ee01ed5f2b7 /ffmpeg /usr/local/bin/ffmpeg

LABEL org.opencontainers.image.title="cfg-server-foundryvtt"
LABEL org.opencontainers.image.description="CFG server-side wrapper for FoundryVTT hosting — additive felddy superset"
LABEL org.opencontainers.image.source="https://github.com/Crit-Fumble/cfg-server-foundryvtt"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
# The tool contract cfg-core-server's data-ops catalog gates on: a comma list of
# tools this image can run as an ephemeral job. No label → no ops offered, so
# an image without ffmpeg never advertises "Convert to WebM". Declared in
# ADDITIONS.labels; C2/P4 keep the Dockerfile and the rules in lockstep.
LABEL com.crit-fumble.tools="ffmpeg"
