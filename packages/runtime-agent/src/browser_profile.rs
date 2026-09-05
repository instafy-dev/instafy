//! Flag-gated durable browser-profile persistence — runtime side of spec step 2.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! HISTORICAL PROOF (before versioned writes): verified on 2026-07-09 against the
//! real webdev image + the
//! local dev-stack controller (two separate runtime containers sharing one
//! project): a login set in one runtime survives both a graceful restart AND an
//! abrupt SIGKILL (via the periodic snapshot) into a fresh one. Still entirely
//! behind `INSTAFY_BROWSER_PROFILE_PERSIST` (default off), so the shipped default
//! boot path is unchanged. That historical proof does not validate the newer
//! version-checked writer lifecycle. See the notes at the bottom of this file.
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
//!      closing the browser) as a best-effort recovery point for abrupt SIGKILL.
//!      Live copies may lag or be inconsistent; no recovery interval is promised.
//!   4. On graceful shutdown, runtime-agent asks Chromium to close *cleanly over
//!      CDP* — a bare SIGTERM does NOT flush Chromium's batched cookie store, so
//!      it would silently drop a login set during the session — then packs the
//!      login surface and PUTs it back only after confirming Chromium stopped.
//!
//! Persistence failures do not block browsing. A runtime saves only against the
//! exact version it restored. Failed restore, conflicting/ambiguous uploads, or
//! cancellation during an upload disable further saves for this process; they
//! never rebase local cookies onto a newer remote version automatically.

use std::collections::HashSet;
use std::fs::File;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{info, warn};
use zip::write::{FileOptions, ZipWriter};
use zip::{CompressionMethod, ZipArchive};

use crate::controller::{BrowserProfileSnapshot, ControllerClient, Registration};
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

/// Total budget to request Chromium's close and confirm it stopped. Exhausting
/// this budget skips the final snapshot, never packs a potentially live profile.
const CHROMIUM_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CHROMIUM_CDP_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
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

/// ControllerClient owns one instance for the runtime process, including across
/// registration/token renewals. Its mutex serializes restore, periodic saves,
/// and the final save. No version is persisted independently from its archive.
#[derive(Default)]
pub(crate) struct BrowserProfileSession {
    restore_attempted: bool,
    shutdown: bool,
    writer: Option<BrowserProfileWriter>,
}

struct BrowserProfileWriter {
    version: i64,
    last_hash: Option<u64>,
}

impl BrowserProfileSession {
    async fn restore(
        &mut self,
        load: impl Future<Output = Result<BrowserProfileSnapshot>>,
        dir: PathBuf,
    ) -> Result<()> {
        anyhow::ensure!(!self.restore_attempted, "profile restore already attempted");
        // Set before any await: cancellation must not leave a writable or
        // retryable baseline for a partly restored local browser.
        self.restore_attempted = true;
        let snapshot = load.await?;
        let version = snapshot.version;
        let last_hash =
            tokio::task::spawn_blocking(move || restore_profile_baseline(snapshot, &dir))
                .await
                .context("profile restore task failed")??;
        self.writer = Some(BrowserProfileWriter {
            version,
            last_hash: Some(last_hash),
        });
        Ok(())
    }
}

/// Install an exact baseline, not an overlay that can retain cookie databases
/// absent from the stored snapshot. Validate/unpack entirely before replacing
/// the old directory. On restore failure the old local profile is retained,
/// but the caller never enables uploads from it.
fn restore_profile_baseline(snapshot: BrowserProfileSnapshot, dir: &Path) -> Result<u64> {
    anyhow::ensure!(
        (snapshot.version == 0 && snapshot.archive.is_none())
            || ((1..i64::MAX).contains(&snapshot.version) && snapshot.archive.is_some()),
        "browser profile version does not match its archive"
    );
    let parent = dir
        .parent()
        .context("browser profile directory has no parent")?;
    std::fs::create_dir_all(parent)?;
    let staging = tempfile::tempdir_in(parent)?;
    if let Some(archive) = snapshot.archive {
        unpack_profile(&archive, staging.path())?;
    }
    // Normalize ZIP entry order/options before Chromium launches. An unchanged
    // first snapshot must not bump the shared version and conflict another
    // runtime that restored this same baseline.
    let last_hash = hash_bytes(&pack_profile(staging.path())?);
    let previous = tempfile::tempdir_in(parent)?;
    let backup = previous.path().join("profile");
    let had_previous = match std::fs::symlink_metadata(dir) {
        Ok(metadata) => {
            anyhow::ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "browser profile directory must be a real directory"
            );
            std::fs::rename(dir, &backup)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = std::fs::rename(staging.path(), dir) {
        if had_previous {
            // If rollback itself fails, retain the backup instead of deleting
            // the user's old local profile when TempDir drops.
            if std::fs::rename(&backup, dir).is_err() {
                let _ = previous.keep();
            }
        }
        return Err(error).context("failed to install restored browser profile");
    }
    Ok(last_hash)
}

async fn save_profile<Prepare, Upload, Uploaded>(
    session: &tokio::sync::Mutex<BrowserProfileSession>,
    shutdown: bool,
    prepare: Prepare,
    upload: Upload,
) -> Result<bool>
where
    Prepare: Future<Output = Result<Option<Vec<u8>>>>,
    Upload: FnOnce(Vec<u8>, i64) -> Uploaded,
    Uploaded: Future<Output = Result<i64>>,
{
    let mut session = session.lock().await;
    if session.shutdown {
        return Ok(false);
    }
    session.shutdown = shutdown;
    if !shutdown && session.writer.is_none() {
        return Ok(false);
    }
    let Some(packed) = prepare.await? else {
        return Ok(false);
    };
    let Some(writer) = session.writer.as_ref() else {
        return Ok(false);
    };
    let previous_hash = writer.last_hash;
    if packed.is_empty() {
        return Ok(false);
    }
    anyhow::ensure!(
        packed.len() <= MAX_PROFILE_BYTES,
        "browser profile snapshot exceeds cap"
    );
    let hash = hash_bytes(&packed);
    if previous_hash == Some(hash) {
        return Ok(false);
    }
    // Remove authority before the request can reach the controller. A failed
    // response or an aborted periodic task may follow a committed write; the
    // final save must not retry or guess/adopt the server's new version.
    let writer = session.writer.take().expect("writer checked above");
    let version = upload(packed, writer.version).await?;
    anyhow::ensure!(
        writer.version.checked_add(1) == Some(version),
        "browser profile upload returned an unexpected version"
    );
    session.writer = Some(BrowserProfileWriter {
        version,
        last_hash: Some(hash),
    });
    Ok(true)
}

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
/// Re-registration retains the same baseline, including a disabled writer after
/// failure. Never GET a newer version and pair it with an already-running local
/// profile. A dead Chromium process may relaunch using the existing local state
/// but does not silently establish a new persistence baseline.
pub async fn maybe_restore_and_launch(client: &ControllerClient, registration: &Registration) {
    if !persistence_enabled() {
        return;
    }

    let mut session = client.browser_profile_session.lock().await;
    if session.shutdown {
        return;
    }
    let running = chromium_is_running().await;
    if !session.restore_attempted {
        if running {
            session.restore_attempted = true;
            warn!("browser already running without a restored version; profile saves disabled");
        } else {
            match session
                .restore(client.get_browser_profile(registration), profile_dir())
                .await
            {
                Ok(()) => info!("restored browser profile baseline"),
                Err(error) => warn!(
                    ?error,
                    "browser profile restore failed; profile saves disabled"
                ),
            }
        }
    }
    if !running {
        if let Err(error) = launch_chromium().await {
            warn!(?error, "failed to launch Chromium after profile restore");
        }
    }
}

/// Final snapshot on graceful shutdown. Requests a clean Chromium close and
/// requires confirmed exit before using the same version-checked writer as
/// periodic snapshots. A SIGTERM fallback may lose unflushed browser writes.
/// Failed/conflicted writers have no shutdown override.
pub async fn maybe_snapshot(client: &ControllerClient, registration: &Registration) {
    if !persistence_enabled() {
        return;
    }
    pack_and_upload(client, registration, true).await;
}

/// Best-effort periodic recovery points for abrupt SIGKILL (idle cull, crash,
/// host loss); `maybe_snapshot` only runs on a clean shutdown. Runs until
/// `shutdown` fires. No-op unless persistence is enabled and the interval is > 0.
///
/// Unlike the shutdown path, this must NOT close the browser (it is still in
/// use), so it copies files Chromium has already written. Batched writes can lag
/// the browser session and live copies can be inconsistent, even if packing and
/// uploading succeed. There is no guaranteed recovery interval or next-tick
/// correction. Persistence failure does not prevent ordinary browsing.
///
/// All uploads compare against the exact restored/acknowledged version. A
/// conflict or uncertain response disables saves for the process, including
/// shutdown, without fetching/adopting another runtime's newer version.
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

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(interval) => {}
        }
        pack_and_upload(client.as_ref(), &registration, false).await;
    }
}

/// Serialize Chromium close, packing and upload against periodic saves. The
/// acknowledged version and content hash survive registration renewals.
async fn pack_and_upload(client: &ControllerClient, registration: &Registration, shutdown: bool) {
    let context = if shutdown { "shutdown" } else { "periodic" };
    let result = save_profile(
        &client.browser_profile_session,
        shutdown,
        prepare_profile_snapshot(
            async {
                if shutdown {
                    close_chromium().await?;
                } else if !chromium_is_running().await {
                    return Ok(false);
                }
                Ok(true)
            },
            async {
                let dir = profile_dir();
                tokio::task::spawn_blocking(move || pack_profile(&dir))
                    .await
                    .context("profile pack task failed")?
            },
        ),
        |packed, version| client.put_browser_profile(registration, packed, version),
    )
    .await;
    match result {
        Ok(true) => info!(context, "uploaded browser profile snapshot"),
        Ok(false) => {}
        Err(error) => warn!(?error, context, "browser profile snapshot failed"),
    }
}

/// Do not even start packing until browser preparation has succeeded. In the
/// shutdown path, that means a confirmed stopped process, not a close attempt.
async fn prepare_profile_snapshot(
    ready: impl Future<Output = Result<bool>>,
    pack: impl Future<Output = Result<Vec<u8>>>,
) -> Result<Option<Vec<u8>>> {
    if !ready.await? {
        return Ok(None);
    }
    pack.await.map(Some)
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
    command.arg("-e").arg(JS).arg(&endpoint).kill_on_drop(true);
    apply_allowlisted_tokio_environment(&mut command, BROWSER_HELPER_ENV_KEYS);
    let Ok(child) = command.spawn() else {
        return false;
    };
    wait_for_close_helper(child, CHROMIUM_CDP_CLOSE_TIMEOUT).await
}

async fn wait_for_close_helper(mut child: tokio::process::Child, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, child.wait()).await,
        Ok(Ok(status)) if status.success()
    )
}

/// Request a clean close, falling back to SIGTERM if CDP is unavailable. A
/// successful signal/helper is not proof of exit. Missing/invalid PID, unknown
/// liveness, or timeout fails closed so the remote snapshot is retained.
async fn close_chromium() -> Result<()> {
    tokio::time::timeout(CHROMIUM_CLOSE_TIMEOUT, async {
        let pid_text = tokio::fs::read_to_string(CHROMIUM_PID_FILE)
            .await
            .context("cannot confirm Chromium stopped without its PID file")?;
        let pid = parse_chromium_pid(&pid_text)?;
        let Some(identity) = chromium_process_identity(pid).await? else {
            return Ok(());
        };
        if identity.zombie {
            return Ok(());
        }
        // A stale PID file must not authorize signaling an unrelated process.
        let cmdline = tokio::fs::read(format!("/proc/{pid}/cmdline"))
            .await
            .context("cannot confirm Chromium process identity")?;
        let profile_arg = format!("--user-data-dir={}", profile_dir().display());
        let cdp_arg = format!("--remote-debugging-port={}", cdp_port());
        anyhow::ensure!(
            cmdline
                .split(|byte| *byte == 0)
                .any(|arg| arg == profile_arg.as_bytes())
                && cmdline
                    .split(|byte| *byte == 0)
                    .any(|arg| arg == cdp_arg.as_bytes()),
            "Chromium PID does not match the configured browser"
        );

        if !cdp_graceful_close().await {
            if chromium_process_stopped(pid, identity).await? {
                return Ok(());
            }
            let mut command = tokio::process::Command::new("kill");
            command.arg("-TERM").arg(pid.to_string()).kill_on_drop(true);
            apply_allowlisted_tokio_environment(&mut command, &[]);
            // Exit may race the signal; the strict liveness probe below is the
            // authority, not this command's success status.
            command
                .status()
                .await
                .context("failed to signal Chromium")?;
        }
        wait_for_chromium_exit(|| chromium_process_stopped(pid, identity)).await
    })
    .await
    .context("Chromium close timed out; final profile snapshot skipped")?
}

fn parse_chromium_pid(text: &str) -> Result<i32> {
    let pid = text.trim().parse::<i32>().context("invalid Chromium PID")?;
    anyhow::ensure!(pid > 1, "invalid Chromium PID");
    Ok(pid)
}

#[derive(Clone, Copy)]
struct ChromiumProcessIdentity {
    start_ticks: u64,
    zombie: bool,
}

#[cfg(any(target_os = "linux", test))]
fn parse_chromium_process_identity(stat: &str) -> Result<ChromiumProcessIdentity> {
    let (_, fields) = stat
        .rsplit_once(')')
        .context("invalid Chromium process stat")?;
    let mut fields = fields.split_whitespace();
    let state = fields.next().context("missing Chromium process state")?;
    // Fields start at state (field 3); starttime is field 22.
    let start_ticks = fields
        .nth(18)
        .context("missing Chromium process start time")?
        .parse()?;
    Ok(ChromiumProcessIdentity {
        start_ticks,
        zombie: state == "Z",
    })
}

/// Stronger than the ordinary browsing probe. Managed persistence runs on
/// Linux; unavailable inspection elsewhere is unknown, never proof of exit.
async fn chromium_process_identity(pid: i32) -> Result<Option<ChromiumProcessIdentity>> {
    #[cfg(target_os = "linux")]
    match tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await {
        Ok(stat) => return parse_chromium_process_identity(&stat).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("cannot inspect Chromium process"),
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: signal 0 only probes the validated positive PID; it does not
        // deliver a signal or access memory through pointers.
        anyhow::ensure!(
            unsafe { libc::kill(pid, 0) } != 0,
            "Chromium process inspection unavailable"
        );
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        Err(error).context("cannot confirm Chromium process stopped")
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        anyhow::bail!("Chromium stop confirmation requires Linux process inspection")
    }
}

fn chromium_identity_stopped(
    current: Option<ChromiumProcessIdentity>,
    expected: ChromiumProcessIdentity,
) -> Result<bool> {
    let Some(current) = current else {
        return Ok(true);
    };
    anyhow::ensure!(
        current.start_ticks == expected.start_ticks,
        "Chromium PID was reused; exit is unknown"
    );
    Ok(current.zombie)
}

async fn chromium_process_stopped(pid: i32, expected: ChromiumProcessIdentity) -> Result<bool> {
    chromium_identity_stopped(chromium_process_identity(pid).await?, expected)
}

async fn wait_for_chromium_exit<Probe, Checked>(mut stopped: Probe) -> Result<()>
where
    Probe: FnMut() -> Checked,
    Checked: Future<Output = Result<bool>>,
{
    loop {
        if stopped().await? {
            return Ok(());
        }
        tokio::time::sleep(CHROMIUM_CLOSE_POLL).await;
    }
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
            budget.visit_entry(limits)?;
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
    let mut sorted_entries = Vec::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("failed to read entry in {}", dir.display()))?;
        // Reserve every encountered entry before buffering, including skipped
        // symlinks/non-files. Across recursive calls the shared cap bounds both
        // enumeration work and memory; never collect an unbounded directory.
        budget.visit_entry(limits)?;
        let path = entry.path();
        let relative = path
            .strip_prefix(base)
            .context("profile directory escaped base")?;
        anyhow::ensure!(
            relative_to_zip_name(relative).len() <= MAX_PROFILE_PATH_BYTES,
            "browser profile path exceeds the supported bounds"
        );
        sorted_entries.push(entry);
    }
    sorted_entries.sort_unstable_by_key(|entry| entry.file_name());
    for entry in sorted_entries {
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

    fn writable_session(version: i64) -> tokio::sync::Mutex<BrowserProfileSession> {
        tokio::sync::Mutex::new(BrowserProfileSession {
            restore_attempted: true,
            shutdown: false,
            writer: Some(BrowserProfileWriter {
                version,
                last_hash: None,
            }),
        })
    }

    #[tokio::test]
    async fn failed_shutdown_close_never_packs_uploads_or_advances_baseline() {
        let session = writable_session(7);
        assert!(
            save_profile(
                &session,
                true,
                prepare_profile_snapshot(
                    async { anyhow::bail!("Chromium exit is unknown") },
                    async { panic!("failed close must never start packing") },
                ),
                |_, _| async { panic!("failed close must never upload") },
            )
            .await
            .is_err()
        );
        {
            let state = session.lock().await;
            assert!(state.shutdown);
            let writer = state.writer.as_ref().unwrap();
            assert_eq!(writer.version, 7);
            assert_eq!(writer.last_hash, None);
        }
        assert!(
            !save_profile(
                &session,
                true,
                async { panic!("failed shutdown must not retry preparation") },
                |_, _| async { panic!("failed shutdown must not retry upload") },
            )
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    async fn failed_profile_preparation_never_uploads_or_advances_baseline() {
        let session = writable_session(3);
        assert!(
            save_profile(
                &session,
                true,
                prepare_profile_snapshot(async { Ok(true) }, async {
                    anyhow::bail!("packing failed")
                },),
                |_, _| async { panic!("failed preparation must never upload") },
            )
            .await
            .is_err()
        );
        assert_eq!(session.lock().await.writer.as_ref().unwrap().version, 3);
        assert!(
            prepare_profile_snapshot(async { Ok(false) }, async {
                panic!("unready browser must not pack")
            },)
            .await
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn chromium_stop_confirmation_rejects_unknown_or_reused_process_identity() {
        for invalid in ["", " ", "abc", "-1", "0", "1", "2147483648"] {
            assert!(parse_chromium_pid(invalid).is_err());
        }
        assert_eq!(parse_chromium_pid(" 123\n").unwrap(), 123);
        let running = ChromiumProcessIdentity {
            start_ticks: 42,
            zombie: false,
        };
        let zombie = ChromiumProcessIdentity {
            start_ticks: 42,
            zombie: true,
        };
        assert!(!chromium_identity_stopped(Some(running), running).unwrap());
        assert!(chromium_identity_stopped(Some(zombie), running).unwrap());
        assert!(chromium_identity_stopped(None, running).unwrap());
        let reused = ChromiumProcessIdentity {
            start_ticks: 43,
            zombie: true,
        };
        assert!(chromium_identity_stopped(Some(reused), running).is_err());
        assert!(parse_chromium_process_identity("123 (chromium) Z").is_err());
        let stat = format!("123 (chromium (main)) Z {} 42 999", "0 ".repeat(18));
        let parsed = parse_chromium_process_identity(&stat).unwrap();
        assert_eq!(parsed.start_ticks, 42);
        assert!(parsed.zombie);
    }

    #[tokio::test]
    async fn chromium_close_wait_requires_confirmed_exit_and_is_bounded() {
        wait_for_chromium_exit(|| async { Ok(true) }).await.unwrap();
        assert!(
            wait_for_chromium_exit(|| async { anyhow::bail!("permission denied") })
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                wait_for_chromium_exit(|| async { Ok(false) }),
            )
            .await
            .is_err()
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                wait_for_chromium_exit(|| std::future::pending::<Result<bool>>()),
            )
            .await
            .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_close_helper_is_killed_instead_of_hanging_shutdown() {
        // Only a disposable sleep process, never a browser or real profile.
        let child = tokio::process::Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap() as i32;
        assert!(!wait_for_close_helper(child, Duration::from_millis(10)).await);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                // Probe only the disposable child's PID. libc is a Linux-only
                // dependency; this helper test also runs on macOS.
                if !tokio::process::Command::new("kill")
                    .arg("-0")
                    .arg(pid.to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .status()
                    .await
                    .unwrap()
                    .success()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("timed-out helper must be killed and reaped");
    }

    #[test]
    fn profile_pack_order_is_deterministic_and_directory_buffering_is_bounded() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let names = ["z.log", "a/last", "a/first", "m.log"];
        for (dir, order) in [
            (first.path(), names.to_vec()),
            (second.path(), names.iter().rev().copied().collect()),
        ] {
            for name in order {
                let path = dir.join("Default/Local Storage").join(name);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, name.as_bytes()).unwrap();
            }
        }
        assert_eq!(
            pack_profile(first.path()).unwrap(),
            pack_profile(second.path()).unwrap()
        );
        assert!(pack_profile_with_limits(first.path(), limits(4096, 4096, 1024, 3)).is_err());
    }

    #[tokio::test]
    async fn restored_unchanged_profiles_do_not_consume_versions_but_real_changes_do() {
        // Intentionally non-normalized input order: both restored sessions must
        // compare normalized local packs, not the original archive's bytes.
        let archive = profile_zip(&[
            ("Default/Local Storage/z", 3, b'z'),
            ("Local State", 3, b'k'),
            ("Default/Local Storage/a", 3, b'a'),
        ]);
        for _ in 0..2 {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().join("profile");
            let mut state = BrowserProfileSession::default();
            state
                .restore(
                    async {
                        Ok(BrowserProfileSnapshot {
                            version: 5,
                            archive: Some(archive.clone()),
                        })
                    },
                    dir.clone(),
                )
                .await
                .unwrap();
            let session = tokio::sync::Mutex::new(state);
            assert!(
                !save_profile(
                    &session,
                    false,
                    async { pack_profile(&dir).map(Some) },
                    |_, _| async {
                        panic!("unchanged restored baseline must not consume a version")
                    },
                )
                .await
                .unwrap()
            );
            assert_eq!(session.lock().await.writer.as_ref().unwrap().version, 5);
            std::fs::write(dir.join("Local State"), b"changed").unwrap();
            assert!(
                save_profile(
                    &session,
                    false,
                    async { pack_profile(&dir).map(Some) },
                    |_, version| async move {
                        assert_eq!(version, 5);
                        Ok(6)
                    },
                )
                .await
                .unwrap()
            );
            assert_eq!(session.lock().await.writer.as_ref().unwrap().version, 6);
        }
    }

    #[tokio::test]
    async fn profile_restore_establishes_exact_baseline_without_stale_cookie_files() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("profile");
        std::fs::create_dir_all(dir.join("Default")).unwrap();
        std::fs::write(dir.join("Default/Cookies"), b"old-local-cookie").unwrap();
        let mut session = BrowserProfileSession::default();
        session
            .restore(
                async {
                    Ok(BrowserProfileSnapshot {
                        version: 4,
                        archive: Some(profile_zip(&[("Local State", 5, b'x')])),
                    })
                },
                dir.clone(),
            )
            .await
            .unwrap();
        assert_eq!(session.writer.as_ref().unwrap().version, 4);
        assert_eq!(std::fs::read(dir.join("Local State")).unwrap(), b"xxxxx");
        assert!(!dir.join("Default/Cookies").exists());

        // A genuine 404 also replaces old local state with the empty baseline.
        let mut empty = BrowserProfileSession::default();
        empty
            .restore(
                async {
                    Ok(BrowserProfileSnapshot {
                        version: 0,
                        archive: None,
                    })
                },
                dir.clone(),
            )
            .await
            .unwrap();
        assert_eq!(empty.writer.unwrap().version, 0);
        assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn failed_profile_fetch_or_restore_never_enables_saves_or_retries_baseline() {
        for archive in [None, Some(b"not-a-zip".to_vec())] {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().join("profile");
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("Local State"), b"retained-local-data").unwrap();
            let mut session = BrowserProfileSession::default();
            let result = session
                .restore(
                    async {
                        let archive = archive.context("fetch failed")?;
                        Ok(BrowserProfileSnapshot {
                            version: 9,
                            archive: Some(archive),
                        })
                    },
                    dir.clone(),
                )
                .await;
            assert!(result.is_err());
            assert!(session.restore_attempted);
            assert!(session.writer.is_none());
            assert_eq!(
                std::fs::read(dir.join("Local State")).unwrap(),
                b"retained-local-data"
            );
            assert!(
                session
                    .restore(async { panic!("must not refetch a new baseline") }, dir)
                    .await
                    .is_err()
            );
            let session = tokio::sync::Mutex::new(session);
            assert!(
                !save_profile(
                    &session,
                    true,
                    async { Ok(Some(b"unsaved-local-data".to_vec())) },
                    |_, _| async { panic!("failed restore must not overwrite stored profile") },
                )
                .await
                .unwrap()
            );
        }
    }

    #[tokio::test]
    async fn profile_conflict_latches_without_retry_or_adopting_another_version() {
        let session = writable_session(3);
        assert!(
            save_profile(
                &session,
                false,
                async { Ok(Some(b"local".to_vec())) },
                |_, version| async move {
                    assert_eq!(version, 3);
                    anyhow::bail!("409: another runtime wrote version 4")
                },
            )
            .await
            .is_err()
        );
        assert!(session.lock().await.writer.is_none());
        for shutdown in [false, true] {
            assert!(
                !save_profile(
                    &session,
                    shutdown,
                    async { Ok(Some(b"newer-local".to_vec())) },
                    |_, _| async {
                        panic!("conflicted writer must never retry, including shutdown")
                    },
                )
                .await
                .unwrap()
            );
        }
    }

    #[tokio::test]
    async fn cancelled_profile_upload_cannot_be_retried_by_shutdown() {
        let session = Arc::new(writable_session(8));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let periodic_session = session.clone();
        let periodic = tokio::spawn(async move {
            save_profile(
                &periodic_session,
                false,
                async { Ok(Some(b"possibly-committed".to_vec())) },
                |_, version| async move {
                    assert_eq!(version, 8);
                    started_tx.send(()).unwrap();
                    std::future::pending::<Result<i64>>().await
                },
            )
            .await
        });
        started_rx.await.unwrap();
        periodic.abort();
        assert!(periodic.await.unwrap_err().is_cancelled());
        assert!(session.lock().await.writer.is_none());
        assert!(
            !save_profile(
                &session,
                true,
                async { Ok(Some(b"final-local".to_vec())) },
                |_, _| async { panic!("uncertain upload must not be retried") },
            )
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    async fn periodic_and_shutdown_profile_saves_serialize_and_advance_one_baseline() {
        let session = Arc::new(writable_session(0));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let periodic_session = session.clone();
        let periodic = tokio::spawn(async move {
            save_profile(
                &periodic_session,
                false,
                async { Ok(Some(b"periodic".to_vec())) },
                |_, version| async move {
                    assert_eq!(version, 0);
                    started_tx.send(()).unwrap();
                    finish_rx.await.unwrap();
                    Ok(1)
                },
            )
            .await
        });
        started_rx.await.unwrap();
        let final_session = session.clone();
        let (prepare_tx, mut prepare_rx) = tokio::sync::oneshot::channel();
        let final_save = tokio::spawn(async move {
            save_profile(
                &final_session,
                true,
                async move {
                    prepare_tx.send(()).unwrap();
                    Ok(Some(b"final-flushed".to_vec()))
                },
                |_, version| async move {
                    assert_eq!(version, 1);
                    Ok(2)
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(matches!(
            prepare_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        finish_tx.send(()).unwrap();
        assert!(periodic.await.unwrap().unwrap());
        assert!(final_save.await.unwrap().unwrap());
        assert_eq!(session.lock().await.writer.as_ref().unwrap().version, 2);
        assert!(
            !save_profile(
                &session,
                false,
                async { panic!("shutdown must gate later preparation") },
                |_, _| async { panic!("shutdown must gate later uploads") },
            )
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    async fn profile_saves_require_matching_ack_and_skip_unchanged_archives() {
        let session = writable_session(5);
        assert!(
            save_profile(
                &session,
                false,
                async { Ok(Some(vec![1])) },
                |_, version| async move {
                    assert_eq!(version, 5);
                    Ok(6)
                }
            )
            .await
            .unwrap()
        );
        assert!(
            !save_profile(&session, false, async { Ok(Some(vec![1])) }, |_, _| async {
                panic!("unchanged snapshot must not upload")
            })
            .await
            .unwrap()
        );
        assert!(
            save_profile(
                &session,
                false,
                async { Ok(Some(vec![2])) },
                |_, version| async move {
                    assert_eq!(version, 6);
                    Ok(99)
                }
            )
            .await
            .is_err()
        );
        assert!(session.lock().await.writer.is_none());
    }

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
