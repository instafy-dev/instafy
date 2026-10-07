//! What a change does to a space's `main`: an upload (files written and
//! paths deleted, with what the client read), the revert of a saved
//! commit, or the restore of unsaved work ([`super::restore`]). Each builds
//! the new tree from `main` in the change's quarantine and refuses what
//! cannot be saved as asked (an upload's rules below):
//!
//! - a link or submodule written over (400 `unsupported_entry`, also when
//!   the request says what the client read there, such as "absent" for a
//!   create, and the version it read had that same entry: reading again
//!   cannot help; 409 `head_moved` when `main` changed that path since that
//!   version, when the request names no version but says what it read, or
//!   for the controller's managed-files bootstrap (`autoCommitAfterApply`),
//!   which reads again and leaves such paths alone), a folder
//!   deleted without the version it was read at (400
//!   `delete_requires_base_rev`), a file where a folder is or the other way
//!   round (409 `path_type_conflict`);
//! - a new file the space's `.gitignore` ignores (422 `ignored_path`;
//!   not for imports and `autoCommitAfterApply` applies, which add tracked
//!   content as `git add --force` does), a
//!   path that may never be saved: Instafy metadata, build output and
//!   dependencies, secrets, legacy chat uploads (422 `excluded_path`), or a
//!   file over the size cap (422 `policy_rejected`);
//! - a new path a disk that ignores case or Unicode form takes for another
//!   entry of the new tree, itself or a folder it lies in taken for a file
//!   (409 `path_alias`, as on Desktop; not for imports and
//!   `autoCommitAfterApply` applies, which add content as they always did);
//! - after the no-op check, a path the client read at another version
//!   (`expected`, or a `baseRev` other than `main`) that changed since
//!   (409 `head_moved`); a change that would need nothing is still 409
//!   `head_moved` when one of its deletes names a path that turned from a
//!   file into a folder (or back) since the client read it.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

use super::answers::{
    delete_requires_base_rev, excluded_path, head_moved, hook_refusal, ignored_path, internal,
    path_alias, path_type_conflict, policy_rejected, rev_not_on_main, revert_conflict,
    unsupported_entry,
};
use super::read::readable;
use super::restore::Restore;
use crate::apply::StagedFile;
use crate::error::OriginError;
use crate::git::is_full_object_id;
use crate::publish::parse_raw_changes;
use crate::publish_policy::{
    deletion_allowed, unpublishable_reason, RejectReason, MAX_PUBLISH_BLOB_BYTES,
};
use crate::restore_plan::{aliases_in, check_ignored, gitignores_for};
use crate::tree_merge::three_way;
use crate::workspace_git::{parse_ls_tree, zero_oid, RunOpts, TreeEntry, WorkspaceGit};

/// Above this many paths, one full listing is cheaper than lookups.
const FULL_LISTING_ABOVE: usize = 2_000;

// ---------------------------------------------------------------------------
// Tree lookups.
// ---------------------------------------------------------------------------

fn is_tree(entry: &TreeEntry) -> bool {
    entry.kind == "tree"
}

pub(super) fn is_regular(mode: &str) -> bool {
    matches!(mode, "100644" | "100755")
}

/// The folders `path` lies in, outermost first (`a`, `a/b` for `a/b/c`).
fn ancestors(path: &str) -> Vec<String> {
    path.match_indices('/')
        .map(|(index, _)| path[..index].to_string())
        .collect()
}

/// The entries of `commit` at exactly `paths`, for every path that exists
/// there (a folder, a file, a link or a submodule). Paths reach git only on
/// stdin ([`WorkspaceGit::entries_by_path`]); many paths are read from one
/// full listing instead.
pub(super) fn entries_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    paths: &BTreeSet<String>,
) -> Result<HashMap<String, TreeEntry>, OriginError> {
    let mut found = HashMap::new();
    if paths.is_empty() {
        return Ok(found);
    }
    if paths.len() > FULL_LISTING_ABOVE {
        let raw = git
            .bytes(&["ls-tree", "-r", "-t", "-z", "--full-tree", commit])
            .map_err(internal)?;
        for entry in parse_ls_tree(&raw) {
            if paths.contains(&entry.path) {
                found.insert(entry.path.clone(), entry);
            }
        }
        return Ok(found);
    }
    let wanted: Vec<String> = paths.iter().cloned().collect();
    Ok(git
        .entries_by_path(commit, &wanted)
        .map_err(internal)?
        .into_iter()
        .collect())
}

/// Every file, link and submodule below `folders` (which do not contain
/// each other) in `commit`. Each folder is found with
/// [`WorkspaceGit::entries_by_path`] and listed by its tree id, so no path
/// is an argument of git.
fn entries_below(
    git: &WorkspaceGit<'_>,
    commit: &str,
    folders: &[String],
) -> Result<Vec<String>, OriginError> {
    let found = git.entries_by_path(commit, folders).map_err(internal)?;
    let mut below = Vec::new();
    for folder in folders {
        let Some(tree) = found.get(folder).filter(|entry| is_tree(entry)) else {
            continue;
        };
        let raw = git
            .bytes(&["ls-tree", "-r", "-z", "--end-of-options", &tree.oid])
            .map_err(internal)?;
        below.extend(
            parse_ls_tree(&raw)
                .into_iter()
                .map(|entry| format!("{folder}/{}", entry.path)),
        );
    }
    Ok(below)
}

/// Whether two entries of one path differ: kind, mode or content. Two
/// folders count as the same (what is in them is compared path by path).
fn differs(a: Option<&TreeEntry>, b: Option<&TreeEntry>) -> bool {
    match (a, b) {
        (None, None) => false,
        (Some(a), Some(b)) if is_tree(a) && is_tree(b) => false,
        (Some(a), Some(b)) => a.mode != b.mode || a.oid != b.oid,
        _ => true,
    }
}

// ---------------------------------------------------------------------------
// Changes.
// ---------------------------------------------------------------------------

/// A path left out of an import, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct SkippedPath {
    pub path: String,
    pub reason: &'static str,
}

/// What a change does to `main`.
pub(crate) enum Change {
    /// Files written and paths deleted (an upload).
    Edits(Edits),
    /// The inverse of a commit already on `main`.
    Revert(Revert),
    /// Unsaved work merged onto `main`.
    Restore(Restore),
}

impl Change {
    pub(super) fn build(
        &mut self,
        git: &WorkspaceGit<'_>,
        scratch: &Path,
        main: Option<&str>,
    ) -> Result<String, OriginError> {
        match self {
            Self::Edits(edits) => edits.build(git, scratch, main),
            Self::Revert(revert) => revert.build(git, main),
            Self::Restore(restore) => restore.build(git, scratch, main),
        }
    }

    pub(super) fn check(
        &self,
        git: &WorkspaceGit<'_>,
        main: Option<&str>,
    ) -> Result<(), OriginError> {
        match self {
            Self::Edits(edits) => edits.check(git, main),
            Self::Revert(_) => Ok(()),
            Self::Restore(restore) => restore.check(git, main),
        }
    }

    /// Before a change whose tree equals `main`'s is answered as needing
    /// nothing: whether that is true. It is not for an upload deleting a
    /// path that is now a folder where it was a file (or the other way
    /// round): the delete removed nothing, and the path changed since the
    /// client read it (409 `head_moved`).
    pub(super) fn settled(
        &self,
        git: &WorkspaceGit<'_>,
        main: Option<&str>,
    ) -> Result<(), OriginError> {
        match self {
            Self::Edits(edits) => edits.settled(git, main),
            Self::Revert(_) | Self::Restore(_) => Ok(()),
        }
    }

    /// What an import's receipt records: the files it keeps and their size
    /// (`None` for anything but an import).
    pub(super) fn receipt_counts(&self) -> Option<(usize, u64)> {
        match self {
            Self::Edits(edits) if edits.import => Some(edits.kept()),
            _ => None,
        }
    }

    /// The shard refused `path`: an import or a restore leaves it out and
    /// tries again; anything else is answered with the refusal.
    pub(super) fn refused(
        &mut self,
        path: String,
        reason: RejectReason,
    ) -> Result<(), OriginError> {
        match self {
            Self::Edits(edits) if edits.import && edits.writes(&path) => {
                edits.skipped.insert(path, reason);
                Ok(())
            }
            Self::Restore(restore) => restore.refused(path, reason),
            _ => Err(hook_refusal(path, reason)),
        }
    }
}

/// An upload: staged files and deletes, with what the client read.
pub(crate) struct Edits {
    /// The absolute folder the files are staged in.
    staging: PathBuf,
    files: Vec<StagedFile>,
    deletes: Vec<String>,
    base_rev: Option<String>,
    expected: BTreeMap<String, Option<String>>,
    /// A controller import: paths that may never be saved are left out
    /// (reported as skipped) instead of refusing the import, and tracked
    /// content is taken as is (no ignore check), as `git add --force` did.
    import: bool,
    /// New files are added even where the space's `.gitignore` ignores
    /// them (an `autoCommitAfterApply` apply: the controller seeding the
    /// managed project files, which the single-tenant apply force-adds).
    /// Every other rule still applies.
    add_ignored: bool,
    /// Blob ids of the files not skipped, by path, hashed on the first
    /// attempt. A skipped file is never hashed, so it never reaches the
    /// mirror.
    blobs: Option<HashMap<String, String>>,
    skipped: BTreeMap<String, RejectReason>,
    attempt: Option<Attempt>,
}

/// What one attempt learned about `main`.
struct Attempt {
    main_entries: HashMap<String, TreeEntry>,
    /// Written paths and deleted paths (folders expanded).
    touched: Vec<String>,
    /// Deletes looked up at the version the client read whose path `main`
    /// holds as the other kind now (a file became a folder, or a folder a
    /// file): there the delete removes nothing.
    swapped: Vec<String>,
}

impl Edits {
    pub(crate) fn new(
        staging: PathBuf,
        files: Vec<StagedFile>,
        deletes: Vec<String>,
        base_rev: Option<String>,
        expected: BTreeMap<String, Option<String>>,
        import: bool,
    ) -> Self {
        Self {
            staging,
            files,
            deletes,
            base_rev,
            expected,
            import,
            add_ignored: false,
            blobs: None,
            skipped: BTreeMap::new(),
            attempt: None,
        }
    }

    /// New files are added even where the space's `.gitignore` ignores
    /// them (see the field).
    pub(crate) fn adding_ignored(mut self, add_ignored: bool) -> Self {
        self.add_ignored = add_ignored;
        self
    }

    /// The paths an import left out.
    pub(crate) fn skipped(&self) -> Vec<SkippedPath> {
        self.skipped
            .iter()
            .map(|(path, reason)| SkippedPath {
                path: path.clone(),
                reason: reason.name(),
            })
            .collect()
    }

    /// How many staged files were kept (not skipped) and their size.
    pub(crate) fn kept(&self) -> (usize, u64) {
        self.files
            .iter()
            .filter(|file| !self.skipped.contains_key(&file.path))
            .fold((0, 0), |(count, bytes), file| {
                (count + 1, bytes.saturating_add(file.size))
            })
    }

    fn writes(&self, path: &str) -> bool {
        self.files.iter().any(|file| file.path == path)
    }

    /// Hash every staged file that is not skipped into the quarantine with
    /// one process.
    fn hash(&self, git: &WorkspaceGit<'_>) -> Result<HashMap<String, String>, OriginError> {
        let files: Vec<&StagedFile> = self
            .files
            .iter()
            .filter(|file| !self.skipped.contains_key(&file.path))
            .collect();
        if files.is_empty() {
            return Ok(HashMap::new());
        }
        let mut input = Vec::new();
        for file in &files {
            let path = self.staging.join(&file.staged_name);
            let text = path
                .to_str()
                .filter(|text| !text.chars().any(char::is_control))
                .ok_or_else(|| internal(format!("unusable staging path {path:?}")))?;
            input.extend_from_slice(text.as_bytes());
            input.push(b'\n');
        }
        let output = git
            .stdout_opts(
                &["hash-object", "-w", "--no-filters", "--stdin-paths"],
                &RunOpts {
                    stdin: Some(&input),
                    ..RunOpts::default()
                },
            )
            .map_err(internal)?;
        let blobs: Vec<String> = output.lines().map(str::to_string).collect();
        if blobs.len() != files.len() || !blobs.iter().all(|id| is_full_object_id(id)) {
            return Err(internal(format!(
                "hash-object printed {} ids for {} files",
                blobs.len(),
                files.len()
            )));
        }
        Ok(files
            .into_iter()
            .map(|file| file.path.clone())
            .zip(blobs)
            .collect())
    }

    fn build(
        &mut self,
        git: &WorkspaceGit<'_>,
        scratch: &Path,
        main: Option<&str>,
    ) -> Result<String, OriginError> {
        if self.blobs.is_none() {
            if self.import {
                for file in &self.files {
                    if let Some(reason) = unpublishable_reason(&file.path) {
                        self.skipped.insert(file.path.clone(), reason);
                    } else if file.size > MAX_PUBLISH_BLOB_BYTES {
                        self.skipped
                            .insert(file.path.clone(), RejectReason::TooLarge);
                    }
                }
            }
            self.blobs = Some(self.hash(git)?);
        }
        let Some(blobs) = self.blobs.as_ref() else {
            return Err(internal("an upload was built before it was hashed"));
        };
        let writes: Vec<(&StagedFile, &str)> = self
            .files
            .iter()
            .filter(|file| !self.skipped.contains_key(&file.path))
            .filter_map(|file| blobs.get(&file.path).map(|blob| (file, blob.as_str())))
            .collect();
        let request_paths = || -> Vec<String> {
            writes
                .iter()
                .map(|(file, _)| file.path.clone())
                .chain(self.deletes.iter().cloned())
                .collect()
        };

        // A base nothing here reaches cannot be compared with: the client
        // read a version this space's history does not have.
        let base = match &self.base_rev {
            Some(base) if Some(base.as_str()) == main => Some(base.as_str()),
            Some(base) => {
                if !readable(git, base).map_err(OriginError::from)? {
                    return Err(head_moved(main, request_paths()));
                }
                Some(base.as_str())
            }
            None => None,
        };

        // A person's save (not an import or the managed files' bootstrap):
        // its new paths are checked against the space's ignore rules and
        // the names `main` holds.
        let check_ignores = !self.import && !self.add_ignored;
        let mut wanted = BTreeSet::new();
        for (file, _) in &writes {
            wanted.insert(file.path.clone());
            wanted.extend(ancestors(&file.path));
            if check_ignores {
                wanted.extend(gitignores_for(&file.path));
            }
        }
        for delete in &self.deletes {
            wanted.insert(delete.clone());
            wanted.extend(ancestors(delete));
        }
        wanted.extend(self.expected.keys().cloned());
        let at_main = match main {
            Some(main) => entries_at(git, main, &wanted)?,
            None => HashMap::new(),
        };

        let mut unsupported = Vec::new();
        // Written over a link or submodule with a condition on what the
        // client read there (sorted below by what changed since).
        let mut hidden_read = Vec::new();
        let mut clashes = Vec::new();
        let mut refused: Vec<(String, RejectReason)> = Vec::new();
        let mut too_large = Vec::new();
        let mut new_paths = Vec::new();
        let mut additions: Vec<(String, String, String)> = Vec::new();
        for (file, blob) in &writes {
            let path = &file.path;
            let current = at_main.get(path);
            if let Some(entry) = current {
                if is_tree(entry) {
                    clashes.push(path.clone());
                    continue;
                }
                if !is_regular(&entry.mode) {
                    if self.expected.contains_key(path) {
                        hidden_read.push(path.clone());
                    } else {
                        unsupported.push(path.clone());
                    }
                    continue;
                }
            }
            if ancestors(path)
                .iter()
                .any(|folder| at_main.get(folder).is_some_and(|entry| !is_tree(entry)))
            {
                clashes.push(path.clone());
                continue;
            }
            let mode = if file.executable {
                "100755"
            } else {
                current.map_or("100644", |entry| entry.mode.as_str())
            };
            let changed = current.map_or(true, |entry| entry.mode != mode || entry.oid != *blob);
            if changed && !self.import {
                if current.is_none() && check_ignores {
                    new_paths.push(path.clone());
                }
                if let Some(reason) = unpublishable_reason(path) {
                    refused.push((path.clone(), reason));
                } else if file.size > MAX_PUBLISH_BLOB_BYTES {
                    too_large.push(path.clone());
                }
            }
            additions.push((mode.to_string(), blob.to_string(), path.clone()));
        }

        // Deletes: a folder is the files it held at the version the client
        // read (files added since stay); without that version only exact
        // files can be deleted.
        let at_base_deletes = match base {
            Some(base) if Some(base) != main && !self.deletes.is_empty() => {
                let set: BTreeSet<String> = self.deletes.iter().cloned().collect();
                Some(entries_at(git, base, &set)?)
            }
            _ => None,
        };
        let mut needs_base = Vec::new();
        let mut folders = Vec::new();
        let mut removals = Vec::new();
        for delete in &self.deletes {
            let entry = match &at_base_deletes {
                Some(at_base) => at_base.get(delete),
                None => at_main.get(delete),
            };
            match entry {
                Some(entry) if is_tree(entry) => {
                    if base.is_none() && !self.import {
                        needs_base.push(delete.clone());
                    } else {
                        folders.push(delete.clone());
                    }
                }
                _ => removals.push(delete.clone()),
            }
        }
        let swapped: Vec<String> = self
            .deletes
            .iter()
            .filter(|delete| {
                at_main
                    .get(delete.as_str())
                    .is_some_and(|entry| is_tree(entry) != folders.contains(delete))
            })
            .cloned()
            .collect();
        let expand_at = if at_base_deletes.is_some() {
            base
        } else {
            main
        };
        if let (Some(commit), false) = (expand_at, folders.is_empty()) {
            removals.extend(entries_below(git, commit, &folders)?);
        }
        for removed in &removals {
            if !deletion_allowed(removed) {
                refused.push((removed.clone(), RejectReason::Excluded));
            }
        }

        // A link or submodule the client said it read something at: 409 when
        // reading again shows something new (the path changed since the
        // version it read, or it named no version: then its read cannot
        // have been of this entry; the bootstrap reads again and leaves the
        // path alone), 400 when that version had this same entry.
        let unmatched = match base {
            _ if hidden_read.is_empty() => Vec::new(),
            _ if self.add_ignored => std::mem::take(&mut hidden_read),
            None => std::mem::take(&mut hidden_read),
            Some(base) if Some(base) == main => Vec::new(),
            Some(base) => {
                let paths: BTreeSet<String> = hidden_read.iter().cloned().collect();
                let at_base = entries_at(git, base, &paths)?;
                let (moved, same): (Vec<String>, Vec<String>) = hidden_read
                    .drain(..)
                    .partition(|path| differs(at_base.get(path), at_main.get(path)));
                hidden_read = same;
                moved
            }
        };
        unsupported.append(&mut hidden_read);
        // A 409 the client can act on (read again, leave the path alone)
        // rather than a refusal of the whole request.
        if !unmatched.is_empty() {
            return Err(head_moved(main, unmatched));
        }
        if !unsupported.is_empty() {
            return Err(unsupported_entry(unsupported));
        }
        if !needs_base.is_empty() {
            return Err(delete_requires_base_rev(needs_base));
        }
        if !clashes.is_empty() {
            return Err(path_type_conflict(main, clashes));
        }
        // The space's own ignore rules come first: a new `.env` the space
        // ignores is answered as ignored, one it does not as a secret.
        if !new_paths.is_empty() {
            let ignored = ignored_paths(git, scratch, &new_paths, &additions, &removals, &at_main)?;
            if !ignored.is_empty() {
                return Err(ignored_path(ignored));
            }
        }
        if !refused.is_empty() {
            return Err(excluded_path(refused));
        }
        if !too_large.is_empty() {
            return Err(policy_rejected(too_large, RejectReason::TooLarge));
        }

        let tree = build_tree(git, scratch, main, &removals, &additions)?;
        // A person's new path that a disk ignoring case takes for another
        // entry of the new tree: a Desktop checkout of the space could not
        // hold both, and on such a disk the save would write over the other
        // (Desktop refuses it too).
        if check_ignores {
            let added: Vec<&str> = additions
                .iter()
                .map(|(_, _, path)| path.as_str())
                .filter(|path| !at_main.contains_key(*path))
                .collect();
            let aliases = aliases_in(git, &tree, &added).map_err(internal)?;
            if !aliases.is_empty() {
                return Err(path_alias(main, aliases));
            }
        }
        let touched = additions
            .iter()
            .map(|(_, _, path)| path.clone())
            .chain(removals.iter().cloned())
            .collect();
        self.attempt = Some(Attempt {
            main_entries: at_main,
            touched,
            swapped,
        });
        Ok(tree)
    }

    /// What the client read must still be what `main` has: each `expected`
    /// path holds that blob (or nothing), and with a `baseRev` other than
    /// `main`, no touched path (or a folder it lies in) changed since.
    fn check(&self, git: &WorkspaceGit<'_>, main: Option<&str>) -> Result<(), OriginError> {
        let stale = self.stale(git, main)?;
        if stale.is_empty() {
            Ok(())
        } else {
            Err(head_moved(main, stale.into_iter().collect()))
        }
    }

    /// A tree equal to `main`'s needs nothing, unless a delete's path is
    /// now the other kind of entry: then the delete did nothing, and the
    /// client is told what changed since it read (with what [`Self::check`]
    /// finds).
    fn settled(&self, git: &WorkspaceGit<'_>, main: Option<&str>) -> Result<(), OriginError> {
        let Some(attempt) = &self.attempt else {
            return Err(internal("a change was checked before it was built"));
        };
        if attempt.swapped.is_empty() {
            return Ok(());
        }
        let mut stale = self.stale(git, main)?;
        stale.extend(attempt.swapped.iter().cloned());
        Err(head_moved(main, stale.into_iter().collect()))
    }

    /// The paths whose condition no longer holds on `main`.
    fn stale(
        &self,
        git: &WorkspaceGit<'_>,
        main: Option<&str>,
    ) -> Result<BTreeSet<String>, OriginError> {
        let Some(attempt) = &self.attempt else {
            return Err(internal("a change was checked before it was built"));
        };
        let mut stale = BTreeSet::new();
        for (path, wanted) in &self.expected {
            let have = attempt.main_entries.get(path).map(|entry| {
                if is_regular(&entry.mode) {
                    entry.oid.clone()
                } else {
                    format!("{} {}", entry.mode, entry.oid)
                }
            });
            if have.as_deref() != wanted.as_deref() {
                stale.insert(path.clone());
            }
        }
        if let Some(base) = self.base_rev.as_deref().filter(|base| Some(*base) != main) {
            stale.extend(moved_since(git, base, main, &attempt.touched)?);
        }
        Ok(stale)
    }
}

/// The paths of `touched` that `main` holds differently from `base` (the
/// version the client read), or that lie in a folder that does: what a
/// change made on `base` would overwrite unseen.
pub(super) fn moved_since(
    git: &WorkspaceGit<'_>,
    base: &str,
    main: Option<&str>,
    touched: &[String],
) -> Result<BTreeSet<String>, OriginError> {
    let mut compared: BTreeSet<String> = BTreeSet::new();
    for path in touched {
        compared.insert(path.clone());
        compared.extend(ancestors(path));
    }
    let at_base = entries_at(git, base, &compared)?;
    let at_main = match main {
        Some(main) => entries_at(git, main, &compared)?,
        None => HashMap::new(),
    };
    Ok(touched
        .iter()
        .filter(|path| {
            differs(at_base.get(*path), at_main.get(*path))
                || ancestors(path)
                    .iter()
                    .any(|folder| differs(at_base.get(folder), at_main.get(folder)))
        })
        .cloned()
        .collect())
}

/// The new paths (of `paths`, none of which `main` has) that the
/// `.gitignore` files of the new tree (`main` with `removals` gone and
/// `additions` in place) ignore.
fn ignored_paths(
    git: &WorkspaceGit<'_>,
    scratch: &Path,
    paths: &[String],
    additions: &[(String, String, String)],
    removals: &[String],
    at_main: &HashMap<String, TreeEntry>,
) -> Result<Vec<String>, OriginError> {
    let added: HashMap<&str, (&str, &str)> = additions
        .iter()
        .map(|(mode, oid, path)| (path.as_str(), (mode.as_str(), oid.as_str())))
        .collect();
    let removed: HashSet<&str> = removals.iter().map(String::as_str).collect();
    let mut rules: BTreeMap<String, String> = BTreeMap::new();
    for path in paths {
        for candidate in gitignores_for(path) {
            if rules.contains_key(&candidate) {
                continue;
            }
            let blob = match added.get(candidate.as_str()) {
                Some((mode, oid)) => is_regular(mode).then(|| oid.to_string()),
                None if removed.contains(candidate.as_str()) => None,
                None => at_main
                    .get(&candidate)
                    .filter(|entry| is_regular(&entry.mode))
                    .map(|entry| entry.oid.clone()),
            };
            if let Some(blob) = blob {
                rules.insert(candidate, blob);
            }
        }
    }
    check_ignored(git, scratch, &rules, paths).map_err(internal)
}

/// `main`'s tree (empty without `main`) with `removals` gone and
/// `additions` (`mode`, `oid`, `path`) in place, written to the quarantine.
fn build_tree(
    git: &WorkspaceGit<'_>,
    scratch: &Path,
    main: Option<&str>,
    removals: &[String],
    additions: &[(String, String, String)],
) -> Result<String, OriginError> {
    let index = scratch.join(format!("index-{}", Uuid::new_v4().simple()));
    let opts = RunOpts {
        index_file: Some(&index),
        ..RunOpts::default()
    };
    let result = (|| -> Result<String, OriginError> {
        if let Some(main) = main {
            git.ok_opts(&["read-tree", main], &opts).map_err(internal)?;
        }
        let zero = zero_oid(
            main.or(additions.first().map(|(_, oid, _)| oid.as_str()))
                .unwrap_or(""),
        );
        let mut info = Vec::new();
        for path in removals {
            info.extend_from_slice(format!("0 {zero}\t{path}").as_bytes());
            info.push(0);
        }
        for (mode, oid, path) in additions {
            info.extend_from_slice(format!("{mode} {oid} 0\t{path}").as_bytes());
            info.push(0);
        }
        if !info.is_empty() {
            git.ok_opts(
                &["update-index", "-z", "--index-info"],
                &RunOpts {
                    index_file: Some(&index),
                    stdin: Some(&info),
                    ..RunOpts::default()
                },
            )
            .map_err(internal)?;
        }
        git.stdout_opts(&["write-tree"], &opts).map_err(internal)
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// The inverse of `commit` (relative to `base`, an ancestor of it) applied
/// to `main` with a three-way merge.
pub(crate) struct Revert {
    commit: String,
    base: String,
}

impl Revert {
    pub(crate) fn new(commit: String, base: String) -> Self {
        Self { commit, base }
    }

    fn build(&mut self, git: &WorkspaceGit<'_>, main: Option<&str>) -> Result<String, OriginError> {
        let Some(main) = main else {
            return Err(rev_not_on_main(None));
        };
        if !git.is_ancestor(&self.commit, main).map_err(internal)? {
            return Err(rev_not_on_main(Some(main)));
        }
        let merged = three_way(git, Some(&self.commit), main, &self.base).map_err(internal)?;
        if !merged.conflicts.is_empty() {
            return Err(revert_conflict(main, merged.conflicts));
        }
        // The inverse may bring back what may never be saved.
        let raw = git
            .bytes(&[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--raw",
                main,
                &merged.tree,
            ])
            .map_err(internal)?;
        let mut refused = Vec::new();
        for change in parse_raw_changes(&raw) {
            if change.status == 'D' {
                if !deletion_allowed(&change.path) {
                    refused.push((change.path, RejectReason::Excluded));
                }
            } else if let Some(reason) = unpublishable_reason(&change.path) {
                refused.push((change.path, reason));
            }
        }
        if !refused.is_empty() {
            return Err(excluded_path(refused));
        }
        Ok(merged.tree)
    }
}
