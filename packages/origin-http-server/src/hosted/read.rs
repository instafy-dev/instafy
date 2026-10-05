//! What the gateway's read routes show of one commit of a mirror: folder
//! listings, files, first-parent history, a commit's changed paths, diffs
//! and the recovery list. Everything reads git objects only (there is no
//! work tree) and blocks; the routes run it off the async threads.

use std::path::Path;

use crate::git::{
    is_full_object_id, is_sync_reserved_path, DirtyPathEntry, GitHistoryEntry, HistoryActor,
};
use crate::publish_policy::MAX_PUBLISH_BLOB_BYTES;
use crate::recovery_view::{
    absence_at, describe, fetch_refs, first_parent_history, list_remote_refs, mark_restored,
    read_blob_at, read_tree_at, resolve, Absence, BlobRead, ObjectEntry, ObjectKind, ReadAt,
    RecoveryItem, TreeRead, ViewError,
};
use crate::routes::{mime_type_for_extension, FileEntryResponse};
use crate::workspace_git::{RunOpts, WorkspaceGit};

/// The largest file a read returns (the largest a save accepts).
pub(crate) const MAX_READ_BYTES: u64 = MAX_PUBLISH_BLOB_BYTES;

/// The longest diff a read returns.
const MAX_DIFF_BYTES: usize = 200_000;

/// A folder listing, or why there is none.
pub(crate) enum EntriesRead {
    Listed(Vec<FileEntryResponse>),
    Missing(Absence),
}

/// The entries at `path` (the root when `None`) of `commit` (`None`: an
/// empty space): a folder's children, or a file's own entry.
pub(crate) fn entries(
    git: &WorkspaceGit<'_>,
    commit: Option<&str>,
    path: Option<&str>,
) -> Result<EntriesRead, ViewError> {
    let Some(commit) = commit else {
        return Ok(match path {
            None => EntriesRead::Listed(Vec::new()),
            Some(_) => EntriesRead::Missing(Absence::Absent),
        });
    };
    Ok(match read_tree_at(git, commit, path.unwrap_or(""))? {
        TreeRead::Directory(children) => {
            let mut listed: Vec<FileEntryResponse> = children.iter().map(entry_response).collect();
            listed.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            EntriesRead::Listed(listed)
        }
        TreeRead::File(entry) => EntriesRead::Listed(vec![entry_response(&entry)]),
        TreeRead::Missing => {
            EntriesRead::Missing(absence_at(git, commit, path.unwrap_or_default())?)
        }
    })
}

/// One listed entry in the shape the single-tenant `/entries` uses, with
/// the blob id and without a modification time (commits have none per
/// file).
fn entry_response(entry: &ObjectEntry) -> FileEntryResponse {
    let name = entry
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&entry.path)
        .to_string();
    match entry.kind {
        ObjectKind::Directory => FileEntryResponse {
            name,
            path: entry.path.clone(),
            kind: "directory".to_string(),
            size: None,
            modified: None,
            extension: None,
            // Git trees are never empty, though every child may be hidden.
            has_children: true,
            mime_type: None,
            blob_oid: None,
        },
        ObjectKind::File => {
            let extension = Path::new(&entry.path)
                .extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_string);
            FileEntryResponse {
                name,
                path: entry.path.clone(),
                kind: "file".to_string(),
                size: entry.size,
                modified: None,
                mime_type: extension.as_deref().and_then(mime_type_for_extension),
                extension,
                has_children: false,
                blob_oid: Some(entry.oid.clone()),
            }
        }
    }
}

/// A file read, or why there is none.
pub(crate) enum FileRead {
    Found { oid: String, data: Vec<u8> },
    TooLarge,
    Missing(Absence),
}

/// The regular file at `path` of `commit` (`None`: an empty space).
pub(crate) fn file(
    git: &WorkspaceGit<'_>,
    commit: Option<&str>,
    path: &str,
) -> Result<FileRead, ViewError> {
    let Some(commit) = commit else {
        return Ok(FileRead::Missing(Absence::Absent));
    };
    Ok(match read_blob_at(git, commit, path, MAX_READ_BYTES)? {
        BlobRead::Found { oid, data, .. } => FileRead::Found { oid, data },
        BlobRead::TooLarge { .. } => FileRead::TooLarge,
        BlobRead::Missing => FileRead::Missing(absence_at(git, commit, path)?),
    })
}

/// A commit, after `resolve`: readable here (main or a branch reaches it).
pub(crate) fn readable(git: &WorkspaceGit<'_>, rev: &str) -> Result<bool, ViewError> {
    match resolve(git, "", &ReadAt::Rev(rev.to_string())) {
        Ok(_) => Ok(true),
        Err(ViewError::RevNotFound) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Whether `rev` is on `main`'s history (`main` included).
pub(crate) fn on_main(git: &WorkspaceGit<'_>, rev: &str, main: &str) -> Result<bool, ViewError> {
    if !readable(git, rev)? {
        return Ok(false);
    }
    Ok(git.is_ancestor(rev, main)?)
}

/// One page of `head`'s first-parent history (each entry with its first
/// parent, parent count and actor), and whether more follows.
pub(crate) fn history(
    git: &WorkspaceGit<'_>,
    head: &str,
    limit: usize,
    skip: usize,
    gateway_email: &str,
) -> Result<(Vec<GitHistoryEntry>, bool), ViewError> {
    let mut entries = first_parent_history(git, head, limit, skip)?;
    for entry in &mut entries {
        entry.actor = Some(HistoryActor::of_author(&entry.author_email, gateway_email));
    }
    let has_more = entries.len() == limit && has_commit_after(git, head, skip + limit)?;
    Ok((entries, has_more))
}

/// Whether `head`'s first-parent chain has a commit after the first
/// `skip`.
fn has_commit_after(git: &WorkspaceGit<'_>, head: &str, skip: usize) -> Result<bool, ViewError> {
    // Git reads the count as an int.
    if skip > i32::MAX as usize {
        return Ok(false);
    }
    let skip = skip.to_string();
    let listed = git.stdout(&[
        "rev-list",
        "--first-parent",
        "--max-count",
        "1",
        "--skip",
        &skip,
        "--end-of-options",
        head,
        "--",
    ])?;
    Ok(!listed.trim().is_empty())
}

/// The parents of `commit`.
pub(crate) fn parents(git: &WorkspaceGit<'_>, commit: &str) -> Result<Vec<String>, ViewError> {
    let listed = git.stdout(&[
        "rev-list",
        "--parents",
        "--max-count",
        "1",
        "--end-of-options",
        commit,
        "--",
    ])?;
    let ids: Vec<&str> = listed.split_whitespace().collect();
    if ids.first() != Some(&commit) || !ids.iter().all(|id| is_full_object_id(id)) {
        return Err(anyhow::anyhow!("rev-list printed {listed:?} for {commit}").into());
    }
    Ok(ids[1..].iter().map(|id| id.to_string()).collect())
}

/// The paths `commit` changed against its first parent (everything, for a
/// root commit), with renames and copies, as status letters; reserved and
/// sync-reserved paths are left out. Also the commit's parent count.
pub(crate) fn review(
    git: &WorkspaceGit<'_>,
    commit: &str,
) -> Result<(Vec<DirtyPathEntry>, usize), ViewError> {
    let parents = parents(git, commit)?;
    let raw = match parents.first() {
        Some(first) => git.bytes(&[
            "diff-tree",
            "-r",
            "-z",
            "--name-status",
            "-M",
            "-C",
            first,
            commit,
        ])?,
        None => git.bytes(&[
            "diff-tree",
            "-r",
            "-z",
            "--name-status",
            "-M",
            "-C",
            "--root",
            "--no-commit-id",
            commit,
        ])?,
    };
    let mut entries = parse_name_status(&raw);
    entries.retain(|entry| !is_sync_reserved_path(&entry.path));
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries.dedup_by(|a, b| a.path == b.path);
    Ok((entries, parents.len()))
}

/// `diff-tree -z --name-status` records: a status, then one path, or two
/// for a rename or copy (the new path is the one listed).
fn parse_name_status(raw: &[u8]) -> Vec<DirtyPathEntry> {
    let mut fields = raw
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).to_string());
    let mut entries = Vec::new();
    while let Some(status) = fields.next() {
        let Some(code) = status.chars().next() else {
            continue;
        };
        let path = if matches!(code, 'R' | 'C') {
            let _from = fields.next();
            fields.next()
        } else {
            fields.next()
        };
        let Some(path) = path.filter(|path| !path.is_empty()) else {
            continue;
        };
        entries.push(DirtyPathEntry {
            path,
            code: code.to_string(),
            embedded_repo_root: None,
        });
    }
    entries
}

/// One path's diff, from objects only:
/// - `base` and `commit`: between them;
/// - `commit` only: against its first parent (the empty tree for a root);
/// - `base` only: from `base` to `main`;
/// - neither: the last first-parent change of the path on `main`.
///
/// Returns the text (cut at [`MAX_DIFF_BYTES`]) and whether it was cut.
pub(crate) fn diff(
    git: &WorkspaceGit<'_>,
    base: Option<&str>,
    commit: Option<&str>,
    main: Option<&str>,
    path: &str,
) -> Result<(String, bool), ViewError> {
    let text = match (base, commit, main) {
        (Some(base), Some(commit), _) | (Some(base), None, Some(commit)) => {
            diff_between(git, base, commit, path)?
        }
        (None, Some(commit), _) => match parents(git, commit)?.first() {
            Some(first) => diff_between(git, first, commit, path)?,
            None => {
                let empty = git.empty_tree()?;
                diff_between(git, &empty, commit, path)?
            }
        },
        (None, None, Some(main)) => {
            let raw = git.bytes_opts(
                &[
                    "log",
                    "-1",
                    "--first-parent",
                    "--format=",
                    "--patch",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--end-of-options",
                    main,
                    "--",
                    path,
                ],
                &RunOpts {
                    literal_pathspecs: true,
                    ..RunOpts::default()
                },
            )?;
            String::from_utf8_lossy(&raw).trim_start().to_string()
        }
        (_, None, None) => String::new(),
    };
    Ok(cut_diff(text))
}

fn diff_between(
    git: &WorkspaceGit<'_>,
    base: &str,
    head: &str,
    path: &str,
) -> Result<String, ViewError> {
    let raw = git.bytes_opts(
        &[
            "diff",
            "--patch",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            base,
            head,
            "--",
            path,
        ],
        &RunOpts {
            literal_pathspecs: true,
            ..RunOpts::default()
        },
    )?;
    Ok(String::from_utf8_lossy(&raw).to_string())
}

/// `text` cut at [`MAX_DIFF_BYTES`] on a character boundary, with a note.
fn cut_diff(mut text: String) -> (String, bool) {
    if text.len() <= MAX_DIFF_BYTES {
        return (text.trim_end().to_string(), false);
    }
    let mut end = MAX_DIFF_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n… (diff truncated)\n");
    (text.trim_end().to_string(), true)
}

/// The recovery and salvage refs on `remote` that a person can review,
/// newest first: listed, fetched and described against `main`, each marked
/// with the newest commit on `main` that restored it (`restoredRev`), by
/// the rule Desktop lists them by ([`mark_restored`]: a restore commit the
/// gateway committed, whose whole message names the ref).
pub(crate) fn recovery_list(
    git: &WorkspaceGit<'_>,
    remote: &str,
    main: Option<&str>,
    gateway_email: &str,
) -> Result<Vec<RecoveryItem>, ViewError> {
    let listed = list_remote_refs(git, remote)?;
    let fetched = fetch_refs(git, remote, &listed)?;
    let mut items = describe(git, &fetched.fetched, main)?;
    mark_restored(git, &mut items, main, gateway_email)?;
    Ok(items)
}
