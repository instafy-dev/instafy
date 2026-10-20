# Runtime image builds

`docker/runtime/Dockerfile` builds the runtime image (`--target runtime`) and the
browser-enabled dev image (`--target runtime-webdev`). The local scripts are
`pnpm build:image:agent` and `pnpm build:image:agent:webdev`. They build for the
machine's native platform unless `DOCKER_BUILD_PLATFORM` is set. The `:push`
scripts and CI build `linux/amd64` with `BUILD_PROFILE=release`.

The build is incremental. A one-file runtime-agent change recompiles only
runtime-agent and rebuilds the image in under a minute. This page explains how
that works, what makes a build slow again and how to force a clean build.

## Stages and layer order

| stage | what it does | rebuilt when |
|---|---|---|
| `node-runtime`, `browser-*-builder`, `cli-builder` | Node runtime, the Go helpers and the `instafy` CLI | their own package sources change |
| `chef` | `cargo chef prepare` writes `recipe.json` from the manifests. runtime-agent's own sources are stubbed; openai-proxy-server is stubbed too, because it is only a dev-dependency | `Cargo.toml`/`Cargo.lock`, runtime-contracts, git-service, origin-http-server, `codex/codex-rs`, `codex/third_party/v8`, `proto` |
| `builder-deps` | apt toolchain, rusty_v8 download, cargo config, then `cargo chef cook` (every dependency plus the path crates) | rusty_v8 download: `Cargo.lock`, `codex/third_party/v8`, `scripts/fetch-rusty-v8.sh`. Cook: anything the `chef` stage copies, `docker/runtime/cargo-config.toml`, `docker/runtime/cargo-source-stamps.sh` |
| `builder` | one `cargo build` for runtime-agent, codex-code-mode-host and codex-linux-sandbox | the cook, runtime-agent's `Cargo.toml`/`Cargo.lock`, `src/`, `assets/instafy/`, `assets/*.js` |
| `binary-export` | only the three binaries (`--target binary-export --output type=local,dest=...`) for hot-swapping into a running container | `builder` |
| `browser-extensions` | downloads and checks the uBlock Origin Lite release once for both runtime images | `UBOLITE_*` arguments |
| `runtime`, `runtime-webdev` | apt/Chromium and the browser host stack (X/VNC, window manager, `xdpyinfo`, ffmpeg), npm, the browser host's private Node and Playwright (base only), rathole, entrypoint, Go helpers, CLI, **then** the Rust binaries | each layer only by its own inputs; a binary change re-exports the binary layers and the few small layers after them |

runtime-agent's tests and README are not in `builder`'s inputs, so editing them
rebuilds nothing.

## The shared compiled cache

Both cargo steps (`cook` and `build`) compile into one BuildKit cache mount:

```
id=instafy-runtime-agent-target-${BUILD_PROFILE}-${TARGETARCH}, sharing=locked
```

The mount does not depend on any layer. It keeps every compiled crate when the
cook layer is rebuilt or removed by BuildKit's cleanup. A changed path crate or
codex bump recompiles only the crates that changed. dev, release, amd64 and
arm64 each get their own mount. Every checkout that builds this Dockerfile on
the same Docker daemon shares the mount, and `sharing=locked` makes builds from
different worktrees take turns.

Cargo decides whether a path crate is fresh by comparing file mtimes, and
BuildKit's `COPY` keeps the checkout's mtimes. That is unsafe for a shared
target: an older-timestamped but different file would reuse stale code.
`cargo-source-stamps` (run around each cargo step) makes the check
content-based:

- `prepare` sets every path-crate source file to a fixed 2000-01-01 mtime. It
  then gives a new mtime to each file whose sha256 differs from the last
  successful build or from any failed build since. The new mtime is the current
  time, or one second past the newest fingerprint in `target/` if the clock
  stepped back.
- `commit` runs only after cargo succeeds. It records the manifest and sets the
  rebuilt files back to the fixed mtime. After a failed build the files keep
  counting as changed.
- Source file names with a backslash or newline are refused rather than
  guessed at.

Registry and git crates, the profile, features, `RUSTFLAGS`, the toolchain and
`env!` inputs are already part of cargo's own fingerprint.

Dev builds keep only line tables (`docker/runtime/cargo-config.toml`, the same
setting Codex uses), and dependencies keep no incremental state. A dev target is
about 7.4 GB and runtime-agent is about 730 MB. Debuggers still get file and
line numbers but no variable or type info. Release builds are unchanged.

### Release builds and CI

Exported layer caches (the registry cache in CI) never contain cache mounts.
Release builds therefore also copy the cooked target into the `builder-deps`
layer at `/src/cooked-target`. `builder` fills an empty mount from that copy
when the mount does not hold that cook. `CARGO_DEPS_LAYER=1` or `0` forces the
copy on or off; the default is on for `release` only. This path has not yet
been timed in CI. Expect 20–40 s for the copy on a fresh runner, and the release
target is stored twice while the cook runs, so watch runner disk space.

## Expected rebuild times

Measured on an Apple Silicon Mac, Docker VM with 24 GB, `runtime-webdev`, dev
profile, arm64.

| change | full image build | what cargo compiles |
|---|---|---|
| nothing | ~2 s | nothing |
| runtime-agent test or README | ~2 s | nothing |
| one runtime-agent `.rs` file, binary changes and ships | 40–42 s (cargo 11–13 s, layer export ~15 s) | runtime-agent |
| one runtime-agent `.rs` comment (binary identical) | 32–38 s | runtime-agent |
| runtime-contracts or another path crate | ~48 s | that crate, its dependants, runtime-agent |
| cook re-runs with the compiled cache kept (Dockerfile or cargo config edit) | 47 s – 2.5 min | the stub crates, v8 and runtime-agent |
| cold: empty compiled cache | ~6 min | ~970 crates |
| old Dockerfile (before this layout) | 17 min on a 24 GB VM, 31–58 min on 8 GB | ~1,036 crates |

The fast numbers assume BuildKit still has the earlier layers. Docker Desktop's
build cache cleanup (`builder.gc.defaultKeepStorage` in `~/.docker/daemon.json`,
20 GB by default) removes the least recently used records once the cache is
over the cap. The compiled cache mount alone is about 7.4 GB, so a few builds
from other worktrees or projects can push out the runtime stages' apt, Chromium
and npm layers, and even the mount itself.

- Losing builder layers costs about 3 min. The cook re-runs, but the mount
  still holds every crate.
- Losing the runtime stages' layers costs as long as apt, npm and Playwright
  take to download again.
- Losing the mount costs one cold build of about 6 min.

To keep builds fast, raise the cap (for example to 60–100 GB, disk space
permitting) in Docker Desktop, under Settings, Docker Engine, then restart
Docker.

## Forcing a clean build

- **Re-run the Docker layers but keep the compiled crates:**
  `docker buildx build --no-cache ...`. `--no-cache` does not clear cache
  mounts, so cargo still finds nothing to recompile beyond what changed.
- **Recompile everything:** remove the compiled cache mount for that profile
  and architecture, then build. List it with
  `docker buildx du --verbose | grep -B4 'instafy-runtime-agent-target-dev-arm64'`,
  where the `ID:` line is the record. Remove it with
  `docker buildx prune --filter id=<ID>`. Do not use a plain
  `docker builder prune`: it also drops every other project's cache.
- **Release builds in CI** get a fresh BuildKit instance for each job, so their
  mount starts empty and is filled from the `builder-deps` layer. Dropping the
  registry cache for that run makes it cook from scratch.
