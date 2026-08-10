## Pin the Rust image to keep CI build caches warm (avoid nightly churn).
ARG RUST_TOOLCHAIN=1.95.0
ARG RUST_IMAGE=rust:${RUST_TOOLCHAIN}-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082
ARG GO_VERSION=1.26.5
ARG GO_IMAGE=golang:${GO_VERSION}-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG CLI_NODE_IMAGE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG PLAYWRIGHT_VERSION=1.61.1
ARG NPM_VERSION=12.0.1
ARG PNPM_VERSION=11.17.0
# npm (through 12.0.2) vendors vulnerable brace-expansion and ip-address
# versions. Replace every vendored copy with exact fixed tarballs whose
# checksums are committed here until npm ships both fixes itself.
ARG BRACE_EXPANSION_VERSION=5.0.9
ARG BRACE_EXPANSION_SHA256=5d06001fddd25cbee90c96db4dc5b7b57711b984c3141e28d10f143deb52dbaf
ARG IP_ADDRESS_VERSION=10.3.1
ARG IP_ADDRESS_SHA256=ad1790063beea11a312c801df30d58e147de762f4f77787552376eb7424623e5
# Rathole is used for self-hosted tunnel ingress. The crates.io release currently
# depends on older `time` versions that fail to compile on newer Rust toolchains,
# so we install a prebuilt release binary instead of `cargo install`.
ARG RATHOLE_VERSION=0.5.0
ARG RATHOLE_SHA256_AMD64=3e7d0d0f365120cd3cd351d147d1a12ee960c8068b464d4dd533a3821873b80e
ARG RATHOLE_SHA256_ARM64=fa4a6fc63d86f8f1faa7c103a845e4715ce79a048455c0eec897b27237576564
ARG UBOLITE_SHA256_AMD64=d5811c79278f27001ae0be090e824577c505cc2b4151997e252462df9f11ba36
ARG UBOLITE_SHA256_ARM64=d5811c79278f27001ae0be090e824577c505cc2b4151997e252462df9f11ba36
# Default to dev profile for faster, debug-friendly test builds.
ARG BUILD_PROFILE=dev
# Cargo's dev profile outputs to target/debug.
ARG BUILD_ARTIFACT_DIR=debug
# Runtime base should have glibc >= the builder image; Debian trixie is newer than bookworm.
ARG RUNTIME_BASE=debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd
ARG WEBDEV_BASE=mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48

########################
# Runtime Node distribution
########################
FROM ${NODE_IMAGE} AS node-runtime

########################
# Shared Browser egress proxy
########################
FROM ${GO_IMAGE} AS browser-egress-proxy-builder

WORKDIR /src
COPY packages/browser-egress-proxy/go.mod ./
COPY packages/browser-egress-proxy/ ./
RUN go test ./...
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/browser-egress-proxy . \
    && go version -m /out/browser-egress-proxy >/dev/null

########################
# Shared Browser WebRTC sender
########################
FROM ${GO_IMAGE} AS browser-webrtc-builder

WORKDIR /src
COPY packages/browser-webrtc-sender/go.mod packages/browser-webrtc-sender/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY packages/browser-webrtc-sender/ ./
RUN --mount=type=cache,target=/go/pkg/mod go test ./...
RUN --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/browser-webrtc-sender . \
    && go version -m /out/browser-webrtc-sender >/dev/null

########################
# Instafy CLI builder
########################
FROM ${CLI_NODE_IMAGE} AS cli-builder

WORKDIR /src
COPY package.json package.json
COPY pnpm-lock.yaml pnpm-lock.yaml
COPY pnpm-workspace.yaml pnpm-workspace.yaml
COPY packages/instafy-cli/package.json packages/instafy-cli/package.json
COPY packages/instafy-cli/tsconfig.json packages/instafy-cli/tsconfig.json
COPY packages/instafy-cli/tsup.config.ts packages/instafy-cli/tsup.config.ts
COPY packages/instafy-cli/src packages/instafy-cli/src
COPY packages/instafy-cli/bin packages/instafy-cli/bin
COPY packages/instafy-sdk/package.json packages/instafy-sdk/package.json
COPY packages/instafy-sdk/src packages/instafy-sdk/src
COPY packages/provider-client/package.json packages/provider-client/package.json
COPY packages/provider-client/index.js packages/provider-client/index.js
COPY packages/provider-client/index.d.ts packages/provider-client/index.d.ts
COPY packages/provider-contract/package.json packages/provider-contract/package.json
COPY packages/provider-contract/index.js packages/provider-contract/index.js
COPY packages/provider-contract/index.d.ts packages/provider-contract/index.d.ts

RUN corepack enable
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --filter instafy-monorepo --filter @instafy/cli... --frozen-lockfile
RUN pnpm --filter @instafy/cli run build
RUN pnpm deploy --legacy --filter @instafy/cli --prod /out

########################
# Dependencies planner
########################
FROM ${RUST_IMAGE} AS chef
ARG CARGO_CHEF_VERSION=0.1.77
# codex-linux-sandbox's vendored bubblewrap build.rs probes libcap via pkg-config.
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev libcap-dev protobuf-compiler ca-certificates \
      clang lld \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --version "${CARGO_CHEF_VERSION}" --locked
WORKDIR /src
COPY packages/runtime-agent/Cargo.toml packages/runtime-agent/Cargo.lock packages/runtime-agent/
RUN mkdir -p packages/runtime-agent/src \
    && printf 'pub fn cargo_chef_placeholder() {}\n' > packages/runtime-agent/src/lib.rs \
    && printf 'fn main() {}\n' > packages/runtime-agent/src/main.rs
COPY packages/runtime-contracts/ packages/runtime-contracts/
COPY packages/openai-proxy-server/ packages/openai-proxy-server/
COPY packages/origin-http-server/ packages/origin-http-server/
COPY codex/codex-rs/ codex/codex-rs/
COPY proto/ proto/
WORKDIR /src/packages/runtime-agent
RUN cargo chef prepare --recipe-path /src/recipe.json

########################
# Dependencies builder
########################
FROM ${RUST_IMAGE} AS builder-deps
ARG BUILD_PROFILE=dev
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev libcap-dev protobuf-compiler \
      clang lld curl \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/usr/local/cargo \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"
WORKDIR /src/packages/runtime-agent
COPY --from=chef /usr/local/cargo/bin/cargo-chef /usr/local/cargo/bin/cargo-chef
COPY --from=chef /src/packages/runtime-agent /src/packages/runtime-agent
COPY --from=chef /src/packages/runtime-contracts /src/packages/runtime-contracts
COPY --from=chef /src/packages/openai-proxy-server /src/packages/openai-proxy-server
COPY --from=chef /src/packages/origin-http-server /src/packages/origin-http-server
COPY --from=chef /src/codex /src/codex
COPY --from=chef /src/proto /src/proto
COPY --from=chef /src/recipe.json /src/recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/packages/runtime-agent/target \
    cargo chef cook --profile ${BUILD_PROFILE} --recipe-path /src/recipe.json --locked

########################
# Application builder
########################
FROM ${RUST_IMAGE} AS builder
ARG BUILD_PROFILE=dev
ARG BUILD_ARTIFACT_DIR=debug
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev libcap-dev protobuf-compiler \
      clang lld curl \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/usr/local/cargo \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"
WORKDIR /src
COPY packages/runtime-agent/ packages/runtime-agent/
COPY packages/runtime-contracts/ packages/runtime-contracts/
COPY packages/openai-proxy-server/ packages/openai-proxy-server/
COPY packages/origin-http-server/ packages/origin-http-server/
COPY codex/codex-rs/ codex/codex-rs/
COPY proto/ proto/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/packages/runtime-agent/target \
    cargo build --profile ${BUILD_PROFILE} --manifest-path packages/runtime-agent/Cargo.toml --locked \
    && cargo build --profile ${BUILD_PROFILE} --manifest-path packages/runtime-agent/Cargo.toml -p codex-linux-sandbox --locked \
    && mkdir -p /src/build-artifacts/${BUILD_ARTIFACT_DIR} \
    && cp /src/packages/runtime-agent/target/${BUILD_ARTIFACT_DIR}/runtime-agent /src/build-artifacts/${BUILD_ARTIFACT_DIR}/runtime-agent \
    && cp /src/packages/runtime-agent/target/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox

########################
# Binary-only export (dev fast loop): `--target binary-export --output type=local` yields just
# the compiled binaries so a running runtime container can be hot-swapped without rebuilding the
# heavy browser-based runtime image.
########################
FROM scratch AS binary-export
ARG BUILD_ARTIFACT_DIR=debug
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/runtime-agent /runtime-agent
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox /codex-linux-sandbox

########################
# Runtime image
########################
FROM ${RUNTIME_BASE} AS runtime

ARG RATHOLE_VERSION=0.5.0
ARG RATHOLE_SHA256_AMD64
ARG RATHOLE_SHA256_ARM64
ARG TARGETARCH
ARG PLAYWRIGHT_VERSION
ARG NPM_VERSION
ARG PNPM_VERSION
ARG BRACE_EXPANSION_VERSION
ARG BRACE_EXPANSION_SHA256
ARG IP_ADDRESS_VERSION
ARG IP_ADDRESS_SHA256

COPY --from=node-runtime /usr/local/ /usr/local/
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      chromium \
      curl \
      git \
      less \
      procps \
      ripgrep \
      unzip \
      openssh-client \
      python-is-python3 \
      python3 \
      python3-pip && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g "npm@${NPM_VERSION}" && \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "playwright@${PLAYWRIGHT_VERSION}" "@playwright/test@${PLAYWRIGHT_VERSION}" && \
    npm install -g "pnpm@${PNPM_VERSION}" && \
    ln -sf /usr/local/bin/pnpm /usr/local/bin/pnpx && \
    if [ ! -e /usr/local/bin/npx ] && [ -x /usr/bin/npx ]; then ln -s /usr/bin/npx /usr/local/bin/npx; fi && \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-${BRACE_EXPANSION_VERSION}.tgz" \
      --output /tmp/brace-expansion.tgz && \
    printf '%s  %s\n' "${BRACE_EXPANSION_SHA256}" /tmp/brace-expansion.tgz | sha256sum --check --status && \
    for be_dir in $(find /usr -type d -path '*/node_modules/npm/node_modules/brace-expansion' 2>/dev/null); do \
      rm -rf "$be_dir" && mkdir -p "$be_dir" && \
      tar -xzf /tmp/brace-expansion.tgz -C "$be_dir" --strip-components=1; \
    done && \
    rm /tmp/brace-expansion.tgz && \
    unpatched="$(find /usr -type f -path '*/node_modules/npm/node_modules/brace-expansion/package.json' -exec grep -L "\"version\": \"${BRACE_EXPANSION_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched brace-expansion copies: $unpatched" >&2; exit 1; fi && \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/ip-address/-/ip-address-${IP_ADDRESS_VERSION}.tgz" \
      --output /tmp/ip-address.tgz && \
    printf '%s  %s\n' "${IP_ADDRESS_SHA256}" /tmp/ip-address.tgz | sha256sum --check --status && \
    for ia_dir in $(find /usr -type d -path '*/node_modules/npm/node_modules/ip-address' 2>/dev/null); do \
      rm -rf "$ia_dir" && mkdir -p "$ia_dir" && \
      tar -xzf /tmp/ip-address.tgz -C "$ia_dir" --strip-components=1; \
    done && \
    rm /tmp/ip-address.tgz && \
    unpatched="$(find /usr -type f -path '*/node_modules/npm/node_modules/ip-address/package.json' -exec grep -L "\"version\": \"${IP_ADDRESS_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched ip-address copies: $unpatched" >&2; exit 1; fi && \
    rm -rf /root/.npm

ARG BUILD_PROFILE=dev
ARG BUILD_ARTIFACT_DIR=debug
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/runtime-agent /usr/local/bin/runtime-agent
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox
COPY --from=browser-egress-proxy-builder /out/browser-egress-proxy /usr/local/bin/browser-egress-proxy
COPY --from=browser-webrtc-builder /out/browser-webrtc-sender /usr/local/bin/browser-webrtc-sender
RUN set -eu; \
    for binary in /usr/local/bin/browser-egress-proxy /usr/local/bin/browser-webrtc-sender; do \
      magic="$(od -An -tx1 -N4 "${binary}" | tr -d ' \n')"; \
      [ "${magic}" = "7f454c46" ] || { echo "Invalid ELF helper binary: ${binary}" >&2; exit 1; }; \
    done
COPY --from=cli-builder /out /opt/instafy-cli

RUN install -m 0755 /usr/local/bin/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox.real \
    && printf '%s\n' \
      '#!/bin/sh' \
      'if [ "$1" = "--codex-run-as-apply-patch" ]; then' \
      '  exec /usr/local/bin/runtime-agent "$@"' \
      'fi' \
      'exec /usr/local/bin/codex-linux-sandbox.real "$@"' \
      > /usr/local/bin/codex-linux-sandbox \
    && chmod +x /usr/local/bin/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox.real

RUN chmod +x /opt/instafy-cli/bin/instafy.js \
    && ln -sf /opt/instafy-cli/bin/instafy.js /usr/local/bin/instafy
RUN ln -sf /usr/local/bin/runtime-agent /usr/local/bin/codex

RUN set -eu; \
    arch="${TARGETARCH:-}"; \
    if [ -z "$arch" ]; then \
      uname_arch="$(uname -m || true)"; \
      case "$uname_arch" in \
        x86_64) arch="amd64" ;; \
        aarch64|arm64) arch="arm64" ;; \
        *) arch="$uname_arch" ;; \
      esac; \
    fi; \
    case "$arch" in \
      amd64) asset="rathole-x86_64-unknown-linux-gnu.zip"; checksum="${RATHOLE_SHA256_AMD64}" ;; \
      arm64) asset="rathole-aarch64-unknown-linux-musl.zip"; checksum="${RATHOLE_SHA256_ARM64}" ;; \
      *) echo "Unsupported arch=$arch (expected amd64|arm64)"; exit 1 ;; \
    esac; \
    url="https://github.com/rathole-org/rathole/releases/download/v${RATHOLE_VERSION}/${asset}"; \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error -o /tmp/rathole.zip "$url"; \
    printf '%s  %s\n' "${checksum}" /tmp/rathole.zip | sha256sum --check --status; \
    unzip -q /tmp/rathole.zip -d /tmp/rathole; \
    install -m 0755 /tmp/rathole/rathole /usr/local/bin/rathole; \
    rm -rf /tmp/rathole /tmp/rathole.zip; \
    rathole --version

COPY docker/runtime/entrypoint.sh /usr/local/bin/runtime-entrypoint

RUN chmod +x /usr/local/bin/runtime-entrypoint

ENV WORKSPACE_DIR=/workspace \
    CODEX_HOME=/workspace/.codex \
    PATH=/usr/local/bin:$PATH \
    CODEX_LINUX_SANDBOX_EXE=/usr/local/bin/codex-linux-sandbox \
    INSTAFY_RUNTIME_FLAVOR=base

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/runtime-entrypoint"]

########################
# Runtime image (webdev)
########################
FROM ${WEBDEV_BASE} AS runtime-webdev

ARG RATHOLE_VERSION=0.5.0
ARG RATHOLE_SHA256_AMD64
ARG RATHOLE_SHA256_ARM64
ARG TARGETARCH
ARG PLAYWRIGHT_VERSION
ARG NPM_VERSION
ARG PNPM_VERSION
ARG BRACE_EXPANSION_VERSION
ARG BRACE_EXPANSION_SHA256
ARG IP_ADDRESS_VERSION
ARG IP_ADDRESS_SHA256
# uBlock Origin Lite (Manifest V3) provides ad blocking on modern Chromium builds.
# uBlock Origin itself is Manifest V2 which may be blocked/disabled in newer releases.
ARG UBOLITE_VERSION=2026.301.2014
ARG UBOLITE_SHA256_AMD64
ARG UBOLITE_SHA256_ARM64

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      less \
      procps \
      ripgrep \
      fluxbox \
      ffmpeg \
      tigervnc-standalone-server \
      tigervnc-common \
      unzip \
      x11-utils \
      openssh-client \
      python-is-python3 \
      python3 \
      python3-pip && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g "npm@${NPM_VERSION}" && \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "playwright@${PLAYWRIGHT_VERSION}" "@playwright/test@${PLAYWRIGHT_VERSION}" && \
    npm install -g "pnpm@${PNPM_VERSION}" && \
    if [ ! -e /usr/local/bin/npx ] && [ -x /usr/bin/npx ]; then ln -s /usr/bin/npx /usr/local/bin/npx; fi && \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-${BRACE_EXPANSION_VERSION}.tgz" \
      --output /tmp/brace-expansion.tgz && \
    printf '%s  %s\n' "${BRACE_EXPANSION_SHA256}" /tmp/brace-expansion.tgz | sha256sum --check --status && \
    for be_dir in $(find /usr -type d -path '*/node_modules/npm/node_modules/brace-expansion' 2>/dev/null); do \
      rm -rf "$be_dir" && mkdir -p "$be_dir" && \
      tar -xzf /tmp/brace-expansion.tgz -C "$be_dir" --strip-components=1; \
    done && \
    rm /tmp/brace-expansion.tgz && \
    unpatched="$(find /usr -type f -path '*/node_modules/npm/node_modules/brace-expansion/package.json' -exec grep -L "\"version\": \"${BRACE_EXPANSION_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched brace-expansion copies: $unpatched" >&2; exit 1; fi && \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/ip-address/-/ip-address-${IP_ADDRESS_VERSION}.tgz" \
      --output /tmp/ip-address.tgz && \
    printf '%s  %s\n' "${IP_ADDRESS_SHA256}" /tmp/ip-address.tgz | sha256sum --check --status && \
    for ia_dir in $(find /usr -type d -path '*/node_modules/npm/node_modules/ip-address' 2>/dev/null); do \
      rm -rf "$ia_dir" && mkdir -p "$ia_dir" && \
      tar -xzf /tmp/ip-address.tgz -C "$ia_dir" --strip-components=1; \
    done && \
    rm /tmp/ip-address.tgz && \
    unpatched="$(find /usr -type f -path '*/node_modules/npm/node_modules/ip-address/package.json' -exec grep -L "\"version\": \"${IP_ADDRESS_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched ip-address copies: $unpatched" >&2; exit 1; fi && \
    rm -rf /root/.npm

# Keep the headed browser usable for humans by shipping an ad blocker extension.
# This is architecture-independent and avoids having to bundle Brave (which is not
# consistently available on all target arches).
RUN set -eu; \
    arch="${TARGETARCH:-}"; \
    if [ -z "$arch" ]; then \
      uname_arch="$(uname -m || true)"; \
      case "$uname_arch" in \
        x86_64) arch="amd64" ;; \
        aarch64|arm64) arch="arm64" ;; \
        *) arch="$uname_arch" ;; \
      esac; \
    fi; \
    case "$arch" in \
      amd64) checksum="${UBOLITE_SHA256_AMD64}" ;; \
      arm64) checksum="${UBOLITE_SHA256_ARM64}" ;; \
      *) echo "Unsupported arch=$arch (expected amd64|arm64)"; exit 1 ;; \
    esac; \
    mkdir -p /opt/instafy/extensions/ublock; \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      -o /tmp/ublock.zip \
      "https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOLITE_VERSION}/uBOLite_${UBOLITE_VERSION}.chromium.zip"; \
    printf '%s  %s\n' "${checksum}" /tmp/ublock.zip | sha256sum --check --status; \
    unzip -q /tmp/ublock.zip -d /opt/instafy/extensions/ublock; \
    rm -f /tmp/ublock.zip

ARG BUILD_PROFILE=dev
ARG BUILD_ARTIFACT_DIR=debug
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/runtime-agent /usr/local/bin/runtime-agent
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox
COPY --from=browser-egress-proxy-builder /out/browser-egress-proxy /usr/local/bin/browser-egress-proxy
COPY --from=browser-webrtc-builder /out/browser-webrtc-sender /usr/local/bin/browser-webrtc-sender
RUN set -eu; \
    for binary in /usr/local/bin/browser-egress-proxy /usr/local/bin/browser-webrtc-sender; do \
      magic="$(od -An -tx1 -N4 "${binary}" | tr -d ' \n')"; \
      [ "${magic}" = "7f454c46" ] || { echo "Invalid ELF helper binary: ${binary}" >&2; exit 1; }; \
    done
COPY --from=cli-builder /out /opt/instafy-cli

RUN install -m 0755 /usr/local/bin/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox.real \
    && printf '%s\n' \
      '#!/bin/sh' \
      'if [ "$1" = "--codex-run-as-apply-patch" ]; then' \
      '  exec /usr/local/bin/runtime-agent "$@"' \
      'fi' \
      'exec /usr/local/bin/codex-linux-sandbox.real "$@"' \
      > /usr/local/bin/codex-linux-sandbox \
    && chmod +x /usr/local/bin/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox.real

RUN chmod +x /opt/instafy-cli/bin/instafy.js \
    && ln -sf /opt/instafy-cli/bin/instafy.js /usr/local/bin/instafy
RUN ln -sf /usr/local/bin/runtime-agent /usr/local/bin/codex

RUN set -eu; \
    arch="${TARGETARCH:-}"; \
    if [ -z "$arch" ]; then \
      uname_arch="$(uname -m || true)"; \
      case "$uname_arch" in \
        x86_64) arch="amd64" ;; \
        aarch64|arm64) arch="arm64" ;; \
        *) arch="$uname_arch" ;; \
      esac; \
    fi; \
    case "$arch" in \
      amd64) asset="rathole-x86_64-unknown-linux-gnu.zip"; checksum="${RATHOLE_SHA256_AMD64}" ;; \
      arm64) asset="rathole-aarch64-unknown-linux-musl.zip"; checksum="${RATHOLE_SHA256_ARM64}" ;; \
      *) echo "Unsupported arch=$arch (expected amd64|arm64)"; exit 1 ;; \
    esac; \
    url="https://github.com/rathole-org/rathole/releases/download/v${RATHOLE_VERSION}/${asset}"; \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error -o /tmp/rathole.zip "$url"; \
    printf '%s  %s\n' "${checksum}" /tmp/rathole.zip | sha256sum --check --status; \
    unzip -q /tmp/rathole.zip -d /tmp/rathole; \
    install -m 0755 /tmp/rathole/rathole /usr/local/bin/rathole; \
    rm -rf /tmp/rathole /tmp/rathole.zip; \
    rathole --version

COPY docker/runtime/entrypoint.sh /usr/local/bin/runtime-entrypoint

RUN chmod +x /usr/local/bin/runtime-entrypoint

ENV WORKSPACE_DIR=/workspace \
    CODEX_HOME=/workspace/.codex \
    PATH=/usr/local/bin:$PATH \
    CODEX_LINUX_SANDBOX_EXE=/usr/local/bin/codex-linux-sandbox \
    INSTAFY_RUNTIME_FLAVOR=webdev

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/runtime-entrypoint"]
