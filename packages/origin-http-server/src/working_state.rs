//! The seam between a working folder and its durable copy.
//!
//! Two calls answer everything the rest of the system asks about a folder's
//! unfinished work:
//!
//! - [`local_state`]: what is unsaved and when canonical last held all of
//!   it, from this machine alone (no network, no credential);
//! - `persist` (the `/workspace/persist` route, and the last step of a stop
//!   that asks for it): save that work to canonical now.
//!
//! Both answer a [`WorkingState`]. Drain, eviction and Studio read only that
//! answer (or the durable-stop marker written from it), never git: a backend
//! other than git, such as a replicated folder, can answer the same way.
//!
//! The git backend keeps each working folder's unfinished work on one
//! recovery ref, its slot: `refs/instafy/recovery/<working-set id>/working`
//! ([`git_service::policy::WORKING_SLOT_NAME`]). The working-set id is a
//! one-way hash of a random seed kept in the checkout's own repository
//! config ([`WORKING_SET_CONFIG_KEY`]), so it names the folder, and a fresh
//! clone gets a new one. Only the folder holds its seed: a turn that sees
//! another folder's slot (every fetch mirrors canonical's recovery refs)
//! and writes that slot's id into its own config only renames its own
//! slot, and a record naming another folder's commit is dropped, never used
//! as a lease. A save:
//!
//! 1. pushes local recovery refs still waiting for a push, first;
//! 2. takes a snapshot of the folder through the publish filter, with no
//!    lock on the real index and without moving HEAD, the index, any file
//!    or a nested repository. Its parent is the merge base with canonical
//!    `main` (or `main` itself for an unrelated history). A rolling save
//!    made while the agent works (a tick) leaves out files over
//!    [`TICK_MAX_BLOB_BYTES`], anything inside a nested repository and new
//!    content past [`TICK_MAX_NEW_BYTES`] (smallest files go first): they
//!    keep the entry the slot (or the parent) has, and content left out for
//!    the budget goes with the next tick;
//! 3. compares it with the local record [`RECORD_REF`], the last slot
//!    commit canonical confirmed: the same parent, tree and origin push
//!    nothing;
//! 4. replaces the slot under a lease on that recorded tip, confirms the
//!    push with `ls-remote`, and only then moves the record;
//! 5. deletes the slot (under the same lease) when nothing is unsaved and
//!    nothing waits on a local recovery ref.
//!
//! A push or delete is marked before it starts ([`ATTEMPT_REF`],
//! [`DELETING_REF`]) and unmarked once canonical's answer is known. When
//! the answer is lost, or the confirming `ls-remote` cannot run, the save
//! looks at the slot right away or, failing that, the next save does before
//! anything else: a commit this folder wrote becomes the record (and the
//! save builds its snapshot on it, so a file a tick leaves out keeps that
//! commit's version), a slot this folder deleted takes the record with it,
//! and until then nothing reads as saved. Only a commit this folder never
//! wrote is `slot_moved`.
//!
//! A slot gone from canonical while the record still names it, with no
//! delete of this folder's in flight, was removed or restored by a person:
//! the record moves to [`DISMISSED_REF`], and every path that commit held
//! whose content has not changed since keeps the parent's entry in later
//! saves, so removed work does not come back until someone edits it again.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use uuid::Uuid;

use crate::publish::{PublishContext, Publisher, Selection};
use crate::push::{delete_with_lease, push_replace_with_lease, PushClass};
use crate::recovery::{self, KIND_TRAILER, PATH_TRAILER};
use crate::tree_merge::{changed_paths, overlay, tree_with_entries_from};
use crate::workspace_fs::WorkspaceDir;
use crate::workspace_git::WorkspaceGit;

/// The checkout's repository config key holding the seed its working-set id
/// is made from (see [`working_set_id_for`]).
pub const WORKING_SET_CONFIG_KEY: &str = "instafy.workingSet";

/// The last slot commit canonical confirmed for this folder. Outside every
/// `local-recovery*` root, so no recovery push or dismissal reads it.
pub(crate) const RECORD_REF: &str = "refs/instafy/working-state";

/// The slot commit a person removed or restored: its paths are not saved
/// again until they change.
pub(crate) const DISMISSED_REF: &str = "refs/instafy/working-state-dismissed";

/// The slot commit a save is pushing: written before the push and removed
/// once canonical's answer is known. After a lost answer, a deadline or a
/// crash, the next save looks at the slot first and records this commit if
/// it landed.
pub(crate) const ATTEMPT_REF: &str = "refs/instafy/working-state-attempt";

/// The recorded slot commit a save is deleting, kept for the same reason: a
/// slot found gone after that was deleted by this folder, not removed by a
/// person.
pub(crate) const DELETING_REF: &str = "refs/instafy/working-state-deleting";

/// How often one save follows the slot to a newer commit of this folder's
/// own, or tries a create again, before it gives up.
const MAX_SLOT_RETRIES: usize = 3;

/// Files larger than this wait for the turn's end or the stop instead of
/// going out with a rolling save.
pub const TICK_MAX_BLOB_BYTES: u64 = 2 * 1024 * 1024;

/// The most new content (files whose version is on neither the slot nor
/// the parent) one rolling save sends. Smaller files go first; the rest
/// keep their earlier entry and go out with the next tick, so a small edit
/// always lands within [`TICK_BUDGET`].
pub const TICK_MAX_NEW_BYTES: u64 = 16 * 1024 * 1024;

/// How long a rolling save may spend on the network.
pub const TICK_BUDGET: Duration = Duration::from_secs(10);

/// How long a turn-end save waits for the workspace locks.
pub const TURN_END_LOCK_WAIT: Duration = Duration::from_secs(10);

/// How long a save's push or `ls-remote` may move no data.
const STALL_SECONDS: u32 = 8;

/// Paths the repository policy may refuse in one save before it gives up.
const MAX_PATH_REFUSALS: usize = 8;

/// Paths named in one slot commit's message.
const MAX_TRAILER_PATHS: usize = 200;

/// What the durable-stop marker holds: the stop's final [`local_state`]
/// was durable.
pub const DURABLE_MARKER: &[u8] = b"durable v1\n";

const ORIGIN_TRAILER: &str = "Instafy-Origin";
/// Names the working set whose slot a commit was made for.
const WORKING_SET_TRAILER: &str = "Instafy-Working-Set";
const SUBJECT: &str = "Keep a workspace's unsaved changes";

/// Why a save was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistReason {
    /// A rolling save while a turn runs.
    Tick,
    /// The end of a write job.
    TurnEnd,
    /// The last step of a stop's flush.
    Stop,
}

/// What is unsaved in a working folder and when canonical last held all of
/// it. The one answer every consumer reads.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingState {
    /// Paths in the folder that differ from its saved version and may be
    /// saved.
    pub unsaved: u32,
    /// Work only this machine holds (git: local recovery refs not pushed).
    pub local_only: u32,
    /// When canonical last held all of it.
    pub persisted_at: Option<DateTime<Utc>>,
    /// Nothing is local-only, and canonical holds the folder's current
    /// unsaved state.
    pub durable: bool,
    /// The folder changed since its last confirmed save (always true before
    /// the first save of a process): the check a rolling save makes before
    /// it asks for a credential.
    #[serde(default)]
    pub changed: bool,
    /// A fixed code, never free text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Why a save did not leave canonical holding the folder's work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SaveError {
    /// No canonical remote to save to.
    NoBackend,
    /// No credential that may push.
    NoCredential,
    /// A stop began: the rolling save gave up.
    Stopping,
    /// The push's outcome is unknown; nothing was recorded.
    PushAmbiguous,
    /// Someone else moved the slot.
    SlotMoved,
    /// Canonical refused the save.
    PushRejected,
    /// The push was reported, but canonical does not show it.
    Unconfirmed,
    /// Canonical could not be reached.
    Unreachable,
    /// A local git step failed.
    Local,
}

impl SaveError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::NoBackend => "no_backend",
            Self::NoCredential => "no_credential",
            Self::Stopping => "stopping",
            Self::PushAmbiguous => "push_ambiguous",
            Self::SlotMoved => "slot_moved",
            Self::PushRejected => "push_rejected",
            Self::Unconfirmed => "unconfirmed",
            Self::Unreachable => "unreachable",
            Self::Local => "local_failed",
        }
    }
}

/// The process-wide flag a stop raises: a rolling save in flight gives up
/// at its next step, and the stop's own flush takes the locks. It is up
/// while any stop holds the [`Raised`] its `raise` returned, so it goes down
/// when the last of them is dropped, also when a stop's request is
/// cancelled, and one stop never lowers it under another.
#[derive(Clone, Default)]
pub struct StopFlag(Arc<AtomicUsize>);

/// One stop's hold on the [`StopFlag`].
#[must_use = "the stop flag goes down when this is dropped"]
pub struct Raised(StopFlag);

impl Drop for Raised {
    fn drop(&mut self) {
        self.0 .0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl StopFlag {
    pub fn raise(&self) -> Raised {
        self.0.fetch_add(1, Ordering::SeqCst);
        Raised(self.clone())
    }

    pub fn is_raised(&self) -> bool {
        self.0.load(Ordering::SeqCst) > 0
    }
}

/// What this process remembers about the folder's last confirmed save:
/// nothing survives a restart, so the first save of a process always runs.
#[derive(Clone, Default)]
pub struct WorkingMemory(Arc<Mutex<Remembered>>);

#[derive(Default)]
struct Remembered {
    saved: Option<Saved>,
    persisted_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy)]
struct Saved {
    fingerprint: Fingerprint,
    /// Nothing was deferred: canonical holds every file of that state.
    complete: bool,
    /// The save left new content for the next one (see
    /// [`TICK_MAX_NEW_BYTES`]): it runs even if nothing changes meanwhile.
    more: bool,
}

type Fingerprint = [u8; 32];

impl WorkingMemory {
    fn lock(&self) -> std::sync::MutexGuard<'_, Remembered> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state(&self, fingerprint: Fingerprint, unsaved: usize, local_only: usize) -> WorkingState {
        let remembered = self.lock();
        let changed = remembered
            .saved
            .is_none_or(|saved| saved.fingerprint != fingerprint || saved.more);
        let complete = remembered.saved.is_some_and(|saved| saved.complete);
        WorkingState {
            unsaved: count(unsaved),
            local_only: count(local_only),
            persisted_at: remembered.persisted_at,
            durable: !changed && complete && local_only == 0,
            changed,
            error: None,
        }
    }

    fn confirm(&self, fingerprint: Fingerprint, complete: bool, durable: bool, more: bool) {
        let mut remembered = self.lock();
        remembered.saved = Some(Saved {
            fingerprint,
            complete,
            more,
        });
        if durable {
            remembered.persisted_at = Some(Utc::now());
        }
    }

    fn forget(&self) {
        self.lock().saved = None;
    }

    fn persisted_at(&self) -> Option<DateTime<Utc>> {
        self.lock().persisted_at
    }
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// A lower-case hyphenated UUID, the only form a working-set id or its seed
/// takes.
pub fn is_working_set_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// The folder's working-set id: the name of its slot on canonical, made from
/// the seed the first save writes to its repository config.
pub(crate) fn working_set_id(git: &WorkspaceGit<'_>) -> Result<String> {
    Ok(working_set_id_for(&working_set_seed(git)?))
}

/// The working-set id of `seed`: the first 128 bits of a SHA-256 of it, as a
/// UUID. Slot names are public to everyone who may read the space; the seed
/// stays in the folder, and no slot name leads back to it.
pub fn working_set_id_for(seed: &str) -> String {
    let digest = Sha256::new()
        .chain_update(b"instafy-working-set-v1\0")
        .chain_update(seed.as_bytes())
        .finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .as_hyphenated()
        .to_string()
}

fn working_set_seed(git: &WorkspaceGit<'_>) -> Result<String> {
    if let Some(seed) = read_working_set_seed(git)? {
        return Ok(seed);
    }
    let seed = Uuid::new_v4().as_hyphenated().to_string();
    git.ok(&["config", WORKING_SET_CONFIG_KEY, &seed])?;
    match read_working_set_seed(git)? {
        Some(stored) if stored == seed => Ok(seed),
        _ => bail!("the working-set seed did not stay in the repository config"),
    }
}

fn read_working_set_seed(git: &WorkspaceGit<'_>) -> Result<Option<String>> {
    let output = git.run(&["config", "--get", WORKING_SET_CONFIG_KEY])?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(is_working_set_id(&value).then_some(value))
}

fn slot_ref(id: &str) -> String {
    format!(
        "{}/{id}/{}",
        git_service::policy::RECOVERY_REF_ROOT,
        git_service::policy::WORKING_SLOT_NAME
    )
}

/// Whether a rolling save leaves `path` for later: it lies at or under a
/// folder holding a `.git` (a nested repository, found without renaming
/// anything), or it is a file over [`TICK_MAX_BLOB_BYTES`].
pub(crate) fn deferred_by_tick(workspace: &WorkspaceDir, root: &Path, path: &str) -> bool {
    let mut cursor = Path::new(path);
    loop {
        if cursor.as_os_str().is_empty() {
            break;
        }
        let candidate = format!("{}/.git", cursor.to_string_lossy().replace('\\', "/"));
        match workspace.entry_kind(&candidate) {
            Ok(_) => return true,
            // No `.git` there, or `cursor` is a file.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            // Anything that cannot be read safely waits for the turn's end.
            Err(_) => return true,
        }
        match cursor.parent() {
            Some(parent) => cursor = parent,
            None => break,
        }
    }
    std::fs::symlink_metadata(root.join(path))
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > TICK_MAX_BLOB_BYTES)
}

/// The confirmed slot commit the local record names.
#[derive(Clone, Debug)]
struct Record {
    commit: String,
    parent: Option<String>,
    tree: String,
    origin: Option<Uuid>,
    /// The working set the commit was made for.
    working_set: Option<String>,
}

fn read_commit(git: &WorkspaceGit<'_>, reference: &str) -> Result<Option<Record>> {
    let Some(commit) = git.commit_id(reference)? else {
        return Ok(None);
    };
    let object = git
        .read_objects(std::slice::from_ref(&commit))?
        .pop()
        .context("the working-state record is missing")?;
    let parsed = crate::recovery_view::parse_commit(&object.data);
    let text = String::from_utf8_lossy(&object.data);
    let tree = text
        .lines()
        .find_map(|line| line.strip_prefix("tree "))
        .context("the working-state record has no tree")?
        .trim()
        .to_string();
    Ok(Some(Record {
        parent: parsed.parents.first().cloned(),
        origin: parsed
            .trailer(ORIGIN_TRAILER)
            .and_then(|value| Uuid::parse_str(value).ok()),
        working_set: parsed.trailer(WORKING_SET_TRAILER).map(str::to_string),
        tree,
        commit,
    }))
}

/// The folder's record ([`RECORD_REF`]), when it names a slot commit made
/// for this folder's working set. A record naming anything else (another
/// folder's save, which a fetch mirrors into this repository and a turn can
/// point the record at) is dropped, so it never becomes a lease.
fn read_record(
    git: &WorkspaceGit<'_>,
    working_set: impl FnOnce() -> Result<String>,
) -> Result<Option<Record>> {
    let Some(record) = read_commit(git, RECORD_REF)? else {
        return Ok(None);
    };
    if record.working_set.as_deref() == Some(working_set()?.as_str()) {
        return Ok(Some(record));
    }
    warn!("the working folder's record names a commit made for another working set; dropped it");
    git.delete_ref(RECORD_REF, &record.commit)?;
    Ok(None)
}

/// The paths at or under one of `roots` that a save on `parent_tree` keeps
/// from `record`: the ones `record` changes against its own parent, except
/// where `main` changed them too since (the parents' trees differ there),
/// whose version is then the newer one.
fn kept_from_record(
    git: &WorkspaceGit<'_>,
    record: &Record,
    roots: &[String],
    parent_tree: &str,
) -> Result<Vec<String>> {
    let base = match record.parent.as_deref() {
        Some(parent) => git.tree_id(parent)?,
        None => git.empty_tree()?,
    };
    let moved: BTreeSet<String> = if base == parent_tree {
        BTreeSet::new()
    } else {
        changed_paths(git, &base, parent_tree)?
            .into_iter()
            .collect()
    };
    Ok(changed_paths(git, &base, &record.tree)?
        .into_iter()
        .filter(|path| {
            !moved.contains(path)
                && roots
                    .iter()
                    .any(|root| path == root || path.starts_with(&format!("{root}/")))
        })
        .collect())
}

/// `tree` as a save on `parent` sends it, given the slot commit `record`
/// names. A path the save left out (`deferred`) never drops what an earlier
/// save held: it keeps `record`'s entry where `record` changed it and
/// `main` has not changed it since (see [`kept_from_record`]), and the
/// parent's everywhere else. An earlier save on an older `main` would
/// otherwise carry an older version of a file onto this parent, as if the
/// folder had changed it back, and a Restore would apply it over the
/// published one. Paths a person removed from the slot then take the
/// parent's entry (see [`without_dismissed`]).
fn kept_by_save(
    git: &WorkspaceGit<'_>,
    tree: &str,
    parent: Option<&str>,
    parent_tree: &str,
    record: Option<&Record>,
    deferred: &[String],
) -> Result<String> {
    let mut tree = tree.to_string();
    if !deferred.is_empty() {
        tree = tree_with_entries_from(git, &tree, parent, deferred)?;
        if let Some(record) = record {
            let kept = kept_from_record(git, record, deferred, parent_tree)?;
            tree = tree_with_entries_from(git, &tree, Some(&record.commit), &kept)?;
        }
    }
    without_dismissed(git, &tree, parent)
}

/// Whether a stop needs no `unsaved` copy of `tree` on `parent`, once the
/// paths a person removed from the slot are left out as every save leaves
/// them out (see [`without_dismissed`]): those paths are all it changes, or
/// the folder's last confirmed save holds the rest. Without a removed slot
/// this is only the second.
pub(crate) fn record_holds(
    git: &WorkspaceGit<'_>,
    parent: Option<&str>,
    tree: &str,
) -> Result<bool> {
    let kept = without_dismissed(git, tree, parent)?;
    if kept != tree {
        let parent_tree = match parent {
            Some(parent) => git.tree_id(parent)?,
            None => git.empty_tree()?,
        };
        if kept == parent_tree {
            return Ok(true);
        }
    }
    if unsettled(git)? {
        return Ok(false);
    }
    Ok(read_record(git, || working_set_id(git))?
        .is_some_and(|record| record.parent.as_deref() == parent && record.tree == kept))
}

/// Whether a push or delete of the slot is waiting for canonical's answer
/// (see [`ATTEMPT_REF`]): until a save has looked at the slot again, the
/// record may be behind it and says nothing about what canonical holds.
pub(crate) fn unsettled(git: &WorkspaceGit<'_>) -> Result<bool> {
    let (attempt, deleting) = markers(git)?;
    Ok(attempt.is_some() || deleting.is_some())
}

/// The commits [`ATTEMPT_REF`] and [`DELETING_REF`] name, in one call.
fn markers(git: &WorkspaceGit<'_>) -> Result<(Option<String>, Option<String>)> {
    let listed = git.stdout(&[
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        ATTEMPT_REF,
        DELETING_REF,
    ])?;
    let named = |reference: &str| {
        listed.lines().find_map(|line| {
            let (name, rev) = line.split_once('\0')?;
            (name == reference).then(|| rev.to_string())
        })
    };
    Ok((named(ATTEMPT_REF), named(DELETING_REF)))
}

/// Local recovery refs not pushed yet, except the ones `held_back`.
fn local_only(git: &WorkspaceGit<'_>, held_back: &BTreeSet<String>) -> Result<usize> {
    Ok(recovery::pending(git)?
        .into_iter()
        .filter(|(name, _)| !held_back.contains(name))
        .count())
}

/// HEAD and the tracked `main` (a publish may move only `main`, onto the
/// folder's own commits) plus `(path, mtime, size, mode, inode, ctime)` of
/// every path the publish filter lets through, and how many there are.
/// Never takes `index.lock`.
fn fingerprint(
    publisher: &Publisher<'_>,
    status: &[(String, bool)],
) -> Result<(Fingerprint, usize)> {
    let head = publisher.git.commit_id("HEAD")?;
    let main = publisher.tracked_main()?;
    let root = publisher.git.root();
    let mut hasher = Sha256::new();
    hasher.update(b"instafy-working-state-v1\0");
    hasher.update(head.unwrap_or_default().as_bytes());
    hasher.update(b"\0");
    hasher.update(main.unwrap_or_default().as_bytes());
    hasher.update(b"\0");
    let mut listed = 0usize;
    for (path, deleted) in status {
        if publisher.pre_check(path, *deleted).is_some() {
            continue;
        }
        listed += 1;
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        match std::fs::symlink_metadata(root.join(path)) {
            Ok(metadata) => {
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or_default();
                hasher.update(modified.to_le_bytes());
                hasher.update(metadata.len().to_le_bytes());
                hash_identity(&mut hasher, &metadata);
            }
            Err(_) => hasher.update(b"absent"),
        }
        hasher.update(b"\0");
    }
    Ok((hasher.finalize().into(), listed))
}

/// The mode and, on unix, the inode and the change time. `tar -x`,
/// `cp -p` and `rsync -a` put the mtime back after a rewrite; nothing in
/// userland sets the ctime, so a rewrite of the same size still shows.
#[cfg(unix)]
fn hash_identity(hasher: &mut Sha256, metadata: &std::fs::Metadata) {
    use std::os::unix::fs::MetadataExt as _;
    hasher.update(metadata.mode().to_le_bytes());
    hasher.update(metadata.ino().to_le_bytes());
    hasher.update(metadata.ctime().to_le_bytes());
    hasher.update(metadata.ctime_nsec().to_le_bytes());
}

#[cfg(not(unix))]
fn hash_identity(hasher: &mut Sha256, metadata: &std::fs::Metadata) {
    let mode = u32::from(metadata.is_dir()) | (u32::from(metadata.permissions().readonly()) << 1);
    hasher.update(mode.to_le_bytes());
}

/// What the folder holds now, from this machine alone: no network, no
/// credential, no lock. `durable` and `changed` compare it with what this
/// process last confirmed.
pub fn local_state(ctx: &PublishContext<'_>, memory: &WorkingMemory) -> Result<WorkingState> {
    let publisher = Publisher::new(ctx, Duration::ZERO);
    let status = publisher.status_without_locks()?;
    let (fingerprint, unsaved) = self::fingerprint(&publisher, &status)?;
    let local_only = recovery::pending(&publisher.git)?.len();
    let mut state = memory.state(fingerprint, unsaved, local_only);
    if unsettled(&publisher.git)? {
        // A save's answer never came: canonical may hold less than the
        // folder, and the next save has to look.
        state.durable = false;
        state.changed = true;
    } else if !state.durable && unsaved == 0 && local_only == 0 && head_on_main(&publisher)? {
        // Nothing to save, whatever this process remembers (it may never
        // have saved, as with rolling saves off): canonical `main` already
        // holds everything the folder does.
        state.durable = true;
    }
    Ok(state)
}

/// Whether canonical `main`, as last fetched, holds the folder's HEAD.
fn head_on_main(publisher: &Publisher<'_>) -> Result<bool> {
    let Some(head) = publisher.git.commit_id("HEAD")? else {
        return Ok(true);
    };
    match publisher.tracked_main()? {
        Some(main) => publisher.git.is_ancestor(&head, &main),
        None => Ok(false),
    }
}

/// One save's snapshot, taken under the workspace locks with no network
/// call, and what it needs.
pub(crate) struct Plan {
    reason: PersistReason,
    fingerprint: Fingerprint,
    head: Option<String>,
    parent: Option<String>,
    main: Option<String>,
    tree: String,
    /// Paths the tree took from the slot (or the parent) instead of the
    /// folder.
    deferred: Vec<String>,
    /// Some of them were left for the next tick only because this one had
    /// sent [`TICK_MAX_NEW_BYTES`] already.
    more: bool,
    record: Option<Record>,
    /// A push or delete of the slot is waiting for canonical's answer.
    unsettled: bool,
    /// The parent's tree (the empty tree without a parent).
    parent_tree: String,
    /// Local recovery refs waiting for a push.
    pending: usize,
}

impl Plan {
    fn parent_tree(&self, _git: &WorkspaceGit<'_>) -> Result<String> {
        Ok(self.parent_tree.clone())
    }

    /// The slot already holds this snapshot as this origin saved it, and no
    /// earlier push or delete is waiting for its answer.
    fn slot_current(&self, origin: Uuid) -> bool {
        !self.unsettled
            && holds(
                self.record.as_ref(),
                self.parent.as_deref(),
                &self.tree,
                origin,
            )
    }

    /// Whether this save has to talk to canonical: something waits on a
    /// local ref, an earlier save's answer never came, the slot is behind
    /// the folder, or nothing is unsaved and a slot exists. Only then is a
    /// credential minted.
    pub(crate) fn needs_network(&self, git: &WorkspaceGit<'_>, origin: Uuid) -> Result<bool> {
        if self.pending > 0 || self.unsettled {
            return Ok(true);
        }
        let unsaved = self.tree != self.parent_tree(git)?;
        Ok(if unsaved {
            !self.slot_current(origin)
        } else {
            self.record.is_some()
        })
    }
}

/// Whether `record` holds `tree` on `parent` as `origin` saved it.
fn holds(record: Option<&Record>, parent: Option<&str>, tree: &str, origin: Uuid) -> bool {
    record.is_some_and(|record| {
        record.parent.as_deref() == parent && record.tree == tree && record.origin == Some(origin)
    })
}

/// What looking at the slot on canonical found, once the record agrees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Seen {
    /// The slot holds the recorded commit (or nothing, and there is no
    /// record): no earlier push or delete landed unseen.
    Recorded,
    /// The slot holds a commit this folder wrote that the record did not
    /// name; the record names it now.
    Adopted,
    /// The slot is gone because this folder deleted it; so is the record.
    Deleted,
    /// The slot is gone while the record names it and no delete of this
    /// folder's was in flight: a person removed or restored it. The record
    /// moved to [`DISMISSED_REF`].
    Removed,
    /// Someone else's commit. Nothing was changed.
    Moved,
}

/// The result of a stop's own save.
pub(crate) struct StopSave {
    pub(crate) state: WorkingState,
    /// The tree canonical now holds for the folder (the slot's, or the
    /// parent's when nothing is unsaved), once the save settled. A held-back
    /// `unsaved` copy is needed only when this does not hold all of it (see
    /// [`holds_copy`]).
    pub(crate) held: Option<String>,
}

fn stopping(stop: Option<&StopFlag>) -> Result<()> {
    if stop.is_some_and(StopFlag::is_raised) {
        bail!(Stopped);
    }
    Ok(())
}

/// A rolling save gave up because a stop began.
#[derive(Debug)]
struct Stopped;

impl std::fmt::Display for Stopped {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a stop began; the rolling save gave up")
    }
}

impl std::error::Error for Stopped {}

fn local_failure(error: &anyhow::Error) -> SaveError {
    if error.downcast_ref::<Stopped>().is_some() {
        SaveError::Stopping
    } else {
        SaveError::Local
    }
}

impl Publisher<'_> {
    /// Take the save's snapshot (see the module docs) with no network call.
    /// A tick never moves HEAD, the index, a file or a nested repository,
    /// and gives up when `stop` is raised.
    pub(crate) fn plan_working_save(
        &mut self,
        reason: PersistReason,
        stop: Option<&StopFlag>,
    ) -> Result<Plan> {
        stopping(stop)?;
        let head = self.git.commit_id("HEAD")?;
        let main = self.tracked_main()?;
        let base = match (head.as_deref(), main.as_deref()) {
            (Some(head), Some(main)) => self.git.merge_base(head, main)?,
            _ => None,
        };
        let parent = base.clone().or_else(|| main.clone());
        let parent_tree = match parent.as_deref() {
            Some(parent) => self.git.tree_id(parent)?,
            None => self.git.empty_tree()?,
        };
        // The agent may be running git in the folder during a tick; at a
        // turn's end or a stop it is idle.
        let status = if reason == PersistReason::Tick {
            self.status_without_locks()?
        } else {
            self.status()?
        };
        let (fingerprint, _) = fingerprint(self, &status)?;
        stopping(stop)?;
        let (dirty_tree, deferred) = self.stage_paths(
            &Selection::AllDirty,
            head.as_deref(),
            Some(status),
            reason == PersistReason::Tick,
        )?;
        stopping(stop)?;
        if let Some(head) = head.as_deref() {
            self.scan_history(head, main.as_deref())?;
        }
        let frozen: Vec<String> = self.filtered.keys().cloned().collect();
        let mut tree = match (head.as_deref(), base.as_deref(), main.as_deref()) {
            (Some(head), None, Some(main)) => self.unrelated_tree(main, head, &dirty_tree)?,
            (None, _, Some(main)) => overlay(&self.git, main, &dirty_tree, &frozen)?,
            _ => tree_with_entries_from(&self.git, &dirty_tree, parent.as_deref(), &frozen)?,
        };
        let record = read_record(&self.git, || self.working_set())?;
        let mut deferred = deferred;
        let mut more = false;
        if reason == PersistReason::Tick {
            let over = self.over_budget(&tree, &parent_tree, record.as_ref(), &deferred)?;
            more = !over.is_empty();
            deferred.extend(over);
        }
        tree = kept_by_save(
            &self.git,
            &tree,
            parent.as_deref(),
            &parent_tree,
            record.as_ref(),
            &deferred,
        )?;
        stopping(stop)?;
        let pending = local_only(&self.git, &self.held_back)?;
        let unsettled = unsettled(&self.git)?;
        Ok(Plan {
            reason,
            fingerprint,
            head,
            parent,
            main,
            tree,
            deferred,
            record,
            unsettled,
            parent_tree,
            pending,
            more,
        })
    }

    /// The paths a tick leaves for the next one so it sends at most
    /// [`TICK_MAX_NEW_BYTES`] of new content: content whose version is on
    /// neither the slot nor the parent, smallest first (sizes as the folder
    /// has them now). Paths `deferred` already are not counted.
    fn over_budget(
        &self,
        tree: &str,
        parent_tree: &str,
        record: Option<&Record>,
        deferred: &[String],
    ) -> Result<Vec<String>> {
        let mut fresh = changed_paths(&self.git, parent_tree, tree)?;
        if let Some(record) = record {
            let unsent: BTreeSet<String> = changed_paths(&self.git, &record.tree, tree)?
                .into_iter()
                .collect();
            fresh.retain(|path| unsent.contains(path));
        }
        fresh.retain(|path| {
            !deferred
                .iter()
                .any(|kept| path == kept || path.starts_with(&format!("{kept}/")))
        });
        let root = self.git.root();
        let mut sized: Vec<(u64, String)> = fresh
            .into_iter()
            .map(|path| {
                let size = std::fs::symlink_metadata(root.join(&path))
                    .map(|metadata| {
                        if metadata.is_file() {
                            metadata.len()
                        } else {
                            0
                        }
                    })
                    .unwrap_or(0);
                (size, path)
            })
            .collect();
        sized.sort();
        let mut sent = 0u64;
        let mut over = Vec::new();
        for (size, path) in sized {
            if sent.saturating_add(size) > TICK_MAX_NEW_BYTES {
                over.push(path);
            } else {
                sent += size;
            }
        }
        Ok(over)
    }

    /// Whether `plan` still stands: HEAD, the tracked `main`, the record and
    /// any unanswered push or delete are what they were when it was taken.
    /// A route-level save lets the workspace go while it asks for write
    /// access; meanwhile the turn may have published (moving HEAD and
    /// `main`), or another save of the folder may have moved the slot.
    pub(crate) fn plan_still_current(&self, plan: &Plan) -> Result<bool> {
        let recorded = self.git.commit_id(RECORD_REF)?;
        Ok(
            recorded.as_deref() == plan.record.as_ref().map(|record| record.commit.as_str())
                && unsettled(&self.git)? == plan.unsettled
                && self.git.commit_id("HEAD")? == plan.head
                && self.tracked_main()? == plan.main,
        )
    }

    /// Bring canonical up to date with `plan`: push what waits on local
    /// refs first, then replace, keep or delete the slot. Never fails: the
    /// answer carries a fixed error code instead.
    pub(crate) fn execute_working_save(
        &mut self,
        plan: Plan,
        memory: &WorkingMemory,
        stop: Option<&StopFlag>,
    ) -> StopSave {
        let fingerprint = plan.fingerprint;
        let complete = plan.deferred.is_empty();
        let more = plan.more;
        let unsaved_paths = plan
            .parent_tree(&self.git)
            .and_then(|parent_tree| changed_paths(&self.git, &parent_tree, &plan.tree));
        let unsaved = unsaved_paths.as_ref().map(Vec::len).unwrap_or_default();
        let outcome = self.save_slot(plan, stop);
        let local_only = local_only(&self.git, &self.held_back).unwrap_or(usize::MAX);
        match outcome {
            Ok(settled) => {
                let durable = settled.held.is_some() && complete && local_only == 0;
                memory.confirm(fingerprint, complete, durable, more);
                StopSave {
                    state: WorkingState {
                        unsaved: count(settled.unsaved.unwrap_or(unsaved)),
                        local_only: count(local_only),
                        persisted_at: memory.persisted_at(),
                        durable,
                        changed: false,
                        error: None,
                    },
                    held: settled.held,
                }
            }
            Err(error) => {
                if error == SaveError::SlotMoved {
                    warn!("the working folder's save was moved by someone else; this folder saves nothing more to it");
                    memory.forget();
                }
                StopSave {
                    state: WorkingState {
                        unsaved: count(unsaved),
                        local_only: count(local_only),
                        persisted_at: memory.persisted_at(),
                        durable: false,
                        changed: true,
                        error: Some(error.code().to_string()),
                    },
                    held: None,
                }
            }
        }
    }

    /// A stop's own save, after it parked and pushed what it keeps on local
    /// refs; the `unsaved` copies it held back do not count as local-only.
    pub(crate) fn persist_for_stop(&mut self, memory: &WorkingMemory) -> StopSave {
        if self
            .config
            .git_remote_url_for_project(self.config.project_id)
            .is_none()
        {
            return not_saved(memory, SaveError::NoBackend);
        }
        let plan = match self.plan_working_save(PersistReason::Stop, None) {
            Ok(plan) => plan,
            Err(error) => {
                warn!(error = %format!("{error:#}"), "a stop could not take the working folder's snapshot");
                return not_saved(memory, local_failure(&error));
            }
        };
        let state = self.execute_working_save(plan, memory, None);
        info!(
            durable = state.state.durable,
            error = state.state.error.as_deref().unwrap_or("none"),
            "a stop saved the working folder"
        );
        state
    }

    fn save_slot(&mut self, plan: Plan, stop: Option<&StopFlag>) -> Result<Settled, SaveError> {
        let origin = self.config.origin_id;
        let reason = plan.reason;
        let local = |error: anyhow::Error| {
            warn!(error = %format!("{error:#}"), ?reason, "a working save failed locally");
            local_failure(&error)
        };
        if plan.pending > 0 {
            if !self.can_write {
                return Err(SaveError::NoCredential);
            }
            // Work only this machine holds goes out first: a slot is never
            // the reason it stays local.
            stopping(stop).map_err(local)?;
            self.push_parked();
            stopping(stop).map_err(local)?;
        }
        let local_only = local_only(&self.git, &self.held_back).map_err(local)?;
        let parent_tree = plan.parent_tree(&self.git).map_err(local)?;
        let mut tree = plan.tree.clone();
        let mut record = plan.record.clone();
        if plan.unsettled {
            // An earlier push or delete never got its answer: learn what the
            // slot holds before anything relies on the record.
            if !self.can_write {
                return Err(SaveError::NoCredential);
            }
            let slot = self.slot().map_err(local)?;
            let (seen, _) = self.see_slot(&slot)?;
            if seen == Seen::Moved {
                return Err(SaveError::SlotMoved);
            }
            (record, tree) = self.follow_record(&plan, record, tree).map_err(local)?;
        }
        if tree != parent_tree && holds(record.as_ref(), plan.parent.as_deref(), &tree, origin) {
            return Ok(Settled::holding(&tree, None));
        }
        let mut retries = 0usize;
        let mut refusals = 0usize;
        loop {
            stopping(stop).map_err(local)?;
            if tree == parent_tree {
                // Nothing unsaved. The slot may be the only canonical copy of
                // what a local-only ref holds, so it stays until that is
                // pushed.
                let Some(current) = record.as_ref() else {
                    return Ok(Settled::holding(&parent_tree, Some(0)));
                };
                // Nor while a copy this stop held back has work the parent
                // does not hold: that copy is pushed instead.
                if local_only > 0 || !self.held_back_within(&parent_tree).map_err(local)? {
                    return Ok(Settled {
                        held: None,
                        unsaved: Some(0),
                    });
                }
                if self.delete_slot(current)? {
                    return Ok(Settled::holding(&parent_tree, Some(0)));
                }
                // The slot holds a newer save of this folder's own: go on
                // from it (below).
            } else {
                if !self.can_write {
                    return Err(SaveError::NoCredential);
                }
                let slot = self.slot().map_err(local)?;
                let commit = self
                    .slot_commit(&tree, plan.parent.as_deref(), &parent_tree)
                    .map_err(local)?;
                let expected = record.as_ref().map(|record| record.commit.clone());
                // Kept until canonical's answer is known, so a push that lands
                // unseen is found by the next save.
                self.git
                    .ok(&[
                        "update-ref",
                        "-m",
                        "instafy: working state push",
                        ATTEMPT_REF,
                        &commit,
                    ])
                    .map_err(local)?;
                let pushed = match push_replace_with_lease(
                    &self.git,
                    &self.remote,
                    &commit,
                    &slot,
                    expected.as_deref(),
                ) {
                    Ok(pushed) => pushed.class,
                    Err(error) => {
                        warn!(error = %format!("{error:#}"), "a working save could not push");
                        return self.after_push(&slot, &commit, &tree, SaveError::Unreachable);
                    }
                };
                match pushed {
                    // Confirmed only once `ls-remote` shows it.
                    PushClass::Pushed => {
                        return self.after_push(&slot, &commit, &tree, SaveError::Unconfirmed)
                    }
                    PushClass::Ambiguous(_) => {
                        return self.after_push(&slot, &commit, &tree, SaveError::PushAmbiguous)
                    }
                    PushClass::PathRejected { path, .. } => {
                        self.clear_markers().map_err(local)?;
                        refusals += 1;
                        if refusals > MAX_PATH_REFUSALS {
                            return Err(SaveError::PushRejected);
                        }
                        let left_out = without_refused_path(
                            &self.git,
                            &tree,
                            plan.parent.as_deref(),
                            plan.main.as_deref(),
                            &path,
                        )
                        .map_err(local)?;
                        if left_out == tree {
                            return Err(SaveError::PushRejected);
                        }
                        tree = left_out;
                        continue;
                    }
                    PushClass::LostRace(_) => {
                        if self.see_slot(&slot)?.0 == Seen::Moved {
                            return Err(SaveError::SlotMoved);
                        }
                    }
                    PushClass::Rejected(_) => {
                        self.clear_markers().map_err(local)?;
                        return Err(SaveError::PushRejected);
                    }
                }
            }
            // The slot was not what the record named: a newer save of this
            // folder's own, which the record names now, no slot at all, or
            // one a person removed. Go on from what it holds.
            retries += 1;
            if retries > MAX_SLOT_RETRIES {
                return Err(SaveError::SlotMoved);
            }
            (record, tree) = self.follow_record(&plan, record, tree).map_err(local)?;
            if tree != parent_tree && holds(record.as_ref(), plan.parent.as_deref(), &tree, origin)
            {
                return Ok(Settled::holding(&tree, None));
            }
        }
    }

    /// The record after a look at the slot, and `tree` built again for it
    /// (see [`kept_by_save`]) when it names another commit than `record`:
    /// a newer save of this folder's own holds what this save left out,
    /// and a slot a person removed leaves paths that are not saved again.
    fn follow_record(
        &self,
        plan: &Plan,
        record: Option<Record>,
        tree: String,
    ) -> Result<(Option<Record>, String)> {
        let now = read_record(&self.git, || self.working_set())?;
        let commit = |record: &Option<Record>| record.as_ref().map(|record| record.commit.clone());
        if commit(&now) == commit(&record) {
            return Ok((now, tree));
        }
        let tree = kept_by_save(
            &self.git,
            &tree,
            plan.parent.as_deref(),
            &plan.parent_tree,
            now.as_ref(),
            &plan.deferred,
        )?;
        Ok((now, tree))
    }

    /// A push of `commit` to `slot` whose answer was `error` (or an `ok`
    /// still to confirm): look at the slot. It holds `commit` only when the
    /// push landed, and then the record names it.
    fn after_push(
        &self,
        slot: &str,
        commit: &str,
        tree: &str,
        error: SaveError,
    ) -> Result<Settled, SaveError> {
        match self.see_slot(slot) {
            Ok((_, Some(tip))) if tip == commit => Ok(Settled::holding(tree, None)),
            Ok((Seen::Moved, _)) => Err(SaveError::SlotMoved),
            Ok(_) => Err(error),
            // The marker stays, so the next save looks again.
            Err(_) => Err(match error {
                SaveError::Unconfirmed => SaveError::Unreachable,
                other => other,
            }),
        }
    }

    /// Delete the slot `record` names under a lease on it, then the record:
    /// `true` once the slot is gone, `false` when it holds a newer save of
    /// this folder's own, which the record names now.
    fn delete_slot(&self, record: &Record) -> Result<bool, SaveError> {
        if !self.can_write {
            return Err(SaveError::NoCredential);
        }
        let local = |error: anyhow::Error| {
            warn!(error = %format!("{error:#}"), "a working save could not delete its slot locally");
            local_failure(&error)
        };
        let slot = self.slot().map_err(local)?;
        // Kept until canonical's answer is known: a slot found gone after
        // that is this folder's own delete, never a removal.
        self.git
            .ok(&[
                "update-ref",
                "-m",
                "instafy: working state delete",
                DELETING_REF,
                &record.commit,
            ])
            .map_err(local)?;
        let deleted = match delete_with_lease(&self.git, &self.remote, &slot, &record.commit) {
            Ok(deleted) => deleted.class,
            Err(error) => {
                warn!(error = %format!("{error:#}"), "a working save could not delete its slot");
                return self.after_delete(&slot, SaveError::Unreachable);
            }
        };
        match deleted {
            PushClass::Pushed => {
                self.git
                    .delete_ref(RECORD_REF, &record.commit)
                    .map_err(local)?;
                self.clear_markers().map_err(local)?;
                Ok(true)
            }
            PushClass::Ambiguous(_) => self.after_delete(&slot, SaveError::PushAmbiguous),
            PushClass::LostRace(_) => match self.see_slot(&slot)? {
                (Seen::Deleted | Seen::Recorded | Seen::Removed, None) => Ok(true),
                (Seen::Adopted, Some(_)) => Ok(false),
                (Seen::Moved, _) => Err(SaveError::SlotMoved),
                _ => Err(SaveError::PushAmbiguous),
            },
            PushClass::Rejected(_) | PushClass::PathRejected { .. } => {
                self.clear_markers().map_err(local)?;
                Err(SaveError::PushRejected)
            }
        }
    }

    /// A delete of the slot whose answer was `error`: look at the slot.
    fn after_delete(&self, slot: &str, error: SaveError) -> Result<bool, SaveError> {
        match self.see_slot(slot) {
            Ok((Seen::Deleted, _)) => Ok(true),
            Ok((Seen::Moved, _)) => Err(SaveError::SlotMoved),
            _ => Err(error),
        }
    }

    /// Whether `tree` holds every `unsaved` copy this stop holds back.
    pub(crate) fn held_back_within(&self, tree: &str) -> Result<bool> {
        for name in &self.held_back {
            let local = format!("{}/{name}", recovery::LOCAL_RECOVERY_ROOT);
            if let Some(rev) = self.git.commit_id(&local)? {
                if !holds_copy(&self.git, tree, &rev)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// This folder's slot ref.
    fn slot(&self) -> Result<String> {
        Ok(slot_ref(&self.working_set()?))
    }

    /// Look at the slot on canonical and bring the record in line with it
    /// (see [`Seen`]). Also returns the slot's tip.
    fn see_slot(&self, slot: &str) -> Result<(Seen, Option<String>), SaveError> {
        let shown =
            recovery::ls_remote(&self.git, &self.remote, &[slot.to_string()]).map_err(|error| {
                warn!(error = %format!("{error:#}"), "could not look at the working folder's save");
                SaveError::Unreachable
            })?;
        let tip = shown.get(slot).cloned();
        let seen = self.settle_markers(tip.as_deref()).map_err(|error| {
            warn!(error = %format!("{error:#}"), "could not record what the working folder's save holds");
            local_failure(&error)
        })?;
        Ok((seen, tip))
    }

    /// Given the slot's `tip` on canonical, move the record to what this
    /// folder knows it holds, and drop the markers of the push or delete
    /// whose answer this was.
    fn settle_markers(&self, tip: Option<&str>) -> Result<Seen> {
        let record = read_record(&self.git, || self.working_set())?;
        let recorded = record.as_ref().map(|record| record.commit.as_str());
        let (attempt, deleting) = markers(&self.git)?;
        let seen = match (tip, record.as_ref()) {
            (None, None) => Seen::Recorded,
            (None, Some(gone)) if deleting.as_deref() == Some(gone.commit.as_str()) => {
                self.git.delete_ref(RECORD_REF, &gone.commit)?;
                Seen::Deleted
            }
            (None, Some(gone)) => {
                dismiss(&self.git, gone)?;
                Seen::Removed
            }
            (Some(tip), _) if Some(tip) == recorded => Seen::Recorded,
            (Some(tip), _) if Some(tip) == attempt.as_deref() || self.wrote(tip)? => {
                self.git.update_ref(
                    RECORD_REF,
                    tip,
                    recorded,
                    "instafy: working state confirmed",
                )?;
                Seen::Adopted
            }
            (Some(_), _) => return Ok(Seen::Moved),
        };
        self.drop_markers(attempt.as_deref(), deleting.as_deref())?;
        Ok(seen)
    }

    /// Whether `commit` is a slot commit of this folder: it exists here, it
    /// keeps unsaved work, and a save of this folder made it (an earlier
    /// attempt whose marker a later one replaced).
    fn wrote(&self, commit: &str) -> Result<bool> {
        if self.git.commit_id(commit)?.is_none() {
            return Ok(false);
        }
        let Some(object) = self.git.read_objects(&[commit.to_string()])?.pop() else {
            return Ok(false);
        };
        let parsed = crate::recovery_view::parse_commit(&object.data);
        Ok(
            parsed.trailer(KIND_TRAILER) == Some(recovery::RecoveryKind::Unsaved.as_str())
                && parsed
                    .trailer(WORKING_SET_TRAILER)
                    .is_some_and(|id| Some(id) == self.working_set().ok().as_deref()),
        )
    }

    /// Forget the push or delete whose answer is now known.
    fn clear_markers(&self) -> Result<()> {
        let (attempt, deleting) = markers(&self.git)?;
        self.drop_markers(attempt.as_deref(), deleting.as_deref())
    }

    fn drop_markers(&self, attempt: Option<&str>, deleting: Option<&str>) -> Result<()> {
        for (marker, rev) in [(ATTEMPT_REF, attempt), (DELETING_REF, deleting)] {
            if let Some(rev) = rev {
                self.git.delete_ref(marker, rev)?;
            }
        }
        Ok(())
    }

    /// This folder's working-set id, read once per save.
    fn working_set(&self) -> Result<String> {
        if let Some(id) = self.working_set.get() {
            return Ok(id.clone());
        }
        let id = working_set_id(&self.git)?;
        let _ = self.working_set.set(id.clone());
        Ok(id)
    }

    /// The slot commit: `tree` on `parent`, by this origin, naming the
    /// paths it changes.
    fn slot_commit(&self, tree: &str, parent: Option<&str>, parent_tree: &str) -> Result<String> {
        let paths = changed_paths(&self.git, parent_tree, tree)?;
        let mut message = format!(
            "{SUBJECT}\n\nThe workspace has not saved these changes yet. This commit holds them\n\
             until a save publishes them, or someone restores or removes them.\n\n\
             {KIND_TRAILER}: {}\n{ORIGIN_TRAILER}: {}\n{WORKING_SET_TRAILER}: {}\n",
            recovery::RecoveryKind::Unsaved.as_str(),
            self.config.origin_id.as_hyphenated(),
            self.working_set()?
        );
        for path in paths.iter().take(MAX_TRAILER_PATHS) {
            message.push_str(&format!(
                "{PATH_TRAILER}: {}\n",
                path.replace(['\n', '\r'], " ")
            ));
        }
        let parents: Vec<&str> = parent.into_iter().collect();
        self.git.commit_tree(
            tree,
            &parents,
            &self.identity,
            &self.identity,
            message.as_bytes(),
        )
    }
}

/// What a slot step left.
struct Settled {
    /// The tree canonical holds for the folder now (the slot's, or the
    /// parent's when nothing is unsaved); `None` when it does not hold the
    /// snapshot.
    held: Option<String>,
    /// Unsaved paths, when the step decided it.
    unsaved: Option<usize>,
}

impl Settled {
    fn holding(tree: &str, unsaved: Option<usize>) -> Self {
        Self {
            held: Some(tree.to_string()),
            unsaved,
        }
    }
}

/// Whether `tree` holds every change the recovery commit `copy` makes to its
/// own parent, except paths a person removed from the slot that still hold
/// what they held then (they are left out of saves on purpose, see
/// [`DISMISSED_REF`]). A stop's `unsaved` copy that `tree` holds this way is
/// not needed once canonical holds `tree`.
pub(crate) fn holds_copy(git: &WorkspaceGit<'_>, tree: &str, copy: &str) -> Result<bool> {
    let Some(copy) = read_commit(git, copy)? else {
        return Ok(false);
    };
    let base = match copy.parent.as_deref() {
        Some(parent) => git.tree_id(parent)?,
        None => git.empty_tree()?,
    };
    let paths = changed_paths(git, &base, &copy.tree)?;
    if paths.is_empty() {
        return Ok(true);
    }
    let wanted = git.tree_entries(&copy.tree, &paths)?;
    let held = git.tree_entries(tree, &paths)?;
    // What a removed slot changed, at the paths this copy changes.
    let (removed_paths, removed) = match read_commit(git, DISMISSED_REF)? {
        Some(dismissed) => {
            let base = match dismissed.parent.as_deref() {
                Some(parent) => git.tree_id(parent)?,
                None => git.empty_tree()?,
            };
            let changed: BTreeSet<String> = changed_paths(git, &base, &dismissed.tree)?
                .into_iter()
                .filter(|path| paths.contains(path))
                .collect();
            let entries = git.tree_entries(&dismissed.tree, &paths)?;
            (changed, entries)
        }
        None => Default::default(),
    };
    let same = |a: Option<&crate::workspace_git::TreeEntry>,
                b: Option<&crate::workspace_git::TreeEntry>| match (a, b) {
        (Some(a), Some(b)) => a.mode == b.mode && a.oid == b.oid,
        (None, None) => true,
        _ => false,
    };
    Ok(paths.iter().all(|path| {
        same(wanted.get(path), held.get(path))
            || (removed_paths.contains(path) && same(wanted.get(path), removed.get(path)))
    }))
}

fn not_saved(memory: &WorkingMemory, error: SaveError) -> StopSave {
    StopSave {
        state: WorkingState {
            persisted_at: memory.persisted_at(),
            changed: true,
            error: Some(error.code().to_string()),
            ..WorkingState::default()
        },
        held: None,
    }
}

/// A finished save that needed no network call: the slot is current, or
/// nothing is unsaved and there is no slot.
pub(crate) fn settle_locally(
    plan: &Plan,
    memory: &WorkingMemory,
    git: &WorkspaceGit<'_>,
) -> WorkingState {
    let complete = plan.deferred.is_empty();
    let unsaved = plan
        .parent_tree(git)
        .and_then(|parent_tree| changed_paths(git, &parent_tree, &plan.tree))
        .map(|paths| paths.len())
        .unwrap_or_default();
    let durable = complete && plan.pending == 0;
    memory.confirm(plan.fingerprint, complete, durable, plan.more);
    WorkingState {
        unsaved: count(unsaved),
        local_only: count(plan.pending),
        persisted_at: memory.persisted_at(),
        durable,
        changed: false,
        error: None,
    }
}

/// A save that could not start.
pub(crate) fn refused(memory: &WorkingMemory, error: SaveError) -> WorkingState {
    not_saved(memory, error).state
}

/// What the first, local half of a route-level save decided.
pub(crate) enum Planned {
    /// Canonical has to be told: mint a credential and run this plan.
    Network(Plan),
    /// Answered without the network.
    Answered(WorkingState),
}

/// Take a route-level save's snapshot and settle it locally when canonical
/// needs nothing.
pub(crate) fn plan_route_save(
    publisher: &mut Publisher<'_>,
    reason: PersistReason,
    memory: &WorkingMemory,
    stop: &StopFlag,
) -> Planned {
    let origin = publisher.config.origin_id;
    let planned = publisher
        .plan_working_save(reason, Some(stop))
        .and_then(|plan| {
            let needs_network = plan.needs_network(&publisher.git, origin)?;
            Ok((plan, needs_network))
        });
    match planned {
        Ok((plan, true)) => Planned::Network(plan),
        Ok((plan, false)) => Planned::Answered(settle_locally(&plan, memory, &publisher.git)),
        Err(error) => {
            let failure = local_failure(&error);
            if failure != SaveError::Stopping {
                warn!(error = %format!("{error:#}"), "a working save could not take its snapshot");
            }
            Planned::Answered(refused(memory, failure))
        }
    }
}

/// Move the record of a slot a person removed to [`DISMISSED_REF`].
fn dismiss(git: &WorkspaceGit<'_>, record: &Record) -> Result<()> {
    info!("the working folder's save was removed or restored; its paths are not saved again until they change");
    let transaction = format!(
        "update {DISMISSED_REF} {commit}\ndelete {RECORD_REF} {commit}\n",
        commit = record.commit
    );
    git.ok_opts(
        &[
            "update-ref",
            "--stdin",
            "-m",
            "instafy: working state removed",
        ],
        &crate::workspace_git::RunOpts {
            stdin: Some(transaction.as_bytes()),
            ..Default::default()
        },
    )
}

/// `tree` with every path a removed slot changed whose content is still
/// what it held taking `parent`'s entry. Once none is left the dismissal is
/// forgotten.
fn without_dismissed(git: &WorkspaceGit<'_>, tree: &str, parent: Option<&str>) -> Result<String> {
    let Some(dismissed) = read_commit(git, DISMISSED_REF)? else {
        return Ok(tree.to_string());
    };
    let base = match dismissed.parent.as_deref() {
        Some(parent) => git.tree_id(parent)?,
        None => git.empty_tree()?,
    };
    let paths = changed_paths(git, &base, &dismissed.tree)?;
    let now = git.tree_entries(tree, &paths)?;
    let then = git.tree_entries(&dismissed.tree, &paths)?;
    let unchanged: Vec<String> = paths
        .into_iter()
        .filter(|path| match (now.get(path), then.get(path)) {
            (Some(now), Some(then)) => now.mode == then.mode && now.oid == then.oid,
            (None, None) => true,
            _ => false,
        })
        .collect();
    if unchanged.is_empty() {
        if let Err(error) = git.delete_ref(DISMISSED_REF, &dismissed.commit) {
            warn!(error = %format!("{error:#}"), "could not forget a removed working save");
        }
        return Ok(tree.to_string());
    }
    tree_with_entries_from(git, tree, parent, &unchanged)
}

/// `tree` without `path`, which canonical refused: the parent's entry, or
/// `main`'s when `main` changed that path since.
fn without_refused_path(
    git: &WorkspaceGit<'_>,
    tree: &str,
    parent: Option<&str>,
    main: Option<&str>,
    path: &str,
) -> Result<String> {
    let paths = [path.to_string()];
    let mut next = tree_with_entries_from(git, tree, parent, &paths)?;
    if next == tree {
        if let Some(main) = main {
            next = tree_with_entries_from(git, tree, Some(main), &paths)?;
        }
    }
    Ok(next)
}

/// How a route-level save holds its locks: a tick takes them only when
/// free, a turn-end save waits up to [`TURN_END_LOCK_WAIT`].
pub(crate) fn lock_wait(reason: PersistReason) -> Option<Duration> {
    match reason {
        PersistReason::Tick => None,
        PersistReason::TurnEnd | PersistReason::Stop => Some(TURN_END_LOCK_WAIT),
    }
}

/// The network budget of a route-level save.
pub(crate) fn budget(reason: PersistReason) -> Duration {
    match reason {
        PersistReason::Tick => TICK_BUDGET,
        PersistReason::TurnEnd | PersistReason::Stop => crate::publish::STOP_FLUSH_BUDGET,
    }
}

/// A [`Publisher`] for a save with `budget` on the network.
pub(crate) fn publisher<'a>(ctx: &PublishContext<'a>, budget: Duration) -> Publisher<'a> {
    let mut publisher = Publisher::new(ctx, budget);
    let deadline = Instant::now() + budget;
    publisher.git = publisher
        .git
        .with_stall_limit(STALL_SECONDS)
        .with_network_deadline(deadline);
    publisher.push_deadline = Some(deadline);
    publisher
}

#[cfg(test)]
#[path = "working_state_tests.rs"]
mod tests;
