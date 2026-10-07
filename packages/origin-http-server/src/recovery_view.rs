//! Reads of committed objects, with no work tree: the entries and files of a
//! commit, first-parent history, the recovery refs a person can review, and
//! the checks on the `rev` and `ref` values a client sends.
//!
//! Everything here runs through [`WorkspaceGit`], so it works the same on the
//! hosted gateway's bare mirrors and on a Desktop checkout's `.instafy/.git`,
//! and never reads a workspace file. Nothing here talks to the network except
//! [`list_remote_refs`], [`remote_tip`], [`fetch_refs`] and [`resolve`] of a
//! ref; callers decide when to fetch `main`.
//!
//! A ref a client may name (`?ref=`, restore, dismiss) is
//! `refs/instafy/recovery/<lower-case uuid>/<[0-9A-Za-z._-]+>`, and
//! `git check-ref-format` must accept it. Refs reach git only after
//! `--end-of-options` (or, for `check-ref-format`, which has no such option,
//! only once they are known to start with `refs/`). Recovery refs are always
//! read from the remote by their exact names; locally they are never refs of
//! their own names, which a case-insensitive disk could merge.

// The hosted gateway's reads and the recovery routes call these as they land;
// until then only the tests do.
#![cfg_attr(not(test), allow(dead_code))]

use axum::http::StatusCode;
use chrono::{FixedOffset, SecondsFormat, TimeZone as _};
use git_service::policy::RECOVERY_REF_ROOT;
use serde::Serialize;
use uuid::Uuid;

use crate::apply::normalize_relative_path;
use crate::error::OriginError;
use crate::git::{is_full_object_id, GitHistoryEntry, HistoryFormat};
use crate::paths::is_reserved_path;
use crate::recovery::{RecoveryKind, CONFLICT_TRAILER, KIND_TRAILER, PATH_TRAILER};
use crate::workspace_git::{RunOpts, WorkspaceGit};

/// Where one [`fetch_refs`] call holds the commits it fetched, under a
/// namespace of its own that it removes before it returns. Recovery refs
/// are never fetched into local refs named after them.
pub(crate) const FETCHED_REF_ROOT: &str = "refs/instafy/fetched";

/// The branch every read without `rev` or `ref` shows.
pub(crate) const MAIN_REF: &str = "refs/heads/main";

/// Longest name of a recovery ref (after its origin id): one file name.
const MAX_RECOVERY_NAME_BYTES: usize = 255;

/// Most items one recovery listing returns, newest first.
pub(crate) const MAX_RECOVERY_ITEMS: usize = 100;

/// Most paths one recovery item lists.
pub(crate) const MAX_RECOVERY_ITEM_PATHS: usize = 200;

/// Most commits one history page returns.
pub(crate) const MAX_HISTORY_PAGE: usize = 50;

/// Largest skip a history page passes to git, which reads it as an int.
const MAX_HISTORY_SKIP: usize = i32::MAX as usize;

/// Why a read could not name what it asked for.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ViewError {
    #[error("ref must be refs/instafy/recovery/<origin id>/<name>")]
    InvalidRef,
    #[error("send either rev or ref, not both")]
    RevAndRef,
    #[error("rev must be a full commit id")]
    InvalidRev,
    #[error("invalid file path")]
    InvalidPath,
    #[error("that version is not in this project's history")]
    RevNotFound,
    #[error("that ref does not exist")]
    RefNotFound,
    /// The canonical repository could not be reached (or refused) while a
    /// ref was listed or fetched: never answered from stale data.
    #[error("the saved history could not be reached: {0:#}")]
    Unreachable(anyhow::Error),
    #[error(transparent)]
    Git(#[from] anyhow::Error),
}

impl ViewError {
    /// The stable code clients see.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidRef | Self::RevAndRef => "invalid_ref",
            Self::InvalidRev => "invalid_rev",
            Self::InvalidPath => "invalid_path",
            // `not_found` is kept for a path absent from a commit's tree; a
            // ref that does not resolve is a version that is not there.
            Self::RevNotFound | Self::RefNotFound => "rev_not_found",
            Self::Unreachable(_) => "canonical_unreachable",
            Self::Git(_) => "internal",
        }
    }

    pub(crate) fn status(&self) -> StatusCode {
        match self {
            Self::InvalidRef | Self::RevAndRef | Self::InvalidRev | Self::InvalidPath => {
                StatusCode::BAD_REQUEST
            }
            Self::RevNotFound | Self::RefNotFound => StatusCode::NOT_FOUND,
            Self::Unreachable(_) => StatusCode::BAD_GATEWAY,
            Self::Git(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl From<ViewError> for OriginError {
    fn from(error: ViewError) -> Self {
        match error {
            ViewError::Git(error) => OriginError::internal(error.to_string()),
            other => OriginError::with_report(
                other.status(),
                other.code(),
                other.to_string(),
                serde_json::json!({}),
            ),
        }
    }
}

/// A recovery ref name that passed the rule:
/// `refs/instafy/recovery/<origin id>/<name>`, work an origin could not
/// save. A person may restore or dismiss it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RecoveryRef {
    name: String,
    /// The origin whose namespace the ref is in.
    origin: Uuid,
}

impl RecoveryRef {
    /// Check `name` against the rule without running git: a recovery ref
    /// is `refs/instafy/recovery/<lower-case hyphenated origin id>/<name>`,
    /// where `<name>` is up to 255 bytes of `[0-9A-Za-z._-]` that
    /// `git check-ref-format` would also accept (no leading `.`, no `..`, no
    /// trailing `.` or `.lock`, the latter in any letter case so it cannot
    /// alias a lock file on a case-insensitive disk).
    pub(crate) fn parse(name: &str) -> Result<Self, ViewError> {
        let recovery_prefix = format!("{RECOVERY_REF_ROOT}/");
        let rest = name
            .strip_prefix(&recovery_prefix)
            .ok_or(ViewError::InvalidRef)?;
        let (origin, last) = rest.split_once('/').ok_or(ViewError::InvalidRef)?;
        if !is_lower_case_uuid(origin) || !is_valid_recovery_name(last) {
            return Err(ViewError::InvalidRef);
        }
        let origin = Uuid::parse_str(origin).map_err(|_| ViewError::InvalidRef)?;
        // Every byte passed the rule above; git is given a copy built from
        // the bytes the rule allows, never the caller's own string.
        let name = copy_from_alphabet(name, REF_NAME_BYTES).ok_or(ViewError::InvalidRef)?;
        Ok(Self { name, origin })
    }

    /// [`Self::parse`], and `git check-ref-format` agrees.
    pub(crate) fn validate(git: &WorkspaceGit<'_>, name: &str) -> Result<Self, ViewError> {
        let parsed = Self::parse(name)?;
        // `check-ref-format` takes no `--end-of-options`; the name starts
        // with `refs/`, so git cannot read it as an option.
        if git.test(&["check-ref-format", parsed.as_str()])? {
            Ok(parsed)
        } else {
            Err(ViewError::InvalidRef)
        }
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.name
    }

    /// The origin whose namespace the ref is in.
    pub(crate) fn origin(&self) -> Uuid {
        self.origin
    }
}

fn is_lower_case_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn is_valid_recovery_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_RECOVERY_NAME_BYTES
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.to_ascii_lowercase().ends_with(".lock")
}

/// A commit id a client sends (`?rev=`, `baseRev`, a listed `rev`): exactly
/// 40 or 64 hex digits, returned in lower case, copied from the hex digits
/// (see [`copy_from_alphabet`]).
pub(crate) fn parse_rev(value: &str) -> Result<String, ViewError> {
    if matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        copy_from_alphabet(&value.to_ascii_lowercase(), LOWER_HEX_BYTES)
            .ok_or(ViewError::InvalidRev)
    } else {
        Err(ViewError::InvalidRev)
    }
}

/// Every byte a recovery ref name may hold (see [`RecoveryRef::parse`]).
const REF_NAME_BYTES: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-/";

/// The digits of a commit id in lower case.
const LOWER_HEX_BYTES: &[u8] = b"0123456789abcdef";

/// `value` rebuilt from `alphabet`: each byte is looked up there and the
/// copy holds the table's own byte, so a name or id a caller sent reaches
/// git's argument list only as bytes of `alphabet`. `None` when a byte is
/// not in `alphabet`.
pub(crate) fn copy_from_alphabet(value: &str, alphabet: &'static [u8]) -> Option<String> {
    value
        .bytes()
        .map(|byte| {
            alphabet
                .iter()
                .find(|allowed| **allowed == byte)
                .map(|allowed| char::from(*allowed))
        })
        .collect()
}

/// `value` in decimal, as a copy of the digits (see [`copy_from_alphabet`]):
/// a count a caller sent (a page size, how many to skip) reaches git's
/// arguments only as table bytes.
pub(crate) fn decimal(value: usize) -> String {
    copy_from_alphabet(&value.to_string(), b"0123456789").unwrap_or_default()
}

/// What a read names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReadAt {
    /// `main`.
    Main,
    /// One commit (`?rev=`).
    Rev(String),
    /// The tip of a recovery ref (`?ref=`).
    Ref(RecoveryRef),
}

impl ReadAt {
    /// From a request's `rev` and `ref` values; an empty value counts as
    /// absent, and sending both is an error.
    pub(crate) fn from_query(
        git: &WorkspaceGit<'_>,
        rev: Option<&str>,
        reference: Option<&str>,
    ) -> Result<Self, ViewError> {
        let rev = rev.filter(|value| !value.is_empty());
        let reference = reference.filter(|value| !value.is_empty());
        match (rev, reference) {
            (Some(_), Some(_)) => Err(ViewError::RevAndRef),
            (Some(rev), None) => Ok(Self::Rev(parse_rev(rev)?)),
            (None, Some(reference)) => Ok(Self::Ref(RecoveryRef::validate(git, reference)?)),
            (None, None) => Ok(Self::Main),
        }
    }
}

/// The commit `at` names: `main`'s tip here (`None` while `main` does not
/// exist), or the commit itself when it is readable here (see
/// [`readable_commit`]; [`ViewError::RevNotFound`] otherwise: a commit that
/// only `HEAD`, the reflog or another kind of ref reaches counts as not
/// here); neither makes a network call, so the caller fetches `main` first
/// where it needs to. A recovery
/// ref is resolved on `remote` by exactly its name and fetched
/// ([`ViewError::RefNotFound`] when the remote has no such ref): it is never
/// read from a local ref, which on a case-insensitive disk could stand for
/// another name.
pub(crate) fn resolve(
    git: &WorkspaceGit<'_>,
    remote: &str,
    at: &ReadAt,
) -> Result<Option<String>, ViewError> {
    match at {
        ReadAt::Main => Ok(git.commit_id(MAIN_REF)?),
        ReadAt::Rev(rev) => {
            if readable_commit(git, rev)? {
                Ok(Some(rev.clone()))
            } else {
                Err(ViewError::RevNotFound)
            }
        }
        ReadAt::Ref(reference) => Ok(Some(resolve_ref(git, remote, reference)?.commit)),
    }
}

/// `reference` on `remote`, by exactly its name, fetched: what it names
/// there (`tip`, which a lease on it uses and a read reports) and the
/// commit. [`ViewError::RefNotFound`] when the remote has no such ref,
/// [`ViewError::Unreachable`] when the remote cannot be listed or fetched.
pub(crate) fn resolve_ref(
    git: &WorkspaceGit<'_>,
    remote: &str,
    reference: &RecoveryRef,
) -> Result<FetchedRef, ViewError> {
    let Some(rev) = remote_tip(git, remote, reference).map_err(unreachable)? else {
        return Err(ViewError::RefNotFound);
    };
    match fetch_refs(git, remote, &[(reference.clone(), rev)])
        .map_err(unreachable)?
        .fetched
        .pop()
    {
        Some(fetched) => Ok(fetched),
        None => Err(ViewError::RefNotFound),
    }
}

/// A git failure while talking to the remote is [`ViewError::Unreachable`].
pub(crate) fn unreachable(error: ViewError) -> ViewError {
    match error {
        ViewError::Git(error) => ViewError::Unreachable(error),
        other => other,
    }
}

/// [`resolve`] of a `rev`, and when it is not readable here, once more after
/// fetching `remote`'s `main` into a fetch namespace of this call (so a
/// checkout whose own branch has not moved to a newer canonical commit can
/// still read it). [`ViewError::RevNotFound`] when neither has it; with no
/// `remote`, only what is here is read.
pub(crate) fn resolve_rev_fetching_main(
    git: &WorkspaceGit<'_>,
    remote: Option<&str>,
    rev: &str,
) -> Result<String, ViewError> {
    let rev = parse_rev(rev)?;
    if readable_commit(git, &rev)? {
        return Ok(rev);
    }
    let Some(remote) = remote else {
        return Err(ViewError::RevNotFound);
    };
    let listed = git
        .stdout(&["ls-remote", "--end-of-options", remote, MAIN_REF])
        .map_err(ViewError::Unreachable)?;
    if !parse_ls_remote(&listed)
        .iter()
        .any(|(name, _)| name == MAIN_REF)
    {
        return Err(ViewError::RevNotFound);
    }
    sweep_stale_fetches(git);
    let scratch = FetchScratch::new(git);
    let target = scratch.target(0);
    let refspec = format!("+{MAIN_REF}:{target}");
    git.ok(&[
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--end-of-options",
        remote,
        &refspec,
    ])
    .map_err(ViewError::Unreachable)?;
    // Read while the fetch ref holds the commits; dropping the scratch
    // removes the ref, never the objects.
    if readable_commit(git, &rev)? {
        Ok(rev)
    } else {
        Err(ViewError::RevNotFound)
    }
}

/// What a commit holds at exactly one path, whether or not a read serves
/// it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathKind {
    /// Nothing, or a path below a file, symlink or submodule: not in the
    /// tree.
    Absent,
    /// A regular file.
    File,
    /// A folder.
    Directory,
    /// A symlink, a submodule, a reserved path that is there, or another
    /// entry reads never serve.
    Unsupported,
}

/// What `commit` holds at `path` (in `normalize_relative_path` form; ""
/// is the root folder). Reads use it to tell a path that is absent (404
/// `not_found`) from one that holds something they never serve (404
/// `unsupported_entry`), which a client must never take for a delete.
pub(crate) fn path_kind_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
) -> Result<PathKind, ViewError> {
    let commit = parse_rev(commit)?;
    if path.is_empty() {
        return Ok(PathKind::Directory);
    }
    let path = checked_path(path)?;
    // The tree first: a reserved path that is there is hidden from reads
    // but never absent, as on the hosted gateway (`not_found` only when
    // the tree has no entry).
    let reserved = is_reserved_path(&path);
    let kind = git
        .entries_by_path(&commit, std::slice::from_ref(&path))?
        .remove(&path)
        .map(|entry| match (entry.mode.as_str(), entry.kind.as_str()) {
            _ if reserved => PathKind::Unsupported,
            ("100644" | "100755", "blob") => PathKind::File,
            ("040000", "tree") => PathKind::Directory,
            _ => PathKind::Unsupported,
        });
    Ok(kind.unwrap_or(PathKind::Absent))
}

/// Whether `rev` is a commit here that is complete: its tree is here, and
/// `main` or a branch or fetch ref reaches it. Git moves a ref only after
/// the fetch's connectivity check, so whatever a ref reaches has every
/// object it names, while a fetch that stopped partway can leave loose
/// objects (written commit first) that no ref reaches. Such a commit is not
/// readable, so the caller fetches.
///
/// At most three processes, and only the refs reads need are walked: `main`
/// first (one ancestry walk), then, only when `main` does not reach it,
/// `refs/heads/` and the fetch namespaces. Git before 2.49 tests every ref
/// for `--contains` whatever `--count` says, so tags and other namespaces
/// are never consulted; a smaller set can only make a commit "not here",
/// never let an incomplete one through.
fn readable_commit(git: &WorkspaceGit<'_>, rev: &str) -> Result<bool, ViewError> {
    let input = format!("{rev}\n{rev}^{{tree}}\n");
    let raw = git.stdout_opts(
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        &RunOpts {
            stdin: Some(input.as_bytes()),
            ..RunOpts::default()
        },
    )?;
    let lines: Vec<&str> = raw.lines().collect();
    let present = matches!(
        lines.as_slice(),
        [commit, tree] if *commit == format!("{rev} commit") && tree.ends_with(" tree")
    );
    if !present {
        return Ok(false);
    }
    let on_main = git.run(&["merge-base", "--is-ancestor", rev, MAIN_REF])?;
    if on_main.status.code() == Some(0) {
        return Ok(true);
    }
    let reaching = git.stdout(&[
        "for-each-ref",
        "--count=1",
        "--format=%(refname)",
        "--contains",
        rev,
        "refs/heads",
        FETCHED_REF_ROOT,
    ])?;
    Ok(!reaching.is_empty())
}

/// `(name, id)` of every local ref under the `namespaces`.
fn local_refs(
    git: &WorkspaceGit<'_>,
    namespaces: &[&str],
) -> Result<Vec<(String, String)>, ViewError> {
    let mut args = vec![
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "--end-of-options",
    ];
    args.extend(namespaces);
    let raw = git.stdout(&args)?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let (name, id) = line.split_once('\0')?;
            Some((name.to_string(), id.to_string()))
        })
        .collect())
}

/// Whether an entry is a file or a folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ObjectKind {
    File,
    Directory,
}

/// One entry of a commit's tree, as a listing shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ObjectEntry {
    /// The full path from the root.
    pub path: String,
    pub kind: ObjectKind,
    /// `100644` or `100755` for files, `040000` for folders.
    pub mode: String,
    pub oid: String,
    /// The blob's size (files only).
    pub size: Option<u64>,
}

impl ObjectEntry {
    pub(crate) fn executable(&self) -> bool {
        self.mode == "100755"
    }
}

/// What a commit holds at a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TreeRead {
    /// Nothing that may be shown.
    Missing,
    /// A regular file: its one entry.
    File(ObjectEntry),
    /// A folder: its listed children (possibly none, when every child is
    /// hidden).
    Directory(Vec<ObjectEntry>),
}

/// What a commit holds at `path` ("" is the root): a folder's children or a
/// file's own entry. Symlinks, submodules and reserved paths are never
/// shown: such a path, or anything that would lie below one, is
/// [`TreeRead::Missing`].
pub(crate) fn read_tree_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
) -> Result<TreeRead, ViewError> {
    let commit = parse_rev(commit)?;
    if path.is_empty() {
        let raw = git.bytes(&["ls-tree", "-l", "-z", "--end-of-options", &commit])?;
        return Ok(TreeRead::Directory(listed_children("", &raw)?));
    }
    let path = checked_path(path)?;
    if is_reserved_path(&path) {
        return Ok(TreeRead::Missing);
    }
    let Some(entry) = entry_at(git, &commit, &path)? else {
        return Ok(TreeRead::Missing);
    };
    match entry.kind {
        ObjectKind::File => Ok(TreeRead::File(entry)),
        ObjectKind::Directory => {
            let raw = git.bytes(&["ls-tree", "-l", "-z", "--end-of-options", &entry.oid])?;
            Ok(TreeRead::Directory(listed_children(&path, &raw)?))
        }
    }
}

/// A regular file's bytes at a path of a commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BlobRead {
    /// No regular file that may be shown is there.
    Missing,
    /// The file is larger than the caller allows; nothing was read.
    TooLarge { oid: String, size: u64 },
    Found {
        oid: String,
        mode: String,
        data: Vec<u8>,
    },
}

/// The bytes of the regular file at `path` in `commit` when it is at most
/// `max_bytes` long. Symlinks, submodules, folders and reserved paths are
/// [`BlobRead::Missing`].
pub(crate) fn read_blob_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
    max_bytes: u64,
) -> Result<BlobRead, ViewError> {
    let commit = parse_rev(commit)?;
    let path = checked_path(path)?;
    if is_reserved_path(&path) {
        return Ok(BlobRead::Missing);
    }
    let Some(entry) = entry_at(git, &commit, &path)? else {
        return Ok(BlobRead::Missing);
    };
    let (ObjectKind::File, Some(size)) = (entry.kind, entry.size) else {
        return Ok(BlobRead::Missing);
    };
    if size > max_bytes {
        return Ok(BlobRead::TooLarge {
            oid: entry.oid,
            size,
        });
    }
    let object = git
        .read_objects(std::slice::from_ref(&entry.oid))?
        .pop()
        .ok_or_else(|| anyhow::anyhow!("blob {} was not read", entry.oid))?;
    if object.kind != "blob" {
        return Ok(BlobRead::Missing);
    }
    Ok(BlobRead::Found {
        oid: entry.oid,
        mode: entry.mode,
        data: object.data,
    })
}

/// Why a read shows nothing at a path of a commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Absence {
    /// The tree has no entry at the path.
    Absent,
    /// A folder is there (a file read finds no file).
    Directory,
    /// Something reads never show is there: a symlink, a submodule, or a
    /// reserved path.
    Hidden,
}

/// What `commit` holds at exactly `path` when a read showed nothing there.
/// Only [`Absence::Absent`] means the path is not in the tree, so only it
/// may be reported as a missing path: a client could otherwise turn a link
/// or a submodule into a delete.
pub(crate) fn absence_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
) -> Result<Absence, ViewError> {
    let commit = parse_rev(commit)?;
    let path = checked_path(path)?;
    let Some(found) = git
        .entries_by_path(&commit, std::slice::from_ref(&path))?
        .remove(&path)
    else {
        return Ok(Absence::Absent);
    };
    Ok(match shown_entry(git, found)? {
        Some(entry) if entry.kind == ObjectKind::Directory && !is_reserved_path(&path) => {
            Absence::Directory
        }
        _ => Absence::Hidden,
    })
}

/// `path` as `normalize_relative_path` writes it, or an error: reads take
/// paths in that form only, so one path never names two entries.
fn checked_path(path: &str) -> Result<String, ViewError> {
    // Git takes paths as arguments, which cannot hold a NUL.
    if path.contains('\0') {
        return Err(ViewError::InvalidPath);
    }
    match normalize_relative_path(path) {
        Some(normalized) if normalized == path => Ok(normalized),
        _ => Err(ViewError::InvalidPath),
    }
}

/// The shown entry at exactly `path` in `commit`, if any. The path reaches
/// git only on stdin ([`WorkspaceGit::entries_by_path`]).
fn entry_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
) -> Result<Option<ObjectEntry>, ViewError> {
    match git
        .entries_by_path(commit, &[path.to_string()])?
        .remove(path)
    {
        Some(entry) => shown_entry(git, entry),
        None => Ok(None),
    }
}

/// `entry` as a listing shows it: a regular file with its size, or a
/// folder; `None` for anything else (symlinks, submodules). A regular file
/// whose size git could not read (its object is missing or corrupt) is an
/// error, never a path that is not there: a client would take that for a
/// deleted file.
fn shown_entry(
    git: &WorkspaceGit<'_>,
    entry: crate::workspace_git::TreeEntry,
) -> Result<Option<ObjectEntry>, ViewError> {
    match (entry.mode.as_str(), entry.kind.as_str()) {
        ("100644" | "100755", "blob") => {
            let size = git
                .object_sizes(std::slice::from_ref(&entry.oid))?
                .pop()
                .flatten()
                .map(|(_, size)| size);
            let Some(size) = size else {
                return Err(ViewError::Git(anyhow::anyhow!(
                    "the object of {} ({}) is missing or corrupt",
                    entry.path,
                    entry.oid
                )));
            };
            Ok(Some(ObjectEntry {
                path: entry.path,
                kind: ObjectKind::File,
                mode: entry.mode,
                oid: entry.oid,
                size: Some(size),
            }))
        }
        ("040000", "tree") => Ok(Some(ObjectEntry {
            path: entry.path,
            kind: ObjectKind::Directory,
            mode: entry.mode,
            oid: entry.oid,
            size: None,
        })),
        _ => Ok(None),
    }
}

/// The shown entries of one `ls-tree -l -z` listing of a folder at
/// `parent` ("" for the root).
fn listed_children(parent: &str, raw: &[u8]) -> Result<Vec<ObjectEntry>, ViewError> {
    Ok(parse_ls_tree_long(raw)?
        .into_iter()
        .filter_map(|(name, entry)| {
            let mut entry = entry?;
            entry.path = if parent.is_empty() {
                name
            } else {
                format!("{parent}/{name}")
            };
            (!is_reserved_path(&entry.path)).then_some(entry)
        })
        .collect())
}

/// `(path, entry)` for each record of `ls-tree -l -z` output, where the
/// entry is `None` for anything that is neither a regular file nor a folder
/// (symlinks, submodules). A regular file whose size git could not read
/// (`BAD`: its object is missing or corrupt) is an error, never a path that
/// is not there: a client would take that for a deleted file.
fn parse_ls_tree_long(raw: &[u8]) -> Result<Vec<(String, Option<ObjectEntry>)>, ViewError> {
    let mut parsed = Vec::new();
    for record in raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if let Some(record) = parse_ls_tree_long_record(record)? {
            parsed.push(record);
        }
    }
    Ok(parsed)
}

fn parse_ls_tree_long_record(
    record: &[u8],
) -> Result<Option<(String, Option<ObjectEntry>)>, ViewError> {
    let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
        return Ok(None);
    };
    let (Ok(meta), Ok(path)) = (
        std::str::from_utf8(&record[..tab]),
        std::str::from_utf8(&record[tab + 1..]),
    ) else {
        return Ok(None);
    };
    let path = path.to_string();
    let mut fields = meta.split_whitespace();
    let (Some(mode), Some(object_type), Some(oid), Some(size)) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return Ok(None);
    };
    let (mode, oid) = (mode.to_string(), oid.to_string());
    let entry = match (mode.as_str(), object_type) {
        ("100644" | "100755", "blob") => {
            let Ok(size) = size.parse() else {
                return Err(ViewError::Git(anyhow::anyhow!(
                    "the object of {path} ({oid}) is missing or corrupt"
                )));
            };
            Some(ObjectEntry {
                path: path.clone(),
                kind: ObjectKind::File,
                mode,
                oid,
                size: Some(size),
            })
        }
        ("040000", "tree") => Some(ObjectEntry {
            path: path.clone(),
            kind: ObjectKind::Directory,
            mode,
            oid,
            size: None,
        }),
        _ => None,
    };
    Ok(Some((path, entry)))
}

/// Up to `limit` (at most [`MAX_HISTORY_PAGE`]) commits of `head`'s
/// first-parent chain after skipping `skip`, newest first, each with its
/// first parent and parent count.
///
/// Ids and parents come from `rev-list`, which prints nothing but ids, so no
/// commit text can change them; the other fields come from a `git log` of
/// the same walk with framing no commit can forge, and its ids must match.
pub(crate) fn first_parent_history(
    git: &WorkspaceGit<'_>,
    head: &str,
    limit: usize,
    skip: usize,
) -> Result<Vec<GitHistoryEntry>, ViewError> {
    walk_history(
        git,
        head,
        limit.min(MAX_HISTORY_PAGE),
        skip,
        HistoryWalk::FirstParent,
    )
}

/// Which commits a history page lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HistoryWalk {
    /// The first-parent chain: the versions of `main`.
    FirstParent,
    /// Every commit `head` reaches, in `git log`'s default order: a
    /// checkout's own history, as single-tenant origins list it.
    All,
}

/// One page of history and whether older commits follow it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HistoryPage {
    pub entries: Vec<GitHistoryEntry>,
    pub has_more: bool,
}

/// Up to `limit` (at most [`MAX_HISTORY_PAGE`]) commits of `walk` from
/// `head` after skipping `skip`, newest first, each with its first parent
/// and parent count, and whether another commit follows the page (one more
/// is walked to tell).
pub(crate) fn history_page(
    git: &WorkspaceGit<'_>,
    head: &str,
    limit: usize,
    skip: usize,
    walk: HistoryWalk,
) -> Result<HistoryPage, ViewError> {
    let limit = limit.min(MAX_HISTORY_PAGE);
    if limit == 0 {
        return Ok(HistoryPage::default());
    }
    let mut entries = walk_history(git, head, limit + 1, skip, walk)?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    Ok(HistoryPage { entries, has_more })
}

/// Up to `count` commits of `walk` from `head` after `skip`, as
/// [`first_parent_history`] reads them.
fn walk_history(
    git: &WorkspaceGit<'_>,
    head: &str,
    count: usize,
    skip: usize,
    walk: HistoryWalk,
) -> Result<Vec<GitHistoryEntry>, ViewError> {
    let head = parse_rev(head)?;
    // Git reads the count as an int: a larger skip is past any history.
    if count == 0 || skip > MAX_HISTORY_SKIP {
        return Ok(Vec::new());
    }
    let max_count = decimal(count);
    let skip = decimal(skip);
    let mut walk_args = Vec::new();
    if walk == HistoryWalk::FirstParent {
        walk_args.push("--first-parent");
    }
    walk_args.extend(["--max-count", &max_count, "--skip", &skip]);
    let mut args = vec!["rev-list", "--parents"];
    args.extend(&walk_args);
    args.extend(["--end-of-options", &head, "--"]);
    let listed = git.stdout(&args)?;
    let mut chain = Vec::new();
    for line in listed.lines() {
        let mut ids = line.split(' ');
        let commit = ids.next().unwrap_or_default();
        let parents: Vec<&str> = ids.collect();
        if !is_full_object_id(commit) || !parents.iter().all(|id| is_full_object_id(id)) {
            return Err(anyhow::anyhow!("rev-list printed {line:?}").into());
        }
        chain.push((
            commit.to_string(),
            parents.first().map(|id| id.to_string()),
            parents.len(),
        ));
    }

    let format = HistoryFormat::new();
    let pretty = format.pretty_arg();
    let mut args = vec!["log"];
    args.extend(&walk_args);
    args.extend([
        "--date=iso-strict",
        &pretty,
        "--end-of-options",
        &head,
        "--",
    ]);
    let mut entries = format.parse(&git.stdout(&args)?);
    if entries.len() != chain.len()
        || entries
            .iter()
            .zip(&chain)
            .any(|(entry, (commit, _, _))| entry.commit != *commit)
    {
        return Err(anyhow::anyhow!("the history of {head} changed while it was read").into());
    }
    for (entry, (_, first_parent, parents)) in entries.iter_mut().zip(chain) {
        entry.first_parent = first_parent;
        entry.parent_count = Some(parents);
    }
    Ok(entries)
}

/// `(ref, rev)` for every recovery ref on `remote` that passes the rule;
/// any other name there is left out. Names that differ only in
/// letter case are separate entries, each with its own commit.
pub(crate) fn list_remote_refs(
    git: &WorkspaceGit<'_>,
    remote: &str,
) -> Result<Vec<(RecoveryRef, String)>, ViewError> {
    Ok(remote_names(git, remote)?
        .into_iter()
        .filter_map(|(name, rev)| Some((RecoveryRef::parse(&name).ok()?, parse_rev(&rev).ok()?)))
        .collect())
}

/// The commit `reference` names on `remote`, or `None` when it is gone.
pub(crate) fn remote_tip(
    git: &WorkspaceGit<'_>,
    remote: &str,
    reference: &RecoveryRef,
) -> Result<Option<String>, ViewError> {
    let raw = git.stdout(&[
        "ls-remote",
        "--refs",
        "--end-of-options",
        remote,
        reference.as_str(),
    ])?;
    Ok(parse_ls_remote(&raw)
        .into_iter()
        .find(|(name, _)| name == reference.as_str())
        .and_then(|(_, rev)| parse_rev(&rev).ok()))
}

/// Every `(name, rev)` under the recovery namespace on `remote`, whether
/// or not it passes the rule.
fn remote_names(git: &WorkspaceGit<'_>, remote: &str) -> Result<Vec<(String, String)>, ViewError> {
    let recovery = format!("{RECOVERY_REF_ROOT}/*");
    let raw = git.stdout(&["ls-remote", "--refs", "--end-of-options", remote, &recovery])?;
    Ok(parse_ls_remote(&raw))
}

fn parse_ls_remote(raw: &str) -> Vec<(String, String)> {
    raw.lines()
        .filter_map(|line| {
            let (rev, name) = line.split_once('\t')?;
            Some((name.trim().to_string(), rev.trim().to_string()))
        })
        .collect()
}

/// One fetched recovery ref.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FetchedRef {
    pub reference: RecoveryRef,
    /// The id the ref names on the remote: the commit, or an annotated tag
    /// of it. A lease on the ref (dismiss, restore) uses this id.
    pub tip: String,
    /// The commit, now here and complete.
    pub commit: String,
}

/// What [`fetch_refs`] did with each ref it was asked for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct FetchedRefs {
    /// Fetched: each ref with the commit it names on the remote.
    pub fetched: Vec<FetchedRef>,
    /// Not on the remote (any more), or naming neither a commit nor an
    /// annotated tag of one: dismissed, restored or never there.
    pub missing: Vec<RecoveryRef>,
}

/// How many times [`fetch_refs`] lists the remote again and retries after
/// a fetch fails or brings something other than what was listed.
const FETCH_RETRIES: usize = 2;

/// A fetch namespace older than this belongs to a call that died: no call
/// runs this long, so it is removed.
const FETCH_SCRATCH_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Fetch the commits `listed` names on `remote` (each `(ref, rev)` as
/// [`list_remote_refs`] or [`remote_tip`] reported it), by exactly those
/// names, in one fetch.
///
/// The remote names stay data: each commit is fetched into a ref of a
/// namespace made for this call under [`FETCHED_REF_ROOT`] (digits,
/// lower-case hex and `-`, so no two of them can share a file on a
/// case-insensitive disk), read back with one `for-each-ref`, and the
/// namespace is removed before returning, on every path. Two remote names
/// that differ only in letter case therefore each get their own commit, and
/// no local ref is ever named after a remote one.
///
/// A fetched commit must be the one listed: when the name is gone, git's
/// own guessing can fetch another ref (`refs/heads/<name>`) instead. When
/// the fetch fails, or brings something else, the remote is listed once
/// more: names that are gone (dismissed, retired) are reported missing,
/// names that moved are fetched at their new commit, and the rest are
/// fetched again in one fetch, at most [`FETCH_RETRIES`] times. Only a
/// remote that cannot be reached, or a fetch that keeps failing, is an
/// error. Namespaces that calls which died left behind are removed first.
pub(crate) fn fetch_refs(
    git: &WorkspaceGit<'_>,
    remote: &str,
    listed: &[(RecoveryRef, String)],
) -> Result<FetchedRefs, ViewError> {
    let mut outcome = FetchedRefs::default();
    if listed.is_empty() {
        return Ok(outcome);
    }
    // Housekeeping: it never fails the call.
    sweep_stale_fetches(git);
    let scratch = FetchScratch::new(git);
    // (index, ref, the commit the remote names it at)
    let mut pending: Vec<(usize, &RecoveryRef, String)> = listed
        .iter()
        .enumerate()
        .map(|(index, (reference, rev))| (index, reference, rev.clone()))
        .collect();
    // What each ref fetched as listed.
    let mut found: Vec<Option<ScratchRef>> = vec![None; listed.len()];
    let mut attempt = 0;
    loop {
        let targets: Vec<(&RecoveryRef, String)> = pending
            .iter()
            .map(|(index, reference, _)| (*reference, scratch.target(*index)))
            .collect();
        let result = fetch_into(git, remote, &targets);
        if result.is_ok() {
            let here = scratch.read()?;
            pending.retain(|(index, _, rev)| match here.get(&scratch.target(*index)) {
                Some(fetched) if fetched.id == *rev => {
                    found[*index] = Some(fetched.clone());
                    false
                }
                _ => true,
            });
            if pending.is_empty() {
                break;
            }
        }
        if attempt == FETCH_RETRIES {
            let reason = match result {
                Err(error) => error.to_string(),
                Ok(()) => {
                    "the refs kept changing on the remote while they were fetched".to_string()
                }
            };
            return Err(anyhow::anyhow!(
                "could not fetch {} recovery refs in {} attempts: {reason}",
                pending.len(),
                attempt + 1
            )
            .into());
        }
        attempt += 1;
        let now: std::collections::HashMap<String, String> =
            remote_names(git, remote)?.into_iter().collect();
        pending.retain_mut(
            |(index, reference, rev)| match now.get(reference.as_str()) {
                Some(current) => {
                    *rev = current.clone();
                    true
                }
                None => {
                    outcome.missing.push(listed[*index].0.clone());
                    false
                }
            },
        );
        if pending.is_empty() {
            break;
        }
    }

    // A commit, or an annotated tag of one (the shard accepts both, nested
    // tags included). Git before 2.45 peels `%(*objectname)` one level
    // only; tags still pointing at tags are peeled in one more process.
    let nested: Vec<String> = found
        .iter()
        .flatten()
        .filter(|fetched| fetched.kind == "tag" && fetched.peeled_kind == "tag")
        .map(|fetched| fetched.peeled.clone())
        .collect();
    let peeled = peel_to_commits(git, &nested)?;
    for (index, (reference, _)) in listed.iter().enumerate() {
        let Some(fetched) = found[index].take() else {
            continue;
        };
        let commit = match (fetched.kind.as_str(), fetched.peeled_kind.as_str()) {
            ("commit", _) => Some(fetched.id.clone()),
            ("tag", "commit") => Some(fetched.peeled.clone()),
            ("tag", "tag") => peeled.get(&fetched.peeled).cloned(),
            _ => None,
        };
        match commit {
            Some(commit) => outcome.fetched.push(FetchedRef {
                reference: reference.clone(),
                tip: fetched.id,
                commit,
            }),
            None => outcome.missing.push(reference.clone()),
        }
    }
    Ok(outcome)
}

/// The commit each of `tags` (tag ids) finally names, with one
/// `cat-file --batch-check` over `<id>^{commit}`; a tag that names no
/// commit is left out. No process when `tags` is empty.
fn peel_to_commits(
    git: &WorkspaceGit<'_>,
    tags: &[String],
) -> Result<std::collections::HashMap<String, String>, ViewError> {
    let mut peeled = std::collections::HashMap::new();
    if tags.is_empty() {
        return Ok(peeled);
    }
    let input: String = tags
        .iter()
        .map(|tag| format!("{tag}^{{commit}}\n"))
        .collect();
    let raw = git.stdout_opts(
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        &RunOpts {
            stdin: Some(input.as_bytes()),
            ..RunOpts::default()
        },
    )?;
    for (tag, line) in tags.iter().zip(raw.lines()) {
        if let Some(commit) = line.strip_suffix(" commit") {
            if is_full_object_id(commit) {
                peeled.insert(tag.clone(), commit.to_string());
            }
        }
    }
    Ok(peeled)
}

/// Remove every fetch namespace older than [`FETCH_SCRATCH_STALE_AFTER`]:
/// a call that died left it. Only names this server makes
/// (`<unix seconds>-<32 hex>/<n>`) are ever removed; anything else under the
/// root is left alone. Called by [`fetch_refs`] and when the server starts, under the same
/// age rule. Best effort: it never fails, and logs only counts. Several
/// calls may sweep the same refs at once: a ref another call already
/// removed is not an error. Returns how many stale refs it removed.
pub(crate) fn sweep_stale_fetches(git: &WorkspaceGit<'_>) -> usize {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let Ok(listed) = local_refs(git, &[FETCHED_REF_ROOT]) else {
        tracing::warn!(target: "origin_recovery", "could not list fetch refs to sweep");
        return 0;
    };
    let stale: Vec<(String, String)> = listed
        .into_iter()
        .filter(|(name, _)| {
            fetch_ref_started(name).is_some_and(|started| {
                now.saturating_sub(started) > FETCH_SCRATCH_STALE_AFTER.as_secs()
            })
        })
        .collect();
    if delete_refs(git, &stale).is_err() {
        tracing::warn!(
            target: "origin_recovery",
            stale = stale.len(),
            "could not remove stale fetch refs"
        );
        return 0;
    }
    stale.len()
}

/// When the fetch namespace a ref named `<root>/<unix seconds>-<32 hex>/<n>`
/// was made (its seconds); `None` for any other name.
fn fetch_ref_started(name: &str) -> Option<u64> {
    let rest = name.strip_prefix(FETCHED_REF_ROOT)?.strip_prefix('/')?;
    let (namespace, index) = rest.split_once('/')?;
    let (seconds, token) = namespace.split_once('-')?;
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    let hex = token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    (digits(seconds) && hex && digits(index))
        .then(|| seconds.parse().ok())
        .flatten()
}

/// Delete the fetch refs named in `refs` (`(name, id)`; any name that is not
/// one is skipped) in one transaction and one attempt. Best effort, and it
/// never holds its caller up: `--no-deref` deletes a symbolic ref itself,
/// never the ref it points to; no old id is given, so a ref that is already
/// gone is not an error; and a held lock (a concurrent delete, or one left
/// by a process that was killed) is waited for briefly, then the refs are
/// left for the next sweep. Lock files are never removed.
fn delete_refs(git: &WorkspaceGit<'_>, refs: &[(String, String)]) -> Result<(), ViewError> {
    let mut transaction = String::new();
    for (name, _) in refs {
        if fetch_ref_started(name).is_some() {
            transaction.push_str(&format!("delete {name}\n"));
        }
    }
    if transaction.is_empty() {
        return Ok(());
    }
    // A delete locks `packed-refs`, which concurrent deletes also lock for a
    // moment: wait at most a second for it, and a tenth of a second for a
    // loose ref lock, in a single attempt.
    git.ok_opts(
        &["update-ref", "--no-deref", "--stdin"],
        &RunOpts {
            stdin: Some(transaction.as_bytes()),
            env: vec![
                ("GIT_CONFIG_COUNT", "2".into()),
                ("GIT_CONFIG_KEY_0", "core.packedRefsTimeout".into()),
                ("GIT_CONFIG_VALUE_0", DELETE_PACKED_REFS_WAIT_MS.into()),
                ("GIT_CONFIG_KEY_1", "core.filesRefLockTimeout".into()),
                ("GIT_CONFIG_VALUE_1", DELETE_REF_LOCK_WAIT_MS.into()),
            ],
            single_attempt: true,
            ..RunOpts::default()
        },
    )?;
    Ok(())
}

/// How long a fetch-ref delete waits for `packed-refs.lock`, in ms.
const DELETE_PACKED_REFS_WAIT_MS: &str = "1000";

/// How long a fetch-ref delete waits for a loose ref lock, in ms.
const DELETE_REF_LOCK_WAIT_MS: &str = "100";

/// What a fetch ref names: the object, its type, and for an annotated tag
/// the object the tag names.
#[derive(Clone, Debug)]
struct ScratchRef {
    id: String,
    kind: String,
    peeled: String,
    peeled_kind: String,
}

/// The namespace one [`fetch_refs`] call fetches into,
/// `<FETCHED_REF_ROOT>/<unix seconds>-<random hex>`; dropping it deletes
/// every ref under it.
struct FetchScratch<'g, 'a> {
    git: &'g WorkspaceGit<'a>,
    namespace: String,
}

impl<'g, 'a> FetchScratch<'g, 'a> {
    fn new(git: &'g WorkspaceGit<'a>) -> Self {
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            git,
            namespace: format!("{FETCHED_REF_ROOT}/{started}-{}", Uuid::new_v4().simple()),
        }
    }

    fn target(&self, index: usize) -> String {
        format!("{}/{index}", self.namespace)
    }

    /// Each ref here, with what it names, read with one `for-each-ref`.
    fn read(&self) -> Result<std::collections::HashMap<String, ScratchRef>, ViewError> {
        let raw = self.git.stdout(&[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
            "--end-of-options",
            &self.namespace,
        ])?;
        Ok(raw
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\0');
                let name = fields.next()?.to_string();
                let fetched = ScratchRef {
                    id: fields.next()?.to_string(),
                    kind: fields.next()?.to_string(),
                    peeled: fields.next().unwrap_or_default().to_string(),
                    peeled_kind: fields.next().unwrap_or_default().to_string(),
                };
                Some((name, fetched))
            })
            .collect())
    }
}

impl Drop for FetchScratch<'_, '_> {
    fn drop(&mut self) {
        let removed = local_refs(self.git, &[self.namespace.as_str()])
            .and_then(|refs| delete_refs(self.git, &refs));
        if let Err(error) = removed {
            tracing::warn!(target: "origin_recovery", %error, "could not remove fetched refs");
        }
    }
}

/// Fetch each `(remote name, local target)` pair in one command.
fn fetch_into(
    git: &WorkspaceGit<'_>,
    remote: &str,
    targets: &[(&RecoveryRef, String)],
) -> Result<(), ViewError> {
    let refspecs: Vec<String> = targets
        .iter()
        .map(|(reference, target)| format!("+{}:{target}", reference.as_str()))
        .collect();
    let mut args: Vec<&str> = vec![
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--end-of-options",
        remote,
    ];
    args.extend(refspecs.iter().map(String::as_str));
    git.ok(&args)?;
    Ok(())
}

/// What a person sees about one recovery ref.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ItemKind {
    Conflict,
    Unpublished,
    Unsaved,
    Stale,
    Unknown,
}

impl From<RecoveryKind> for ItemKind {
    fn from(kind: RecoveryKind) -> Self {
        match kind {
            RecoveryKind::Conflict => Self::Conflict,
            RecoveryKind::Unpublished => Self::Unpublished,
            RecoveryKind::Unsaved => Self::Unsaved,
            RecoveryKind::Stale => Self::Stale,
        }
    }
}

/// One entry of the unsaved work list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryItem {
    #[serde(rename = "ref")]
    pub reference: String,
    /// The id the ref names: a lease on the ref (dismiss, restore) uses it.
    pub rev: String,
    /// The commit (the same as `rev` unless the ref names an annotated tag).
    pub commit: String,
    pub kind: ItemKind,
    pub subject: String,
    /// The committer date, ISO 8601.
    pub date: Option<String>,
    /// The origin whose namespace the ref is in.
    pub origin: Uuid,
    /// For a conflict, the conflicted paths only; otherwise the paths the
    /// commit names as kept.
    pub paths: Vec<String>,
    /// Where the work left `main`: review and restore compare against it.
    pub base: Option<String>,
    /// The newest commit on `main` that restored this ref (see
    /// [`mark_restored`]); a ref holding work that could not be restored
    /// stays after a restore, so this is how a restored one is shown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_rev: Option<String>,
    #[serde(skip)]
    timestamp: i64,
}

/// Describe `refs` (as [`fetch_refs`] fetched them), newest first, at most
/// [`MAX_RECOVERY_ITEMS`]; a ref whose commit is not here is left out.
/// `main` (when it exists) gives each listed item its `base`.
pub(crate) fn describe(
    git: &WorkspaceGit<'_>,
    refs: &[FetchedRef],
    main: Option<&str>,
) -> Result<Vec<RecoveryItem>, ViewError> {
    // A ref whose commit is not here (it vanished before it could be
    // fetched) is left out rather than failing the list.
    let commits: Vec<String> = refs.iter().map(|fetched| fetched.commit.clone()).collect();
    let present: Vec<&FetchedRef> = refs
        .iter()
        .zip(git.object_sizes(&commits)?)
        .filter(|(_, found)| matches!(found, Some((kind, _)) if kind == "commit"))
        .map(|(entry, _)| entry)
        .collect();
    let commits: Vec<String> = present
        .iter()
        .map(|fetched| fetched.commit.clone())
        .collect();
    let objects = git.read_objects(&commits)?;
    let mut items = Vec::with_capacity(present.len());
    for (fetched, object) in present.into_iter().zip(objects) {
        let reference = &fetched.reference;
        let commit = parse_commit(&object.data);
        let kind = commit
            .trailer(KIND_TRAILER)
            .and_then(recovery_kind)
            .or_else(|| {
                let name = reference.as_str().rsplit('/').next().unwrap_or_default();
                crate::recovery::kind_of_name(name)
            })
            .map(ItemKind::from)
            .unwrap_or(ItemKind::Unknown);
        let path_trailer = if kind == ItemKind::Conflict {
            CONFLICT_TRAILER
        } else {
            PATH_TRAILER
        };
        let paths = commit
            .trailers
            .iter()
            .filter(|(key, value)| key == path_trailer && !value.is_empty())
            .map(|(_, value)| value.clone())
            .take(MAX_RECOVERY_ITEM_PATHS)
            .collect();
        items.push(RecoveryItem {
            reference: reference.as_str().to_string(),
            rev: fetched.tip.clone(),
            commit: fetched.commit.clone(),
            kind,
            subject: commit.subject,
            date: commit.date,
            origin: reference.origin(),
            paths,
            base: None,
            restored_rev: None,
            timestamp: commit.timestamp,
        });
    }
    items.sort_by(|a, b| {
        b.timestamp
            .cmp(&a.timestamp)
            .then_with(|| a.reference.cmp(&b.reference))
    });
    // The cap comes before the one merge-base per item.
    items.truncate(MAX_RECOVERY_ITEMS);
    if let Some(main) = main {
        for item in &mut items {
            item.base = git.merge_base(&item.commit, main)?;
        }
    }
    Ok(items)
}

/// The reason a restore gives for a path the person chose to keep as the
/// saved version has it.
pub(crate) const KEPT: &str = "kept";

/// A path a restore left as `main` (or the checkout) has it, and why:
/// [`KEPT`], or the name of the reason it may never be restored here
/// ([`crate::publish_policy::RejectReason::name`]). Desktop and the hosted
/// gateway both answer `notRestored` as a list of these, by path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NotRestored {
    pub path: String,
    pub reason: &'static str,
}

/// Why a restore leaves a change of the work out, if it does: refused first
/// (`refused`: why it may never be restored here), so a path that can never
/// come back is refused even below a kept folder, and only then [`KEPT`]
/// when the person kept it (`kept`). Only the person's own choices let a
/// recovery ref go once the rest is on `main`, so the order decides whether
/// work is removed on their behalf. Desktop and the gateway decide by it.
pub(crate) fn left_out_reason(
    refused: Option<crate::publish_policy::RejectReason>,
    kept: bool,
) -> Option<&'static str> {
    match refused {
        Some(reason) => Some(reason.name()),
        None => kept.then_some(KEPT),
    }
}

/// The trailer a restore commit names the ref it restored with. Only the
/// origin itself writes it (as the commit's committer), in exactly
/// [`restore_commit_message`]; saves drop it, like every `Instafy-` trailer
/// the origin trusts, from the text callers give
/// ([`without_origin_trailers`]).
pub(crate) const RESTORED_FROM_TRAILER: &str = "Instafy-Restored-From";

/// The subject of a restore commit.
const RESTORE_COMMIT_SUBJECT: &str = "Restore unsaved work";

/// The whole message of the commit that restores `reference`.
pub(crate) fn restore_commit_message(reference: &str) -> String {
    format!("{RESTORE_COMMIT_SUBJECT}\n\n{RESTORED_FROM_TRAILER}: {reference}\n")
}

/// The ref a restore commit's message names, when the message is exactly
/// [`restore_commit_message`] of a recovery ref; any other text
/// (another subject, more lines, a second trailer) is not a restore.
fn restored_from(message: &str) -> Option<&str> {
    let reference = message
        .strip_prefix(RESTORE_COMMIT_SUBJECT)?
        .strip_prefix("\n\n")?
        .strip_prefix(RESTORED_FROM_TRAILER)?
        .strip_prefix(": ")?
        .strip_suffix('\n')?;
    RecoveryRef::parse(reference).ok().map(|_| reference)
}

/// The prefix of every trailer key the origin or the gateway writes itself
/// and reads back from history (`Instafy-Restored-From`,
/// `Instafy-Apply-Key`, `Instafy-Apply-Fingerprint`, the recovery
/// trailers), in any letter case.
const ORIGIN_TRAILER_PREFIX: &str = "instafy-";

/// The one `Instafy-` trailer callers write: history only shows it.
const CALLER_TRAILER: &str = "Instafy-Resolved-By";

/// Trailer lines git writes itself. With one of them, a trailer block may
/// hold up to three other lines per trailer.
const GIT_GENERATED_TRAILERS: [&str; 2] = ["Signed-off-by: ", "(cherry picked from commit "];

/// The line `git commit --verbose` cuts the message off at.
const SCISSORS_LINE: &str = "# ------------------------ >8 ------------------------";

/// Rounds [`without_origin_trailers`] looks for a trailer block in. A
/// message whose paragraphs keep turning into trailer blocks is not prose:
/// past the bound, every `Instafy-` trailer line below the subject goes at
/// once, so a long one never costs a round per paragraph.
const TRAILER_ROUNDS: usize = 8;

/// `message`, trimmed as every save trims it, without the trailers the
/// origin and the gateway write and trust. A line goes only when git reads
/// it in the message's trailer block ([`trailer_block`]) and it is a
/// `Key: value` line whose key starts with `Instafy-` in any letter case,
/// once its control characters (other than tab) and leading blanks are set
/// aside. Every other line stays: the subject, other paragraphs, a last
/// paragraph git does not read as trailers, text that only starts with
/// `Instafy-` ("Instafy-style buttons"), a key git would not parse (a
/// Unicode look-alike), and `Instafy-Resolved-By`, which callers write and
/// history only shows.
///
/// Text a caller gives a save goes through this before the origin commits
/// it as itself (and canonical history is shared with the gateway), so a
/// save can never pass for a restore or an import receipt. The block is
/// looked for in the text as given and with its control characters set
/// aside, each with and without the `---` line that ends a message for
/// `git interpret-trailers` (but not for `%(trailers)`). Dropping a block's
/// lines can leave the paragraph above it last, so this repeats until
/// nothing more goes (see [`TRAILER_ROUNDS`]).
pub(crate) fn without_origin_trailers(message: &str) -> String {
    let mut message = message.trim().to_string();
    for round in 0..=TRAILER_ROUNDS {
        let lines: Vec<&str> = message.split('\n').collect();
        let shown: Vec<String> = lines
            .iter()
            .map(|line| {
                line.chars()
                    .filter(|ch| *ch == '\t' || !ch.is_control())
                    .collect()
            })
            .collect();
        let mut origin = vec![false; lines.len()];
        if round < TRAILER_ROUNDS {
            let shown_lines: Vec<&str> = shown.iter().map(String::as_str).collect();
            for view in [&lines, &shown_lines] {
                for divider in [false, true] {
                    for index in trailer_block(view, divider) {
                        origin[index] |= is_origin_trailer(&shown[index]);
                    }
                }
            }
        } else {
            // The subject line is never in a trailer block, in any view.
            for index in 1..lines.len() {
                origin[index] = is_origin_trailer(&shown[index]);
            }
        }
        if !origin.contains(&true) {
            break;
        }
        let kept: Vec<&str> = lines
            .iter()
            .zip(&origin)
            .filter(|(_, origin)| !**origin)
            .map(|(line, _)| *line)
            .collect();
        let next = kept.join("\n").trim().to_string();
        message = next;
    }
    message
}

/// Whether `shown` (a line with its control characters set aside) is a
/// trailer the origin or the gateway trusts: leading blanks aside, a
/// `Key: value` line whose key starts with `Instafy-` and is not
/// `Instafy-Resolved-By`.
fn is_origin_trailer(shown: &str) -> bool {
    trailer_key(shown.trim_start_matches([' ', '\t'])).is_some_and(|key| {
        key.get(..ORIGIN_TRAILER_PREFIX.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(ORIGIN_TRAILER_PREFIX))
            && !key.eq_ignore_ascii_case(CALLER_TRAILER)
    })
}

/// The key of `line` when git reads the line as a trailer: ASCII letters,
/// digits and `-`, then optional blanks, then `:` (git's
/// `find_separator`).
fn trailer_key(line: &str) -> Option<&str> {
    let end = line
        .bytes()
        .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        .count();
    let rest = line[end..].trim_start_matches([' ', '\t']);
    (end > 0 && rest.starts_with(':')).then(|| &line[..end])
}

/// The lines of a message (`lines`, each read as ending in a newline, as a
/// committed message does) git's trailer parser reads as its trailer
/// block, with git's default settings (`#` comments, `:` separators, no
/// configured trailers), as `trailer.c` and `commit.c` find it since git
/// 2.34. The message ends at the first `---` line when `divider` is set,
/// at the scissors line, and before a trailing run of comments, empty
/// lines and an old `Conflicts:` list. The block is its last paragraph
/// after the subject, when all of that paragraph's lines are trailers (or
/// lines continuing one), or at least a quarter of them with one git
/// writes itself (`Signed-off-by: `). Empty when there is none.
fn trailer_block(lines: &[&str], divider: bool) -> std::ops::Range<usize> {
    let is_space = |byte: u8| matches!(byte, b' ' | b'\t' | b'\n' | b'\r');
    let is_blank = |line: &str| line.bytes().all(is_space);
    let is_comment = |line: &str| line.starts_with('#');
    let mut end = lines.len();
    if divider {
        if let Some(at) = lines.iter().position(|line| {
            line.strip_prefix("---")
                .is_some_and(|rest| rest.bytes().next().is_none_or(is_space))
        }) {
            end = at;
        }
    }
    let cutoff = lines[..end]
        .iter()
        .position(|line| line.starts_with(SCISSORS_LINE))
        .unwrap_or(end);
    // The trailing run; like git, one that starts at the first line is
    // not counted.
    let mut run = None;
    let mut conflicts = false;
    for (index, line) in lines[..cutoff].iter().enumerate() {
        if is_comment(line) || line.is_empty() || *line == "Conflicts:" {
            conflicts |= *line == "Conflicts:";
            if run.is_none() && index > 0 {
                run = Some(index);
            }
        } else if conflicts && line.starts_with('\t') {
            // A path in the old conflicts list.
        } else if run.is_some() {
            run = None;
            conflicts = false;
        }
    }
    let lines = &lines[..run.unwrap_or(cutoff)];
    let title = lines
        .iter()
        .position(|line| !is_comment(line) && is_blank(line))
        .unwrap_or(lines.len());
    let (mut trailers, mut others, mut continuing) = (0usize, 0usize, 0usize);
    let mut recognized = false;
    let mut only_blank = true;
    for index in (title..lines.len()).rev() {
        let line = lines[index];
        if is_comment(line) {
            others += continuing;
            continuing = 0;
        } else if is_blank(line) {
            if only_blank {
                continue;
            }
            others += continuing;
            let block = (recognized && trailers * 3 >= others) || (trailers > 0 && others == 0);
            return if block { index + 1..lines.len() } else { 0..0 };
        } else {
            only_blank = false;
            if GIT_GENERATED_TRAILERS
                .iter()
                .any(|prefix| line.starts_with(prefix))
            {
                trailers += 1;
                continuing = 0;
                recognized = true;
            } else if trailer_key(line).is_some() {
                trailers += 1;
                continuing = 0;
            } else if line.bytes().next().is_some_and(is_space) {
                continuing += 1;
            } else {
                others += 1 + continuing;
                continuing = 0;
            }
        }
    }
    0..0
}

/// Most restore commits one walk reads.
const MAX_RESTORE_COMMITS: usize = 500;

/// How long before a listed item was made a restore of it is looked for:
/// clocks of the machines that made the commits may differ.
const RESTORE_CLOCK_SLACK_SECONDS: i64 = 24 * 60 * 60;

/// The committer addresses whose restore commits count as restores, on
/// Desktop and on the gateway alike: this server's own (`own`), Desktop's
/// origin identity ([`DEFAULT_ORIGIN_AUTHOR_EMAIL`], which Desktop commits
/// under) and the gateway's ([`DEFAULT_GATEWAY_AUTHOR_EMAIL`]), in lower
/// case, without repeats. One space's canonical history is shared by both
/// modes, so a restore made in one shows as restored in the other and is
/// never recorded twice. A caller can never write a restore commit under
/// either address: both servers drop every `Instafy-` trailer git reads
/// from the messages they commit for callers ([`without_origin_trailers`]).
///
/// [`DEFAULT_ORIGIN_AUTHOR_EMAIL`]: crate::config::DEFAULT_ORIGIN_AUTHOR_EMAIL
/// [`DEFAULT_GATEWAY_AUTHOR_EMAIL`]: crate::config::DEFAULT_GATEWAY_AUTHOR_EMAIL
pub(crate) fn restore_committers(own: &str) -> Vec<String> {
    let mut committers: Vec<String> = Vec::new();
    for email in [
        own,
        crate::config::DEFAULT_ORIGIN_AUTHOR_EMAIL,
        crate::config::DEFAULT_GATEWAY_AUTHOR_EMAIL,
    ] {
        let email = email.trim().to_ascii_lowercase();
        if !email.is_empty() && !committers.contains(&email) {
            committers.push(email);
        }
    }
    committers
}

/// Give every item a commit `main` reaches restored its `restored_rev`: the
/// newest commit whose whole message is [`restore_commit_message`] of the
/// item's ref and whose committer is one of `committers`
/// ([`restore_committers`]). A ref a restore keeps (it holds work that may
/// never be saved here) so shows as restored. The
/// origin commits saves as itself too, but drops the trailer from their
/// text ([`without_origin_trailers`]), so no save message is the restore
/// message. The walk covers all of `main`'s history since the oldest item
/// was made, not only its first parents (a Desktop publish merges the
/// branch's restore commit in as a second parent), with one `rev-list`
/// and one `cat-file --batch`.
pub(crate) fn mark_restored(
    git: &WorkspaceGit<'_>,
    items: &mut [RecoveryItem],
    main: Option<&str>,
    committers: &[String],
) -> Result<(), ViewError> {
    let (Some(main), Some(oldest)) = (main, items.iter().map(|item| item.timestamp).min()) else {
        return Ok(());
    };
    let main = parse_rev(main)?;
    let ids = restore_candidates(git, &main, oldest)?;
    let mut restored: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (id, reference) in restore_commits(git, &ids, committers)? {
        // Newest first: the first commit seen for a ref wins.
        restored.entry(reference).or_insert(id);
    }
    for item in items.iter_mut() {
        item.restored_rev = restored.get(&item.reference).cloned();
    }
    Ok(())
}

/// Ids of the commits `tip` reaches since `made_at` (less the clock slack)
/// with a line holding `Instafy-Restored-From: `, newest first, at most
/// [`MAX_RESTORE_COMMITS`]; [`restore_commits`] decides which are restores.
fn restore_candidates(
    git: &WorkspaceGit<'_>,
    tip: &str,
    made_at: i64,
) -> Result<Vec<String>, ViewError> {
    let grep = format!("--grep={RESTORED_FROM_TRAILER}: ");
    let max_count = format!("--max-count={MAX_RESTORE_COMMITS}");
    let since = format!(
        "--max-age={}",
        made_at.saturating_sub(RESTORE_CLOCK_SLACK_SECONDS).max(0)
    );
    let listed = git.stdout(&[
        "rev-list",
        "--fixed-strings",
        &grep,
        &max_count,
        &since,
        "--end-of-options",
        tip,
        "--",
    ])?;
    Ok(listed
        .lines()
        .map(str::trim)
        .filter(|id| is_full_object_id(id))
        .map(str::to_string)
        .collect())
}

/// `(id, ref)` of each of `ids` that is a restore commit
/// ([`restore_commit_message`] of `ref`) committed by one of `committers`
/// (lower case, as [`restore_committers`] gives them), in the order given,
/// with one `cat-file --batch`.
fn restore_commits(
    git: &WorkspaceGit<'_>,
    ids: &[String],
    committers: &[String],
) -> Result<Vec<(String, String)>, ViewError> {
    let mut found = Vec::new();
    for (id, object) in ids.iter().zip(git.read_objects(ids)?) {
        let trusted = committer_of(&object.data)
            .is_some_and(|committer| committers.iter().any(|email| *email == committer));
        if object.kind != "commit" || !trusted {
            continue;
        }
        let text = String::from_utf8_lossy(&object.data);
        let Some((_, message)) = text.split_once("\n\n") else {
            continue;
        };
        if let Some(reference) = restored_from(message) {
            found.push((id.clone(), reference.to_string()));
        }
    }
    Ok(found)
}

/// The committer's address of a raw commit, in lower case.
fn committer_of(data: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(data);
    let headers = text.split("\n\n").next()?;
    let committer = headers
        .lines()
        .find_map(|line| line.strip_prefix("committer "))?;
    let open = committer.rfind('<')?;
    let close = committer.rfind('>')?;
    (open < close).then(|| committer[open + 1..close].trim().to_ascii_lowercase())
}

/// The answer to a dismissal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Dismissed {
    /// This call removed the ref.
    pub dismissed: bool,
    /// The ref was already gone.
    pub missing: bool,
}

/// Dismiss unsaved work for everyone: delete `reference` on `remote` while
/// it still names `rev` (the tip the person saw), with a lease, so work
/// that changed since is never removed. A ref that names something else
/// now is 409 `recovery_ref_moved`; a ref already gone is `{dismissed: false,
/// missing: true}`. The handle needs write access to `remote`.
pub(crate) fn dismiss(
    git: &WorkspaceGit<'_>,
    remote: &str,
    reference: &RecoveryRef,
    rev: &str,
) -> Result<Dismissed, OriginError> {
    let rev = parse_rev(rev)?;
    let mut pushed = false;
    for _ in 0..2 {
        match remote_tip(git, remote, reference).map_err(unreachable)? {
            None => {
                return Ok(Dismissed {
                    dismissed: pushed,
                    missing: !pushed,
                })
            }
            Some(tip) if tip != rev => return Err(recovery_ref_moved(Some(&tip))),
            Some(_) => {}
        }
        let result = crate::push::delete_with_lease(git, remote, reference.as_str(), &rev)
            .map_err(ViewError::Unreachable)?;
        match result.class {
            crate::push::PushClass::Pushed => {
                return Ok(Dismissed {
                    dismissed: true,
                    missing: false,
                })
            }
            // Someone moved or removed it first: look again.
            crate::push::PushClass::LostRace(_) => {}
            // The answer was lost: the removal may have happened.
            crate::push::PushClass::Ambiguous(_) => pushed = true,
            crate::push::PushClass::Rejected(detail) => {
                return Err(OriginError::with_report(
                    StatusCode::BAD_GATEWAY,
                    "push_rejected",
                    format!("the saved history refused the removal: {detail}"),
                    serde_json::json!({}),
                ))
            }
            crate::push::PushClass::PathRejected { path, .. } => {
                return Err(OriginError::with_report(
                    StatusCode::BAD_GATEWAY,
                    "push_rejected",
                    format!("the saved history refused the removal ({path})"),
                    serde_json::json!({}),
                ))
            }
        }
    }
    Err(recovery_ref_moved(None))
}

/// 409 `recovery_ref_moved`: the ref no longer names what the person saw
/// (`rev`: what it names now, if anything).
pub(crate) fn recovery_ref_moved(rev: Option<&str>) -> OriginError {
    OriginError::with_report(
        StatusCode::CONFLICT,
        "recovery_ref_moved",
        "this unsaved work changed since it was listed; refresh the list",
        match rev {
            Some(rev) => serde_json::json!({ "rev": rev }),
            None => serde_json::json!({ "missing": true }),
        },
    )
}

/// A recovery ref's own kind; any other value is not one.
fn recovery_kind(value: &str) -> Option<RecoveryKind> {
    [
        RecoveryKind::Conflict,
        RecoveryKind::Unpublished,
        RecoveryKind::Unsaved,
        RecoveryKind::Stale,
    ]
    .into_iter()
    .find(|kind| kind.as_str() == value)
}

/// The parts of a raw commit object a listing shows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ParsedCommit {
    pub parents: Vec<String>,
    pub subject: String,
    /// Committer date, ISO 8601 (as `%cI` prints it).
    pub date: Option<String>,
    /// Committer time, seconds since the epoch (0 when unreadable).
    pub timestamp: i64,
    /// `(key, value)` lines of the message's last paragraph, in order.
    pub trailers: Vec<(String, String)>,
}

impl ParsedCommit {
    /// The last value of `key`.
    pub(crate) fn trailer(&self, key: &str) -> Option<&str> {
        self.trailers
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}

/// Parse a raw commit object (`cat-file commit` bytes).
pub(crate) fn parse_commit(data: &[u8]) -> ParsedCommit {
    let text = String::from_utf8_lossy(data);
    let (headers, message) = text.split_once("\n\n").unwrap_or((&text, ""));
    let mut parsed = ParsedCommit::default();
    for line in headers.lines() {
        if let Some(parent) = line.strip_prefix("parent ") {
            parsed.parents.push(parent.trim().to_string());
        } else if let Some(committer) = line.strip_prefix("committer ") {
            if let Some((timestamp, date)) = identity_date(committer) {
                parsed.timestamp = timestamp;
                parsed.date = Some(date);
            }
        }
    }
    // As `%s` prints it: the first paragraph on one line.
    let title = message.split("\n\n").next().unwrap_or_default();
    parsed.subject = title.lines().map(str::trim).collect::<Vec<_>>().join(" ");
    let body = message.trim_end();
    if let Some((_, last)) = body.rsplit_once("\n\n") {
        parsed.trailers = last
            .lines()
            .filter_map(|line| {
                let (key, value) = line.split_once(": ")?;
                let is_key = !key.is_empty()
                    && key
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
                is_key.then(|| (key.to_string(), value.trim().to_string()))
            })
            .collect();
    }
    parsed
}

/// `(epoch seconds, ISO 8601)` from the end of an author or committer line:
/// `Name <email> 1700000000 +0100`.
fn identity_date(identity: &str) -> Option<(i64, String)> {
    let after_email = &identity[identity.rfind('>')? + 1..];
    let mut fields = after_email.split_whitespace();
    let timestamp: i64 = fields.next()?.parse().ok()?;
    let zone = fields.next()?;
    if zone.len() != 5 {
        return None;
    }
    let sign = match zone.as_bytes()[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hours: i32 = zone[1..3].parse().ok()?;
    let minutes: i32 = zone[3..5].parse().ok()?;
    let offset = FixedOffset::east_opt(sign * (hours * 3600 + minutes * 60))?;
    let date = offset.timestamp_opt(timestamp, 0).single()?;
    Some((timestamp, date.to_rfc3339_opts(SecondsFormat::Secs, false)))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use axum::response::IntoResponse as _;

    use super::*;
    use crate::test_support::{
        commit_files, git_in, ig, init_workspace_repo, with_mode, with_raw_entry, ws_git,
    };
    use crate::workspace_git::GitIdentity;

    const ORIGIN: &str = "0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60";

    fn tempdir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    /// An empty bare repository made by the server's handle.
    fn bare(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        WorkspaceGit::init_bare(&path).unwrap();
        path
    }

    fn fetch(git: &WorkspaceGit<'_>, remote: &Path, refspec: &str) {
        git.ok(&[
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            remote.to_str().unwrap(),
            refspec,
        ])
        .unwrap();
    }

    /// A tree holding `files`, written through `git`.
    fn tree(git: &WorkspaceGit<'_>, files: &[(&str, &str)]) -> String {
        let scratch = crate::workspace_git::temp_index_dir(git).unwrap();
        let index = scratch.path().join("index");
        let opts = RunOpts {
            index_file: Some(&index),
            ..RunOpts::default()
        };
        git.ok_opts(&["read-tree", "--empty"], &opts).unwrap();
        for (path, content) in files {
            let blob = git
                .stdout_opts(
                    &["hash-object", "-w", "--stdin"],
                    &RunOpts {
                        stdin: Some(content.as_bytes()),
                        ..RunOpts::default()
                    },
                )
                .unwrap();
            let cacheinfo = format!("100644,{blob},{path}");
            git.ok_opts(&["update-index", "--add", "--cacheinfo", &cacheinfo], &opts)
                .unwrap();
        }
        git.stdout_opts(&["write-tree"], &opts).unwrap()
    }

    fn commit(
        git: &WorkspaceGit<'_>,
        tree: &str,
        parents: &[&str],
        epoch: i64,
        message: &str,
    ) -> String {
        let identity =
            GitIdentity::new("Instafy", "origin@instafy.dev").at(Some(format!("{epoch} +0130")));
        git.commit_tree(tree, parents, &identity, &identity, message.as_bytes())
            .unwrap()
    }

    /// `(ref, tip)` of each fetched ref, as a listing pairs them.
    fn pairs(fetched: &[FetchedRef]) -> Vec<(RecoveryRef, String)> {
        fetched
            .iter()
            .map(|fetched| (fetched.reference.clone(), fetched.tip.clone()))
            .collect()
    }

    /// Refs that name their commits directly, as fetched.
    fn as_fetched(refs: &[(RecoveryRef, String)]) -> Vec<FetchedRef> {
        refs.iter()
            .map(|(reference, rev)| FetchedRef {
                reference: reference.clone(),
                tip: rev.clone(),
                commit: rev.clone(),
            })
            .collect()
    }

    #[test]
    fn the_ref_rule_accepts_only_recovery_names() {
        let recovery =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-conflict-0123456789ab");
        let parsed = RecoveryRef::parse(&recovery).unwrap();
        assert_eq!(parsed.as_str(), recovery);
        assert_eq!(parsed.origin(), Uuid::parse_str(ORIGIN).unwrap());

        let long = format!("refs/instafy/recovery/{ORIGIN}/{}", "a".repeat(256));
        let upper = format!("refs/instafy/recovery/{}/name", ORIGIN.to_ascii_uppercase());
        let mut rejected: Vec<String> = [
            "",
            "refs/heads/main",
            "--upload-pack=x",
            "refs/instafy/recovery",
            "refs/instafy/recovery/",
            "refs/instafy/recovery/0b7c2f1058a44e6b9f0e2d1c3b4a5f60/name",
            "refs/instafy/recovery/not-a-uuid/name",
            "refs/instafy/local-recovery/name",
            "refs/instafy/other/name",
        ]
        .map(str::to_string)
        .to_vec();
        rejected.extend([
            format!("refs/instafy/recovery/{ORIGIN}"),
            format!("refs/instafy/recovery/{ORIGIN}/"),
            format!("refs/instafy/recovery/{ORIGIN}/a/b"),
            format!("refs/INSTAFY/recovery/{ORIGIN}/name"),
            format!(" refs/instafy/recovery/{ORIGIN}/name"),
            upper,
            long,
        ]);
        for name in [
            ".hidden",
            "trailing.",
            "a..b",
            "name.lock",
            "name.LOCK",
            "sp ace",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[",
            "a\\b",
            "a@{1}",
            "caf\u{e9}",
            "a\nb",
        ] {
            rejected.push(format!("refs/instafy/recovery/{ORIGIN}/{name}"));
        }
        for rejected in &rejected {
            assert!(
                matches!(RecoveryRef::parse(rejected), Err(ViewError::InvalidRef)),
                "{rejected:?}"
            );
        }
    }

    #[test]
    fn git_agrees_with_every_name_the_rule_accepts() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        for name in [
            format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-unsaved-0123456789ab"),
            format!("refs/instafy/recovery/{ORIGIN}/node-1.local-0123abcd"),
            format!("refs/instafy/recovery/{ORIGIN}/-x"),
            format!("refs/instafy/recovery/{ORIGIN}/{}", "a".repeat(255)),
        ] {
            assert_eq!(RecoveryRef::validate(&git, &name).unwrap().as_str(), name);
        }
        assert!(matches!(
            RecoveryRef::validate(&git, &format!("refs/instafy/recovery/{ORIGIN}/a..b")),
            Err(ViewError::InvalidRef)
        ));
    }

    #[test]
    fn restores_by_desktop_and_the_gateway_count_in_both() {
        for (own, expected) in [
            (
                "origin@instafy.dev",
                vec!["origin@instafy.dev", "gateway@instafy.dev"],
            ),
            (
                " Gateway@Instafy.dev ",
                vec!["gateway@instafy.dev", "origin@instafy.dev"],
            ),
            (
                "Bot@Example.com",
                vec![
                    "bot@example.com",
                    "origin@instafy.dev",
                    "gateway@instafy.dev",
                ],
            ),
        ] {
            assert_eq!(restore_committers(own), expected, "{own}");
        }
    }

    #[test]
    fn names_and_ids_reach_git_as_copies_of_the_allowed_bytes() {
        let name = format!("refs/instafy/recovery/{ORIGIN}/Unsaved_0.x-1");
        assert_eq!(
            copy_from_alphabet(&name, REF_NAME_BYTES).as_deref(),
            Some(name.as_str())
        );
        assert_eq!(RecoveryRef::parse(&name).unwrap().as_str(), name);
        assert_eq!(
            copy_from_alphabet("0123456789abcdef", LOWER_HEX_BYTES).as_deref(),
            Some("0123456789abcdef")
        );
        for outside in ["a b", "a\0b", "a\nb", "a:b", "a~b", "é", "ABC"] {
            assert_eq!(
                copy_from_alphabet(outside, LOWER_HEX_BYTES),
                None,
                "{outside:?}"
            );
        }
        for outside in ["refs/a b", "refs/a\0b", "refs/a:b", "refs/a^b", "refs/é"] {
            assert_eq!(
                copy_from_alphabet(outside, REF_NAME_BYTES),
                None,
                "{outside:?}"
            );
        }
    }

    #[test]
    fn revs_are_full_commit_ids_and_a_read_names_one_thing() {
        let sha1 = "0123456789abcdef0123456789abcdef01234567";
        let sha256 = "0123456789abcdef".repeat(4);
        assert_eq!(parse_rev(sha1).unwrap(), sha1);
        assert_eq!(parse_rev(&sha256).unwrap(), sha256);
        assert_eq!(parse_rev(&sha1.to_ascii_uppercase()).unwrap(), sha1);
        for rejected in [
            "",
            "HEAD",
            "main",
            "-x",
            "--output=/tmp/x",
            &sha1[..39],
            &format!("{sha1}0"),
            "0123456789abcdef0123456789abcdef0123456g",
            &format!("{sha1}^"),
        ] {
            assert!(
                matches!(parse_rev(rejected), Err(ViewError::InvalidRev)),
                "{rejected:?}"
            );
        }

        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let reference = format!("refs/instafy/recovery/{ORIGIN}/name");
        assert_eq!(ReadAt::from_query(&git, None, None).unwrap(), ReadAt::Main);
        assert_eq!(
            ReadAt::from_query(&git, Some(""), Some("")).unwrap(),
            ReadAt::Main
        );
        assert_eq!(
            ReadAt::from_query(&git, Some(sha1), None).unwrap(),
            ReadAt::Rev(sha1.to_string())
        );
        assert_eq!(
            ReadAt::from_query(&git, None, Some(&reference)).unwrap(),
            ReadAt::Ref(RecoveryRef::parse(&reference).unwrap())
        );
        assert!(matches!(
            ReadAt::from_query(&git, Some(sha1), Some(&reference)),
            Err(ViewError::RevAndRef)
        ));
        assert!(matches!(
            ReadAt::from_query(&git, Some("main"), None),
            Err(ViewError::InvalidRev)
        ));
        assert!(matches!(
            ReadAt::from_query(&git, None, Some("refs/heads/main")),
            Err(ViewError::InvalidRef)
        ));

        // Missing things: `main` and a commit locally, a ref on the remote.
        let remote = bare(&root, "remote.git");
        let remote = remote.to_str().unwrap();
        assert_eq!(resolve(&git, remote, &ReadAt::Main).unwrap(), None);
        assert!(matches!(
            resolve(&git, remote, &ReadAt::Rev(sha1.to_string())),
            Err(ViewError::RevNotFound)
        ));
        assert!(matches!(
            resolve(
                &git,
                remote,
                &ReadAt::Ref(RecoveryRef::parse(&reference).unwrap())
            ),
            Err(ViewError::RefNotFound)
        ));
    }

    #[test]
    fn errors_carry_stable_codes() {
        for (error, status, code) in [
            (ViewError::InvalidRef, 400, "invalid_ref"),
            (ViewError::RevAndRef, 400, "invalid_ref"),
            (ViewError::InvalidRev, 400, "invalid_rev"),
            (ViewError::InvalidPath, 400, "invalid_path"),
            (ViewError::RevNotFound, 404, "rev_not_found"),
            (ViewError::RefNotFound, 404, "rev_not_found"),
            (
                ViewError::Unreachable(anyhow::anyhow!("offline")),
                502,
                "canonical_unreachable",
            ),
            (ViewError::Git(anyhow::anyhow!("boom")), 500, "internal"),
        ] {
            assert_eq!(error.code(), code);
            assert_eq!(OriginError::from(error).into_response().status(), status);
        }
    }

    /// A workspace commit holding regular files, an executable, a symlink,
    /// a submodule, a reserved path and a larger file, on `main`.
    fn object_fixture(workspace: &Path) -> String {
        init_workspace_repo(workspace);
        let big = "x".repeat(2000);
        let first = commit_files(
            workspace,
            None,
            &[
                ("README.md", Some("hello\n")),
                ("src/lib.rs", Some("pub fn lib() {}\n")),
                ("src/nested/deep.rs", Some("deep\n")),
                ("bin/run.sh", Some("#!/bin/sh\n")),
                ("docs/big.txt", Some(&big)),
                (".instafy/state.json", Some("{}\n")),
                ("vendor/notes.txt", Some("notes\n")),
            ],
        );
        let executable = with_mode(workspace, &first, "bin/run.sh", "100755");
        let link_target = ig(workspace, &["rev-parse", &format!("{first}:README.md")]);
        let linked = with_raw_entry(workspace, &executable, "link", "120000", &link_target);
        let head = with_raw_entry(workspace, &linked, "vendor/sub", "160000", &first);
        ig(workspace, &["update-ref", "refs/heads/main", &head]);
        head
    }

    /// What a path holds tells an absent path (404 `not_found`) from one a
    /// read never serves (404 `unsupported_entry`), in either layout.
    #[test]
    fn path_kinds_tell_absent_paths_from_unsupported_entries() {
        let (_dir, root) = tempdir();
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let head = object_fixture(&workspace);
        let mirror = bare(&root, "mirror.git");
        let mirror_git = WorkspaceGit::bare(&mirror, None);
        fetch(
            &mirror_git,
            &workspace.join(".instafy/.git"),
            "+refs/heads/main:refs/heads/main",
        );
        for git in [ws_git(&workspace), mirror_git] {
            for (path, kind) in [
                ("", PathKind::Directory),
                ("README.md", PathKind::File),
                ("bin/run.sh", PathKind::File),
                ("src", PathKind::Directory),
                ("src/nested", PathKind::Directory),
                ("link", PathKind::Unsupported),
                ("vendor/sub", PathKind::Unsupported),
                ("missing.md", PathKind::Absent),
                ("src/missing.rs", PathKind::Absent),
                // Below a file, a symlink or a submodule nothing can be.
                ("README.md/x", PathKind::Absent),
                ("link/x", PathKind::Absent),
                ("vendor/sub/x", PathKind::Absent),
                // Reserved paths are never shown, but one that is there is
                // never reported absent (a client could turn it into a
                // delete).
                (".instafy/state.json", PathKind::Unsupported),
                (".instafy", PathKind::Unsupported),
                (".instafy/missing.json", PathKind::Absent),
            ] {
                assert_eq!(path_kind_at(&git, &head, path).unwrap(), kind, "{path}");
            }
            assert!(matches!(
                path_kind_at(&git, &head, "./README.md"),
                Err(ViewError::InvalidPath)
            ));
        }
    }

    fn names(entries: &[ObjectEntry]) -> Vec<(&str, ObjectKind)> {
        entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.kind))
            .collect()
    }

    /// A file whose object is missing or corrupt is an error, never a
    /// path that is not there (a client would take a 404 `not_found` for a
    /// deleted file) and never left out of a listing.
    #[test]
    fn a_file_whose_object_is_damaged_is_an_error_not_an_absence() {
        let (_dir, root) = tempdir();
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let head = object_fixture(&workspace);
        let mirror = bare(&root, "mirror.git");
        let mirror_git = WorkspaceGit::bare(&mirror, None);
        fetch(
            &mirror_git,
            &workspace.join(".instafy/.git"),
            "+refs/heads/main:refs/heads/main",
        );
        let blob = ig(&workspace, &["rev-parse", &format!("{head}:src/lib.rs")]);
        let loose = mirror.join("objects").join(&blob[..2]).join(&blob[2..]);
        assert!(loose.is_file());
        std::fs::remove_file(&loose).unwrap();

        let unreadable = |error: ViewError| {
            let text = format!("{error:#}");
            assert!(text.contains("missing or corrupt"), "{text}");
        };
        unreadable(read_blob_at(&mirror_git, &head, "src/lib.rs", 1 << 20).unwrap_err());
        unreadable(absence_at(&mirror_git, &head, "src/lib.rs").unwrap_err());
        unreadable(read_tree_at(&mirror_git, &head, "src").unwrap_err());
        // Other files read as before.
        assert!(matches!(
            read_blob_at(&mirror_git, &head, "README.md", 1 << 20).unwrap(),
            BlobRead::Found { .. }
        ));
    }

    #[test]
    fn object_reads_show_regular_files_and_folders_only_in_either_layout() {
        let (_dir, root) = tempdir();
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let head = object_fixture(&workspace);
        let mirror = bare(&root, "mirror.git");
        let mirror_git = WorkspaceGit::bare(&mirror, None);
        fetch(
            &mirror_git,
            &workspace.join(".instafy/.git"),
            "+refs/heads/main:refs/heads/main",
        );
        assert_eq!(
            resolve(&mirror_git, "", &ReadAt::Main).unwrap().as_deref(),
            Some(head.as_str())
        );

        for git in [ws_git(&workspace), mirror_git] {
            let TreeRead::Directory(top) = read_tree_at(&git, &head, "").unwrap() else {
                panic!("the root is a folder");
            };
            assert_eq!(
                names(&top),
                vec![
                    ("README.md", ObjectKind::File),
                    ("bin", ObjectKind::Directory),
                    ("docs", ObjectKind::Directory),
                    ("src", ObjectKind::Directory),
                    ("vendor", ObjectKind::Directory),
                ]
            );
            assert_eq!(top[0].size, Some(6));
            assert_eq!(
                top[0].oid,
                ig(&workspace, &["rev-parse", &format!("{head}:README.md")])
            );

            let TreeRead::Directory(src) = read_tree_at(&git, &head, "src").unwrap() else {
                panic!("src is a folder");
            };
            assert_eq!(
                names(&src),
                vec![
                    ("src/lib.rs", ObjectKind::File),
                    ("src/nested", ObjectKind::Directory)
                ]
            );
            let TreeRead::Directory(vendor) = read_tree_at(&git, &head, "vendor").unwrap() else {
                panic!("vendor is a folder");
            };
            assert_eq!(names(&vendor), vec![("vendor/notes.txt", ObjectKind::File)]);
            let TreeRead::File(script) = read_tree_at(&git, &head, "bin/run.sh").unwrap() else {
                panic!("a file reads as its own entry");
            };
            assert!(script.executable());

            for hidden in [
                "link",
                "link/inside",
                "vendor/sub",
                "vendor/sub/file",
                ".instafy",
                ".instafy/state.json",
                "missing",
                "README.md/below",
            ] {
                assert_eq!(
                    read_tree_at(&git, &head, hidden).unwrap(),
                    TreeRead::Missing,
                    "{hidden}"
                );
                assert_eq!(
                    read_blob_at(&git, &head, hidden, 1 << 20).unwrap(),
                    BlobRead::Missing,
                    "{hidden}"
                );
            }
            assert_eq!(
                read_blob_at(&git, &head, "src", 1 << 20).unwrap(),
                BlobRead::Missing
            );
            // Why nothing was shown: only a path the tree lacks is absent.
            for (path, why) in [
                ("missing", Absence::Absent),
                ("link/inside", Absence::Absent),
                ("vendor/sub/file", Absence::Absent),
                ("README.md/below", Absence::Absent),
                ("link", Absence::Hidden),
                ("vendor/sub", Absence::Hidden),
                (".instafy", Absence::Hidden),
                (".instafy/state.json", Absence::Hidden),
                ("src", Absence::Directory),
                ("src/nested", Absence::Directory),
            ] {
                assert_eq!(absence_at(&git, &head, path).unwrap(), why, "{path}");
            }
            assert!(matches!(
                absence_at(&git, &head, "../x"),
                Err(ViewError::InvalidPath)
            ));

            let BlobRead::Found { data, mode, .. } =
                read_blob_at(&git, &head, "README.md", 1 << 20).unwrap()
            else {
                panic!("README.md is a file");
            };
            assert_eq!(
                (data.as_slice(), mode.as_str()),
                (&b"hello\n"[..], "100644")
            );
            let BlobRead::Found { mode, .. } =
                read_blob_at(&git, &head, "bin/run.sh", 1 << 20).unwrap()
            else {
                panic!("bin/run.sh is a file");
            };
            assert_eq!(mode, "100755");
            assert!(matches!(
                read_blob_at(&git, &head, "docs/big.txt", 1999).unwrap(),
                BlobRead::TooLarge { size: 2000, .. }
            ));
            assert!(matches!(
                read_blob_at(&git, &head, "docs/big.txt", 2000).unwrap(),
                BlobRead::Found { .. }
            ));

            for invalid in [
                "README\0.md",
                "src\0/lib.rs",
                "/README.md",
                "./README.md",
                "src/",
                "src//lib.rs",
                "../x",
                "src/../x",
            ] {
                assert!(
                    matches!(
                        read_tree_at(&git, &head, invalid),
                        Err(ViewError::InvalidPath)
                    ),
                    "{invalid}"
                );
                assert!(
                    matches!(
                        read_blob_at(&git, &head, invalid, 1 << 20),
                        Err(ViewError::InvalidPath)
                    ),
                    "{invalid}"
                );
            }
            assert!(matches!(
                read_tree_at(&git, "main", ""),
                Err(ViewError::InvalidRev)
            ));
        }
    }

    #[test]
    fn history_follows_first_parents_and_names_each_one() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let files = tree(&git, &[("README.md", "one\n")]);
        let a = commit(&git, &files, &[], 1_700_000_000, "first\n");
        let b = commit(&git, &files, &[&a], 1_700_000_100, "second\n");
        let side = commit(&git, &files, &[&a], 1_700_000_150, "side\n");
        let merge = commit(&git, &files, &[&b, &side], 1_700_000_200, "merge\n");
        let c = commit(&git, &files, &[&merge], 1_700_000_300, "latest\n");

        let page = first_parent_history(&git, &c, 10, 0).unwrap();
        let listed: Vec<(&str, Option<&str>)> = page
            .iter()
            .map(|entry| (entry.commit.as_str(), entry.first_parent.as_deref()))
            .collect();
        assert_eq!(
            listed,
            vec![
                (c.as_str(), Some(merge.as_str())),
                (merge.as_str(), Some(b.as_str())),
                (b.as_str(), Some(a.as_str())),
                (a.as_str(), None),
            ]
        );
        assert_eq!(page[0].subject, "latest");
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json[0]["firstParent"], merge.as_str());
        assert!(json[3].get("firstParent").is_none(), "{json}");
        let parents: Vec<Option<usize>> = page.iter().map(|entry| entry.parent_count).collect();
        assert_eq!(parents, vec![Some(1), Some(2), Some(1), Some(0)]);
        assert_eq!(json[1]["parentCount"], 2);
        assert_eq!(json[3]["parentCount"], 0);

        let skipped = first_parent_history(&git, &c, 2, 1).unwrap();
        assert_eq!(
            skipped
                .iter()
                .map(|entry| entry.commit.as_str())
                .collect::<Vec<_>>(),
            vec![merge.as_str(), b.as_str()]
        );
        assert!(first_parent_history(&git, &c, 0, 0).unwrap().is_empty());
        assert_eq!(first_parent_history(&git, &c, 10_000, 0).unwrap().len(), 4);
        assert!(matches!(
            first_parent_history(&git, "main", 10, 0),
            Err(ViewError::InvalidRev)
        ));

        // A skip past what git can count is an empty page, not an error or
        // a page from the start (older git wraps the number).
        for skip in [i32::MAX as usize + 1, u32::MAX as usize + 1, usize::MAX] {
            assert!(first_parent_history(&git, &c, 2, skip).unwrap().is_empty());
        }
        assert!(first_parent_history(&git, &c, 2, i32::MAX as usize)
            .unwrap()
            .is_empty());
    }

    /// A page walks one commit more than it shows to say whether older ones
    /// follow; every row names its parents' count, and the whole-history
    /// walk (a checkout's) lists side commits too, in `git log` order.
    #[test]
    fn history_pages_count_parents_and_say_whether_more_follow() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let files = tree(&git, &[("README.md", "one\n")]);
        let a = commit(&git, &files, &[], 1_700_000_000, "first\n");
        let b = commit(&git, &files, &[&a], 1_700_000_100, "second\n");
        let side = commit(&git, &files, &[&a], 1_700_000_150, "side\n");
        let merge = commit(&git, &files, &[&b, &side], 1_700_000_200, "merge\n");
        let c = commit(&git, &files, &[&merge], 1_700_000_300, "latest\n");

        let rows = |page: &HistoryPage| -> Vec<(String, Option<usize>)> {
            page.entries
                .iter()
                .map(|entry| (entry.subject.clone(), entry.parent_count))
                .collect()
        };
        let first = history_page(&git, &c, 2, 0, HistoryWalk::FirstParent).unwrap();
        assert_eq!(
            rows(&first),
            vec![
                ("latest".to_string(), Some(1)),
                ("merge".to_string(), Some(2))
            ]
        );
        assert!(first.has_more);
        let last = history_page(&git, &c, 2, 2, HistoryWalk::FirstParent).unwrap();
        assert_eq!(
            rows(&last),
            vec![
                ("second".to_string(), Some(1)),
                ("first".to_string(), Some(0))
            ]
        );
        assert!(!last.has_more, "nothing follows the root");
        assert_eq!(last.entries[1].first_parent, None);

        let all = history_page(&git, &c, 50, 0, HistoryWalk::All).unwrap();
        let expected: Vec<String> = git
            .stdout(&["log", "--format=%s", &c])
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(
            all.entries
                .iter()
                .map(|entry| entry.subject.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(all.entries.len(), 5);
        assert!(!all.has_more);
        let merge_row = all
            .entries
            .iter()
            .find(|entry| entry.commit == merge)
            .unwrap();
        assert_eq!(merge_row.parent_count, Some(2));
        assert_eq!(merge_row.first_parent.as_deref(), Some(b.as_str()));
        let json = serde_json::to_value(&all.entries).unwrap();
        assert_eq!(json[0]["parentCount"], 1);

        // A page is at most 50 rows, and a full page of exactly the rest
        // says nothing follows.
        let full = history_page(&git, &c, 5, 0, HistoryWalk::All).unwrap();
        assert_eq!(full.entries.len(), 5);
        assert!(!full.has_more);
        assert_eq!(
            history_page(&git, &c, 0, 0, HistoryWalk::All).unwrap(),
            HistoryPage::default()
        );
        let mut long = c.clone();
        for index in 0..55i64 {
            long = commit(&git, &files, &[&long], 1_700_001_000 + index, "more\n");
        }
        let capped = history_page(&git, &long, 500, 0, HistoryWalk::All).unwrap();
        assert_eq!(capped.entries.len(), MAX_HISTORY_PAGE);
        assert!(capped.has_more);
    }

    /// Subjects, author names and trailers that hold the bytes a listing
    /// splits on, newlines and whole forged records change no id, parent or
    /// row count.
    #[test]
    fn commit_text_cannot_forge_history_rows_or_parents() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let files = tree(&git, &[("README.md", "one\n")]);
        let fake = "0123456789abcdef0123456789abcdef01234567";
        let a = commit(&git, &files, &[], 1_700_000_000, "first\n");
        let b = commit(
            &git,
            &files,
            &[&a],
            1_700_000_100,
            &format!("change\u{1f}\u{1f}{fake}\n"),
        );
        let forged_record = format!(
            "\u{1e}{fake}\u{1f}0123456\u{1f}2026-10-04T00:00:00+00:00\u{1f}Victim\u{1f}v@x\u{1f}forged\u{1f}\u{1f}{fake}"
        );
        let c = commit(
            &git,
            &files,
            &[&b],
            1_700_000_200,
            &format!(
                "evil{forged_record}\nline\n\nInstafy-Resolved-By: assistant{forged_record}\n"
            ),
        );
        let author = GitIdentity::new(format!("Mal\u{1f}lory{forged_record}"), "m@x")
            .at(Some("1700000300 +0000".to_string()));
        let d = git
            .commit_tree(&files, &[&c], &author, &author, b"plain\n")
            .unwrap();

        let page = first_parent_history(&git, &d, 10, 0).unwrap();
        let listed: Vec<(&str, Option<&str>)> = page
            .iter()
            .map(|entry| (entry.commit.as_str(), entry.first_parent.as_deref()))
            .collect();
        assert_eq!(
            listed,
            vec![
                (d.as_str(), Some(c.as_str())),
                (c.as_str(), Some(b.as_str())),
                (b.as_str(), Some(a.as_str())),
                (a.as_str(), None),
            ]
        );
        assert_eq!(page[0].author_name, format!("Mal\u{1f}lory{forged_record}"));
        assert_eq!(page[2].subject, format!("change\u{1f}\u{1f}{fake}"));
        assert_eq!(first_parent_history(&git, &d, 2, 0).unwrap().len(), 2);
        assert!(page.iter().all(|entry| entry.commit != fake));
    }

    #[test]
    fn recovery_refs_are_listed_fetched_and_described() {
        let (_dir, root) = tempdir();
        let canonical = root.join("canonical.git");
        git_in(
            &root,
            &["init", "--quiet", "--bare", "-b", "main", "canonical.git"],
        );
        let remote = WorkspaceGit::bare(&canonical, None);
        let base_tree = tree(&remote, &[("README.md", "base\n")]);
        let main = commit(&remote, &base_tree, &[], 1_700_000_000, "base\n");
        remote.update_ref(MAIN_REF, &main, None, "test").unwrap();

        let conflict_ref =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-conflict-0123456789ab");
        let conflict = commit(
            &remote,
            &tree(&remote, &[("README.md", "mine\n"), ("other.md", "o\n")]),
            &[&main],
            1_700_000_200,
            &format!(
                "Keep changes that conflicted with the saved version\n\n\
                 Instafy-Path: not-a-trailer-here.md\n\n\
                 Instafy-Recovery-Kind: conflict\n\
                 Instafy-Origin: {ORIGIN}\n\
                 Instafy-Conflict: README.md\n\
                 Instafy-Path: other.md\n"
            ),
        );
        // A kind trailer that names no recovery kind counts for nothing: the
        // kind comes from the ref's name.
        let posing_ref =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T130000Z-unsaved-abcdef012345");
        let posing = commit(
            &remote,
            &base_tree,
            &[&main],
            1_700_000_300,
            "Pretend\n\nInstafy-Recovery-Kind: archived\nInstafy-Path: z.md\n",
        );
        for (reference, rev) in [
            (conflict_ref.as_str(), conflict.as_str()),
            (posing_ref.as_str(), posing.as_str()),
            (
                // Another origin, so a case-insensitive disk keeps its own
                // folder for it.
                "refs/instafy/recovery/0B7C2F10-58A4-4E6B-9F0E-2D1C3B4A5F61/x",
                conflict.as_str(),
            ),
            ("refs/instafy/other/x", conflict.as_str()),
        ] {
            remote.update_ref(reference, rev, None, "test").unwrap();
        }

        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let url = canonical.to_str().unwrap();
        let mut listed = list_remote_refs(&git, url).unwrap();
        listed.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
        assert_eq!(
            listed
                .iter()
                .map(|(reference, rev)| (reference.as_str(), rev.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (conflict_ref.as_str(), conflict.as_str()),
                (posing_ref.as_str(), posing.as_str()),
            ]
        );
        let conflict_name = RecoveryRef::parse(&conflict_ref).unwrap();
        assert_eq!(
            remote_tip(&git, url, &conflict_name).unwrap().as_deref(),
            Some(conflict.as_str())
        );
        let gone = RecoveryRef::parse(&format!("refs/instafy/recovery/{ORIGIN}/gone")).unwrap();
        assert_eq!(remote_tip(&git, url, &gone).unwrap(), None);
        assert_eq!(
            fetch_refs(&git, url, &[(gone.clone(), conflict.clone())]).unwrap(),
            FetchedRefs {
                missing: vec![gone.clone()],
                ..FetchedRefs::default()
            }
        );

        let at = ReadAt::Ref(conflict_name.clone());
        let fetched = fetch_refs(&git, url, &listed).unwrap();
        assert_eq!(pairs(&fetched.fetched), listed);
        assert!(fetched.missing.is_empty());
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        assert_eq!(
            resolve(&git, url, &at).unwrap().as_deref(),
            Some(conflict.as_str())
        );
        // No local ref is named after a remote one, and nothing is left
        // in the fetch namespace.
        assert!(git.refs_under("refs/instafy/").unwrap().is_empty());
        let TreeRead::Directory(entries) = read_tree_at(&git, &conflict, "").unwrap() else {
            panic!("the root is a folder");
        };
        assert_eq!(entries.len(), 2);

        let items = describe(&git, &fetched.fetched, Some(&main)).unwrap();
        let summary: Vec<(&str, ItemKind, Vec<&str>)> = items
            .iter()
            .map(|item| {
                (
                    item.reference.as_str(),
                    item.kind,
                    item.paths.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (posing_ref.as_str(), ItemKind::Unsaved, vec!["z.md"]),
                (conflict_ref.as_str(), ItemKind::Conflict, vec!["README.md"]),
            ]
        );
        let conflict_item = &items[1];
        assert_eq!(
            conflict_item.subject,
            "Keep changes that conflicted with the saved version"
        );
        assert_eq!(conflict_item.base.as_deref(), Some(main.as_str()));
        assert_eq!(conflict_item.origin, Uuid::parse_str(ORIGIN).unwrap());
        let committed_at = git_in(&canonical, &["log", "-1", "--format=%cI", &conflict]);
        assert_eq!(conflict_item.date.as_deref(), Some(committed_at.as_str()));

        let json = serde_json::to_value(conflict_item).unwrap();
        assert_eq!(json["ref"], conflict_ref.as_str());
        assert_eq!(json["kind"], "conflict");
        assert_eq!(json["origin"], ORIGIN);
        assert_eq!(json["base"], main.as_str());
        assert!(json.get("timestamp").is_none(), "{json}");

        // Without main there is no base.
        assert!(describe(&git, &fetched.fetched, None)
            .unwrap()
            .iter()
            .all(|item| item.base.is_none()));
    }

    /// A bare canonical repository holding `refs` (and `main`), written as
    /// packed refs so that names differing only in letter case can coexist
    /// even on a case-insensitive disk.
    fn canonical_with_packed_refs(root: &Path, refs: &[(&str, &str)], main: &str) -> PathBuf {
        let canonical = root.join("canonical.git");
        let mut sorted: Vec<(&str, &str)> = refs.to_vec();
        sorted.push((MAIN_REF, main));
        sorted.sort();
        let mut packed = String::from("# pack-refs with: peeled fully-peeled sorted \n");
        for (name, id) in sorted {
            packed.push_str(&format!("{id} {name}\n"));
        }
        std::fs::write(canonical.join("packed-refs"), packed).unwrap();
        canonical
    }

    /// A name that is not a ref is never read as some other commit, even
    /// when git could parse it as an abbreviated id of a commit that is here.
    #[test]
    fn a_missing_ref_is_never_read_as_another_commit() {
        let (_dir, root) = tempdir();
        let canonical = bare(&root, "canonical.git");
        let remote = WorkspaceGit::bare(&canonical, None);
        let files = tree(&remote, &[("a.txt", "a\n")]);
        let main = commit(&remote, &files, &[], 1_700_000_000, "main\n");
        remote.update_ref(MAIN_REF, &main, None, "test").unwrap();
        let real =
            RecoveryRef::parse(&format!("refs/instafy/recovery/{ORIGIN}/node-1-0123abcd")).unwrap();
        remote
            .update_ref(real.as_str(), &main, None, "test")
            .unwrap();
        let url = canonical.to_str().unwrap();

        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        for name in [
            format!(
                "refs/instafy/recovery/{ORIGIN}/nothing-here-1-g{}",
                &main[..7]
            ),
            format!("refs/instafy/recovery/{ORIGIN}/x-0-g{}", &main[..4]),
        ] {
            let at = ReadAt::from_query(&git, None, Some(&name)).unwrap();
            assert!(
                matches!(resolve(&git, url, &at), Err(ViewError::RefNotFound)),
                "{name}"
            );
        }
        assert_eq!(
            resolve(&git, url, &ReadAt::Ref(real)).unwrap().as_deref(),
            Some(main.as_str())
        );
    }

    /// Whether `dir` is on a case-insensitive filesystem.
    fn case_insensitive(dir: &Path) -> bool {
        let probe = dir.join("Case-Probe");
        std::fs::write(&probe, b"").unwrap();
        let insensitive = dir.join("case-probe").exists();
        std::fs::remove_file(probe).unwrap();
        insensitive
    }

    /// Recovery names that differ only in letter case are separate refs on
    /// the remote: both are listed, each fetches and reads as its own
    /// commit, in a bare mirror and in a Desktop checkout alike, and a
    /// stray local ref spelled like one of them is never read for it. On a
    /// case-insensitive disk (this test's temporary folder on macOS) the
    /// two names would be one local file if they were fetched under their
    /// own names, so they never are.
    #[test]
    fn refs_that_differ_only_in_case_are_each_listed_and_read_as_themselves() {
        let (_dir, root) = tempdir();
        eprintln!(
            "temporary folder is case-insensitive: {}",
            case_insensitive(&root)
        );
        git_in(
            &root,
            &["init", "--quiet", "--bare", "-b", "main", "canonical.git"],
        );
        let canonical_dir = root.join("canonical.git");
        let remote = WorkspaceGit::bare(&canonical_dir, None);
        let files = tree(&remote, &[("a.txt", "a\n")]);
        let main = commit(&remote, &files, &[], 1_700_000_000, "main\n");
        let one = commit(&remote, &files, &[&main], 1_700_000_100, "one\n");
        let two = commit(&remote, &files, &[&main], 1_700_000_200, "two\n");
        let three = commit(&remote, &files, &[&main], 1_700_000_300, "three\n");
        let base = format!("refs/instafy/recovery/{ORIGIN}");
        let upper = format!("{base}/20261002T120000Z-unsaved-x");
        let lower = format!("{base}/20261002t120000z-unsaved-x");
        let plain = format!("{base}/20261002T130000Z-stale-y");
        let other = "refs/instafy/recovery/0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f61/node-1".to_string();
        let canonical = canonical_with_packed_refs(
            &root,
            &[
                (&upper, &two),
                (&lower, &one),
                (&plain, &one),
                (&other, &three),
            ],
            &main,
        );
        let url = canonical.to_str().unwrap();

        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        init_workspace_repo(&workspace);
        let mirror = bare(&root, "mirror.git");
        for git in [ws_git(&workspace), WorkspaceGit::bare(&mirror, None)] {
            // A stray local ref spelled like the lower-case name, at the
            // other commit.
            fetch(&git, &canonical, &format!("+{upper}:{lower}"));
            assert_eq!(git.refs_under(&lower).unwrap().len(), 1);

            let listed = list_remote_refs(&git, url).unwrap();
            let mut entries: Vec<(&str, &str)> = listed
                .iter()
                .map(|(reference, rev)| (reference.as_str(), rev.as_str()))
                .collect();
            entries.sort();
            let mut expected = vec![
                (upper.as_str(), two.as_str()),
                (lower.as_str(), one.as_str()),
                (plain.as_str(), one.as_str()),
                (other.as_str(), three.as_str()),
            ];
            expected.sort();
            assert_eq!(entries, expected);

            let fetched = fetch_refs(&git, url, &listed).unwrap();
            assert!(fetched.missing.is_empty(), "{fetched:?}");
            assert_eq!(pairs(&fetched.fetched), listed);
            for (reference, rev) in &listed {
                assert_eq!(
                    resolve(&git, url, &ReadAt::Ref(reference.clone()))
                        .unwrap()
                        .as_deref(),
                    Some(rev.as_str()),
                    "{}",
                    reference.as_str()
                );
            }
            let items = describe(&git, &fetched.fetched, Some(&main)).unwrap();
            let mut described: Vec<(&str, &str)> = items
                .iter()
                .map(|item| (item.reference.as_str(), item.rev.as_str()))
                .collect();
            described.sort();
            assert_eq!(described, expected);

            // Only the stray ref is here: nothing was fetched under a
            // remote name, and the fetch namespace is gone.
            let left: Vec<String> = git
                .refs_under("refs/instafy/")
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect();
            assert_eq!(left.len(), 1, "{left:?}");
            assert!(left[0].eq_ignore_ascii_case(&lower), "{left:?}");
        }
    }

    /// A ref deleted between the listing and the fetch (another tab
    /// dismissed it, a publish retired it) is reported missing; the others
    /// are fetched and described.
    #[test]
    fn a_ref_that_vanishes_before_the_fetch_leaves_the_others_listed() {
        let (_dir, root) = tempdir();
        git_in(
            &root,
            &["init", "--quiet", "--bare", "-b", "main", "canonical.git"],
        );
        let canonical = root.join("canonical.git");
        let remote = WorkspaceGit::bare(&canonical, None);
        let files = tree(&remote, &[("a.txt", "a\n")]);
        let main = commit(&remote, &files, &[], 1_700_000_000, "main\n");
        remote.update_ref(MAIN_REF, &main, None, "test").unwrap();
        let gone = RecoveryRef::parse(&format!("refs/instafy/recovery/{ORIGIN}/gone")).unwrap();
        let kept = RecoveryRef::parse(&format!("refs/instafy/recovery/{ORIGIN}/kept")).unwrap();
        let gone_rev = commit(&remote, &files, &[&main], 1_700_000_100, "gone\n");
        let kept_rev = commit(&remote, &files, &[&main], 1_700_000_200, "kept\n");
        remote
            .update_ref(gone.as_str(), &gone_rev, None, "test")
            .unwrap();
        remote
            .update_ref(kept.as_str(), &kept_rev, None, "test")
            .unwrap();

        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let url = canonical.to_str().unwrap();
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        let listed = list_remote_refs(&git, url).unwrap();
        assert_eq!(listed.len(), 2);

        // The ref disappears right before the first fetch starts.
        let marker = root.join("deleted");
        let log = root.join("commands.log");
        let outcome = {
            let _wrapper = crate::test_support::GitWrapper::install(
                &root,
                &format!(
                    "{}\nfor arg in \"$@\"; do\n  if [ \"$arg\" = fetch ] && [ ! -e '{marker}' ]; then\n    \
                     : > '{marker}'\n    \
                     env -u GIT_DIR git --git-dir '{canonical}' update-ref -d '{gone}'\n  fi\ndone",
                    log_subcommands(&log),
                    marker = marker.display(),
                    canonical = canonical.display(),
                    gone = gone.as_str(),
                ),
            );
            fetch_refs(&git, url, &listed).unwrap()
        };
        assert!(marker.exists(), "the ref was not deleted mid-fetch");
        // One more listing and one more fetch, however many refs there are.
        let counts = subcommand_counts(&log);
        assert_eq!(counts.get("fetch"), Some(&2), "{counts:?}");
        assert_eq!(counts.get("ls-remote"), Some(&1), "{counts:?}");
        assert_eq!(
            outcome,
            FetchedRefs {
                fetched: as_fetched(&[(kept.clone(), kept_rev.clone())]),
                missing: vec![gone.clone()],
            }
        );
        // Even when given the stale listing, only what is here is described.
        let items = describe(&git, &as_fetched(&listed), Some(&main)).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.rev.as_str())
                .collect::<Vec<_>>(),
            vec![kept_rev.as_str()]
        );
        assert!(matches!(
            resolve(&git, url, &ReadAt::Ref(gone)),
            Err(ViewError::RefNotFound)
        ));
        assert!(git.refs_under(FETCHED_REF_ROOT).unwrap().is_empty());

        // An unreachable remote is still an error.
        let nowhere = root.join("nowhere.git");
        assert!(fetch_refs(
            &git,
            nowhere.to_str().unwrap(),
            &[(kept.clone(), kept_rev.clone())]
        )
        .is_err());
    }

    /// The listing is capped before the one merge-base per item, so a pile
    /// of refs costs at most [`MAX_RECOVERY_ITEMS`] merge-base processes.
    #[test]
    fn describe_caps_the_list_before_any_merge_base() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let files = tree(&git, &[("a.txt", "a\n")]);
        let main = commit(&git, &files, &[], 1_700_000_000, "main\n");
        let total = MAX_RECOVERY_ITEMS + 5;
        let refs: Vec<(RecoveryRef, String)> = (0..total)
            .map(|index| {
                let rev = commit(
                    &git,
                    &files,
                    &[&main],
                    1_700_000_000 + 10 * (index as i64 + 1),
                    &format!("work {index}\n"),
                );
                let name = format!("refs/instafy/recovery/{ORIGIN}/item-{index:03}");
                (RecoveryRef::parse(&name).unwrap(), rev)
            })
            .collect();

        let log = root.join("merge-bases.log");
        let items = {
            let _wrapper = crate::test_support::GitWrapper::install(
                &root,
                &format!(
                    "for arg in \"$@\"; do\n  if [ \"$arg\" = merge-base ]; then echo x >> '{}'; fi\ndone",
                    log.display()
                ),
            );
            describe(&git, &as_fetched(&refs), Some(&main)).unwrap()
        };
        let merge_bases = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .count();
        assert_eq!(merge_bases, MAX_RECOVERY_ITEMS);
        assert_eq!(items.len(), MAX_RECOVERY_ITEMS);
        assert_eq!(items[0].reference, refs[total - 1].0.as_str());
        assert_eq!(items[MAX_RECOVERY_ITEMS - 1].reference, refs[5].0.as_str());
        assert!(items
            .iter()
            .all(|item| item.base.as_deref() == Some(main.as_str())));
    }

    /// A shell prelude for [`crate::test_support::GitWrapper`] that appends
    /// each git command's subcommand to `log`.
    fn log_subcommands(log: &Path) -> String {
        format!(
            "sub=\"\"; skip=0\nfor arg in \"$@\"; do\n  if [ $skip = 1 ]; then skip=0; continue; fi\n  \
             case \"$arg\" in\n    -c|--git-dir|--work-tree) skip=1 ;;\n    -*) ;;\n    \
             *) sub=\"$arg\"; break ;;\n  esac\ndone\necho \"$sub\" >> '{}'",
            log.display()
        )
    }

    fn subcommand_counts(log: &Path) -> std::collections::BTreeMap<String, usize> {
        let mut counts = std::collections::BTreeMap::new();
        for line in std::fs::read_to_string(log).unwrap_or_default().lines() {
            *counts.entry(line.to_string()).or_insert(0) += 1;
        }
        counts
    }

    /// A bare canonical repository with `count` recovery refs, each at a
    /// commit of its own (newer for higher indexes), as packed refs.
    fn canonical_with_many_refs(root: &Path, count: usize) -> (PathBuf, String, Vec<String>) {
        git_in(
            root,
            &["init", "--quiet", "--bare", "-b", "main", "canonical.git"],
        );
        let canonical_dir = root.join("canonical.git");
        let remote = WorkspaceGit::bare(&canonical_dir, None);
        let files = tree(&remote, &[("a.txt", "a\n")]);
        let main = commit(&remote, &files, &[], 1_700_000_000, "main\n");
        let names: Vec<String> = (0..count)
            .map(|index| format!("refs/instafy/recovery/{ORIGIN}/item-{index:03}"))
            .collect();
        let revs: Vec<String> = (0..count)
            .map(|index| {
                commit(
                    &remote,
                    &files,
                    &[&main],
                    1_700_000_000 + 10 * (index as i64 + 1),
                    &format!("work {index}\n"),
                )
            })
            .collect();
        let refs: Vec<(&str, &str)> = names
            .iter()
            .zip(&revs)
            .map(|(name, rev)| (name.as_str(), rev.as_str()))
            .collect();
        let canonical = canonical_with_packed_refs(root, &refs, &main);
        (canonical, main, revs)
    }

    /// A listing costs a fixed number of git processes, however many refs
    /// there are: one fetch, no process per ref, and a merge-base only for
    /// the items shown.
    #[test]
    fn listing_many_refs_spawns_no_process_per_ref() {
        let (_dir, root) = tempdir();
        let total = MAX_RECOVERY_ITEMS + 50;
        let (canonical, main, revs) = canonical_with_many_refs(&root, total);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");

        let log = root.join("commands.log");
        let (fetched, items) = {
            let _wrapper = crate::test_support::GitWrapper::install(&root, &log_subcommands(&log));
            let listed = list_remote_refs(&git, url).unwrap();
            let fetched = fetch_refs(&git, url, &listed).unwrap();
            let items = describe(&git, &fetched.fetched, Some(&main)).unwrap();
            (fetched, items)
        };
        assert_eq!(fetched.fetched.len(), total);
        assert_eq!(items.len(), MAX_RECOVERY_ITEMS);
        assert_eq!(items[0].rev, revs[total - 1]);
        let counts = subcommand_counts(&log);
        let count = |name: &str| counts.get(name).copied().unwrap_or(0);
        assert_eq!(count("ls-remote"), 1, "{counts:?}");
        assert_eq!(count("fetch"), 1, "{counts:?}");
        assert_eq!(count("rev-parse"), 0, "{counts:?}");
        assert_eq!(count("merge-base"), MAX_RECOVERY_ITEMS, "{counts:?}");
        let others: usize = counts
            .iter()
            .filter(|(name, _)| !matches!(name.as_str(), "merge-base"))
            .map(|(_, count)| count)
            .sum();
        assert!(others <= 10, "{counts:?}");
        assert!(git.refs_under(FETCHED_REF_ROOT).unwrap().is_empty());
    }

    /// When the listed name is gone by the time of the fetch, git's own
    /// name guessing fetches a lookalike (`refs/heads/<the same name>`) that
    /// anyone with write access can create. The fetched commit must be the
    /// listed one: otherwise the ref counts as gone.
    #[test]
    fn a_lookalike_ref_is_never_fetched_for_a_vanished_one() {
        let (_dir, root) = tempdir();
        git_in(
            &root,
            &["init", "--quiet", "--bare", "-b", "main", "canonical.git"],
        );
        let canonical = root.join("canonical.git");
        let remote = WorkspaceGit::bare(&canonical, None);
        let files = tree(&remote, &[("a.txt", "a\n")]);
        let main = commit(&remote, &files, &[], 1_700_000_000, "main\n");
        let real = commit(&remote, &files, &[&main], 1_700_000_100, "real\n");
        let stray = commit(&remote, &files, &[&main], 1_700_000_200, "stray\n");
        let name = format!("refs/instafy/recovery/{ORIGIN}/x");
        remote.update_ref(MAIN_REF, &main, None, "test").unwrap();
        remote.update_ref(&name, &real, None, "test").unwrap();
        remote
            .update_ref(&format!("refs/heads/{name}"), &stray, None, "test")
            .unwrap();
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let listed = list_remote_refs(&git, url).unwrap();
        assert_eq!(
            listed,
            vec![(RecoveryRef::parse(&name).unwrap(), real.clone())]
        );

        let marker = root.join("deleted");
        let outcome = {
            let _wrapper = crate::test_support::GitWrapper::install(
                &root,
                &format!(
                    "for arg in \"$@\"; do\n  if [ \"$arg\" = fetch ] && [ ! -e '{marker}' ]; then\n    \
                     : > '{marker}'\n    \
                     env -u GIT_DIR git --git-dir '{canonical}' update-ref -d '{name}'\n  fi\ndone",
                    marker = marker.display(),
                    canonical = canonical.display(),
                ),
            );
            fetch_refs(&git, url, &listed).unwrap()
        };
        assert!(marker.exists());
        assert_eq!(
            outcome,
            FetchedRefs {
                fetched: Vec::new(),
                missing: vec![RecoveryRef::parse(&name).unwrap()],
            }
        );
        assert!(matches!(
            resolve(&git, url, &ReadAt::Ref(RecoveryRef::parse(&name).unwrap())),
            Err(ViewError::RefNotFound)
        ));
        assert!(git.refs_under(FETCHED_REF_ROOT).unwrap().is_empty());
    }

    /// Turn off the automatic maintenance a fetch starts: from git 2.49 it
    /// runs `pack-refs --auto`, which races concurrent ref deletes and can
    /// put back refs they just removed (harmless in production: the
    /// namespace is swept later), which would make "nothing is left"
    /// assertions flaky.
    fn quiet_maintenance(repository: &Path) {
        git_in(repository, &["config", "maintenance.auto", "false"]);
        git_in(repository, &["config", "gc.auto", "0"]);
    }

    /// Calls that run at once on one repository each fetch into their own
    /// namespace: every call gets its own refs' commits and nothing is
    /// left behind.
    #[test]
    fn concurrent_fetches_never_share_a_namespace() {
        let (_dir, root) = tempdir();
        let (canonical, _main, _revs) = canonical_with_many_refs(&root, 8);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        quiet_maintenance(&mirror);
        let listed = list_remote_refs(&WorkspaceGit::bare(&mirror, None), url).unwrap();
        std::thread::scope(|scope| {
            for thread in 0..8 {
                let listed = &listed;
                let mirror = &mirror;
                scope.spawn(move || {
                    let git = WorkspaceGit::bare(mirror, None);
                    for call in 0..3 {
                        // A different order and subset in every call, so a
                        // shared namespace would hand out wrong commits.
                        let mut mine = listed.clone();
                        mine.rotate_left((thread + call) % listed.len());
                        mine.truncate(3 + (thread + call) % 5);
                        let fetched = fetch_refs(&git, url, &mine).unwrap();
                        assert_eq!(pairs(&fetched.fetched), mine);
                        assert!(fetched.missing.is_empty());
                    }
                });
            }
        });
        let git = WorkspaceGit::bare(&mirror, None);
        assert!(git.refs_under(FETCHED_REF_ROOT).unwrap().is_empty());
    }

    /// A call that fails after fetching some refs still removes its
    /// namespace.
    #[test]
    fn a_failed_fetch_removes_its_namespace() {
        let (_dir, root) = tempdir();
        let (canonical, _main, _revs) = canonical_with_many_refs(&root, 3);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let listed = list_remote_refs(&git, url).unwrap();
        let log = root.join("commands.log");
        let result = {
            // Every fetch writes its refs, then reports a failure.
            let _wrapper = crate::test_support::GitWrapper::install(
                &root,
                &format!(
                    "{}\nfor arg in \"$@\"; do\n  if [ \"$arg\" = fetch ]; then git \"$@\"; exit 1; fi\ndone",
                    log_subcommands(&log)
                ),
            );
            fetch_refs(&git, url, &listed)
        };
        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("could not fetch 3 recovery refs in 3 attempts"),
            "{error}"
        );
        let counts = subcommand_counts(&log);
        assert_eq!(
            counts.get("fetch"),
            Some(&(FETCH_RETRIES + 1)),
            "{counts:?}"
        );
        assert!(git.refs_under(FETCHED_REF_ROOT).unwrap().is_empty());
    }

    /// Namespaces left by calls that died (older than the stale limit, or
    /// in an older naming) are removed by the next call and on start; a
    /// recent one, which a running call may own, is kept.
    #[test]
    fn stale_fetch_namespaces_are_swept() {
        let (_dir, root) = tempdir();
        let (canonical, main, _revs) = canonical_with_many_refs(&root, 2);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let old = now - FETCH_SCRATCH_STALE_AFTER.as_secs() - 60;
        let stale = format!("{FETCHED_REF_ROOT}/{old}-0123456789abcdef0123456789abcdef/0");
        // Names this server does not make are never removed: through a
        // linked folder they could be other refs.
        let unnamed = format!("{FETCHED_REF_ROOT}/0123456789abcdef0123456789abcdef/0");
        let other = format!("{FETCHED_REF_ROOT}/main");
        let live = format!("{FETCHED_REF_ROOT}/{now}-fedcba9876543210fedcba9876543210/0");
        for name in [&stale, &unnamed, &other, &live] {
            git.update_ref(name, &main, None, "test").unwrap();
        }
        assert_eq!(sweep_stale_fetches(&git), 1);
        let mut kept = vec![unnamed.clone(), other.clone(), live.clone()];
        kept.sort();
        let left: Vec<String> = git
            .refs_under(FETCHED_REF_ROOT)
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(left, kept);

        git.update_ref(&stale, &main, None, "test").unwrap();
        let listed = list_remote_refs(&git, url).unwrap();
        fetch_refs(&git, url, &listed).unwrap();
        let left: Vec<String> = git
            .refs_under(FETCHED_REF_ROOT)
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(left, kept);
    }

    /// A fetch that stops partway can leave loose objects (git writes them
    /// commit first) that no ref reaches; git moves a ref only after its
    /// connectivity check. A `?rev` read accepts a commit only when its tree
    /// is here and a local ref reaches it, so such a commit is "not here"
    /// and the caller fetches; a commit a ref reaches reads normally. The
    /// check costs two processes.
    #[test]
    fn a_commit_no_ref_reaches_is_not_readable() {
        let (_dir, root) = tempdir();
        let (canonical, main, revs) = canonical_with_many_refs(&root, 1);
        let url = canonical.to_str().unwrap();
        let tip = revs[0].clone();
        let canonical_git = WorkspaceGit::bare(&canonical, None);
        let blob = canonical_git
            .stdout(&["rev-parse", &format!("{tip}:a.txt")])
            .unwrap();
        let tree_id = canonical_git.tree_id(&tip).unwrap();
        assert!(![&tip, &main, &tree_id]
            .iter()
            .any(|id| id[..2] == blob[..2]));

        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        init_workspace_repo(&workspace);
        let mirror = bare(&root, "mirror.git");
        let layouts = [
            (ws_git(&workspace), workspace.join(".instafy/.git/objects")),
            (WorkspaceGit::bare(&mirror, None), mirror.join("objects")),
        ];
        for (git, objects) in &layouts {
            // The blob's loose-object folder cannot be made (a full disk):
            // the fetch stops after writing the commits and the tree.
            std::fs::write(objects.join(&blob[..2]), b"").unwrap();
            let listed = list_remote_refs(git, url).unwrap();
            assert!(fetch_refs(git, url, &listed).is_err());
            assert_eq!(git.commit_id(&tip).unwrap().as_deref(), Some(tip.as_str()));
            assert!(git.test(&["cat-file", "-e", &tree_id]).unwrap());
            assert!(matches!(
                resolve(git, url, &ReadAt::Rev(tip.clone())),
                Err(ViewError::RevNotFound)
            ));
            std::fs::remove_file(objects.join(&blob[..2])).unwrap();

            // Once a ref reaches it, it reads, at two processes.
            fetch(git, &canonical, &format!("+{tip}:refs/heads/recovered"));
            let log = root.join("resolve.log");
            let _ = std::fs::remove_file(&log);
            let resolved = {
                let _wrapper =
                    crate::test_support::GitWrapper::install(&root, &log_subcommands(&log));
                resolve(git, url, &ReadAt::Rev(tip.clone())).unwrap()
            };
            assert_eq!(resolved.as_deref(), Some(tip.as_str()));
            // A branch, not main, reaches it: presence, main, branches.
            // (A checkout also reads its config before each command.)
            let counts = subcommand_counts(&log);
            let commands: usize = counts
                .iter()
                .filter(|(name, _)| name.as_str() != "config")
                .map(|(_, count)| count)
                .sum();
            assert_eq!(commands, 3, "{counts:?}");
            assert!(matches!(
                read_blob_at(git, &tip, "a.txt", 1 << 20).unwrap(),
                BlobRead::Found { .. }
            ));
        }

        // A commit here whose tree is not, even if a ref names it.
        let damaged = bare(&root, "damaged.git");
        let git = WorkspaceGit::bare(&damaged, None);
        let raw = format!(
            "tree {tree_id}\nauthor A <a@x> 1700000000 +0000\ncommitter A <a@x> 1700000000 +0000\n\norphan\n"
        );
        let orphan = git
            .stdout_opts(
                &["hash-object", "-t", "commit", "-w", "--stdin"],
                &RunOpts {
                    stdin: Some(raw.as_bytes()),
                    ..RunOpts::default()
                },
            )
            .unwrap();
        git.update_ref("refs/heads/orphan", &orphan, None, "test")
            .unwrap();
        assert!(matches!(
            resolve(&git, url, &ReadAt::Rev(orphan)),
            Err(ViewError::RevNotFound)
        ));
    }

    /// The shard accepts a recovery ref that names its commit through an
    /// annotated tag: it is listed, fetched, read and described, and the
    /// item keeps the tag's id as `rev`, the id a lease on the ref needs.
    #[test]
    fn a_recovery_ref_naming_an_annotated_tag_reads_as_its_commit() {
        let (_dir, root) = tempdir();
        let (canonical, main, revs) = canonical_with_many_refs(&root, 1);
        let url = canonical.to_str().unwrap();
        git_in(
            &canonical,
            &[
                "-c",
                "user.name=Tagger",
                "-c",
                "user.email=tagger@instafy.dev",
                "tag",
                "-a",
                "-m",
                "kept",
                "kept",
                &revs[0],
            ],
        );
        let tag = git_in(&canonical, &["rev-parse", "refs/tags/kept"]);
        let name = format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-unsaved-tagged");
        git_in(&canonical, &["update-ref", &name, &tag]);
        let reference = RecoveryRef::parse(&name).unwrap();

        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        let listed = list_remote_refs(&git, url).unwrap();
        assert!(listed.contains(&(reference.clone(), tag.clone())));
        let fetched = fetch_refs(&git, url, &listed).unwrap();
        assert!(fetched.missing.is_empty(), "{fetched:?}");
        let tagged = fetched
            .fetched
            .iter()
            .find(|fetched| fetched.reference == reference)
            .unwrap();
        assert_eq!(
            (tagged.tip.as_str(), tagged.commit.as_str()),
            (tag.as_str(), revs[0].as_str())
        );
        assert_eq!(
            resolve(&git, url, &ReadAt::Ref(reference.clone()))
                .unwrap()
                .as_deref(),
            Some(revs[0].as_str())
        );
        let items = describe(&git, &fetched.fetched, Some(&main)).unwrap();
        let item = items.iter().find(|item| item.reference == name).unwrap();
        assert_eq!(
            (item.rev.as_str(), item.commit.as_str()),
            (tag.as_str(), revs[0].as_str())
        );
        assert_eq!(item.base.as_deref(), Some(main.as_str()));
    }

    /// Calls that start together while a stale namespace is here all
    /// succeed: the sweep is housekeeping, and a ref another call already
    /// removed is not an error.
    #[test]
    fn concurrent_calls_with_a_stale_namespace_all_succeed() {
        let (_dir, root) = tempdir();
        let (canonical, main, _revs) = canonical_with_many_refs(&root, 4);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        quiet_maintenance(&mirror);
        let git = WorkspaceGit::bare(&mirror, None);
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        let listed = list_remote_refs(&git, url).unwrap();
        let old = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - FETCH_SCRATCH_STALE_AFTER.as_secs()
            - 60;
        for round in 0..5 {
            for index in 0..20 {
                let name = format!("{FETCHED_REF_ROOT}/{old}-{round:032x}/{index}");
                git.update_ref(&name, &main, None, "test").unwrap();
            }
            let start = std::sync::Barrier::new(8);
            std::thread::scope(|scope| {
                for _ in 0..8 {
                    let (listed, mirror, start) = (&listed, &mirror, &start);
                    scope.spawn(move || {
                        let git = WorkspaceGit::bare(mirror, None);
                        start.wait();
                        let fetched = fetch_refs(&git, url, listed).unwrap();
                        assert_eq!(pairs(&fetched.fetched), *listed);
                    });
                }
            });
            assert!(git.refs_under(FETCHED_REF_ROOT).unwrap().is_empty());
        }
    }

    /// A symbolic ref under the fetch root that points elsewhere is
    /// removed itself; the ref it points to is never touched.
    #[test]
    fn sweeping_a_symbolic_fetch_ref_never_deletes_its_target() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let files = tree(&git, &[("a.txt", "a\n")]);
        let main = commit(&git, &files, &[], 1_700_000_000, "main\n");
        git.update_ref(MAIN_REF, &main, None, "test").unwrap();
        let link = format!("{FETCHED_REF_ROOT}/1000-{:032x}/0", 0xaa);
        git.ok(&["symbolic-ref", &link, MAIN_REF]).unwrap();
        assert_eq!(sweep_stale_fetches(&git), 1);
        assert_eq!(
            git.commit_id(MAIN_REF).unwrap().as_deref(),
            Some(main.as_str())
        );
        assert!(git.refs_under(FETCHED_REF_ROOT).unwrap().is_empty());
    }

    /// A `?ref=` read lists the remote once and fetches once.
    #[test]
    fn a_ref_read_lists_the_remote_once() {
        let (_dir, root) = tempdir();
        let (canonical, _main, revs) = canonical_with_many_refs(&root, 3);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let reference =
            RecoveryRef::parse(&format!("refs/instafy/recovery/{ORIGIN}/item-001")).unwrap();
        let log = root.join("commands.log");
        let resolved = {
            let _wrapper = crate::test_support::GitWrapper::install(&root, &log_subcommands(&log));
            resolve(&git, url, &ReadAt::Ref(reference)).unwrap()
        };
        assert_eq!(resolved.as_deref(), Some(revs[1].as_str()));
        let counts = subcommand_counts(&log);
        assert_eq!(counts.get("ls-remote"), Some(&1), "{counts:?}");
        assert_eq!(counts.get("fetch"), Some(&1), "{counts:?}");
    }

    /// A version from history (a commit `main` has moved past, with refs
    /// packed) reads through `?rev`, in a checkout and a mirror alike, with
    /// two processes: presence, then one ancestry walk from `main`.
    #[test]
    fn an_older_commit_on_main_reads_through_rev() {
        let (_dir, root) = tempdir();
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        init_workspace_repo(&workspace);
        let mirror = bare(&root, "mirror.git");
        for git in [ws_git(&workspace), WorkspaceGit::bare(&mirror, None)] {
            let first = tree(&git, &[("a.txt", "old\n")]);
            let second = tree(&git, &[("a.txt", "new\n")]);
            let older = commit(&git, &first, &[], 1_700_000_000, "older\n");
            let newer = commit(&git, &second, &[&older], 1_700_000_100, "newer\n");
            git.update_ref(MAIN_REF, &newer, None, "test").unwrap();
            git.ok(&["pack-refs", "--all"]).unwrap();
            let log = root.join("older.log");
            let _ = std::fs::remove_file(&log);
            let resolved = {
                let _wrapper =
                    crate::test_support::GitWrapper::install(&root, &log_subcommands(&log));
                resolve(&git, "", &ReadAt::Rev(older.clone())).unwrap()
            };
            assert_eq!(resolved.as_deref(), Some(older.as_str()));
            let counts = subcommand_counts(&log);
            assert_eq!(counts.get("cat-file"), Some(&1), "{counts:?}");
            assert_eq!(counts.get("merge-base"), Some(&1), "{counts:?}");
            assert_eq!(counts.get("for-each-ref"), None, "{counts:?}");
            let BlobRead::Found { data, .. } =
                read_blob_at(&git, &older, "a.txt", 1 << 20).unwrap()
            else {
                panic!("the older file reads");
            };
            assert_eq!(data, b"old\n");
        }
    }

    /// Reachability consults `main`, then only branches and fetch refs:
    /// never tags or recovery refs, however many there are (git before
    /// 2.49 tests every ref it is given). A commit only a tag or a recovery
    /// ref reaches is therefore "not here".
    #[test]
    fn readability_never_walks_tags_or_other_namespaces() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let files = tree(&git, &[("a.txt", "a\n")]);
        let main = commit(&git, &files, &[], 1_700_000_000, "main\n");
        let on_branch = commit(&git, &files, &[&main], 1_700_000_100, "branch\n");
        let tagged = commit(&git, &files, &[&main], 1_700_000_200, "tagged\n");
        let parked = commit(&git, &files, &[&main], 1_700_000_300, "parked\n");
        let mut packed = String::from("# pack-refs with: peeled fully-peeled sorted \n");
        let mut names = vec![
            (MAIN_REF.to_string(), main.clone()),
            ("refs/heads/side".to_string(), on_branch.clone()),
        ];
        for index in 0..300 {
            names.push((format!("refs/tags/t{index:03}"), tagged.clone()));
            names.push((
                format!("refs/instafy/recovery/{ORIGIN}/item-{index:03}"),
                parked.clone(),
            ));
        }
        names.sort();
        for (name, id) in &names {
            packed.push_str(&format!("{id} {name}\n"));
        }
        std::fs::write(mirror.join("packed-refs"), packed).unwrap();

        let log = root.join("args.log");
        let outcome = |rev: &str| {
            let _ = std::fs::remove_file(&log);
            let resolved = {
                let _wrapper = crate::test_support::GitWrapper::install(
                    &root,
                    &format!("echo \"$*\" >> '{}'", log.display()),
                );
                resolve(&git, "", &ReadAt::Rev(rev.to_string()))
            };
            let calls = std::fs::read_to_string(&log).unwrap_or_default();
            (resolved, calls)
        };

        let (resolved, calls) = outcome(&on_branch);
        assert_eq!(resolved.unwrap().as_deref(), Some(on_branch.as_str()));
        assert_eq!(calls.lines().count(), 3, "{calls}");
        let walk = calls
            .lines()
            .find(|line| line.contains("for-each-ref"))
            .unwrap();
        assert!(
            walk.ends_with(&format!(
                "--contains {on_branch} refs/heads {FETCHED_REF_ROOT}"
            )),
            "{walk}"
        );
        for rev in [&tagged, &parked] {
            let (resolved, calls) = outcome(rev);
            assert!(matches!(resolved, Err(ViewError::RevNotFound)), "{calls}");
            assert_eq!(calls.lines().count(), 3, "{calls}");
        }
    }

    /// A `packed-refs.lock` left by a process that was killed never holds a
    /// read up: removing the fetch refs is tried once with a short wait and
    /// then left to a later sweep, and the read is still correct.
    #[test]
    fn a_stale_packed_refs_lock_never_holds_a_read_up() {
        let (_dir, root) = tempdir();
        let (canonical, _main, revs) = canonical_with_many_refs(&root, 3);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let listed = list_remote_refs(&git, url).unwrap();
        let old = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - FETCH_SCRATCH_STALE_AFTER.as_secs()
            - 60;
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        let main = git.commit_id(MAIN_REF).unwrap().unwrap();
        let stale = format!("{FETCHED_REF_ROOT}/{old}-{:032x}/0", 1);
        git.update_ref(&stale, &main, None, "test").unwrap();
        std::fs::write(mirror.join("packed-refs.lock"), b"").unwrap();

        let log = root.join("commands.log");
        let started = std::time::Instant::now();
        let (fetched, resolved) = {
            let _wrapper = crate::test_support::GitWrapper::install(&root, &log_subcommands(&log));
            let fetched = fetch_refs(&git, url, &listed).unwrap();
            let resolved = resolve(&git, url, &ReadAt::Ref(listed[1].0.clone())).unwrap();
            (fetched, resolved)
        };
        let elapsed = started.elapsed();
        assert_eq!(pairs(&fetched.fetched), listed);
        assert_eq!(resolved.as_deref(), Some(revs[1].as_str()));
        // One delete attempt per sweep and per cleanup, never a retry loop
        // (which waited about a minute per call).
        let counts = subcommand_counts(&log);
        assert_eq!(counts.get("update-ref"), Some(&4), "{counts:?}");
        assert!(elapsed < std::time::Duration::from_secs(20), "{elapsed:?}");
        // The lock file is never removed.
        assert!(mirror.join("packed-refs.lock").exists());
    }

    /// A sweep that cannot remove a stale namespace (a ref lock left by a
    /// process that was killed) never fails the call, and the call still
    /// removes its own namespace.
    #[test]
    fn a_failed_sweep_never_fails_the_call() {
        let (_dir, root) = tempdir();
        let (canonical, main, _revs) = canonical_with_many_refs(&root, 2);
        let url = canonical.to_str().unwrap();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        let listed = list_remote_refs(&git, url).unwrap();
        let old = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - FETCH_SCRATCH_STALE_AFTER.as_secs()
            - 60;
        let namespace = format!("{FETCHED_REF_ROOT}/{old}-{:032x}", 7);
        let stale = format!("{namespace}/0");
        git.update_ref(&stale, &main, None, "test").unwrap();
        std::fs::write(mirror.join(format!("{stale}.lock")), b"").unwrap();
        for _ in 0..3 {
            let fetched = fetch_refs(&git, url, &listed).unwrap();
            assert_eq!(pairs(&fetched.fetched), listed);
        }
        let left: Vec<String> = git
            .refs_under(FETCHED_REF_ROOT)
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(left, vec![stale]);
    }

    /// The shard accepts a recovery ref naming a tag of a tag of a commit.
    /// Git before 2.45 peels `%(*objectname)` one level only; the commit is
    /// then found with one more process.
    #[test]
    fn a_recovery_ref_naming_nested_tags_reads_as_its_commit() {
        let (_dir, root) = tempdir();
        let (canonical, _main, revs) = canonical_with_many_refs(&root, 1);
        let url = canonical.to_str().unwrap();
        let tag = |name: &str, target: &str| {
            git_in(
                &canonical,
                &[
                    "-c",
                    "user.name=Tagger",
                    "-c",
                    "user.email=tagger@instafy.dev",
                    "tag",
                    "-a",
                    "-m",
                    name,
                    name,
                    target,
                ],
            );
            git_in(&canonical, &["rev-parse", &format!("refs/tags/{name}")])
        };
        let inner = tag("inner", &revs[0]);
        let outer = tag("outer", &inner);
        let name = format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-unsaved-nested");
        git_in(&canonical, &["update-ref", &name, &outer]);
        let reference = RecoveryRef::parse(&name).unwrap();

        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let listed = list_remote_refs(&git, url).unwrap();
        let fetched = fetch_refs(&git, url, &listed).unwrap();
        let nested = fetched
            .fetched
            .iter()
            .find(|fetched| fetched.reference == reference)
            .expect("listed");
        assert_eq!(
            (nested.tip.as_str(), nested.commit.as_str()),
            (outer.as_str(), revs[0].as_str())
        );

        // The second step on its own, as git before 2.45 needs it.
        let peeled = peel_to_commits(&git, &[inner.clone(), outer.clone()]);
        // The tags were fetched with the ref, so they are here.
        let peeled = peeled.unwrap();
        assert_eq!(
            peeled.get(&inner).map(String::as_str),
            Some(revs[0].as_str())
        );
        assert_eq!(
            peeled.get(&outer).map(String::as_str),
            Some(revs[0].as_str())
        );
        assert!(peel_to_commits(&git, &[]).unwrap().is_empty());
    }

    /// Dismiss looks at the ref, then deletes it under a lease on what it
    /// saw. Work saved to the ref between the two stays: the lease refuses
    /// the delete, and the dismissal answers 409 `recovery_ref_moved` with
    /// the new tip.
    #[test]
    fn a_dismissal_never_removes_work_saved_after_it_looked() {
        struct ClearHook;
        impl Drop for ClearHook {
            fn drop(&mut self) {
                crate::push::clear_push_hook();
            }
        }

        let (_dir, root) = tempdir();
        let canonical = bare(&root, "canonical.git");
        let remote = WorkspaceGit::bare(&canonical, None);
        let files = tree(&remote, &[("notes.md", "notes\n")]);
        let seen = commit(&remote, &files, &[], 1_700_000_000, "seen\n");
        let newer = commit(&remote, &files, &[&seen], 1_700_000_100, "newer\n");
        let name = format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-unsaved-0123456789ab");
        remote.update_ref(&name, &seen, None, "test").unwrap();
        let reference = RecoveryRef::parse(&name).unwrap();
        let local_dir = bare(&root, "local.git");
        let local = WorkspaceGit::bare(&local_dir, None);
        let url = format!("file://{}", canonical.display());

        let moved = std::rc::Rc::new(std::cell::Cell::new(false));
        let _clear = ClearHook;
        {
            let moved = moved.clone();
            let canonical = canonical.clone();
            let (name, newer) = (name.clone(), newer.clone());
            crate::push::set_push_hook(move |_| {
                if !moved.replace(true) {
                    git_in(&canonical, &["update-ref", &name, &newer]);
                }
                crate::push::PushHookAction::Proceed
            });
        }
        let error = dismiss(&local, &url, &reference, &seen).unwrap_err();
        assert!(moved.get(), "the delete was never attempted");
        match error {
            OriginError::WithReport { code, report, .. } => {
                assert_eq!(code, "recovery_ref_moved");
                assert_eq!(report["rev"], newer.as_str());
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            remote.commit_id(&name).unwrap().as_deref(),
            Some(newer.as_str())
        );
    }

    #[test]
    fn only_the_exact_restore_message_names_a_ref_and_saves_drop_it() {
        let reference =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-unsaved-0123456789ab");
        let message = restore_commit_message(&reference);
        assert_eq!(restored_from(&message), Some(reference.as_str()));
        for other in [
            format!("Tidy\n\n{RESTORED_FROM_TRAILER}: {reference}\n"),
            format!("Restore unsaved work\n\n{RESTORED_FROM_TRAILER}: {reference}\nX-Other: y\n"),
            format!("Restore unsaved work\n\n{RESTORED_FROM_TRAILER}: {reference}"),
            format!("Restore unsaved work\n\n{RESTORED_FROM_TRAILER}: refs/heads/main\n"),
            format!("Restore unsaved work\nmore\n\n{RESTORED_FROM_TRAILER}: {reference}\n"),
        ] {
            assert_eq!(restored_from(&other), None, "{other:?}");
        }
        assert_eq!(
            without_origin_trailers(&format!(
                "Fix\n\nInstafy-Resolved-By: assistant\n  instafy-restored-from : {reference}\n\
                 {RESTORED_FROM_TRAILER}: {reference}"
            )),
            "Fix\n\nInstafy-Resolved-By: assistant"
        );
        assert_eq!(
            without_origin_trailers("Notes on Instafy-Restored-From handling\n"),
            "Notes on Instafy-Restored-From handling"
        );
    }

    /// Caller text never carries a trailer the origin or the gateway writes
    /// and reads back (`Instafy-Restored-From`, `Instafy-Apply-Key`, the
    /// recovery trailers, any other `Instafy-` key): control characters
    /// before it (other than tab) do not hide it. `Instafy-Resolved-By`,
    /// which callers write and history only shows, stays.
    #[test]
    fn saves_drop_every_origin_trailer_however_it_is_hidden() {
        let reference =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-unsaved-0123456789ab");
        let message = format!(
            "Fix\n\nInstafy-Resolved-By: assistant\n\
             \u{1}Instafy-Restored-From: {reference}\n\
             \r\u{7f} instafy-restored-from: {reference}\n\
             \t\u{1b}INSTAFY-APPLY-KEY: imp:forged\n\
             Instafy-Apply-Fingerprint: abc\n\
             \u{0}Instafy-Recovery-Kind: unsaved\n\
             Instafy-Origin: {ORIGIN}\n\
             Signed-off-by: A <a@x>\n"
        );
        assert_eq!(
            without_origin_trailers(&message),
            "Fix\n\nInstafy-Resolved-By: assistant\nSigned-off-by: A <a@x>"
        );
        // Text that only mentions a trailer, or has no key before it, stays.
        for kept in [
            "Notes on Instafy-Apply-Key handling\n",
            "See \u{1}Instafy-Restored-From\n",
            "Instafy\n",
        ] {
            assert_eq!(without_origin_trailers(kept), kept.trim_end(), "{kept:?}");
        }
    }

    /// The longest one git call of the trailer tests may take: they fail
    /// with the call and its input past it, never wait forever.
    const GIT_CALL_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

    /// The output of plain git `args` with `input` on stdin, outside any
    /// repository and with no configuration, within [`GIT_CALL_LIMIT`].
    fn git_stdout_within_limit(args: &[&str], input: &str) -> String {
        let (_dir, root) = tempdir();
        let output = crate::test_support::git_output_within(
            &root,
            args,
            input.as_bytes(),
            GIT_CALL_LIMIT,
        )
        .unwrap_or_else(|| {
            panic!("git {args:?} did not return within {GIT_CALL_LIMIT:?} for {input:?}; stopped")
        });
        assert!(
            output.status.success(),
            "git {args:?} for {input:?}: {output:?}"
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Whether `message` has a scissors line below a `---` line. On such a
    /// message git 2.34's `interpret-trailers` without `--no-divider` never
    /// returns: its message end at the scissors line lies past the one it
    /// took at the divider (later git bounds it).
    fn loops_git_2_34_with_divider(message: &str) -> bool {
        let mut below_divider = false;
        for line in message.split('\n') {
            if below_divider && line.starts_with(SCISSORS_LINE) {
                return true;
            }
            below_divider |= line
                .strip_prefix("---")
                .is_some_and(|rest| rest.bytes().next().is_none_or(|b| b.is_ascii_whitespace()));
        }
        false
    }

    /// The trailer keys git's own parser reads in `message`, in lower case:
    /// `git interpret-trailers --parse --no-divider` (as `%(trailers)`
    /// reads a commit) and, unless git 2.34 would loop on `message`
    /// ([`loops_git_2_34_with_divider`]), without `--no-divider` too, with
    /// no configuration. Each call fails the test past [`GIT_CALL_LIMIT`].
    fn git_trailer_keys(message: &str) -> Vec<String> {
        let mut runs = vec![&["interpret-trailers", "--parse", "--no-divider"][..]];
        if !loops_git_2_34_with_divider(message) {
            runs.push(&["interpret-trailers", "--parse"][..]);
        }
        let mut keys = Vec::new();
        for args in runs {
            for line in git_stdout_within_limit(args, message).lines() {
                let (key, _) = line.split_once(':').unwrap_or((line, ""));
                keys.push(key.trim().to_ascii_lowercase());
            }
        }
        keys
    }

    /// `message` as `git commit -m` keeps it (`git stripspace`).
    fn git_stripspace(message: &str) -> String {
        git_stdout_within_limit(&["stripspace"], message)
    }

    /// The trailer tests never hang on git 2.34: a message it loops on is
    /// read only with `--no-divider`, and every git call is bounded.
    #[test]
    fn the_trailer_tests_never_wait_on_a_git_that_loops() {
        let looping = format!("Tidy\n\n--- x\n{SCISSORS_LINE}\nInstafy-Apply-Key: imp:x\n");
        assert!(loops_git_2_34_with_divider(&looping));
        assert!(git_trailer_keys(&looping).is_empty());
        for other in [
            format!("Tidy\n\n{SCISSORS_LINE}\n---\n"),
            "Tidy\n\n---x\nmore".to_string(),
            "Tidy\n\n---\nmore".to_string(),
        ] {
            assert!(!loops_git_2_34_with_divider(&other), "{other:?}");
        }
        // A git that never returns is stopped, not waited on.
        let (_dir, root) = tempdir();
        let started = std::time::Instant::now();
        let stopped = crate::test_support::git_output_within(
            &root,
            &["-c", "alias.wait=!sleep 30", "wait"],
            b"",
            std::time::Duration::from_millis(300),
        );
        assert!(stopped.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
    }

    /// A save drops only the `Instafy-` trailers git reads in the trailer
    /// block, never prose: a subject or a body line that starts with
    /// `Instafy-`, a `Key: value` line in another paragraph, or a last
    /// paragraph git does not read as trailers stays word for word, and so
    /// does a key git would not parse (Unicode look-alikes, a format
    /// character before it). Every variant git reads, or would read once a
    /// save trims the text or its control characters are set aside, goes,
    /// so no save message is the restore message or carries a receipt.
    #[test]
    fn saves_keep_prose_and_drop_only_the_trailers_git_reads() {
        let reference =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-unsaved-0123456789ab");
        let reads_origin_trailer = |message: &str| {
            git_trailer_keys(message)
                .iter()
                .any(|key| key.starts_with("instafy-") && key != "instafy-resolved-by")
        };
        // What the origin commits: trimmed with a newline (a Desktop save),
        // or as `git commit -m` keeps it (the multi-tenant routes).
        let assert_clean = |message: &str, saved: &str| {
            for committed in [format!("{}\n", saved.trim()), git_stripspace(saved)] {
                assert!(
                    !reads_origin_trailer(&committed),
                    "{message:?} saved as {committed:?}"
                );
                assert_eq!(restored_from(&committed), None, "{message:?}");
            }
        };

        let prose = [
            "Instafy-style buttons on the landing page".to_string(),
            "instafy-cli: bump the version\n\nMore detail here".to_string(),
            "Tidy\n\nInstafy-hosted docs are linked now".to_string(),
            "Tidy\n\ninstafy-cli: now prints JSON.\nIt also fixes the flag parsing.".to_string(),
            "Tidy\n\ninstafy-cli: now prints JSON.\n\nMore detail here".to_string(),
            format!("Tidy\n\nInstafy-Restored-From: {reference}\n\nQuoted above, not a trailer."),
            "Tidy\n\nInstafy-style note in a trailer block\nSigned-off-by: A <a@x>".to_string(),
            "Notes on Instafy-Apply-Key handling".to_string(),
            "See \u{1}Instafy-Restored-From".to_string(),
            "Instafy".to_string(),
        ];
        let look_alikes = [
            format!("Tidy\n\n\u{feff}Instafy-Restored-From: {reference}"),
            format!("Tidy\n\n\u{200b}Instafy-Restored-From: {reference}"),
            format!("Tidy\n\n\u{a0}Instafy-Restored-From: {reference}"),
            format!("Tidy\n\n\u{406}nstafy-Restored-From: {reference}"),
            format!("Tidy\n\n\u{ff29}nstafy-Restored-From: {reference}"),
            format!("Tidy\n\nInstafy\u{2010}Restored-From: {reference}"),
            format!("Tidy\n\nInstafy-Restored-From\u{ff1a} {reference}"),
            format!("Tidy\n\nInstafy-Restored-From\u{a0}: {reference}"),
        ];
        for message in prose.iter().chain(&look_alikes) {
            assert!(!reads_origin_trailer(message), "git reads {message:?}");
            assert_eq!(without_origin_trailers(message), *message, "{message:?}");
            assert_clean(message, message);
        }

        // Trailers git reads: any letter case, blanks before the colon, a
        // block a `Signed-off-by: ` line lets hold other text, before a
        // `---` line, trailing comments or the scissors line, and a block
        // that is last only once the one below it is gone.
        let read = [
            (
                format!("Tidy\n\nINSTAFY-RESTORED-FROM: {reference}"),
                "Tidy".to_string(),
            ),
            (
                format!("Tidy\n\ninstafy-restored-from : {reference}\nSigned-off-by: A <a@x>"),
                "Tidy\n\nSigned-off-by: A <a@x>".to_string(),
            ),
            (
                "Tidy\n\nprose one\nprose two\nInstafy-Apply-Key: imp:x\nSigned-off-by: A <a@x>"
                    .to_string(),
                "Tidy\n\nprose one\nprose two\nSigned-off-by: A <a@x>".to_string(),
            ),
            (
                format!("Tidy\n\nInstafy-Restored-From: {reference}\n\u{1}\nSigned-off-by: A"),
                "Tidy\n\n\u{1}\nSigned-off-by: A".to_string(),
            ),
            (
                format!("Tidy\n\nInstafy-Restored-From: {reference}\n---\nmore text"),
                "Tidy\n\n---\nmore text".to_string(),
            ),
            (
                format!("Tidy\n\nInstafy-Restored-From: {reference}\n\n# a comment"),
                "Tidy\n\n\n# a comment".to_string(),
            ),
            (
                format!(
                    "Tidy\n\nInstafy-Restored-From: {reference}\n\n# a comment\n\
                     Conflicts:\n\tpath.md"
                ),
                "Tidy\n\n\n# a comment\nConflicts:\n\tpath.md".to_string(),
            ),
            (
                format!(
                    "Tidy\n\nInstafy-Restored-From: {reference}\n\
                     # ------------------------ >8 ------------------------\nmore text"
                ),
                "Tidy\n\n# ------------------------ >8 ------------------------\nmore text"
                    .to_string(),
            ),
            (
                format!(
                    "Restore unsaved work\n\nInstafy-Restored-From: {reference}\n\n\
                     Instafy-Apply-Key: imp:x"
                ),
                "Restore unsaved work".to_string(),
            ),
        ];
        for (message, saved) in &read {
            assert!(
                reads_origin_trailer(message),
                "git reads none in {message:?}"
            );
            assert_eq!(without_origin_trailers(message), *saved, "{message:?}");
            assert_clean(message, saved);
        }

        // Trailers git does not read as given, but would once the save trims
        // the text, or a reader sets control characters aside.
        let hidden = [
            (
                format!("Restore unsaved work\n\nInstafy-Restored-From: {reference}\n\u{3000}"),
                "Restore unsaved work".to_string(),
            ),
            (
                format!(
                    "Tidy\n\n\u{1}Instafy-Restored-From: {reference}\n\
                     \r\u{7f}Instafy-Apply-Key: imp:x\nInsta\u{1b}fy-Apply-Fingerprint: abc"
                ),
                "Tidy".to_string(),
            ),
        ];
        for (message, saved) in &hidden {
            assert_eq!(without_origin_trailers(message), *saved, "{message:?}");
            assert_clean(message, saved);
        }

        // Paragraph after paragraph of trailers: each round makes the one
        // above it last, and past the bound every `Instafy-` trailer line
        // below the subject goes at once.
        let stacked = format!(
            "Restore unsaved work\n\nInstafy-Restored-From: {reference}{}",
            "\n\nInstafy-Apply-Key: imp:x".repeat(20_000)
        );
        assert_eq!(without_origin_trailers(&stacked), "Restore unsaved work");
    }

    #[test]
    fn commits_are_parsed_from_their_raw_form() {
        let raw = b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
                    parent 0123456789abcdef0123456789abcdef01234567\n\
                    parent 89abcdef0123456789abcdef0123456789abcdef\n\
                    author A <a@x> 1700000000 +0000\n\
                    committer C <c@x> 1700000000 -0130\n\
                    \n\
                    Keep changes\n\
                    that wrap\n\
                    \n\
                    Instafy-Path: in-the-body.md\n\
                    \n\
                    Local commits:\n\
                    - abc123 a: b (x)\n\
                    \n\
                    Instafy-Recovery-Kind: unsaved\n\
                    Instafy-Path: one.md\n\
                    Instafy-Path: two: with colon.md\n\
                    not a trailer line\n";
        let parsed = parse_commit(raw);
        assert_eq!(parsed.parents.len(), 2);
        assert_eq!(parsed.subject, "Keep changes that wrap");
        assert_eq!(parsed.timestamp, 1_700_000_000);
        assert_eq!(parsed.date.as_deref(), Some("2023-11-14T20:43:20-01:30"));
        assert_eq!(
            parsed.trailers,
            vec![
                ("Instafy-Recovery-Kind".to_string(), "unsaved".to_string()),
                ("Instafy-Path".to_string(), "one.md".to_string()),
                ("Instafy-Path".to_string(), "two: with colon.md".to_string()),
            ]
        );
        assert_eq!(parsed.trailer("Instafy-Recovery-Kind"), Some("unsaved"));

        let subject_only =
            parse_commit(b"tree x\ncommitter C <c@x> 1 +0000\n\nOnly a subject: here\n");
        assert_eq!(subject_only.subject, "Only a subject: here");
        assert!(subject_only.trailers.is_empty());
        assert_eq!(parse_commit(b"garbage").date, None);
    }
}
