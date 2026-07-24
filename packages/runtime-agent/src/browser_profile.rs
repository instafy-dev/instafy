//! Flag-gated durable browser-profile persistence — runtime side of spec step 2.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! STATUS: verified end-to-end on 2026-07-09 against the real webdev image + the
//! local dev-stack controller (two separate runtime containers sharing one
//! project): a login set in one runtime survives both a graceful restart AND an
//! abrupt SIGKILL (via the periodic snapshot) into a fresh one. Still entirely
//! behind `INSTAFY_BROWSER_PROFILE_PERSIST` (default off), so the shipped default
//! boot path is byte-for-byte unchanged. See the notes at the bottom of this file.
//! ─────────────────────────────────────────────────────────────────────────────
//!
//! ## The boot-ordering problem this solves
//!
//! `docker/runtime/entrypoint.sh` launches the headed Chromium daemon (with
//! `--user-data-dir=$INSTAFY_PLAYWRIGHT_PROFILE_DIR`) and only *then* `exec`s
//! runtime-agent. Chromium reads its profile once, at launch. So to boot the
//! browser with a *restored* profile we must seed that directory before Chromium
//! starts — but the entrypoint (bash) has no agent token; only runtime-agent,
//! after `register_runtime`, holds the controller credentials.
//!
//! The fix keeps the whole default path intact and gates a small reorder behind
//! `INSTAFY_BROWSER_PROFILE_PERSIST=1`:
//!   1. entrypoint.sh still starts VNC/X/fluxbox, but *defers* the Chromium
//!      launch (it does not call `start_headed_chromium_daemon`).
//!   2. runtime-agent registers (gets the agent token), GETs the stored profile,
//!      unpacks it into the profile dir, then launches Chromium by invoking the
//!      exact same bash launcher via `runtime-entrypoint launch-chromium`.
//!   3. During the session it snapshots the profile periodically (without
//!      closing the browser) so an abrupt SIGKILL loses at most one interval of
//!      state rather than the whole session.
//!   4. On graceful shutdown, runtime-agent asks Chromium to close *cleanly over
//!      CDP* — a bare SIGTERM does NOT flush Chromium's batched cookie store, so
//!      it would silently drop a login set during the session — then packs the
//!      login surface and PUTs it back.
//!
//! Everything here is best-effort: any failure logs and falls back to a working
//! blank browser rather than blocking the runtime from serving jobs.

use std::collections::HashSet;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{info, warn};
use zip::write::{FileOptions, ZipWriter};
use zip::{CompressionMethod, ZipArchive};

use crate::controller::{ControllerClient, Registration};
use crate::model_environment::{BROWSER_HELPER_ENV_KEYS, apply_allowlisted_tokio_environment};

/// Master gate. Off by default; the whole module is inert unless this is `1`.
const PERSIST_FLAG_ENV: &str = "INSTAFY_BROWSER_PROFILE_PERSIST";
/// Persistence only makes sense when a browser session is actually enabled.
const BROWSER_SESSION_FLAG_ENV: &str = "INSTAFY_ENABLE_BROWSER_SESSION";
/// Chromium user-data-dir; mirrors the same env entrypoint.sh exports.
const PROFILE_DIR_ENV: &str = "INSTAFY_PLAYWRIGHT_PROFILE_DIR";
const DEFAULT_PROFILE_DIR: &str = "/tmp/instafy/playwright/profile";
/// The bash entrypoint we re-invoke as `<entrypoint> launch-chromium`.
const ENTRYPOINT_ENV: &str = "INSTAFY_RUNTIME_ENTRYPOINT";
const DEFAULT_ENTRYPOINT: &str = "/usr/local/bin/runtime-entrypoint";
/// Written by entrypoint.sh's `start_headed_chromium_daemon`.
const CHROMIUM_PID_FILE: &str = "/tmp/instafy/playwright/chromium.pid";
/// Chromium's CDP port (loopback); mirrors entrypoint.sh's default.
const CDP_PORT_ENV: &str = "INSTAFY_PLAYWRIGHT_CDP_PORT";
const DEFAULT_CDP_PORT: &str = "9223";
/// Seconds between mid-session snapshots (0 disables them; shutdown-only).
const SNAPSHOT_INTERVAL_ENV: &str = "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS";
const DEFAULT_SNAPSHOT_INTERVAL_SECS: u64 = 120;

/// Ceiling on the packed snapshot. Matches the controller request-body cap.
const MAX_PROFILE_BYTES: usize = 16 * 1024 * 1024;
/// A compressed archive may expand, but never beyond this aggregate profile size.
const MAX_PROFILE_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
/// One corrupt Chromium database must not consume the entire aggregate budget.
const MAX_PROFILE_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Bounds both filesystem traversal during pack and archive traversal during restore.
const MAX_PROFILE_ENTRIES: usize = 4_096;
const MAX_PROFILE_PATH_BYTES: usize = 4_096;
const MAX_PROFILE_PATH_DEPTH: usize = 64;

/// How long to wait for Chromium to finish flushing and exit after we ask it to
/// close before we pack the profile anyway.
const CHROMIUM_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CHROMIUM_CLOSE_POLL: Duration = Duration::from_millis(100);

/// Profile paths (relative to the Chromium user-data-dir) that carry the login
/// surface. Everything else — HTTP/GPU/code caches — is disposable and excluded
/// so the upload stays tiny. Both the modern (`Default/Network/Cookies`) and
/// legacy (`Default/Cookies`) cookie locations are listed; only the ones that
/// exist are packed.
///
/// `Local State` is mandatory: it holds os_crypt's wrapped key, and without it
/// the restored cookies cannot be decrypted on the next runtime.
const PROFILE_FILE_ALLOWLIST: &[&str] =
    &["Local State", "Default/Cookies", "Default/Network/Cookies"];

const PROFILE_DIRECTORY_ALLOWLIST: &[&str] = &[
    "Default/Local Storage",
    "Default/IndexedDB",
    "Default/Session Storage",
];

#[derive(Clone, Copy, Debug)]
struct ProfileArchiveLimits {
    archive_bytes: u64,
    total_uncompressed_bytes: u64,
    file_bytes: u64,
    entries: usize,
}

const PROFILE_ARCHIVE_LIMITS: ProfileArchiveLimits = ProfileArchiveLimits {
    archive_bytes: MAX_PROFILE_BYTES as u64,
    total_uncompressed_bytes: MAX_PROFILE_UNCOMPRESSED_BYTES,
    file_bytes: MAX_PROFILE_FILE_BYTES,
    entries: MAX_PROFILE_ENTRIES,
};

fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

/// The module is inert unless persistence is explicitly enabled *and* a browser
/// session is running (there is nothing to persist otherwise).
fn persistence_enabled() -> bool {
    env_flag(PERSIST_FLAG_ENV) && env_flag(BROWSER_SESSION_FLAG_ENV)
}

fn profile_dir() -> PathBuf {
    std::env::var(PROFILE_DIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_PROFILE_DIR))
}

fn entrypoint_path() -> String {
    std::env::var(ENTRYPOINT_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ENTRYPOINT.to_string())
}

fn cdp_port() -> String {
    std::env::var(CDP_PORT_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CDP_PORT.to_string())
}

/// Interval between mid-session snapshots. `INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS`
/// overrides the default; `0` disables periodic snapshots (shutdown-only).
fn snapshot_interval() -> Duration {
    let secs = std::env::var(SNAPSHOT_INTERVAL_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_SNAPSHOT_INTERVAL_SECS);
    Duration::from_secs(secs)
}

/// Restore the durable profile (if any) into the profile dir, then launch
/// Chromium against it. Meant to run once per runtime, right after the first
/// registration, before the lease loop serves jobs. No-op unless persistence is
/// enabled.
///
/// IMPORTANT: `register_and_process` (the caller) re-runs on every non-shutdown
/// re-registration — routinely on tunnel-lease refresh. Restoring again would
/// unpack the *stale* stored snapshot over the profile dir while Chromium is
/// still running, corrupting the live cookie DB/leveldb and reverting the user's
/// mid-session login. So we skip entirely once a browser is already provisioned
/// for this runtime (its pid file points at a live process). This also keeps the
/// `launch-chromium` re-invoke — which truncates the live action log — from
/// firing on a refresh. If a first launch failed there is no live process, so a
/// later re-registration is free to retry (self-healing).
pub async fn maybe_restore_and_launch(client: &ControllerClient, registration: &Registration) {
    if !persistence_enabled() {
        return;
    }

    if chromium_is_running().await {
        return;
    }

    match client.get_browser_profile(registration).await {
        Ok(Some(bytes)) => {
            let dir = profile_dir();
            match tokio::task::spawn_blocking(move || unpack_profile(&bytes, &dir)).await {
                Ok(Ok(count)) => info!(restored_entries = count, "restored browser profile"),
                Ok(Err(error)) => {
                    warn!(?error, "failed to unpack browser profile; starting blank")
                }
                Err(error) => warn!(?error, "profile unpack task panicked; starting blank"),
            }
        }
        Ok(None) => info!("no stored browser profile; starting blank"),
        Err(error) => warn!(?error, "failed to fetch browser profile; starting blank"),
    }

    if let Err(error) = launch_chromium().await {
        warn!(?error, "failed to launch Chromium after profile restore");
    }
}

/// Final snapshot on graceful shutdown. Closes Chromium first (which flushes its
/// stores) so this captures the complete, consistent login state, then uploads
/// unconditionally — it is the authoritative last write for the session.
pub async fn maybe_snapshot(client: &ControllerClient, registration: &Registration) {
    if !persistence_enabled() {
        return;
    }
    // Close Chromium so it flushes cookies/leveldb to disk before we pack.
    close_chromium().await;
    // prev_hash = None => always upload (final state wins).
    let _ = pack_and_upload(client, registration, None, "shutdown").await;
}

/// Periodically snapshot the profile *during* the session so an abrupt SIGKILL
/// (idle cull, crash, host loss) does not lose a login established mid-session —
/// the graceful `maybe_snapshot` only runs on a clean shutdown. Runs until
/// `shutdown` fires. No-op unless persistence is enabled and the interval is > 0.
///
/// Unlike the shutdown path, this must NOT close the browser (it is still in
/// use), so it packs whatever Chromium has already committed to disk. Chromium
/// batches cookie writes on a ~30s timer, so a periodic snapshot can lag reality
/// by up to about that; the trade is bounded loss (at most one interval) instead
/// of losing the whole session. Reads of the live profile can occasionally be
/// torn — that degrades to "this snapshot didn't take", never a broken runtime,
/// and the next tick (or the clean shutdown) corrects it.
///
/// Concurrency note: like the shutdown snapshot this is last-write-wins on the
/// project-scoped row, so multiple active runtimes on one project can clobber
/// each other's uploads more often now. Acceptable for the shared tier v1.
pub async fn run_periodic_snapshots(
    client: Arc<ControllerClient>,
    registration: Registration,
    shutdown: crate::agent::ShutdownSignal,
) {
    if !persistence_enabled() {
        return;
    }
    let interval = snapshot_interval();
    if interval.is_zero() {
        return; // explicitly disabled (INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS=0)
    }

    let mut prev_hash: Option<u64> = None;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(interval) => {}
        }
        // Only snapshot when a browser is actually up (skip during the restore/
        // launch gap or if it died); avoids uploading a blank/partial profile.
        if !chromium_is_running().await {
            continue;
        }
        if let Some(hash) =
            pack_and_upload(client.as_ref(), &registration, prev_hash, "periodic").await
        {
            prev_hash = Some(hash);
        }
    }
}

/// Pack the on-disk profile and upload it, unless it is empty, over the cap, or
/// byte-identical to `prev_hash` (so a periodic caller skips redundant uploads
/// while the browser is idle). Returns the content hash on a kept upload or an
/// unchanged profile, or None when there was nothing to persist / it failed.
async fn pack_and_upload(
    client: &ControllerClient,
    registration: &Registration,
    prev_hash: Option<u64>,
    context: &'static str,
) -> Option<u64> {
    let dir = profile_dir();
    let packed = match tokio::task::spawn_blocking(move || pack_profile(&dir)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            warn!(
                ?error,
                context, "failed to pack browser profile; skipping snapshot"
            );
            return None;
        }
        Err(error) => {
            warn!(
                ?error,
                context, "profile pack task panicked; skipping snapshot"
            );
            return None;
        }
    };

    if packed.is_empty() {
        if context == "shutdown" {
            info!("no browser profile contents to snapshot");
        }
        return None;
    }
    if packed.len() > MAX_PROFILE_BYTES {
        warn!(
            bytes = packed.len(),
            context, "browser profile snapshot exceeds cap; skipping (prune failed?)"
        );
        return None;
    }

    let hash = hash_bytes(&packed);
    if Some(hash) == prev_hash {
        return prev_hash; // unchanged since last upload — nothing to do
    }

    match client.put_browser_profile(registration, packed).await {
        Ok(()) => {
            info!(context, "uploaded browser profile snapshot");
            Some(hash)
        }
        Err(error) => {
            warn!(?error, context, "failed to upload browser profile snapshot");
            None
        }
    }
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// Launch the headed Chromium daemon by re-invoking the bash entrypoint's
/// `launch-chromium` subcommand. That reuses the exact flags/CDP-readiness
/// checks entrypoint.sh already ships and starts the browser against the
/// freshly-seeded profile dir. VNC/X/fluxbox are already running from boot; this
/// only starts the browser process.
async fn launch_chromium() -> Result<()> {
    let entrypoint = entrypoint_path();
    let mut command = tokio::process::Command::new(&entrypoint);
    command.arg("launch-chromium");
    apply_allowlisted_tokio_environment(&mut command, BROWSER_HELPER_ENV_KEYS);
    let status = command
        .status()
        .await
        .with_context(|| format!("failed to spawn {entrypoint} launch-chromium"))?;

    if !status.success() {
        anyhow::bail!("{entrypoint} launch-chromium exited with {status}");
    }
    Ok(())
}

/// Read the Chromium pid file and report whether that process is currently
/// alive (used to detect "a browser is already provisioned for this runtime").
async fn chromium_is_running() -> bool {
    let Ok(pid_text) = tokio::fs::read_to_string(CHROMIUM_PID_FILE).await else {
        return false;
    };
    let pid = pid_text.trim();
    if pid.is_empty() {
        return false;
    }
    process_alive(pid).await
}

/// Liveness check that treats a zombie as gone. Chromium is launched by the bash
/// launcher and reparented to runtime-agent (PID 1), which never reaps it — so
/// after SIGTERM it lingers as a zombie and a bare `kill -0` keeps succeeding.
/// On Linux we consult `/proc/<pid>/stat` (state field after the last `)`) and
/// treat state `Z` as exited; elsewhere we fall back to `kill -0`.
async fn process_alive(pid: &str) -> bool {
    if let Ok(stat) = tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await {
        return !stat_reports_zombie(&stat);
    }
    let mut command = tokio::process::Command::new("kill");
    command.arg("-0").arg(pid);
    apply_allowlisted_tokio_environment(&mut command, &[]);
    command
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Parse a `/proc/<pid>/stat` line and report whether the process is a zombie.
/// Format is "pid (comm) STATE ..."; `comm` can contain spaces and parens, so we
/// split on the LAST `)` and read the state token after it.
fn stat_reports_zombie(stat: &str) -> bool {
    stat.rsplit_once(')')
        .map(|(_, rest)| rest.trim_start().starts_with('Z'))
        .unwrap_or(false)
}

/// Ask Chromium to shut down *gracefully* over CDP so it flushes its stores to
/// disk before we snapshot. This matters: a bare SIGTERM does NOT flush
/// Chromium's cookie store (cookies are batched and committed on a ~30s timer or
/// on a clean browser shutdown), so a snapshot taken right after SIGTERM
/// silently drops any cookie established during the session — the login the
/// feature exists to preserve. `Browser.close` triggers the clean shutdown that
/// flushes cookies + leveldb.
///
/// The runtime drives its browser exclusively through node+playwright over CDP
/// (that IS the browsing mechanism), so we reuse the same path here rather than
/// pull a WebSocket client into this crate. Returns true if the close was
/// issued; the caller falls back to SIGTERM otherwise.
async fn cdp_graceful_close() -> bool {
    // Connect to the running Chromium over CDP and issue Browser.close.
    const JS: &str = "const {chromium}=require('playwright');\
chromium.connectOverCDP(process.argv[1])\
.then(async b=>{const s=await b.newBrowserCDPSession();try{await s.send('Browser.close')}catch(e){}process.exit(0)})\
.catch(()=>process.exit(1));";
    let endpoint = format!("http://127.0.0.1:{}", cdp_port());
    let mut command = tokio::process::Command::new("node");
    command.arg("-e").arg(JS).arg(&endpoint);
    apply_allowlisted_tokio_environment(&mut command, BROWSER_HELPER_ENV_KEYS);
    matches!(command.status().await, Ok(status) if status.success())
}

/// Best-effort close of the running Chromium so it flushes its stores before we
/// snapshot. Prefers a graceful CDP `Browser.close` (which flushes cookies);
/// falls back to SIGTERM (dependency-free `kill`, as entrypoint.sh uses) if the
/// CDP path is unavailable.
async fn close_chromium() {
    let closed_gracefully = cdp_graceful_close().await;

    let Ok(pid_text) = tokio::fs::read_to_string(CHROMIUM_PID_FILE).await else {
        return;
    };
    let pid = pid_text.trim().to_string();
    if pid.is_empty() {
        return;
    }

    if !closed_gracefully {
        let mut command = tokio::process::Command::new("kill");
        command.arg("-TERM").arg(&pid);
        apply_allowlisted_tokio_environment(&mut command, &[]);
        let _ = command.status().await;
    }

    let deadline_polls =
        (CHROMIUM_CLOSE_TIMEOUT.as_millis() / CHROMIUM_CLOSE_POLL.as_millis()).max(1) as usize;
    for _ in 0..deadline_polls {
        if !process_alive(&pid).await {
            return;
        }
        tokio::time::sleep(CHROMIUM_CLOSE_POLL).await;
    }
    warn!(
        pid,
        "Chromium did not exit before snapshot; profile may be torn"
    );
}

struct SizeLimitedCursor {
    inner: Cursor<Vec<u8>>,
    max_len: u64,
}

impl SizeLimitedCursor {
    fn new(max_len: u64) -> Self {
        Self {
            inner: Cursor::new(Vec::new()),
            max_len,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.inner.into_inner()
    }
}

impl Write for SizeLimitedCursor {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let end = self
            .inner
            .position()
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| std::io::Error::other("profile archive size overflow"))?;
        if end > self.max_len {
            return Err(std::io::Error::other(format!(
                "profile archive exceeds {} compressed bytes",
                self.max_len
            )));
        }
        self.inner.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl Seek for SizeLimitedCursor {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let next = self.inner.seek(position)?;
        if next > self.max_len {
            return Err(std::io::Error::other(format!(
                "profile archive seek exceeds {} compressed bytes",
                self.max_len
            )));
        }
        Ok(next)
    }
}

#[derive(Default)]
struct ProfilePackBudget {
    visited_entries: usize,
    uncompressed_bytes: u64,
}

impl ProfilePackBudget {
    fn visit_entry(&mut self, limits: ProfileArchiveLimits) -> Result<()> {
        self.visited_entries = self
            .visited_entries
            .checked_add(1)
            .context("profile entry count overflow")?;
        if self.visited_entries > limits.entries {
            anyhow::bail!(
                "browser profile contains more than {} filesystem entries",
                limits.entries
            );
        }
        Ok(())
    }

    fn reserve_file(&mut self, size: u64, limits: ProfileArchiveLimits) -> Result<()> {
        self.visit_entry(limits)?;
        if size > limits.file_bytes {
            anyhow::bail!(
                "browser profile file exceeds {} uncompressed bytes",
                limits.file_bytes
            );
        }
        self.uncompressed_bytes = self
            .uncompressed_bytes
            .checked_add(size)
            .context("browser profile uncompressed size overflow")?;
        if self.uncompressed_bytes > limits.total_uncompressed_bytes {
            anyhow::bail!(
                "browser profile exceeds {} total uncompressed bytes",
                limits.total_uncompressed_bytes
            );
        }
        Ok(())
    }
}

/// Pack the allowlisted login surface under `profile_dir` into a zip. Returns an
/// empty vec when none of the allowlisted paths exist (nothing to snapshot).
fn pack_profile(profile_dir: &Path) -> Result<Vec<u8>> {
    pack_profile_with_limits(profile_dir, PROFILE_ARCHIVE_LIMITS)
}

fn pack_profile_with_limits(profile_dir: &Path, limits: ProfileArchiveLimits) -> Result<Vec<u8>> {
    let mut output = SizeLimitedCursor::new(limits.archive_bytes);
    let mut budget = ProfilePackBudget::default();
    let mut wrote_any = false;
    {
        let mut zip = ZipWriter::new(&mut output);
        let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);

        for relative in PROFILE_FILE_ALLOWLIST {
            let absolute = profile_dir.join(relative);
            let Ok(metadata) = std::fs::symlink_metadata(&absolute) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                warn!(path = %absolute.display(), "skipping symlinked profile entry");
                continue;
            }
            if !metadata.is_file() {
                warn!(path = %absolute.display(), "skipping non-file profile entry");
                continue;
            }
            add_file(
                &mut zip,
                profile_dir,
                &absolute,
                options,
                &mut budget,
                limits,
            )?;
            wrote_any = true;
        }

        for relative in PROFILE_DIRECTORY_ALLOWLIST {
            let absolute = profile_dir.join(relative);
            let Ok(metadata) = std::fs::symlink_metadata(&absolute) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                warn!(path = %absolute.display(), "skipping symlinked profile entry");
                continue;
            }
            if !metadata.is_dir() {
                warn!(path = %absolute.display(), "skipping non-directory profile entry");
                continue;
            }
            budget.visit_entry(limits)?;
            wrote_any |= add_dir(
                &mut zip,
                profile_dir,
                &absolute,
                options,
                &mut budget,
                limits,
                1,
            )?;
        }
        zip.finish().context("failed to finalize profile archive")?;
    }

    if !wrote_any {
        return Ok(Vec::new());
    }
    Ok(output.into_inner())
}

fn add_dir<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    base: &Path,
    dir: &Path,
    options: FileOptions<()>,
    budget: &mut ProfilePackBudget,
    limits: ProfileArchiveLimits,
    depth: usize,
) -> Result<bool> {
    if depth > MAX_PROFILE_PATH_DEPTH {
        anyhow::bail!(
            "browser profile directory depth exceeds {MAX_PROFILE_PATH_DEPTH} components"
        );
    }
    let mut wrote = false;
    let entries = std::fs::read_dir(dir)
        .with_context(|| format!("failed to read profile dir {}", dir.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("failed to read entry in {}", dir.display()))?;
        // `file_type()` here comes from readdir/lstat and does NOT follow the
        // entry's own symlink, so a symlinked file or dir is skipped rather than
        // dereferenced (host-file exfiltration guard, same as the top level).
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat entry in {}", dir.display()))?;
        if file_type.is_symlink() {
            warn!(path = %entry.path().display(), "skipping symlinked profile entry");
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            budget.visit_entry(limits)?;
            wrote |= add_dir(zip, base, &path, options, budget, limits, depth + 1)?;
        } else if file_type.is_file() {
            add_file(zip, base, &path, options, budget, limits)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

fn add_file<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    base: &Path,
    file: &Path,
    options: FileOptions<()>,
    budget: &mut ProfilePackBudget,
    limits: ProfileArchiveLimits,
) -> Result<()> {
    let relative = file
        .strip_prefix(base)
        .with_context(|| format!("profile path {} escaped base", file.display()))?;
    let name = relative_to_zip_name(relative);
    if name.is_empty() {
        return Ok(());
    }
    if name.len() > MAX_PROFILE_PATH_BYTES || relative.components().count() > MAX_PROFILE_PATH_DEPTH
    {
        anyhow::bail!("browser profile path exceeds the supported bounds");
    }

    // Re-check immediately before opening. The opened descriptor is streamed, so
    // file contents never need to be buffered in memory.
    let link_metadata = std::fs::symlink_metadata(file)
        .with_context(|| format!("failed to stat {}", file.display()))?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        anyhow::bail!("browser profile file changed type while packing");
    }
    let source = File::open(file).with_context(|| format!("failed to open {}", file.display()))?;
    let metadata = source
        .metadata()
        .with_context(|| format!("failed to stat opened profile file {}", file.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("browser profile source is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if link_metadata.dev() != metadata.dev() || link_metadata.ino() != metadata.ino() {
            anyhow::bail!("browser profile file changed while it was opened");
        }
    }

    let size = metadata.len();
    budget.reserve_file(size, limits)?;
    zip.start_file(name.as_str(), options)
        .with_context(|| format!("failed to start archive entry {name}"))?;
    let copied = std::io::copy(&mut source.take(size.saturating_add(1)), zip)
        .with_context(|| format!("failed to stream archive entry {name}"))?;
    if copied != size {
        anyhow::bail!("browser profile file changed size while packing {name}");
    }
    Ok(())
}

/// Convert a relative filesystem path to a forward-slash zip entry name.
fn relative_to_zip_name(relative: &Path) -> String {
    relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Debug)]
struct ValidatedProfileEntry {
    archive_index: usize,
    relative: PathBuf,
    uncompressed_bytes: u64,
}

fn profile_file_path_is_allowlisted(relative: &Path) -> bool {
    PROFILE_FILE_ALLOWLIST
        .iter()
        .any(|allowed| relative == Path::new(allowed))
        || PROFILE_DIRECTORY_ALLOWLIST.iter().any(|allowed| {
            let allowed = Path::new(allowed);
            relative != allowed && relative.starts_with(allowed)
        })
}

fn profile_directory_path_is_allowlisted(relative: &Path) -> bool {
    PROFILE_FILE_ALLOWLIST.iter().any(|allowed| {
        let allowed = Path::new(allowed);
        relative != allowed && allowed.starts_with(relative)
    }) || PROFILE_DIRECTORY_ALLOWLIST.iter().any(|allowed| {
        let allowed = Path::new(allowed);
        relative == allowed || allowed.starts_with(relative) || relative.starts_with(allowed)
    })
}

fn validate_profile_archive(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    limits: ProfileArchiveLimits,
) -> Result<Vec<ValidatedProfileEntry>> {
    if archive.len() > limits.entries {
        anyhow::bail!(
            "browser profile archive contains more than {} entries",
            limits.entries
        );
    }

    let mut validated = Vec::with_capacity(archive.len());
    let mut seen = HashSet::with_capacity(archive.len());
    let mut total_uncompressed_bytes = 0u64;
    for archive_index in 0..archive.len() {
        let entry = archive
            .by_index(archive_index)
            .with_context(|| format!("failed to read archive entry {archive_index}"))?;
        let name = entry.name().to_string();
        let relative = safe_relative_path(&name)
            .with_context(|| format!("unsafe browser profile archive path {name:?}"))?;
        if !seen.insert(relative.clone()) {
            anyhow::bail!("duplicate browser profile archive path {name:?}");
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            anyhow::bail!("browser profile archive contains a symlink entry {name:?}");
        }
        if entry.is_dir() {
            if !profile_directory_path_is_allowlisted(&relative) {
                anyhow::bail!("browser profile archive directory is not allowlisted: {name:?}");
            }
            continue;
        }
        if !profile_file_path_is_allowlisted(&relative) {
            anyhow::bail!("browser profile archive file is not allowlisted: {name:?}");
        }

        let size = entry.size();
        if size > limits.file_bytes {
            anyhow::bail!(
                "browser profile archive file exceeds {} uncompressed bytes: {name:?}",
                limits.file_bytes
            );
        }
        total_uncompressed_bytes = total_uncompressed_bytes
            .checked_add(size)
            .context("browser profile archive size overflow")?;
        if total_uncompressed_bytes > limits.total_uncompressed_bytes {
            anyhow::bail!(
                "browser profile archive exceeds {} total uncompressed bytes",
                limits.total_uncompressed_bytes
            );
        }
        validated.push(ValidatedProfileEntry {
            archive_index,
            relative,
            uncompressed_bytes: size,
        });
    }
    Ok(validated)
}

fn ensure_restore_parent(profile_dir: &Path, relative_parent: &Path) -> Result<PathBuf> {
    if !profile_dir.exists() {
        std::fs::create_dir_all(profile_dir)
            .with_context(|| format!("failed to create profile dir {}", profile_dir.display()))?;
    }
    let profile_metadata = std::fs::symlink_metadata(profile_dir)
        .with_context(|| format!("failed to stat profile dir {}", profile_dir.display()))?;
    if profile_metadata.file_type().is_symlink() || !profile_metadata.is_dir() {
        anyhow::bail!("browser profile restore destination must be a real directory");
    }

    let mut current = profile_dir.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(component) = component else {
            anyhow::bail!("browser profile restore parent is not relative");
        };
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    anyhow::bail!(
                        "browser profile restore parent must be a real directory: {}",
                        current.display()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .with_context(|| format!("failed to create {}", current.display()))?;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to stat {}", current.display()));
            }
        }
    }
    Ok(current)
}

/// Unpack a profile archive into `profile_dir`, returning the number of files
/// written. The compressed input, declared sizes, actual streamed bytes, entry
/// count, path shape, and restored destinations are all bounded before Chromium
/// sees any restored state.
fn unpack_profile(bytes: &[u8], profile_dir: &Path) -> Result<usize> {
    unpack_profile_with_limits(bytes, profile_dir, PROFILE_ARCHIVE_LIMITS)
}

fn unpack_profile_with_limits(
    bytes: &[u8],
    profile_dir: &Path,
    limits: ProfileArchiveLimits,
) -> Result<usize> {
    if bytes.len() as u64 > limits.archive_bytes {
        anyhow::bail!(
            "browser profile archive exceeds {} compressed bytes",
            limits.archive_bytes
        );
    }
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).context("invalid browser profile archive")?;
    let validated = validate_profile_archive(&mut archive, limits)?;

    let mut written = 0usize;
    let mut actual_uncompressed_bytes = 0u64;
    for validated_entry in validated {
        let entry = archive
            .by_index(validated_entry.archive_index)
            .with_context(|| {
                format!(
                    "failed to reopen archive entry {}",
                    validated_entry.archive_index
                )
            })?;
        let destination = profile_dir.join(&validated_entry.relative);
        let relative_parent = validated_entry
            .relative
            .parent()
            .unwrap_or_else(|| Path::new(""));
        let parent = ensure_restore_parent(profile_dir, relative_parent)?;

        let remaining_total = limits
            .total_uncompressed_bytes
            .checked_sub(actual_uncompressed_bytes)
            .context("browser profile actual byte budget exhausted")?;
        let read_limit = remaining_total.min(limits.file_bytes).saturating_add(1);
        let mut temporary = tempfile::NamedTempFile::new_in(&parent)
            .with_context(|| format!("failed to stage {}", destination.display()))?;
        let copied = std::io::copy(&mut entry.take(read_limit), temporary.as_file_mut())
            .with_context(|| {
                format!(
                    "failed to stream archive entry {}",
                    validated_entry.relative.display()
                )
            })?;
        if copied != validated_entry.uncompressed_bytes
            || copied > limits.file_bytes
            || copied > remaining_total
        {
            anyhow::bail!(
                "browser profile archive entry expanded beyond its validated bounds: {}",
                validated_entry.relative.display()
            );
        }
        temporary
            .as_file_mut()
            .flush()
            .with_context(|| format!("failed to flush {}", destination.display()))?;
        temporary
            .persist(&destination)
            .map_err(|error| error.error)
            .with_context(|| format!("failed to install {}", destination.display()))?;
        actual_uncompressed_bytes = actual_uncompressed_bytes
            .checked_add(copied)
            .context("browser profile actual size overflow")?;
        written += 1;
    }
    Ok(written)
}

/// Return a safe relative path for a zip entry name, or `None` if the name is
/// absolute or escapes its root via `..`/prefix components.
fn safe_relative_path(name: &str) -> Option<PathBuf> {
    if name.len() > MAX_PROFILE_PATH_BYTES || name.contains(['\0', '\\']) {
        return None;
    }
    let candidate = Path::new(name);
    if candidate.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            // Reject `..`, `/`, and Windows prefixes outright.
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() || out.components().count() > MAX_PROFILE_PATH_DEPTH {
        None
    } else {
        Some(out)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE-RUNTIME VERIFICATION — walked end-to-end on 2026-07-09 against the real
// webdev image + local dev-stack controller (two separate runtime containers,
// same project). All of the below were observed:
//
//  1. Flag unset → boot byte-identical (Chromium from entrypoint.sh, no GET/PUT).
//  2. Flag on, nothing stored → GET 404 ("starting blank"), Chromium launched by
//     runtime-agent, CDP reachable.
//  3. Cookie set via CDP → graceful shutdown → "uploaded browser profile
//     snapshot", controller row appears (version advances).
//  4. Fresh runtime → GET 200 → "restored browser profile" → Chromium launched
//     with it; the cookie is present WITHOUT re-auth. Confirms cross-runtime
//     os_crypt decryption.
//  5. FLUSH FIX: the first pass proved SIGTERM does NOT flush Chromium's cookie
//     store (snapshot had 0 cookie rows); switching close_chromium to a graceful
//     CDP Browser.close made the cookie land on disk. That is the code above.
//  6. PERIODIC (SIGKILL): with INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS=10, set a
//     cookie, waited for Chromium's ~30s commit timer, observed periodic uploads
//     (context="periodic") whose stored profile contained the cookie, then
//     `docker kill` (SIGKILL — NO graceful shutdown, no context="shutdown" log).
//     A fresh runtime still restored the cookie. Confirms periodic snapshots
//     bound abrupt-kill loss to ~one interval. Caveat observed: a cookie set
//     <~30s before a hard kill can still be lost, because Chromium has not yet
//     committed it to disk when the periodic pack runs.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(
        archive_bytes: u64,
        total_uncompressed_bytes: u64,
        file_bytes: u64,
        entries: usize,
    ) -> ProfileArchiveLimits {
        ProfileArchiveLimits {
            archive_bytes,
            total_uncompressed_bytes,
            file_bytes,
            entries,
        }
    }

    fn profile_zip(entries: &[(&str, usize, u8)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(cursor);
        let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);
        for (name, size, byte) in entries {
            zip.start_file(*name, options)
                .expect("start test ZIP entry");
            let chunk = vec![*byte; 256];
            let mut remaining = *size;
            while remaining > 0 {
                let write = remaining.min(chunk.len());
                zip.write_all(&chunk[..write])
                    .expect("write test ZIP entry");
                remaining -= write;
            }
        }
        zip.finish().expect("finish test ZIP").into_inner()
    }

    #[test]
    fn safe_relative_path_rejects_traversal_and_absolute() {
        assert!(safe_relative_path("Default/Cookies").is_some());
        assert!(safe_relative_path("Local State").is_some());
        assert!(safe_relative_path("../../etc/passwd").is_none());
        assert!(safe_relative_path("Default/../../escape").is_none());
        assert!(safe_relative_path("/absolute/path").is_none());
        assert!(safe_relative_path("").is_none());
    }

    #[test]
    fn relative_to_zip_name_uses_forward_slashes() {
        let name = relative_to_zip_name(Path::new("Default").join("Local Storage").as_path());
        assert_eq!(name, "Default/Local Storage");
    }

    #[test]
    fn unpack_rejects_highly_compressible_total_size_bomb() {
        let packed = profile_zip(&[
            ("Default/Local Storage/a.log", 400, b'a'),
            ("Default/Local Storage/b.log", 400, b'b'),
            ("Default/Local Storage/c.log", 400, b'c'),
        ]);
        assert!(
            packed.len() < 1_024,
            "fixture must be smaller compressed than its expanded payload"
        );

        let restore = tempfile::tempdir().expect("restore tempdir");
        let error =
            unpack_profile_with_limits(&packed, restore.path(), limits(4_096, 1_024, 512, 8))
                .expect_err("expanded total must be rejected");
        assert!(error.to_string().contains("total uncompressed bytes"));
        assert!(!restore.path().join("Default").exists());
    }

    #[test]
    fn unpack_rejects_excessive_archive_entry_count() {
        let source = tempfile::tempdir().expect("source tempdir");
        std::fs::create_dir_all(source.path().join("Default/Local Storage")).unwrap();
        for name in ["1", "2", "3", "4"] {
            std::fs::write(source.path().join("Default/Local Storage").join(name), b"x").unwrap();
        }
        let pack_error = pack_profile_with_limits(source.path(), limits(4_096, 4_096, 1_024, 3))
            .expect_err("source entry-count bomb must be rejected");
        assert!(pack_error.to_string().contains("filesystem entries"));

        let packed = profile_zip(&[
            ("Default/Local Storage/1", 1, b'1'),
            ("Default/Local Storage/2", 1, b'2'),
            ("Default/Local Storage/3", 1, b'3'),
            ("Default/Local Storage/4", 1, b'4'),
        ]);
        let restore = tempfile::tempdir().expect("restore tempdir");
        let error =
            unpack_profile_with_limits(&packed, restore.path(), limits(4_096, 4_096, 1_024, 3))
                .expect_err("entry-count bomb must be rejected");
        assert!(error.to_string().contains("more than 3 entries"));
        assert!(!restore.path().join("Default").exists());
    }

    #[test]
    fn pack_and_unpack_reject_oversized_individual_files() {
        let source = tempfile::tempdir().expect("source tempdir");
        std::fs::write(source.path().join("Local State"), vec![b'x'; 513]).unwrap();
        let test_limits = limits(4_096, 1_024, 512, 8);
        let pack_error = pack_profile_with_limits(source.path(), test_limits)
            .expect_err("oversized source file must be rejected");
        assert!(pack_error.to_string().contains("file exceeds 512"));

        let packed = profile_zip(&[("Local State", 513, b'x')]);
        let restore = tempfile::tempdir().expect("restore tempdir");
        let unpack_error = unpack_profile_with_limits(&packed, restore.path(), test_limits)
            .expect_err("oversized archive file must be rejected");
        assert!(unpack_error.to_string().contains("file exceeds 512"));
        assert!(!restore.path().join("Local State").exists());
    }

    #[test]
    fn restore_rejects_files_outside_the_exact_login_surface_allowlist() {
        let packed = profile_zip(&[("Default/Cache/poison", 8, b'x')]);
        let restore = tempfile::tempdir().expect("restore tempdir");
        let error =
            unpack_profile_with_limits(&packed, restore.path(), limits(4_096, 4_096, 1_024, 8))
                .expect_err("non-allowlisted path must be rejected");
        assert!(error.to_string().contains("file is not allowlisted"));
        assert!(!restore.path().join("Default").exists());
    }

    #[test]
    fn pack_stream_enforces_the_compressed_archive_budget() {
        let source = tempfile::tempdir().expect("source tempdir");
        let bytes = (0..4_096)
            .map(|index| ((index * 73 + index / 7) % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(source.path().join("Local State"), bytes).unwrap();
        let error = pack_profile_with_limits(source.path(), limits(128, 8_192, 8_192, 8))
            .expect_err("compressed output budget must be enforced");
        let rendered = format!("{error:#}");
        assert!(rendered.contains("profile archive"), "{rendered}");
        assert!(rendered.contains("compressed bytes"), "{rendered}");
    }

    #[test]
    fn pack_then_unpack_round_trips_the_login_surface() {
        let source = tempfile::tempdir().expect("source tempdir");
        let source_dir = source.path();

        // Allowlisted file at the root and a nested dir with a file.
        std::fs::write(source_dir.join("Local State"), b"os-crypt-key").unwrap();
        std::fs::create_dir_all(source_dir.join("Default/Local Storage/leveldb")).unwrap();
        std::fs::write(
            source_dir.join("Default/Local Storage/leveldb/000003.log"),
            b"session-token",
        )
        .unwrap();
        // A non-allowlisted cache file must NOT be packed.
        std::fs::create_dir_all(source_dir.join("Default/Cache")).unwrap();
        std::fs::write(source_dir.join("Default/Cache/junk"), b"disposable").unwrap();

        let packed = pack_profile(source_dir).expect("pack");
        assert!(!packed.is_empty(), "expected a non-empty archive");

        let restore = tempfile::tempdir().expect("restore tempdir");
        let restore_dir = restore.path();
        let count = unpack_profile(&packed, restore_dir).expect("unpack");
        assert_eq!(count, 2, "packed exactly the two allowlisted files");

        assert_eq!(
            std::fs::read(restore_dir.join("Local State")).unwrap(),
            b"os-crypt-key"
        );
        assert_eq!(
            std::fs::read(restore_dir.join("Default/Local Storage/leveldb/000003.log")).unwrap(),
            b"session-token"
        );
        // The cache file was outside the allowlist and must be absent.
        assert!(!restore_dir.join("Default/Cache/junk").exists());
    }

    #[test]
    fn pack_profile_is_empty_when_nothing_to_persist() {
        let empty = tempfile::tempdir().expect("tempdir");
        let packed = pack_profile(empty.path()).expect("pack");
        assert!(packed.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn pack_profile_skips_symlinks_and_never_exfiltrates_targets() {
        use std::os::unix::fs::symlink;

        // A "host" secret living OUTSIDE the profile subtree.
        let outside = tempfile::tempdir().expect("outside tempdir");
        let secret = outside.path().join("host-secret");
        std::fs::write(&secret, b"TOP-SECRET-HOST-BYTES").unwrap();

        let profile = tempfile::tempdir().expect("profile tempdir");
        let dir = profile.path();
        std::fs::create_dir_all(dir.join("Default/Local Storage")).unwrap();

        // A legitimate allowlisted file (must be packed).
        std::fs::write(dir.join("Local State"), b"real-key").unwrap();
        // A legit file inside an allowlisted dir (must be packed).
        std::fs::write(dir.join("Default/Local Storage/real.log"), b"real-ls").unwrap();
        // Symlink at a top-level allowlisted entry pointing at the host secret.
        symlink(&secret, dir.join("Default/Cookies")).unwrap();
        // Symlink INSIDE an allowlisted dir pointing at the host secret.
        symlink(&secret, dir.join("Default/Local Storage/evil")).unwrap();

        let packed = pack_profile(dir).expect("pack");
        let restore = tempfile::tempdir().expect("restore tempdir");
        unpack_profile(&packed, restore.path()).expect("unpack");

        // Real files survive.
        assert_eq!(
            std::fs::read(restore.path().join("Local State")).unwrap(),
            b"real-key"
        );
        assert_eq!(
            std::fs::read(restore.path().join("Default/Local Storage/real.log")).unwrap(),
            b"real-ls"
        );
        // Symlinked entries were skipped — neither the link nor its target bytes
        // made it into the archive.
        assert!(!restore.path().join("Default/Cookies").exists());
        assert!(!restore.path().join("Default/Local Storage/evil").exists());
        // Belt-and-suspenders: the secret bytes appear in no unpacked file.
        for name in ["Local State", "Default/Local Storage/real.log"] {
            let contents = std::fs::read(restore.path().join(name)).unwrap();
            assert!(!contents.windows(6).any(|w| w == b"SECRET"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unpack_profile_refuses_symlinked_restore_parents() {
        use std::os::unix::fs::symlink;

        let packed = profile_zip(&[("Default/Local Storage/session", 8, b'x')]);
        let restore = tempfile::tempdir().expect("restore tempdir");
        let outside = tempfile::tempdir().expect("outside tempdir");
        std::fs::create_dir(restore.path().join("Default")).unwrap();
        symlink(outside.path(), restore.path().join("Default/Local Storage")).unwrap();

        let error = unpack_profile(&packed, restore.path())
            .expect_err("restore must not traverse a symlinked parent");
        assert!(error.to_string().contains("real directory"));
        assert!(!outside.path().join("session").exists());
    }

    #[test]
    fn hash_bytes_detects_change_for_skip_logic() {
        let a = hash_bytes(b"profile-bytes-v1");
        assert_eq!(
            a,
            hash_bytes(b"profile-bytes-v1"),
            "stable for identical input"
        );
        assert_ne!(
            a,
            hash_bytes(b"profile-bytes-v2"),
            "changes when bytes change"
        );
        assert_ne!(hash_bytes(b""), hash_bytes(b"x"));
    }

    #[test]
    fn stat_reports_zombie_reads_state_after_last_paren() {
        assert!(stat_reports_zombie("1234 (chrome) Z 1 1234 0 0"));
        assert!(!stat_reports_zombie("1234 (chrome) S 1 1234 0 0"));
        // comm containing a paren must not confuse the split.
        assert!(stat_reports_zombie("1234 (weird )name) Z 1 1234"));
        assert!(!stat_reports_zombie("garbage-without-paren"));
    }
}
