# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG RUST_TOOLCHAIN=1.91.1
ARG RUST_IMAGE=rust:${RUST_TOOLCHAIN}-slim-bookworm@sha256:8514999d4786ef12efe89239e86b3d0a021b94b9d35108c8efe6c79ca7dc1a65
ARG BUILD_PROFILE=release
ARG BUILD_ARTIFACT_DIR=release
ARG RUNTIME_BASE=debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd

FROM ${RUST_IMAGE} AS builder
ARG BUILD_PROFILE=release
ARG BUILD_ARTIFACT_DIR=release
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packages/origin-http-server/ packages/origin-http-server/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --profile ${BUILD_PROFILE} --manifest-path packages/origin-http-server/Cargo.toml --bin origin-http-server --locked

FROM ${RUNTIME_BASE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_ARTIFACT_DIR=release
COPY --from=builder /src/packages/origin-http-server/target/${BUILD_ARTIFACT_DIR}/origin-http-server /usr/local/bin/origin-http-server
ENV RUST_LOG=info,origin_http_server=info
EXPOSE 54333
ENTRYPOINT ["/usr/local/bin/origin-http-server"]
