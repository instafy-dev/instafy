//! Restoring unsaved work: the commit a recovery or salvage ref names
//! merged onto `main` against their merge base (the empty tree when they
//! share no history), as one change on canonical `main`.
//!
//! Each attempt decides the restore with [`restore_plan::plan`], the rule
//! Desktop restores by too: which of the work's changes come back, which
//! keep `main`'s entry and why (`notRestored`: refused first, as
//! `excluded`, `secret`, `attachment`, `unsupported`, `too_large`,
//! `ignored` by the restored tree's own `.gitignore` files, or a shard's
//! reason from an earlier attempt; then `kept` on request, a path also
//! covering everything below it; and, for a salvage commit the gateway
//! made, the files its salvage kept privately), which clashes are 409
//! `restore_conflict`, whether the ref may go, and whether an empty restore
//! commit records it. With a `baseRev` other than `main`, every path the
//! restore changes must be as it was at `baseRev` (409 `head_moved`), as
//! for an upload.

use std::collections::BTreeMap;
use std::path::Path;

use super::answers::{head_moved, hook_refusal, internal, or_disk_full, restore_conflict};
use super::change::moved_since;
use super::read::readable;
use crate::error::OriginError;
use crate::publish_policy::RejectReason;
use crate::recovery_view::{restore_committers, NotRestored, RecoveryRef};
use crate::restore_plan::{self, PathRoots, PlanError, RestoreInput};
use crate::tree_merge::changed_paths;
use crate::workspace_git::WorkspaceGit;

/// Unsaved work merged onto `main`.
pub(crate) struct Restore {
    /// The recovery or salvage ref restored.
    reference: RecoveryRef,
    /// The commit the ref names, already in the mirror.
    commit: String,
    /// Paths (and everything below them) that keep `main`'s version.
    keep: PathRoots,
    /// The `main` the person last saw.
    base_rev: Option<String>,
    /// Paths the shard refused on an earlier attempt.
    shard_refused: BTreeMap<String, RejectReason>,
    /// The last attempt's paths left as `main` has them, with why.
    not_restored: Vec<NotRestored>,
    /// The last attempt left out only what the person chose to keep, and
    /// `main` holds all of the work but that ([`restore_plan`]'s rule).
    lets_ref_go: bool,
    /// The last attempt's changes to `main`.
    touched: Option<Vec<String>>,
    /// The committers whose restore commits count: the gateway's own
    /// address and Desktop's.
    committers: Vec<String>,
    /// The gateway's own address: a salvage commit it made lists the files
    /// its salvage kept privately.
    salvage_committer: String,
    /// The last attempt brings nothing new to `main` and records the
    /// restore with an empty restore commit.
    marker: bool,
}

impl Restore {
    pub(crate) fn new(
        reference: RecoveryRef,
        commit: String,
        keep: Vec<String>,
        base_rev: Option<String>,
        committer_email: String,
    ) -> Self {
        Self {
            reference,
            commit,
            keep: keep.into_iter().collect(),
            base_rev,
            shard_refused: BTreeMap::new(),
            not_restored: Vec::new(),
            lets_ref_go: true,
            touched: None,
            committers: restore_committers(&committer_email),
            salvage_committer: committer_email,
            marker: false,
        }
    }

    /// Whether the last attempt records the restore with an empty restore
    /// commit (a salvage ref with nothing left to bring back, which `main`
    /// has no restore commit of yet): such a commit is made even though its
    /// tree is `main`'s.
    pub(crate) fn marker(&self) -> bool {
        self.marker
    }

    /// What the last attempt left as `main` has it, by path.
    pub(crate) fn not_restored(&self) -> Vec<NotRestored> {
        self.not_restored.clone()
    }

    /// Whether anything was left out for a reason other than the person's
    /// own choice, or kept at a new name another file of `main` takes on a
    /// disk ignoring case: then the work is not all on `main`, and its ref
    /// stays.
    pub(crate) fn left_out_unsaveable(&self) -> bool {
        !self.lets_ref_go
    }

    pub(super) fn build(
        &mut self,
        git: &WorkspaceGit<'_>,
        scratch: &Path,
        main: Option<&str>,
    ) -> Result<String, OriginError> {
        let plan = restore_plan::plan(
            git,
            &RestoreInput {
                reference: &self.reference,
                onto: main,
                saved: &self.commit,
                keep: &self.keep,
                refused_before: &self.shard_refused,
                restorers: &self.committers,
                recorded_on: None,
                salvage_committer: &self.salvage_committer,
                scratch,
            },
        )
        .map_err(|error| match error {
            PlanError::Conflict(paths) => restore_conflict(main, paths),
            PlanError::Failed(error) => or_disk_full(error),
        })?;
        self.touched = Some(changed_paths(git, &plan.onto_tree, &plan.tree).map_err(internal)?);
        self.lets_ref_go = plan.lets_ref_go();
        self.marker = plan.marker;
        self.not_restored = plan.not_restored;
        Ok(plan.tree)
    }

    /// With a `baseRev` other than `main`: nothing the restore changes may
    /// have changed on `main` since.
    pub(super) fn check(
        &self,
        git: &WorkspaceGit<'_>,
        main: Option<&str>,
    ) -> Result<(), OriginError> {
        let Some(touched) = &self.touched else {
            return Err(internal("a restore was checked before it was built"));
        };
        let Some(base) = self.base_rev.as_deref().filter(|base| Some(*base) != main) else {
            return Ok(());
        };
        if !readable(git, base).map_err(OriginError::from)? {
            return Err(head_moved(main, touched.clone()));
        }
        let moved = moved_since(git, base, main, touched)?;
        if moved.is_empty() {
            Ok(())
        } else {
            Err(head_moved(main, moved.into_iter().collect()))
        }
    }

    /// The shard refused `path`: leave it as `main` has it and try again,
    /// once per path.
    pub(super) fn refused(
        &mut self,
        path: String,
        reason: RejectReason,
    ) -> Result<(), OriginError> {
        if self.shard_refused.contains_key(&path) {
            return Err(hook_refusal(path, reason));
        }
        self.shard_refused.insert(path, reason);
        Ok(())
    }
}
