//! What a restore of unsaved work brings back, decided once for both
//! servers that restore: Desktop's checkout (`publish::restore`) and the
//! hosted gateway (`hosted::restore`). Each mode only applies the plan its
//! own way (Desktop through its index and a publish, the gateway as a
//! commit pushed to canonical `main`); what is restored, what is left out
//! and why, which clashes the person must settle, whether the ref may go
//! and whether an empty restore commit records the restore are decided
//! here, so the two cannot drift.
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
//!   `unsupported`, `too_large`), then `ignored`;
//! - is otherwise `kept` when the person keeps it or a folder above it;
//! - keeps `onto`'s entry when it is left out, and is reported in
//!   `notRestored` with why.
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
//! The ref may go once the restore is on `main` only when nothing was left
//! out but on request: work refused here exists only on the ref, which then
//! stays. A salvage ref with nothing left to bring back is recorded with an
//! empty restore commit ([`restore_marker`]).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context as _, Result};
use uuid::Uuid;

use crate::error::OriginError;
use crate::publish::parse_raw_changes;
use crate::publish_policy::{restore_refusal, RejectReason};
use crate::recovery_view::{left_out_reason, restore_marker, NotRestored, RecoveryRef};
use crate::tree_merge::{three_way, tree_with_entries_from};
use crate::workspace_git::{nul_list, RunOpts, WorkspaceGit};

/// What a restore is asked to do.
pub(crate) struct RestoreInput<'a> {
    /// The recovery or salvage ref restored.
    pub reference: &'a RecoveryRef,
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
    /// The committers whose restore commits count
    /// ([`crate::recovery_view::restore_committers`]).
    pub restorers: &'a [String],
    /// Another commit whose restore commits count for the marker decision
    /// (Desktop: canonical `main` as last fetched, which may be ahead of
    /// the branch restored onto).
    pub recorded_on: Option<&'a str>,
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
    /// Nothing new comes to `onto`, and the restore of this salvage ref is
    /// recorded with an empty restore commit.
    pub marker: bool,
    /// The restore commit of this ref `onto` already has, if any.
    pub earlier_marker: Option<String>,
}

impl RestorePlan {
    /// Whether the restore changes `onto`'s tree.
    pub(crate) fn made(&self) -> bool {
        self.tree != self.onto_tree
    }

    /// Whether the ref may go once the restore is on `main`: nothing was
    /// left out but what the person chose to keep. Salvage refs stay
    /// whatever this says.
    pub(crate) fn lets_ref_go(&self) -> bool {
        self.refused == 0
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
        let refusal = input.refused_before.get(path).copied().or_else(|| {
            restore_refusal(
                path,
                deleted,
                &change.new_mode,
                sizes.get(&change.new_oid).copied(),
            )
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

    // A clash is settled when it lies below a path left out, or when the
    // work brings nothing in at or below it. A change already on `onto`
    // settles only its own path: below a file both sides removed for a
    // folder, the folders may still differ.
    let left_out_roots: PathRoots = left_out.keys().cloned().collect();
    for path in left_out.keys() {
        nothing_in.insert(path.clone());
    }
    let work: PathRoots = changed.into_iter().collect();
    let conflicts: Vec<String> = merged
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
        .collect();
    if !conflicts.is_empty() {
        return Err(PlanError::Conflict(conflicts));
    }

    let made = tree != onto_tree;
    let (marker, earlier_marker) = match input.onto {
        Some(onto) => {
            let tips: Vec<&str> = std::iter::once(onto).chain(input.recorded_on).collect();
            restore_marker(
                git,
                input.reference,
                made,
                &tips,
                input.saved,
                input.restorers,
            )?
        }
        None => (false, None),
    };
    Ok(RestorePlan {
        tree,
        onto_tree,
        not_restored: left_out
            .into_iter()
            .map(|(path, reason)| NotRestored { path, reason })
            .collect(),
        refused: refused.len(),
        marker,
        earlier_marker,
    })
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
    use super::{gitignores_for, PathRoots};

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
