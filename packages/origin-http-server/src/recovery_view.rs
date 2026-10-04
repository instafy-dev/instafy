//! Reads of committed objects, with no work tree: the entries and files of a
//! commit, first-parent history, the recovery and salvage refs a person can
//! review, and the checks on the `rev` and `ref` values a client sends.
//!
//! Everything here runs through [`WorkspaceGit`], so it works the same on the
//! hosted gateway's bare mirrors and on a Desktop checkout's `.instafy/.git`,
//! and never reads a workspace file. Nothing here talks to the network except
//! [`list_remote_refs`], [`remote_tip`] and [`fetch_refs`]; callers decide
//! when to fetch.
//!
//! The one rule for a ref a client may name (`?ref=`, restore, dismiss) is
//! `^refs/instafy/(recovery/<lower-case uuid>|salvage/gateway)/[0-9A-Za-z._-]+$`,
//! and `git check-ref-format` must accept it. Refs reach git only after
//! `--end-of-options` (or, for `check-ref-format`, which has no such option,
//! only once they are known to start with `refs/`).

// The hosted gateway's reads and the recovery routes call these as they land;
// until then only the tests do.
#![cfg_attr(not(test), allow(dead_code))]

use axum::http::StatusCode;
use chrono::{FixedOffset, SecondsFormat, TimeZone as _};
use git_service::policy::{RECOVERY_REF_ROOT, SALVAGE_REF_ROOT};
use serde::Serialize;
use uuid::Uuid;

use crate::apply::normalize_relative_path;
use crate::error::OriginError;
use crate::git::{is_full_object_id, GitHistoryEntry, HistoryFormat};
use crate::paths::is_reserved_path;
use crate::recovery::{RecoveryKind, CONFLICT_TRAILER, KIND_TRAILER, PATH_TRAILER};
use crate::workspace_git::{RunOpts, WorkspaceGit};

/// Where salvaged work from retired gateway working copies lives.
pub(crate) const SALVAGE_GATEWAY_ROOT: &str = "refs/instafy/salvage/gateway";

/// The branch every read without `rev` or `ref` shows.
pub(crate) const MAIN_REF: &str = "refs/heads/main";

/// Longest name of a recovery ref (after its origin id): one file name.
const MAX_RECOVERY_NAME_BYTES: usize = 255;

/// Longest name of a salvage ref, as the shard allows.
const MAX_SALVAGE_NAME_BYTES: usize = 100;

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
    #[error(
        "ref must be refs/instafy/recovery/<origin id>/<name> or \
         refs/instafy/salvage/gateway/<name>"
    )]
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
            Self::RevNotFound => "rev_not_found",
            Self::RefNotFound => "not_found",
            Self::Git(_) => "internal",
        }
    }

    pub(crate) fn status(&self) -> StatusCode {
        match self {
            Self::InvalidRef | Self::RevAndRef | Self::InvalidRev | Self::InvalidPath => {
                StatusCode::BAD_REQUEST
            }
            Self::RevNotFound | Self::RefNotFound => StatusCode::NOT_FOUND,
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

/// Which namespace a [`RecoveryRef`] is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RefSource {
    /// `refs/instafy/recovery/<origin id>/<name>`: work an origin could not
    /// save. A person may restore or dismiss it.
    Recovery { origin: Uuid },
    /// `refs/instafy/salvage/gateway/<name>`: work kept from a retired
    /// gateway working copy. It is kept for good: the shard refuses every
    /// change to it, so it can be restored but never dismissed.
    Salvage,
}

/// A recovery or salvage ref name that passed the rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RecoveryRef {
    name: String,
    source: RefSource,
}

impl RecoveryRef {
    /// Check `name` against the rule without running git:
    ///
    /// - a recovery ref is `refs/instafy/recovery/<lower-case hyphenated
    ///   origin id>/<name>`, where `<name>` is up to 255 bytes of
    ///   `[0-9A-Za-z._-]` that `git check-ref-format` would also accept (no
    ///   leading `.`, no `..`, no trailing `.` or `.lock`, the latter in any
    ///   letter case so it cannot alias a lock file on a case-insensitive
    ///   disk);
    /// - a salvage ref is `refs/instafy/salvage/gateway/<name>` under the
    ///   rule the shard holds salvage refs to: up to 100 bytes of
    ///   `[0-9a-z._-]` starting with `[0-9a-z]`, with no `..` and no trailing
    ///   `.` or `.lock`.
    pub(crate) fn parse(name: &str) -> Result<Self, ViewError> {
        let recovery_prefix = format!("{RECOVERY_REF_ROOT}/");
        let salvage_prefix = format!("{SALVAGE_GATEWAY_ROOT}/");
        let source = if let Some(rest) = name.strip_prefix(&recovery_prefix) {
            let (origin, last) = rest.split_once('/').ok_or(ViewError::InvalidRef)?;
            if !is_lower_case_uuid(origin) || !is_valid_recovery_name(last) {
                return Err(ViewError::InvalidRef);
            }
            let origin = Uuid::parse_str(origin).map_err(|_| ViewError::InvalidRef)?;
            RefSource::Recovery { origin }
        } else if let Some(last) = name.strip_prefix(&salvage_prefix) {
            if !is_valid_salvage_name(last) {
                return Err(ViewError::InvalidRef);
            }
            RefSource::Salvage
        } else {
            return Err(ViewError::InvalidRef);
        };
        Ok(Self {
            name: name.to_string(),
            source,
        })
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

    pub(crate) fn source(&self) -> &RefSource {
        &self.source
    }

    pub(crate) fn is_salvage(&self) -> bool {
        self.source == RefSource::Salvage
    }

    /// Whether a person may dismiss it (delete it under a lease on the
    /// listed commit). Salvage refs never are.
    pub(crate) fn dismissible(&self) -> bool {
        !self.is_salvage()
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

/// The shard's rule for the name of a salvage ref.
fn is_valid_salvage_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_SALVAGE_NAME_BYTES
        && matches!(bytes[0], b'0'..=b'9' | b'a'..=b'z')
        && bytes
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'z' | b'.' | b'_' | b'-'))
        && !name.contains("..")
        && !name.ends_with('.')
        && !name.ends_with(".lock")
}

/// A commit id a client sends (`?rev=`, `baseRev`, a listed `rev`): exactly
/// 40 or 64 hex digits, returned in lower case.
pub(crate) fn parse_rev(value: &str) -> Result<String, ViewError> {
    if matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(ViewError::InvalidRev)
    }
}

/// What a read names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReadAt {
    /// `main`.
    Main,
    /// One commit (`?rev=`).
    Rev(String),
    /// The tip of a recovery or salvage ref (`?ref=`).
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

/// The commit `at` names in the repository now, without any network call:
/// `main`'s tip (`None` while `main` does not exist), the commit itself
/// ([`ViewError::RevNotFound`] when it is not here or is not a commit), or
/// the ref's local tip ([`ViewError::RefNotFound`] when it was not fetched).
pub(crate) fn resolve_local(
    git: &WorkspaceGit<'_>,
    at: &ReadAt,
) -> Result<Option<String>, ViewError> {
    match at {
        ReadAt::Main => Ok(git.commit_id(MAIN_REF)?),
        ReadAt::Rev(rev) => match git.commit_id(rev)? {
            Some(commit) if commit == *rev => Ok(Some(commit)),
            _ => Err(ViewError::RevNotFound),
        },
        ReadAt::Ref(reference) => match local_tip(git, reference)? {
            Some(tip) => match git.commit_id(&tip)? {
                Some(commit) => Ok(Some(commit)),
                None => Err(ViewError::RefNotFound),
            },
            None => Err(ViewError::RefNotFound),
        },
    }
}

/// What `reference` names here, found by its exact name. Git's own lookup
/// of a missing name falls back to other forms (a name ending in
/// `-<n>-g<hex>` reads as an abbreviated commit id), and on a
/// case-insensitive disk two names that differ only in letter case are one
/// file; neither may stand for the ref. `None` when the ref is not here, or
/// another ref here differs from it only in letter case.
pub(crate) fn local_tip(
    git: &WorkspaceGit<'_>,
    reference: &RecoveryRef,
) -> Result<Option<String>, ViewError> {
    let namespace = reference
        .as_str()
        .rsplit_once('/')
        .map(|(namespace, _)| namespace)
        .unwrap_or_default();
    let mut tip = None;
    for (name, id) in local_refs(git, &[namespace])? {
        if name == reference.as_str() {
            tip = Some(id);
        } else if name.eq_ignore_ascii_case(reference.as_str()) {
            return Ok(None);
        }
    }
    Ok(tip)
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
        return Ok(TreeRead::Directory(listed_children("", &raw)));
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
            Ok(TreeRead::Directory(listed_children(&path, &raw)))
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

/// The shown entry at exactly `path` in `commit`, if any.
fn entry_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
) -> Result<Option<ObjectEntry>, ViewError> {
    let raw = git.bytes_opts(
        &[
            "ls-tree",
            "-l",
            "-z",
            "--full-tree",
            "--end-of-options",
            commit,
            "--",
            path,
        ],
        &RunOpts {
            literal_pathspecs: true,
            ..RunOpts::default()
        },
    )?;
    Ok(parse_ls_tree_long(&raw)
        .into_iter()
        .find(|(entry_path, _)| entry_path == path)
        .and_then(|(_, entry)| entry))
}

/// The shown entries of one `ls-tree -l -z` listing of a folder at
/// `parent` ("" for the root).
fn listed_children(parent: &str, raw: &[u8]) -> Vec<ObjectEntry> {
    parse_ls_tree_long(raw)
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
        .collect()
}

/// `(path, entry)` for each record of `ls-tree -l -z` output, where the
/// entry is `None` for anything that is neither a regular file nor a folder
/// (symlinks, submodules).
fn parse_ls_tree_long(raw: &[u8]) -> Vec<(String, Option<ObjectEntry>)> {
    raw.split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let tab = record.iter().position(|byte| *byte == b'\t')?;
            let meta = std::str::from_utf8(&record[..tab]).ok()?;
            let path = std::str::from_utf8(&record[tab + 1..]).ok()?.to_string();
            let mut fields = meta.split_whitespace();
            let mode = fields.next()?.to_string();
            let object_type = fields.next()?;
            let oid = fields.next()?.to_string();
            let size = fields.next()?;
            let entry = match (mode.as_str(), object_type) {
                ("100644" | "100755", "blob") => Some(ObjectEntry {
                    path: path.clone(),
                    kind: ObjectKind::File,
                    mode,
                    oid,
                    size: Some(size.parse().ok()?),
                }),
                ("040000", "tree") => Some(ObjectEntry {
                    path: path.clone(),
                    kind: ObjectKind::Directory,
                    mode,
                    oid,
                    size: None,
                }),
                _ => None,
            };
            Some((path, entry))
        })
        .collect()
}

/// Up to `limit` (at most [`MAX_HISTORY_PAGE`]) commits of `head`'s
/// first-parent chain after skipping `skip`, newest first, each with its
/// first parent.
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
    let head = parse_rev(head)?;
    let limit = limit.min(MAX_HISTORY_PAGE);
    // Git reads the count as an int: a larger skip is past any history.
    if limit == 0 || skip > MAX_HISTORY_SKIP {
        return Ok(Vec::new());
    }
    let max_count = limit.to_string();
    let skip = skip.to_string();
    let walk = ["--first-parent", "--max-count", &max_count, "--skip", &skip];
    let mut args = vec!["rev-list", "--parents"];
    args.extend(walk);
    args.extend(["--end-of-options", &head, "--"]);
    let listed = git.stdout(&args)?;
    let mut chain = Vec::new();
    for line in listed.lines() {
        let mut ids = line.split(' ');
        let commit = ids.next().unwrap_or_default();
        if !is_full_object_id(commit) {
            return Err(anyhow::anyhow!("rev-list printed {line:?}").into());
        }
        chain.push((commit.to_string(), ids.next().map(str::to_string)));
    }

    let format = HistoryFormat::new();
    let pretty = format.pretty_arg();
    let mut args = vec!["log"];
    args.extend(walk);
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
            .any(|(entry, (commit, _))| entry.commit != *commit)
    {
        return Err(anyhow::anyhow!("the history of {head} changed while it was read").into());
    }
    for (entry, (_, first_parent)) in entries.iter_mut().zip(chain) {
        entry.first_parent = first_parent;
    }
    Ok(entries)
}

/// `(ref, rev)` for every recovery and salvage ref on `remote` that passes
/// the rule. Any other name there is left out, and so is every name that
/// differs from another one there only in letter case: on a
/// case-insensitive disk (a Desktop checkout) the two would be one file, so
/// neither can be fetched or read as itself.
pub(crate) fn list_remote_refs(
    git: &WorkspaceGit<'_>,
    remote: &str,
) -> Result<Vec<(RecoveryRef, String)>, ViewError> {
    let listed = remote_names(git, remote)?;
    let mut refs = Vec::new();
    for (name, rev) in &listed {
        if differs_only_in_case(name, listed.iter().map(|(other, _)| other.as_str())) {
            tracing::warn!(
                target: "origin_recovery",
                reference = %name,
                "left a recovery ref out: another ref differs from it only in letter case"
            );
            continue;
        }
        if let (Ok(reference), Ok(rev)) = (RecoveryRef::parse(name), parse_rev(rev)) {
            refs.push((reference, rev));
        }
    }
    Ok(refs)
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

/// Every `(name, rev)` under the recovery and salvage namespaces on
/// `remote`, whether or not it passes the rule.
fn remote_names(git: &WorkspaceGit<'_>, remote: &str) -> Result<Vec<(String, String)>, ViewError> {
    let recovery = format!("{RECOVERY_REF_ROOT}/*");
    let salvage = format!("{SALVAGE_REF_ROOT}/*");
    let raw = git.stdout(&[
        "ls-remote",
        "--refs",
        "--end-of-options",
        remote,
        &recovery,
        &salvage,
    ])?;
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

/// Whether one of `others` is `name` in another letter case.
fn differs_only_in_case<'b>(name: &str, mut others: impl Iterator<Item = &'b str>) -> bool {
    others.any(|other| other != name && other.eq_ignore_ascii_case(name))
}

/// What [`fetch_refs`] did with each ref it was asked for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct FetchedRefs {
    /// Fetched, with the commit each one names here now.
    pub fetched: Vec<(RecoveryRef, String)>,
    /// Not on the remote (any more): dismissed, restored or never there.
    pub missing: Vec<RecoveryRef>,
    /// Left alone: another ref on the remote or here differs from it only
    /// in letter case, so on a case-insensitive disk fetching it would
    /// overwrite the other.
    pub ambiguous: Vec<RecoveryRef>,
}

/// Fetch `references` from `remote` into the same names here, replacing
/// whatever they named before. A ref the remote no longer has (another tab
/// dismissed it, a publish retired it, even between the listing and the
/// fetch) is reported missing and never fails the others; only a failure
/// to reach the remote is an error.
pub(crate) fn fetch_refs(
    git: &WorkspaceGit<'_>,
    remote: &str,
    references: &[&RecoveryRef],
) -> Result<FetchedRefs, ViewError> {
    let mut outcome = FetchedRefs::default();
    if references.is_empty() {
        return Ok(outcome);
    }
    let listed = remote_names(git, remote)?;
    let here = local_refs(git, &[RECOVERY_REF_ROOT, SALVAGE_REF_ROOT])?;
    let mut wanted = Vec::new();
    for reference in references {
        let name = reference.as_str();
        let others = listed.iter().chain(&here).map(|(other, _)| other.as_str());
        if differs_only_in_case(name, others) {
            outcome.ambiguous.push((*reference).clone());
        } else if listed.iter().any(|(listed, _)| listed == name) {
            wanted.push(*reference);
        } else {
            outcome.missing.push((*reference).clone());
        }
    }
    if !wanted.is_empty() && fetch_exactly(git, remote, &wanted).is_err() {
        // One ref vanished after the listing, or the remote failed: fetch
        // each on its own and tell the two apart.
        let mut still = Vec::new();
        for reference in wanted {
            match fetch_exactly(git, remote, &[reference]) {
                Ok(()) => still.push(reference),
                Err(error) => match remote_tip(git, remote, reference)? {
                    None => outcome.missing.push(reference.clone()),
                    Some(_) => return Err(error),
                },
            }
        }
        wanted = still;
    }
    for reference in wanted {
        match local_tip(git, reference)? {
            Some(tip) => outcome.fetched.push((reference.clone(), tip)),
            None => outcome.missing.push(reference.clone()),
        }
    }
    Ok(outcome)
}

fn fetch_exactly(
    git: &WorkspaceGit<'_>,
    remote: &str,
    references: &[&RecoveryRef],
) -> Result<(), ViewError> {
    let refspecs: Vec<String> = references
        .iter()
        .map(|reference| format!("+{0}:{0}", reference.as_str()))
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

/// What a person sees about one recovery or salvage ref.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ItemKind {
    Conflict,
    Unpublished,
    Unsaved,
    Stale,
    Salvage,
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
    pub rev: String,
    pub kind: ItemKind,
    pub subject: String,
    /// The committer date, ISO 8601.
    pub date: Option<String>,
    /// The origin whose namespace a recovery ref is in (none for salvage).
    pub origin: Option<Uuid>,
    /// For a conflict, the conflicted paths only; otherwise the paths the
    /// commit names as kept.
    pub paths: Vec<String>,
    /// Where the work left `main`: review and restore compare against it.
    pub base: Option<String>,
    pub dismissible: bool,
    #[serde(skip)]
    timestamp: i64,
}

/// Describe `refs` (each with the commit it names, fetched here), newest
/// first, at most [`MAX_RECOVERY_ITEMS`]; a ref whose commit is not here is
/// left out. `main` (when it exists) gives each listed item its `base`.
pub(crate) fn describe(
    git: &WorkspaceGit<'_>,
    refs: &[(RecoveryRef, String)],
    main: Option<&str>,
) -> Result<Vec<RecoveryItem>, ViewError> {
    // A ref whose commit is not here (it vanished before it could be
    // fetched) is left out rather than failing the list.
    let revs: Vec<String> = refs.iter().map(|(_, rev)| rev.clone()).collect();
    let present: Vec<&(RecoveryRef, String)> = refs
        .iter()
        .zip(git.object_sizes(&revs)?)
        .filter(|(_, found)| matches!(found, Some((kind, _)) if kind == "commit"))
        .map(|(entry, _)| entry)
        .collect();
    let revs: Vec<String> = present.iter().map(|(_, rev)| rev.clone()).collect();
    let objects = git.read_objects(&revs)?;
    let mut items = Vec::with_capacity(present.len());
    for ((reference, rev), object) in present.into_iter().zip(objects) {
        let commit = parse_commit(&object.data);
        let kind = match reference.source() {
            RefSource::Salvage => ItemKind::Salvage,
            RefSource::Recovery { .. } => commit
                .trailer(KIND_TRAILER)
                .and_then(recovery_kind)
                .or_else(|| {
                    let name = reference.as_str().rsplit('/').next().unwrap_or_default();
                    crate::recovery::kind_of_name(name)
                })
                .map(ItemKind::from)
                .unwrap_or(ItemKind::Unknown),
        };
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
            rev: rev.clone(),
            kind,
            subject: commit.subject,
            date: commit.date,
            origin: match reference.source() {
                RefSource::Recovery { origin } => Some(*origin),
                RefSource::Salvage => None,
            },
            paths,
            base: None,
            dismissible: reference.dismissible(),
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
            item.base = git.merge_base(&item.rev, main)?;
        }
    }
    Ok(items)
}

/// A recovery ref's own kind; `salvage` (or anything else) on a recovery ref
/// is not one, so a recovery ref can never pass for salvaged work.
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

    #[test]
    fn the_ref_rule_accepts_only_recovery_and_salvage_names() {
        let recovery =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T120000Z-conflict-0123456789ab");
        let parsed = RecoveryRef::parse(&recovery).unwrap();
        assert_eq!(parsed.as_str(), recovery);
        assert_eq!(
            parsed.source(),
            &RefSource::Recovery {
                origin: Uuid::parse_str(ORIGIN).unwrap()
            }
        );
        assert!(parsed.dismissible());
        let longest_salvage = format!("refs/instafy/salvage/gateway/{}", "a".repeat(100));
        for salvage in [
            "refs/instafy/salvage/gateway/node-1.local-0123abcd",
            "refs/instafy/salvage/gateway/0-leading-digit",
            "refs/instafy/salvage/gateway/a_b.c",
            &longest_salvage,
        ] {
            let parsed = RecoveryRef::parse(salvage).unwrap();
            assert!(parsed.is_salvage() && !parsed.dismissible(), "{salvage}");
        }

        let long = format!("refs/instafy/recovery/{ORIGIN}/{}", "a".repeat(256));
        let long_salvage = format!("refs/instafy/salvage/gateway/{}", "a".repeat(101));
        let upper = format!("refs/instafy/recovery/{}/name", ORIGIN.to_ascii_uppercase());
        for rejected in [
            "",
            "refs/heads/main",
            "--upload-pack=x",
            "refs/instafy/recovery",
            "refs/instafy/recovery/",
            &format!("refs/instafy/recovery/{ORIGIN}"),
            &format!("refs/instafy/recovery/{ORIGIN}/"),
            &format!("refs/instafy/recovery/{ORIGIN}/a/b"),
            &upper,
            "refs/instafy/recovery/0b7c2f1058a44e6b9f0e2d1c3b4a5f60/name",
            "refs/instafy/recovery/not-a-uuid/name",
            "refs/instafy/salvage/gateway",
            "refs/instafy/salvage/gateway/",
            "refs/instafy/salvage/other/name",
            "refs/instafy/salvage/name",
            "refs/INSTAFY/salvage/gateway/name",
            "refs/instafy/SALVAGE/gateway/name",
            "refs/instafy/local-recovery/name",
            "refs/instafy/salvage/gateway/.hidden",
            "refs/instafy/salvage/gateway/trailing.",
            "refs/instafy/salvage/gateway/a..b",
            "refs/instafy/salvage/gateway/name.lock",
            "refs/instafy/salvage/gateway/name.LOCK",
            "refs/instafy/salvage/gateway/sp ace",
            "refs/instafy/salvage/gateway/a~1",
            "refs/instafy/salvage/gateway/a^",
            "refs/instafy/salvage/gateway/a:b",
            "refs/instafy/salvage/gateway/a?",
            "refs/instafy/salvage/gateway/a*",
            "refs/instafy/salvage/gateway/a[",
            "refs/instafy/salvage/gateway/a\\b",
            "refs/instafy/salvage/gateway/a@{1}",
            "refs/instafy/salvage/gateway/caf\u{e9}",
            "refs/instafy/salvage/gateway/a\nb",
            " refs/instafy/salvage/gateway/name",
            &long,
            // Salvage names follow the shard's stricter rule.
            &long_salvage,
            "refs/instafy/salvage/gateway/-leading-dash",
            "refs/instafy/salvage/gateway/_leading-underscore",
            "refs/instafy/salvage/gateway/NODE-1-0123ABCD",
            "refs/instafy/salvage/gateway/node-1-0123ABCD",
        ] {
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
            "refs/instafy/salvage/gateway/node-1.local-0123abcd".to_string(),
            format!("refs/instafy/recovery/{ORIGIN}/-x"),
            format!("refs/instafy/recovery/{ORIGIN}/{}", "a".repeat(255)),
            format!("refs/instafy/salvage/gateway/{}", "a".repeat(100)),
        ] {
            assert_eq!(RecoveryRef::validate(&git, &name).unwrap().as_str(), name);
        }
        assert!(matches!(
            RecoveryRef::validate(&git, "refs/instafy/salvage/gateway/a..b"),
            Err(ViewError::InvalidRef)
        ));
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

        // Missing things, with no network call.
        assert_eq!(resolve_local(&git, &ReadAt::Main).unwrap(), None);
        assert!(matches!(
            resolve_local(&git, &ReadAt::Rev(sha1.to_string())),
            Err(ViewError::RevNotFound)
        ));
        assert!(matches!(
            resolve_local(&git, &ReadAt::Ref(RecoveryRef::parse(&reference).unwrap())),
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
            (ViewError::RefNotFound, 404, "not_found"),
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

    fn names(entries: &[ObjectEntry]) -> Vec<(&str, ObjectKind)> {
        entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.kind))
            .collect()
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
            resolve_local(&mirror_git, &ReadAt::Main)
                .unwrap()
                .as_deref(),
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
        let salvage_ref = "refs/instafy/salvage/gateway/node-1-0123abcd".to_string();
        let salvage = commit(
            &remote,
            &tree(&remote, &[("README.md", "base\n"), ("a.md", "a\n")]),
            &[&main],
            1_700_000_100,
            "Keep unsaved edits from the retired file gateway\n\n\
             Instafy-Recovery-Kind: salvage\n\
             Instafy-Path: a.md\n\
             Instafy-Path: b.md\n",
        );
        // A recovery commit that claims to be salvage is still a recovery ref.
        let posing_ref =
            format!("refs/instafy/recovery/{ORIGIN}/20261004T130000Z-unsaved-abcdef012345");
        let posing = commit(
            &remote,
            &base_tree,
            &[&main],
            1_700_000_300,
            "Pretend\n\nInstafy-Recovery-Kind: salvage\nInstafy-Path: z.md\n",
        );
        for (reference, rev) in [
            (conflict_ref.as_str(), conflict.as_str()),
            (salvage_ref.as_str(), salvage.as_str()),
            (posing_ref.as_str(), posing.as_str()),
            (
                // Another origin, so a case-insensitive disk keeps its own
                // folder for it.
                "refs/instafy/recovery/0B7C2F10-58A4-4E6B-9F0E-2D1C3B4A5F61/x",
                conflict.as_str(),
            ),
            ("refs/instafy/salvage/elsewhere/x", salvage.as_str()),
            ("refs/instafy/other/x", salvage.as_str()),
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
                (salvage_ref.as_str(), salvage.as_str()),
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
            fetch_refs(&git, url, &[&gone]).unwrap(),
            FetchedRefs {
                missing: vec![gone.clone()],
                ..FetchedRefs::default()
            }
        );

        let at = ReadAt::Ref(conflict_name.clone());
        assert!(matches!(
            resolve_local(&git, &at),
            Err(ViewError::RefNotFound)
        ));
        let refs: Vec<&RecoveryRef> = listed.iter().map(|(reference, _)| reference).collect();
        fetch_refs(&git, url, &refs).unwrap();
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        assert_eq!(
            resolve_local(&git, &at).unwrap().as_deref(),
            Some(conflict.as_str())
        );
        let TreeRead::Directory(entries) = read_tree_at(&git, &conflict, "").unwrap() else {
            panic!("the root is a folder");
        };
        assert_eq!(entries.len(), 2);

        let items = describe(&git, &listed, Some(&main)).unwrap();
        let summary: Vec<(&str, ItemKind, bool, Vec<&str>)> = items
            .iter()
            .map(|item| {
                (
                    item.reference.as_str(),
                    item.kind,
                    item.dismissible,
                    item.paths.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (posing_ref.as_str(), ItemKind::Unsaved, true, vec!["z.md"]),
                (
                    conflict_ref.as_str(),
                    ItemKind::Conflict,
                    true,
                    vec!["README.md"]
                ),
                (
                    salvage_ref.as_str(),
                    ItemKind::Salvage,
                    false,
                    vec!["a.md", "b.md"]
                ),
            ]
        );
        let conflict_item = &items[1];
        assert_eq!(
            conflict_item.subject,
            "Keep changes that conflicted with the saved version"
        );
        assert_eq!(conflict_item.base.as_deref(), Some(main.as_str()));
        assert_eq!(conflict_item.origin, Some(Uuid::parse_str(ORIGIN).unwrap()));
        assert_eq!(items[2].origin, None);
        let committed_at = git_in(&canonical, &["log", "-1", "--format=%cI", &conflict]);
        assert_eq!(conflict_item.date.as_deref(), Some(committed_at.as_str()));

        let json = serde_json::to_value(conflict_item).unwrap();
        assert_eq!(json["ref"], conflict_ref.as_str());
        assert_eq!(json["kind"], "conflict");
        assert_eq!(json["dismissible"], true);
        assert_eq!(json["base"], main.as_str());
        assert!(json.get("timestamp").is_none(), "{json}");

        // Without main there is no base.
        assert!(describe(&git, &listed, None)
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
    /// when git could parse it as an abbreviated id.
    #[test]
    fn a_missing_ref_is_never_read_as_another_commit() {
        let (_dir, root) = tempdir();
        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        let files = tree(&git, &[("a.txt", "a\n")]);
        let main = commit(&git, &files, &[], 1_700_000_000, "main\n");
        git.update_ref(MAIN_REF, &main, None, "test").unwrap();
        for name in [
            format!(
                "refs/instafy/salvage/gateway/nothing-here-1-g{}",
                &main[..7]
            ),
            format!("refs/instafy/recovery/{ORIGIN}/x-0-g{}", &main[..4]),
        ] {
            let at = ReadAt::from_query(&git, None, Some(&name)).unwrap();
            assert!(
                matches!(resolve_local(&git, &at), Err(ViewError::RefNotFound)),
                "{name}"
            );
        }
        let real = RecoveryRef::parse("refs/instafy/salvage/gateway/node-1-0123abcd").unwrap();
        git.update_ref(real.as_str(), &main, None, "test").unwrap();
        assert_eq!(
            resolve_local(&git, &ReadAt::Ref(real)).unwrap().as_deref(),
            Some(main.as_str())
        );
    }

    /// Refs whose names differ only in letter case would be one file on a
    /// case-insensitive disk (a Desktop checkout): they are left out of the
    /// listing, never fetched and never read as each other, and the rest of
    /// the list still works.
    #[test]
    fn refs_that_differ_only_in_case_are_never_fetched_or_read_as_each_other() {
        let (_dir, root) = tempdir();
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
        let base = format!("refs/instafy/recovery/{ORIGIN}");
        let upper = format!("{base}/20261002T120000Z-unsaved-x");
        let lower = format!("{base}/20261002t120000z-unsaved-x");
        let plain = format!("{base}/20261002T130000Z-stale-y");
        let only_upper = format!("{base}/20261002T140000Z-unsaved-z");
        let canonical = canonical_with_packed_refs(
            &root,
            &[
                (&upper, &two),
                (&lower, &one),
                (&plain, &one),
                (&only_upper, &two),
            ],
            &main,
        );
        let url = canonical.to_str().unwrap();

        let mirror = bare(&root, "mirror.git");
        let git = WorkspaceGit::bare(&mirror, None);
        // The mirror already holds the lower-case form of `only_upper`.
        fetch(&git, &canonical, "+refs/heads/main:refs/heads/main");
        let only_lower = only_upper.to_ascii_lowercase();
        let objects_of_one = format!("+{plain}:{only_lower}");
        fetch(&git, &canonical, &objects_of_one);

        let listed = list_remote_refs(&git, url).unwrap();
        let mut names: Vec<&str> = listed.iter().map(|(name, _)| name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec![plain.as_str(), only_upper.as_str()]);

        let refs: Vec<RecoveryRef> = [&upper, &lower, &plain, &only_upper]
            .iter()
            .map(|name| RecoveryRef::parse(name).unwrap())
            .collect();
        let outcome = fetch_refs(&git, url, &refs.iter().collect::<Vec<_>>()).unwrap();
        assert_eq!(
            outcome,
            FetchedRefs {
                fetched: vec![(refs[2].clone(), one.clone())],
                missing: Vec::new(),
                ambiguous: vec![refs[0].clone(), refs[1].clone(), refs[3].clone()],
            }
        );
        for reference in [&refs[0], &refs[1], &refs[3]] {
            assert!(
                matches!(
                    resolve_local(&git, &ReadAt::Ref(reference.clone())),
                    Err(ViewError::RefNotFound)
                ),
                "{}",
                reference.as_str()
            );
        }
        assert_eq!(
            resolve_local(&git, &ReadAt::Ref(refs[2].clone()))
                .unwrap()
                .as_deref(),
            Some(one.as_str())
        );
        assert_eq!(describe(&git, &listed, Some(&main)).unwrap().len(), 1);
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
        let outcome = {
            let _wrapper = crate::test_support::GitWrapper::install(
                &root,
                &format!(
                    "for arg in \"$@\"; do\n  if [ \"$arg\" = fetch ] && [ ! -e '{marker}' ]; then\n    \
                     : > '{marker}'\n    \
                     env -u GIT_DIR git --git-dir '{canonical}' update-ref -d '{gone}'\n  fi\ndone",
                    marker = marker.display(),
                    canonical = canonical.display(),
                    gone = gone.as_str(),
                ),
            );
            fetch_refs(&git, url, &[&gone, &kept]).unwrap()
        };
        assert!(marker.exists(), "the ref was not deleted mid-fetch");
        assert_eq!(
            outcome,
            FetchedRefs {
                fetched: vec![(kept.clone(), kept_rev.clone())],
                missing: vec![gone.clone()],
                ambiguous: Vec::new(),
            }
        );
        let items = describe(&git, &listed, Some(&main)).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.rev.as_str())
                .collect::<Vec<_>>(),
            vec![kept_rev.as_str()]
        );
        assert!(matches!(
            resolve_local(&git, &ReadAt::Ref(gone)),
            Err(ViewError::RefNotFound)
        ));

        // An unreachable remote is still an error.
        let nowhere = root.join("nowhere.git");
        assert!(fetch_refs(&git, nowhere.to_str().unwrap(), &[&kept]).is_err());
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
            describe(&git, &refs, Some(&main)).unwrap()
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
