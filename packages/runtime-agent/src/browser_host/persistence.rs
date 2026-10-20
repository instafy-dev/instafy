//! Keeps a lazy browser host's sign-ins in the space's durable profile store.
//!
//! Every host start restores the stored profile while the host is down;
//! while it is Ready a periodic task saves it; a stop closes Chromium
//! cleanly over CDP, confirms it exited, and saves once more. Saves use the
//! controller's versioned writes (`PUT /agent/browser-profile/v2?version=N`),
//! as the boot-time browser's persistence does (`crate::browser_profile`).
//! The two never run in one process: a lazy host needs the boot-time browser
//! off, and the boot-time persistence needs it on.
//!
//! Unlike the boot-time persistence, one failed or uncertain save does not
//! stop saving for the process. Each save records what it sent before
//! sending it, so an uncertain result is resolved later by comparing the
//! stored copy's SHA-256 with what was sent and what was there before. The
//! controller stores and returns the uploaded bytes unchanged, so the hashes
//! are exact.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::{info, warn};

use super::mode::{HOST_CDP_PORT, HOST_NODE_BINARY};
use super::process::HOST_PATH;
use crate::browser_profile::{hash_bytes, pack_profile, restore_profile_baseline};
use crate::controller::{BrowserProfileSnapshot, ControllerClient, UploadFailure};

/// How long a restore (or the read that resolves an uncertain save) may
/// wait for the stored copy.
pub(crate) const RESTORE_BUDGET: Duration = Duration::from_secs(30);
/// How long the CDP close helper may run.
pub(crate) const CLOSE_HELPER_BUDGET: Duration = Duration::from_secs(2);
/// How long Chromium may take to exit after the close.
pub(crate) const CLOSE_CONFIRM_BUDGET: Duration = Duration::from_secs(5);

/// Seconds between periodic saves; the controller sets it for covered
/// spaces. `0` turns periodic saves off.
const SNAPSHOT_INTERVAL_ENV: &str = "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS";
const DEFAULT_SNAPSHOT_INTERVAL: Duration = Duration::from_secs(120);

/// Connects to the host's Chromium and asks it to close, which flushes its
/// cookie store. Only the private Playwright is loaded, by absolute path.
const CLOSE_SCRIPT: &str = "const {chromium}=require('/opt/instafy/browser-host/node_modules/playwright');\
chromium.connectOverCDP(process.argv[1])\
.then(async b=>{const s=await b.newBrowserCDPSession();try{await s.send('Browser.close')}catch(e){}process.exit(0)})\
.catch(()=>process.exit(1));";

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The space's durable profile store.
pub(crate) trait ProfileStore: Send + Sync {
    /// The stored version and archive; version 0 with no archive when empty.
    fn fetch(&self) -> BoxFuture<'_, Result<BrowserProfileSnapshot>>;
    /// Stores `body` if the stored version is still `expected_version`, and
    /// returns the new version.
    fn upload(
        &self,
        body: Vec<u8>,
        expected_version: i64,
    ) -> BoxFuture<'_, std::result::Result<i64, UploadFailure>>;
}

/// The controller's store, with the freshest agent token.
pub(crate) struct ControllerProfileStore(pub(crate) Arc<ControllerClient>);

impl ProfileStore for ControllerProfileStore {
    fn fetch(&self) -> BoxFuture<'_, Result<BrowserProfileSnapshot>> {
        Box::pin(self.0.get_browser_profile_with_current_token())
    }

    fn upload(
        &self,
        body: Vec<u8>,
        expected_version: i64,
    ) -> BoxFuture<'_, std::result::Result<i64, UploadFailure>> {
        Box::pin(
            self.0
                .put_browser_profile_classified(None, body, expected_version),
        )
    }
}

type Sha256Digest = [u8; 32];

fn sha256(bytes: &[u8]) -> Sha256Digest {
    Sha256::digest(bytes).into()
}

/// The stored version this process may write over, and the exact bytes it
/// holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Writer {
    version: i64,
    /// SHA-256 of the stored bytes (of the empty string for version 0).
    archive_sha256: Sha256Digest,
    /// Hash of the local profile packed as stored, to skip unchanged saves.
    packed_hash: u64,
}

/// An upload whose result is not known yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pending {
    expected: i64,
    sha256: Sha256Digest,
    prev_sha256: Sha256Digest,
    packed_hash: u64,
    prev_packed_hash: u64,
}

#[derive(Debug, Default)]
struct HostProfileSession {
    writer: Option<Writer>,
    pending: Option<Pending>,
    /// A packed hash the controller refused; not sent again.
    rejected_hash: Option<u64>,
    /// This process installed a stored baseline at least once.
    baseline_installed: bool,
    /// The runtime's final save ran; nothing saves after it.
    shutdown: bool,
}

impl HostProfileSession {
    /// Settles `pending` against the stored `version` and bytes: the upload
    /// either committed or never landed. False when neither matches.
    fn resolve_pending(&mut self, version: i64, stored: &Sha256Digest) -> bool {
        let Some(pending) = self.pending else {
            return false;
        };
        let packed_hash =
            if Some(version) == pending.expected.checked_add(1) && *stored == pending.sha256 {
                pending.packed_hash
            } else if version == pending.expected && *stored == pending.prev_sha256 {
                // Not landed: the local profile still differs from the stored
                // copy, so the next save sends it again.
                pending.prev_packed_hash
            } else {
                return false;
            };
        self.writer = Some(Writer {
            version,
            archive_sha256: *stored,
            packed_hash,
        });
        self.pending = None;
        true
    }
}

/// What a restore did to the local profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestoreOutcome {
    /// The local profile already matches the stored copy (or the store was
    /// unreachable and this process may still write): it is used as is.
    KeptLocal,
    /// The stored copy replaced the local profile exactly.
    Installed,
    /// The local profile came from this process's earlier restore; saves
    /// stay off until the stored copy is known again.
    KeptLocalSavesOff,
    /// Nothing trustworthy was available: the browser starts signed out.
    StartedEmpty,
}

/// What a save did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SaveOutcome {
    Saved(i64),
    /// Nothing new to send.
    Unchanged,
    /// Saves are off, the store was unreachable, or the browser is not
    /// Ready.
    Skipped,
    /// Another writer's version is stored; the next start installs it.
    Conflict,
    /// The controller refused this copy; the writer is kept.
    Rejected,
    /// The result is unknown; it is resolved by the next save or start.
    Uncertain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SaveKind {
    Periodic,
    /// A host stop within a running process; later starts save again.
    HostStop,
    /// The runtime's shutdown; nothing saves after it.
    Final,
}

/// The host's profile writer, shared by restores, the periodic task and
/// stops. One mutex serializes them, held across pack and upload.
pub(crate) struct HostPersistence {
    store: Arc<dyn ProfileStore>,
    session: Mutex<HostProfileSession>,
    interval: Duration,
    restore_budget: Duration,
    /// Set by poison, a kill without save, or the runtime's shutdown;
    /// synchronous, so a Drop handler can set it.
    disabled: AtomicBool,
}

impl std::fmt::Debug for HostPersistence {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostPersistence")
            .field("interval", &self.interval)
            .field("disabled", &self.is_disabled())
            .finish_non_exhaustive()
    }
}

impl HostPersistence {
    pub(crate) fn new(store: Arc<dyn ProfileStore>, interval: Duration) -> Self {
        Self {
            store,
            session: Mutex::new(HostProfileSession::default()),
            interval,
            restore_budget: RESTORE_BUDGET,
            disabled: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_restore_budget(mut self, budget: Duration) -> Self {
        self.restore_budget = budget;
        self
    }

    /// No more saves from this process. The last successful save stands.
    pub(crate) fn disable(&self) {
        self.disabled.store(true, Ordering::SeqCst);
    }

    fn is_disabled(&self) -> bool {
        self.disabled.load(Ordering::SeqCst)
    }

    /// Restores the stored profile into `profile` before a start, while the
    /// host is down. `Err` only when the profile could not be emptied, so the
    /// start must not run on it.
    pub(crate) async fn restore(&self, profile: &Path) -> Result<RestoreOutcome> {
        let mut session = self.session.lock().await;
        let fetched = tokio::time::timeout(self.restore_budget, self.store.fetch()).await;
        let snapshot = match fetched {
            Ok(Ok(snapshot)) => snapshot,
            Ok(Err(error)) => {
                warn!(?error, "could not read the stored browser profile");
                return keep_or_empty(&mut session, profile, false);
            }
            Err(_) => {
                warn!("reading the stored browser profile timed out");
                return keep_or_empty(&mut session, profile, false);
            }
        };
        let stored = sha256(snapshot.archive.as_deref().unwrap_or_default());
        let version = snapshot.version;
        if session
            .writer
            .is_some_and(|writer| writer.version == version && writer.archive_sha256 == stored)
        {
            return Ok(RestoreOutcome::KeptLocal);
        }
        if session.resolve_pending(version, &stored) {
            return Ok(RestoreOutcome::KeptLocal);
        }

        let dir = profile.to_path_buf();
        let installed =
            tokio::task::spawn_blocking(move || restore_profile_baseline(snapshot, &dir)).await;
        match installed {
            Ok(Ok(packed_hash)) => {
                session.writer = Some(Writer {
                    version,
                    archive_sha256: stored,
                    packed_hash,
                });
                session.pending = None;
                session.rejected_hash = None;
                session.baseline_installed = true;
                info!(version, "restored the browser profile");
                Ok(RestoreOutcome::Installed)
            }
            Ok(Err(error)) => {
                warn!(?error, "could not install the stored browser profile");
                keep_or_empty(&mut session, profile, true)
            }
            Err(error) => {
                warn!(?error, "the browser profile restore task failed");
                keep_or_empty(&mut session, profile, true)
            }
        }
    }

    /// Saves the local profile against the writer's version. For
    /// [`SaveKind::Periodic`], `ready` must hold when the save begins.
    pub(crate) async fn save(
        &self,
        profile: &Path,
        kind: SaveKind,
        deadline: Option<Instant>,
        ready: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> SaveOutcome {
        let mut session = self.session.lock().await;
        let outcome = self
            .save_locked(&mut session, profile, deadline, ready)
            .await;
        if kind == SaveKind::Final {
            session.shutdown = true;
        }
        match outcome {
            SaveOutcome::Saved(version) => info!(version, ?kind, "saved the browser profile"),
            SaveOutcome::Conflict => warn!(
                ?kind,
                "another browser profile was saved meanwhile; the next start installs it"
            ),
            SaveOutcome::Rejected => warn!(?kind, "the controller refused the browser profile"),
            SaveOutcome::Uncertain => warn!(?kind, "the browser profile save result is unknown"),
            SaveOutcome::Unchanged | SaveOutcome::Skipped => {}
        }
        outcome
    }

    async fn save_locked(
        &self,
        session: &mut HostProfileSession,
        profile: &Path,
        deadline: Option<Instant>,
        ready: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> SaveOutcome {
        if session.shutdown || self.is_disabled() || ready.is_some_and(|ready| !ready()) {
            return SaveOutcome::Skipped;
        }
        if session.pending.is_some() {
            // A read only: it never touches the local profile.
            let budget = remaining(self.restore_budget, deadline);
            match tokio::time::timeout(budget, self.store.fetch()).await {
                Ok(Ok(snapshot)) => {
                    let stored = sha256(snapshot.archive.as_deref().unwrap_or_default());
                    if !session.resolve_pending(snapshot.version, &stored) {
                        session.writer = None;
                        session.pending = None;
                        return SaveOutcome::Conflict;
                    }
                }
                Ok(Err(error)) => {
                    warn!(
                        ?error,
                        "could not read the stored browser profile to settle a save"
                    );
                    return SaveOutcome::Skipped;
                }
                Err(_) => return SaveOutcome::Skipped,
            }
        }
        let Some(writer) = session.writer else {
            return SaveOutcome::Skipped;
        };

        let dir = profile.to_path_buf();
        let packed = match tokio::task::spawn_blocking(move || pack_profile(&dir)).await {
            Ok(Ok(packed)) => packed,
            Ok(Err(error)) => {
                warn!(?error, "could not pack the browser profile");
                return SaveOutcome::Skipped;
            }
            Err(error) => {
                warn!(?error, "the browser profile pack task failed");
                return SaveOutcome::Skipped;
            }
        };
        if packed.is_empty() {
            return SaveOutcome::Unchanged;
        }
        let packed_hash = hash_bytes(&packed);
        if packed_hash == writer.packed_hash || session.rejected_hash == Some(packed_hash) {
            return SaveOutcome::Unchanged;
        }
        if self.is_disabled() {
            return SaveOutcome::Skipped;
        }

        // Recorded before the request can reach the controller, so whatever
        // happens to the response, the stored copy can be recognised later.
        let sent = sha256(&packed);
        session.writer = None;
        session.pending = Some(Pending {
            expected: writer.version,
            sha256: sent,
            prev_sha256: writer.archive_sha256,
            packed_hash,
            prev_packed_hash: writer.packed_hash,
        });
        let upload = self.store.upload(packed, writer.version);
        let result = match deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, upload)
                .await
                .unwrap_or_else(|_| {
                    Err(UploadFailure::Uncertain(anyhow!(
                        "the browser profile upload ran out of time"
                    )))
                }),
            None => upload.await,
        };
        match result {
            Ok(version) if Some(version) == writer.version.checked_add(1) => {
                session.writer = Some(Writer {
                    version,
                    archive_sha256: sent,
                    packed_hash,
                });
                session.pending = None;
                session.rejected_hash = None;
                SaveOutcome::Saved(version)
            }
            Ok(_) => SaveOutcome::Uncertain,
            Err(UploadFailure::Conflict) => {
                session.pending = None;
                SaveOutcome::Conflict
            }
            Err(UploadFailure::Rejected(status)) => {
                warn!(%status, "browser profile upload refused");
                session.writer = Some(writer);
                session.pending = None;
                session.rejected_hash = Some(packed_hash);
                SaveOutcome::Rejected
            }
            Err(UploadFailure::Uncertain(error)) => {
                warn!(?error, "browser profile upload failed");
                SaveOutcome::Uncertain
            }
        }
    }

    /// Starts the periodic saves for a Ready host; `None` when they are off.
    /// Each tick saves only while `ready` holds.
    pub(crate) fn start_saver(
        self: &Arc<Self>,
        profile: PathBuf,
        ready: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Option<Saver> {
        if self.interval.is_zero() {
            return None;
        }
        let (stop, mut stopped) = watch::channel(false);
        let persistence = self.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stopped.changed() => return,
                    _ = tokio::time::sleep(persistence.interval) => {}
                }
                // Not raced against the stop: an upload in flight finishes.
                persistence
                    .save(&profile, SaveKind::Periodic, None, Some(&*ready))
                    .await;
                if *stopped.borrow() {
                    return;
                }
            }
        });
        Some(Saver { stop, task })
    }
}

/// After the stored copy could not be read or installed: keep the local
/// profile if this process may write over the store (or restored it
/// earlier), else empty it, without following symlinks.
fn keep_or_empty(
    session: &mut HostProfileSession,
    profile: &Path,
    drop_writer: bool,
) -> Result<RestoreOutcome> {
    let had_writer = session.writer.is_some();
    if drop_writer {
        session.writer = None;
        session.pending = None;
    }
    if had_writer && !drop_writer {
        return Ok(RestoreOutcome::KeptLocal);
    }
    if had_writer || session.baseline_installed {
        return Ok(RestoreOutcome::KeptLocalSavesOff);
    }
    remove_profile(profile)?;
    Ok(RestoreOutcome::StartedEmpty)
}

/// Removes the profile directory (a symlink there is removed, never
/// followed); the supervisor creates it again.
fn remove_profile(profile: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(profile) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir_all(profile)
        }
        Ok(_) => std::fs::remove_file(profile),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// `budget`, cut to what is left before `deadline`.
pub(crate) fn remaining(budget: Duration, deadline: Option<Instant>) -> Duration {
    match deadline {
        Some(deadline) => budget.min(deadline.saturating_duration_since(Instant::now())),
        None => budget,
    }
}

/// The periodic save task of one Ready host.
pub(crate) struct Saver {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Saver {
    /// Signals the task and waits for it; an upload in flight finishes
    /// first and is never aborted. False when `deadline` passed first (the
    /// task then finishes on its own).
    pub(crate) async fn stop(self, deadline: Option<Instant>) -> bool {
        let _ = self.stop.send(true);
        let mut task = self.task;
        match deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, &mut task).await.is_ok(),
            None => {
                let _ = task.await;
                true
            }
        }
    }
}

/// Asks the host's Chromium to close over CDP.
#[derive(Clone, Debug)]
pub(crate) struct CloseCommand {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<String>,
}

impl CloseCommand {
    /// The private Node with the private Playwright, against the host's CDP
    /// port.
    pub(crate) fn for_host() -> Self {
        Self {
            program: PathBuf::from(HOST_NODE_BINARY),
            args: vec![
                "-e".to_string(),
                CLOSE_SCRIPT.to_string(),
                format!("http://127.0.0.1:{HOST_CDP_PORT}"),
            ],
        }
    }

    /// Runs the helper with only `PATH` in its environment. True when it
    /// sent the close and exited cleanly within `budget`; that alone is not
    /// proof that Chromium stopped.
    pub(crate) async fn run(&self, budget: Duration) -> bool {
        let mut command = tokio::process::Command::new(&self.program);
        command
            .args(&self.args)
            .env_clear()
            .env("PATH", HOST_PATH)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let Ok(mut child) = command.spawn() else {
            return false;
        };
        matches!(
            tokio::time::timeout(budget, child.wait()).await,
            Ok(Ok(status)) if status.success()
        )
    }
}

/// The periodic save interval from the launch environment.
pub(crate) fn snapshot_interval() -> Duration {
    parse_snapshot_interval(std::env::var(SNAPSHOT_INTERVAL_ENV).ok().as_deref())
}

fn parse_snapshot_interval(raw: Option<&str>) -> Duration {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_SNAPSHOT_INTERVAL)
}

#[cfg(test)]
pub(crate) mod testing {
    //! An in-memory profile store with the controller's versioned writes.

    use super::*;
    use reqwest::StatusCode;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum UploadMode {
        Normal,
        Reject(StatusCode),
        /// Stores the copy, then reports an unknown result.
        UncertainAfterCommit,
        /// Stores nothing and reports an unknown result.
        UncertainBeforeCommit,
    }

    struct State {
        version: i64,
        archive: Option<Vec<u8>>,
        fetch_fails: bool,
        mode: UploadMode,
        fetches: usize,
        uploads_started: usize,
        uploads_finished: usize,
    }

    pub(crate) struct FakeStore {
        state: std::sync::Mutex<State>,
        /// Uploads wait while this is false.
        open: watch::Sender<bool>,
        log: Option<Arc<std::sync::Mutex<Vec<String>>>>,
    }

    impl FakeStore {
        pub(crate) fn new() -> Arc<Self> {
            Self::build(None)
        }

        /// Pushes `profile-put` to `log` when an upload begins.
        pub(crate) fn logging_to(log: Arc<std::sync::Mutex<Vec<String>>>) -> Arc<Self> {
            Self::build(Some(log))
        }

        fn build(log: Option<Arc<std::sync::Mutex<Vec<String>>>>) -> Arc<Self> {
            Arc::new(Self {
                state: std::sync::Mutex::new(State {
                    version: 0,
                    archive: None,
                    fetch_fails: false,
                    mode: UploadMode::Normal,
                    fetches: 0,
                    uploads_started: 0,
                    uploads_finished: 0,
                }),
                open: watch::channel(true).0,
                log,
            })
        }

        fn state(&self) -> std::sync::MutexGuard<'_, State> {
            self.state.lock().unwrap()
        }

        /// Another writer saved `archive` as `version`.
        pub(crate) fn set_stored(&self, version: i64, archive: Option<Vec<u8>>) {
            let mut state = self.state();
            state.version = version;
            state.archive = archive;
        }

        pub(crate) fn stored(&self) -> (i64, Option<Vec<u8>>) {
            let state = self.state();
            (state.version, state.archive.clone())
        }

        pub(crate) fn set_fetch_fails(&self, fails: bool) {
            self.state().fetch_fails = fails;
        }

        pub(crate) fn set_mode(&self, mode: UploadMode) {
            self.state().mode = mode;
        }

        /// While closed, uploads wait (after they started).
        pub(crate) fn set_open(&self, open: bool) {
            self.open.send_replace(open);
        }

        pub(crate) fn fetches(&self) -> usize {
            self.state().fetches
        }

        pub(crate) fn uploads_started(&self) -> usize {
            self.state().uploads_started
        }

        pub(crate) fn uploads_finished(&self) -> usize {
            self.state().uploads_finished
        }
    }

    impl ProfileStore for FakeStore {
        fn fetch(&self) -> BoxFuture<'_, Result<BrowserProfileSnapshot>> {
            Box::pin(async move {
                let mut state = self.state();
                state.fetches += 1;
                anyhow::ensure!(!state.fetch_fails, "the store is unreachable");
                Ok(BrowserProfileSnapshot {
                    version: state.version,
                    archive: state.archive.clone(),
                })
            })
        }

        fn upload(
            &self,
            body: Vec<u8>,
            expected_version: i64,
        ) -> BoxFuture<'_, std::result::Result<i64, UploadFailure>> {
            Box::pin(async move {
                self.state().uploads_started += 1;
                if let Some(log) = &self.log {
                    log.lock().unwrap().push("profile-put".to_string());
                }
                let mut open = self.open.subscribe();
                let _ = open.wait_for(|open| *open).await;
                let mut state = self.state();
                state.uploads_finished += 1;
                match state.mode {
                    UploadMode::Reject(status) => return Err(UploadFailure::Rejected(status)),
                    UploadMode::UncertainBeforeCommit => {
                        return Err(UploadFailure::Uncertain(anyhow!("connection reset")));
                    }
                    UploadMode::Normal | UploadMode::UncertainAfterCommit => {}
                }
                if state.version != expected_version {
                    return Err(UploadFailure::Conflict);
                }
                state.version += 1;
                state.archive = Some(body);
                if state.mode == UploadMode::UncertainAfterCommit {
                    return Err(UploadFailure::Uncertain(anyhow!("response lost")));
                }
                Ok(state.version)
            })
        }
    }
}

#[cfg(test)]
#[path = "persistence_tests.rs"]
mod tests;
