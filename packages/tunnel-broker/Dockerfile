# Multi-stage build for the tunnel broker service.
FROM rust:1.88 AS builder
WORKDIR /app

# Pre-copy manifests for incremental rebuilds.
COPY Cargo.toml Cargo.lock* ./
COPY crates/tunnel-broker/Cargo.toml crates/tunnel-broker/Cargo.toml
COPY crates/tunnel-broker-types/Cargo.toml crates/tunnel-broker-types/Cargo.toml
COPY crates/tunnel-broker-types/src/lib.rs crates/tunnel-broker-types/src/lib.rs

# Fetch dependencies first to leverage Docker cache.
RUN mkdir -p crates/tunnel-broker/src \
  && echo "pub fn placeholder() {}" > crates/tunnel-broker/src/lib.rs \
  && echo "fn main() {}" > crates/tunnel-broker/src/main.rs \
  && cargo fetch

# Now copy the full source and rebuild.
COPY . .
RUN cargo build -p tunnel-broker --release

FROM debian:bookworm-slim AS rathole
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETARCH
ARG RATHOLE_VERSION=v0.5.0
RUN set -eux; \
  case "${TARGETARCH:-arm64}" in \
    arm64) asset="rathole-aarch64-unknown-linux-musl.zip" ;; \
    amd64) asset="rathole-x86_64-unknown-linux-gnu.zip" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/rathole-org/rathole/releases/download/${RATHOLE_VERSION}/${asset}"; \
  mkdir -p /rathole-install/bin; \
  curl -fsSL "$url" -o /tmp/rathole.zip; \
  unzip -j /tmp/rathole.zip rathole -d /rathole-install/bin; \
  chmod +x /rathole-install/bin/rathole; \
  if [ "${BUILDPLATFORM:-}" = "${TARGETPLATFORM:-}" ]; then \
    /rathole-install/bin/rathole --help >/dev/null; \
  else \
    echo "Skipping rathole exec check for cross-build ${BUILDPLATFORM:-unknown}->${TARGETPLATFORM:-unknown}"; \
  fi

FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
RUN apt-get update \
  && apt-get install -y --no-install-recommends libssl3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10001 -r -M tunnel-broker
WORKDIR /app
COPY --from=builder /app/target/release/tunnel-broker /usr/local/bin/tunnel-broker
COPY --from=builder /app/target/release/render_rathole /usr/local/bin/render_rathole
COPY --from=builder /app/target/release/ingress_sidecar /usr/local/bin/ingress_sidecar
COPY --from=builder /app/target/release/dns_sidecar /usr/local/bin/dns_sidecar
COPY --from=rathole /rathole-install/bin/rathole /usr/local/bin/rathole

ENV RUST_LOG=tunnel_broker=info,info
EXPOSE 8080
USER tunnel-broker
CMD ["tunnel-broker"]
