//! The gateway's mirror cache: one bare repository per space, holding a
//! copy of canonical `main` (and, for a moment at a time, recovery commits
//! a read asked for). It is disposable: deleting any of it, or all of it,
//! only costs a fetch.
//!
//! Layout under `<root>/.git-cache/` (all private to the server, none of it
//! named like a space, so no older gateway image ever treats it as a
//! checkout):
//!
//! - `<space id>.git`: the mirror. `instafy-last-use` in it is touched when
//!   a request lets go of it, for the sweeper.
//! - `.quarantine/`, `.staging/`: per-request scratch for writes.
//! - `.trash/`: mirrors being removed.
//! - `.tmp-<uuid>.git`: a mirror being created, renamed into place when
//!   ready.
//!
//! Fetches of `main` are single-flight per space and run in a task of their
//! own, so a request that stops waiting never stops the fetch. A plain read
//! reuses a fetch that finished in the last two seconds or joins the one in
//! flight; a write joins only a fetch that started after it arrived. A
//! request waits at most ten seconds, a space's first clone included, and
//! is then told to retry (503 `fetch_pending`) while the fetch goes on: no
//! caller (the controller's reads and import checks, a browser's save)
//! waits on the server longer than it waits for the answer. A write with
//! time left asks again ([`super::cas::CachedCanonical`]). A failed fetch
//! is an error, never stale data.
//!
//! A write that pushed a commit moves the mirror's `main` to it at once
//! (after its objects are in), unless a fetch is updating the mirror's refs
//! right then: the next read then fetches instead of reusing that fetch.
//!
//! A mirror damaged on the gateway's disk (a lock a killed git left, an
//! object missing or corrupt, what a full disk left behind) is thrown away
//! and made again: by the fetch that finds it, or, when a read or a write
//! finds it, in the background while that request is told 503
//! `mirror_reset`. Canonical is never touched.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result};
use axum::http::StatusCode;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use tracing::{debug, info, warn};
use uuid::Uuid;

use super::answers::{is_disk_full, or_disk_full};
use super::disk::{ensure_private_dir, modified, remove_entry, rename_no_replace, tree_size};
use super::legacy::LEGACY_DIR;
use crate::config::ServerConfig;
use crate::error::OriginError;
use crate::git_tokens;
use crate::recovery_view::{sweep_stale_fetches, MAIN_REF};
use crate::workspace_git::{failure, WorkspaceGit};

/// The cache's folder under the workspace root.
pub(crate) const CACHE_DIR: &str = ".git-cache";
/// Per-write object quarantines.
pub(crate) const QUARANTINE_DIR: &str = ".quarantine";
/// Per-write upload staging.
pub(crate) const STAGING_DIR: &str = ".staging";
/// Mirrors on their way out.
const TRASH_DIR: &str = ".trash";
/// Mirrors being created.
const TEMP_PREFIX: &str = ".tmp-";
/// Touched in a mirror when a request lets go of it.
const LAST_USE_FILE: &str = "instafy-last-use";
/// The only branch a mirror holds.
const MAIN_FETCH_SPEC: &str = "+refs/heads/main:refs/heads/main";

/// A plain read reuses a fetch that finished this recently.
const COALESCE_WINDOW: Duration = Duration::from_secs(2);
/// How long a request waits for a fetch of a mirror that exists.
pub(crate) const FETCH_WAIT: Duration = Duration::from_secs(10);
/// How long any request waits for a space's first clone: less than every
/// client gives the answer (20 s for the controller's managed-files reads,
/// 30 s for its import status checks and for Files), so they are told
/// `fetch_pending` and retry rather than time out. The clone goes on
/// either way.
pub(crate) const FIRST_CLONE_WAIT: Duration = FETCH_WAIT;
/// A fetch is stopped after this long, waited for or not.
const FETCH_DEADLINE: Duration = Duration::from_secs(300);
/// What `Retry-After` tells a request that stopped waiting.
pub(crate) const RETRY_AFTER_SECONDS: u64 = 2;
/// A cached read credential is replaced this long before it expires.
const TOKEN_REUSE_MARGIN: Duration = Duration::from_secs(60);
/// How often the sweeper runs.
pub(crate) const SWEEP_INTERVAL: Duration = Duration::from_secs(600);
/// Only mirrors unused for longer than this are removed for space.
pub(crate) const EVICT_IDLE_AFTER: Duration = Duration::from_secs(3600);
/// How long diff and review remember a commit a space did not have after a
/// fetch: a chat card asks once per file, and each ask would fetch again.
pub(crate) const MISSING_REV_MEMORY: Duration = Duration::from_secs(30);
/// At most this many such commits are remembered.
const MISSING_REVS_REMEMBERED: usize = 4096;
/// How often the size of `.legacy/` is measured, at most.
const LEGACY_MEASURE_EVERY: Duration = Duration::from_secs(3600);
/// Scratch older than this belongs to a request that is gone.
const SCRATCH_STALE_AFTER: Duration = Duration::from_secs(3600);
/// Below this much free space on the cache's disk the sweeper removes
/// mirrors nobody holds, however recently used, until it has it again.
pub(crate) const MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// About this many loose objects in a mirror, or more packs than
/// [`PACK_LIMIT`], and the sweeper packs it (git's own `gc --auto` limits;
/// git never packs a mirror by itself).
const LOOSE_OBJECT_LIMIT: u64 = 6_700;
const PACK_LIMIT: u64 = 50;
/// A mirror whose packing changed nothing (loose objects git keeps loose:
/// recent ones nothing reaches) is not packed again for this long, as git
/// waits a day after such a `gc --auto`.
const PACK_RETRY_AFTER: Duration = Duration::from_secs(24 * 3600);

/// How fresh a request needs `main` to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Freshness {
    /// Reads: a fetch that finished in the last two seconds, or the one in
    /// flight, will do.
    Coalesced,
    /// Writes: only a fetch that started after the request arrived.
    Fresh,
}

/// Why a fetch did not give a request a current `main`.
#[derive(Clone, Debug)]
enum FetchError {
    /// Canonical could not be read (or no credential to read it).
    Unreachable,
    /// The mirror is damaged on the gateway's own disk (a lock a killed git
    /// left, a corrupt object). It is thrown away and cloned again.
    Broken,
    /// The pack canonical sent could not be indexed. That is canonical's
    /// problem, unless the pack holds deltas against objects of the mirror
    /// (a thin pack) that are damaged: fetched again from scratch, a mirror
    /// that had `main` shows which it was.
    BadPack,
    /// The gateway's disk is full.
    DiskFull,
    /// Something else on the gateway's own disk failed.
    Local(String),
}

impl FetchError {
    fn into_origin(self) -> OriginError {
        match self {
            Self::Unreachable | Self::BadPack => canonical_unreachable(),
            Self::Broken => mirror_reset(),
            Self::DiskFull => disk_full(),
            Self::Local(message) => or_disk_full(OriginError::internal(message)),
        }
    }

    /// A failure on the gateway's own disk: [`Self::DiskFull`] when it
    /// says the disk is full.
    fn local(message: String) -> Self {
        if says_disk_full(&message) {
            Self::DiskFull
        } else {
            Self::Local(message)
        }
    }

    /// Whether the mirror is thrown away and fetched again from scratch:
    /// damaged, or (when it had `main`) a pack that did not index.
    fn remakes(&self, had_main: bool) -> bool {
        matches!(self, Self::Broken) || (had_main && matches!(self, Self::BadPack))
    }
}

/// 503: this space's mirror was damaged on the gateway's disk and is
/// being made again.
pub(crate) fn mirror_reset() -> OriginError {
    OriginError::retry_later(
        "mirror_reset",
        "this space's copy on the server was damaged and is being made again; try again in a \
         moment",
        RETRY_AFTER_SECONDS,
    )
}

/// 503: the gateway's disk is full.
pub(crate) fn disk_full() -> OriginError {
    OriginError::retry_later(
        "disk_full",
        "the server is out of disk space; try again in a moment",
        RETRY_AFTER_SECONDS,
    )
}

/// 502: canonical could not be read; nothing older is served instead.
pub(crate) fn canonical_unreachable() -> OriginError {
    OriginError::with_report(
        StatusCode::BAD_GATEWAY,
        "canonical_unreachable",
        "this space's saved versions could not be reached; try again in a moment",
        serde_json::json!({}),
    )
}

/// Whether `error` is 503 `fetch_pending`.
pub(crate) fn is_fetch_pending(error: &OriginError) -> bool {
    matches!(error, OriginError::RetryLater { code, .. } if *code == "fetch_pending")
}

/// 503: the fetch this request needs is still running.
pub(crate) fn fetch_pending() -> OriginError {
    OriginError::retry_later(
        "fetch_pending",
        "this space's saved versions are still being fetched; try again in a moment",
        RETRY_AFTER_SECONDS,
    )
}

type FetchOutcome = Result<(), FetchError>;
type SharedFetch = Shared<BoxFuture<'static, FetchOutcome>>;

/// A fetch that is running or waiting for the one before it.
struct Pending {
    id: u64,
    /// `None` while it waits for the running fetch to finish.
    started: Option<Instant>,
    fetch: SharedFetch,
}

#[derive(Default)]
struct FetchState {
    running: Option<Pending>,
    /// At most one fetch waits behind the running one; every write that
    /// arrives meanwhile joins it.
    queued: Option<Pending>,
    /// When the last fetch finished, if it succeeded.
    last_success: Option<Instant>,
    /// A write pushed to canonical at this time but could not move the
    /// mirror's `main`: until a fetch that started later runs, every read
    /// waits for one.
    refetch_since: Option<Instant>,
}

/// One space's mirror, as the process tracks it.
pub(crate) struct MirrorEntry {
    project: Uuid,
    /// Requests (and fetches) using the mirror; the sweeper never removes
    /// a mirror in use.
    leases: AtomicUsize,
    fetches: Mutex<FetchState>,
    /// Held while a fetch updates the mirror's refs, and by a write moving
    /// `main` to the commit it pushed, so the two never race on `main`.
    refs: Mutex<()>,
    /// Stale fetch namespaces were swept since this process opened it.
    swept: AtomicBool,
    /// How often a request found it damaged and threw it away: a request
    /// whose git failed after that is told `mirror_reset` too.
    resets: AtomicU64,
}

/// A request's hold on one space's mirror. While any exists the mirror is
/// never removed; letting go records the use (except the sweeper's own
/// hold, which is not a use).
pub(crate) struct MirrorLease {
    entry: Arc<MirrorEntry>,
    dir: PathBuf,
    record_use: bool,
}

impl MirrorLease {
    pub(crate) fn project(&self) -> Uuid {
        self.entry.project
    }

    /// The mirror's bare repository (it may not exist before the first
    /// fetch or [`MirrorCache::ensure_mirror`]).
    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    /// The mirror, for blocking work the request waits for while it holds
    /// this lease.
    pub(crate) fn mirror(&self) -> MirrorRef {
        MirrorRef {
            entry: self.entry.clone(),
        }
    }
}

/// A mirror, as blocking work that runs under a request's
/// [`MirrorLease`] names it.
#[derive(Clone)]
pub(crate) struct MirrorRef {
    entry: Arc<MirrorEntry>,
}

impl MirrorRef {
    /// How often the mirror was found damaged and thrown away so far.
    pub(crate) fn resets(&self) -> u64 {
        self.entry.resets.load(Ordering::SeqCst)
    }
}

impl Drop for MirrorLease {
    fn drop(&mut self) {
        // Record the use before the lease count drops, so the sweeper never
        // sees an unused mirror with an old last use.
        if self.record_use {
            touch(&self.dir.join(LAST_USE_FILE));
        }
        self.entry.leases.fetch_sub(1, Ordering::SeqCst);
    }
}

fn touch(path: &Path) {
    // Only when the mirror exists; nothing is created around it.
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
    {
        let _ = file.set_modified(SystemTime::now());
    }
}

struct CachedToken {
    token: String,
    expires: Instant,
}

/// What the sweeper knows of a mirror's size: measured once and kept until
/// something adds to the mirror (a fetch, a pushed save, a packing), so a
/// sweep walks only the mirrors that changed since the last one.
#[derive(Default)]
struct KnownSize {
    bytes: Option<u64>,
    /// Bumped on every change, so a walk that ran across one is not kept.
    generation: u64,
}

/// The mirror cache of one gateway process.
pub(crate) struct MirrorCache {
    /// `<root>/.git-cache`, absolute.
    root: PathBuf,
    config: Arc<ServerConfig>,
    http: reqwest::Client,
    max_bytes: u64,
    mirrors: Mutex<HashMap<Uuid, Arc<MirrorEntry>>>,
    tokens: Mutex<HashMap<Uuid, CachedToken>>,
    sizes: Mutex<HashMap<Uuid, KnownSize>>,
    /// Commits a space did not have after a fetch, and when that was found.
    missing_revs: Mutex<HashMap<(Uuid, String), Instant>>,
    next_fetch: AtomicU64,
    fetches_started: AtomicU64,
    /// How many sweeps ran (not counting those that found one running).
    sweeps_run: AtomicU64,
    fetch_wait: Duration,
    first_clone_wait: Duration,
    /// When the sweeper packs a mirror: (loose objects, packs).
    pack_limits: (u64, u64),
    /// The free space the sweeper keeps on the cache's disk.
    min_free_bytes: u64,
    /// The free space on the disk of a path (`None`: unknown).
    free_space: Box<dyn Fn(&Path) -> Option<u64> + Send + Sync>,
    /// Held while a sweep evicts: one at a time.
    sweeping: Mutex<()>,
    /// A sweep was asked for while one ran: the running one goes again.
    sweep_again: AtomicBool,
    /// Held while mirrors are packed (outside the sweep's lock).
    packing: Mutex<()>,
    /// Mirrors whose last packing changed nothing, and when that was.
    pack_skipped: Mutex<HashMap<Uuid, Instant>>,
    /// The size of `.legacy/` and when it was measured.
    legacy_bytes: Mutex<Option<(Instant, Option<u64>)>>,
    #[cfg(test)]
    test_packed_while_sweeping: Mutex<Option<bool>>,
    #[cfg(test)]
    pub(crate) test_fetch_delay: Option<Duration>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl MirrorCache {
    /// The cache under `workspace_root` (absolute), made ready to serve:
    /// its folders are created (mode 0700; a link anywhere is refused) and
    /// whatever requests of an earlier process left in its scratch folders
    /// is removed. Blocking.
    pub(crate) fn open(
        workspace_root: &Path,
        config: Arc<ServerConfig>,
        http: reqwest::Client,
        max_bytes: u64,
    ) -> Result<Self> {
        let root = workspace_root.join(CACHE_DIR);
        ensure_private_dir(&root)?;
        for folder in [QUARANTINE_DIR, STAGING_DIR, TRASH_DIR] {
            let path = root.join(folder);
            ensure_private_dir(&path)?;
            clear_folder(&path).with_context(|| format!("failed to clear {path:?}"))?;
        }
        for entry in std::fs::read_dir(&root).with_context(|| format!("failed to list {root:?}"))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(TEMP_PREFIX) {
                remove_entry(&entry.path())
                    .with_context(|| format!("failed to remove {:?}", entry.path()))?;
            } else if mirror_project(&name).is_some() {
                // Nothing runs git in a mirror before the server does: any
                // lock in one was left by a git that was killed (out of
                // memory, a stop that ran out of time), and would refuse
                // every fetch of that space.
                let removed = remove_stale_locks(&entry.path());
                if removed > 0 {
                    info!(mirror = %name, removed, "removed locks a stopped git left in a mirror");
                }
            }
        }
        Ok(Self {
            root,
            config,
            http,
            max_bytes,
            mirrors: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            sizes: Mutex::new(HashMap::new()),
            missing_revs: Mutex::new(HashMap::new()),
            next_fetch: AtomicU64::new(1),
            fetches_started: AtomicU64::new(0),
            sweeps_run: AtomicU64::new(0),
            fetch_wait: FETCH_WAIT,
            first_clone_wait: FIRST_CLONE_WAIT,
            pack_limits: (LOOSE_OBJECT_LIMIT, PACK_LIMIT),
            min_free_bytes: MIN_FREE_BYTES,
            // Tests see no disk pressure unless they ask for it.
            #[cfg(not(test))]
            free_space: Box::new(free_bytes),
            #[cfg(test)]
            free_space: Box::new(|_| None),
            sweeping: Mutex::new(()),
            sweep_again: AtomicBool::new(false),
            packing: Mutex::new(()),
            pack_skipped: Mutex::new(HashMap::new()),
            legacy_bytes: Mutex::new(None),
            #[cfg(test)]
            test_packed_while_sweeping: Mutex::new(None),
            #[cfg(test)]
            test_fetch_delay: None,
        })
    }

    /// The free space the sweeper keeps and how it is measured, for tests.
    #[cfg(test)]
    pub(crate) fn with_free_space(
        mut self,
        min_free_bytes: u64,
        free_space: impl Fn(&Path) -> Option<u64> + Send + Sync + 'static,
    ) -> Self {
        self.min_free_bytes = min_free_bytes;
        self.free_space = Box::new(free_space);
        self
    }

    /// Lower packing limits, for tests.
    #[cfg(test)]
    pub(crate) fn with_pack_limits(mut self, loose_objects: u64, packs: u64) -> Self {
        self.pack_limits = (loose_objects, packs);
        self
    }

    /// Shorter waits, for tests.
    #[cfg(test)]
    pub(crate) fn with_waits(mut self, fetch_wait: Duration, first_clone_wait: Duration) -> Self {
        self.fetch_wait = fetch_wait;
        self.first_clone_wait = first_clone_wait;
        self
    }

    /// The cache's folder.
    #[cfg(test)]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// How many fetches of `main` this process started.
    #[cfg(test)]
    pub(crate) fn fetches_started(&self) -> u64 {
        self.fetches_started.load(Ordering::SeqCst)
    }

    /// How many mirrors' sizes the sweeper keeps.
    #[cfg(test)]
    pub(crate) fn known_sizes(&self) -> usize {
        locked(&self.sizes).len()
    }

    /// How many sweeps ran.
    #[cfg(test)]
    pub(crate) fn sweeps_run(&self) -> u64 {
        self.sweeps_run.load(Ordering::SeqCst)
    }

    /// Hold a mirror's ref lock, as a running fetch does.
    #[cfg(test)]
    pub(crate) fn hold_refs(lease: &MirrorLease) -> MutexGuard<'_, ()> {
        locked(&lease.entry.refs)
    }

    fn mirror_dir(&self, project: Uuid) -> PathBuf {
        self.root.join(format!("{}.git", project.as_hyphenated()))
    }

    /// Where writes make their object quarantines (absolute), created
    /// again when someone removed it.
    pub(crate) fn quarantine_dir(&self) -> Result<PathBuf, OriginError> {
        self.scratch_dir(QUARANTINE_DIR)
    }

    /// Where writes stage the files of an upload (absolute), created again
    /// when someone removed it.
    pub(crate) fn staging_dir(&self) -> Result<PathBuf, OriginError> {
        self.scratch_dir(STAGING_DIR)
    }

    fn scratch_dir(&self, name: &str) -> Result<PathBuf, OriginError> {
        let path = self.root.join(name);
        ensure_private_dir(&self.root)
            .and_then(|()| ensure_private_dir(&path))
            .map_err(|error| OriginError::internal(format!("{error:#}")))?;
        Ok(path)
    }

    /// The canonical repository of `project`.
    pub(crate) fn remote_url(&self, project: Uuid) -> Result<String, OriginError> {
        self.config
            .git_remote_url_for_project(project)
            .ok_or_else(|| OriginError::internal("the gateway has no canonical base URL"))
    }

    /// Hold `project`'s mirror for the length of a request.
    pub(crate) fn lease(&self, project: Uuid) -> MirrorLease {
        self.hold(project, true)
    }

    /// Hold `project`'s mirror; letting go records a use when `record_use`.
    fn hold(&self, project: Uuid, record_use: bool) -> MirrorLease {
        let mut mirrors = locked(&self.mirrors);
        let entry = mirrors
            .entry(project)
            .or_insert_with(|| {
                Arc::new(MirrorEntry {
                    project,
                    leases: AtomicUsize::new(0),
                    fetches: Mutex::new(FetchState::default()),
                    refs: Mutex::new(()),
                    swept: AtomicBool::new(false),
                    resets: AtomicU64::new(0),
                })
            })
            .clone();
        entry.leases.fetch_add(1, Ordering::SeqCst);
        MirrorLease {
            dir: self.mirror_dir(project),
            entry,
            record_use,
        }
    }

    /// `main` of the space as canonical has it, as fresh as `freshness`
    /// asks: `None` when canonical has no `main` yet (an empty space).
    /// The answer is read from the mirror after the fetch, so a write the
    /// gateway pushed and moved in meanwhile is included.
    pub(crate) async fn resolve_main(
        self: &Arc<Self>,
        lease: &MirrorLease,
        freshness: Freshness,
        caller_token: Option<&str>,
    ) -> Result<Option<String>, OriginError> {
        self.resolve_main_since(lease, freshness, caller_token, Instant::now())
            .await
    }

    /// [`Self::resolve_main`] for a request that arrived at `arrived`: a
    /// `Fresh` answer comes from a fetch that started no earlier. A caller
    /// that asks again after `fetch_pending` passes its first arrival, so
    /// it joins the fetch it waited for instead of queueing a new one.
    pub(crate) async fn resolve_main_since(
        self: &Arc<Self>,
        lease: &MirrorLease,
        freshness: Freshness,
        caller_token: Option<&str>,
        arrived: Instant,
    ) -> Result<Option<String>, OriginError> {
        let first_clone = std::fs::symlink_metadata(lease.dir()).is_err();
        let wait = if first_clone {
            self.first_clone_wait
        } else {
            self.fetch_wait
        };
        let fetch = {
            let mut state = locked(&lease.entry.fetches);
            match (freshness, state.refetch_since) {
                // A write pushed a commit the mirror may not show yet: only
                // a fetch that started after that push will do.
                (Freshness::Coalesced, Some(since)) => {
                    Some(self.fresh_fetch(&lease.entry, &mut state, since, caller_token))
                }
                (Freshness::Coalesced, None) => {
                    // A recent fetch counts only while its mirror is there.
                    let recent = state
                        .last_success
                        .is_some_and(|finished| finished.elapsed() < COALESCE_WINDOW)
                        && std::fs::symlink_metadata(lease.dir()).is_ok();
                    if recent {
                        None
                    } else if let Some(pending) = state.running.as_ref().or(state.queued.as_ref()) {
                        // A queued fetch is about to start: two fetches
                        // into one mirror would fight over its refs.
                        Some(pending.fetch.clone())
                    } else {
                        Some(self.start_fetch(&lease.entry, &mut state, None, caller_token))
                    }
                }
                (Freshness::Fresh, _) => {
                    Some(self.fresh_fetch(&lease.entry, &mut state, arrived, caller_token))
                }
            }
        };
        if let Some(fetch) = fetch {
            match tokio::time::timeout(wait, fetch).await {
                Ok(outcome) => outcome.map_err(FetchError::into_origin)?,
                Err(_) => return Err(fetch_pending()),
            }
        }
        let dir = lease.dir().to_path_buf();
        tokio::task::spawn_blocking(move || {
            WorkspaceGit::bare(&dir, None)
                .commit_id(MAIN_REF)
                .map_err(|error| OriginError::internal(format!("failed to read main: {error}")))
        })
        .await
        .map_err(|error| OriginError::internal(format!("main read task failed: {error}")))?
    }

    /// A fetch that starts no earlier than `since`: the running one if it
    /// started since (so a caller that asks again after `fetch_pending`
    /// keeps waiting for the fetch it waited for, not one a later request
    /// queued behind it), else the queued one, else a new one (queued
    /// behind the running fetch, if any).
    fn fresh_fetch(
        self: &Arc<Self>,
        entry: &Arc<MirrorEntry>,
        state: &mut FetchState,
        since: Instant,
        caller_token: Option<&str>,
    ) -> SharedFetch {
        if let Some(running) = state
            .running
            .as_ref()
            .filter(|running| running.started.is_some_and(|at| at >= since))
        {
            return running.fetch.clone();
        }
        if let Some(queued) = &state.queued {
            return queued.fetch.clone();
        }
        let before = state.running.as_ref().map(|running| running.fetch.clone());
        self.start_fetch(entry, state, before, caller_token)
    }

    /// Start a fetch of `main` in a task of its own, after `before` when
    /// another fetch is still running. The task holds a lease, so the
    /// mirror stays while it runs.
    fn start_fetch(
        self: &Arc<Self>,
        entry: &Arc<MirrorEntry>,
        state: &mut FetchState,
        before: Option<SharedFetch>,
        caller_token: Option<&str>,
    ) -> SharedFetch {
        let id = self.next_fetch.fetch_add(1, Ordering::SeqCst);
        // The caller holds a lease on `entry`, so the sweeper cannot be
        // removing it while this one is added.
        entry.leases.fetch_add(1, Ordering::SeqCst);
        let guard = MirrorLease {
            entry: entry.clone(),
            dir: self.mirror_dir(entry.project),
            record_use: true,
        };
        let queued = before.is_some();
        let cache = self.clone();
        let caller_token = caller_token.map(str::to_string);
        let task = tokio::spawn(async move {
            if let Some(before) = before {
                let _ = before.await;
            }
            cache.fetch_started(&guard.entry, id);
            let outcome = cache.fetch_main(&guard, caller_token).await;
            cache.fetch_finished(&guard.entry, id, &outcome);
            if matches!(outcome, Err(FetchError::DiskFull)) {
                cache.request_sweep();
            }
            drop(guard);
            outcome
        });
        let fetch = async move {
            task.await.unwrap_or_else(|error| {
                Err(FetchError::Local(format!(
                    "the fetch task stopped: {error}"
                )))
            })
        }
        .boxed()
        .shared();
        let pending = Pending {
            id,
            started: (!queued).then(Instant::now),
            fetch: fetch.clone(),
        };
        if queued {
            state.queued = Some(pending);
        } else {
            state.running = Some(pending);
        }
        fetch
    }

    fn fetch_started(&self, entry: &MirrorEntry, id: u64) {
        self.fetches_started.fetch_add(1, Ordering::SeqCst);
        let mut state = locked(&entry.fetches);
        // This fetch reads canonical after every push recorded so far.
        let now = Instant::now();
        if state.refetch_since.is_some_and(|since| since <= now) {
            state.refetch_since = None;
        }
        if state.queued.as_ref().is_some_and(|queued| queued.id == id) {
            let mut pending = state.queued.take().expect("checked above");
            pending.started = Some(Instant::now());
            state.running = Some(pending);
        }
    }

    fn fetch_finished(&self, entry: &MirrorEntry, id: u64, outcome: &FetchOutcome) {
        self.size_changed(entry.project);
        let mut state = locked(&entry.fetches);
        if state
            .running
            .as_ref()
            .is_some_and(|running| running.id == id)
        {
            state.running = None;
        }
        state.last_success = outcome.is_ok().then(Instant::now);
    }

    async fn fetch_main(
        self: &Arc<Self>,
        guard: &MirrorLease,
        caller_token: Option<String>,
    ) -> FetchOutcome {
        #[cfg(test)]
        if let Some(delay) = self.test_fetch_delay {
            tokio::time::sleep(delay).await;
        }
        let project = guard.project();
        let token = self.read_token(project, caller_token.as_deref()).await?;
        let url = self
            .remote_url(project)
            .map_err(|error| FetchError::Local(error.to_string()))?;
        let cache = self.clone();
        let entry = guard.entry.clone();
        tokio::task::spawn_blocking(move || {
            let dir = cache.open_mirror(&entry)?;
            let _refs = locked(&entry.refs);
            let had_main = !matches!(WorkspaceGit::bare(&dir, None).commit_id(MAIN_REF), Ok(None));
            match fetch_main_into(&dir, &url, token.as_deref(), project) {
                Err(failure)
                    if failure.remakes(had_main) || matches!(failure, FetchError::DiskFull) =>
                {
                    // The mirror is only a copy: throw it away. A damaged
                    // one is made again at once; on a full disk that would
                    // fail again, so the next request makes it.
                    if let Err(error) = cache.discard(&dir) {
                        warn!(%project, %error, "could not throw away a damaged mirror");
                        return Err(failure);
                    }
                    warn!(%project, ?failure, "threw away a mirror the gateway's disk broke");
                    entry.resets.fetch_add(1, Ordering::SeqCst);
                    if matches!(failure, FetchError::DiskFull) {
                        return Err(failure);
                    }
                    let dir = cache.open_mirror(&entry)?;
                    match fetch_main_into(&dir, &url, token.as_deref(), project) {
                        // Fetched from scratch, a pack that does not index
                        // is canonical's.
                        Err(FetchError::BadPack) => Err(FetchError::Unreachable),
                        outcome => outcome,
                    }
                }
                outcome => outcome,
            }
        })
        .await
        .unwrap_or_else(|error| Err(FetchError::Local(format!("the fetch stopped: {error}"))))
    }

    /// A `git.read` credential for `project`'s canonical repository, reused
    /// until shortly before it expires. `None` when there is nothing to mint
    /// one with (local development without auth).
    pub(crate) async fn read_token(
        &self,
        project: Uuid,
        caller_token: Option<&str>,
    ) -> Result<Option<String>, FetchErrorPublic> {
        if let Some(cached) = locked(&self.tokens).get(&project) {
            if cached.expires > Instant::now() + TOKEN_REUSE_MARGIN {
                return Ok(Some(cached.token.clone()));
            }
        }
        let caller_token = caller_token
            .map(str::trim)
            .filter(|token| !token.is_empty());
        match git_tokens::mint_git_access_token(
            &self.http,
            &self.config,
            project,
            &["git.read"],
            caller_token,
        )
        .await
        {
            Ok(Some(minted)) => {
                let lifetime = Duration::from_secs(u64::try_from(minted.expires_in).unwrap_or(0));
                locked(&self.tokens).insert(
                    project,
                    CachedToken {
                        token: minted.token.clone(),
                        expires: Instant::now() + lifetime,
                    },
                );
                Ok(Some(minted.token))
            }
            Ok(None) => Ok(None),
            Err(error) => {
                warn!(%project, %error, "no read credential for the canonical repository");
                Err(FetchErrorPublic(FetchError::Unreachable))
            }
        }
    }

    /// A `git.write` credential for `project`, exchanged from the caller's
    /// own `fs.write` token (never the gateway's machine credential), with
    /// its lifetime. `None` when the server needs none (local development
    /// without auth and no caller token).
    pub(crate) async fn write_token(
        &self,
        project: Uuid,
        caller_token: Option<&str>,
    ) -> Result<Option<(String, Duration)>, OriginError> {
        let caller_token = caller_token
            .map(str::trim)
            .filter(|token| !token.is_empty());
        if self.config.skip_auth && caller_token.is_none() {
            return Ok(None);
        }
        Ok(git_tokens::mint_git_access_token(
            &self.http,
            &self.config,
            project,
            &["git.read", "git.write"],
            caller_token,
        )
        .await?
        .map(|minted| {
            let lifetime = Duration::from_secs(u64::try_from(minted.expires_in).unwrap_or(0));
            (minted.token, lifetime)
        }))
    }

    /// After a write pushed `commit` (on top of `old`, `None` for a new
    /// `main`) to canonical: move the mirror's `main` to it, so reads show
    /// the save without a fetch. Only when the commit's objects were moved
    /// into the mirror (`promoted`) and no fetch is updating the mirror's
    /// refs right now; otherwise reads fetch first until a fetch that
    /// started after this call has run. Blocking; never fails the write.
    pub(crate) fn record_push(
        &self,
        mirror: &MirrorRef,
        commit: &str,
        old: Option<&str>,
        promoted: bool,
    ) {
        let entry = &mirror.entry;
        self.size_changed(entry.project);
        if promoted {
            let refs = match entry.refs.try_lock() {
                Ok(guard) => Some(guard),
                Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
                Err(TryLockError::WouldBlock) => None,
            };
            if let Some(_refs) = refs {
                let dir = self.mirror_dir(entry.project);
                match WorkspaceGit::bare(&dir, None).update_ref(
                    MAIN_REF,
                    commit,
                    old,
                    "instafy: pushed",
                ) {
                    Ok(()) => return,
                    Err(error) => debug!(
                        project = %entry.project,
                        error = %format!("{error:#}"),
                        "the mirror's main moved meanwhile; the next read fetches"
                    ),
                }
            }
        }
        locked(&entry.fetches).refetch_since = Some(Instant::now());
    }

    /// Whether `rev` was found missing from `project` after a fetch less
    /// than [`MISSING_REV_MEMORY`] ago.
    pub(crate) fn recently_missing(&self, project: Uuid, rev: &str) -> bool {
        locked(&self.missing_revs)
            .get(&(project, rev.to_string()))
            .is_some_and(|found| found.elapsed() < MISSING_REV_MEMORY)
    }

    /// `rev` is not in `project` after a fetch: remember it for a while.
    pub(crate) fn note_missing(&self, project: Uuid, rev: &str) {
        let mut missing = locked(&self.missing_revs);
        if missing.len() >= MISSING_REVS_REMEMBERED {
            missing.retain(|_, found| found.elapsed() < MISSING_REV_MEMORY);
            if missing.len() >= MISSING_REVS_REMEMBERED {
                missing.clear();
            }
        }
        missing.insert((project, rev.to_string()), Instant::now());
    }

    /// Something may have added to (or removed) `project`'s mirror: the
    /// next sweep measures it again.
    pub(crate) fn size_changed(&self, project: Uuid) {
        let mut sizes = locked(&self.sizes);
        let known = sizes.entry(project).or_default();
        known.bytes = None;
        known.generation = known.generation.wrapping_add(1);
    }

    /// What the sweeper keeps about `project`'s mirror, once it is gone.
    fn forget(&self, project: Uuid) {
        locked(&self.sizes).remove(&project);
        locked(&self.pack_skipped).remove(&project);
    }

    /// `project`'s mirror at `path`: the size kept since it last changed,
    /// or measured now.
    fn mirror_size(&self, project: Uuid, path: &Path) -> u64 {
        let generation = {
            let mut sizes = locked(&self.sizes);
            let known = sizes.entry(project).or_default();
            if let Some(bytes) = known.bytes {
                return bytes;
            }
            known.generation
        };
        let bytes = tree_size(path);
        let mut sizes = locked(&self.sizes);
        let known = sizes.entry(project).or_default();
        if known.generation == generation {
            known.bytes = Some(bytes);
        }
        bytes
    }

    /// `result` of git work on `mirror` that started when the mirror had
    /// been thrown away `resets_before` times: a failure that says the
    /// mirror is damaged on this server's disk throws it away and makes it
    /// again in the background ([`Self::reset_mirror`]), and is answered
    /// 503 `mirror_reset`, as is any failure of work whose mirror was thrown
    /// away meanwhile. Blocking.
    pub(crate) fn checked<T>(
        self: &Arc<Self>,
        mirror: &MirrorRef,
        resets_before: u64,
        caller_token: Option<&str>,
        result: Result<T, OriginError>,
    ) -> Result<T, OriginError> {
        let error = match result {
            Ok(value) => return Ok(value),
            Err(error) => or_disk_full(error),
        };
        if is_disk_full(&error) {
            self.request_sweep();
            return Err(error);
        }
        let damaged = match &error {
            OriginError::Internal(message) => says_mirror_damaged(message),
            _ => false,
        };
        if damaged {
            warn!(project = %mirror.entry.project, %error, "a mirror is damaged on this server's disk");
            self.reset_mirror(mirror, caller_token);
            return Err(mirror_reset());
        }
        if matches!(error, OriginError::Internal(_)) && mirror.resets() != resets_before {
            return Err(mirror_reset());
        }
        Err(error)
    }

    /// Throw `mirror` away (damaged on this server's disk) and start making
    /// it again in the background. Not while a fetch updates it: that fetch
    /// finds the damage and makes it again itself. Blocking.
    fn reset_mirror(self: &Arc<Self>, mirror: &MirrorRef, caller_token: Option<&str>) {
        let entry = &mirror.entry;
        {
            let _refs = match entry.refs.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
                Err(TryLockError::WouldBlock) => return,
            };
            let dir = self.mirror_dir(entry.project);
            if let Err(error) = self.discard(&dir) {
                warn!(project = %entry.project, %error, "could not throw away a damaged mirror");
                return;
            }
            entry.resets.fetch_add(1, Ordering::SeqCst);
        }
        warn!(project = %entry.project, "threw away a damaged mirror; making it again");
        self.size_changed(entry.project);
        let mut state = locked(&entry.fetches);
        state.last_success = None;
        if state.running.is_none() && state.queued.is_none() {
            // The request holds a lease on `entry`; the fetch runs in a
            // task of its own whether or not anyone waits for it.
            let _ = self.start_fetch(entry, &mut state, None, caller_token);
        }
    }

    /// The mirror's bare repository, created empty when missing. Blocking.
    pub(crate) fn ensure_mirror(&self, mirror: &MirrorRef) -> Result<PathBuf, OriginError> {
        self.open_mirror(&mirror.entry)
            .map_err(FetchError::into_origin)
    }

    fn open_mirror(&self, entry: &MirrorEntry) -> Result<PathBuf, FetchError> {
        let dir = self.mirror_dir(entry.project);
        let local = |error: anyhow::Error| FetchError::local(format!("{error:#}"));
        match std::fs::symlink_metadata(&dir) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                // Never written by the server: throw it away.
                self.discard(&dir).map_err(|error| local(error.into()))?;
                self.create_mirror(&dir).map_err(local)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.create_mirror(&dir).map_err(local)?;
            }
            Err(error) => return Err(local(error.into())),
        }
        if !entry.swept.swap(true, Ordering::SeqCst) {
            // Fetch namespaces of calls an earlier process did not finish.
            let removed = sweep_stale_fetches(&WorkspaceGit::bare(&dir, None));
            if removed > 0 {
                info!(project = %entry.project, removed, "removed stale fetch refs from a mirror");
            }
        }
        Ok(dir)
    }

    /// Create an empty mirror at `dir`: initialised under a temporary name
    /// and renamed into place, so a half-made mirror is never used. When
    /// another request made it first, theirs is kept.
    fn create_mirror(&self, dir: &Path) -> Result<()> {
        // The whole cache may have been removed while the server runs.
        ensure_private_dir(&self.root)?;
        let temp = self.root.join(format!(
            "{TEMP_PREFIX}{}.git",
            Uuid::new_v4().as_hyphenated()
        ));
        let made = WorkspaceGit::init_bare(&temp)
            .and_then(|()| rename_no_replace(&temp, dir).map_err(anyhow::Error::from));
        match made {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = remove_entry(&temp);
                let raced = error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::AlreadyExists);
                if raced {
                    Ok(())
                } else {
                    Err(error.context(format!("failed to create the mirror {dir:?}")))
                }
            }
        }
    }

    /// Move `path` to the trash and remove it.
    fn discard(&self, path: &Path) -> io::Result<()> {
        let trash = self.root.join(TRASH_DIR).join(format!(
            "{}-{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            Uuid::new_v4().simple()
        ));
        rename_no_replace(path, &trash)?;
        remove_entry(&trash)
    }

    /// Sweep now, off the request (the disk filled up): unless a sweep is
    /// running already. Needs a runtime.
    pub(crate) fn request_sweep(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let cache = self.clone();
        runtime.spawn_blocking(move || {
            let report = cache.sweep(SystemTime::now());
            if report.ran {
                info!(
                    evicted = report.evicted.len(),
                    bytes = report.total_bytes,
                    "swept the mirror cache after the disk filled up"
                );
            }
        });
    }

    /// Run [`Self::sweep`] every [`SWEEP_INTERVAL`].
    pub(crate) fn spawn_sweeper(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let cache = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval_at(
                tokio::time::Instant::now() + SWEEP_INTERVAL,
                SWEEP_INTERVAL,
            );
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let cache = cache.clone();
                match tokio::task::spawn_blocking(move || cache.sweep(SystemTime::now())).await {
                    Ok(report) => {
                        if !report.evicted.is_empty() {
                            info!(
                                evicted = report.evicted.len(),
                                bytes = report.total_bytes,
                                "removed unused mirrors to stay under the cache cap"
                            );
                        }
                        if !report.packed.is_empty() {
                            info!(packed = report.packed.len(), "packed mirrors");
                        }
                    }
                    Err(error) => warn!(%error, "the cache sweep failed"),
                }
            }
        })
    }

    /// Housekeeping, blocking: remove scratch older than an hour and the
    /// trash, forget expired credentials, and, while the mirrors together
    /// are over the cap, remove the least recently used mirror that nobody
    /// has used for an hour and nobody holds. The cap is soft: mirrors in
    /// use are never removed for it. Below [`MIN_FREE_BYTES`] free on the
    /// cache's disk, mirrors nobody holds are removed however recent. Then
    /// mirrors over git's packing limits are packed, outside the sweep's
    /// lock (packing a large mirror takes minutes).
    ///
    /// One sweep at a time: a sweep asked for while one runs (a write that
    /// found the disk full) makes the running one go over the cache again
    /// when it is done, and is itself `ran: false`.
    pub(crate) fn sweep(&self, now: SystemTime) -> SweepReport {
        let mut report = SweepReport::default();
        let mut stats: Vec<MirrorStat>;
        loop {
            let Ok(sweeping) = self.sweeping.try_lock() else {
                self.sweep_again.store(true, Ordering::SeqCst);
                return report;
            };
            self.sweep_again.store(false, Ordering::SeqCst);
            let now = if report.ran { SystemTime::now() } else { now };
            stats = self.sweep_once(now, &mut report);
            report.ran = true;
            drop(sweeping);
            if !self.sweep_again.load(Ordering::SeqCst) {
                break;
            }
        }
        // One mirror at a time, the ones that crossed git's own limits.
        if let Ok(_packing) = self.packing.try_lock() {
            for stat in &stats {
                if !report.evicted.contains(&stat.project) && self.pack_mirror(stat.project) {
                    report.packed.push(stat.project);
                }
            }
        }
        report
    }

    /// One pass of [`Self::sweep`] under its lock: what it removed goes into
    /// `report`; returns what it knew of each mirror.
    fn sweep_once(&self, now: SystemTime, report: &mut SweepReport) -> Vec<MirrorStat> {
        self.sweeps_run.fetch_add(1, Ordering::SeqCst);
        for folder in [QUARANTINE_DIR, STAGING_DIR] {
            remove_older_than(&self.root.join(folder), now, SCRATCH_STALE_AFTER);
        }
        let _ = clear_folder(&self.root.join(TRASH_DIR));
        if let Ok(entries) = std::fs::read_dir(&self.root) {
            for entry in entries.flatten() {
                let stale = modified(&entry.path())
                    .and_then(|at| now.duration_since(at).ok())
                    .is_some_and(|age| age > SCRATCH_STALE_AFTER);
                if stale && entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
                    let _ = remove_entry(&entry.path());
                }
            }
        }
        let live = Instant::now() + TOKEN_REUSE_MARGIN;
        locked(&self.tokens).retain(|_, cached| cached.expires > live);
        locked(&self.missing_revs).retain(|_, found| found.elapsed() < MISSING_REV_MEMORY);

        let stats = self.mirror_stats();
        // What is kept per space goes with its mirror (one removed behind
        // the server's back, or never made).
        let on_disk: std::collections::HashSet<Uuid> =
            stats.iter().map(|stat| stat.project).collect();
        locked(&self.sizes).retain(|project, _| on_disk.contains(project));
        locked(&self.pack_skipped).retain(|project, _| on_disk.contains(project));
        let total_bytes = stats
            .iter()
            .fold(0u64, |total, stat| total.saturating_add(stat.bytes));
        if !report.ran {
            report.total_bytes = total_bytes;
        }
        let mut evicted = Vec::new();
        for project in plan_eviction(&stats, self.max_bytes, now) {
            if self.evict(project, now, true) {
                evicted.push(project);
            }
        }
        // A disk short of space (the cache shares it with `.legacy/` and
        // anything else): mirrors nobody holds go, least recently used
        // first, however recently used. Deleting one only costs a fetch.
        // `.legacy/` (working copies of the old gateway, kept for salvage)
        // is never touched; its size is reported.
        if let Some(free) = (self.free_space)(&self.root).filter(|free| *free < self.min_free_bytes)
        {
            let left: Vec<MirrorStat> = stats
                .iter()
                .filter(|stat| !evicted.contains(&stat.project))
                .cloned()
                .collect();
            let mut freed = 0;
            for project in plan_space_eviction(&left, self.min_free_bytes - free) {
                if self.evict(project, now, false) {
                    freed += 1;
                    evicted.push(project);
                }
            }
            let legacy_bytes = self.legacy_size();
            report.legacy_bytes = legacy_bytes;
            warn!(
                free,
                floor = self.min_free_bytes,
                removed = freed,
                legacy_bytes,
                "the mirror cache's disk is low on space; removed mirrors nobody holds \
                 (.legacy/ is kept)"
            );
        }
        let kept: u64 = stats
            .iter()
            .filter(|stat| !evicted.contains(&stat.project))
            .fold(0u64, |total, stat| total.saturating_add(stat.bytes));
        if kept > self.max_bytes {
            warn!(
                mirrors = stats.len() - evicted.len(),
                bytes = kept,
                cap = self.max_bytes,
                "the mirror cache stays over its cap: the rest is in use or used within the hour"
            );
        }
        report.evicted.extend(evicted);
        stats
    }

    /// The size of `.legacy/` next to the cache, measured at most once an
    /// hour (`None`: there is none).
    fn legacy_size(&self) -> Option<u64> {
        let mut known = locked(&self.legacy_bytes);
        if let Some((measured, bytes)) = *known {
            if measured.elapsed() < LEGACY_MEASURE_EVERY {
                return bytes;
            }
        }
        let legacy = self.root.parent().map(|root| root.join(LEGACY_DIR));
        let bytes = legacy
            .filter(|legacy| {
                std::fs::symlink_metadata(legacy).is_ok_and(|metadata| metadata.is_dir())
            })
            .map(|legacy| tree_size(&legacy));
        *known = Some((Instant::now(), bytes));
        bytes
    }

    /// Whether `project`'s mirror is left unpacked for now (its last
    /// packing changed nothing).
    #[cfg(test)]
    pub(crate) fn pack_skipped(&self, project: Uuid) -> bool {
        locked(&self.pack_skipped)
            .get(&project)
            .is_some_and(|at| at.elapsed() < PACK_RETRY_AFTER)
    }

    /// Whether the last packing ran while a sweep held its lock.
    #[cfg(test)]
    pub(crate) fn packed_while_sweeping(&self) -> Option<bool> {
        *locked(&self.test_packed_while_sweeping)
    }

    /// Pack `project`'s mirror when it holds about [`LOOSE_OBJECT_LIMIT`]
    /// loose objects or more than [`PACK_LIMIT`] packs, as `git gc --auto`
    /// would, but here: in the foreground, held against eviction, and one
    /// mirror at a time. Refs are left as they are (fetches move them
    /// meanwhile), and no commit-graph is written. A packing that changed
    /// nothing is not counted, and the mirror is left alone for
    /// [`PACK_RETRY_AFTER`]. Blocking; whether it packed anything.
    fn pack_mirror(&self, project: Uuid) -> bool {
        let (loose_limit, pack_limit) = self.pack_limits;
        if locked(&self.pack_skipped)
            .get(&project)
            .is_some_and(|at| at.elapsed() < PACK_RETRY_AFTER)
        {
            return false;
        }
        let held = self.hold(project, false);
        let dir = held.dir().to_path_buf();
        let before = packing_state(&dir);
        if !before.needs_packing(loose_limit, pack_limit) {
            return false;
        }
        // git reads both as an `int`; 0 would turn `gc --auto` off.
        let auto = format!("gc.auto={}", loose_limit.clamp(1, i32::MAX as u64));
        let packs = format!("gc.autoPackLimit={}", pack_limit.clamp(1, i32::MAX as u64));
        let args = [
            "-c",
            auto.as_str(),
            "-c",
            packs.as_str(),
            "-c",
            "gc.autoDetach=false",
            "-c",
            "gc.packRefs=false",
            "-c",
            "gc.writeCommitGraph=false",
            "gc",
            "--auto",
            "--quiet",
        ];
        #[cfg(test)]
        {
            *locked(&self.test_packed_while_sweeping) = Some(self.sweeping.try_lock().is_err());
        }
        let ran = WorkspaceGit::bare(&dir, None).run(&args);
        match &ran {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                warn!(%project, error = %failure(&args, &output), "packing a mirror failed");
            }
            Err(error) => {
                warn!(%project, error = %format!("{error:#}"), "packing a mirror failed");
            }
        }
        let after = packing_state(&dir);
        if after.needs_packing(loose_limit, pack_limit) {
            info!(
                %project,
                "a mirror keeps loose objects git does not pack; packing it again in a day"
            );
            locked(&self.pack_skipped).insert(project, Instant::now());
        }
        if after == before {
            return false;
        }
        self.size_changed(project);
        info!(%project, "packed a mirror");
        true
    }

    /// Size, last use and holders of every mirror on disk.
    fn mirror_stats(&self) -> Vec<MirrorStat> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut stats = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(project) = mirror_project(&name) else {
                continue;
            };
            let path = entry.path();
            let is_dir = std::fs::symlink_metadata(&path)
                .map(|metadata| metadata.file_type().is_dir())
                .unwrap_or(false);
            if !is_dir {
                continue;
            }
            let last_use = modified(&path.join(LAST_USE_FILE))
                .or_else(|| modified(&path))
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let leases = locked(&self.mirrors)
                .get(&project)
                .map_or(0, |entry| entry.leases.load(Ordering::SeqCst));
            stats.push(MirrorStat {
                project,
                bytes: self.mirror_size(project, &path),
                last_use,
                leases,
            });
        }
        stats
    }

    /// Remove `project`'s mirror if nobody holds it and (when `idle_only`)
    /// nobody used it for [`EVICT_IDLE_AFTER`]. Checked and moved to the
    /// trash under the mirrors lock, which every new lease takes, so a
    /// request either holds the old mirror (and it stays) or starts on a
    /// fresh one.
    fn evict(&self, project: Uuid, now: SystemTime, idle_only: bool) -> bool {
        let dir = self.mirror_dir(project);
        let trash = self.root.join(TRASH_DIR).join(format!(
            "{}-{}",
            project.as_hyphenated(),
            Uuid::new_v4().simple()
        ));
        {
            let mut mirrors = locked(&self.mirrors);
            if mirrors
                .get(&project)
                .is_some_and(|entry| entry.leases.load(Ordering::SeqCst) > 0)
            {
                return false;
            }
            let idle = modified(&dir.join(LAST_USE_FILE))
                .or_else(|| modified(&dir))
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > EVICT_IDLE_AFTER);
            if idle_only && !idle {
                return false;
            }
            if rename_no_replace(&dir, &trash).is_err() {
                return false;
            }
            mirrors.remove(&project);
        }
        self.forget(project);
        if let Err(error) = remove_entry(&trash) {
            warn!(%project, %error, "could not delete a removed mirror; the next sweep retries");
        }
        true
    }
}

/// [`FetchError`] for callers outside this module (the reads mint the same
/// credential for `?ref=` fetches).
#[derive(Debug)]
pub(crate) struct FetchErrorPublic(FetchError);

impl From<FetchErrorPublic> for OriginError {
    fn from(error: FetchErrorPublic) -> Self {
        error.0.into_origin()
    }
}

impl From<FetchErrorPublic> for FetchError {
    fn from(error: FetchErrorPublic) -> Self {
        error.0
    }
}

/// Fetch canonical `main` into the mirror at `dir`. A canonical repository
/// without `main` (a new space) empties the mirror's `main`. Blocking.
fn fetch_main_into(
    dir: &Path,
    url: &str,
    token: Option<&str>,
    project: Uuid,
) -> Result<(), FetchError> {
    let local = |error: anyhow::Error| FetchError::Local(format!("{error:#}"));
    let git = WorkspaceGit::bare(dir, token).with_network_deadline(Instant::now() + FETCH_DEADLINE);
    let args = [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--prune",
        "--end-of-options",
        url,
        MAIN_FETCH_SPEC,
    ];
    let output = git.run(&args).map_err(|error| {
        warn!(%project, error = %format!("{error:#}"), "fetching main failed");
        FetchError::Unreachable
    })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("couldn't find remote ref") {
        let plain = WorkspaceGit::bare(dir, None);
        if let Some(stale) = plain.commit_id(MAIN_REF).map_err(local)? {
            plain.delete_ref(MAIN_REF, &stale).map_err(local)?;
        }
        return Ok(());
    }
    let failed = local_failure(&stderr).unwrap_or(FetchError::Unreachable);
    warn!(%project, ?failed, error = %failure(&args, &output), "fetching main failed");
    Err(failed)
}

/// What a failed fetch says about where it failed, for callers outside
/// this module (`?ref=` and recovery-list fetches).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FetchFailure {
    /// The mirror is damaged on this server's disk.
    Damaged,
    /// This server's disk is full.
    DiskFull,
}

/// [`FetchFailure`] of a failed fetch's git output, `None` when it is
/// canonical's (or the network's).
pub(crate) fn fetch_failure(text: &str) -> Option<FetchFailure> {
    match local_failure(text)? {
        FetchError::Broken => Some(FetchFailure::Damaged),
        FetchError::DiskFull => Some(FetchFailure::DiskFull),
        _ => None,
    }
}

/// What git says when the transfer from canonical broke off: the
/// connection closed or stalled part way (curl 18 and 28 over smart HTTP),
/// or the other end hung up. A pack that did not arrive whole fails to
/// index too; that never says anything about the mirror.
const TRANSPORT_MARKERS: &[&str] = &[
    "early eof",
    "unexpected disconnect",
    "rpc failed",
    "the remote end hung up",
    "bytes of body are still expected",
    "transfer closed",
    "operation too slow",
];

/// What a failed fetch's stderr says about the gateway's own disk: full,
/// or a mirror damaged there; or that the pack sent did not index. Lines
/// from canonical (`remote:`) never count, and a transfer that broke off
/// is canonical's (or the network's) whatever else git printed after it.
fn local_failure(stderr: &str) -> Option<FetchError> {
    let text = stderr
        .lines()
        .map(|line| line.trim().to_ascii_lowercase())
        .filter(|line| !line.starts_with("remote:"))
        .collect::<Vec<_>>()
        .join("\n");
    if says_disk_full(&text) {
        return Some(FetchError::DiskFull);
    }
    let names_local_object = ["stored in ", "./objects/"]
        .iter()
        .any(|marker| text.contains(marker));
    // An object file of the mirror git could not read: the mirror's damage,
    // whatever the transport printed after it.
    if names_local_object && says_mirror_damaged(&text) {
        return Some(FetchError::Broken);
    }
    if TRANSPORT_MARKERS.iter().any(|marker| text.contains(marker)) {
        return None;
    }
    // A pack that does not index: canonical's, unless git names an object
    // file of the mirror it could not read to resolve the pack's deltas.
    let from_pack = ["index-pack", "pack has bad object", "unresolved delta"]
        .iter()
        .any(|marker| text.contains(marker));
    if from_pack && !names_local_object {
        Some(FetchError::BadPack)
    } else if says_mirror_damaged(&text) {
        Some(FetchError::Broken)
    } else {
        None
    }
}

/// Whether `text` (git's own words about a mirror) says the mirror is
/// damaged on this server's disk: an object missing or corrupt, a ref to
/// nothing, a lock a killed git left.
pub(crate) fn says_mirror_damaged(text: &str) -> bool {
    const MARKERS: &[&str] = &[
        "cannot lock ref",
        ".lock': file exists",
        "unable to update local ref",
        "is corrupt",
        "corrupt loose object",
        "does not match index",
        "cannot be accessed",
        "unable to read sha1 file",
        "unable to read tree",
        "not a tree object",
        "unable to unpack",
        "inflate: data stream error",
        "object file ./objects/",
        "does not point to a valid object",
        "fatal: bad object",
        "error: bad object",
        // The readers' own words for an object git could not give them.
        "is missing or corrupt",
    ];
    let lower = text.to_ascii_lowercase();
    MARKERS.iter().any(|marker| lower.contains(marker))
        || (lower.contains("git object ") && lower.contains(" is missing"))
        || names_unreadable_object(&lower)
}

/// Whether `text` says git "could not read" an object it names by id.
fn names_unreadable_object(text: &str) -> bool {
    text.match_indices("could not read ").any(|(at, marker)| {
        let rest = &text[at + marker.len()..];
        let id: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        id.len() == 40 || id.len() == 64
    })
}

/// Remove the lock files a stopped git left in the mirror at `dir`: the
/// repository's own (`packed-refs.lock`, `config.lock`, ...), any under
/// `refs/` and `logs/`, and those in `objects/info` and `objects/pack`.
/// Links are never followed. Returns how many went.
fn remove_stale_locks(dir: &Path) -> usize {
    fn sweep(folder: &Path, deep: bool) -> usize {
        let Ok(entries) = std::fs::read_dir(folder) else {
            return 0;
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_dir() {
                if deep {
                    removed += sweep(&path, true);
                }
            } else if metadata.file_type().is_file()
                && entry.file_name().to_string_lossy().ends_with(".lock")
                && std::fs::remove_file(&path).is_ok()
            {
                removed += 1;
            }
        }
        removed
    }
    let real_dir = std::fs::symlink_metadata(dir).is_ok_and(|metadata| metadata.is_dir());
    if !real_dir {
        return 0;
    }
    sweep(dir, false)
        + sweep(&dir.join("refs"), true)
        + sweep(&dir.join("logs"), true)
        + sweep(&dir.join("objects/info"), false)
        + sweep(&dir.join("objects/pack"), false)
}

/// What `git gc --auto` looks at in a mirror: loose objects in the one
/// fan-out folder it samples (`objects/17`) and packs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PackingState {
    sampled: u64,
    packs: u64,
}

impl PackingState {
    /// Whether `gc --auto` with these limits would pack: more than
    /// `ceil(loose_limit / 256)` loose objects sampled, or more than
    /// `pack_limit` packs.
    fn needs_packing(self, loose_limit: u64, pack_limit: u64) -> bool {
        self.sampled > loose_limit.div_ceil(256) || self.packs > pack_limit
    }
}

fn packing_state(dir: &Path) -> PackingState {
    let count = |folder: &Path, keep: &dyn Fn(&str) -> bool| -> u64 {
        std::fs::read_dir(folder)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| keep(&entry.file_name().to_string_lossy()))
                    .count() as u64
            })
            .unwrap_or(0)
    };
    let objects = dir.join("objects");
    // The rest of an object name after its two-digit folder (SHA-1 or
    // SHA-256), as git counts them.
    let sampled = count(&objects.join("17"), &|name| {
        matches!(name.len(), 38 | 62) && name.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    let packs = count(&objects.join("pack"), &|name| name.ends_with(".pack"));
    PackingState { sampled, packs }
}

/// Whether the mirror at `dir` holds about `loose_limit` loose objects or
/// more than `pack_limit` packs, as `git gc --auto` estimates it.
#[cfg(test)]
fn needs_packing(dir: &Path, loose_limit: u64, pack_limit: u64) -> bool {
    packing_state(dir).needs_packing(loose_limit, pack_limit)
}

/// The space a cache entry named `<space id>.git` belongs to.
fn mirror_project(name: &str) -> Option<Uuid> {
    let id = name.strip_suffix(".git")?;
    let project = Uuid::parse_str(id).ok()?;
    (project.as_hyphenated().to_string() == id).then_some(project)
}

fn clear_folder(path: &Path) -> io::Result<()> {
    for entry in std::fs::read_dir(path)? {
        remove_entry(&entry?.path())?;
    }
    Ok(())
}

fn remove_older_than(path: &Path, now: SystemTime, age: Duration) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let old = modified(&entry.path())
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|elapsed| elapsed > age);
        if old {
            let _ = remove_entry(&entry.path());
        }
    }
}

/// What the sweeper knows about one mirror.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MirrorStat {
    pub project: Uuid,
    pub bytes: u64,
    pub last_use: SystemTime,
    pub leases: usize,
}

/// What one sweep did.
#[derive(Debug, Default)]
pub(crate) struct SweepReport {
    /// Whether it ran (not when another sweep was running: that one goes
    /// over the cache again instead).
    pub ran: bool,
    pub evicted: Vec<Uuid>,
    /// Mirrors that crossed git's packing limits and were packed.
    pub packed: Vec<Uuid>,
    /// The mirrors' total size before any was removed.
    pub total_bytes: u64,
    /// The size of `.legacy/`, reported (never reduced) when the disk is
    /// short of space.
    pub legacy_bytes: Option<u64>,
}

/// The mirrors to remove to free `needed` bytes on a disk short of space:
/// least recently used first, any that nobody holds. When those are not
/// enough, all of them.
pub(crate) fn plan_space_eviction(stats: &[MirrorStat], needed: u64) -> Vec<Uuid> {
    let mut unheld: Vec<&MirrorStat> = stats.iter().filter(|stat| stat.leases == 0).collect();
    unheld.sort_by_key(|stat| (stat.last_use, stat.project));
    let mut freed = 0u64;
    let mut evict = Vec::new();
    for stat in unheld {
        if freed >= needed {
            break;
        }
        freed = freed.saturating_add(stat.bytes);
        evict.push(stat.project);
    }
    evict
}

/// The free space on the disk of `path` for the server's user.
#[cfg(unix)]
fn free_bytes(path: &Path) -> Option<u64> {
    let stats = rustix::fs::statvfs(path).ok()?;
    Some(stats.f_bavail.saturating_mul(stats.f_frsize))
}

#[cfg(not(unix))]
fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Whether `text` (an error's) says a disk is full.
pub(crate) fn says_disk_full(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("no space left on device") || lower.contains("disk quota exceeded")
}

/// The mirrors to remove so the total gets under `cap`: least recently
/// used first, and only mirrors nobody holds that were last used more than
/// [`EVICT_IDLE_AFTER`] before `now`. When those are not enough the cache
/// stays over the cap (it is soft).
pub(crate) fn plan_eviction(stats: &[MirrorStat], cap: u64, now: SystemTime) -> Vec<Uuid> {
    let mut total = stats
        .iter()
        .fold(0u64, |total, stat| total.saturating_add(stat.bytes));
    if total <= cap {
        return Vec::new();
    }
    let mut idle: Vec<&MirrorStat> = stats
        .iter()
        .filter(|stat| {
            stat.leases == 0
                && now
                    .duration_since(stat.last_use)
                    .is_ok_and(|age| age > EVICT_IDLE_AFTER)
        })
        .collect();
    idle.sort_by_key(|stat| (stat.last_use, stat.project));
    let mut evict = Vec::new();
    for stat in idle {
        if total <= cap {
            break;
        }
        total = total.saturating_sub(stat.bytes);
        evict.push(stat.project);
    }
    evict
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Loose objects are estimated exactly as `git gc --auto` does: from
    /// `objects/17`, packing only above `ceil(limit / 256)` there (27 for
    /// git's 6700: 28 or more). Names that are not object names do not
    /// count.
    #[test]
    fn packing_starts_where_gc_auto_would() {
        let dir = tempfile::tempdir().unwrap();
        let sample = dir.path().join("objects/17");
        std::fs::create_dir_all(&sample).unwrap();
        std::fs::create_dir_all(dir.path().join("objects/pack")).unwrap();
        for n in 0..27 {
            std::fs::write(sample.join(format!("{n:038x}")), b"").unwrap();
        }
        std::fs::write(sample.join(format!("{:039x}", 1)), b"").unwrap();
        std::fs::write(sample.join(format!("{:038x}.tmp", 1)), b"").unwrap();
        assert!(!needs_packing(dir.path(), LOOSE_OBJECT_LIMIT, PACK_LIMIT));
        std::fs::write(sample.join(format!("{:038x}", 27)), b"").unwrap();
        assert!(needs_packing(dir.path(), LOOSE_OBJECT_LIMIT, PACK_LIMIT));
    }

    #[cfg(unix)]
    #[test]
    fn free_space_is_measured_on_the_disk() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(dir.path()).is_some_and(|free| free > 0));
        assert_eq!(free_bytes(&dir.path().join("missing")), None);
    }

    /// A mirror that cannot be made on a full disk (a first read of a
    /// space) is 503 `disk_full`, not a server failure.
    #[test]
    fn a_mirror_that_cannot_be_made_on_a_full_disk_is_asked_to_retry() {
        let text =
            "failed to create the mirror \"/c/x.git\": No space left on device (os error 28)";
        assert!(matches!(
            FetchError::local(text.to_string()),
            FetchError::DiskFull
        ));
        let status = |error: OriginError| {
            axum::response::IntoResponse::into_response(error)
                .status()
                .as_u16()
        };
        assert_eq!(
            status(FetchError::Local(text.to_string()).into_origin()),
            503
        );
        assert_eq!(
            status(FetchError::Local("permission denied".to_string()).into_origin()),
            500
        );
    }

    #[test]
    fn local_failures_are_told_apart_from_canonical_ones() {
        let kind = |stderr: &str| match local_failure(stderr) {
            Some(FetchError::Broken) => "broken",
            Some(FetchError::DiskFull) => "disk_full",
            Some(FetchError::BadPack) => "bad_pack",
            Some(_) => "other",
            None => "unreachable",
        };
        for (stderr, expected) in [
            (
                "error: cannot lock ref 'refs/heads/main': Unable to create '/c/x.git/refs/heads/main.lock': File exists.",
                "broken",
            ),
            (
                "error: update_ref failed for ref 'refs/heads/main': unable to update local ref",
                "broken",
            ),
            ("error: object file ./objects/ab/cd is empty", "broken"),
            ("fatal: loose object 0123 (stored in x) is corrupt", "broken"),
            ("fatal: bad object refs/heads/main", "broken"),
            (
                "error: unable to write file ./objects/ab/cd: No space left on device",
                "disk_full",
            ),
            ("fatal: write error: Disk quota exceeded", "disk_full"),
            (
                "fatal: unable to access 'https://edge/x.git/': Could not resolve host: edge",
                "unreachable",
            ),
            // A transfer cut off part way, as git tells it over smart HTTP
            // (curl 18: the connection closed; curl 28: too slow) and over
            // a local transport: the pack that did not arrive whole never
            // says the mirror is damaged.
            (
                "error: RPC failed; curl 18 transfer closed with 1877460 bytes remaining to read\n\
                 error: 46572 bytes of body are still expected\n\
                 fetch-pack: unexpected disconnect while reading sideband packet\n\
                 fatal: early EOF\n\
                 fatal: fetch-pack: invalid index-pack output",
                "unreachable",
            ),
            (
                "error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 30 seconds\n\
                 fetch-pack: unexpected disconnect while reading sideband packet\n\
                 fatal: early EOF\n\
                 fatal: fetch-pack: invalid index-pack output",
                "unreachable",
            ),
            (
                "fatal: the remote end hung up unexpectedly\n\
                 fatal: early EOF\n\
                 fatal: index-pack failed",
                "unreachable",
            ),
            // A damaged object file of the mirror stays the mirror's when the
            // other end hangs up after it.
            (
                "fatal: loose object 7627 (stored in ./objects/76/27) is corrupt\n\
                 fatal: the remote end hung up unexpectedly\n\
                 fatal: fetch-pack: invalid index-pack output",
                "broken",
            ),
            (
                "fatal: pack has bad object at offset 12: inflate returned -3\nfatal: index-pack failed",
                "bad_pack",
            ),
            (
                "fatal: pack has 1 unresolved delta\nfatal: fetch-pack: invalid index-pack output",
                "bad_pack",
            ),
            // A pack that does not resolve against a damaged local object.
            (
                "fatal: loose object 7627 (stored in ./objects/76/27) is corrupt\nfatal: fetch-pack: invalid index-pack output",
                "broken",
            ),
            (
                "error: object file ./objects/76/27 is empty\nfatal: index-pack failed",
                "broken",
            ),
            ("remote: error: object file x is empty\nfatal: early EOF", "unreachable"),
        ] {
            assert_eq!(kind(stderr), expected, "{stderr}");
        }
    }
}
