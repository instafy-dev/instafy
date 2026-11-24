# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM rust:1.83-alpine@sha256:0ac946ed7597a9f053a1be2ce38c09aa88b3d7079a91ea491493615294b1f699 AS builder
RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static
WORKDIR /src

COPY packages/runtime-provider-core/Cargo.toml packages/runtime-provider-core/Cargo.toml
COPY packages/runtime-provider-core/src packages/runtime-provider-core/src
COPY packages/runtime-provider-service/Cargo.toml packages/runtime-provider-service/Cargo.toml
COPY packages/runtime-provider-service/Cargo.lock packages/runtime-provider-service/Cargo.lock
COPY packages/runtime-provider-service/src packages/runtime-provider-service/src

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --manifest-path packages/runtime-provider-service/Cargo.toml --locked

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
# Minimum versions, never exact pins: Alpine drops a package's old -rN build from
# its index when it rebuilds it, so an exact pin stops resolving and fails every
# publish. The digest-pinned alpine:3.23 base keeps apk on that stable branch, and
# the publishers' HIGH/CRITICAL scan still gates whatever it installs.
# musl 1.2.5-r24 fixes CVE-2026-107891 and zlib 1.3.2-r1 fixes CVE-2026-85091.
# OpenSSL and the Docker CLI toolchain start at the last builds the scan passed.
ARG MUSL_MIN_VERSION=1.2.5-r24
ARG ZLIB_MIN_VERSION=1.3.2-r1
ARG OPENSSL_MIN_VERSION=3.5.9-r1
ARG DOCKER_CLI_MIN_VERSION=29.5.2-r0
ARG DOCKER_BUILDX_MIN_VERSION=0.30.1-r6
ARG DOCKER_COMPOSE_MIN_VERSION=2.40.3-r6
RUN apk add --no-cache \
    "musl>=${MUSL_MIN_VERSION}" \
    "musl-utils>=${MUSL_MIN_VERSION}" \
    "zlib>=${ZLIB_MIN_VERSION}" \
    "libcrypto3>=${OPENSSL_MIN_VERSION}" \
    "libssl3>=${OPENSSL_MIN_VERSION}" \
    "docker-cli>=${DOCKER_CLI_MIN_VERSION}" \
    "docker-cli-buildx>=${DOCKER_BUILDX_MIN_VERSION}" \
    "docker-cli-compose>=${DOCKER_COMPOSE_MIN_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
COPY --from=builder /src/packages/runtime-provider-service/target/release/runtime-provider-service /usr/local/bin/runtime-provider-service
EXPOSE 9090
ENTRYPOINT ["/usr/local/bin/runtime-provider-service"]
