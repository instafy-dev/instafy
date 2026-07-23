# syntax=docker/dockerfile:1

FROM rust:1.88 AS builder
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

FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY --from=builder /usr/local/bin/runtime-controller-build /usr/local/bin/runtime-controller
EXPOSE 8788
ENTRYPOINT ["/usr/local/bin/runtime-controller"]
