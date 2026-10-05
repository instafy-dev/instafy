//! Restoring unsaved work: the commit a recovery or salvage ref names
//! (`Q`) merged onto `main` (`E`) against their merge base (the empty tree
//! when they share no history), as one change on canonical `main`.
//!
//! Each attempt builds `T = three_way(merge-base(Q, E), E, Q)` and then
//! leaves some of what `Q` changes as `E` has it, reporting each such path
//! in `notRestored` with why:
//!
//! - `kept`: the person chose to keep the saved version (`keep`; a path
//!   also covers everything below it);
//! - `excluded`, `secret`, `attachment`: a path that may never be saved
//!   (build output and dependencies, Instafy metadata, credentials, legacy
//!   chat uploads), as for an upload; a delete follows the same rule as an
//!   upload's;
//! - `too_large`: a file over the size a save may hold;
//! - `ignored`: a new file the restored tree's `.gitignore` files ignore;
//! - a reason from the shard, for a path it refused on an earlier attempt.
//!
//! What both sides changed differently is a conflict: 409
//! `restore_conflict` with the paths, unless the path is kept or could
//! never be saved anyway. With a `baseRev` other than `main`, every path
//! the restore changes must be as it was at `baseRev` (409 `head_moved`),
//! as for an upload.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use super::answers::{head_moved, hook_refusal, internal, reason_name, restore_conflict};
use super::change::{check_ignored, entries_at, gitignores_for, is_regular, moved_since};
use super::read::readable;
use crate::error::OriginError;
use crate::publish::parse_raw_changes;
use crate::publish_policy::{
    deletion_allowed, is_unsafe_path, unpublishable_reason, RejectReason, MAX_PUBLISH_BLOB_BYTES,
};
use crate::tree_merge::{changed_paths, three_way, tree_with_entries_from};
use crate::workspace_git::WorkspaceGit;

/// The reason given for a path the person chose to keep as it is.
pub(crate) const KEPT: &str = "kept";

/// A path a restore left as `main` has it, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct NotRestored {
    pub path: String,
    pub reason: &'static str,
}

/// Unsaved work merged onto `main`.
pub(crate) struct Restore {
    /// The commit the ref names, already in the mirror.
    commit: String,
    /// Paths (and everything below them) that keep `main`'s version.
    keep: Vec<String>,
    /// The `main` the person last saw.
    base_rev: Option<String>,
    /// Paths the shard refused on an earlier attempt.
    shard_refused: BTreeMap<String, RejectReason>,
    /// The last attempt's paths left as `main` has them, with why.
    withheld: BTreeMap<String, &'static str>,
    /// The last attempt's changes to `main`.
    touched: Option<Vec<String>>,
}

impl Restore {
    pub(crate) fn new(commit: String, keep: Vec<String>, base_rev: Option<String>) -> Self {
        Self {
            commit,
            keep,
            base_rev,
            shard_refused: BTreeMap::new(),
            withheld: BTreeMap::new(),
            touched: None,
        }
    }

    /// What the last attempt left as `main` has it, by path.
    pub(crate) fn not_restored(&self) -> Vec<NotRestored> {
        self.withheld
            .iter()
            .map(|(path, reason)| NotRestored {
                path: path.clone(),
                reason,
            })
            .collect()
    }

    /// Whether anything was left out for a reason other than the person's
    /// own choice: then the work is not all on `main`, and its ref stays.
    pub(crate) fn left_out_unsaveable(&self) -> bool {
        self.withheld.values().any(|reason| *reason != KEPT)
    }

    fn kept(&self, path: &str) -> bool {
        self.keep.iter().any(|kept| {
            path == kept
                || path
                    .strip_prefix(kept.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }

    pub(super) fn build(
        &mut self,
        git: &WorkspaceGit<'_>,
        scratch: &Path,
        main: Option<&str>,
    ) -> Result<String, OriginError> {
        let ours = match main {
            Some(main) => main.to_string(),
            None => git.empty_tree().map_err(internal)?,
        };
        let base = match main {
            Some(main) => git.merge_base(&self.commit, main).map_err(internal)?,
            None => None,
        };
        let merged = three_way(git, base.as_deref(), &ours, &self.commit).map_err(internal)?;
        let ours_tree = git.tree_id(&ours).map_err(internal)?;

        let mut withheld: BTreeMap<String, &'static str> = self
            .shard_refused
            .iter()
            .map(|(path, reason)| (path.clone(), reason_name(*reason)))
            .collect();

        // Conflicts keep `main`'s entry already; only real ones stop the
        // restore.
        let mut conflicts = Vec::new();
        for path in &merged.conflicts {
            if self.kept(path) {
                withheld.insert(path.clone(), KEPT);
            } else if let Some(reason) = never_saved(path) {
                withheld.insert(path.clone(), reason_name(reason));
            } else {
                conflicts.push(path.clone());
            }
        }
        if !conflicts.is_empty() {
            return Err(restore_conflict(main, conflicts));
        }

        // What the merge changes on `main`, and what of it stays as `main`
        // has it.
        let raw = git
            .bytes(&[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--raw",
                &ours_tree,
                &merged.tree,
            ])
            .map_err(internal)?;
        let changes = parse_raw_changes(&raw);
        let written: Vec<String> = changes
            .iter()
            .filter(|change| change.status != 'D' && is_regular(&change.new_mode))
            .map(|change| change.new_oid.clone())
            .collect();
        let sizes: BTreeMap<String, u64> = git
            .object_sizes(&written)
            .map_err(internal)?
            .into_iter()
            .zip(&written)
            .filter_map(|(size, oid)| size.map(|(_, size)| (oid.clone(), size)))
            .collect();
        let mut reset = Vec::new();
        let mut added = Vec::new();
        for change in &changes {
            let path = &change.path;
            let reason = if withheld.contains_key(path) {
                None
            } else if self.kept(path) {
                Some(KEPT)
            } else if change.status == 'D' {
                (!deletion_allowed(path)).then(|| reason_name(RejectReason::Excluded))
            } else if let Some(reason) = never_saved(path) {
                Some(reason_name(reason))
            } else if sizes
                .get(&change.new_oid)
                .is_some_and(|size| *size > MAX_PUBLISH_BLOB_BYTES)
            {
                Some(reason_name(RejectReason::TooLarge))
            } else {
                if change.status == 'A' {
                    added.push(path.clone());
                }
                None
            };
            if let Some(reason) = reason {
                withheld.insert(path.clone(), reason);
            }
            if withheld.contains_key(path) {
                reset.push(path.clone());
            }
        }
        let mut tree = merged.tree;
        if !reset.is_empty() {
            tree = tree_with_entries_from(git, &tree, main, &reset).map_err(internal)?;
        }

        // New files the restored tree's own `.gitignore` files ignore.
        if !added.is_empty() {
            let candidates: BTreeSet<String> =
                added.iter().flat_map(|path| gitignores_for(path)).collect();
            let rules: BTreeMap<String, String> = entries_at(git, &tree, &candidates)?
                .into_iter()
                .filter(|(_, entry)| is_regular(&entry.mode))
                .map(|(path, entry)| (path, entry.oid))
                .collect();
            let ignored = check_ignored(git, scratch, &rules, &added)?;
            if !ignored.is_empty() {
                for path in &ignored {
                    withheld.insert(path.clone(), reason_name(RejectReason::Ignored));
                }
                tree = tree_with_entries_from(git, &tree, main, &ignored).map_err(internal)?;
            }
        }

        self.touched = Some(changed_paths(git, &ours_tree, &tree).map_err(internal)?);
        self.withheld = withheld;
        Ok(tree)
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

/// Why `path` may never be added to or changed on `main`, if so.
fn never_saved(path: &str) -> Option<RejectReason> {
    unpublishable_reason(path).or_else(|| is_unsafe_path(path).then_some(RejectReason::Excluded))
}
