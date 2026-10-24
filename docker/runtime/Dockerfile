## Pin the Rust image to keep CI build caches warm (avoid nightly churn).
ARG RUST_TOOLCHAIN=1.95.0
ARG RUST_IMAGE=rust:${RUST_TOOLCHAIN}-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082
ARG GO_VERSION=1.26.10
ARG GO_IMAGE=golang:${GO_VERSION}-bookworm@sha256:fe3da92a5cb2881e4aa75e625cb0b7c50571632fb4cf340cbe53e6ccdcffdd51
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG CLI_NODE_IMAGE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG PLAYWRIGHT_VERSION=1.61.1
ARG NPM_VERSION=12.0.1
ARG PNPM_VERSION=11.24.0
# npm (through 12.0.2) vendors vulnerable brace-expansion, ip-address, and tar
# versions. Replace every vendored copy with exact fixed tarballs whose
# checksums are committed here until npm ships the fixes itself.
ARG NPM_TAR_VERSION=7.5.22
ARG NPM_TAR_SHA256=b792c2d1c7fc770910522ca1ffc29eee02ee38de4fa3a01e7832eb705879c6c6
ARG BRACE_EXPANSION_VERSION=5.0.12
ARG BRACE_EXPANSION_SHA256=ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4
ARG IP_ADDRESS_VERSION=10.3.1
ARG IP_ADDRESS_SHA256=ad1790063beea11a312c801df30d58e147de762f4f77787552376eb7424623e5
# npm and pnpm each vendor an older undici; 6.29.1 fixes CVE-2026-19534 and CVE-2026-109869.
ARG UNDICI_VERSION=6.29.1
ARG UNDICI_SHA256=29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f
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
ARG RUNTIME_BASE=debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132
ARG CHROMIUM_MIN_VERSION=152.0.7977.82-1~deb13u1
ARG GZIP_MIN_VERSION=1.13-1+deb13u1
ARG PCRE2_MIN_VERSION=10.46-1~deb13u2
ARG SQLITE3_MIN_VERSION=3.46.1-7+deb13u2
ARG WEBDEV_BASE=mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48
# The pinned Playwright base ships OpenSSL 3.0.13-0ubuntu3.11; 3.0.13-0ubuntu3.16 fixes CVE-2026-84782.
ARG WEBDEV_OPENSSL_MIN_VERSION=3.0.13-0ubuntu3.16

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
COPY packages/instafy-cli/scripts packages/instafy-cli/scripts
# `instafy bind`: the CLI build bundles the zero-dependency binder into dist/bind.
COPY packages/instafy-bind/package.json packages/instafy-bind/package.json
COPY packages/instafy-bind/LICENSE packages/instafy-bind/LICENSE
COPY packages/instafy-bind/bin packages/instafy-bind/bin
COPY packages/instafy-bind/src packages/instafy-bind/src
COPY packages/instafy-bind/client packages/instafy-bind/client
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
# openai-proxy-server is only a dev-dependency: cargo resolves its manifest but
# never compiles it for the image, so its sources stay out of the cook's key.
COPY packages/openai-proxy-server/Cargo.toml packages/openai-proxy-server/Cargo.toml
RUN mkdir -p packages/openai-proxy-server/src \
    && printf '' > packages/openai-proxy-server/src/lib.rs \
    && printf 'fn main() {}\n' > packages/openai-proxy-server/src/main.rs
COPY packages/git-service/ packages/git-service/
COPY packages/origin-http-server/ packages/origin-http-server/
COPY codex/codex-rs/ codex/codex-rs/
# Checksums Codex pins for its sandboxed rusty_v8 builds (see scripts/fetch-rusty-v8.sh).
COPY codex/third_party/v8/ codex/third_party/v8/
COPY proto/ proto/
WORKDIR /src/packages/runtime-agent
RUN cargo chef prepare --recipe-path /src/recipe.json

########################
# Dependencies builder
########################
# The recipe stubs only runtime-agent itself: cargo-chef keeps the out-of-tree
# path crates (runtime-contracts, git-service, origin-http-server, codex-rs) as
# real sources, so this layer is keyed on them too.
#
# Both Rust builders compile into one target/ cache mount with a stable id, so
# a local daemon keeps every compiled crate across builds, whatever happened to
# the layers: a runtime-agent edit recompiles runtime-agent only, a codex bump
# only the crates that changed, and a cook whose layer BuildKit's cleanup
# removed reruns in seconds. cargo-source-stamps makes that sharing safe across
# checkouts (cargo alone trusts mtimes, and COPY keeps the checkout's).
#
# Exported layer caches (the publisher's registry cache, mode=max) keep image
# layers but never cache mounts, so release builds, which only the publishers
# run, also copy the cooked target/ into this layer (/src/cooked-target); the
# builder seeds an empty mount from it. Dev builds skip that copy, which would
# only double the disk the cache needs. CARGO_DEPS_LAYER=1 or 0 overrides it.
FROM ${RUST_IMAGE} AS builder-deps
ARG BUILD_PROFILE=dev
ARG TARGETARCH
ARG CARGO_DEPS_LAYER=auto
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev libcap-dev protobuf-compiler \
      clang lld curl \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/usr/local/cargo \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"
WORKDIR /src/packages/runtime-agent
COPY --from=chef /usr/local/cargo/bin/cargo-chef /usr/local/cargo/bin/cargo-chef
# codex-code-mode-host links V8 with its sandbox enabled. denoland publishes no
# such prebuilt, so fetch the one Codex publishes, checked against the checksums
# pinned in the codex checkout, and point the v8 build script at it. Only its
# inputs are copied first (the v8 version comes from Cargo.lock), so a codex
# source change does not download it again.
COPY --from=chef /src/packages/runtime-agent/Cargo.lock /src/packages/runtime-agent/Cargo.lock
COPY --from=chef /src/codex/third_party/v8 /src/codex/third_party/v8
COPY scripts/fetch-rusty-v8.sh /src/scripts/fetch-rusty-v8.sh
RUN /src/scripts/fetch-rusty-v8.sh "$(rustc -vV | sed -n 's/^host: //p')" /opt/rusty_v8
ENV RUSTY_V8_ARCHIVE=/opt/rusty_v8/rusty_v8_archive \
    RUSTY_V8_SRC_BINDING_PATH=/opt/rusty_v8/src_binding.rs
# After the fetch, which uses neither, so editing them does not download again.
COPY docker/runtime/cargo-config.toml /usr/local/cargo/config.toml
COPY docker/runtime/cargo-source-stamps.sh /usr/local/bin/cargo-source-stamps
COPY --from=chef /src/packages/runtime-agent /src/packages/runtime-agent
COPY --from=chef /src/packages/runtime-contracts /src/packages/runtime-contracts
COPY --from=chef /src/packages/openai-proxy-server /src/packages/openai-proxy-server
COPY --from=chef /src/packages/git-service /src/packages/git-service
COPY --from=chef /src/packages/origin-http-server /src/packages/origin-http-server
COPY --from=chef /src/codex /src/codex
COPY --from=chef /src/proto /src/proto
COPY --from=chef /src/recipe.json /src/recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=instafy-runtime-agent-target-${BUILD_PROFILE}-${TARGETARCH},target=/src/packages/runtime-agent/target,sharing=locked \
    set -eu; \
    target=/src/packages/runtime-agent/target; \
    cargo-source-stamps prepare "$target" /src/packages/runtime-contracts /src/packages/openai-proxy-server \
      /src/packages/git-service /src/packages/origin-http-server /src/codex/codex-rs /src/proto; \
    cargo chef cook --features code-mode-host --profile ${BUILD_PROFILE} --recipe-path /src/recipe.json --locked; \
    cargo-source-stamps commit "$target"; \
    deps_layer="${CARGO_DEPS_LAYER}"; \
    if [ "$deps_layer" = auto ]; then deps_layer=0; [ "${BUILD_PROFILE}" != release ] || deps_layer=1; fi; \
    if [ "$deps_layer" = 1 ]; then \
      cat /proc/sys/kernel/random/uuid > "$target/.instafy-cook-id"; \
      cp -a "$target" /src/cooked-target; \
    fi

########################
# Application builder
########################
# Build on top of the cooked dependency layer (same toolchain, packages, cargo
# config and environment) in the same target/ mount as the cook. When the
# cook's layer came from an exported cache and this daemon's mount does not
# hold that cook (a fresh publisher runner), the mount is first replaced with
# the cooked copy. The per-commit compiled workspace stays out of every layer.
# Only the runtime-agent files that are compiled in are copied here: the path
# crates come from builder-deps exactly as they were cooked, and runtime-agent's
# tests and README stay out, so changing them does not rerun this build. The
# Shared Browser controller embeds the browser-action-policy scripts as source;
# only their plain *.js files are copied, since the package has no build step.
FROM builder-deps AS builder
ARG BUILD_PROFILE=dev
ARG BUILD_ARTIFACT_DIR=debug
ARG TARGETARCH
WORKDIR /src
COPY packages/runtime-agent/Cargo.toml packages/runtime-agent/Cargo.lock packages/runtime-agent/
COPY packages/runtime-agent/src/ packages/runtime-agent/src/
COPY packages/runtime-agent/assets/instafy/ packages/runtime-agent/assets/instafy/
COPY packages/runtime-agent/assets/*.js packages/runtime-agent/assets/
COPY packages/browser-action-policy/*.js packages/browser-action-policy/
# One cargo command for all three binaries: the sandbox's library is already in
# runtime-agent's graph, so building it here adds only its binary instead of
# re-resolving its dependencies with other features and recompiling 63 crates.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=instafy-runtime-agent-target-${BUILD_PROFILE}-${TARGETARCH},target=/src/packages/runtime-agent/target,sharing=locked \
    set -eu; \
    target=/src/packages/runtime-agent/target; \
    if [ -f /src/cooked-target/.instafy-cook-id ] && ! cmp -s /src/cooked-target/.instafy-cook-id "$target/.instafy-cook-id"; then \
      find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; \
      cp -a /src/cooked-target/. "$target/"; \
    fi; \
    cargo-source-stamps prepare "$target" /src/packages/runtime-agent /src/packages/browser-action-policy /src/packages/runtime-contracts \
      /src/packages/openai-proxy-server /src/packages/git-service /src/packages/origin-http-server /src/codex/codex-rs /src/proto; \
    cargo build --profile ${BUILD_PROFILE} --manifest-path packages/runtime-agent/Cargo.toml --features code-mode-host -p runtime-agent -p codex-code-mode-host -p codex-linux-sandbox --locked; \
    cargo-source-stamps commit "$target"; \
    mkdir -p /src/build-artifacts/${BUILD_ARTIFACT_DIR}; \
    for binary in runtime-agent codex-linux-sandbox codex-code-mode-host; do \
      cp "$target/${BUILD_ARTIFACT_DIR}/$binary" /src/build-artifacts/${BUILD_ARTIFACT_DIR}/$binary; \
    done

########################
# Binary-only export (dev fast loop): `--target binary-export --output type=local` yields just
# the compiled binaries so a running runtime container can be hot-swapped without rebuilding the
# heavy browser-based runtime image.
########################
FROM scratch AS binary-export
ARG BUILD_ARTIFACT_DIR=debug
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/runtime-agent /runtime-agent
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox /codex-linux-sandbox
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-code-mode-host /codex-code-mode-host

########################
# Shared Browser extensions
########################
# uBlock Origin Lite (Manifest V3) provides ad blocking on modern Chromium builds.
# uBlock Origin itself is Manifest V2 which may be blocked/disabled in newer releases.
# Both runtime images copy the unpacked extension from this stage, so the
# download and its checksum check exist once.
FROM ${RUNTIME_BASE} AS browser-extensions
ARG TARGETARCH
ARG UBOLITE_VERSION=2026.301.2014
ARG UBOLITE_SHA256_AMD64
ARG UBOLITE_SHA256_ARM64
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl unzip && \
    rm -rf /var/lib/apt/lists/*

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

########################
# Runtime image
########################
# The runtime publisher rebuilds this stage and runtime-webdev on every release
# instead of taking them from its layer cache, so the OS and npm packages they
# install are current when the image is scanned. Keep compilation in the builder
# stages, whose layers the cache keeps.
FROM ${RUNTIME_BASE} AS runtime

ARG CHROMIUM_MIN_VERSION
ARG GZIP_MIN_VERSION
ARG PCRE2_MIN_VERSION
ARG SQLITE3_MIN_VERSION
ARG RATHOLE_VERSION=0.5.0
ARG RATHOLE_SHA256_AMD64
ARG RATHOLE_SHA256_ARM64
ARG TARGETARCH
ARG PLAYWRIGHT_VERSION
ARG NPM_VERSION
ARG PNPM_VERSION
ARG NPM_TAR_VERSION
ARG NPM_TAR_SHA256
ARG BRACE_EXPANSION_VERSION
ARG BRACE_EXPANSION_SHA256
ARG IP_ADDRESS_VERSION
ARG IP_ADDRESS_SHA256
ARG UNDICI_VERSION
ARG UNDICI_SHA256

COPY --from=node-runtime /usr/local/ /usr/local/
RUN test -n "${CHROMIUM_MIN_VERSION}" && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      bsdutils \
      ca-certificates \
      chromium \
      curl \
      git \
      gzip \
      less \
      libpcre2-8-0 \
      libsqlite3-0 \
      login \
      mount \
      procps \
      ripgrep \
      fluxbox \
      ffmpeg \
      fonts-liberation \
      tigervnc-standalone-server \
      tigervnc-common \
      unzip \
      x11-utils \
      openssh-client \
      python-is-python3 \
      python3 \
      python3-pip \
      util-linux \
    && dpkg --compare-versions \
      "$(dpkg-query -W -f='${Version}' chromium)" ge "${CHROMIUM_MIN_VERSION}" \
    && test -n "${GZIP_MIN_VERSION}" && test -n "${PCRE2_MIN_VERSION}" && test -n "${SQLITE3_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' gzip)" ge "${GZIP_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge "${PCRE2_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libsqlite3-0)" ge "${SQLITE3_MIN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "npm@${NPM_VERSION}" && \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "playwright@${PLAYWRIGHT_VERSION}" "@playwright/test@${PLAYWRIGHT_VERSION}" && \
    npm install -g "pnpm@${PNPM_VERSION}" && \
    ln -sf /usr/local/bin/pnpm /usr/local/bin/pnpx && \
    if [ ! -e /usr/local/bin/npx ] && [ -x /usr/bin/npx ]; then ln -s /usr/bin/npx /usr/local/bin/npx; fi && \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/tar/-/tar-${NPM_TAR_VERSION}.tgz" \
      --output /tmp/npm-tar.tgz && \
    printf '%s  %s\n' "${NPM_TAR_SHA256}" /tmp/npm-tar.tgz | sha256sum --check --status && \
    for nt_dir in $(find /usr -type d -path '*/node_modules/npm/node_modules/tar' 2>/dev/null); do \
      rm -rf "$nt_dir" && mkdir -p "$nt_dir" && \
      tar -xzf /tmp/npm-tar.tgz -C "$nt_dir" --strip-components=1; \
    done && \
    rm /tmp/npm-tar.tgz && \
    unpatched="$(find /usr -type f -path '*/node_modules/npm/node_modules/tar/package.json' -exec grep -L "\"version\": \"${NPM_TAR_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched npm tar copies: $unpatched" >&2; exit 1; fi && \
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
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/undici/-/undici-${UNDICI_VERSION}.tgz" \
      --output /tmp/undici.tgz && \
    printf '%s  %s\n' "${UNDICI_SHA256}" /tmp/undici.tgz | sha256sum --check --status && \
    for un_dir in $(find /usr -type d \( -path '*/node_modules/npm/node_modules/undici' -o -path '*/node_modules/pnpm/dist/node_modules/undici' \) 2>/dev/null); do \
      rm -rf "$un_dir" && mkdir -p "$un_dir" && \
      tar -xzf /tmp/undici.tgz -C "$un_dir" --strip-components=1; \
    done && \
    rm /tmp/undici.tgz && \
    unpatched="$(find /usr -type f \( -path '*/node_modules/npm/node_modules/undici/package.json' -o -path '*/node_modules/pnpm/dist/node_modules/undici/package.json' \) -exec grep -L "\"version\": \"${UNDICI_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched undici copies: $unpatched" >&2; exit 1; fi && \
    rm -rf /root/.npm

# The on-demand browser host (runtime-entrypoint start-browser-host) and its
# agent tools use their own Node and Playwright, outside the /usr/local tree
# that workspace tooling (npm -g, version managers) rewrites. The build fails
# if the copy would resolve Playwright from anywhere else.
RUN set -eu; \
    host_root=/opt/instafy/browser-host; \
    global_root="$(npm root -g)"; \
    install -d -m 0755 "${host_root}/bin" "${host_root}/node_modules"; \
    install -m 0755 "$(command -v node)" "${host_root}/bin/node"; \
    cp -a "${global_root}/playwright" "${host_root}/node_modules/playwright"; \
    if [ -d "${global_root}/playwright-core" ]; then \
      cp -a "${global_root}/playwright-core" "${host_root}/node_modules/playwright-core"; \
    fi; \
    env -u NODE_PATH "${host_root}/bin/node" -e ' \
      const path = require("node:path"); \
      const root = "/opt/instafy/browser-host/node_modules"; \
      const playwright = require.resolve("playwright", { paths: [root] }); \
      const core = require.resolve("playwright-core", { paths: [path.dirname(playwright)] }); \
      for (const resolved of [playwright, core]) { \
        if (!resolved.startsWith(root + "/")) throw new Error("Playwright resolved outside the browser host: " + resolved); \
      } \
      require(playwright);'

COPY --from=browser-extensions /opt/instafy/extensions /opt/instafy/extensions

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

# codex-linux-sandbox is a wrapper that hands apply-patch to runtime-agent and
# runs the real sandbox (copied in below as codex-linux-sandbox.real) otherwise.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'if [ "$1" = "--codex-run-as-apply-patch" ]; then' \
      '  exec /usr/local/bin/runtime-agent "$@"' \
      'fi' \
      'exec /usr/local/bin/codex-linux-sandbox.real "$@"' \
      > /usr/local/bin/codex-linux-sandbox \
    && chmod +x /usr/local/bin/codex-linux-sandbox \
    && ln -sf /usr/local/bin/runtime-agent /usr/local/bin/codex
COPY --from=browser-egress-proxy-builder /out/browser-egress-proxy /usr/local/bin/browser-egress-proxy
COPY --from=browser-webrtc-builder /out/browser-webrtc-sender /usr/local/bin/browser-webrtc-sender
COPY --from=cli-builder /out /opt/instafy-cli
RUN chmod +x /opt/instafy-cli/bin/instafy.js \
    && ln -sf /opt/instafy-cli/bin/instafy.js /usr/local/bin/instafy

# The compiled binaries change with almost every commit, so they come last: a
# runtime-agent change re-exports only the binary layers and the small layers
# after them.
ARG BUILD_PROFILE=dev
ARG BUILD_ARTIFACT_DIR=debug
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox.real
# Code-mode-only models run their tools in this host; runtime-agent looks for it beside itself.
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-code-mode-host /usr/local/bin/codex-code-mode-host
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/runtime-agent /usr/local/bin/runtime-agent
RUN set -eu; \
    for binary in /usr/local/bin/browser-egress-proxy /usr/local/bin/browser-webrtc-sender /usr/local/bin/codex-code-mode-host; do \
      magic="$(od -An -tx1 -N4 "${binary}" | tr -d ' \n')"; \
      [ "${magic}" = "7f454c46" ] || { echo "Invalid ELF helper binary: ${binary}" >&2; exit 1; }; \
    done

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
ARG NPM_TAR_VERSION
ARG NPM_TAR_SHA256
ARG BRACE_EXPANSION_VERSION
ARG BRACE_EXPANSION_SHA256
ARG IP_ADDRESS_VERSION
ARG IP_ADDRESS_SHA256
ARG UNDICI_VERSION
ARG UNDICI_SHA256
ARG WEBDEV_OPENSSL_MIN_VERSION

RUN test -n "${WEBDEV_OPENSSL_MIN_VERSION}" && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      bsdutils \
      ca-certificates \
      curl \
      git \
      less \
      login \
      mount \
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
      python3-pip \
      util-linux \
      libssl3t64 \
      openssl \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libssl3t64)" ge "${WEBDEV_OPENSSL_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' openssl)" ge "${WEBDEV_OPENSSL_MIN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "npm@${NPM_VERSION}" && \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "playwright@${PLAYWRIGHT_VERSION}" "@playwright/test@${PLAYWRIGHT_VERSION}" && \
    npm install -g "pnpm@${PNPM_VERSION}" && \
    if [ ! -e /usr/local/bin/npx ] && [ -x /usr/bin/npx ]; then ln -s /usr/bin/npx /usr/local/bin/npx; fi && \
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/tar/-/tar-${NPM_TAR_VERSION}.tgz" \
      --output /tmp/npm-tar.tgz && \
    printf '%s  %s\n' "${NPM_TAR_SHA256}" /tmp/npm-tar.tgz | sha256sum --check --status && \
    for nt_dir in $(find /usr -type d -path '*/node_modules/npm/node_modules/tar' 2>/dev/null); do \
      rm -rf "$nt_dir" && mkdir -p "$nt_dir" && \
      tar -xzf /tmp/npm-tar.tgz -C "$nt_dir" --strip-components=1; \
    done && \
    rm /tmp/npm-tar.tgz && \
    unpatched="$(find /usr -type f -path '*/node_modules/npm/node_modules/tar/package.json' -exec grep -L "\"version\": \"${NPM_TAR_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched npm tar copies: $unpatched" >&2; exit 1; fi && \
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
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      "https://registry.npmjs.org/undici/-/undici-${UNDICI_VERSION}.tgz" \
      --output /tmp/undici.tgz && \
    printf '%s  %s\n' "${UNDICI_SHA256}" /tmp/undici.tgz | sha256sum --check --status && \
    for un_dir in $(find /usr -type d \( -path '*/node_modules/npm/node_modules/undici' -o -path '*/node_modules/pnpm/dist/node_modules/undici' \) 2>/dev/null); do \
      rm -rf "$un_dir" && mkdir -p "$un_dir" && \
      tar -xzf /tmp/undici.tgz -C "$un_dir" --strip-components=1; \
    done && \
    rm /tmp/undici.tgz && \
    unpatched="$(find /usr -type f \( -path '*/node_modules/npm/node_modules/undici/package.json' -o -path '*/node_modules/pnpm/dist/node_modules/undici/package.json' \) -exec grep -L "\"version\": \"${UNDICI_VERSION}\"" {} + 2>/dev/null || true)" && \
    if [ -n "$unpatched" ]; then echo "unpatched undici copies: $unpatched" >&2; exit 1; fi && \
    rm -rf /root/.npm

COPY --from=browser-extensions /opt/instafy/extensions /opt/instafy/extensions

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

# codex-linux-sandbox is a wrapper that hands apply-patch to runtime-agent and
# runs the real sandbox (copied in below as codex-linux-sandbox.real) otherwise.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'if [ "$1" = "--codex-run-as-apply-patch" ]; then' \
      '  exec /usr/local/bin/runtime-agent "$@"' \
      'fi' \
      'exec /usr/local/bin/codex-linux-sandbox.real "$@"' \
      > /usr/local/bin/codex-linux-sandbox \
    && chmod +x /usr/local/bin/codex-linux-sandbox \
    && ln -sf /usr/local/bin/runtime-agent /usr/local/bin/codex
COPY --from=browser-egress-proxy-builder /out/browser-egress-proxy /usr/local/bin/browser-egress-proxy
COPY --from=browser-webrtc-builder /out/browser-webrtc-sender /usr/local/bin/browser-webrtc-sender
COPY --from=cli-builder /out /opt/instafy-cli
RUN chmod +x /opt/instafy-cli/bin/instafy.js \
    && ln -sf /opt/instafy-cli/bin/instafy.js /usr/local/bin/instafy

# The compiled binaries change with almost every commit, so they come last: a
# runtime-agent change re-exports only the binary layers and the small layers
# after them.
ARG BUILD_PROFILE=dev
ARG BUILD_ARTIFACT_DIR=debug
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox.real
# Code-mode-only models run their tools in this host; runtime-agent looks for it beside itself.
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/codex-code-mode-host /usr/local/bin/codex-code-mode-host
COPY --from=builder /src/build-artifacts/${BUILD_ARTIFACT_DIR}/runtime-agent /usr/local/bin/runtime-agent
RUN set -eu; \
    for binary in /usr/local/bin/browser-egress-proxy /usr/local/bin/browser-webrtc-sender /usr/local/bin/codex-code-mode-host; do \
      magic="$(od -An -tx1 -N4 "${binary}" | tr -d ' \n')"; \
      [ "${magic}" = "7f454c46" ] || { echo "Invalid ELF helper binary: ${binary}" >&2; exit 1; }; \
    done

ENV WORKSPACE_DIR=/workspace \
    CODEX_HOME=/workspace/.codex \
    PATH=/usr/local/bin:$PATH \
    CODEX_LINUX_SANDBOX_EXE=/usr/local/bin/codex-linux-sandbox \
    INSTAFY_RUNTIME_FLAVOR=webdev

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/runtime-entrypoint"]
