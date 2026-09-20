# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM rust:1.88@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS builder
RUN apt-get update && \
    apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV CARGO_TARGET_DIR=/app/target

# Build with sources (no root Cargo.toml; crate lives under packages/)
COPY packages/runtime-controller packages/runtime-controller
COPY packages/runtime-contracts packages/runtime-contracts
COPY packages/runtime-agent/assets/instafy packages/runtime-agent/assets/instafy
COPY proto proto
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build --release --bin runtime-controller --manifest-path packages/runtime-controller/Cargo.toml && \
    cp /app/target/release/runtime-controller /usr/local/bin/runtime-controller-build

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
# Explicitly refresh inherited PCRE2; installing another package does not upgrade it.
ARG PCRE2_MIN_VERSION=10.42-1+deb12u1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libpcre2-8-0 \
    && test -n "${PCRE2_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge "${PCRE2_MIN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY --from=builder /usr/local/bin/runtime-controller-build /usr/local/bin/runtime-controller
EXPOSE 8788
ENTRYPOINT ["/usr/local/bin/runtime-controller"]
