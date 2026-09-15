# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

## Pin Rust to keep CI build caches warm (avoid nightly churn).
ARG RUST_TOOLCHAIN=1.95.0
ARG RUST_IMAGE=rust:${RUST_TOOLCHAIN}-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082
ARG RUNTIME_BASE=debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

## Cargo profile to build (release for production images, dev for CI speed).
ARG BUILD_PROFILE=release
ARG BUILD_ARTIFACT_DIR=release

########################
# Dependency planner
########################
FROM ${RUST_IMAGE} AS chef
ARG CARGO_CHEF_VERSION=0.1.77
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev protobuf-compiler ca-certificates \
      clang lld \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --version "${CARGO_CHEF_VERSION}" --locked
WORKDIR /src
COPY packages/openai-proxy-server/ packages/openai-proxy-server/
COPY packages/runtime-contracts/ packages/runtime-contracts/
COPY codex/codex-rs/ codex/codex-rs/
COPY proto/ proto/
WORKDIR /src/packages/openai-proxy-server
RUN cargo chef prepare --recipe-path /src/recipe.json

########################
# Dependency builder
########################
FROM ${RUST_IMAGE} AS builder-deps
ARG BUILD_PROFILE=release
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev protobuf-compiler ca-certificates \
      clang lld \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/usr/local/cargo \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"
WORKDIR /src
COPY --from=chef /src/recipe.json recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo chef cook --profile ${BUILD_PROFILE} --recipe-path recipe.json --locked

########################
# Build
########################
FROM ${RUST_IMAGE} AS builder
ARG BUILD_PROFILE=release
ARG BUILD_ARTIFACT_DIR=release
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev protobuf-compiler ca-certificates \
      clang lld \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/usr/local/cargo \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"
WORKDIR /src
COPY packages/openai-proxy-server/ packages/openai-proxy-server/
COPY packages/runtime-contracts/ packages/runtime-contracts/
COPY codex/codex-rs/ codex/codex-rs/
COPY proto/ proto/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --profile ${BUILD_PROFILE} --manifest-path packages/openai-proxy-server/Cargo.toml --bin proxy --locked

########################
# Runtime
########################
FROM ${RUNTIME_BASE} AS runtime
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
# Explicitly refresh inherited PCRE2; installing another package does not upgrade it.
ARG PCRE2_MIN_VERSION=10.42-1+deb12u1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libpcre2-8-0 \
    && test -n "${PCRE2_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge "${PCRE2_MIN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_ARTIFACT_DIR=release
COPY --from=builder /src/packages/openai-proxy-server/target/${BUILD_ARTIFACT_DIR}/proxy /usr/local/bin/openai-proxy
ENV CODEX_HOME=/root/.codex
EXPOSE 8789
ENTRYPOINT ["/usr/local/bin/openai-proxy"]
