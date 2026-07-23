# syntax=docker/dockerfile:1.7

# This image is intentionally local/E2E-only. Production keeps the separate
# git-edge, git-shard, and origin-gateway images so each deployed service has
# its own minimal runtime surface.
ARG RUST_TOOLCHAIN=1.91.1
ARG RUST_IMAGE=rust:${RUST_TOOLCHAIN}-slim-bookworm
ARG BUILD_PROFILE=release
ARG BUILD_ARTIFACT_DIR=release
ARG RUNTIME_BASE=debian:trixie-slim

FROM ${RUST_IMAGE} AS builder
ARG BUILD_PROFILE
ARG BUILD_ARTIFACT_DIR
ARG CARGO_PROFILE_DEV_DEBUG=2
ENV CARGO_TARGET_DIR=/src/target \
    CARGO_PROFILE_DEV_DEBUG=${CARGO_PROFILE_DEV_DEBUG}
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packages/git-service/ packages/git-service/
COPY packages/runtime-agent/assets/ packages/runtime-agent/assets/
COPY packages/runtime-contracts/ packages/runtime-contracts/
COPY packages/origin-http-server/ packages/origin-http-server/
COPY proto/ proto/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --profile ${BUILD_PROFILE} --manifest-path packages/git-service/Cargo.toml --bins --locked \
    && cargo build --profile ${BUILD_PROFILE} --manifest-path packages/origin-http-server/Cargo.toml --bin origin-http-server --locked \
    && install -Dm755 /src/target/${BUILD_ARTIFACT_DIR}/git-edge /src/build-artifacts/${BUILD_ARTIFACT_DIR}/git-edge \
    && install -Dm755 /src/target/${BUILD_ARTIFACT_DIR}/git-shard /src/build-artifacts/${BUILD_ARTIFACT_DIR}/git-shard \
    && install -Dm755 /src/target/${BUILD_ARTIFACT_DIR}/origin-http-server /src/build-artifacts/${BUILD_ARTIFACT_DIR}/origin-http-server

FROM ${RUNTIME_BASE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && mkdir -p /var/lib/instafy-git \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_ARTIFACT_DIR
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/git-edge /usr/local/bin/git-edge
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/git-shard /usr/local/bin/git-shard
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/origin-http-server /usr/local/bin/origin-http-server
EXPOSE 8080 8081 54333
