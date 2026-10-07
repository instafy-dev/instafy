//! What a restore of unsaved work brings back, decided once for both
//! servers that restore: Desktop's checkout (`publish::restore`) and the
//! hosted gateway (`hosted::restore`). Each mode only applies the plan its
//! own way (Desktop through its index and a publish, the gateway as a
//! commit pushed to canonical `main`); what is restored, what is left out
//! and why, which clashes the person must settle and whether the ref may go
//! are decided here, so the two cannot drift.
//!
//! The work is what the ref's commit (`saved`) changes against its merge
//! base with the commit it is restored onto (`onto`: Desktop's `HEAD`, the
//! gateway's `main`). A change `onto` already holds as the work has it
//! brings nothing in and is not judged. Every other change:
//!
//! - is refused when it may never be restored here, before a keep is looked
//!   at ([`left_out_reason`]): an earlier refusal (Desktop's frozen paths,
//!   the shard's refusal on an earlier attempt), then
//!   [`restore_refusal`] (`excluded`, `secret`, `attachment`,
//!   `unsupported`, `too_large`), then `unsupported` for any change of a
//!   submodule entry `onto` holds (reads hide it, and a Desktop folder
//!   there may hold a repository of the person's own), then `ignored`;
//! - is otherwise `kept` when the person keeps it or a folder above it;
//! - keeps `onto`'s entry when it is left out, and is reported in
//!   `notRestored` with why.
//!
//! Keeping `onto`'s entry at one path can undo a change at another: a file
//! the work made of a folder goes when a path below it is put back, and
//! work below a folder left out gives way to `onto`'s entries there. Such a
//! change is never dropped unlisted, whether or not `onto` moved since the
//! work's base: it is left out for the reason a refused path that undid it
//! was refused (one above it, or one below it where `onto` has an entry to
//! put back), or otherwise it is a clash the person settles. A refused new
//! file `onto` lacks puts nothing back, so a file the work made a folder of
//! around it keeps its clash with `onto`'s edit.
//!
//! `ignored` comes from one snapshot: the `.gitignore` files of the
//! restored tree itself (the merge with every path left out so far as
//! `onto` has it), checked with `check-ignore --no-index` against a scratch
//! tree that holds only those files, for every change that writes a path
//! `onto` does not track, conflicts and the work's entries below a clash
//! included. Nothing else counts: not the server's own configuration, not a
//! checkout's `info/exclude`, not the rules from before the restore.
//!
//! A path both sides changed differently keeps `onto`'s entry. It is
//! settled (Desktop's rule) when it is kept, lies below a path left out, or
//! every change the work makes at or below it brings nothing in (left out
//! or already on `onto`), as when the work adds a folder where `onto` has a
//! file; any other is a conflict the person must choose for. A change
//! already on `onto` settles only its own path, never what lies below it:
//! when both sides replaced a file with a folder, the files inside may
//! still differ.
//!
//! A new name of the work that differs only in case or Unicode form from
//! another entry of the restored tree (`Notes.md` beside a `notes.md` that
//! `onto` keeps) is a clash too, and so is a new path in a folder whose name
//! is such a variant of a file, a link or a submodule (`Docs/guide.md`
//! beside a file `docs`): a disk that ignores case takes the two for one, so
//! Desktop could not check both out, and `main` should not hold what such a
//! checkout cannot. Two folders whose names differ only so share one folder
//! there, and stay allowed ([`alias_clashes`]).
//!
//! The ref may go once the restore is on `main` only when nothing was left
//! out but on request: work refused here exists only on the ref, which then
//! stays. A kept path the work writes where `onto` has no file, link or
//! submodule keeps the ref too unless, on the `onto` restored onto, the keep
//! chose `onto`'s version over the work's ([`unsettled_keeps`]): `onto` has
//! a folder there or a file above it, removed the file the work changed, or
//! holds the work as the work has it under a name such a disk takes for
//! the path. Keeping `main`'s `TODO.md` chose no version of the work's
//! `todo.md` ([`kept_aliases`]), and neither does a keep chosen at a clash
//! that has left `main` since (the person kept `Notes.md` beside `main`'s
//! `notes.md`, which a later save removed) or at a new path whose clash was
//! with the merge base alone: such work would otherwise be on neither
//! `main` nor any ref.
//!
//! Such a keep is listed [`PATH_ALIAS`] (a kept name such a disk takes for
//! another entry of the restored tree that does not hold the work) or
//! [`NOTHING_TO_KEEP`] (any other), not `kept`, and the restore commit then
//! names no ref ([`RestorePlan::marks_restored`]): the ref still holds work
//! `main` lacks under every name, which a later restore can bring back, so
//! it is never listed as restored by that commit.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context as _, Result};
use uuid::Uuid;

use crate::apply::portable_key;
use crate::error::OriginError;
use crate::publish::{parse_raw_changes, RawChange};
use crate::publish_policy::{restore_refusal, RejectReason};
use crate::recovery_view::{left_out_reason, NotRestored, KEPT, NOTHING_TO_KEEP, PATH_ALIAS};
use crate::tree_merge::{three_way, tree_with_entries_from};
use crate::workspace_git::{nul_list, parse_ls_tree, RunOpts, TreeEntry, WorkspaceGit};

/// What a restore is asked to do.
pub(crate) struct RestoreInput<'a> {
    /// The commit the work is restored onto; `None` for a space with no
    /// `main` yet.
    pub onto: Option<&'a str>,
    /// The commit the ref names, already in the repository.
    pub saved: &'a str,
    /// Paths (and everything below them) the person keeps as `onto` has
    /// them.
    pub keep: &'a PathRoots,
    /// Paths refused before this plan, with why.
    pub refused_before: &'a BTreeMap<String, RejectReason>,
    /// A folder the ignore check may make its scratch tree in.
    pub scratch: &'a Path,
}

/// What a restore brings back.
#[derive(Debug)]
pub(crate) struct RestorePlan {
    /// The restored tree.
    pub tree: String,
    /// `onto`'s tree (the empty tree without `onto`).
    pub onto_tree: String,
    /// Every change of the work left as `onto` has it, with why, by path.
    pub not_restored: Vec<NotRestored>,
    /// How many of them were refused (left out for a reason other than
    /// the person's own keep).
    refused: usize,
    /// How many kept paths chose no version of the work's file, so the
    /// work is on the restored tree under no name ([`unsettled_keeps`]).
    unsettled: usize,
}

impl RestorePlan {
    /// Whether the restore changes `onto`'s tree.
    pub(crate) fn made(&self) -> bool {
        self.tree != self.onto_tree
    }

    /// Whether the ref may go once the restore is on `main`: nothing was
    /// left out but what the person chose to keep, and every keep chose
    /// `onto`'s version over the work's ([`unsettled_keeps`]).
    pub(crate) fn lets_ref_go(&self) -> bool {
        self.refused == 0 && self.unsettled == 0
    }

    /// Whether the restore commit may name the ref, so the ref is listed as
    /// restored by it: not while a keep chose no version of the work's file
    /// ([`PATH_ALIAS`], [`NOTHING_TO_KEEP`]). The person settled nothing
    /// there; the work stays on the ref, pending, and can still come back.
    /// Work refused here never can, so a ref kept only for it is listed as
    /// restored.
    pub(crate) fn marks_restored(&self) -> bool {
        self.unsettled == 0
    }
}

/// Why a plan could not be made.
#[derive(Debug)]
pub(crate) enum PlanError {
    /// Paths both sides changed that the person must choose a version for.
    Conflict(Vec<String>),
    /// Anything else.
    Failed(OriginError),
}

impl From<anyhow::Error> for PlanError {
    fn from(error: anyhow::Error) -> Self {
        Self::Failed(OriginError::internal(format!("{error:#}")))
    }
}

impl From<crate::recovery_view::ViewError> for PlanError {
    fn from(error: crate::recovery_view::ViewError) -> Self {
        Self::Failed(error.into())
    }
}

/// Decide a restore (see the module documentation).
pub(crate) fn plan(
    git: &WorkspaceGit<'_>,
    input: &RestoreInput<'_>,
) -> Result<RestorePlan, PlanError> {
    let onto_tree = match input.onto {
        Some(onto) => git.tree_id(onto)?,
        None => git.empty_tree()?,
    };
    let base = match input.onto {
        Some(onto) => git.merge_base(input.saved, onto)?,
        None => None,
    };
    let base_tree = match base.as_deref() {
        Some(base) => git.tree_id(base)?,
        None => git.empty_tree()?,
    };
    let merged = three_way(git, base.as_deref(), &onto_tree, input.saved)?;

    // What the work changes.
    let saved_tree = git.tree_id(input.saved)?;
    let raw = git.bytes(&[
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--raw",
        &base_tree,
        &saved_tree,
    ])?;
    let changes = parse_raw_changes(&raw);
    let changed: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
    // What `onto` holds there: a file, a link or a submodule (a folder
    // counts as nothing at that path).
    let at_onto: BTreeMap<String, (String, String)> = git
        .tree_entries(&onto_tree, &changed)?
        .into_iter()
        .filter(|(_, entry)| entry.kind != "tree")
        .map(|(path, entry)| (path, (entry.mode, entry.oid)))
        .collect();
    let written: Vec<String> = changes
        .iter()
        .filter(|change| change.status != 'D' && change.new_mode != "160000")
        .map(|change| change.new_oid.clone())
        .collect();
    let sizes: BTreeMap<String, u64> = written
        .iter()
        .cloned()
        .zip(git.object_sizes(&written)?)
        .filter_map(|(oid, size)| size.map(|(_, size)| (oid, size)))
        .collect();

    let mut left_out: BTreeMap<String, &'static str> = BTreeMap::new();
    let mut refused: BTreeSet<String> = BTreeSet::new();
    let mut nothing_in = PathRoots::default();
    let mut unignored = Vec::new();
    for change in &changes {
        let path = &change.path;
        let deleted = change.status == 'D';
        let held = at_onto.get(path);
        let on_onto = if deleted {
            held.is_none()
        } else {
            held.is_some_and(|(mode, oid)| *mode == change.new_mode && *oid == change.new_oid)
        };
        if on_onto {
            nothing_in.insert(path.clone());
            continue;
        }
        let refusal = input
            .refused_before
            .get(path)
            .copied()
            .or_else(|| {
                restore_refusal(
                    path,
                    deleted,
                    &change.new_mode,
                    sizes.get(&change.new_oid).copied(),
                )
            })
            // A submodule entry on `onto` is never replaced or removed:
            // reads hide it, and on Desktop its folder may hold a
            // repository of the person's own that the change would delete.
            .or_else(|| {
                held.is_some_and(|(mode, _)| mode == "160000")
                    .then_some(RejectReason::Unsupported)
            });
        if let Some(reason) = left_out_reason(refusal, input.keep.covers(path)) {
            left_out.insert(path.clone(), reason);
            if refusal.is_some() {
                refused.insert(path.clone());
            }
        }
        // A new file for `onto` goes through the ignore check, a kept one
        // too: a file the restored tree ignores is refused, not kept.
        if refusal.is_none() && !deleted && held.is_none() {
            unignored.push(path.clone());
        }
    }
    for (path, reason) in input.refused_before {
        left_out.entry(path.clone()).or_insert(reason.name());
        refused.insert(path.clone());
    }

    // The restored tree so far: the merge (conflicts keep `onto`'s entry)
    // with every path left out as `onto` has it.
    let reset: Vec<String> = left_out.keys().cloned().collect();
    let mut tree = tree_with_entries_from(git, &merged.tree, Some(&onto_tree), &reset)?;

    // Its own `.gitignore` files decide what it ignores.
    let ignored = ignored_in(git, input.scratch, &tree, &unignored)?;
    let mut newly = Vec::new();
    for path in ignored {
        if left_out
            .insert(path.clone(), RejectReason::Ignored.name())
            .is_none()
        {
            newly.push(path.clone());
        }
        refused.insert(path);
    }
    if !newly.is_empty() {
        tree = tree_with_entries_from(git, &tree, Some(&onto_tree), &newly)?;
    }

    // A change those resets undid is never dropped unlisted: a file of the
    // work taken away to make room for a path left out below it (an entry
    // put back clears every file above it), or work below a path left out,
    // where `onto`'s entries are back. It cannot come in while that path
    // stays as `onto` has it: refused for the same reason when such a path
    // was refused, and otherwise (only kept paths) a clash to settle.
    let mut undone_clashes = Vec::new();
    if !left_out.is_empty() {
        let conflicted: BTreeSet<&str> = merged.conflicts.iter().map(String::as_str).collect();
        let pending: Vec<&RawChange> = changes
            .iter()
            .filter(|change| {
                !left_out.contains_key(&change.path) && !nothing_in.contains(&change.path)
            })
            .collect();
        // A refused path below a change undoes it only when `onto` has
        // something there to put back, which needs a folder above it: a
        // refused new file `onto` lacks leaves nothing behind.
        let refused_paths: Vec<String> = refused.iter().cloned().collect();
        let put_back: BTreeSet<String> = git
            .entries_by_path(&onto_tree, &refused_paths)?
            .into_keys()
            .collect();
        for path in undone(git, &pending, &conflicted, &merged.tree, &tree)? {
            match refused_around(&left_out, &refused, &put_back, &path) {
                Some(reason) => {
                    left_out.insert(path.clone(), reason);
                    refused.insert(path);
                }
                None => undone_clashes.push(path),
            }
        }
    }

    // A new name of the work that a disk ignoring case or Unicode form
    // takes for another entry of the restored tree (itself, or a folder it
    // lies in taken for a file) cannot come in beside it: a Desktop
    // checkout cannot hold both, and the gateway would leave `main` with
    // two names such a checkout takes for one. It is a clash the person
    // settles, in both modes.
    let added: Vec<&str> = changes
        .iter()
        .filter(|change| {
            change.status != 'D'
                && !at_onto.contains_key(&change.path)
                && !left_out.contains_key(&change.path)
        })
        .map(|change| change.path.as_str())
        .collect();
    let alias_clashes = aliases_in(git, &tree, &added)?;

    // A clash is settled when it lies below a path left out, or when the
    // work brings nothing in at or below it. A change already on `onto`
    // settles only its own path: below a file both sides removed for a
    // folder, the folders may still differ.
    let left_out_roots: PathRoots = left_out.keys().cloned().collect();
    for path in left_out.keys() {
        nothing_in.insert(path.clone());
    }
    let work: PathRoots = changed.into_iter().collect();
    let mut conflicts: Vec<String> = merged
        .conflicts
        .iter()
        .filter(|path| {
            if left_out_roots.covers(path) || input.keep.covers(path) {
                return false;
            }
            let mut inside = work.at_or_below(path).peekable();
            let any_inside = inside.peek().is_some();
            !(any_inside && inside.all(|path| nothing_in.contains(path)))
        })
        .cloned()
        .chain(undone_clashes)
        .chain(alias_clashes)
        .collect();
    conflicts.sort();
    conflicts.dedup();
    if !conflicts.is_empty() {
        return Err(PlanError::Conflict(conflicts));
    }

    // A kept path the work writes where `onto` has no file, a link or a
    // submodule keeps the ref unless the keep chose `onto`'s version over
    // the work's on this `onto` ([`unsettled_keeps`]): the person chose at
    // the clash they were shown, and `onto` may have moved since.
    let kept_new: Vec<&RawChange> = changes
        .iter()
        .filter(|change| {
            change.status != 'D'
                && !at_onto.contains_key(&change.path)
                && left_out.get(&change.path) == Some(&KEPT)
        })
        .collect();
    let unsettled = unsettled_keeps(git, &onto_tree, &tree, &merged.conflicts, &kept_new)?;
    for (path, reason) in &unsettled {
        left_out.insert(path.clone(), *reason);
    }

    Ok(RestorePlan {
        tree,
        onto_tree,
        not_restored: left_out
            .into_iter()
            .map(|(path, reason)| NotRestored { path, reason })
            .collect(),
        refused: refused.len(),
        unsettled: unsettled.len(),
    })
}

/// The paths of `kept` (changes the person kept that write a path where
/// `onto`, a tree id, has no file, link or submodule) whose keep chose no
/// version of the work's file, so the work is on the restored `tree` under
/// no name and the ref stays with it, pending, each with the reason the
/// restore lists it under instead of [`KEPT`]: [`PATH_ALIAS`] for a name
/// such a disk takes for another entry of `tree`, [`NOTHING_TO_KEEP`]
/// otherwise. A keep chooses `onto`'s version only when this `onto` holds a
/// version to choose:
///
/// - a folder at the path, or a file, a link or a submodule at a folder
///   above it (the file and folder clash such a keep settles);
/// - a removal the work's change conflicted with (the merge conflicted at a
///   path the merge base had a file at, which `onto` removed: keeping that
///   removal is a choice). A path the work added never qualifies: its
///   conflict may be with the merge base's file alone (the work made a
///   folder of a file `onto` has since removed too), and `onto` then holds
///   nothing to choose;
/// - the work itself, as the work has it, under a name a disk ignoring
///   case takes for the path.
///
/// A path such a disk takes for another entry of the restored tree that
/// does not hold the work ([`kept_aliases`]) chose nothing whatever else
/// holds there: `main`'s `TODO.md` is another file than the work's
/// `todo.md`. Any other keep settles nothing on this `onto`, as when the
/// file whose name the work's new one took left `main` after the person
/// chose to keep it.
fn unsettled_keeps(
    git: &WorkspaceGit<'_>,
    onto_tree: &str,
    tree: &str,
    conflicts: &[String],
    kept: &[&RawChange],
) -> Result<Vec<(String, &'static str)>> {
    if kept.is_empty() {
        return Ok(Vec::new());
    }
    let aliases = kept_aliases(git, tree, kept)?;
    // `onto`'s entries at each kept path and the folders above it.
    let around: BTreeSet<String> = kept
        .iter()
        .flat_map(|change| {
            let path = change.path.as_str();
            path.match_indices('/')
                .map(|(index, _)| path[..index].to_string())
                .chain(std::iter::once(path.to_string()))
        })
        .collect();
    let around: Vec<String> = around.into_iter().collect();
    let at_onto = git.entries_by_path(onto_tree, &around)?;
    let is_folder = |path: &str| at_onto.get(path).map(|entry| entry.kind == "tree");
    let conflicted: BTreeSet<&str> = conflicts.iter().map(String::as_str).collect();
    Ok(kept
        .iter()
        .filter_map(|change| {
            let path = change.path.as_str();
            let unsettled = match aliases.get(path) {
                Some(held) => (!held).then_some(PATH_ALIAS),
                None => {
                    let folder_here = is_folder(path) == Some(true);
                    let file_above = path
                        .match_indices('/')
                        .any(|(index, _)| is_folder(&path[..index]) == Some(false));
                    // A path the work added had no file for `onto` to
                    // remove: its conflict may be with the merge base alone
                    // (a file of the base where the work made a folder).
                    let removed = change.status != 'A' && conflicted.contains(path);
                    (!(folder_here || file_above || removed)).then_some(NOTHING_TO_KEEP)
                }
            };
            unsettled.map(|reason| (change.path.clone(), reason))
        })
        .collect())
}

/// The paths of `pending` (changes neither left out nor already on `onto`)
/// that `tree` does not hold as the restore means to bring them: as the
/// work has them, or, for a file both sides edited that the merge combined
/// (a path of `merged` in no conflict), as `merged` has it. Sorted, so a
/// folder comes before what lies below it.
fn undone(
    git: &WorkspaceGit<'_>,
    pending: &[&RawChange],
    conflicted: &BTreeSet<&str>,
    merged: &str,
    tree: &str,
) -> Result<Vec<String>> {
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    // A file, a link or a submodule at each path (a folder is none).
    let leaves = |tree: &str, paths: &[String]| -> Result<BTreeMap<String, (String, String)>> {
        Ok(git
            .entries_by_path(tree, paths)?
            .into_iter()
            .filter(|(_, entry)| entry.kind != "tree")
            .map(|(path, entry)| (path, (entry.mode, entry.oid)))
            .collect())
    };
    let paths: Vec<String> = pending.iter().map(|change| change.path.clone()).collect();
    let now = leaves(tree, &paths)?;
    let unlike_work: Vec<&RawChange> = pending
        .iter()
        .copied()
        .filter(|change| {
            let work =
                (change.status != 'D').then(|| (change.new_mode.clone(), change.new_oid.clone()));
            now.get(&change.path) != work.as_ref()
        })
        .collect();
    let combined: Vec<String> = unlike_work
        .iter()
        .filter(|change| !conflicted.contains(change.path.as_str()))
        .map(|change| change.path.clone())
        .collect();
    let as_merged = leaves(merged, &combined)?;
    let mut undone: Vec<String> = unlike_work
        .into_iter()
        .filter(|change| {
            conflicted.contains(change.path.as_str())
                || now.get(&change.path) != as_merged.get(&change.path)
        })
        .map(|change| change.path.clone())
        .collect();
    undone.sort();
    Ok(undone)
}

/// [`alias_clashes`] of `added` in `tree` (a tree id), listed once.
pub(crate) fn aliases_in(
    git: &WorkspaceGit<'_>,
    tree: &str,
    added: &[&str],
) -> Result<Vec<String>> {
    if added.is_empty() {
        return Ok(Vec::new());
    }
    let entries = every_entry(git, tree)?
        .into_iter()
        .map(|entry| (entry.path, entry.kind == "tree"));
    Ok(alias_clashes(entries, added))
}

/// Every entry of `tree` (a tree id), folders included.
fn every_entry(git: &WorkspaceGit<'_>, tree: &str) -> Result<Vec<TreeEntry>> {
    let raw = git.bytes(&[
        "ls-tree",
        "-r",
        "-t",
        "-z",
        "--full-tree",
        "--end-of-options",
        tree,
    ])?;
    Ok(parse_ls_tree(&raw))
}

/// The paths of `kept` (new names of the work the person kept, so absent
/// from the restored `tree`) that [`alias_clashes`] finds once they are
/// put back beside `tree`'s entries, each other and the folders they lie
/// in, each with whether an entry of `tree` that such a disk takes for the
/// path holds it as the work has it. Unless one does, "Keep current" on
/// such a path chose no version of the work's file: `onto`'s entry is
/// another file, and the work is on `main` under no name.
fn kept_aliases(
    git: &WorkspaceGit<'_>,
    tree: &str,
    kept: &[&RawChange],
) -> Result<BTreeMap<String, bool>> {
    if kept.is_empty() {
        return Ok(BTreeMap::new());
    }
    let listed = every_entry(git, tree)?;
    // What `tree` holds under each key: a file, a link or a submodule.
    let held: BTreeSet<(String, &str, &str)> = listed
        .iter()
        .filter(|entry| entry.kind != "tree")
        .map(|entry| {
            (
                portable_key(&entry.path),
                entry.mode.as_str(),
                entry.oid.as_str(),
            )
        })
        .collect();
    let mut entries: Vec<(String, bool)> = listed
        .iter()
        .map(|entry| (entry.path.clone(), entry.kind == "tree"))
        .collect();
    for change in kept {
        entries.extend(
            change
                .path
                .match_indices('/')
                .map(|(index, _)| (change.path[..index].to_string(), true)),
        );
        entries.push((change.path.clone(), false));
    }
    let paths: Vec<&str> = kept.iter().map(|change| change.path.as_str()).collect();
    let clashes: BTreeSet<String> = alias_clashes(entries, &paths).into_iter().collect();
    Ok(kept
        .iter()
        .filter(|change| clashes.contains(&change.path))
        .map(|change| {
            let holds_work = held.contains(&(
                portable_key(&change.path),
                change.new_mode.as_str(),
                change.new_oid.as_str(),
            ));
            (change.path.clone(), holds_work)
        })
        .collect())
}

/// The paths of `added` that a tree whose `entries` (path, and whether it is
/// a folder) hold them cannot hold on a disk that ignores case or Unicode
/// form ([`portable_key`]): a path beside another entry of its key (a file,
/// a link, a submodule or a folder), or below a folder whose key another
/// entry that is not a folder has (a folder `Docs` beside a file `docs`).
/// Two folders of one key share one folder on such a disk, so a path below
/// them is judged by its own key alone.
pub(crate) fn alias_clashes(
    entries: impl IntoIterator<Item = (String, bool)>,
    added: &[&str],
) -> Vec<String> {
    let mut names: BTreeMap<String, Vec<(String, bool)>> = BTreeMap::new();
    for (path, folder) in entries {
        names
            .entry(portable_key(&path))
            .or_default()
            .push((path, folder));
    }
    // The other entries of `name`'s key, with whether each is a folder.
    let others = |name: &str| {
        let name = name.to_string();
        names
            .get(&portable_key(&name))
            .into_iter()
            .flatten()
            .filter(move |(other, _)| *other != name)
            .map(|(_, folder)| *folder)
    };
    added
        .iter()
        .filter(|path| {
            let held = names
                .get(&portable_key(path))
                .is_some_and(|found| found.iter().any(|(name, _)| name.as_str() == **path));
            held && (others(path).next().is_some()
                || path
                    .match_indices('/')
                    .any(|(index, _)| others(&path[..index]).any(|folder| !folder)))
        })
        .map(|path| path.to_string())
        .collect()
}

/// Why a path left out at a folder above `path`, or below `path`, was
/// refused, if one was: the nearest folder above first, then the first
/// path below that `onto` holds an entry at (`put_back`). A refused path
/// below that `onto` lacks puts nothing back, so it never stands in the way
/// of the change at `path` (a file the work made a folder of keeps its
/// clash with `onto`'s edit).
fn refused_around(
    left_out: &BTreeMap<String, &'static str>,
    refused: &BTreeSet<String>,
    put_back: &BTreeSet<String>,
    path: &str,
) -> Option<&'static str> {
    let above = path
        .match_indices('/')
        .map(|(index, _)| &path[..index])
        .rev()
        .find(|path| refused.contains(*path));
    let below_prefix = format!("{path}/");
    let below = || {
        left_out
            .range::<str, _>((
                std::ops::Bound::Included(below_prefix.as_str()),
                std::ops::Bound::Unbounded,
            ))
            .map(|(path, _)| path.as_str())
            .take_while(|path| path.starts_with(&below_prefix))
            .find(|path| refused.contains(*path) && put_back.contains(*path))
    };
    above
        .or_else(below)
        .and_then(|path| left_out.get(path).copied())
}

// ---------------------------------------------------------------------------
// The ignore snapshot.
// ---------------------------------------------------------------------------

fn is_regular(mode: &str) -> bool {
    matches!(mode, "100644" | "100755")
}

/// The `.gitignore` files that apply to `path`, outermost first.
pub(crate) fn gitignores_for(path: &str) -> Vec<String> {
    std::iter::once(".gitignore".to_string())
        .chain(
            path.match_indices('/')
                .map(|(index, _)| format!("{}/.gitignore", &path[..index])),
        )
        .collect()
}

/// The paths of `paths` that the `.gitignore` files of `tree` (a tree or
/// commit) ignore.
pub(crate) fn ignored_in(
    git: &WorkspaceGit<'_>,
    scratch: &Path,
    tree: &str,
    paths: &[String],
) -> Result<Vec<String>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let candidates: Vec<String> = paths
        .iter()
        .flat_map(|path| gitignores_for(path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let rules: BTreeMap<String, String> = git
        .tree_entries(tree, &candidates)?
        .into_iter()
        .filter(|(_, entry)| is_regular(&entry.mode))
        .map(|(path, entry)| (path, entry.oid))
        .collect();
    check_ignored(git, scratch, &rules, paths)
}

/// The paths of `paths` that the `.gitignore` files `rules` (path → blob
/// id, read through `git`) ignore. The files are written into a scratch work
/// tree in `scratch`, and `check-ignore --no-index` runs there against an
/// empty repository of its own: no rules from the server's configuration,
/// a checkout's `info/exclude` or anywhere else count.
pub(crate) fn check_ignored(
    git: &WorkspaceGit<'_>,
    scratch: &Path,
    rules: &BTreeMap<String, String>,
    paths: &[String],
) -> Result<Vec<String>> {
    if rules.is_empty() || paths.is_empty() {
        return Ok(Vec::new());
    }
    let name = Uuid::new_v4().simple().to_string();
    let tree = scratch.join(format!("ignore-{name}"));
    let repository = scratch.join(format!("ignore-{name}.git"));
    let result = (|| -> Result<Vec<String>> {
        std::fs::create_dir(&tree).with_context(|| format!("failed to create {tree:?}"))?;
        let ids: Vec<String> = rules.values().cloned().collect();
        let contents = git.read_objects(&ids)?;
        for ((path, _), object) in rules.iter().zip(contents) {
            let target = tree.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create {parent:?}"))?;
            }
            std::fs::write(&target, &object.data)
                .with_context(|| format!("failed to write {target:?}"))?;
        }
        WorkspaceGit::init_bare(&repository)?;
        let input = nul_list(paths);
        let checker = WorkspaceGit::bare(&repository, None).with_work_tree(&tree);
        let args = ["check-ignore", "--no-index", "-z", "--stdin"];
        let output = checker.run_opts(
            &args,
            &RunOpts {
                stdin: Some(&input),
                ..RunOpts::default()
            },
        )?;
        match output.status.code() {
            Some(0) | Some(1) => Ok(output
                .stdout
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| String::from_utf8_lossy(path).to_string())
                .collect()),
            _ => anyhow::bail!("{}", crate::workspace_git::failure(&args, &output)),
        }
    })();
    let _ = std::fs::remove_dir_all(&tree);
    let _ = std::fs::remove_dir_all(&repository);
    result
}

// ---------------------------------------------------------------------------
// Paths and what lies below them.
// ---------------------------------------------------------------------------

/// Paths and folders, each matched by itself and by every path below it,
/// in time that grows with a path's depth, not with the number of entries.
#[derive(Clone, Debug, Default)]
pub(crate) struct PathRoots(BTreeSet<String>);

impl PathRoots {
    pub(crate) fn insert(&mut self, path: String) {
        self.0.insert(path);
    }

    pub(crate) fn contains(&self, path: &str) -> bool {
        self.0.contains(path)
    }

    /// `path` is an entry or lies below one.
    pub(crate) fn covers(&self, path: &str) -> bool {
        self.contains(path)
            || path
                .match_indices('/')
                .any(|(index, _)| self.contains(&path[..index]))
    }

    /// The entries that are `folder` or lie below it.
    pub(crate) fn at_or_below<'s>(&'s self, folder: &'s str) -> impl Iterator<Item = &'s str> + 's {
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

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::{alias_clashes, gitignores_for, refused_around, PathRoots};

    #[test]
    fn a_new_path_whose_name_or_folder_another_entry_takes_is_a_clash() {
        // (path, folder) of a tree.
        let tree = [
            ("Docs", true),
            ("Docs/guide.md", false),
            ("docs", false),
            ("Notes.md", false),
            ("notes.md", false),
            ("Shared", true),
            ("Shared/new.md", false),
            ("shared", true),
            ("shared/old.md", false),
            ("Vendor", true),
            ("Vendor/lib.rs", false),
            ("vendor", false),
            ("a", true),
            ("a/B", true),
            ("a/B/c.md", false),
            ("a/b", false),
            ("plain", true),
            ("plain/new.md", false),
        ]
        .map(|(path, folder)| (path.to_string(), folder));
        let added = [
            // Below a folder another entry's file takes.
            "Docs/guide.md",
            "a/B/c.md",
            // Beside a file of its key.
            "Notes.md",
            // Below two folders of one key: one folder on such a disk.
            "Shared/new.md",
            // Nothing of its key.
            "plain/new.md",
            // Not in the tree.
            "Missing.md",
        ];
        assert_eq!(
            alias_clashes(tree.clone(), &added),
            vec!["Docs/guide.md", "a/B/c.md", "Notes.md"]
        );
        // A file the work adds where another entry is a folder of its key.
        assert_eq!(alias_clashes(tree, &["vendor"]), vec!["vendor"]);
    }

    /// A disk that ignores case folds it fully: `Straße.md`, `STRAẞE.md`
    /// and `STRASSE.md`, a final sigma and a plain one, a long s and an s,
    /// a ligature and its letters each name one file there.
    #[test]
    fn names_full_case_folding_takes_for_one_are_a_clash() {
        for (kept, added) in [
            ("Stra\u{df}e.md", "STRASSE.md"),
            ("Stra\u{df}e.md", "STRA\u{1e9e}E.md"),
            ("STRA\u{1e9e}E.md", "strasse.md"),
            (
                "\u{39f}\u{394}\u{39f}\u{3a3}.md",
                "\u{3bf}\u{3b4}\u{3bf}\u{3c2}.md",
            ),
            ("\u{17f}ize.md", "size.md"),
            ("\u{fb01}le.md", "FILE.md"),
        ] {
            let tree = [(kept.to_string(), false), (added.to_string(), false)];
            assert_eq!(alias_clashes(tree, &[added]), vec![added], "{kept} {added}");
            let folders = [
                (kept.to_string(), false),
                (added.to_string(), true),
                (format!("{added}/x"), false),
            ];
            let below = format!("{added}/x");
            assert_eq!(
                alias_clashes(folders, &[below.as_str()]),
                vec![below.clone()],
                "{kept} {added}"
            );
        }
    }

    #[test]
    fn a_refusal_above_or_below_a_path_says_why_it_was_undone() {
        let left_out: BTreeMap<String, &'static str> = [
            ("a", "kept"),
            ("a/b/c", "secret"),
            ("k/a.txt", "kept"),
            ("libs-x", "excluded"),
            ("libs/vendor", "unsupported"),
            ("x", "ignored"),
            ("x/y/z", "kept"),
        ]
        .into_iter()
        .map(|(path, reason)| (path.to_string(), reason))
        .collect();
        let refused: BTreeSet<String> = ["a/b/c", "libs-x", "libs/vendor", "x"]
            .into_iter()
            .map(str::to_string)
            .collect();
        // What `onto` holds an entry at, of the refused paths.
        let put_back: BTreeSet<String> = ["a/b/c", "libs-x", "libs/vendor"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let around = |path: &str| refused_around(&left_out, &refused, &put_back, path);
        // A refused folder above, the nearest first; kept ones are passed.
        assert_eq!(around("x/y"), Some("ignored"));
        assert_eq!(around("x/y/z/w"), Some("ignored"));
        // A refused path below, never a sibling that only shares a prefix.
        assert_eq!(around("libs"), Some("unsupported"));
        assert_eq!(around("a/b"), Some("secret"));
        // Only kept paths around, or none.
        assert_eq!(around("k"), None);
        assert_eq!(around("lib"), None);
        assert_eq!(around("q/r"), None);
        // A refused path below that `onto` lacks puts nothing back.
        let nothing_back = BTreeSet::new();
        assert_eq!(
            refused_around(&left_out, &refused, &nothing_back, "a/b"),
            None
        );
        assert_eq!(
            refused_around(&left_out, &refused, &nothing_back, "x/y"),
            Some("ignored")
        );
    }

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

    #[test]
    fn every_gitignore_above_a_path_applies() {
        assert_eq!(gitignores_for("a.txt"), vec![".gitignore"]);
        assert_eq!(
            gitignores_for("a/b/c.txt"),
            vec![".gitignore", "a/.gitignore", "a/b/.gitignore"]
        );
    }
}
