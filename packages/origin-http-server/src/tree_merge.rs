//! Three-way tree merge built from git 2.34 plumbing.
//!
//! `read-tree -i -m --aggressive` in a temporary index resolves every path
//! that changed on one side only. Paths left unmerged are regular files that
//! both sides changed, which `merge-file` merges line by line, and everything
//! else: binary files, add/add with different content, modify/delete,
//! directory/file swaps, symlinks and gitlinks. Those are conflicts and keep
//! **ours**. The result is a tree id plus the conflicted paths; no ref, index
//! or worktree file is touched, so callers decide what to do with it.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};

use crate::workspace_git::{parse_ls_tree, temp_index_dir, RunOpts, WorkspaceGit};

/// The merged tree and the paths that kept `ours` because they conflicted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeResult {
    pub tree: String,
    pub conflicts: Vec<String>,
}

#[derive(Clone, Debug)]
struct Stage {
    mode: String,
    oid: String,
}

/// Merge `theirs` into `ours` relative to `base` (`None` is the empty tree).
/// Each argument may name a commit or a tree.
pub(crate) fn three_way(
    git: &WorkspaceGit<'_>,
    base: Option<&str>,
    ours: &str,
    theirs: &str,
) -> Result<MergeResult> {
    let base_tree = match base {
        Some(base) => git.tree_id(base)?,
        None => git.empty_tree()?,
    };
    let ours_tree = git.tree_id(ours)?;
    let theirs_tree = git.tree_id(theirs)?;

    // Fast paths: one side unchanged.
    if theirs_tree == base_tree || theirs_tree == ours_tree {
        return Ok(MergeResult {
            tree: ours_tree,
            conflicts: Vec::new(),
        });
    }
    if ours_tree == base_tree {
        return Ok(MergeResult {
            tree: theirs_tree,
            conflicts: Vec::new(),
        });
    }

    let scratch = temp_index_dir(git)?;
    let index = scratch.path().join("index");
    let opts = RunOpts {
        index_file: Some(&index),
        ..RunOpts::default()
    };
    git.ok_opts(
        &[
            "read-tree",
            "-i",
            "-m",
            "--aggressive",
            &base_tree,
            &ours_tree,
            &theirs_tree,
        ],
        &opts,
    )
    .context("three-way read-tree failed")?;

    let unmerged = git.bytes_opts(&["ls-files", "-u", "-z"], &opts)?;
    let mut stages: BTreeMap<String, [Option<Stage>; 3]> = BTreeMap::new();
    for record in unmerged.split(|byte| *byte == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .context("malformed ls-files -u record")?;
        let meta = std::str::from_utf8(&record[..tab]).context("non-utf8 ls-files record")?;
        let path = std::str::from_utf8(&record[tab + 1..])
            .context("a conflicting path is not valid UTF-8")?
            .to_string();
        let mut fields = meta.split(' ');
        let mode = fields.next().unwrap_or_default().to_string();
        let oid = fields.next().unwrap_or_default().to_string();
        let stage: usize = fields
            .next()
            .and_then(|value| value.parse().ok())
            .context("ls-files -u printed no stage")?;
        if !(1..=3).contains(&stage) {
            bail!("unexpected index stage {stage} for {path}");
        }
        stages.entry(path).or_default()[stage - 1] = Some(Stage { mode, oid });
    }

    if stages.is_empty() {
        let tree = git.stdout_opts(&["write-tree"], &opts)?;
        return Ok(MergeResult {
            tree,
            conflicts: Vec::new(),
        });
    }

    // Paths where all three sides are regular files go through merge-file.
    let mut mergeable = Vec::new();
    for (path, [base, ours, theirs]) in &stages {
        if let (Some(base), Some(ours), Some(theirs)) = (base, ours, theirs) {
            if is_regular(&base.mode) && is_regular(&ours.mode) && is_regular(&theirs.mode) {
                mergeable.push(path.clone());
            }
        }
    }
    let mut blob_ids = Vec::new();
    for path in &mergeable {
        let [base, ours, theirs] = &stages[path];
        for stage in [base, ours, theirs] {
            blob_ids.push(stage.as_ref().map(|s| s.oid.clone()).unwrap_or_default());
        }
    }
    let blobs = git.read_objects(&blob_ids)?;
    let files = tempfile::Builder::new()
        .prefix("instafy-merge-")
        .tempdir_in(git.git_dir())
        .context("failed to create a merge scratch directory")?;

    let mut resolved: Vec<(String, Option<Stage>)> = Vec::new();
    let mut conflicts = Vec::new();
    let mut merged_index = 0usize;
    for (path, [base, ours, theirs]) in &stages {
        let merged = if mergeable.get(merged_index) == Some(path) {
            let offset = merged_index * 3;
            merged_index += 1;
            let (base, ours, theirs) = (
                base.as_ref().unwrap(),
                ours.as_ref().unwrap(),
                theirs.as_ref().unwrap(),
            );
            match merge_file(
                git,
                files.path(),
                &blobs[offset].data,
                &blobs[offset + 1].data,
                &blobs[offset + 2].data,
            )? {
                Some(content) => {
                    // If only one side changed the exec bit, that side wins.
                    let mode = if ours.mode == theirs.mode || theirs.mode == base.mode {
                        ours.mode.clone()
                    } else {
                        theirs.mode.clone()
                    };
                    let oid = git.stdout_opts(
                        &["hash-object", "-w", "--stdin"],
                        &RunOpts {
                            stdin: Some(&content),
                            ..RunOpts::default()
                        },
                    )?;
                    Some(Stage { mode, oid })
                }
                None => None,
            }
        } else {
            None
        };
        match merged {
            Some(stage) => resolved.push((path.clone(), Some(stage))),
            None => {
                conflicts.push(path.clone());
                // Keep ours: its entry, or nothing when ours has none.
                resolved.push((path.clone(), ours.clone()));
            }
        }
    }

    // Replace every unmerged path with its resolution. A zero-mode line
    // removes all of a path's stages first.
    let mut info = Vec::new();
    let zero = "0".repeat(stages_oid_len(&stages));
    for (path, _) in &resolved {
        info.extend_from_slice(format!("0 {zero}\t{path}").as_bytes());
        info.push(0);
    }
    for (path, stage) in &resolved {
        if let Some(stage) = stage {
            info.extend_from_slice(format!("{} {} 0\t{path}", stage.mode, stage.oid).as_bytes());
            info.push(0);
        }
    }
    git.ok_opts(
        &["update-index", "-z", "--index-info"],
        &RunOpts {
            index_file: Some(&index),
            stdin: Some(&info),
            ..RunOpts::default()
        },
    )?;
    let tree = git
        .stdout_opts(&["write-tree"], &opts)
        .context("merged index does not form a tree")?;
    Ok(MergeResult { tree, conflicts })
}

fn stages_oid_len(stages: &BTreeMap<String, [Option<Stage>; 3]>) -> usize {
    stages
        .values()
        .flat_map(|entry| entry.iter().flatten())
        .map(|stage| stage.oid.len())
        .next()
        .unwrap_or(40)
}

fn is_regular(mode: &str) -> bool {
    matches!(mode, "100644" | "100755")
}

/// Merge three versions of a file. `None` when they conflict or are binary.
fn merge_file(
    git: &WorkspaceGit<'_>,
    scratch: &std::path::Path,
    base: &[u8],
    ours: &[u8],
    theirs: &[u8],
) -> Result<Option<Vec<u8>>> {
    let base_path = scratch.join("base");
    let ours_path = scratch.join("ours");
    let theirs_path = scratch.join("theirs");
    std::fs::write(&base_path, base)?;
    std::fs::write(&ours_path, ours)?;
    std::fs::write(&theirs_path, theirs)?;
    let ours_arg = ours_path.to_string_lossy().to_string();
    let base_arg = base_path.to_string_lossy().to_string();
    let theirs_arg = theirs_path.to_string_lossy().to_string();
    let output = git.run(&["merge-file", "-p", "--", &ours_arg, &base_arg, &theirs_arg])?;
    // Exit 0 is a clean merge, a positive count is conflicts, and a negative
    // value (255) is an error such as binary input.
    if output.status.code() == Some(0) {
        Ok(Some(output.stdout))
    } else {
        Ok(None)
    }
}

/// The paths whose entries differ between two trees (or commits).
pub(crate) fn changed_paths(git: &WorkspaceGit<'_>, from: &str, to: &str) -> Result<Vec<String>> {
    let raw = git.bytes(&[
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--name-only",
        from,
        to,
    ])?;
    Ok(raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).to_string())
        .collect())
}

/// Replace the entries of `tree` at `paths` (and anything below them) with
/// the matching entries of `source`, or remove them where `source` has none,
/// and return the new tree id.
pub(crate) fn tree_with_entries_from(
    git: &WorkspaceGit<'_>,
    tree: &str,
    source: Option<&str>,
    paths: &[String],
) -> Result<String> {
    if paths.is_empty() {
        return git.tree_id(tree);
    }
    let scratch = temp_index_dir(git)?;
    let index = scratch.path().join("index");
    let opts = RunOpts {
        index_file: Some(&index),
        ..RunOpts::default()
    };
    git.ok_opts(&["read-tree", tree], &opts)?;
    let zero = "0".repeat(git.tree_id(tree)?.len());
    let under = |entry: &str| {
        paths
            .iter()
            .any(|path| entry == path || entry.starts_with(&format!("{path}/")))
    };

    let mut info = Vec::new();
    let remove = |path: &str, info: &mut Vec<u8>| {
        info.extend_from_slice(format!("0 {zero}\t{path}").as_bytes());
        info.push(0);
    };
    // Everything the tree holds at or below the paths.
    for chunk in paths.chunks(256) {
        let mut args: Vec<&str> = vec!["ls-files", "-z", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let listed = git.bytes_opts(
            &args,
            &RunOpts {
                index_file: Some(&index),
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
        for entry in listed.split(|byte| *byte == 0).filter(|r| !r.is_empty()) {
            let entry = String::from_utf8_lossy(entry).to_string();
            if under(&entry) {
                remove(&entry, &mut info);
            }
        }
    }
    if let Some(source) = source {
        for chunk in paths.chunks(256) {
            let mut args: Vec<&str> = vec!["ls-tree", "-r", "-z", "--full-tree", source, "--"];
            args.extend(chunk.iter().map(String::as_str));
            let raw = git.bytes_opts(
                &args,
                &RunOpts {
                    literal_pathspecs: true,
                    ..RunOpts::default()
                },
            )?;
            for entry in parse_ls_tree(&raw) {
                if under(&entry.path) {
                    // A file the tree keeps where this entry needs a
                    // directory would make the tree invalid.
                    let mut ancestor = entry.path.as_str();
                    while let Some((parent, _)) = ancestor.rsplit_once('/') {
                        remove(parent, &mut info);
                        ancestor = parent;
                    }
                    info.extend_from_slice(
                        format!("{} {} 0\t{}", entry.mode, entry.oid, entry.path).as_bytes(),
                    );
                    info.push(0);
                }
            }
        }
    }

    git.ok_opts(
        &["update-index", "-z", "--index-info"],
        &RunOpts {
            index_file: Some(&index),
            stdin: Some(&info),
            ..RunOpts::default()
        },
    )?;
    git.stdout_opts(&["write-tree"], &opts)
        .context("could not rebuild the tree after filtering paths")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_files, init_workspace_repo, ws_git};
    use tempfile::tempdir;

    fn blob(git: &WorkspaceGit<'_>, tree: &str, path: &str) -> Option<String> {
        let raw = git
            .bytes(&["ls-tree", "-z", tree, "--", path])
            .unwrap_or_default();
        crate::workspace_git::parse_ls_tree(&raw)
            .into_iter()
            .find(|entry| entry.path == path)
            .map(|entry| {
                String::from_utf8_lossy(&git.read_objects(&[entry.oid]).unwrap()[0].data)
                    .to_string()
            })
    }

    fn mode(git: &WorkspaceGit<'_>, tree: &str, path: &str) -> Option<String> {
        let raw = git.bytes(&["ls-tree", "-z", tree, "--", path]).unwrap();
        crate::workspace_git::parse_ls_tree(&raw)
            .into_iter()
            .find(|entry| entry.path == path)
            .map(|entry| entry.mode)
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        init_workspace_repo(&root);
        Fixture { _dir: dir, root }
    }

    #[test]
    fn clean_merge_combines_both_sides() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(&fx.root, None, &[("a.txt", Some("1\n2\n3\n4\n5\n"))]);
        let ours = commit_files(
            &fx.root,
            Some(&base),
            &[("a.txt", Some("ONE\n2\n3\n4\n5\n"))],
        );
        let theirs = commit_files(
            &fx.root,
            Some(&base),
            &[("a.txt", Some("1\n2\n3\n4\nFIVE\n"))],
        );
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert!(result.conflicts.is_empty());
        assert_eq!(
            blob(&git, &result.tree, "a.txt").as_deref(),
            Some("ONE\n2\n3\n4\nFIVE\n")
        );
    }

    #[test]
    fn same_line_conflict_keeps_ours() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(&fx.root, None, &[("a.txt", Some("1\n2\n3\n"))]);
        let ours = commit_files(&fx.root, Some(&base), &[("a.txt", Some("1\nours\n3\n"))]);
        let theirs = commit_files(&fx.root, Some(&base), &[("a.txt", Some("1\ntheirs\n3\n"))]);
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert_eq!(result.conflicts, vec!["a.txt".to_string()]);
        assert_eq!(
            blob(&git, &result.tree, "a.txt").as_deref(),
            Some("1\nours\n3\n")
        );
    }

    #[test]
    fn one_sided_add_and_delete_are_taken() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(
            &fx.root,
            None,
            &[("keep.txt", Some("k\n")), ("gone.txt", Some("g\n"))],
        );
        let ours = commit_files(&fx.root, Some(&base), &[("ours.txt", Some("o\n"))]);
        let theirs = commit_files(
            &fx.root,
            Some(&base),
            &[("gone.txt", None), ("theirs.txt", Some("t\n"))],
        );
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert!(result.conflicts.is_empty());
        assert_eq!(blob(&git, &result.tree, "ours.txt").as_deref(), Some("o\n"));
        assert_eq!(
            blob(&git, &result.tree, "theirs.txt").as_deref(),
            Some("t\n")
        );
        assert_eq!(blob(&git, &result.tree, "gone.txt"), None);
        assert_eq!(blob(&git, &result.tree, "keep.txt").as_deref(), Some("k\n"));
    }

    #[test]
    fn identical_add_add_is_clean_and_different_add_add_keeps_ours() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(&fx.root, None, &[("keep.txt", Some("k\n"))]);
        let ours = commit_files(
            &fx.root,
            Some(&base),
            &[("same.txt", Some("x\n")), ("diff.txt", Some("ours\n"))],
        );
        let theirs = commit_files(
            &fx.root,
            Some(&base),
            &[("same.txt", Some("x\n")), ("diff.txt", Some("theirs\n"))],
        );
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert_eq!(result.conflicts, vec!["diff.txt".to_string()]);
        assert_eq!(blob(&git, &result.tree, "same.txt").as_deref(), Some("x\n"));
        assert_eq!(
            blob(&git, &result.tree, "diff.txt").as_deref(),
            Some("ours\n")
        );
    }

    #[test]
    fn modify_delete_keeps_ours_either_way() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(
            &fx.root,
            None,
            &[("a.txt", Some("a\n")), ("b.txt", Some("b\n"))],
        );
        // Ours deletes a.txt and edits b.txt; theirs edits a.txt and deletes b.txt.
        let ours = commit_files(
            &fx.root,
            Some(&base),
            &[("a.txt", None), ("b.txt", Some("b ours\n"))],
        );
        let theirs = commit_files(
            &fx.root,
            Some(&base),
            &[("a.txt", Some("a theirs\n")), ("b.txt", None)],
        );
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert_eq!(
            result.conflicts,
            vec!["a.txt".to_string(), "b.txt".to_string()]
        );
        assert_eq!(blob(&git, &result.tree, "a.txt"), None);
        assert_eq!(
            blob(&git, &result.tree, "b.txt").as_deref(),
            Some("b ours\n")
        );
    }

    #[test]
    fn directory_file_swap_keeps_ours() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(&fx.root, None, &[("keep.txt", Some("k\n"))]);
        let ours = commit_files(&fx.root, Some(&base), &[("a", Some("file\n"))]);
        let theirs = commit_files(
            &fx.root,
            Some(&base),
            &[("a/b", Some("nested\n")), ("other.txt", Some("o\n"))],
        );
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert!(result.conflicts.contains(&"a".to_string()));
        assert!(result.conflicts.contains(&"a/b".to_string()));
        assert_eq!(blob(&git, &result.tree, "a").as_deref(), Some("file\n"));
        assert_eq!(
            blob(&git, &result.tree, "other.txt").as_deref(),
            Some("o\n")
        );
    }

    #[test]
    fn binary_files_changed_on_both_sides_conflict() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(&fx.root, None, &[("logo.bin", Some("\0base\0"))]);
        let ours = commit_files(&fx.root, Some(&base), &[("logo.bin", Some("\0ours\0"))]);
        let theirs = commit_files(&fx.root, Some(&base), &[("logo.bin", Some("\0theirs\0"))]);
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert_eq!(result.conflicts, vec!["logo.bin".to_string()]);
        assert_eq!(
            blob(&git, &result.tree, "logo.bin").as_deref(),
            Some("\0ours\0")
        );
    }

    #[test]
    fn exec_bit_changed_on_one_side_wins() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(&fx.root, None, &[("run.sh", Some("a\nb\nc\n"))]);
        let ours = commit_files(&fx.root, Some(&base), &[("run.sh", Some("A\nb\nc\n"))]);
        let theirs_tree = {
            // Theirs flips the exec bit and edits another line.
            let edited = commit_files(&fx.root, Some(&base), &[("run.sh", Some("a\nb\nC\n"))]);
            crate::test_support::with_mode(&fx.root, &edited, "run.sh", "100755")
        };
        let result = three_way(&git, Some(&base), &ours, &theirs_tree).unwrap();
        assert!(result.conflicts.is_empty());
        assert_eq!(
            blob(&git, &result.tree, "run.sh").as_deref(),
            Some("A\nb\nC\n")
        );
        assert_eq!(
            mode(&git, &result.tree, "run.sh").as_deref(),
            Some("100755")
        );
    }

    #[test]
    fn symlinks_and_gitlinks_changed_on_both_sides_conflict() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let base = commit_files(&fx.root, None, &[("keep.txt", Some("k\n"))]);
        let base =
            crate::test_support::with_entry(&fx.root, &base, "link", "120000", Some("target-a"));
        let base_gitlink = "1".repeat(40);
        let base = crate::test_support::with_raw_entry(
            &fx.root,
            &base,
            "vendored",
            "160000",
            &base_gitlink,
        );
        let ours =
            crate::test_support::with_entry(&fx.root, &base, "link", "120000", Some("target-ours"));
        let ours = crate::test_support::with_raw_entry(
            &fx.root,
            &ours,
            "vendored",
            "160000",
            &"2".repeat(40),
        );
        let theirs = crate::test_support::with_entry(
            &fx.root,
            &base,
            "link",
            "120000",
            Some("target-theirs"),
        );
        let theirs = crate::test_support::with_raw_entry(
            &fx.root,
            &theirs,
            "vendored",
            "160000",
            &"3".repeat(40),
        );
        let result = three_way(&git, Some(&base), &ours, &theirs).unwrap();
        assert_eq!(
            result.conflicts,
            vec!["link".to_string(), "vendored".to_string()]
        );
        assert_eq!(
            blob(&git, &result.tree, "link").as_deref(),
            Some("target-ours")
        );
        assert_eq!(
            mode(&git, &result.tree, "vendored").as_deref(),
            Some("160000")
        );
    }

    #[test]
    fn empty_base_merges_unrelated_trees() {
        let fx = fixture();
        let git = ws_git(&fx.root);
        let ours = commit_files(&fx.root, None, &[("README.md", Some("first\n"))]);
        let theirs = commit_files(
            &fx.root,
            None,
            &[
                ("AGENTS.md", Some("agents\n")),
                ("README.md", Some("other\n")),
            ],
        );
        let result = three_way(&git, None, &ours, &theirs).unwrap();
        assert_eq!(result.conflicts, vec!["README.md".to_string()]);
        assert_eq!(
            blob(&git, &result.tree, "README.md").as_deref(),
            Some("first\n")
        );
        assert_eq!(
            blob(&git, &result.tree, "AGENTS.md").as_deref(),
            Some("agents\n")
        );
    }
}
