//! Recovery refs: work a publish could not put on canonical `main`.
//!
//! A recovery commit Q is built without moving HEAD and stored first as a
//! local ref, `refs/instafy/local-recovery/<name>`, before any network call.
//! It is pushed to `refs/instafy/recovery/<origin id>/<name>` only by a holder
//! of `git.write`, where the origin id is the one in Q's own `Instafy-Origin`
//! trailer: a checkout outlives its runtime, and a later runtime (with a new
//! origin id) pushes and reads the refs an earlier one made under that
//! earlier id. Once the push is confirmed (the push reported success and the
//! remote ref names the same commit) the local ref moves to
//! `refs/instafy/local-recovery-pushed/<name>`. A pushed marker whose
//! canonical ref later disappears was dismissed (or restored) by a person:
//! it moves to `refs/instafy/local-recovery-dismissed/<name>` and is never
//! published again. A ref that was never pushed is always pushed and never
//! retired, except an `unpublished` one whose source commits reached `main`,
//! because then its content is already canonical.
//!
//! Nothing that may not be published (see [`crate::publish_policy`]) is ever
//! pushed: before a push, a recovery commit whose own change or whose
//! never-published ancestry adds or changes such a path is rebuilt on a
//! published parent without it, and the original stays only as a local
//! backup.
//!
//! Dismissed work is never pushed again either. A pending ref that builds on
//! commits of a dismissed `unpublished` ref (a copy parked before the
//! dismissal was seen, on a stop or offline) is replaced before its push by
//! a copy of what is left without them ([`replace_pending`]), or retired
//! when the branch already carries that rest: when a dismissal is applied,
//! later commits replayed without the dismissed ones are recorded under
//! `refs/instafy/local-replayed/<old commit>`.
//!
//! Names are `<UTC time>-<kind>-<hash>`, where the hash covers the kind and
//! the exact set of changed entries. The same work therefore always gets the
//! same name, a second store or push of it is a no-op, and different work
//! gets a different name.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::push::{push, PushClass};
use crate::workspace_git::{GitIdentity, RunOpts, WorkspaceGit};

pub const LOCAL_RECOVERY_ROOT: &str = "refs/instafy/local-recovery";
pub const LOCAL_RECOVERY_PUSHED_ROOT: &str = "refs/instafy/local-recovery-pushed";
pub const LOCAL_RECOVERY_DISMISSED_ROOT: &str = "refs/instafy/local-recovery-dismissed";
/// Recovery commits the repository policy refused, or that built on
/// dismissed work, kept only locally after a copy without the refused path
/// (or the dismissed work) replaced them.
pub const LOCAL_RECOVERY_REJECTED_ROOT: &str = "refs/instafy/local-recovery-rejected";
/// `<root>/<old commit>` names the commit a dismissal replayed it as.
pub const LOCAL_REPLAYED_ROOT: &str = "refs/instafy/local-replayed";

/// Trailer naming the local commit a recovery commit was made from.
pub const SOURCE_TRAILER: &str = "Instafy-Recovery-Source";
/// Trailer naming one path that conflicted with canonical `main`.
pub const CONFLICT_TRAILER: &str = "Instafy-Conflict";
/// Trailer naming one path parked by the recovery commit.
pub const PATH_TRAILER: &str = "Instafy-Path";
/// Trailer naming a path the repository policy refused, left out of this copy.
pub const LEFT_OUT_TRAILER: &str = "Instafy-Left-Out";
/// How many refused paths one recovery commit may drop before giving up.
const MAX_POLICY_RETRIES: usize = 8;
const KIND_TRAILER: &str = "Instafy-Recovery-Kind";
const ORIGIN_TRAILER: &str = "Instafy-Origin";
const MAX_LISTED_PATHS: usize = 200;
const MAX_LISTED_COMMITS: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryKind {
    /// The agent's full version of paths that conflicted with `main`; the
    /// rest of its work was published.
    Conflict,
    /// Local commits a publish could not push; retried by later publishes.
    Unpublished,
    /// Changes nobody saved before the workspace stopped.
    Unsaved,
    /// Copies an older sync left behind that differ from the saved files.
    Stale,
}

impl RecoveryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conflict => "conflict",
            Self::Unpublished => "unpublished",
            Self::Unsaved => "unsaved",
            Self::Stale => "stale",
        }
    }

    fn subject(self) -> &'static str {
        match self {
            Self::Conflict => "Keep changes that conflicted with the saved version",
            Self::Unpublished => "Keep changes that could not be saved",
            Self::Unsaved => "Keep unsaved changes from a stopped workspace",
            Self::Stale => "Keep old copies left by an earlier sync",
        }
    }
}

/// A local commit listed in a recovery commit's message.
#[derive(Clone, Debug)]
pub struct CommitSummary {
    pub short: String,
    pub subject: String,
    pub author: String,
}

/// What to store.
pub struct RecoverySpec {
    pub kind: RecoveryKind,
    pub tree: String,
    pub parent: Option<String>,
    pub source: Option<String>,
    /// `<epoch> <tz>` for the commit dates; `None` uses the current time.
    pub date: Option<String>,
    pub paths: Vec<String>,
    pub commits: Vec<CommitSummary>,
    pub identity: GitIdentity,
    pub origin_id: Uuid,
}

/// A stored recovery commit.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRefReport {
    pub name: String,
    pub kind: RecoveryKind,
    pub rev: String,
    /// `refs/instafy/recovery/<origin id>/<name>` once pushed, otherwise the
    /// local ref that holds it until the next publish or refresh.
    pub reference: String,
    pub pushed: bool,
    /// False when the same work was already stored under this name.
    pub created: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

pub fn canonical_ref(origin_id: Uuid, name: &str) -> String {
    format!(
        "{}/{}/{name}",
        git_service::policy::RECOVERY_REF_ROOT,
        origin_id.as_hyphenated()
    )
}

fn local_ref(name: &str) -> String {
    format!("{LOCAL_RECOVERY_ROOT}/{name}")
}

fn pushed_ref(name: &str) -> String {
    format!("{LOCAL_RECOVERY_PUSHED_ROOT}/{name}")
}

fn dismissed_ref(name: &str) -> String {
    format!("{LOCAL_RECOVERY_DISMISSED_ROOT}/{name}")
}

/// Store a recovery commit locally. Returns `None` when its tree equals its
/// parent's (nothing to keep).
pub(crate) fn store(
    git: &WorkspaceGit<'_>,
    spec: RecoverySpec,
) -> Result<Option<RecoveryRefReport>> {
    let changes = match spec.parent.as_deref() {
        Some(parent) => {
            if git.tree_id(parent)? == spec.tree {
                return Ok(None);
            }
            git.bytes(&[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--raw",
                parent,
                &spec.tree,
            ])?
        }
        None => {
            let empty = git.empty_tree()?;
            if empty == spec.tree {
                return Ok(None);
            }
            git.bytes(&[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--raw",
                &empty,
                &spec.tree,
            ])?
        }
    };
    let hash = change_hash(spec.kind, &changes);
    let suffix = format!("-{}-{hash}", spec.kind.as_str());

    // The same work is stored once, whatever state its earlier copy is in.
    if let Some(found) = stored_with_suffix(git, &suffix, None)? {
        return Ok(found.into_report(git, &spec));
    }

    let epoch = spec
        .date
        .as_deref()
        .and_then(|date| date.split(' ').next())
        .and_then(|seconds| seconds.parse::<i64>().ok())
        .unwrap_or_else(|| Utc::now().timestamp());
    let stamp = Utc
        .timestamp_opt(epoch, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y%m%dT%H%M%SZ");
    let name = format!("{stamp}{suffix}");

    let identity = spec.identity.clone().at(spec.date.clone());
    let message = message(&spec);
    let parents: Vec<&str> = spec.parent.iter().map(String::as_str).collect();
    let rev = git.commit_tree(
        &spec.tree,
        &parents,
        &identity,
        &identity,
        message.as_bytes(),
    )?;
    let reference = local_ref(&name);
    git.update_ref(&reference, &rev, None, "instafy: keep recovery work")
        .with_context(|| format!("failed to store {reference}"))?;
    Ok(Some(RecoveryRefReport {
        name,
        kind: spec.kind,
        rev,
        reference,
        pushed: false,
        created: true,
        paths: spec.paths,
    }))
}

/// An earlier copy of the same work (by name suffix).
struct Stored {
    root: &'static str,
    name: String,
    rev: String,
}

impl Stored {
    /// What a store of the same work reports: the earlier copy, or nothing
    /// when that copy was dismissed.
    fn into_report(self, git: &WorkspaceGit<'_>, spec: &RecoverySpec) -> Option<RecoveryRefReport> {
        match self.root {
            LOCAL_RECOVERY_DISMISSED_ROOT => None,
            root => {
                let pushed = root == LOCAL_RECOVERY_PUSHED_ROOT;
                Some(RecoveryRefReport {
                    reference: if pushed {
                        canonical_ref(origin_of(git, &self.rev, spec.origin_id), &self.name)
                    } else {
                        local_ref(&self.name)
                    },
                    name: self.name,
                    kind: spec.kind,
                    rev: self.rev,
                    pushed,
                    created: false,
                    paths: spec.paths.clone(),
                })
            }
        }
    }
}

/// The stored copy whose name ends with `suffix`, in any state, except the
/// pending ref `skip`.
fn stored_with_suffix(
    git: &WorkspaceGit<'_>,
    suffix: &str,
    skip: Option<&str>,
) -> Result<Option<Stored>> {
    for root in [
        LOCAL_RECOVERY_ROOT,
        LOCAL_RECOVERY_PUSHED_ROOT,
        LOCAL_RECOVERY_DISMISSED_ROOT,
    ] {
        for (reference, rev) in git.refs_under(root)? {
            let name = reference
                .strip_prefix(&format!("{root}/"))
                .unwrap_or_default()
                .to_string();
            if root == LOCAL_RECOVERY_ROOT && skip == Some(name.as_str()) {
                continue;
            }
            if name.ends_with(suffix) {
                return Ok(Some(Stored { root, name, rev }));
            }
        }
    }
    Ok(None)
}

/// Replace the pending ref `name` (at `rev`), which builds on dismissed
/// work, by a commit of what is left without it (`spec`). The old commit
/// moves to the rejected backups in the same transaction, so the work is
/// pending under one name or the other at every moment. When nothing is
/// left, or the same rest is already stored (or was dismissed), only the
/// old commit moves. Returns the copy that now holds the rest, if any.
pub(crate) fn replace_pending(
    git: &WorkspaceGit<'_>,
    name: &str,
    rev: &str,
    spec: RecoverySpec,
) -> Result<Option<RecoveryRefReport>> {
    let parent_tree = match spec.parent.as_deref() {
        Some(parent) => git.tree_id(parent)?,
        None => git.empty_tree()?,
    };
    if parent_tree == spec.tree {
        retire_pending(git, name, rev)?;
        return Ok(None);
    }
    let changes = git.bytes(&[
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--raw",
        &parent_tree,
        &spec.tree,
    ])?;
    let suffix = format!(
        "-{}-{}",
        spec.kind.as_str(),
        change_hash(spec.kind, &changes)
    );
    if let Some(found) = stored_with_suffix(git, &suffix, Some(name))? {
        retire_pending(git, name, rev)?;
        return Ok(found.into_report(git, &spec));
    }
    let identity = spec.identity.clone().at(None);
    let parents: Vec<&str> = spec.parent.iter().map(String::as_str).collect();
    let next = git.commit_tree(
        &spec.tree,
        &parents,
        &identity,
        &identity,
        message(&spec).as_bytes(),
    )?;
    let stamp = name.split('-').next().unwrap_or_default();
    let next_name = format!("{stamp}{suffix}");
    let backup = format!("{LOCAL_RECOVERY_REJECTED_ROOT}/{name}");
    let transaction = if next_name == name {
        format!(
            "update {backup} {rev}\nupdate {} {next} {rev}\n",
            local_ref(name)
        )
    } else {
        format!(
            "update {backup} {rev}\ndelete {} {rev}\nupdate {} {next}\n",
            local_ref(name),
            local_ref(&next_name)
        )
    };
    git.ok_opts(
        &[
            "update-ref",
            "--stdin",
            "-m",
            "instafy: recovery work without dismissed work",
        ],
        &RunOpts {
            stdin: Some(transaction.as_bytes()),
            ..RunOpts::default()
        },
    )?;
    Ok(Some(RecoveryRefReport {
        reference: local_ref(&next_name),
        name: next_name,
        kind: spec.kind,
        rev: next,
        pushed: false,
        created: true,
        paths: spec.paths,
    }))
}

/// Record that a dismissal replayed `old` as `new`.
pub(crate) fn record_replayed(git: &WorkspaceGit<'_>, pairs: &[(String, String)]) -> Result<()> {
    if pairs.is_empty() {
        return Ok(());
    }
    let mut transaction = String::new();
    for (old, new) in pairs {
        transaction.push_str(&format!("update {LOCAL_REPLAYED_ROOT}/{old} {new}\n"));
    }
    git.ok_opts(
        &[
            "update-ref",
            "--stdin",
            "-m",
            "instafy: commits replayed without dismissed work",
        ],
        &RunOpts {
            stdin: Some(transaction.as_bytes()),
            ..RunOpts::default()
        },
    )
}

/// The commit a dismissal replayed `commit` as (following later replays),
/// if it was.
pub(crate) fn replayed(git: &WorkspaceGit<'_>, commit: &str) -> Result<Option<String>> {
    let mut current = commit.to_string();
    let mut found = None;
    for _ in 0..16 {
        match git.commit_id(&format!("{LOCAL_REPLAYED_ROOT}/{current}"))? {
            Some(next) if next != current => {
                found = Some(next.clone());
                current = next;
            }
            _ => break,
        }
    }
    Ok(found)
}

/// The commits dismissed `unpublished` work put on the branch, as
/// `(source, base)` (its tip and the published commit below it): from the
/// markers already retired as dismissed and from pushed markers whose
/// canonical ref the last fetch found gone.
pub(crate) fn dismissed_ranges(
    git: &WorkspaceGit<'_>,
    origin_id: Uuid,
) -> Result<Vec<(String, String)>> {
    let mut markers: Vec<(String, String)> = git
        .refs_under(LOCAL_RECOVERY_DISMISSED_ROOT)?
        .into_iter()
        .filter_map(|(reference, rev)| {
            let name = reference.strip_prefix(&format!("{LOCAL_RECOVERY_DISMISSED_ROOT}/"))?;
            Some((name.to_string(), rev))
        })
        .collect();
    markers.extend(dismissed_markers(git, origin_id)?);
    let mut ranges = Vec::new();
    for (name, rev) in markers {
        if kind_of_name(&name) != Some(RecoveryKind::Unpublished) {
            continue;
        }
        let (Some(source), Some(base)) =
            (source_of(git, &rev)?, git.commit_id(&format!("{rev}^"))?)
        else {
            continue;
        };
        if git.commit_id(&source)?.is_some() && !ranges.contains(&(source.clone(), base.clone())) {
            ranges.push((source, base));
        }
    }
    Ok(ranges)
}

fn message(spec: &RecoverySpec) -> String {
    let mut body = String::new();
    body.push_str(spec.kind.subject());
    body.push_str("\n\n");
    match spec.kind {
        RecoveryKind::Conflict => body.push_str(
            "These files were changed both here and in the saved version. The saved\n\
             version kept its copy; this commit holds the other one.\n",
        ),
        RecoveryKind::Unpublished => body.push_str(
            "A save could not reach the shared history. This commit holds the work\n\
             until a later save publishes it.\n",
        ),
        RecoveryKind::Unsaved => {
            body.push_str("The workspace stopped before these changes were saved.\n")
        }
        RecoveryKind::Stale => body.push_str(
            "An older version of the sync left these copies behind. They differ from\n\
             the saved files, so they were set aside instead of being saved.\n",
        ),
    }
    if !spec.commits.is_empty() {
        body.push_str("\nLocal commits:\n");
        for commit in spec.commits.iter().take(MAX_LISTED_COMMITS) {
            body.push_str(&format!(
                "- {} {} ({})\n",
                commit.short,
                one_line(&commit.subject),
                one_line(&commit.author)
            ));
        }
        if spec.commits.len() > MAX_LISTED_COMMITS {
            body.push_str(&format!(
                "- and {} more\n",
                spec.commits.len() - MAX_LISTED_COMMITS
            ));
        }
    }
    body.push('\n');
    body.push_str(&format!("{KIND_TRAILER}: {}\n", spec.kind.as_str()));
    body.push_str(&format!(
        "{ORIGIN_TRAILER}: {}\n",
        spec.origin_id.as_hyphenated()
    ));
    if let Some(source) = spec.source.as_deref() {
        body.push_str(&format!("{SOURCE_TRAILER}: {source}\n"));
    }
    let trailer = if spec.kind == RecoveryKind::Conflict {
        CONFLICT_TRAILER
    } else {
        PATH_TRAILER
    };
    for path in spec.paths.iter().take(MAX_LISTED_PATHS) {
        body.push_str(&format!("{trailer}: {}\n", one_line(path)));
    }
    body
}

fn one_line(value: &str) -> String {
    value.replace(['\n', '\r'], " ")
}

/// Every local recovery ref not yet confirmed on canonical, as `(name, rev)`.
pub(crate) fn pending(git: &WorkspaceGit<'_>) -> Result<Vec<(String, String)>> {
    Ok(git
        .refs_under(LOCAL_RECOVERY_ROOT)?
        .into_iter()
        .filter_map(|(reference, rev)| {
            let name = reference.strip_prefix(&format!("{LOCAL_RECOVERY_ROOT}/"))?;
            Some((name.to_string(), rev))
        })
        .collect())
}

/// Result of pushing the pending refs.
#[derive(Debug, Default)]
pub(crate) struct PushPending {
    /// `(name, canonical ref)` of every ref this call pushed.
    pub pushed: Vec<(String, String)>,
    pub failed: Vec<(String, String)>,
    pub remaining: usize,
}

/// Push every pending local recovery ref, and move each one confirmed on
/// the remote to the pushed markers. Needs a `git.write` token.
///
/// `main` is the fetched canonical `main`; `published` names every commit
/// known to be on canonical (`main`, and the published frontier of an
/// unrelated history). Whatever a push would send beyond them is checked
/// first.
///
/// When the repository policy refuses a path in a recovery commit, that path
/// is left out (a new commit and name; the refused one moves to
/// `refs/instafy/local-recovery-rejected/`) and the push is retried, so one
/// refused file never keeps the rest of the work local forever. A ref that
/// cannot be pushed is reported in `failed` and the others are still pushed.
/// Pushing stops at `deadline`; whatever is left waits for the next call.
pub(crate) fn push_pending(
    git: &WorkspaceGit<'_>,
    remote: &str,
    origin_id: Uuid,
    main: Option<&str>,
    published: &[String],
    deadline: Option<Instant>,
) -> Result<PushPending> {
    let mut report = PushPending::default();
    for (name, rev) in pending(git)? {
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            report
                .failed
                .push((name, "no time left to push it in this call".to_string()));
            continue;
        }
        match push_one(git, remote, origin_id, main, published, &name, &rev) {
            Ok(Ok(pushed)) => report.pushed.push(pushed),
            Ok(Err(detail)) => report.failed.push((name, detail)),
            Err(error) => report.failed.push((name, format!("{error:#}"))),
        }
    }
    report.remaining = pending(git)?.len();
    Ok(report)
}

/// Push one pending ref. The outer error is a local git failure, the inner
/// one a push that did not land.
fn push_one(
    git: &WorkspaceGit<'_>,
    remote: &str,
    origin_id: Uuid,
    main: Option<&str>,
    published: &[String],
    name: &str,
    rev: &str,
) -> Result<Result<(String, String), String>> {
    let (mut name, mut rev) = (name.to_string(), rev.to_string());
    match without_unpublishable(git, &name, &rev, main, published)? {
        Rebuilt::Unchanged => {}
        Rebuilt::Replaced(next_name, next_rev) => {
            name = next_name;
            rev = next_rev;
        }
        Rebuilt::Dropped(reason) => return Ok(Err(reason)),
    }
    let origin = origin_of(git, &rev, origin_id);
    let mut outcome = Err("not pushed".to_string());
    for _ in 0..MAX_POLICY_RETRIES {
        let destination = canonical_ref(origin, &name);
        let result = push(git, remote, &[format!("{rev}:{destination}")], &[])?;
        let reported_ok = matches!(result.class, PushClass::Pushed)
            || result
                .refs
                .iter()
                .any(|pushed| pushed.to == destination && pushed.ok());
        match result.class {
            PushClass::PathRejected { path, .. } if !reported_ok => {
                match without_path(git, &name, &rev, &path, main)? {
                    Rebuilt::Replaced(next_name, next_rev) => {
                        name = next_name;
                        rev = next_rev;
                        continue;
                    }
                    Rebuilt::Dropped(reason) => {
                        outcome = Err(reason);
                        break;
                    }
                    Rebuilt::Unchanged => {
                        outcome = Err(format!("the repository policy refused {path}"));
                        break;
                    }
                }
            }
            class => {
                // Confirm on the remote rather than trusting the push's
                // own report.
                let confirmed = reported_ok
                    && ls_remote(git, remote, std::slice::from_ref(&destination))
                        .ok()
                        .and_then(|found| found.get(&destination).cloned())
                        .as_deref()
                        == Some(rev.as_str());
                outcome = if confirmed {
                    Ok(())
                } else {
                    Err(match class {
                        PushClass::Pushed => {
                            "the remote does not show the pushed commit".to_string()
                        }
                        PushClass::LostRace(text)
                        | PushClass::Rejected(text)
                        | PushClass::Ambiguous(text) => text,
                        PushClass::PathRejected { path, .. } => {
                            format!("policy refused {path}")
                        }
                    })
                };
                break;
            }
        }
    }
    if let Err(detail) = outcome {
        return Ok(Err(detail));
    }
    let destination = canonical_ref(origin, &name);
    let mut transaction = String::new();
    transaction.push_str(&format!("update {} {rev}\n", pushed_ref(&name)));
    transaction.push_str(&format!("delete {} {rev}\n", local_ref(&name)));
    // Mirror the canonical ref so the agent can read it right away; the next
    // refresh replaces it with a fetched copy.
    transaction.push_str(&format!("update {destination} {rev}\n"));
    git.ok_opts(
        &[
            "update-ref",
            "--stdin",
            "-m",
            "instafy: recovery work pushed",
        ],
        &RunOpts {
            stdin: Some(transaction.as_bytes()),
            ..RunOpts::default()
        },
    )?;
    Ok(Ok((name, destination)))
}

/// What became of a pending recovery commit that had to change.
enum Rebuilt {
    /// Nothing needed to change.
    Unchanged,
    /// A new pending commit `(name, rev)` replaced it.
    Replaced(String, String),
    /// Nothing that may be pushed was left; it stays only as a backup.
    Dropped(String),
}

struct RecoveryCommit {
    tree: String,
    parent: Option<String>,
    committer: GitIdentity,
    message: String,
}

fn read_recovery_commit(git: &WorkspaceGit<'_>, rev: &str) -> Result<RecoveryCommit> {
    let object = git
        .read_objects(&[rev.to_string()])?
        .pop()
        .context("recovery commit missing")?;
    let split = object
        .data
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| index + 2)
        .unwrap_or(object.data.len());
    let headers = String::from_utf8_lossy(&object.data[..split]).to_string();
    let mut message = String::from_utf8_lossy(&object.data[split..]).to_string();
    if !message.ends_with('\n') {
        message.push('\n');
    }
    let mut tree = None;
    let mut parent = None;
    let mut committer = None;
    for line in headers.lines() {
        if let Some(value) = line.strip_prefix("tree ") {
            tree = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("parent ") {
            parent.get_or_insert_with(|| value.to_string());
        } else if let Some(value) = line.strip_prefix("committer ") {
            committer = parse_identity(value);
        }
    }
    Ok(RecoveryCommit {
        tree: tree.context("recovery commit has no tree")?,
        parent,
        committer: committer.context("recovery commit has no committer")?,
        message,
    })
}

/// Replace the pending commit `name` (at `rev`) by a commit of `tree` on
/// `parent` with `left_out` named in its message. The old commit moves to
/// the rejected backups, which are never pushed.
fn replace_refused(
    git: &WorkspaceGit<'_>,
    name: &str,
    rev: &str,
    commit: &RecoveryCommit,
    tree: &str,
    parent: Option<&str>,
    left_out: &[String],
) -> Result<Rebuilt> {
    let backup = format!("{LOCAL_RECOVERY_REJECTED_ROOT}/{name}");
    let parent_tree = match parent {
        Some(parent) => git.tree_id(parent)?,
        None => git.empty_tree()?,
    };
    if tree == parent_tree {
        retire_pending(git, name, rev)?;
        return Ok(Rebuilt::Dropped(format!(
            "only refused paths were left in {name}"
        )));
    }
    let mut message = commit.message.clone();
    for path in left_out.iter().take(MAX_LISTED_PATHS) {
        message.push_str(&format!("{LEFT_OUT_TRAILER}: {}\n", one_line(path)));
    }
    let parents: Vec<&str> = parent.into_iter().collect();
    let next = git.commit_tree(
        tree,
        &parents,
        &commit.committer,
        &commit.committer,
        message.as_bytes(),
    )?;
    let changes = git.bytes(&[
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--raw",
        &parent_tree,
        tree,
    ])?;
    let kind = kind_of_name(name).unwrap_or(RecoveryKind::Unsaved);
    let stamp = name.split('-').next().unwrap_or_default();
    let next_name = format!("{stamp}-{}-{}", kind.as_str(), change_hash(kind, &changes));
    // The same change on another parent keeps its name (names follow the
    // change, not the parent): then the ref moves in place, since one
    // transaction may name a ref only once.
    let transaction = if next_name == name {
        format!(
            "update {backup} {rev}\nupdate {} {next} {rev}\n",
            local_ref(name)
        )
    } else {
        format!(
            "update {backup} {rev}\ndelete {} {rev}\nupdate {} {next}\n",
            local_ref(name),
            local_ref(&next_name)
        )
    };
    git.ok_opts(
        &[
            "update-ref",
            "--stdin",
            "-m",
            "instafy: recovery work refused",
        ],
        &RunOpts {
            stdin: Some(transaction.as_bytes()),
            ..RunOpts::default()
        },
    )?;
    Ok(Rebuilt::Replaced(next_name, next))
}

/// Move a pending recovery commit to the rejected backups (never pushed).
pub(crate) fn retire_pending(git: &WorkspaceGit<'_>, name: &str, rev: &str) -> Result<()> {
    let backup = format!("{LOCAL_RECOVERY_REJECTED_ROOT}/{name}");
    git.ok_opts(
        &[
            "update-ref",
            "--stdin",
            "-m",
            "instafy: recovery work refused",
        ],
        &RunOpts {
            stdin: Some(
                format!("update {backup} {rev}\ndelete {} {rev}\n", local_ref(name)).as_bytes(),
            ),
            ..RunOpts::default()
        },
    )
}

/// Replace a pending recovery commit by one without `path`, which the
/// repository policy refused. The hook compares a new recovery ref with
/// `main`, so a path the commit itself did not change can be refused too
/// (main changed it since the commit's parent): then the copy takes `main`'s
/// entry and agrees with `main` there. When neither changes anything the
/// commit can never pass the policy as it is, and it moves to the rejected
/// backups ([`Rebuilt::Dropped`]).
fn without_path(
    git: &WorkspaceGit<'_>,
    name: &str,
    rev: &str,
    path: &str,
    main: Option<&str>,
) -> Result<Rebuilt> {
    let commit = read_recovery_commit(git, rev)?;
    let paths = [path.to_string()];
    let mut new_tree = crate::tree_merge::tree_with_entries_from(
        git,
        &commit.tree,
        commit.parent.as_deref(),
        &paths,
    )?;
    if new_tree == commit.tree {
        if let Some(main) = main {
            new_tree =
                crate::tree_merge::tree_with_entries_from(git, &commit.tree, Some(main), &paths)?;
        }
    }
    if new_tree == commit.tree {
        retire_pending(git, name, rev)?;
        return Ok(Rebuilt::Dropped(format!(
            "the repository policy refused {path}, which {name} cannot leave out"
        )));
    }
    replace_refused(
        git,
        name,
        rev,
        &commit,
        &new_tree,
        commit.parent.as_deref(),
        &paths,
    )
}

/// Make sure a pending recovery commit sends nothing that may not be
/// published: neither its own change nor any never-published commit below
/// it may add or change such a path. When one does, the commit is rebuilt
/// on a published parent (its own, or the merge base with `main`) with
/// those paths keeping the parent's version.
fn without_unpublishable(
    git: &WorkspaceGit<'_>,
    name: &str,
    rev: &str,
    main: Option<&str>,
    published: &[String],
) -> Result<Rebuilt> {
    let mut args: Vec<String> = vec!["rev-list".to_string(), rev.to_string()];
    args.extend(published.iter().map(|tip| format!("^{tip}")));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let listing = git.stdout(&arg_refs)?;
    let commits: Vec<&str> = listing.lines().filter(|line| !line.is_empty()).collect();
    if commits.is_empty() {
        return Ok(Rebuilt::Unchanged);
    }
    let mut input = String::new();
    for commit in &commits {
        input.push_str(commit);
        input.push('\n');
    }
    let raw = git.bytes_opts(
        &[
            "diff-tree",
            "--stdin",
            "-r",
            "-z",
            "--no-renames",
            "--raw",
            "-m",
            "--root",
        ],
        &RunOpts {
            stdin: Some(input.as_bytes()),
            ..RunOpts::default()
        },
    )?;
    let offending: BTreeSet<String> = crate::publish::parse_stdin_diff_tree(&raw)
        .into_values()
        .flatten()
        .filter(|change| change.status != 'D')
        .map(|change| change.path)
        .filter(|path| crate::publish_policy::is_unpublishable(path))
        .collect();
    if offending.is_empty() {
        return Ok(Rebuilt::Unchanged);
    }
    let offending: Vec<String> = offending.into_iter().collect();
    let commit = read_recovery_commit(git, rev)?;
    let parent_published = match commit.parent.as_deref() {
        Some(parent) => {
            let mut on_canonical = false;
            for tip in published {
                if git.is_ancestor(parent, tip)? {
                    on_canonical = true;
                    break;
                }
            }
            on_canonical
        }
        None => main.is_none(),
    };
    let (parent, tree) = if parent_published {
        let tree = crate::tree_merge::tree_with_entries_from(
            git,
            &commit.tree,
            commit.parent.as_deref(),
            &offending,
        )?;
        (commit.parent.clone(), tree)
    } else {
        match main {
            Some(main) => match git.merge_base(rev, main)? {
                Some(base) => {
                    let tree = crate::tree_merge::tree_with_entries_from(
                        git,
                        &commit.tree,
                        Some(&base),
                        &offending,
                    )?;
                    (Some(base), tree)
                }
                None => {
                    let tree = crate::tree_merge::overlay(git, main, &commit.tree, &offending)?;
                    (Some(main.to_string()), tree)
                }
            },
            None => {
                let tree =
                    crate::tree_merge::tree_with_entries_from(git, &commit.tree, None, &offending)?;
                (None, tree)
            }
        }
    };
    tracing::warn!(
        %name,
        paths = offending.len(),
        "left files that may not be published out of recovery work"
    );
    replace_refused(
        git,
        name,
        rev,
        &commit,
        &tree,
        parent.as_deref(),
        &offending,
    )
}

fn parse_identity(value: &str) -> Option<GitIdentity> {
    let open = value.rfind('<')?;
    let close = value.rfind('>')?;
    if close < open {
        return None;
    }
    let date = value[close + 1..].trim();
    Some(
        GitIdentity::new(value[..open].trim_end(), &value[open + 1..close])
            .at((!date.is_empty()).then(|| date.to_string())),
    )
}

fn change_hash(kind: RecoveryKind, changes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"instafy-recovery-v1\0");
    hasher.update(kind.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(changes);
    hasher
        .finalize()
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `ref -> id` for each of `references` that exists on the remote.
pub(crate) fn ls_remote(
    git: &WorkspaceGit<'_>,
    remote: &str,
    references: &[String],
) -> Result<BTreeMap<String, String>> {
    let mut found = BTreeMap::new();
    for chunk in references.chunks(128) {
        let mut args: Vec<&str> = vec!["ls-remote", remote];
        args.extend(chunk.iter().map(String::as_str));
        let raw = git.stdout(&args)?;
        for line in raw.lines() {
            if let Some((rev, name)) = line.split_once('\t') {
                if chunk.iter().any(|reference| reference == name) {
                    found.insert(name.to_string(), rev.trim().to_string());
                }
            }
        }
    }
    Ok(found)
}

/// After a fetch that mirrored `refs/instafy/recovery/*` with `--prune`, the
/// pushed markers whose canonical ref is gone: someone dismissed that work.
/// A marker's canonical ref is under the origin that made it (its trailer),
/// not under the origin running now. Returns the `(name, rev)` pairs and
/// moves nothing: the caller retires each marker with [`retire_markers`]
/// only once it has acted on the dismissal, so a dismissal it could not
/// apply is seen again by the next call.
pub(crate) fn dismissed_markers(
    git: &WorkspaceGit<'_>,
    origin_id: Uuid,
) -> Result<Vec<(String, String)>> {
    let mirrored: BTreeMap<String, String> = git
        .refs_under(git_service::policy::RECOVERY_REF_ROOT)?
        .into_iter()
        .collect();
    let mut dismissed = Vec::new();
    for (reference, rev) in git.refs_under(LOCAL_RECOVERY_PUSHED_ROOT)? {
        let Some(name) = reference.strip_prefix(&format!("{LOCAL_RECOVERY_PUSHED_ROOT}/")) else {
            continue;
        };
        if mirrored.contains_key(&canonical_ref(origin_of(git, &rev, origin_id), name)) {
            continue;
        }
        dismissed.push((name.to_string(), rev));
    }
    Ok(dismissed)
}

/// Move pushed markers to `local-recovery-dismissed`, in one transaction
/// that fails (and moves none of them) when a marker changed meanwhile.
pub(crate) fn retire_markers(git: &WorkspaceGit<'_>, markers: &[(String, String)]) -> Result<()> {
    if markers.is_empty() {
        return Ok(());
    }
    let mut transaction = String::new();
    for (name, rev) in markers {
        transaction.push_str(&format!("update {} {rev}\n", dismissed_ref(name)));
        transaction.push_str(&format!("delete {} {rev}\n", pushed_ref(name)));
    }
    git.ok_opts(
        &[
            "update-ref",
            "--stdin",
            "-m",
            "instafy: recovery work dismissed",
        ],
        &RunOpts {
            stdin: Some(transaction.as_bytes()),
            ..RunOpts::default()
        },
    )
}

/// The value of the last `<key>: <value>` line of a commit's message.
fn trailer(git: &WorkspaceGit<'_>, rev: &str, key: &str) -> Result<Option<String>> {
    let objects = git.read_objects(&[rev.to_string()])?;
    let Some(object) = objects.first() else {
        return Ok(None);
    };
    if object.kind != "commit" {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&object.data).to_string();
    let prefix = format!("{key}: ");
    Ok(text
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(|value| value.trim().to_string()))
}

/// The `Instafy-Recovery-Source` of a recovery commit, if any.
pub(crate) fn source_of(git: &WorkspaceGit<'_>, rev: &str) -> Result<Option<String>> {
    trailer(git, rev, SOURCE_TRAILER)
}

/// The origin that made a recovery commit (its `Instafy-Origin` trailer),
/// whose id names the commit's canonical ref; `fallback` when it has none.
pub(crate) fn origin_of(git: &WorkspaceGit<'_>, rev: &str, fallback: Uuid) -> Uuid {
    trailer(git, rev, ORIGIN_TRAILER)
        .ok()
        .flatten()
        .and_then(|value| Uuid::parse_str(&value).ok())
        .unwrap_or(fallback)
}

pub(crate) fn kind_of_name(name: &str) -> Option<RecoveryKind> {
    [
        RecoveryKind::Conflict,
        RecoveryKind::Unpublished,
        RecoveryKind::Unsaved,
        RecoveryKind::Stale,
    ]
    .into_iter()
    .find(|kind| name.contains(&format!("-{}-", kind.as_str())))
}

/// Delete this checkout's `unpublished` refs whose source commits are now on
/// `main` (or were replayed without dismissed work onto commits that are):
/// their content is canonical. `also_published` names local commits
/// whose sanitised rewrite (the same work without unpublishable paths) is on
/// `main`. Conflict, unsaved and stale refs are never touched. A pushed copy
/// is deleted on the remote first (with a lease on the exact commit) and its
/// marker only after that succeeds.
pub(crate) fn retire_superseded(
    git: &WorkspaceGit<'_>,
    remote: &str,
    origin_id: Uuid,
    main: &str,
    can_push: bool,
    also_published: &[String],
) -> Result<Vec<String>> {
    let mut retired = Vec::new();
    for (root, pushed) in [
        (LOCAL_RECOVERY_ROOT, false),
        (LOCAL_RECOVERY_PUSHED_ROOT, true),
    ] {
        for (reference, rev) in git.refs_under(root)? {
            let Some(name) = reference.strip_prefix(&format!("{root}/")) else {
                continue;
            };
            if kind_of_name(name) != Some(RecoveryKind::Unpublished) {
                continue;
            }
            let Some(source) = source_of(git, &rev)? else {
                continue;
            };
            // On `main` itself, as its sanitised rewrite, or as the commit a
            // dismissal replayed it as.
            let superseded = also_published.contains(&source)
                || (git.commit_id(&source)?.is_some() && git.is_ancestor(&source, main)?)
                || match replayed(git, &source)? {
                    Some(replay) => git.is_ancestor(&replay, main)?,
                    None => false,
                };
            if !superseded {
                continue;
            }
            if pushed {
                if !can_push {
                    continue;
                }
                let destination = canonical_ref(origin_of(git, &rev, origin_id), name);
                let lease = format!("--force-with-lease={destination}:{rev}");
                let delete = format!(":{destination}");
                let output = git.run(&[
                    "push",
                    "--porcelain",
                    "--no-verify",
                    &lease,
                    remote,
                    &delete,
                ])?;
                if !output.status.success() {
                    continue;
                }
                let _ = git.delete_ref(&destination, &rev);
            }
            git.delete_ref(&reference, &rev)?;
            retired.push(name.to_string());
        }
    }
    Ok(retired)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_round_trip_through_names() {
        for kind in [
            RecoveryKind::Conflict,
            RecoveryKind::Unpublished,
            RecoveryKind::Unsaved,
            RecoveryKind::Stale,
        ] {
            let name = format!("20261002T120000Z-{}-0123456789ab", kind.as_str());
            assert_eq!(kind_of_name(&name), Some(kind));
        }
    }

    #[test]
    fn canonical_refs_match_the_shard_rule() {
        let origin = Uuid::parse_str("0B7C2F10-58A4-4E6B-9F0E-2D1C3B4A5F60").unwrap();
        let reference = canonical_ref(origin, "20261002T120000Z-conflict-0123456789ab");
        assert_eq!(
            reference,
            "refs/instafy/recovery/0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60/20261002T120000Z-conflict-0123456789ab"
        );
    }
}
