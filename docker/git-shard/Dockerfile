# syntax=docker/dockerfile:1.7

ARG RUST_TOOLCHAIN=1.91.1
ARG RUST_IMAGE=rust:${RUST_TOOLCHAIN}-slim-bookworm
ARG BUILD_PROFILE=release
ARG BUILD_ARTIFACT_DIR=release
ARG RUNTIME_BASE=debian:trixie-slim

FROM ${RUST_IMAGE} AS builder
ARG BUILD_PROFILE=release
ARG BUILD_ARTIFACT_DIR=release
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packages/git-service/ packages/git-service/
COPY packages/runtime-agent/assets/ packages/runtime-agent/assets/
COPY packages/runtime-contracts/ packages/runtime-contracts/
COPY proto/ proto/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --profile ${BUILD_PROFILE} --manifest-path packages/git-service/Cargo.toml --bin git-shard --locked

FROM ${RUNTIME_BASE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_ARTIFACT_DIR=release
COPY --from=builder /src/packages/git-service/target/${BUILD_ARTIFACT_DIR}/git-shard /usr/local/bin/git-shard
ENV RUST_LOG=info,git_service=info \
    GIT_REPO_ROOT=/var/lib/instafy-git/repos
WORKDIR /var/lib/instafy-git
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/git-shard"]
