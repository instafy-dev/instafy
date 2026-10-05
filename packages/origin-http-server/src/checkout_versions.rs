//! Saved versions and unsaved work on a single-tenant checkout (a Desktop
//! folder or a workspace runtime): reads at `?rev=` and `?ref=`, and the
//! unsaved-work list.
//!
//! Everything here reads objects from the checkout's `.instafy/.git`
//! through [`WorkspaceGit`] and never the work tree, so a read at a version
//! shows exactly what that commit holds, whatever the folder has now.
//! Recovery and salvage refs are fetched by their exact names from the
//! canonical repository on every call (see [`crate::recovery_view`]).
//! Restoring unsaved work changes the checkout and goes through the publish
//! (`publish::restore`); dismissing it is [`recovery_view::dismiss`].

use crate::recovery_view::{
    self, describe, fetch_refs, list_remote_refs, path_kind_at, read_blob_at, read_tree_at,
    resolve_ref, resolve_rev_fetching_main, unreachable, BlobRead, ObjectEntry, PathKind, ReadAt,
    RecoveryItem, RecoveryRef, TreeRead, ViewError,
};
use crate::workspace_git::WorkspaceGit;

/// The commit a read at a version shows, and the id it reports in
/// `X-Instafy-Rev`: the commit for `?rev=`, the ref's own id (its tip, the
/// one the unsaved-work list shows) for `?ref=`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedRead {
    pub commit: String,
    pub served_rev: String,
}

/// Resolve a read at `at` on a checkout: `None` for `main` (the caller
/// reads the work tree, as before). A `rev` is read when the checkout
/// holds it, or after fetching canonical `main` once; a `ref` is resolved
/// on `remote` by exactly its name. With no `remote` (no canonical
/// repository), only commits already here are read.
pub(crate) fn resolve_read(
    git: &WorkspaceGit<'_>,
    remote: Option<&str>,
    at: &ReadAt,
) -> Result<Option<ResolvedRead>, ViewError> {
    match at {
        ReadAt::Main => Ok(None),
        ReadAt::Rev(rev) => {
            let commit = resolve_rev_fetching_main(git, remote, rev)?;
            Ok(Some(ResolvedRead {
                served_rev: commit.clone(),
                commit,
            }))
        }
        ReadAt::Ref(reference) => {
            let remote = remote.ok_or(ViewError::RefNotFound)?;
            let fetched = resolve_ref(git, remote, reference)?;
            Ok(Some(ResolvedRead {
                commit: fetched.commit,
                served_rev: fetched.tip,
            }))
        }
    }
}

/// A file of a commit, as `/files` and `/raw` serve it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FileAt {
    Found {
        oid: String,
        data: Vec<u8>,
    },
    /// Larger than reads serve; nothing was read.
    TooLarge {
        size: u64,
    },
    /// No regular file is there: what is there instead.
    Missing(PathKind),
}

/// The regular file at `path` in `commit`, up to `max_bytes`.
pub(crate) fn file_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
    max_bytes: u64,
) -> Result<FileAt, ViewError> {
    Ok(match read_blob_at(git, commit, path, max_bytes)? {
        BlobRead::Found { oid, data, .. } => FileAt::Found { oid, data },
        BlobRead::TooLarge { size, .. } => FileAt::TooLarge { size },
        BlobRead::Missing => FileAt::Missing(path_kind_at(git, commit, path)?),
    })
}

/// A listing of a commit, as `/entries` serves it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum EntriesAt {
    /// A folder's shown children, or a file's own entry.
    Listed(Vec<ObjectEntry>),
    /// Nothing that may be listed is there: what is there instead.
    Missing(PathKind),
}

/// The listing of `path` ("" for the root) in `commit`.
pub(crate) fn entries_at(
    git: &WorkspaceGit<'_>,
    commit: &str,
    path: &str,
) -> Result<EntriesAt, ViewError> {
    Ok(match read_tree_at(git, commit, path)? {
        TreeRead::Directory(entries) => EntriesAt::Listed(entries),
        TreeRead::File(entry) => EntriesAt::Listed(vec![entry]),
        TreeRead::Missing => EntriesAt::Missing(path_kind_at(git, commit, path)?),
    })
}

/// Fetch the recovery or salvage ref `name` by its exact name so a review
/// or diff of it reads objects that are here; returns its tip.
pub(crate) fn fetch_ref_for_review(
    git: &WorkspaceGit<'_>,
    remote: Option<&str>,
    name: &str,
) -> Result<String, ViewError> {
    let reference = RecoveryRef::validate(git, name)?;
    let remote = remote.ok_or(ViewError::RefNotFound)?;
    Ok(resolve_ref(git, remote, &reference)?.tip)
}

/// Every recovery and salvage ref on `remote`, newest first (at most
/// [`recovery_view::MAX_RECOVERY_ITEMS`]), each with its merge base with
/// the checkout's `HEAD` (which a review and a restore compare against)
/// and, when a restore commit this origin (`service_email`) made names it,
/// `restoredRev`.
///
/// A restore counts only once canonical `main` has it: restore commits are
/// looked for on `canonical_main` (the checkout's tracking ref of the
/// canonical branch, which moves on every fetch and after every publish
/// that reached `main`), never on `HEAD`, which also holds a restore whose
/// publish failed.
pub(crate) fn list_unsaved_work(
    git: &WorkspaceGit<'_>,
    remote: &str,
    canonical_main: &str,
    service_email: &str,
) -> Result<Vec<RecoveryItem>, ViewError> {
    let listed = list_remote_refs(git, remote).map_err(unreachable)?;
    let fetched = fetch_refs(git, remote, &listed).map_err(unreachable)?;
    let head = git.commit_id("HEAD")?;
    let mut items = describe(git, &fetched.fetched, head.as_deref())?;
    let main = git.commit_id(canonical_main)?;
    recovery_view::mark_restored(git, &mut items, main.as_deref(), service_email)?;
    Ok(items)
}
