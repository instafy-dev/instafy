//! One-time repair of checkouts left behind by the old sync.
//!
//! Before publish-by-merge, a sync moved the branch onto the remote tip with
//! `reset --mixed <remote>/<branch>` whenever the remote had moved, or after
//! a push failed, then committed only the paths it was asked about. Every
//! other file stayed in the work tree as it was: files the remote edited
//! looked locally modified, files it added looked deleted, and the files of
//! a local commit the reset abandoned looked like unsaved edits. Saving
//! "everything dirty" from such a checkout would quietly undo the remote's
//! changes.
//!
//! This runs once per checkout, under the apply lock, before its first
//! publish, refresh, flush or Desktop status count. For each changed path it
//! takes the newest reset whose old head held exactly the file's current
//! content (else the latest reset), and the merge base B of that old head
//! and HEAD:
//! - HEAD has B's version: the file is a local edit (including the work of
//!   an abandoned local commit) and stays;
//! - the file has B's version: it is a copy of the saved version from before
//!   the reset, and gets HEAD's version back (after an older reset, it is
//!   parked first);
//! - otherwise both changed it: the edits are merged onto HEAD's version when
//!   they do not conflict, and anything else is parked on a `stale` recovery
//!   ref first, then restored.
//!
//! Every file the repair replaces is first kept on a local backup ref that is
//! never pushed. Files that may never be published (secrets, attachments,
//! build output, oversized files) are never parked and never replaced: they
//! stay on disk only. Without a reflog, modifications that match an older
//! version of the path, and deletions, are parked and restored.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use tracing::{info, warn};

use crate::config::ServerConfig;
use crate::publish_policy::{is_unpublishable, is_unsafe_path, MAX_PUBLISH_BLOB_BYTES};
use crate::recovery::{self, RecoveryKind, RecoveryRefReport, RecoverySpec};
use crate::tree_merge::changed_paths;
use crate::workspace_fs::WorkspaceDir;
use crate::workspace_git::{
    nul_list, temp_index_dir, GitIdentity, RunOpts, TreeEntry, WorkspaceGit,
};

/// Marker file inside the repository: present once the repair has run.
const MARKER: &str = ".instafy/.git/instafy-stale-align-v1";
/// Local ref holding a copy of every file the repair replaced. Never pushed.
pub(crate) const BACKUP_REF: &str = "refs/instafy/stale-align-backup";
/// How many old resets to compare against.
const MAX_RESETS: usize = 20;
/// How many older versions of a path to compare against without a reflog.
const MAX_HISTORY: usize = 200;

#[derive(Debug, Default)]
pub(crate) struct StaleRepair {
    pub restored: Vec<String>,
    pub merged: Vec<String>,
    pub parked: Option<RecoveryRefReport>,
    pub parked_paths: Vec<String>,
    /// Paths that may not be published, left on disk as they were.
    pub kept_local: Vec<String>,
}

/// Run the repair if this checkout has not had it yet.
pub(crate) fn repair_once(git: &WorkspaceGit<'_>, config: &ServerConfig) -> Result<StaleRepair> {
    let workspace = WorkspaceDir::open(git.root())?;
    if workspace.entry_kind(MARKER).is_ok() {
        return Ok(StaleRepair::default());
    }
    // A checkout without commits has nothing an old sync could have left.
    if git.commit_id("HEAD")?.is_none() {
        return Ok(StaleRepair::default());
    }
    let repair = repair(git, config, &workspace)?;
    if !repair.restored.is_empty() || !repair.merged.is_empty() || repair.parked.is_some() {
        info!(
            restored = repair.restored.len(),
            merged = repair.merged.len(),
            parked = repair.parked_paths.len(),
            kept_local = repair.kept_local.len(),
            "repaired files left behind by an earlier sync"
        );
    }
    let mut marker: &[u8] = b"repaired\n";
    workspace.replace_file(MARKER, &mut marker, false)?;
    Ok(repair)
}

fn repair(
    git: &WorkspaceGit<'_>,
    config: &ServerConfig,
    workspace: &WorkspaceDir,
) -> Result<StaleRepair> {
    let mut outcome = StaleRepair::default();
    let Some(head) = git.commit_id("HEAD")? else {
        return Ok(outcome);
    };
    let mut dirty = dirty_tracked_paths(git, &head)?;

    let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
    let resets = match read_reflog(workspace) {
        Some(lines) => old_heads_before_resets(&lines, &remote_branch),
        None => {
            // No reflog at all: fall back to ORIG_HEAD, else history search.
            match git.commit_id("ORIG_HEAD")? {
                Some(orig) => vec![orig],
                None => return repair_without_reflog(git, config, workspace, &head, &dirty),
            }
        }
    };
    let resets: Vec<String> = resets
        .into_iter()
        .filter_map(|rev| git.commit_id(&rev).ok().flatten())
        .take(MAX_RESETS)
        .collect();
    if resets.is_empty() {
        return Ok(outcome);
    }
    // Files a reset left behind untracked: the old head had them, HEAD not.
    let mut changed_since_reset: BTreeSet<String> = BTreeSet::new();
    for old in &resets {
        changed_since_reset.extend(changed_paths(git, old, &head)?);
    }
    for path in untracked_paths(git)? {
        if changed_since_reset.contains(&path) {
            dirty.push(path);
        }
    }
    dirty.sort();
    dirty.dedup();
    if dirty.is_empty() {
        return Ok(outcome);
    }

    // What the work tree holds for each dirty path, as git would store it.
    let worktree = worktree_entries(git, &head, &dirty)?;
    let head_entries = git.tree_entries(&head, &dirty)?;
    // The merge base of each old head and HEAD: the last saved version both
    // agree on. For a reset onto a newer remote tip it is the old head
    // itself; for a reset that abandoned a local commit it is that commit's
    // parent, so the commit's own edits count as local work.
    let mut old_entries = Vec::with_capacity(resets.len());
    let mut base_entries = Vec::with_capacity(resets.len());
    for old in &resets {
        old_entries.push(git.tree_entries(old, &dirty)?);
        base_entries.push(match git.merge_base(old, &head)? {
            Some(base) => git.tree_entries(&base, &dirty)?,
            None => BTreeMap::new(),
        });
    }

    let mut restore = Vec::new();
    let mut park = Vec::new();
    let mut merged: Vec<(String, Vec<u8>)> = Vec::new();
    for path in &dirty {
        let current = worktree.get(path);
        let head_entry = head_entries.get(path);
        let reference = old_entries
            .iter()
            .position(|entries| same_entry(entries.get(path), current))
            .unwrap_or(0);
        let base_entry = base_entries[reference].get(path);
        if same_entry(base_entry, head_entry) {
            // HEAD has the version both agree on: whatever the file holds
            // is a local edit, possibly from a commit the reset abandoned.
            continue;
        }
        if same_entry(base_entry, current) {
            // A copy of the saved version from before the reset, which HEAD
            // has since changed. After an older reset, keep a copy anyway.
            if reference == 0 {
                restore.push(path.clone());
            } else {
                park.push(path.clone());
            }
            continue;
        }
        match merge_onto_head(git, base_entry, head_entry, current)? {
            Some(content) => merged.push((path.clone(), content)),
            None => park.push(path.clone()),
        }
    }

    let mut touched: Vec<String> = restore.clone();
    touched.extend(park.iter().cloned());
    touched.extend(merged.iter().map(|(path, _)| path.clone()));
    if touched.is_empty() {
        return Ok(outcome);
    }
    backup_worktree(git, config, &head, &touched)?;

    // Never replace, and never park, what may not be published.
    let (park, kept_local) = split_parkable(git, &worktree, park)?;
    let restore: Vec<String> = restore
        .into_iter()
        .filter(|path| !is_unpublishable(path))
        .collect();
    outcome.kept_local = kept_local;

    for (path, content) in &merged {
        write_worktree_file(workspace, path, content, head_entries.get(path))?;
        outcome.merged.push(path.clone());
    }
    let mut restore = restore;
    if !park.is_empty() {
        outcome.parked = park_paths(git, config, &head, &park)?;
        outcome.parked_paths = park.clone();
        restore.extend(park);
    }
    restore_from_head(git, workspace, &restore)?;
    outcome.restored = restore;
    Ok(outcome)
}

/// Without any reflog, a dirty path that matches an older version of itself
/// (or a deletion) cannot be told apart from a leftover, so it is parked.
fn repair_without_reflog(
    git: &WorkspaceGit<'_>,
    config: &ServerConfig,
    workspace: &WorkspaceDir,
    head: &str,
    dirty: &[String],
) -> Result<StaleRepair> {
    if dirty.is_empty() {
        return Ok(StaleRepair::default());
    }
    let mut outcome = StaleRepair::default();
    let worktree = worktree_entries(git, head, dirty)?;
    let mut park = Vec::new();
    for path in dirty {
        let Some(current) = worktree.get(path) else {
            park.push(path.clone());
            continue;
        };
        let raw = git.stdout_opts(
            &[
                "rev-list",
                &format!("--max-count={MAX_HISTORY}"),
                head,
                "--",
                path,
            ],
            &RunOpts {
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
        let mut matched = false;
        for rev in raw.lines().skip(1) {
            let entries = git.tree_entries(rev, std::slice::from_ref(path))?;
            if same_entry(entries.get(path), Some(current)) {
                matched = true;
                break;
            }
        }
        if matched {
            park.push(path.clone());
        }
    }
    if park.is_empty() {
        return Ok(outcome);
    }
    backup_worktree(git, config, head, &park)?;
    let (park, kept_local) = split_parkable(git, &worktree, park)?;
    outcome.kept_local = kept_local;
    if park.is_empty() {
        return Ok(outcome);
    }
    outcome.parked = park_paths(git, config, head, &park)?;
    restore_from_head(git, workspace, &park)?;
    outcome.parked_paths = park.clone();
    outcome.restored = park;
    Ok(outcome)
}

/// Split `paths` into those a recovery ref may carry and those that may
/// never be published (by name, as an unsafe path, or by size), which stay
/// on disk only.
fn split_parkable(
    git: &WorkspaceGit<'_>,
    worktree: &BTreeMap<String, TreeEntry>,
    paths: Vec<String>,
) -> Result<(Vec<String>, Vec<String>)> {
    let ids: Vec<String> = paths
        .iter()
        .filter_map(|path| worktree.get(path))
        .filter(|entry| entry.kind == "blob")
        .map(|entry| entry.oid.clone())
        .collect();
    let sizes: BTreeMap<String, u64> = ids
        .iter()
        .cloned()
        .zip(git.object_sizes(&ids)?)
        .filter_map(|(id, size)| size.map(|(_, size)| (id, size)))
        .collect();
    let (parkable, local): (Vec<String>, Vec<String>) = paths.into_iter().partition(|path| {
        if is_unpublishable(path) || is_unsafe_path(path) {
            return false;
        }
        !worktree.get(path).is_some_and(|entry| {
            entry.kind != "blob"
                || sizes
                    .get(&entry.oid)
                    .is_some_and(|size| *size > MAX_PUBLISH_BLOB_BYTES)
        })
    });
    if !local.is_empty() {
        warn!(
            paths = local.len(),
            "kept files that may not be published on disk only"
        );
    }
    Ok((parkable, local))
}

/// Keep a local copy of HEAD plus the work tree's version of `paths` on
/// [`BACKUP_REF`], which nothing pushes, before the repair replaces them.
fn backup_worktree(
    git: &WorkspaceGit<'_>,
    config: &ServerConfig,
    head: &str,
    paths: &[String],
) -> Result<()> {
    let scratch = temp_index_dir(git)?;
    let index = scratch.path().join("index");
    let opts = RunOpts {
        index_file: Some(&index),
        ..RunOpts::default()
    };
    git.ok_opts(&["read-tree", head], &opts)?;
    let in_head = git.tree_entries(head, paths)?;
    let known: Vec<String> = paths
        .iter()
        .filter(|path| {
            in_head.contains_key(*path) || std::fs::symlink_metadata(git.root().join(path)).is_ok()
        })
        .cloned()
        .collect();
    if !known.is_empty() {
        let list = nul_list(&known);
        git.ok_opts(
            &[
                "add",
                "-A",
                "--ignore-errors",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            &RunOpts {
                index_file: Some(&index),
                stdin: Some(&list),
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
    }
    let tree = git.stdout_opts(&["write-tree"], &opts)?;
    let identity = GitIdentity::new(&config.git_author_name, &config.git_author_email);
    let backup = git.commit_tree(
        &tree,
        &[head],
        &identity,
        &identity,
        b"Keep the files a one-time repair replaced\n\nA local copy only; it is never pushed.\n",
    )?;
    git.ok(&[
        "update-ref",
        "-m",
        "instafy: keep files the repair replaced",
        BACKUP_REF,
        &backup,
    ])
}

fn same_entry(a: Option<&TreeEntry>, b: Option<&TreeEntry>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.mode == b.mode && a.oid == b.oid,
        _ => false,
    }
}

/// Tracked paths whose work tree content differs from HEAD.
fn dirty_tracked_paths(git: &WorkspaceGit<'_>, head: &str) -> Result<Vec<String>> {
    let raw = git.bytes(&["diff-index", "-z", "--no-renames", "--name-only", head])?;
    let mut paths: Vec<String> = raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| std::str::from_utf8(record).ok().map(str::to_string))
        .filter(|path| !crate::git::is_sync_reserved_path(path))
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// `(mode, oid)` of each path as `git add` would record it; absent paths are
/// missing from the map.
pub(crate) fn worktree_entries(
    git: &WorkspaceGit<'_>,
    head: &str,
    paths: &[String],
) -> Result<BTreeMap<String, TreeEntry>> {
    let scratch = temp_index_dir(git)?;
    let index = scratch.path().join("index");
    let opts = RunOpts {
        index_file: Some(&index),
        ..RunOpts::default()
    };
    git.ok_opts(&["read-tree", head], &opts)?;
    // `add` refuses a pathspec that matches nothing, so only name paths that
    // exist on disk or in HEAD; the rest are absent either way.
    let in_head = git.tree_entries(head, paths)?;
    let known: Vec<String> = paths
        .iter()
        .filter(|path| {
            in_head.contains_key(*path) || std::fs::symlink_metadata(git.root().join(path)).is_ok()
        })
        .cloned()
        .collect();
    if !known.is_empty() {
        let list = nul_list(&known);
        git.ok_opts(
            &[
                "add",
                "-A",
                "--ignore-errors",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            &RunOpts {
                index_file: Some(&index),
                stdin: Some(&list),
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
    }
    let mut entries = BTreeMap::new();
    for chunk in paths.chunks(256) {
        let mut args: Vec<&str> = vec!["ls-files", "-s", "-z", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let raw = git.bytes_opts(
            &args,
            &RunOpts {
                index_file: Some(&index),
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
        for record in raw.split(|byte| *byte == 0).filter(|r| !r.is_empty()) {
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                continue;
            };
            let meta = String::from_utf8_lossy(&record[..tab]).to_string();
            let path = String::from_utf8_lossy(&record[tab + 1..]).to_string();
            let mut fields = meta.split(' ');
            let mode = fields.next().unwrap_or_default().to_string();
            let oid = fields.next().unwrap_or_default().to_string();
            if chunk.iter().any(|wanted| wanted == &path) {
                entries.insert(
                    path.clone(),
                    TreeEntry {
                        kind: if mode == "160000" { "commit" } else { "blob" }.to_string(),
                        mode,
                        oid,
                        path,
                    },
                );
            }
        }
    }
    Ok(entries)
}

fn merge_onto_head(
    git: &WorkspaceGit<'_>,
    old: Option<&TreeEntry>,
    head: Option<&TreeEntry>,
    current: Option<&TreeEntry>,
) -> Result<Option<Vec<u8>>> {
    let (Some(old), Some(head), Some(current)) = (old, head, current) else {
        return Ok(None);
    };
    if ![old, head, current]
        .iter()
        .all(|entry| matches!(entry.mode.as_str(), "100644" | "100755"))
    {
        return Ok(None);
    }
    let blobs = git.read_objects(&[old.oid.clone(), head.oid.clone(), current.oid.clone()])?;
    let scratch = tempfile::Builder::new()
        .prefix("instafy-stale-")
        .tempdir_in(git.git_dir())?;
    let base = scratch.path().join("base");
    let ours = scratch.path().join("ours");
    let theirs = scratch.path().join("theirs");
    std::fs::write(&base, &blobs[0].data)?;
    std::fs::write(&ours, &blobs[1].data)?;
    std::fs::write(&theirs, &blobs[2].data)?;
    let output = git.run(&[
        "merge-file",
        "-p",
        "--",
        &ours.to_string_lossy(),
        &base.to_string_lossy(),
        &theirs.to_string_lossy(),
    ])?;
    Ok((output.status.code() == Some(0)).then_some(output.stdout))
}

fn write_worktree_file(
    workspace: &WorkspaceDir,
    path: &str,
    content: &[u8],
    head: Option<&TreeEntry>,
) -> Result<()> {
    let executable = head.is_some_and(|entry| entry.mode == "100755");
    let mut reader = content;
    workspace.replace_file(path, &mut reader, executable)?;
    Ok(())
}

/// Park the work tree copies of `paths` on a `stale` recovery ref built from
/// HEAD plus those copies. HEAD, the index and the files are not touched.
fn park_paths(
    git: &WorkspaceGit<'_>,
    config: &ServerConfig,
    head: &str,
    paths: &[String],
) -> Result<Option<RecoveryRefReport>> {
    let scratch = temp_index_dir(git)?;
    let index = scratch.path().join("index");
    let opts = RunOpts {
        index_file: Some(&index),
        ..RunOpts::default()
    };
    git.ok_opts(&["read-tree", head], &opts)?;
    let list = nul_list(paths);
    git.ok_opts(
        &[
            "add",
            "-A",
            "--ignore-errors",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        &RunOpts {
            index_file: Some(&index),
            stdin: Some(&list),
            literal_pathspecs: true,
            ..RunOpts::default()
        },
    )?;
    let tree = git.stdout_opts(&["write-tree"], &opts)?;
    let stored = recovery::store(
        git,
        RecoverySpec {
            kind: RecoveryKind::Stale,
            tree,
            parent: Some(head.to_string()),
            source: None,
            date: None,
            paths: paths.to_vec(),
            commits: Vec::new(),
            identity: GitIdentity::new(&config.git_author_name, &config.git_author_email),
            origin_id: config.origin_id,
        },
    )?;
    if stored.is_none() {
        warn!("stale copies matched work already set aside; restoring them");
    }
    Ok(stored)
}

/// Give `paths` HEAD's version in the index and the work tree, removing
/// the ones HEAD does not have.
pub(crate) fn restore_from_head(
    git: &WorkspaceGit<'_>,
    workspace: &WorkspaceDir,
    paths: &[String],
) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let in_head = match git.commit_id("HEAD")? {
        Some(head) => git.tree_entries(&head, paths)?,
        None => BTreeMap::new(),
    };
    let (present, absent): (Vec<String>, Vec<String>) = paths
        .iter()
        .cloned()
        .partition(|path| in_head.contains_key(path));
    if !present.is_empty() {
        let list = nul_list(&present);
        git.ok_opts(
            &[
                "restore",
                "--source=HEAD",
                "--staged",
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
    if !absent.is_empty() {
        let list = nul_list(&absent);
        git.ok_opts(
            &[
                "rm",
                "-q",
                "--cached",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            &RunOpts {
                stdin: Some(&list),
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
        for path in &absent {
            match workspace.remove(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

/// Untracked, not ignored files.
fn untracked_paths(git: &WorkspaceGit<'_>) -> Result<Vec<String>> {
    let raw = git.bytes(&["ls-files", "-z", "--others", "--exclude-standard"])?;
    Ok(raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| std::str::from_utf8(record).ok().map(str::to_string))
        .filter(|path| !crate::git::is_sync_reserved_path(path))
        .collect())
}

/// Each line of `.instafy/.git/logs/HEAD`, or `None` without a reflog.
fn read_reflog(workspace: &WorkspaceDir) -> Option<Vec<String>> {
    use std::io::Read as _;
    let mut file = workspace.open_file(".instafy/.git/logs/HEAD").ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text.lines().map(str::to_string).collect())
}

/// The commit HEAD was on before each `reset: moving to <remote>/<branch>`,
/// newest first.
fn old_heads_before_resets(lines: &[String], remote_branch: &str) -> Vec<String> {
    let wanted = format!("reset: moving to {remote_branch}");
    lines
        .iter()
        .rev()
        .filter_map(|line| {
            let (meta, message) = line.split_once('\t')?;
            if message.trim() != wanted {
                return None;
            }
            let old = meta.split(' ').next()?;
            (!old.is_empty() && !old.bytes().all(|byte| byte == b'0')).then(|| old.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflog_resets_are_read_newest_first() {
        let lines = vec![
            "0000000000000000000000000000000000000000 aaaa x <x> 1 +0000\tclone: from y"
                .to_string(),
            "aaaa bbbb x <x> 2 +0000\treset: moving to origin/main".to_string(),
            "bbbb cccc x <x> 3 +0000\tcommit: z".to_string(),
            "cccc dddd x <x> 4 +0000\treset: moving to HEAD~1".to_string(),
            "dddd eeee x <x> 5 +0000\treset: moving to origin/main".to_string(),
        ];
        assert_eq!(
            old_heads_before_resets(&lines, "origin/main"),
            vec!["dddd".to_string(), "aaaa".to_string()]
        );
    }
}
