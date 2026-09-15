# Multi-stage build for the tunnel broker service.
FROM rust:1.88@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS builder
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
# The CI smoke image is also the production image, so keep the broker's unit
# suite in the same cached release build instead of compiling it again on the
# host with a second Cargo target directory.
RUN cargo test -p tunnel-broker --release --tests \
  && cargo build -p tunnel-broker --release

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS rathole
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETARCH
ARG RATHOLE_VERSION=v0.5.0
ARG RATHOLE_SHA256_AMD64=3e7d0d0f365120cd3cd351d147d1a12ee960c8068b464d4dd533a3821873b80e
ARG RATHOLE_SHA256_ARM64=fa4a6fc63d86f8f1faa7c103a845e4715ce79a048455c0eec897b27237576564
RUN set -eux; \
  case "${TARGETARCH:-arm64}" in \
    arm64) asset="rathole-aarch64-unknown-linux-musl.zip"; checksum="${RATHOLE_SHA256_ARM64}" ;; \
    amd64) asset="rathole-x86_64-unknown-linux-gnu.zip"; checksum="${RATHOLE_SHA256_AMD64}" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/rathole-org/rathole/releases/download/${RATHOLE_VERSION}/${asset}"; \
  mkdir -p /rathole-install/bin; \
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error "$url" -o /tmp/rathole.zip; \
  printf '%s  %s\n' "${checksum}" /tmp/rathole.zip | sha256sum --check --status; \
  unzip -j /tmp/rathole.zip rathole -d /rathole-install/bin; \
  chmod +x /rathole-install/bin/rathole; \
  if [ "${BUILDPLATFORM:-}" = "${TARGETPLATFORM:-}" ]; then \
    /rathole-install/bin/rathole --help >/dev/null; \
  else \
    echo "Skipping rathole exec check for cross-build ${BUILDPLATFORM:-unknown}->${TARGETPLATFORM:-unknown}"; \
  fi

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
# Explicitly refresh inherited PCRE2; installing another package does not upgrade it.
ARG PCRE2_MIN_VERSION=10.42-1+deb12u1
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      libssl3 \
      ca-certificates \
      libpcre2-8-0 \
  && test -n "${PCRE2_MIN_VERSION}" \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge "${PCRE2_MIN_VERSION}" \
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
