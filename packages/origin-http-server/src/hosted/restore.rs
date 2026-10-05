//! Restoring unsaved work: the commit a recovery or salvage ref names
//! (`Q`) merged onto `main` (`E`) against their merge base (the empty tree
//! when they share no history), as one change on canonical `main`.
//!
//! Each attempt builds `T = three_way(merge-base(Q, E), E, Q)` and then
//! leaves some of what `Q` changes as `E` has it, reporting each such path
//! in `notRestored` with why:
//!
//! - `excluded`, `secret`, `attachment`, `unsupported`: a path that may
//!   never be saved (build output and dependencies, Instafy metadata,
//!   credentials, legacy chat uploads, unsafe paths and submodules), as for
//!   an upload; a delete follows the same rule as an upload's;
//! - `too_large`: a file over the size a save may hold;
//! - `ignored`: a new file the restored tree's `.gitignore` files ignore;
//! - a reason from the shard, for a path it refused on an earlier attempt;
//! - `kept`: the person chose to keep the saved version (`keep`; a path
//!   also covers everything below it).
//!
//! Refusal comes first, as on Desktop
//! ([`crate::publish_policy::restore_refusal`],
//! [`crate::recovery_view::left_out_reason`]): a secret or ignored file
//! below a kept folder is refused, not kept, so its ref stays.
//!
//! What both sides changed differently is a conflict: 409
//! `restore_conflict` with the paths, unless the path could never be saved
//! anyway or is kept. With a `baseRev` other than `main`, every path
//! the restore changes must be as it was at `baseRev` (409 `head_moved`),
//! as for an upload.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::answers::{head_moved, hook_refusal, internal, restore_conflict};
use super::change::{check_ignored, entries_at, gitignores_for, is_regular, moved_since};
use super::read::readable;
use crate::error::OriginError;
use crate::publish::parse_raw_changes;
use crate::publish_policy::{restore_refusal, RejectReason};
use crate::recovery_view::{left_out_reason, restore_marker, NotRestored, RecoveryRef, KEPT};
use crate::tree_merge::{changed_paths, three_way, tree_with_entries_from};
use crate::workspace_git::WorkspaceGit;

/// Unsaved work merged onto `main`.
pub(crate) struct Restore {
    /// The recovery or salvage ref restored.
    reference: RecoveryRef,
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
    /// The gateway's own address, which restore commits are committed by.
    committer_email: String,
    /// The last attempt brings nothing new to `main` and records the
    /// restore with an empty restore commit ([`restore_marker`]).
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
            keep,
            base_rev,
            shard_refused: BTreeMap::new(),
            withheld: BTreeMap::new(),
            touched: None,
            committer_email,
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
            .map(|(path, reason)| (path.clone(), reason.name()))
            .collect();

        // Conflicts keep `main`'s entry already; only real ones stop the
        // restore. A path that may never be saved is refused before a keep
        // is looked at.
        let mut conflicts = Vec::new();
        for path in &merged.conflicts {
            let refused = restore_refusal(path, false, "", None);
            match left_out_reason(refused, self.kept(path)) {
                Some(reason) => {
                    withheld.insert(path.clone(), reason);
                }
                None => conflicts.push(path.clone()),
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
            if !withheld.contains_key(path) {
                let refused = restore_refusal(
                    path,
                    change.status == 'D',
                    &change.new_mode,
                    sizes.get(&change.new_oid).copied(),
                );
                if let Some(reason) = left_out_reason(refused, self.kept(path)) {
                    withheld.insert(path.clone(), reason);
                }
                // New files go through the ignore check, kept ones too: a
                // file the space ignores is refused, not kept.
                if refused.is_none() && change.status == 'A' {
                    added.push(path.clone());
                }
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
                    withheld.insert(path.clone(), RejectReason::Ignored.name());
                }
                let restored: Vec<String> = ignored
                    .iter()
                    .filter(|path| !reset.contains(path))
                    .cloned()
                    .collect();
                if !restored.is_empty() {
                    tree = tree_with_entries_from(git, &tree, main, &restored).map_err(internal)?;
                }
            }
        }

        self.touched = Some(changed_paths(git, &ours_tree, &tree).map_err(internal)?);
        self.withheld = withheld;
        // Nothing new for `main`: a salvage ref's restore is recorded once,
        // by the rule Desktop records it by.
        self.marker = match main {
            Some(main) => {
                restore_marker(
                    git,
                    &self.reference,
                    tree != ours_tree,
                    main,
                    &self.commit,
                    &self.committer_email,
                )
                .map_err(OriginError::from)?
                .0
            }
            None => false,
        };
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
