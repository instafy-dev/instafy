//! Publish a single-tenant workspace (a hosted runtime checkout or a Desktop
//! folder) onto canonical `main`.
//!
//! Canonical `refs/heads/main` is the truth. A publish never forces, rebases
//! or resets it: the checkout's commits L reach `main` by a plain push, as a
//! fast-forward when `main` has not moved, or as one merge commit on top of
//! the fetched tip R when it has. Every local commit keeps its id, author and
//! message. Paths both sides changed keep `main`'s version, and the local
//! version goes to a `conflict` recovery ref. Work that cannot be published at
//! all goes to an `unpublished` recovery ref. Nothing is silently dropped, and
//! nothing dirty reaches `main` unless a caller selected it.
//!
//! Paths that may never be published (see [`crate::publish_policy`]) are not
//! removed from history: commits that were never pushed are rewritten
//! locally so the path keeps its previous version, which `main` therefore
//! keeps too ("kept the saved version").

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tracing::{info, warn};

use crate::apply::normalize_relative_path;
use crate::config::ServerConfig;
use crate::error::OriginError;
use crate::git::{looks_like_transient_http_error, EmbeddedGitDirGuard};
use crate::publish_policy::{
    deletion_allowed, is_unsafe_path, unpublishable_reason, RejectReason, MAX_PUBLISH_BLOB_BYTES,
};
use crate::push::{delete_with_lease, push, PushClass};
use crate::recovery::{self, CommitSummary, RecoveryKind, RecoveryRefReport, RecoverySpec};
use crate::recovery_view::{
    parse_rev, recovery_ref_moved, resolve_ref, restore_commit_message, restore_commits,
    without_restored_from, RecoveryRef, ViewError, RESTORED_FROM_TRAILER,
};
use crate::stale_align;
use crate::tree_merge::{changed_paths, overlay, three_way, tree_with_entries_from};
use crate::workspace_fs::WorkspaceDir;
use crate::workspace_git::{nul_list, temp_index_dir, GitIdentity, RunOpts, WorkspaceGit};

/// Local ref marking the last commit whose history was replayed onto an
/// unrelated `main`, so a later publish never replays it again.
pub const PUBLISHED_FRONTIER_REF: &str = "refs/instafy/published-frontier";
/// At most this many first-parent commits are replayed onto an unrelated
/// `main`; a longer history is parked instead.
const MAX_REPLAYED_COMMITS: usize = 50;
/// Pushes to `main` that may lose a race before the work is parked.
const MAX_ATTEMPTS: usize = 4;
/// Paths the repository's own push policy may refuse in one publish. The
/// policy names one path per refusal, and each is left out before the next
/// try; these tries never count as lost races.
const MAX_POLICY_REFUSALS: usize = 64;
/// How long a stop's fetch or push may move no data before it gives up.
/// Everything a stop parks is stored locally first, so giving up early only
/// leaves the work for the next publish or refresh to push.
const FLUSH_STALL_SECONDS: u32 = 8;
/// The time a stop may spend keeping its work, below the controller's wait.
const FLUSH_BUDGET: Duration = Duration::from_secs(18);
const MAX_TRAILER_PATHS: usize = 200;
/// At most this many rejected paths are listed in one report.
const MAX_REPORTED_PATHS: usize = 1000;
/// Default time a publish may spend retrying lost races.
pub const DEFAULT_PUBLISH_BUDGET: Duration = Duration::from_secs(60);

/// What to commit before publishing.
#[derive(Clone, Debug)]
pub enum Selection {
    /// These paths (files or directories) and nothing else.
    Paths(Vec<String>),
    /// Every changed, untracked or deleted path that is not ignored.
    AllDirty,
    /// Nothing: publish commits already on the local branch.
    None,
}

/// Where and with what credential to publish.
pub struct PublishContext<'a> {
    pub config: &'a ServerConfig,
    pub workspace_root: &'a Path,
    /// Bearer for the canonical remote.
    pub token: Option<&'a str>,
    /// The token carries `git.write`. Without it nothing is pushed.
    pub can_write: bool,
}

pub struct PublishRequest {
    pub selection: Selection,
    pub message: String,
    /// Author of the commit made from the selection; the origin's own
    /// identity when `None`.
    pub author: Option<GitIdentity>,
    pub budget: Duration,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    /// Everything selected and every local commit is on `main`.
    Published,
    /// Some of it is on `main`; the rest is on a recovery ref or was
    /// left out (see `conflictedPaths` and `rejectedPaths`).
    Partial,
    /// There was nothing to publish.
    #[default]
    Unchanged,
    /// Nothing reached `main`; the work is kept locally or on a recovery ref.
    Unpublished,
}

/// A path left out of a publish.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedPath {
    pub path: String,
    pub reason: RejectReason,
    /// The saved version kept its own copy of this path.
    pub kept_saved_version: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishReport {
    /// Canonical `main` after this call (P), when known.
    pub rev: Option<String>,
    /// Canonical `main` as fetched before publishing (R).
    pub base_rev: Option<String>,
    /// The local branch tip that was published (L).
    pub local_rev: Option<String>,
    pub git_sync_status: SyncStatus,
    /// The main recovery ref this publish created or reused.
    pub recovery_ref: Option<String>,
    pub recovery_refs: Vec<RecoveryRefReport>,
    pub conflicted_paths: Vec<String>,
    pub rejected_paths: Vec<RejectedPath>,
    /// The checkout now matches `rev`.
    pub checkout_moved: bool,
    /// Local recovery refs still waiting for a push.
    pub unpushed_refs: usize,
    /// Why nothing (or not everything) was published.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    /// A later attempt can succeed without anyone changing anything.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub retryable: bool,
}

impl PublishReport {
    fn note_recovery(&mut self, stored: Option<RecoveryRefReport>, primary: bool) {
        if let Some(stored) = stored {
            if primary || self.recovery_ref.is_none() {
                self.recovery_ref = Some(stored.reference.clone());
            }
            self.recovery_refs.push(stored);
        }
    }

    fn reject(&mut self, path: &str, reason: RejectReason, kept: bool) {
        if let Some(existing) = self
            .rejected_paths
            .iter_mut()
            .find(|entry| entry.path == path)
        {
            existing.kept_saved_version |= kept;
            return;
        }
        if self.rejected_paths.len() >= MAX_REPORTED_PATHS {
            return;
        }
        self.rejected_paths.push(RejectedPath {
            path: path.to_string(),
            reason,
            kept_saved_version: kept,
        });
    }
}

fn internal(error: anyhow::Error) -> OriginError {
    if error.downcast_ref::<DismissalNotApplied>().is_some() {
        // Not a merge conflict (409): nothing for the agent to resolve.
        return OriginError::with_report(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            DISMISSAL_NOT_APPLIED_CODE,
            format!("{error:#}"),
            serde_json::json!({ "retryable": false }),
        );
    }
    OriginError::internal(format!("{error:#}"))
}

/// The code of a save refused because dismissed work could not be taken off
/// the workspace's branch: nothing is published until it can be, since the
/// branch still carries the dismissed commits.
pub const DISMISSAL_NOT_APPLIED_CODE: &str = "dismissal_not_applied";

/// Dismissed work is still on the branch (see [`DISMISSAL_NOT_APPLIED_CODE`]).
#[derive(Debug)]
struct DismissalNotApplied;

impl std::fmt::Display for DismissalNotApplied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "dismissed recovery work could not be taken off this workspace's branch, so nothing was saved",
        )
    }
}

impl std::error::Error for DismissalNotApplied {}

/// Commit the selection and publish the local branch onto canonical `main`.
pub fn publish(
    ctx: &PublishContext<'_>,
    request: PublishRequest,
) -> Result<PublishReport, OriginError> {
    let mut publisher = Publisher::new(ctx, request.budget);
    publisher.run(request).map_err(internal)?;
    Ok(publisher.report)
}

/// Before a turn: push parked work, notice dismissed work, publish commits
/// left on the local branch, and move the checkout to `main`. With a read-only
/// token the checkout only moves when it holds nothing unpublished.
pub fn refresh(ctx: &PublishContext<'_>) -> Result<PublishReport, OriginError> {
    let mut publisher = Publisher::new(ctx, DEFAULT_PUBLISH_BUDGET);
    publisher
        .run(PublishRequest {
            selection: Selection::None,
            message: String::new(),
            author: None,
            budget: DEFAULT_PUBLISH_BUDGET,
        })
        .map_err(internal)?;
    Ok(publisher.report)
}

/// The result of a flush.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushReport {
    /// Recovery refs this flush created or reused.
    pub recovery_refs: Vec<RecoveryRefReport>,
    /// Local recovery refs still waiting for a push. Zero means everything
    /// this checkout holds is on canonical; a drain treats more as a failure.
    pub unpushed_refs: usize,
    /// The names of those refs (under `refs/instafy/local-recovery/`).
    pub unpushed_ref_names: Vec<String>,
    /// The publish of finished local commits, when one ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publish: Option<PublishReport>,
    /// Why that publish failed; its work stays on the local recovery refs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publish_error: Option<String>,
    /// Local commits of an unfinished turn moved to a recovery ref.
    pub parked_commits: usize,
}

/// Before a stop: store everything the checkout holds on local recovery
/// refs first (finished local commits as `unpublished`, the commits of an
/// unfinished turn and every unsaved edit as `unsaved`), with no network
/// call. Then, when the token allows, publish the finished commits by merge
/// (none when `turn_active`), which retires their local copy, and push the
/// parked refs. Dirty or half-finished work never reaches `main`. A stop
/// without write access or network, or one cut short, keeps everything on
/// local refs for the next publish or refresh to push.
pub fn flush(ctx: &PublishContext<'_>, turn_active: bool) -> Result<FlushReport, OriginError> {
    flush_within(ctx, turn_active, FLUSH_BUDGET)
}

/// [`flush`] with its own budget. Every network command (fetch retries, a
/// push started near the end, connecting included) stops at the budget's
/// end, so the flush answers before the controller stops waiting.
pub(crate) fn flush_within(
    ctx: &PublishContext<'_>,
    turn_active: bool,
    budget: Duration,
) -> Result<FlushReport, OriginError> {
    let mut publisher = Publisher::new(ctx, budget);
    publisher.git = publisher
        .git
        .with_stall_limit(FLUSH_STALL_SECONDS)
        .with_network_deadline(publisher.deadline);
    publisher.push_deadline = Some(publisher.deadline);
    publisher.flush(turn_active).map_err(internal)
}

/// Revert `commit` by applying its inverse to the index and work tree (only
/// for the paths it touched), committing that, and publishing. `base` is the
/// parent to revert against (required for merges and root commits).
pub fn revert_commit(
    ctx: &PublishContext<'_>,
    commit: &str,
    base: Option<&str>,
    author: Option<GitIdentity>,
) -> Result<PublishReport, OriginError> {
    let mut publisher = Publisher::new(ctx, DEFAULT_PUBLISH_BUDGET);
    publisher.revert(commit, base, author)?;
    Ok(publisher.report)
}

/// Most paths a restore's `keep` list may name. Per-file choices over a
/// conflict produce a handful; the bound keeps any list cheap to match
/// while the project's apply lock is held.
pub const MAX_RESTORE_KEEP_PATHS: usize = 10_000;

/// What a restore of unsaved work asks for.
#[derive(Clone, Debug, Default)]
pub struct RestoreRequest {
    /// A recovery ref (`refs/instafy/recovery/<origin id>/<name>`) or a
    /// salvage ref (`refs/instafy/salvage/gateway/<name>`).
    pub reference: String,
    /// The tip the person saw; a ref that names something else now is
    /// refused (409 `recovery_ref_moved`).
    pub rev: Option<String>,
    /// Paths (files or folders) that keep the saved version.
    pub keep: Vec<String>,
    /// Author of the restore commit; the origin's own identity when `None`.
    pub author: Option<GitIdentity>,
}

/// The result of a restore: the publish of the restore commit, plus what it
/// did with the unsaved work.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    #[serde(flatten)]
    pub publish: PublishReport,
    /// This call made the restore's new version: it committed one, or it
    /// published the restore commit an earlier call of the same ref made
    /// and could not publish. False when the saved version already held
    /// this work, or the rest of it was kept or refused.
    pub committed: bool,
    /// Paths the work changes that kept the saved version: kept on request,
    /// or never restorable here (ignored, excluded, secret, legacy
    /// attachments, too large).
    pub not_restored: Vec<String>,
    /// The recovery ref was removed after the restore reached `main`. It is
    /// removed only when everything it holds was restored or kept on
    /// request: work refused here (ignored, secret, excluded, too large)
    /// keeps the ref, the only copy of that work on canonical, for the
    /// person to review or remove. Salvage refs are never removed.
    pub ref_deleted: bool,
}

/// Restore unsaved work kept on a recovery or salvage ref onto the
/// checkout's branch and publish it (see `Publisher::restore`).
pub fn restore(
    ctx: &PublishContext<'_>,
    request: RestoreRequest,
) -> Result<RestoreReport, OriginError> {
    let mut publisher = Publisher::new(ctx, DEFAULT_PUBLISH_BUDGET);
    let (committed, not_restored, ref_deleted) = publisher.restore(request)?;
    Ok(RestoreReport {
        publish: publisher.report,
        committed,
        not_restored,
        ref_deleted,
    })
}

/// Run the one-time repair of copies an older sync left behind (see
/// [`crate::stale_align`]). Callers hold the apply lock. Desktop status
/// counts call this before listing changes.
pub fn repair_stale_checkout(
    config: &ServerConfig,
    workspace_root: &Path,
) -> Result<(), OriginError> {
    let git = WorkspaceGit::new(workspace_root, None);
    if git.commit_id("HEAD").map_err(internal)?.is_none() {
        return Ok(());
    }
    stale_align::repair_once(&git, config)
        .map(|_| ())
        .map_err(internal)
}

struct Publisher<'a> {
    git: WorkspaceGit<'a>,
    config: &'a ServerConfig,
    can_write: bool,
    deadline: Instant,
    remote: String,
    main_ref: String,
    tracking_ref: String,
    identity: GitIdentity,
    report: PublishReport,
    /// Paths frozen at their saved version, with why.
    filtered: BTreeMap<String, RejectReason>,
    /// The last fetch reached the remote.
    fetched: bool,
    /// Local commits whose sanitised rewrite reached `main`: work parked
    /// from them is on canonical too.
    published_aliases: Vec<String>,
    /// Stop pushing parked refs at this time (a stop's budget).
    push_deadline: Option<Instant>,
    /// The conflict copy of the attempt in flight, stored before its push so
    /// no push can land without it.
    conflict_copy: Option<RecoveryRefReport>,
    /// Copies stored in place of pending refs that built on dismissed work.
    separated: Vec<RecoveryRefReport>,
}

struct HistoryScan {
    commits: Vec<(String, Vec<String>)>,
    touched: BTreeSet<String>,
    found: BTreeMap<String, RejectReason>,
}

struct ParsedCommit {
    tree: String,
    author: GitIdentity,
    committer: GitIdentity,
    message: Vec<u8>,
}

enum Attempt {
    Done {
        main: String,
    },
    /// Another writer moved `main` first.
    Retry,
    /// The repository policy refused a path, now frozen; try again without it.
    PolicyRetry,
    Park {
        reason: String,
        retryable: bool,
    },
}

impl<'a> Publisher<'a> {
    fn new(ctx: &PublishContext<'a>, budget: Duration) -> Self {
        let config = ctx.config;
        Self {
            git: WorkspaceGit::new(ctx.workspace_root, ctx.token),
            config,
            can_write: ctx.can_write,
            deadline: Instant::now() + budget,
            remote: config.git_remote_name.clone(),
            main_ref: format!("refs/heads/{}", config.git_branch),
            tracking_ref: format!(
                "refs/remotes/{}/{}",
                config.git_remote_name, config.git_branch
            ),
            identity: GitIdentity::new(&config.git_author_name, &config.git_author_email),
            report: PublishReport::default(),
            filtered: BTreeMap::new(),
            fetched: false,
            published_aliases: Vec::new(),
            push_deadline: None,
            conflict_copy: None,
            separated: Vec::new(),
        }
    }

    // ------------------------------------------------------------------
    // Entry points
    // ------------------------------------------------------------------

    fn run(&mut self, request: PublishRequest) -> Result<()> {
        self.prepare()?;
        let head = self.git.commit_id("HEAD")?;
        let tree = self.stage(&request.selection, head.as_deref())?;
        let local =
            self.commit_selection(head.as_deref(), &tree, request.author, &request.message)?;
        self.report.local_rev = local.clone();
        self.publish_local(local)?;
        self.finish()
    }

    /// Repair, fetch, retire dismissed work, and push parked work. The fetch
    /// comes first: what was dismissed decides what may be pushed.
    fn prepare(&mut self) -> Result<()> {
        let repair = stale_align::repair_once(&self.git, self.config)?;
        self.report.note_recovery(repair.parked, false);
        let mut dismissal = Ok(false);
        match self.fetch(true) {
            Ok(_) => {
                self.fetched = true;
                dismissal = self.retire_dismissed();
            }
            // Without the recovery refs, dismissals wait for the next fetch;
            // publishing only needs main.
            Err(error) => match self.fetch(false) {
                Ok(_) => {
                    warn!(error = %format!("{error:#}"), "could not fetch recovery refs");
                    self.fetched = true;
                }
                Err(error) => {
                    warn!(error = %format!("{error:#}"), "could not fetch canonical main");
                    self.report.failure =
                        Some(format!("could not reach the saved history: {error:#}"));
                    self.report.retryable = true;
                }
            },
        }
        // Parked work goes out even when a dismissal could not be applied:
        // whatever builds on dismissed work is separated from it first.
        if self.can_write {
            self.push_pending();
        }
        if let Err(error) = dismissal {
            warn!(error = %format!("{error:#}"), "could not apply dismissed recovery work; nothing is published");
            return Err(error.context(DismissalNotApplied));
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        self.report.unpushed_refs = recovery::pending(&self.git)?.len();
        self.report.conflicted_paths.sort();
        self.report.conflicted_paths.dedup();
        Ok(())
    }

    fn push_pending(&mut self) {
        let pushed = self.push_parked();
        // Report the canonical name of anything this call pushed.
        for (name, canonical) in pushed {
            if let Some(entry) = self
                .report
                .recovery_refs
                .iter_mut()
                .find(|entry| entry.name == name)
            {
                if self.report.recovery_ref.as_deref() == Some(entry.reference.as_str()) {
                    self.report.recovery_ref = Some(canonical.clone());
                }
                entry.reference = canonical;
                entry.pushed = true;
            }
        }
    }

    /// Push every parked ref; returns `(name, canonical ref)` of each one
    /// pushed. Failures are logged; their refs stay local for the next call.
    /// A pending ref that builds on dismissed work is separated from it
    /// first and never pushed as it is.
    fn push_parked(&mut self) -> Vec<(String, String)> {
        if let Err(error) = self.separate_dismissed_work() {
            warn!(error = %format!("{error:#}"), "could not separate parked work from dismissed work; pushing nothing");
            return Vec::new();
        }
        let main = match self.tracked_main() {
            Ok(main) => main,
            Err(error) => {
                warn!(error = %format!("{error:#}"), "could not read canonical main");
                return Vec::new();
            }
        };
        let mut published: Vec<String> = main.iter().cloned().collect();
        if let Ok(Some(frontier)) = self.git.commit_id(PUBLISHED_FRONTIER_REF) {
            published.push(frontier);
        }
        match recovery::push_pending(
            &self.git,
            &self.remote,
            self.config.origin_id,
            main.as_deref(),
            &published,
            self.push_deadline,
        ) {
            Ok(result) => {
                for (name, detail) in &result.failed {
                    warn!(%name, %detail, "recovery ref not pushed yet");
                }
                result.pushed
            }
            Err(error) => {
                warn!(error = %format!("{error:#}"), "could not push recovery refs");
                Vec::new()
            }
        }
    }

    /// Replace every pending ref that builds on dismissed commits (parked
    /// before the dismissal was seen: on a stop, offline, or in a run whose
    /// dismissal could not be applied) by what is left without them, so no
    /// push ever sends dismissed work again:
    ///
    /// - an `unpublished` copy of commits a dismissal already replayed onto
    ///   the branch without the dismissed ones is retired: the branch holds
    ///   that rest;
    /// - any other copy is rebuilt on the replay of its parent when there is
    ///   one (an unsaved copy of a branch the dismissal moved), else on the
    ///   published commit below the dismissed work, with the dismissed
    ///   changes taken out by a three-way merge;
    /// - work that cannot be separated (a conflict) is left whole for a
    ///   person to decide, like the commits a dismissal sets aside.
    ///
    /// Replaced copies stay in the rejected backups, which are never pushed.
    fn separate_dismissed_work(&mut self) -> Result<()> {
        let pending = recovery::pending(&self.git)?;
        if pending.is_empty() {
            return Ok(());
        }
        let main = self.tracked_main()?;
        let mut dismissed = Vec::new();
        for (source, base) in recovery::dismissed_ranges(&self.git, self.config.origin_id)? {
            if self.is_published(&source, main.as_deref())? {
                continue;
            }
            let depth = self
                .git
                .stdout(&["rev-list", "--count", &source])?
                .trim()
                .parse::<u64>()
                .unwrap_or(0);
            dismissed.push((depth, source, base));
        }
        if dismissed.is_empty() {
            return Ok(());
        }
        // Deepest first: on one chain it covers the shallower ones.
        dismissed.sort_by(|a, b| b.0.cmp(&a.0));
        for (name, rev) in pending {
            let parents: Vec<String> = self
                .git
                .stdout(&["rev-list", "--parents", "-n", "1", &rev])?
                .split_whitespace()
                .skip(1)
                .map(str::to_string)
                .collect();
            let source = match recovery::source_of(&self.git, &rev)? {
                Some(source) if self.git.commit_id(&source)?.is_some() => Some(source),
                _ => None,
            };
            let mut found = None;
            'ranges: for (_, dismissed_source, base) in &dismissed {
                for anchor in parents.iter().chain(source.iter()) {
                    if self.git.is_ancestor(dismissed_source, anchor)? {
                        found = Some((dismissed_source.clone(), base.clone()));
                        break 'ranges;
                    }
                }
            }
            let Some((dismissed_source, base)) = found else {
                continue;
            };
            let kind = recovery::kind_of_name(&name).unwrap_or(RecoveryKind::Unsaved);
            if kind == RecoveryKind::Unpublished {
                if let Some(source) = source.as_deref() {
                    if recovery::replayed(&self.git, source)?.is_some() {
                        recovery::retire_pending(&self.git, &name, &rev)?;
                        info!(%name, "retired a parked copy of commits a dismissal replayed onto the branch");
                        continue;
                    }
                }
            }
            let replayed_parent = match parents.first() {
                Some(parent) => {
                    recovery::replayed(&self.git, parent)?.map(|replay| (parent.clone(), replay))
                }
                None => None,
            };
            let (merge_base, onto) = replayed_parent.unwrap_or((dismissed_source, base));
            let merged = three_way(&self.git, Some(&merge_base), &onto, &rev)?;
            if !merged.conflicts.is_empty() {
                warn!(%name, "parked work is tangled with dismissed work; it is kept whole for a person to decide");
                continue;
            }
            let paths = changed_paths(&self.git, &onto, &merged.tree)?;
            let stored = recovery::replace_pending(
                &self.git,
                &name,
                &rev,
                RecoverySpec {
                    kind,
                    tree: merged.tree,
                    parent: Some(onto),
                    source,
                    date: None,
                    paths: paths.into_iter().take(MAX_TRAILER_PATHS).collect(),
                    commits: Vec::new(),
                    identity: self.identity.clone(),
                    origin_id: self.config.origin_id,
                },
            )?;
            info!(%name, kept = stored.as_ref().map(|stored| stored.name.as_str()).unwrap_or("nothing"), "separated parked work from dismissed work");
            if let Some(stored) = stored.filter(|stored| stored.created) {
                self.report.note_recovery(Some(stored.clone()), false);
                self.separated.push(stored);
            }
        }
        Ok(())
    }

    /// Fetch canonical `main` (and, with `recovery`, mirror this project's
    /// recovery refs). Returns the fetched tip, `None` when `main` is missing.
    fn fetch(&self, recovery: bool) -> Result<Option<String>> {
        let heads = format!("+refs/heads/*:refs/remotes/{}/*", self.remote);
        let recovery_spec = format!(
            "+{root}/*:{root}/*",
            root = git_service::policy::RECOVERY_REF_ROOT
        );
        let mut args = vec!["fetch", "--no-tags", "--prune", "--no-write-fetch-head"];
        args.push(&self.remote);
        args.push(&heads);
        if recovery {
            args.push(&recovery_spec);
        }
        let mut attempts = 0;
        loop {
            let output = self.git.run(&args)?;
            if output.status.success() {
                break;
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let backoff = Duration::from_millis(250 << attempts);
            if attempts < 2
                && looks_like_transient_http_error(&stderr)
                && Instant::now() + backoff < self.deadline
            {
                std::thread::sleep(backoff);
                attempts += 1;
                continue;
            }
            bail!("{}", crate::workspace_git::failure(&args, &output));
        }
        self.git.commit_id(&self.tracking_ref)
    }

    fn tracked_main(&self) -> Result<Option<String>> {
        self.git.commit_id(&self.tracking_ref)
    }

    /// Take the commits of every dismissed `unpublished` ref off the local
    /// branch, so no later publish (or stop) sends them, and retire each
    /// pushed marker whose canonical ref was dismissed. A marker is retired
    /// only after the branch no longer carries its commits: when that fails,
    /// the error is returned and the next call sees the dismissal again.
    /// Returns whether the branch moved.
    fn retire_dismissed(&mut self) -> Result<bool> {
        let dismissed = recovery::dismissed_markers(&self.git, self.config.origin_id)?;
        let mut done = Vec::new();
        let mut unpublished = Vec::new();
        for (name, rev) in dismissed {
            info!(%name, "recovery work was dismissed");
            let source = if recovery::kind_of_name(&name) == Some(RecoveryKind::Unpublished) {
                recovery::source_of(&self.git, &rev)?
            } else {
                None
            };
            match source {
                Some(source) => unpublished.push((name, rev, source)),
                // Nothing on the branch to undo: retiring the marker is the
                // whole dismissal.
                None => done.push((name, rev)),
            }
        }
        recovery::retire_markers(&self.git, &done)?;

        // Deepest source first. Refs parked from the same chain share their
        // base, so a later ref's commits include an earlier one's: stepping
        // back below the later ref first leaves the earlier one's commits off
        // the branch too. The other order would replay the later commits as
        // new ones that no longer match the later ref's source, and publish
        // them.
        let mut ordered = Vec::new();
        for (name, rev, source) in unpublished {
            let depth = match self.git.commit_id(&source)? {
                Some(_) => self
                    .git
                    .stdout(&["rev-list", "--count", &source])?
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0),
                None => 0,
            };
            ordered.push((depth, name, rev, source));
        }
        ordered.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let mut moved = false;
        for (_, name, rev, source) in ordered {
            moved |= self.drop_dismissed_commits(&name, &rev, &source)?;
            recovery::retire_markers(&self.git, &[(name, rev)])?;
        }
        Ok(moved)
    }

    /// Take the dismissed commits (`rev`'s parent up to `source`) off the
    /// local branch. Later local commits on top of them are replayed onto
    /// that parent without them. When they cannot be separated, everything
    /// is set aside on a new `unpublished` ref for a person to decide, and the
    /// branch steps back. Files with unsaved edits keep them either way.
    fn drop_dismissed_commits(&mut self, name: &str, rev: &str, source: &str) -> Result<bool> {
        let Some(head) = self.git.commit_id("HEAD")? else {
            return Ok(false);
        };
        if self.git.commit_id(source)?.is_none() || !self.git.is_ancestor(source, &head)? {
            return Ok(false);
        }
        let main = self.tracked_main()?;
        if self.is_published(source, main.as_deref())? {
            return Ok(false);
        }
        let Some(base) = self.git.commit_id(&format!("{rev}^"))? else {
            return Ok(false);
        };
        let target = if head == source {
            Some((base.clone(), Vec::new()))
        } else {
            match self.replay_without(source, &head, &base) {
                Ok(target) => target,
                // A replay that cannot even be attempted (a path the merge
                // cannot read) is handled like a conflicting one.
                Err(error) => {
                    warn!(error = %format!("{error:#}"), %name, "could not replay later commits without the dismissed ones");
                    None
                }
            }
        };
        match target {
            Some((target, replayed)) => {
                self.move_keeping_edits(&head, &target)?;
                // Copies parked from the old commits are separated from the
                // dismissed work against these before any push.
                recovery::record_replayed(&self.git, &replayed)?;
                info!(%name, "took dismissed local commits off the branch");
            }
            None => {
                // Stored only; the caller's next push sends it.
                let stored = self.store_unpublished(&head, main.as_deref())?;
                self.report.note_recovery(stored, false);
                self.move_keeping_edits(&head, &base)?;
                warn!(
                    %name,
                    "later local commits build on dismissed work; set them all aside"
                );
            }
        }
        Ok(true)
    }

    /// Replay the first-parent commits after `dismissed` up to `head` onto
    /// `onto`, keeping each commit's author, committer and message. Returns
    /// the new tip and each old commit with the commit it became; `None`
    /// when one of them conflicts there, or is a merge.
    fn replay_without(
        &mut self,
        dismissed: &str,
        head: &str,
        onto: &str,
    ) -> Result<Option<(String, Vec<(String, String)>)>> {
        let listing = self.git.stdout(&[
            "rev-list",
            "--first-parent",
            "--reverse",
            "--parents",
            head,
            &format!("^{dismissed}"),
        ])?;
        let mut current = onto.to_string();
        let mut replayed = Vec::new();
        for line in listing.lines().filter(|line| !line.is_empty()) {
            let mut ids = line.split(' ');
            let Some(commit) = ids.next() else { continue };
            let parents: Vec<&str> = ids.collect();
            if parents.len() != 1 {
                return Ok(None);
            }
            let merged = three_way(&self.git, Some(parents[0]), &current, commit)?;
            if !merged.conflicts.is_empty() {
                return Ok(None);
            }
            if merged.tree != self.git.tree_id(&current)? {
                let parsed = self.parse_commit(commit)?;
                current = self.git.commit_tree(
                    &merged.tree,
                    &[&current],
                    &parsed.author,
                    &parsed.committer,
                    &parsed.message,
                )?;
            }
            replayed.push((commit.to_string(), current.clone()));
        }
        Ok(Some((current, replayed)))
    }

    // ------------------------------------------------------------------
    // Step 1: commit the selection
    // ------------------------------------------------------------------

    /// Stage the selection on top of `head` in a temporary index and return
    /// the resulting tree. Paths that may not be published keep `head`'s
    /// entry and are reported.
    fn stage(&mut self, selection: &Selection, head: Option<&str>) -> Result<String> {
        let head_tree = match head {
            Some(head) => self.git.tree_id(head)?,
            None => self.git.empty_tree()?,
        };
        let wanted: Option<Vec<String>> = match selection {
            Selection::None => return Ok(head_tree),
            Selection::AllDirty => None,
            Selection::Paths(paths) => Some(
                paths
                    .iter()
                    .map(|path| path.trim().trim_matches('/').to_string())
                    .filter(|path| !path.is_empty())
                    .collect(),
            ),
        };
        if wanted.as_ref().is_some_and(Vec::is_empty) {
            return Ok(head_tree);
        }

        let head_paths = |paths: &[String]| -> Result<BTreeSet<String>> {
            Ok(match head {
                Some(head) => self.git.tree_entries(head, paths)?.into_keys().collect(),
                None => BTreeSet::new(),
            })
        };

        // Explicitly selected ignored paths are reported, never staged.
        if let Some(wanted) = &wanted {
            for path in self.ignored(wanted)? {
                let kept = head_paths(std::slice::from_ref(&path))?.contains(&path);
                self.report.reject(&path, RejectReason::Ignored, kept);
            }
        }

        let status = self.status()?;
        let mut candidates = Vec::new();
        for (path, deleted) in status {
            if let Some(wanted) = &wanted {
                let selected = wanted
                    .iter()
                    .any(|chosen| path == *chosen || path.starts_with(&format!("{chosen}/")));
                if !selected {
                    continue;
                }
            }
            if let Some(reason) = self.pre_check(&path, deleted) {
                // Saving everything skips build output and caches quietly,
                // as it always has; a named path is reported.
                if wanted.is_some() || reason != RejectReason::Excluded {
                    let kept = head_paths(std::slice::from_ref(&path))?.contains(&path);
                    self.report.reject(&path, reason, kept);
                }
                continue;
            }
            candidates.push(path);
        }
        // `add` refuses a pathspec that matches nothing (a path staged and
        // then deleted, say); such a path is absent from the result anyway.
        let in_head = self.git.tree_entries(&head_tree, &candidates)?;
        candidates.retain(|path| {
            in_head.contains_key(path)
                || std::fs::symlink_metadata(self.git.root().join(path)).is_ok()
        });
        if candidates.is_empty() {
            return Ok(head_tree);
        }

        let scratch = temp_index_dir(&self.git)?;
        let index = scratch.path().join("index");
        let opts = RunOpts {
            index_file: Some(&index),
            ..RunOpts::default()
        };
        self.git.ok_opts(&["read-tree", &head_tree], &opts)?;
        {
            let touched: Vec<&str> = candidates.iter().map(String::as_str).collect();
            let _guard = EmbeddedGitDirGuard::hide(self.git.root(), &touched)?;
            let list = nul_list(&candidates);
            self.git.ok_opts(
                &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
                &RunOpts {
                    index_file: Some(&index),
                    stdin: Some(&list),
                    literal_pathspecs: true,
                    ..RunOpts::default()
                },
            )?;
        }

        // Check what was actually staged (directories expand here) and put
        // back the saved entry for anything that may not be published.
        let raw = self.git.bytes_opts(
            &[
                "diff-index",
                "--cached",
                "-z",
                "--no-renames",
                "--raw",
                &head_tree,
            ],
            &opts,
        )?;
        let changes = parse_raw_changes(&raw);
        let sizes = self.blob_sizes(&changes)?;
        let mut revert = Vec::new();
        for change in &changes {
            if let Some(reason) = self.policy_reason(change, &sizes) {
                let kept = change.status != 'A';
                self.report.reject(&change.path, reason, kept);
                revert.push(change.path.clone());
            }
        }
        if !revert.is_empty() {
            let restored = tree_with_entries_from(
                &self.git,
                &self.git.stdout_opts(&["write-tree"], &opts)?,
                Some(&head_tree),
                &revert,
            )?;
            return Ok(restored);
        }
        self.git.stdout_opts(&["write-tree"], &opts)
    }

    /// `(path, deleted)` for each changed, deleted or untracked path that is
    /// not ignored. An untracked directory (an embedded repository) is listed
    /// once, without a trailing slash.
    fn status(&self) -> Result<Vec<(String, bool)>> {
        let raw = self.git.bytes(&[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
            "--no-renames",
        ])?;
        let mut entries = Vec::new();
        for record in raw.split(|byte| *byte == 0).filter(|r| r.len() > 3) {
            let code = &record[..2];
            let Ok(path) = std::str::from_utf8(&record[3..]) else {
                warn!("skipping a path that is not valid UTF-8");
                continue;
            };
            let path = path.trim_end_matches('/').to_string();
            if path.is_empty() || crate::paths::is_reserved_path(&path) {
                continue;
            }
            let _ = code;
            let deleted = std::fs::symlink_metadata(self.git.root().join(&path)).is_err();
            entries.push((path, deleted));
        }
        entries.sort();
        entries.dedup();
        Ok(entries)
    }

    /// Paths among `paths` that `.gitignore` matches (tracked files never
    /// count as ignored).
    fn ignored(&self, paths: &[String]) -> Result<Vec<String>> {
        let input = nul_list(paths);
        let output = self.git.run_opts(
            &["check-ignore", "-z", "--stdin"],
            &RunOpts {
                stdin: Some(&input),
                ..RunOpts::default()
            },
        )?;
        match output.status.code() {
            Some(0) | Some(1) => Ok(output
                .stdout
                .split(|byte| *byte == 0)
                .filter(|record| !record.is_empty())
                .map(|record| String::from_utf8_lossy(record).to_string())
                .collect()),
            _ => bail!(
                "{}",
                crate::workspace_git::failure(&["check-ignore"], &output)
            ),
        }
    }

    /// Cheap checks before staging, from the path and the file's size.
    fn pre_check(&self, path: &str, deleted: bool) -> Option<RejectReason> {
        if deleted {
            return (!deletion_allowed(path)).then_some(RejectReason::Excluded);
        }
        if let Some(reason) = unpublishable_reason(path) {
            return Some(reason);
        }
        if is_unsafe_path(path) {
            return Some(RejectReason::Unsupported);
        }
        let metadata = std::fs::symlink_metadata(self.git.root().join(path)).ok()?;
        (metadata.is_file() && metadata.len() > MAX_PUBLISH_BLOB_BYTES)
            .then_some(RejectReason::TooLarge)
    }

    fn blob_sizes(&self, changes: &[RawChange]) -> Result<HashMap<String, u64>> {
        let ids: Vec<String> = changes
            .iter()
            .filter(|change| change.status != 'D' && change.new_mode != "160000")
            .map(|change| change.new_oid.clone())
            .collect();
        let sizes = self.git.object_sizes(&ids)?;
        Ok(ids
            .into_iter()
            .zip(sizes)
            .filter_map(|(id, size)| size.map(|(_, size)| (id, size)))
            .collect())
    }

    /// Why a staged or committed change may not reach `main`.
    fn policy_reason(
        &self,
        change: &RawChange,
        sizes: &HashMap<String, u64>,
    ) -> Option<RejectReason> {
        if let Some(reason) = self.filtered.get(&change.path) {
            return Some(*reason);
        }
        if change.status == 'D' {
            return (!deletion_allowed(&change.path)).then_some(RejectReason::Excluded);
        }
        if let Some(reason) = unpublishable_reason(&change.path) {
            return Some(reason);
        }
        if is_unsafe_path(&change.path) || change.new_mode == "160000" {
            return Some(RejectReason::Unsupported);
        }
        if sizes
            .get(&change.new_oid)
            .is_some_and(|size| *size > MAX_PUBLISH_BLOB_BYTES)
        {
            return Some(RejectReason::TooLarge);
        }
        None
    }

    /// Commit `tree` onto `head` as the local branch tip L, when it differs.
    fn commit_selection(
        &mut self,
        head: Option<&str>,
        tree: &str,
        author: Option<GitIdentity>,
        message: &str,
    ) -> Result<Option<String>> {
        let head_tree = match head {
            Some(head) => Some(self.git.tree_id(head)?),
            None => None,
        };
        let unchanged = match &head_tree {
            Some(head_tree) => head_tree == tree,
            None => self.git.empty_tree()? == tree,
        };
        if unchanged {
            return Ok(head.map(str::to_string));
        }
        let author = author.unwrap_or_else(|| self.identity.clone());
        // The origin commits this as itself: a caller's text never names a
        // restore (see `recovery_view::mark_restored`).
        let message = without_restored_from(message);
        let message = if message.trim().is_empty() {
            "Save workspace changes".to_string()
        } else {
            message.trim().to_string()
        };
        let parents: Vec<&str> = head.into_iter().collect();
        let local = self.git.commit_tree(
            tree,
            &parents,
            &author,
            &self.identity,
            format!("{message}\n").as_bytes(),
        )?;
        self.git
            .update_ref("HEAD", &local, head, "instafy: save selected changes")?;
        // The real index follows the new commit for the paths it changed;
        // anything else the index holds stays as it was.
        let changed = match head {
            Some(head) => changed_paths(&self.git, head, &local)?,
            None => changed_paths(&self.git, &self.git.empty_tree()?, &local)?,
        };
        self.reset_index_paths(&changed)?;
        self.report.local_rev = Some(local.clone());
        Ok(Some(local))
    }

    /// Set the real index entries for `paths` to HEAD's.
    fn reset_index_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let list = nul_list(paths);
        self.git.ok_opts(
            &[
                "reset",
                "-q",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            &RunOpts {
                stdin: Some(&list),
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )
    }

    // ------------------------------------------------------------------
    // Steps 2-6: publish the local branch
    // ------------------------------------------------------------------

    fn publish_local(&mut self, local: Option<String>) -> Result<()> {
        if !self.fetched {
            // The remote is unreachable: keep local commits for later, and
            // park them so a lost checkout cannot lose them.
            if let Some(local) = local.as_deref() {
                let main = self.tracked_main()?;
                if !self.is_published(local, main.as_deref())? {
                    let local = self.sanitize(local, main.as_deref())?;
                    self.park_unpublished(&local, main.as_deref())?;
                    self.report.git_sync_status = SyncStatus::Unpublished;
                }
            }
            return Ok(());
        }
        let mut main = self.tracked_main()?;
        self.report.base_rev = main.clone();

        let Some(mut local) = local else {
            // Nothing local at all: follow main if it exists.
            if let Some(main) = main.as_deref() {
                self.report.rev = Some(main.to_string());
                self.report.checkout_moved = self.checkout_unborn(main)?;
            }
            return Ok(());
        };

        if self.is_published(&local, main.as_deref())? {
            let main = main.unwrap_or_else(|| local.clone());
            self.report.rev = Some(main.clone());
            self.report.checkout_moved = self.move_checkout(&local, &main)?;
            if self.can_write {
                self.retire_superseded(&main);
            }
            return Ok(());
        }

        if !self.can_write {
            self.report.git_sync_status = SyncStatus::Unpublished;
            self.report.failure = Some("saving needs write access to the workspace".to_string());
            self.report.rev = main;
            return Ok(());
        }

        // Every version of the local tip before a sanitising rewrite: work
        // parked from any of them is published once the rewrite lands.
        let mut rewritten_from = vec![local.clone()];
        local = self.sanitize(&local, main.as_deref())?;
        let mut lost_races = 0usize;
        let mut policy_refusals = 0usize;
        let (merged_conflicts, _, unrelated) = loop {
            let (attempt, conflicts, base, is_unrelated) = self.attempt(&local, main.as_deref())?;
            match attempt {
                Attempt::Done { main: published } => {
                    main = Some(published);
                    break (conflicts, base, is_unrelated);
                }
                Attempt::Retry => {
                    lost_races += 1;
                    if lost_races >= MAX_ATTEMPTS || Instant::now() >= self.deadline {
                        self.discard_conflict_copy()?;
                        self.report.failure =
                            Some("the saved version kept changing; try again".to_string());
                        self.report.retryable = true;
                        self.park_unpublished(&local, main.as_deref())?;
                        self.report.git_sync_status = SyncStatus::Unpublished;
                        return Ok(());
                    }
                    jitter(lost_races);
                    main = match self.fetch(false) {
                        Ok(main) => main,
                        Err(error) => {
                            self.discard_conflict_copy()?;
                            self.report.failure =
                                Some(format!("could not reach the saved history: {error:#}"));
                            self.report.retryable = true;
                            let tracked = self.tracked_main()?;
                            self.park_unpublished(&local, tracked.as_deref())?;
                            self.report.git_sync_status = SyncStatus::Unpublished;
                            return Ok(());
                        }
                    };
                    self.report.base_rev = main.clone();
                    // A path the policy refused may have been added since.
                    rewritten_from.push(local.clone());
                    local = self.sanitize(&local, main.as_deref())?;
                }
                Attempt::PolicyRetry => {
                    policy_refusals += 1;
                    if policy_refusals > MAX_POLICY_REFUSALS {
                        self.discard_conflict_copy()?;
                        self.report.failure = Some(format!(
                            "the repository policy refused more than {MAX_POLICY_REFUSALS} files in this save"
                        ));
                        self.report.retryable = false;
                        self.park_unpublished(&local, main.as_deref())?;
                        self.report.git_sync_status = SyncStatus::Unpublished;
                        return Ok(());
                    }
                    if Instant::now() >= self.deadline {
                        self.discard_conflict_copy()?;
                        self.report.failure = Some(
                            "the repository policy refused files, and leaving them out took too long; try again"
                                .to_string(),
                        );
                        self.report.retryable = true;
                        self.park_unpublished(&local, main.as_deref())?;
                        self.report.git_sync_status = SyncStatus::Unpublished;
                        return Ok(());
                    }
                    // The refused path is frozen now: rewrite without it.
                    rewritten_from.push(local.clone());
                    local = self.sanitize(&local, main.as_deref())?;
                }
                Attempt::Park { reason, retryable } => {
                    self.discard_conflict_copy()?;
                    self.report.failure = Some(reason);
                    self.report.retryable = retryable;
                    self.park_unpublished(&local, main.as_deref())?;
                    self.report.git_sync_status = SyncStatus::Unpublished;
                    return Ok(());
                }
            }
        };

        let main = main.expect("a successful publish leaves main");
        self.git.ok(&["update-ref", &self.tracking_ref, &main])?;
        self.report.rev = Some(main.clone());
        for earlier in rewritten_from {
            if earlier != local && !self.published_aliases.contains(&earlier) {
                self.published_aliases.push(earlier);
            }
        }

        if !merged_conflicts.is_empty() {
            self.report.conflicted_paths = merged_conflicts.clone();
            // Stored before the push that just landed.
            let stored = self.conflict_copy.take();
            self.report.note_recovery(stored, true);
        }

        self.report.checkout_moved = self.move_checkout(&local, &main)?;
        if self.report.checkout_moved
            && !self.config.hosted_checkout
            && !merged_conflicts.is_empty()
        {
            // A Desktop folder belongs to the user: their version of every
            // conflicted file stays on disk as a local edit against `main`.
            self.write_worktree_versions(&local, &merged_conflicts)?;
        }
        if unrelated {
            self.git
                .ok(&["update-ref", PUBLISHED_FRONTIER_REF, &local])?;
        }
        self.retire_superseded(&main);
        self.push_pending();

        self.report.git_sync_status =
            if self.report.conflicted_paths.is_empty() && self.report.rejected_paths.is_empty() {
                SyncStatus::Published
            } else {
                SyncStatus::Partial
            };
        Ok(())
    }

    /// Whether every commit in `local` is already part of `main`.
    fn is_published(&self, local: &str, main: Option<&str>) -> Result<bool> {
        let Some(main) = main else { return Ok(false) };
        if self.git.is_ancestor(local, main)? {
            return Ok(true);
        }
        // Commits replayed onto an unrelated main are published too.
        if let Some(frontier) = self.git.commit_id(PUBLISHED_FRONTIER_REF)? {
            if self.git.is_ancestor(local, &frontier)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// One push attempt. Also returns the merge conflicts, the merge base
    /// recovery refs use as parent, and whether the histories were unrelated.
    fn attempt(
        &mut self,
        local: &str,
        main: Option<&str>,
    ) -> Result<(Attempt, Vec<String>, Option<String>, bool)> {
        let Some(main) = main else {
            // (a) main is missing: create it, unless someone else just did.
            self.discard_conflict_copy()?;
            let spec = format!("{local}:{}", self.main_ref);
            let result = push(
                &self.git,
                &self.remote,
                &[spec],
                std::slice::from_ref(&self.main_ref),
            )?;
            let attempt = self.classify(result.class, local)?;
            return Ok((attempt, Vec::new(), None, false));
        };

        if self.git.is_ancestor(main, local)? {
            // (c) a fast-forward of main.
            self.discard_conflict_copy()?;
            let spec = format!("{local}:{}", self.main_ref);
            let result = push(&self.git, &self.remote, &[spec], &[])?;
            let attempt = self.classify(result.class, local)?;
            return Ok((attempt, Vec::new(), Some(main.to_string()), false));
        }

        match self.git.merge_base(local, main)? {
            Some(base) => {
                // (d) one merge commit on top of main.
                let merged = three_way(&self.git, Some(&base), main, local)?;
                self.stage_conflict_copy(local, &base, main, &merged.conflicts, false)?;
                let count = self
                    .git
                    .stdout(&["rev-list", "--count", local, &format!("^{main}")])?
                    .parse::<usize>()
                    .unwrap_or(0);
                let message = merge_message(self.config, count, &merged.conflicts);
                let merge = self.git.commit_tree(
                    &merged.tree,
                    &[main, local],
                    &self.identity,
                    &self.identity,
                    message.as_bytes(),
                )?;
                let spec = format!("{merge}:{}", self.main_ref);
                let result = push(&self.git, &self.remote, &[spec], &[])?;
                let attempt = self.classify(result.class, &merge)?;
                Ok((attempt, merged.conflicts, Some(base), false))
            }
            None => {
                // (e) unrelated histories: replay the local first-parent
                // commits onto main, oldest first.
                let (attempt, conflicts) = self.replay(local, main)?;
                Ok((attempt, conflicts, Some(main.to_string()), true))
            }
        }
    }

    fn replay(&mut self, local: &str, main: &str) -> Result<(Attempt, Vec<String>)> {
        let mut args = vec![
            "rev-list".to_string(),
            "--first-parent".to_string(),
            "--reverse".to_string(),
            local.to_string(),
            format!("^{main}"),
        ];
        if let Some(frontier) = self.git.commit_id(PUBLISHED_FRONTIER_REF)? {
            args.push(format!("^{frontier}"));
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let commits: Vec<String> = self
            .git
            .stdout(&arg_refs)?
            .lines()
            .map(str::to_string)
            .collect();
        if commits.len() > MAX_REPLAYED_COMMITS {
            return Ok((
                Attempt::Park {
                    reason: format!(
                        "{} local commits do not share history with the saved version",
                        commits.len()
                    ),
                    retryable: false,
                },
                Vec::new(),
            ));
        }
        let mut current = main.to_string();
        let mut conflicts = Vec::new();
        for commit in &commits {
            let parent = self.git.commit_id(&format!("{commit}^"))?;
            let merged = three_way(&self.git, parent.as_deref(), &current, commit)?;
            conflicts.extend(merged.conflicts);
            if merged.tree == self.git.tree_id(&current)? {
                continue;
            }
            let parsed = self.parse_commit(commit)?;
            current = self.git.commit_tree(
                &merged.tree,
                &[&current],
                &parsed.author,
                &self.identity,
                &parsed.message,
            )?;
        }
        self.stage_conflict_copy(local, main, main, &conflicts, true)?;
        if current == main {
            return Ok((Attempt::Done { main: current }, conflicts));
        }
        let spec = format!("{current}:{}", self.main_ref);
        let result = push(&self.git, &self.remote, &[spec], &[])?;
        let attempt = self.classify(result.class, &current)?;
        Ok((attempt, conflicts))
    }

    /// Store the local version of the paths this attempt's merge left at
    /// `main`'s version, before the push, on a local `conflict` ref with
    /// parent `base`. A copy an earlier attempt stored for other conflicts
    /// is dropped first. For an unrelated history the copy is `main` (the
    /// tip the replay started from) with the local version of only those
    /// paths, so it never reads as deleting what `main` alone holds.
    fn stage_conflict_copy(
        &mut self,
        local: &str,
        base: &str,
        main: &str,
        conflicts: &[String],
        unrelated: bool,
    ) -> Result<()> {
        if conflicts.is_empty() {
            return self.discard_conflict_copy();
        }
        let tree = if unrelated {
            let frozen: Vec<String> = self.filtered.keys().cloned().collect();
            let paths: Vec<String> = conflicts
                .iter()
                .filter(|path| !frozen.contains(path))
                .cloned()
                .collect();
            tree_with_entries_from(&self.git, base, Some(local), &paths)?
        } else {
            self.tree_for_recovery(local, Some(base))?
        };
        let stored = recovery::store(
            &self.git,
            RecoverySpec {
                kind: RecoveryKind::Conflict,
                tree,
                parent: Some(base.to_string()),
                source: Some(local.to_string()),
                date: self.committer_date(local)?,
                paths: conflicts.to_vec(),
                commits: self.local_commits(local, main)?,
                identity: self.identity.clone(),
                origin_id: self.config.origin_id,
            },
        )?;
        if self.conflict_copy.as_ref().map(|copy| &copy.name)
            != stored.as_ref().map(|copy| &copy.name)
        {
            self.discard_conflict_copy()?;
        }
        self.conflict_copy = stored;
        Ok(())
    }

    /// Delete the conflict copy staged for an attempt that did not land,
    /// when this publish created it and it was never pushed.
    fn discard_conflict_copy(&mut self) -> Result<()> {
        if let Some(copy) = self.conflict_copy.take() {
            let reference = format!("{}/{}", recovery::LOCAL_RECOVERY_ROOT, copy.name);
            if copy.created && self.git.commit_id(&reference)?.as_deref() == Some(copy.rev.as_str())
            {
                self.git.delete_ref(&reference, &copy.rev)?;
            }
        }
        Ok(())
    }

    fn classify(&mut self, class: PushClass, pushed: &str) -> Result<Attempt> {
        match class {
            PushClass::Pushed => Ok(Attempt::Done {
                main: pushed.to_string(),
            }),
            PushClass::LostRace(_) => Ok(Attempt::Retry),
            PushClass::PathRejected { path, reason } => {
                if self.filtered.contains_key(&path) {
                    return Ok(Attempt::Park {
                        reason: format!("the repository policy refused {path}"),
                        retryable: false,
                    });
                }
                self.filtered.insert(path.clone(), reason);
                Ok(Attempt::PolicyRetry)
            }
            PushClass::Rejected(text) => Ok(Attempt::Park {
                reason: format!("the saved history refused the save: {text}"),
                retryable: false,
            }),
            PushClass::Ambiguous(text) => {
                // The push may have landed: check before trying again.
                match self.fetch(false) {
                    Ok(Some(main)) if self.git.is_ancestor(pushed, &main)? => {
                        Ok(Attempt::Done { main })
                    }
                    Ok(_) => Ok(Attempt::Retry),
                    Err(_) => Ok(Attempt::Park {
                        reason: format!("could not reach the saved history: {text}"),
                        retryable: true,
                    }),
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Local sanitising of unpublished history
    // ------------------------------------------------------------------

    /// Find never-published local commits that add, change or delete a path
    /// that may not be published, and add those paths to the frozen set.
    fn scan_history(&mut self, local: &str, main: Option<&str>) -> Result<Option<HistoryScan>> {
        let mut args = vec![
            "rev-list".to_string(),
            "--topo-order".to_string(),
            "--reverse".to_string(),
            "--parents".to_string(),
            local.to_string(),
        ];
        if let Some(main) = main {
            args.push(format!("^{main}"));
        }
        if let Some(frontier) = self.git.commit_id(PUBLISHED_FRONTIER_REF)? {
            args.push(format!("^{frontier}"));
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let listing = self.git.stdout(&arg_refs)?;
        let commits: Vec<(String, Vec<String>)> = listing
            .lines()
            .filter_map(|line| {
                let mut ids = line.split(' ').map(str::to_string);
                let commit = ids.next()?;
                Some((commit, ids.collect()))
            })
            .collect();
        if commits.is_empty() {
            return Ok(None);
        }

        let mut input = String::new();
        for (commit, _) in &commits {
            input.push_str(commit);
            input.push('\n');
        }
        let raw = self.git.bytes_opts(
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
        let per_commit = parse_stdin_diff_tree(&raw);
        let all: Vec<RawChange> = per_commit.values().flatten().cloned().collect();
        let sizes = self.blob_sizes(&all)?;
        let mut touched: BTreeSet<String> = BTreeSet::new();
        let mut found: BTreeMap<String, RejectReason> = BTreeMap::new();
        for (commit, changes) in &per_commit {
            for change in changes {
                if let Some(reason) = self.policy_reason(change, &sizes) {
                    touched.insert(commit.clone());
                    found.entry(change.path.clone()).or_insert(reason);
                }
            }
        }
        if found.is_empty() {
            return Ok(None);
        }
        for (path, reason) in &found {
            self.filtered.entry(path.clone()).or_insert(*reason);
        }
        Ok(Some(HistoryScan {
            commits,
            touched,
            found,
        }))
    }

    /// Rewrite never-published local commits so every frozen path keeps its
    /// earlier version throughout. Authors, committers, dates and messages
    /// are kept. Returns the new local tip (the same commit when nothing
    /// needed rewriting) and moves HEAD to it when HEAD was `local`.
    fn sanitize(&mut self, local: &str, main: Option<&str>) -> Result<String> {
        let Some(scan) = self.scan_history(local, main)? else {
            return Ok(local.to_string());
        };
        let frozen: Vec<String> = self.filtered.keys().cloned().collect();
        let mut map: HashMap<String, String> = HashMap::new();
        for (commit, parents) in &scan.commits {
            let new_parents: Vec<String> = parents
                .iter()
                .map(|parent| map.get(parent).cloned().unwrap_or_else(|| parent.clone()))
                .collect();
            if !scan.touched.contains(commit) && &new_parents == parents {
                map.insert(commit.clone(), commit.clone());
                continue;
            }
            let parsed = self.parse_commit(commit)?;
            let tree = tree_with_entries_from(
                &self.git,
                &parsed.tree,
                new_parents.first().map(String::as_str),
                &frozen,
            )?;
            let parent_refs: Vec<&str> = new_parents.iter().map(String::as_str).collect();
            let rewritten = self.git.commit_tree(
                &tree,
                &parent_refs,
                &parsed.author,
                &parsed.committer,
                &parsed.message,
            )?;
            map.insert(commit.clone(), rewritten);
        }
        let rewritten = map.get(local).cloned().unwrap_or_else(|| local.to_string());
        if rewritten != local {
            if self.git.commit_id("HEAD")?.as_deref() == Some(local) {
                self.git.update_ref(
                    "HEAD",
                    &rewritten,
                    Some(local),
                    "instafy: keep unpublishable files local",
                )?;
                self.reset_index_paths(&frozen)?;
            }
            info!(
                paths = scan.found.len(),
                "kept unpublishable files out of local commits"
            );
        }
        let kept = self.git.tree_entries(&rewritten, &frozen)?;
        for (path, reason) in scan.found {
            let kept_saved = kept.contains_key(&path);
            self.report.reject(&path, reason, kept_saved);
        }
        self.report.local_rev = Some(rewritten.clone());
        Ok(rewritten)
    }

    fn parse_commit(&self, commit: &str) -> Result<ParsedCommit> {
        let object = self
            .git
            .read_objects(&[commit.to_string()])?
            .pop()
            .context("commit missing")?;
        let split = object
            .data
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|index| index + 2)
            .unwrap_or(object.data.len());
        let headers = String::from_utf8_lossy(&object.data[..split]).to_string();
        let message = object.data[split..].to_vec();
        let mut tree = None;
        let mut author = None;
        let mut committer = None;
        for line in headers.lines() {
            if let Some(value) = line.strip_prefix("tree ") {
                tree = Some(value.to_string());
            } else if let Some(value) = line.strip_prefix("author ") {
                author = parse_ident(value);
            } else if let Some(value) = line.strip_prefix("committer ") {
                committer = parse_ident(value);
            }
        }
        Ok(ParsedCommit {
            tree: tree.context("commit has no tree")?,
            author: author.context("commit has no author")?,
            committer: committer.context("commit has no committer")?,
            message,
        })
    }

    fn committer_date(&self, commit: &str) -> Result<Option<String>> {
        Ok(self.parse_commit(commit)?.committer.date)
    }

    fn local_commits(&self, local: &str, main: &str) -> Result<Vec<CommitSummary>> {
        let raw = self.git.stdout(&[
            "log",
            "--no-merges",
            "--format=%h%x00%s%x00%an",
            "-n",
            "60",
            local,
            &format!("^{main}"),
        ])?;
        Ok(raw
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\0');
                Some(CommitSummary {
                    short: fields.next()?.to_string(),
                    subject: fields.next()?.to_string(),
                    author: fields.next()?.to_string(),
                })
            })
            .collect())
    }

    // ------------------------------------------------------------------
    // Recovery
    // ------------------------------------------------------------------

    /// L's tree with every frozen path taking `parent`'s entry, so restoring
    /// the recovery commit never removes or replaces those paths.
    fn tree_for_recovery(&self, local: &str, parent: Option<&str>) -> Result<String> {
        let frozen: Vec<String> = self.filtered.keys().cloned().collect();
        tree_with_entries_from(&self.git, local, parent, &frozen)
    }

    fn park_unpublished(&mut self, local: &str, main: Option<&str>) -> Result<()> {
        let stored = self.store_unpublished(local, main)?;
        self.report.note_recovery(stored, true);
        if self.can_write && self.fetched {
            self.push_pending();
        }
        Ok(())
    }

    /// Store the local commits `local` that are not on `main` as a local
    /// `unpublished` recovery ref, without any network call. The copy sits on
    /// a published parent (the merge base, or `main` for an unrelated
    /// history), and paths that may not be published keep that parent's
    /// entry, so pushing it never sends them.
    fn store_unpublished(
        &mut self,
        local: &str,
        main: Option<&str>,
    ) -> Result<Option<RecoveryRefReport>> {
        // Freeze every unpublishable path the never-published commits touch,
        // even when no publish has scanned them yet (an offline stop).
        self.scan_history(local, main)?;
        let base = match main {
            Some(main) => self.git.merge_base(local, main)?,
            None => None,
        };
        let (parent, tree) = match (base, main) {
            (Some(base), _) => {
                let tree = self.tree_for_recovery(local, Some(&base))?;
                (Some(base), tree)
            }
            (None, Some(main)) => (
                Some(main.to_string()),
                self.unrelated_tree(main, local, local)?,
            ),
            (None, None) => (None, self.tree_for_recovery(local, None)?),
        };
        let commits = match main {
            Some(main) => self.local_commits(local, main)?,
            None => Vec::new(),
        };
        let paths = match parent.as_deref() {
            Some(parent) => changed_paths(&self.git, parent, &tree)?,
            None => changed_paths(&self.git, &self.git.empty_tree()?, &tree)?,
        };
        recovery::store(
            &self.git,
            RecoverySpec {
                kind: RecoveryKind::Unpublished,
                tree,
                parent,
                source: Some(local.to_string()),
                date: self.committer_date(local)?,
                paths: paths.into_iter().take(MAX_TRAILER_PATHS).collect(),
                commits,
                identity: self.identity.clone(),
                origin_id: self.config.origin_id,
            },
        )
    }

    /// The tree a recovery commit on `main` holds for `top` (a commit or
    /// tree built on the local commit `head`) from a history unrelated to
    /// `main`: `main` with what `top` changed, never removing what only
    /// `main` holds. After an earlier replay (the published frontier), only
    /// what changed since then. Frozen paths keep `main`'s entry.
    fn unrelated_tree(&self, main: &str, head: &str, top: &str) -> Result<String> {
        let frozen: Vec<String> = self.filtered.keys().cloned().collect();
        if let Some(frontier) = self.git.commit_id(PUBLISHED_FRONTIER_REF)? {
            if self.git.is_ancestor(&frontier, head)? {
                let paths: Vec<String> = changed_paths(&self.git, &frontier, top)?
                    .into_iter()
                    .filter(|path| {
                        !frozen
                            .iter()
                            .any(|kept| path == kept || path.starts_with(&format!("{kept}/")))
                    })
                    .collect();
                return tree_with_entries_from(&self.git, main, Some(top), &paths);
            }
        }
        overlay(&self.git, main, top, &frozen)
    }

    fn retire_superseded(&mut self, main: &str) {
        match recovery::retire_superseded(
            &self.git,
            &self.remote,
            self.config.origin_id,
            main,
            self.can_write,
            &self.published_aliases,
        ) {
            Ok(retired) => {
                for name in retired {
                    info!(%name, "retired recovery work that is now saved");
                }
            }
            Err(error) => {
                warn!(error = %format!("{error:#}"), "could not retire saved recovery work")
            }
        }
    }

    // ------------------------------------------------------------------
    // Moving the checkout
    // ------------------------------------------------------------------

    /// Move the branch and work tree from `from` to `to` with
    /// `reset --keep`, which refuses rather than overwrite a local edit. A
    /// local copy identical to `to`'s version does not block the move. On
    /// refusal the checkout stays where it is.
    fn move_checkout(&self, from: &str, to: &str) -> Result<bool> {
        if from == to {
            return Ok(true);
        }
        if self.git.commit_id("HEAD")?.as_deref() != Some(from) {
            return Ok(false);
        }
        // Index entries written without stat data (after a path-limited
        // reset) look modified to `reset --keep` on older git until the
        // index is refreshed. A non-zero exit only means some files differ.
        let _ = self.git.run(&["update-index", "-q", "--refresh"])?;
        if self
            .git
            .run(&["reset", "-q", "--keep", to])?
            .status
            .success()
        {
            return Ok(true);
        }
        let changed = changed_paths(&self.git, from, to)?;
        if changed.is_empty() {
            return Ok(false);
        }
        let worktree = stale_align::worktree_entries(&self.git, from, &changed)?;
        let target = self.git.tree_entries(to, &changed)?;
        let current = self.git.tree_entries(from, &changed)?;
        let mut same = Vec::new();
        for path in &changed {
            let local = worktree.get(path);
            let wanted = target.get(path);
            let differs_from_head = match (local, current.get(path)) {
                (Some(a), Some(b)) => a.mode != b.mode || a.oid != b.oid,
                (None, None) => false,
                _ => true,
            };
            let equal_to_target = match (local, wanted) {
                (Some(a), Some(b)) => a.mode == b.mode && a.oid == b.oid,
                (None, None) => true,
                _ => false,
            };
            if differs_from_head && equal_to_target {
                same.push(path.clone());
            }
        }
        if same.is_empty() {
            return Ok(false);
        }
        let list = nul_list(&same);
        self.git.ok_opts(
            &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
            &RunOpts {
                stdin: Some(&list),
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
        Ok(self
            .git
            .run(&["reset", "-q", "--keep", to])?
            .status
            .success())
    }

    /// Check out `main` on a branch with no commits yet.
    fn checkout_unborn(&self, main: &str) -> Result<bool> {
        let branch = self.config.git_branch.as_str();
        Ok(self
            .git
            .run(&["checkout", "-q", "-B", branch, main])?
            .status
            .success())
    }

    /// Give the work tree `source`'s version of `paths` (only the work tree:
    /// the index keeps HEAD's version, so they show as local edits). Paths
    /// `source` lacks are removed first, except one that is a parent of a
    /// path `source` has, which restoring that path replaces. A path is
    /// never written over a file or a non-empty directory that is not
    /// itself one of `paths`: that is someone's work, and it stays.
    fn write_worktree_versions(&self, source: &str, paths: &[String]) -> Result<()> {
        let entries = self.git.tree_entries(source, paths)?;
        let (present, absent): (Vec<String>, Vec<String>) = paths
            .iter()
            .cloned()
            .partition(|path| entries.contains_key(path));
        let root = self.git.root();
        let workspace = WorkspaceDir::open(root)?;
        for path in &absent {
            if present
                .iter()
                .any(|kept| kept.starts_with(&format!("{path}/")))
            {
                continue;
            }
            if std::fs::symlink_metadata(root.join(path)).is_err() {
                continue;
            }
            match workspace.remove(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let mut writable = Vec::new();
        'paths: for path in present {
            let mut ancestor = path.as_str();
            while let Some((parent, _)) = ancestor.rsplit_once('/') {
                ancestor = parent;
                let in_the_way = std::fs::symlink_metadata(root.join(parent))
                    .is_ok_and(|metadata| !metadata.is_dir());
                if in_the_way && !paths.iter().any(|listed| listed == parent) {
                    warn!(%path, "a file in the way holds other work; kept it");
                    continue 'paths;
                }
            }
            if let Ok(metadata) = std::fs::symlink_metadata(root.join(&path)) {
                if metadata.is_dir() {
                    let empty = std::fs::read_dir(root.join(&path))
                        .map(|mut entries| entries.next().is_none())
                        .unwrap_or(false);
                    if !empty {
                        warn!(%path, "a folder in the way holds other work; kept it");
                        continue;
                    }
                }
            }
            writable.push(path);
        }
        if !writable.is_empty() {
            let list = nul_list(&writable);
            let source = format!("--source={source}");
            self.git.ok_opts(
                &[
                    "restore",
                    &source,
                    "--worktree",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &RunOpts {
                    stdin: Some(&list),
                    literal_pathspecs: true,
                    ..RunOpts::default()
                },
            )?;
        }
        Ok(())
    }

    /// Move the branch from `from` to `to`. Files without unsaved edits
    /// follow `to`; a file with an unsaved edit keeps it, and shows as a
    /// local change against `to`. Nothing anyone typed is lost.
    fn move_keeping_edits(&self, from: &str, to: &str) -> Result<()> {
        if self.move_checkout(from, to)? {
            return Ok(());
        }
        if self.git.commit_id("HEAD")?.as_deref() != Some(from) {
            bail!("the local branch moved during the update");
        }
        let changed = changed_paths(&self.git, from, to)?;
        let worktree = stale_align::worktree_entries(&self.git, from, &changed)?;
        let current = self.git.tree_entries(from, &changed)?;
        let untouched: Vec<String> = changed
            .iter()
            .filter(|path| match (worktree.get(*path), current.get(*path)) {
                (Some(a), Some(b)) => a.mode == b.mode && a.oid == b.oid,
                (None, None) => true,
                _ => false,
            })
            .cloned()
            .collect();
        self.git.update_ref(
            "HEAD",
            to,
            Some(from),
            "instafy: move the branch, keeping unsaved edits",
        )?;
        self.reset_index_paths(&changed)?;
        self.write_worktree_versions(to, &untouched)
    }

    // ------------------------------------------------------------------
    // Flush
    // ------------------------------------------------------------------

    fn flush(&mut self, turn_active: bool) -> Result<FlushReport> {
        let mut flush = FlushReport::default();
        // 1. Store everything locally, before any network call.
        let repair = stale_align::repair_once(&self.git, self.config)?;
        if let Some(parked) = repair.parked {
            flush.recovery_refs.push(parked);
        }
        let parked = self.park_for_stop(turn_active, &mut flush)?;

        // 2. Best effort, with write access: notice dismissed work, publish
        // finished commits, push what is parked. A failure here leaves the
        // work on the local refs stored above. A dismissal this stop could not
        // apply keeps the finished commits unpublished: they may carry the
        // dismissed work, and the next publish applies the dismissal first.
        let mut dismissals_applied = true;
        if self.can_write && Instant::now() < self.deadline {
            match self.fetch(true) {
                Ok(_) => {
                    self.fetched = true;
                    match self.retire_dismissed() {
                        Ok(true) if !turn_active => {
                            // Dismissed commits left the branch: park again
                            // from the branch as it is now, then drop the
                            // copies made from the old one.
                            let fresh = self.park_for_stop(false, &mut flush)?;
                            let stale: Vec<RecoveryRefReport> = parked
                                .into_iter()
                                .filter(|entry| {
                                    entry.created
                                        && !fresh.iter().any(|kept| kept.name == entry.name)
                                })
                                .collect();
                            self.unpark(&stale, &mut flush)?;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            dismissals_applied = false;
                            warn!(error = %format!("{error:#}"), "could not apply dismissed recovery work; this stop publishes nothing");
                        }
                    }
                }
                Err(error) => {
                    warn!(error = %format!("{error:#}"), "a stop could not reach canonical; keeping its work locally");
                }
            }
        }
        if self.can_write
            && self.fetched
            && dismissals_applied
            && !turn_active
            && Instant::now() < self.deadline
        {
            if let Some(head) = self.git.commit_id("HEAD")? {
                let main = self.tracked_main()?;
                if !self.is_published(&head, main.as_deref())? {
                    // The publish reports only on itself, not on what the
                    // local step above left out of the parked copies.
                    self.report = PublishReport {
                        local_rev: Some(head.clone()),
                        ..PublishReport::default()
                    };
                    match self.publish_local(Some(head)) {
                        Ok(()) => {
                            self.finish()?;
                            flush.publish = Some(self.report.clone());
                        }
                        Err(error) => {
                            warn!(error = %format!("{error:#}"), "a stop could not publish finished commits; they stay parked");
                            flush.publish_error = Some(format!("{error:#}"));
                        }
                    }
                }
            }
        }
        if self.can_write && self.fetched {
            for (name, canonical) in self.push_parked() {
                if let Some(entry) = flush
                    .recovery_refs
                    .iter_mut()
                    .find(|entry| entry.name == name)
                {
                    entry.reference = canonical;
                    entry.pushed = true;
                }
            }
        }

        // Copies that replaced parked work built on dismissed work (under a
        // new name, or the same one when only the parent changed).
        for stored in std::mem::take(&mut self.separated) {
            match flush
                .recovery_refs
                .iter_mut()
                .find(|entry| entry.name == stored.name)
            {
                Some(entry) => *entry = stored,
                None => flush.recovery_refs.push(stored),
            }
        }
        // Report each parked copy as it ends up: pushed (by this call or by
        // the publish above), still local, or retired because its commits
        // reached `main` or it was dismissed (then it is not kept anywhere
        // and not reported).
        let pending = recovery::pending(&self.git)?;
        let dismissed: BTreeSet<String> = self
            .git
            .refs_under(recovery::LOCAL_RECOVERY_DISMISSED_ROOT)?
            .into_iter()
            .filter_map(|(reference, _)| {
                reference
                    .strip_prefix(&format!("{}/", recovery::LOCAL_RECOVERY_DISMISSED_ROOT))
                    .map(str::to_string)
            })
            .collect();
        flush
            .recovery_refs
            .retain(|entry| !dismissed.contains(&entry.name));
        let pushed: BTreeMap<String, String> = self
            .git
            .refs_under(recovery::LOCAL_RECOVERY_PUSHED_ROOT)?
            .into_iter()
            .filter_map(|(reference, rev)| {
                let name = reference
                    .strip_prefix(&format!("{}/", recovery::LOCAL_RECOVERY_PUSHED_ROOT))?
                    .to_string();
                Some((name, rev))
            })
            .collect();
        for entry in &mut flush.recovery_refs {
            if entry.pushed {
                continue;
            }
            if let Some(rev) = pushed.get(&entry.name) {
                let origin = recovery::origin_of(&self.git, rev, self.config.origin_id);
                entry.reference = recovery::canonical_ref(origin, &entry.name);
                entry.pushed = true;
            }
        }
        flush
            .recovery_refs
            .retain(|entry| entry.pushed || pending.iter().any(|(name, _)| name == &entry.name));
        flush.unpushed_refs = pending.len();
        flush.unpushed_ref_names = pending.into_iter().map(|(name, _)| name).collect();
        Ok(flush)
    }

    /// Store what a stop must keep, without any network call. With a turn
    /// active, its local commits and every unsaved edit go to one `unsaved`
    /// recovery commit and leave the branch, so no later publish sends them.
    /// Otherwise finished local commits are kept on an `unpublished` ref (a
    /// publish that lands retires it) and unsaved edits on an `unsaved` one.
    /// Returns every ref this call stored or found already stored.
    fn park_for_stop(
        &mut self,
        turn_active: bool,
        flush: &mut FlushReport,
    ) -> Result<Vec<RecoveryRefReport>> {
        let mut created = Vec::new();
        let mut keep = |stored: Option<RecoveryRefReport>, flush: &mut FlushReport| {
            if let Some(stored) = stored {
                created.push(stored.clone());
                if !flush
                    .recovery_refs
                    .iter()
                    .any(|entry| entry.name == stored.name)
                {
                    flush.recovery_refs.push(stored);
                }
            }
        };
        let main = self.tracked_main()?;
        let head = self.git.commit_id("HEAD")?;
        let unpublished = match head.as_deref() {
            Some(head) => !self.is_published(head, main.as_deref())?,
            None => false,
        };

        if turn_active && unpublished {
            let head = head.clone().expect("unpublished commits need a HEAD");
            let base = match main.as_deref() {
                Some(main) => self.git.merge_base(&head, main)?,
                None => None,
            };
            let parent = base.clone().or_else(|| main.clone());
            let dirty_tree = self.stage(&Selection::AllDirty, Some(&head))?;
            self.scan_history(&head, main.as_deref())?;
            let frozen: Vec<String> = self.filtered.keys().cloned().collect();
            let tree = match (base.as_deref(), main.as_deref()) {
                (None, Some(main)) => self.unrelated_tree(main, &head, &dirty_tree)?,
                _ => tree_with_entries_from(&self.git, &dirty_tree, parent.as_deref(), &frozen)?,
            };
            let commits = match main.as_deref() {
                Some(main) => self.local_commits(&head, main)?,
                None => Vec::new(),
            };
            flush.parked_commits = commits.len();
            let paths = match parent.as_deref() {
                Some(parent) => changed_paths(&self.git, parent, &tree)?,
                None => changed_paths(&self.git, &self.git.empty_tree()?, &tree)?,
            };
            let stored = recovery::store(
                &self.git,
                RecoverySpec {
                    kind: RecoveryKind::Unsaved,
                    tree,
                    parent: parent.clone(),
                    source: Some(head.clone()),
                    date: None,
                    paths: paths.into_iter().take(MAX_TRAILER_PATHS).collect(),
                    commits,
                    identity: self.identity.clone(),
                    origin_id: self.config.origin_id,
                },
            )?;
            keep(stored, flush);
            match (base, main.as_deref()) {
                (Some(base), _) => {
                    // Keep the files; only the branch steps back.
                    let changed = changed_paths(&self.git, &base, &head)?;
                    self.git.update_ref(
                        "HEAD",
                        &base,
                        Some(&head),
                        "instafy: set aside an unfinished turn",
                    )?;
                    self.reset_index_paths(&changed)?;
                }
                (None, Some(_)) => {
                    // Unrelated to main: mark the commits as handled.
                    self.git
                        .ok(&["update-ref", PUBLISHED_FRONTIER_REF, &head])?;
                }
                (None, None) => {
                    let branch = format!("refs/heads/{}", self.config.git_branch);
                    self.git.delete_ref(&branch, &head)?;
                }
            }
            return Ok(created);
        }

        let mut head = head;
        if unpublished {
            let local = head.clone().expect("unpublished commits need a HEAD");
            // Never-published commits lose what may not be published first,
            // so neither copy below can carry it.
            let local = self.sanitize(&local, main.as_deref())?;
            let stored = self.store_unpublished(&local, main.as_deref())?;
            keep(stored, flush);
            head = self.git.commit_id("HEAD")?;
        }
        let dirty_tree = self.stage(&Selection::AllDirty, head.as_deref())?;
        let head_tree = match head.as_deref() {
            Some(head) => self.git.tree_id(head)?,
            None => self.git.empty_tree()?,
        };
        if dirty_tree != head_tree {
            let paths = changed_paths(&self.git, &head_tree, &dirty_tree)?;
            let stored = recovery::store(
                &self.git,
                RecoverySpec {
                    kind: RecoveryKind::Unsaved,
                    tree: dirty_tree,
                    parent: head.clone(),
                    source: None,
                    date: None,
                    paths: paths.into_iter().take(MAX_TRAILER_PATHS).collect(),
                    commits: Vec::new(),
                    identity: self.identity.clone(),
                    origin_id: self.config.origin_id,
                },
            )?;
            keep(stored, flush);
        }
        Ok(created)
    }

    /// Delete never-pushed refs `park_for_stop` created that no longer match
    /// the branch.
    fn unpark(&self, parked: &[RecoveryRefReport], flush: &mut FlushReport) -> Result<()> {
        for entry in parked {
            let reference = format!("{}/{}", recovery::LOCAL_RECOVERY_ROOT, entry.name);
            if self.git.commit_id(&reference)?.as_deref() == Some(entry.rev.as_str()) {
                self.git.delete_ref(&reference, &entry.rev)?;
            }
            flush.recovery_refs.retain(|kept| kept.name != entry.name);
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Revert
    // ------------------------------------------------------------------

    fn revert(
        &mut self,
        commit: &str,
        base: Option<&str>,
        author: Option<GitIdentity>,
    ) -> Result<(), OriginError> {
        let commit = commit.trim();
        if commit.len() < 7 || commit.len() > 64 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(OriginError::bad_request("invalid commit id"));
        }
        let commit = self
            .git
            .commit_id(commit)
            .map_err(internal)?
            .ok_or_else(|| OriginError::not_found("commit not found"))?;
        let parents: Vec<String> = self
            .git
            .stdout(&["rev-list", "--parents", "-n", "1", &commit])
            .map_err(internal)?
            .split(' ')
            .skip(1)
            .map(str::to_string)
            .collect();
        let base = match base.map(str::trim).filter(|value| !value.is_empty()) {
            Some(base) => {
                if !base.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(OriginError::bad_request("invalid base commit id"));
                }
                let base = self
                    .git
                    .commit_id(base)
                    .map_err(internal)?
                    .ok_or_else(|| OriginError::not_found("base commit not found"))?;
                if !self.git.is_ancestor(&base, &commit).map_err(internal)? {
                    return Err(OriginError::bad_request(
                        "base must be an ancestor of the reverted commit",
                    ));
                }
                base
            }
            None => match parents.as_slice() {
                [parent] => parent.clone(),
                _ => {
                    return Err(OriginError::bad_request(
                        "a merge or first commit needs a base to revert against",
                    ))
                }
            },
        };

        self.prepare().map_err(internal)?;
        let head = self
            .git
            .commit_id("HEAD")
            .map_err(internal)?
            .ok_or_else(|| OriginError::conflict("the workspace has no saved version yet"))?;

        let inverse = three_way(&self.git, Some(&commit), &head, &base).map_err(internal)?;
        if !inverse.conflicts.is_empty() {
            return Err(OriginError::conflict_paths(
                "revert_conflict",
                "later changes touch the same lines; this version cannot be reverted automatically",
                inverse.conflicts,
            ));
        }
        let head_tree = self.git.tree_id(&head).map_err(internal)?;
        let mut local = Some(head.clone());
        if inverse.tree != head_tree {
            let touched = changed_paths(&self.git, &head_tree, &inverse.tree).map_err(internal)?;
            let dirty: Vec<String> = self
                .status()
                .map_err(internal)?
                .into_iter()
                .map(|(path, _)| path)
                .filter(|path| {
                    touched.iter().any(|touched| {
                        touched == path
                            || touched.starts_with(&format!("{path}/"))
                            || path.starts_with(&format!("{touched}/"))
                    })
                })
                .collect();
            if !dirty.is_empty() {
                return Err(OriginError::conflict_paths(
                    "dirty_paths",
                    "unsaved edits touch files this revert changes",
                    dirty,
                ));
            }
            // Apply the inverse to the index and the files it touches only.
            self.git
                .ok(&["read-tree", "-m", "-u", &head, &inverse.tree])
                .map_err(internal)?;
            let subject = self
                .git
                .stdout(&["log", "-1", "--format=%s", &commit])
                .map_err(internal)?;
            let message = format!("Revert \"{subject}\"\n\nThis reverts commit {commit}.\n");
            let author = author.unwrap_or_else(|| self.identity.clone());
            let reverted = self
                .git
                .commit_tree(
                    &inverse.tree,
                    &[&head],
                    &author,
                    &self.identity,
                    message.as_bytes(),
                )
                .map_err(internal)?;
            self.git
                .update_ref("HEAD", &reverted, Some(&head), "instafy: revert")
                .map_err(internal)?;
            local = Some(reverted);
        }
        self.report.local_rev = local.clone();
        self.publish_local(local).map_err(internal)?;
        self.finish().map_err(internal)?;
        Ok(())
    }
}

impl Publisher<'_> {
    /// Restore the work a recovery or salvage ref keeps (Q) onto `HEAD`,
    /// the way a revert applies its inverse: everything checked first, then
    /// the index and only the files the restore changes, one commit, one
    /// publish.
    ///
    /// - The ref is read from the remote by exactly its name; `rev`, when
    ///   given, must still be its tip.
    /// - `T = three_way(merge-base(Q, HEAD), HEAD, Q)`. Paths Q changes that
    ///   are kept on request, reserved, never publishable (excluded, secret,
    ///   legacy attachments, unsupported, too large) or ignored here keep
    ///   `HEAD`'s entry and are reported as not restored.
    /// - A conflict is settled when the work brings nothing in at or below
    ///   it any more (kept on request, below a path left out, or with every
    ///   change inside it left out); any other conflict is 409
    ///   `restore_conflict {head, paths}`. An unsaved edit of a path the
    ///   restore changes is 409 `dirty_paths`.
    /// - The commit (`Restore unsaved work`, with an
    ///   `Instafy-Restored-From: <ref>` trailer) is authored by `author`
    ///   and committed by the origin, then published.
    /// - Once the work is on `main`, a recovery ref is deleted under a
    ///   lease on its tip, so the same work is not restored twice, but only
    ///   when every path left out was kept on request: a path refused here
    ///   keeps the ref, so work the person did not choose to leave out is
    ///   never removed. Salvage refs are kept.
    fn restore(
        &mut self,
        request: RestoreRequest,
    ) -> Result<(bool, Vec<String>, bool), OriginError> {
        let reference = RecoveryRef::validate(&self.git, request.reference.trim())?;
        let expected = match request.rev.as_deref().map(str::trim) {
            Some(rev) if !rev.is_empty() => Some(parse_rev(rev)?),
            _ => None,
        };
        if request.keep.len() > MAX_RESTORE_KEEP_PATHS {
            return Err(OriginError::bad_request(format!(
                "a restore keeps at most {MAX_RESTORE_KEEP_PATHS} paths"
            )));
        }
        let mut keep = PathRoots::default();
        for path in &request.keep {
            let normalized = normalize_relative_path(path)
                .ok_or_else(|| OriginError::bad_request("invalid keep path"))?;
            keep.insert(normalized);
        }

        self.prepare().map_err(internal)?;
        if !self.fetched {
            return Err(OriginError::with_report(
                axum::http::StatusCode::BAD_GATEWAY,
                "canonical_unreachable",
                self.report
                    .failure
                    .clone()
                    .unwrap_or_else(|| "could not reach the saved history".to_string()),
                serde_json::json!({ "retryable": true }),
            ));
        }
        let remote = self.remote.clone();
        let fetched = match resolve_ref(&self.git, &remote, &reference) {
            Ok(fetched) => fetched,
            Err(ViewError::RefNotFound) if expected.is_some() => {
                return Err(recovery_ref_moved(None))
            }
            Err(error) => return Err(error.into()),
        };
        if expected.as_deref().is_some_and(|rev| rev != fetched.tip) {
            return Err(recovery_ref_moved(Some(&fetched.tip)));
        }
        let head = self
            .git
            .commit_id("HEAD")
            .map_err(internal)?
            .ok_or_else(|| OriginError::conflict("the workspace has no saved version yet"))?;
        let head_tree = self.git.tree_id(&head).map_err(internal)?;
        let saved = fetched.commit.clone();
        let base = self.git.merge_base(&saved, &head).map_err(internal)?;
        let base_tree = match base.as_deref() {
            Some(base) => self.git.tree_id(base).map_err(internal)?,
            None => self.git.empty_tree().map_err(internal)?,
        };
        let merged = three_way(&self.git, base.as_deref(), &head, &saved).map_err(internal)?;

        // What the work changes, and which of it may not come back here.
        let saved_tree = self.git.tree_id(&saved).map_err(internal)?;
        let raw = self
            .git
            .bytes(&[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--raw",
                &base_tree,
                &saved_tree,
            ])
            .map_err(internal)?;
        let changes = parse_raw_changes(&raw);
        let sizes = self.blob_sizes(&changes).map_err(internal)?;
        let written: Vec<String> = changes
            .iter()
            .filter(|change| change.status != 'D')
            .map(|change| change.path.clone())
            .collect();
        let ignored: BTreeSet<String> = self
            .ignored(&written)
            .map_err(internal)?
            .into_iter()
            .collect();
        // Refused because it can never come back here, or left out on
        // request (`keep`). Only the person's own choices let the ref go,
        // so refusal is decided first: a secret or ignored file below a
        // kept folder (which no conflict showed them) is refused, not kept.
        let mut not_restored = Vec::new();
        let mut refused = Vec::new();
        for change in &changes {
            if crate::paths::is_reserved_path(&change.path)
                || self.policy_reason(change, &sizes).is_some()
                || ignored.contains(&change.path)
            {
                not_restored.push(change.path.clone());
                refused.push(change.path.clone());
            } else if keep.covers(&change.path) {
                not_restored.push(change.path.clone());
            }
        }
        // A conflict (which keeps `HEAD`'s entry) is settled when the work
        // brings nothing in at or below it any more: it was kept on request
        // (itself or a folder above it), it lies below a path left out, or
        // every change the work makes inside it was left out, as when the
        // work adds a folder where `HEAD` has a file.
        let left_out: PathRoots = not_restored.iter().cloned().collect();
        let changed: PathRoots = changes.iter().map(|change| change.path.clone()).collect();
        let conflicts: Vec<String> = merged
            .conflicts
            .iter()
            .filter(|path| {
                if left_out.covers(path) || keep.covers(path) {
                    return false;
                }
                let mut inside = changed.at_or_below(path).peekable();
                let any_inside = inside.peek().is_some();
                !(any_inside && inside.all(|path| left_out.contains(path)))
            })
            .cloned()
            .collect();
        if !conflicts.is_empty() {
            return Err(OriginError::with_report(
                axum::http::StatusCode::CONFLICT,
                "restore_conflict",
                "the saved version changed the same files since; choose a version per file",
                serde_json::json!({ "head": head, "paths": conflicts }),
            ));
        }
        let tree = tree_with_entries_from(&self.git, &merged.tree, Some(&head), &not_restored)
            .map_err(internal)?;

        let mut local = head.clone();
        let made = tree != head_tree;
        // With nothing new to commit, an earlier restore of this ref whose
        // publish did not reach `main` may still be on the branch: this
        // call publishes it, so it is this call's new version.
        let committed = made
            || self
                .unpublished_restore(&head, reference.as_str())
                .map_err(internal)?
                .is_some();
        if made {
            let touched = changed_paths(&self.git, &head_tree, &tree).map_err(internal)?;
            let dirty: Vec<String> = self
                .status()
                .map_err(internal)?
                .into_iter()
                .map(|(path, _)| path)
                .filter(|path| {
                    touched.iter().any(|touched| {
                        touched == path
                            || touched.starts_with(&format!("{path}/"))
                            || path.starts_with(&format!("{touched}/"))
                    })
                })
                .collect();
            if !dirty.is_empty() {
                return Err(OriginError::conflict_paths(
                    "dirty_paths",
                    "unsaved edits touch files this restore changes",
                    dirty,
                ));
            }
            self.git
                .ok(&["read-tree", "-m", "-u", &head, &tree])
                .map_err(internal)?;
            let message = restore_commit_message(reference.as_str());
            let author = request.author.unwrap_or_else(|| self.identity.clone());
            let restored = self
                .git
                .commit_tree(&tree, &[&head], &author, &self.identity, message.as_bytes())
                .map_err(internal)?;
            self.git
                .update_ref(
                    "HEAD",
                    &restored,
                    Some(&head),
                    "instafy: restore unsaved work",
                )
                .map_err(internal)?;
            local = restored;
        }
        self.report.local_rev = Some(local.clone());
        self.publish_local(Some(local.clone())).map_err(internal)?;
        self.finish().map_err(internal)?;

        let landed = matches!(
            self.report.git_sync_status,
            SyncStatus::Published | SyncStatus::Unchanged
        ) && self
            .is_published(&local, self.report.rev.as_deref())
            .map_err(internal)?;
        let mut ref_deleted = false;
        if landed && !refused.is_empty() && !reference.is_salvage() {
            info!(
                reference = reference.as_str(),
                refused = refused.len(),
                "kept the restored work's ref: part of it cannot be restored here"
            );
        }
        if landed && refused.is_empty() && !reference.is_salvage() && self.can_write {
            match delete_with_lease(&self.git, &remote, reference.as_str(), &fetched.tip) {
                Ok(result) if result.class == PushClass::Pushed => ref_deleted = true,
                Ok(result) => {
                    warn!(reference = reference.as_str(), class = ?result.class, "restored work's ref was not removed")
                }
                Err(error) => {
                    warn!(reference = reference.as_str(), error = %format!("{error:#}"), "restored work's ref was not removed")
                }
            }
        }
        not_restored.sort();
        not_restored.dedup();
        Ok((committed, not_restored, ref_deleted))
    }

    /// A restore commit of `reference` that this origin committed on
    /// `head`'s history and canonical `main` (as last fetched) does not
    /// have yet, if any.
    fn unpublished_restore(&self, head: &str, reference: &str) -> Result<Option<String>> {
        let grep = format!("--grep={RESTORED_FROM_TRAILER}: {reference}");
        let mut args = vec![
            "rev-list".to_string(),
            "--fixed-strings".to_string(),
            grep,
            "--end-of-options".to_string(),
            head.to_string(),
        ];
        if let Some(main) = self.tracked_main()? {
            args.push(format!("^{main}"));
        }
        if let Some(frontier) = self.git.commit_id(PUBLISHED_FRONTIER_REF)? {
            args.push(format!("^{frontier}"));
        }
        args.push("--".to_string());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let ids: Vec<String> = self
            .git
            .stdout(&args)?
            .lines()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect();
        Ok(
            restore_commits(&self.git, &ids, &self.config.git_author_email)?
                .into_iter()
                .find(|(_, restored)| restored == reference)
                .map(|(id, _)| id),
        )
    }
}

/// Paths and folders, each matched by itself and by every path below it,
/// in time that grows with a path's depth, not with the number of entries.
#[derive(Default)]
struct PathRoots(BTreeSet<String>);

impl PathRoots {
    fn insert(&mut self, path: String) {
        self.0.insert(path);
    }

    fn contains(&self, path: &str) -> bool {
        self.0.contains(path)
    }

    /// `path` is an entry or lies below one.
    fn covers(&self, path: &str) -> bool {
        self.contains(path)
            || path
                .match_indices('/')
                .any(|(index, _)| self.contains(&path[..index]))
    }

    /// The entries that are `folder` or lie below it.
    fn at_or_below<'s>(&'s self, folder: &'s str) -> impl Iterator<Item = &'s str> + 's {
        self.0
            .range::<str, _>((
                std::ops::Bound::Included(folder),
                std::ops::Bound::Unbounded,
            ))
            .map(String::as_str)
            .take_while(move |path| path.starts_with(folder))
            .filter(move |path| path.len() == folder.len() || path[folder.len()..].starts_with('/'))
    }
}

impl FromIterator<String> for PathRoots {
    fn from_iter<I: IntoIterator<Item = String>>(paths: I) -> Self {
        Self(paths.into_iter().collect())
    }
}

fn jitter(attempt: usize) {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default();
    let spread = 50 + u64::from(nanos % 350);
    std::thread::sleep(Duration::from_millis(
        spread.min(400) * attempt.min(2) as u64,
    ));
}

fn merge_message(config: &ServerConfig, commits: usize, conflicts: &[String]) -> String {
    let mut message = String::from("Save changes from a workspace\n\n");
    message.push_str(&format!(
        "Adds {commits} commit{} made in a workspace to the saved version.\n",
        if commits == 1 { "" } else { "s" }
    ));
    if !conflicts.is_empty() {
        message.push_str(
            "Some files were also changed in the saved version, which kept its own copy.\n",
        );
    }
    message.push_str(&format!(
        "\nInstafy-Origin: {}\n",
        config.origin_id.as_hyphenated()
    ));
    for path in conflicts.iter().take(MAX_TRAILER_PATHS) {
        message.push_str(&format!(
            "{}: {}\n",
            recovery::CONFLICT_TRAILER,
            path.replace(['\n', '\r'], " ")
        ));
    }
    message
}

fn parse_ident(value: &str) -> Option<GitIdentity> {
    let open = value.rfind('<')?;
    let close = value.rfind('>')?;
    if close < open {
        return None;
    }
    let name = value[..open].trim_end().to_string();
    let email = value[open + 1..close].to_string();
    let date = value[close + 1..].trim();
    Some(GitIdentity {
        name,
        email,
        date: (!date.is_empty()).then(|| date.to_string()),
    })
}

/// One `--raw` diff entry.
#[derive(Clone, Debug)]
pub(crate) struct RawChange {
    pub new_mode: String,
    pub new_oid: String,
    pub status: char,
    pub path: String,
}

pub(crate) fn parse_raw_changes(raw: &[u8]) -> Vec<RawChange> {
    let mut changes = Vec::new();
    let mut records = raw.split(|byte| *byte == 0).filter(|r| !r.is_empty());
    while let Some(meta) = records.next() {
        let meta = String::from_utf8_lossy(meta);
        let Some(meta) = meta.strip_prefix(':') else {
            continue;
        };
        let Some(path) = records.next() else { break };
        let fields: Vec<&str> = meta.split(' ').collect();
        if fields.len() < 5 {
            continue;
        }
        changes.push(RawChange {
            new_mode: fields[1].to_string(),
            new_oid: fields[3].to_string(),
            status: fields[4].chars().next().unwrap_or('M'),
            path: String::from_utf8_lossy(path).to_string(),
        });
    }
    changes
}

/// Parse `diff-tree --stdin -z --raw` output: a commit id record, then its
/// changes (repeated per parent with `-m`).
pub(crate) fn parse_stdin_diff_tree(raw: &[u8]) -> BTreeMap<String, Vec<RawChange>> {
    let mut out: BTreeMap<String, Vec<RawChange>> = BTreeMap::new();
    let mut current: Option<String> = None;
    let mut records = raw.split(|byte| *byte == 0).filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        let text = String::from_utf8_lossy(record);
        if let Some(meta) = text.strip_prefix(':') {
            let Some(path) = records.next() else { break };
            let fields: Vec<&str> = meta.split(' ').collect();
            if fields.len() < 5 {
                continue;
            }
            if let Some(commit) = &current {
                out.entry(commit.clone()).or_default().push(RawChange {
                    new_mode: fields[1].to_string(),
                    new_oid: fields[3].to_string(),
                    status: fields[4].chars().next().unwrap_or('M'),
                    path: String::from_utf8_lossy(path).to_string(),
                });
            }
        } else {
            let id = text
                .split(' ')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                current = Some(id);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::PathRoots;

    #[test]
    fn path_roots_match_a_path_and_what_lies_below_it() {
        let roots: PathRoots = ["docs", "src/lib.rs", "a/b"]
            .into_iter()
            .map(str::to_string)
            .collect();
        for path in ["docs", "docs/a.md", "docs/x/y.md", "src/lib.rs", "a/b/c"] {
            assert!(roots.covers(path), "{path}");
        }
        for path in ["docs2", "docs.md", "src", "src/lib.rs.bak", "a", "a/bc"] {
            assert!(!roots.covers(path), "{path}");
        }
        let changed: PathRoots = [
            "docs",
            "docs.md",
            "docs/a.md",
            "docs/z/b.md",
            "docs2/c.md",
            "doc",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(
            changed.at_or_below("docs").collect::<Vec<_>>(),
            vec!["docs", "docs/a.md", "docs/z/b.md"]
        );
        assert_eq!(changed.at_or_below("missing").count(), 0);
    }
}
