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
COPY packages/git-service/ packages/git-service/
COPY packages/runtime-agent/assets/ packages/runtime-agent/assets/
COPY packages/runtime-contracts/ packages/runtime-contracts/
COPY proto/ proto/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --profile ${BUILD_PROFILE} --manifest-path packages/git-service/Cargo.toml --bin git-edge --locked

FROM ${RUNTIME_BASE} AS runtime
# Refresh inherited security packages even when no new dependency requests them.
ARG GZIP_MIN_VERSION=1.13-1+deb13u1
ARG PCRE2_MIN_VERSION=10.46-1~deb13u2
ARG SQLITE3_MIN_VERSION=3.46.1-7+deb13u2
ARG PERL_BASE_MIN_VERSION=5.40.1-6+deb13u1
RUN apt-get update && apt-get install -y --no-install-recommends \
      bsdutils \
      ca-certificates \
      gzip \
      libpcre2-8-0 \
      libsqlite3-0 \
      login \
      mount \
      perl-base \
      util-linux \
    && test -n "${GZIP_MIN_VERSION}" && test -n "${PCRE2_MIN_VERSION}" \
    && test -n "${SQLITE3_MIN_VERSION}" && test -n "${PERL_BASE_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' gzip)" ge "${GZIP_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge "${PCRE2_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libsqlite3-0)" ge "${SQLITE3_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' perl-base)" ge "${PERL_BASE_MIN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_ARTIFACT_DIR=release
COPY --from=builder /src/packages/git-service/target/${BUILD_ARTIFACT_DIR}/git-edge /usr/local/bin/git-edge
ENV RUST_LOG=info,git_service=info
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/git-edge"]
