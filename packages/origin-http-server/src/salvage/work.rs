//! The salvage commit W (the entry's HEAD with its work-tree edits, made in a
//! temporary index), and the history check that decides whether HEAD's local
//! commits may reach canonical as they are or only as one filtered commit.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use anyhow::{Context, Result};

use super::classify::PrivatePath;
use crate::publish::{parse_raw_changes, parse_stdin_diff_tree, RawChange};
use crate::publish_policy::{
    deletion_allowed, is_unsafe_path, unpublishable_reason, RejectReason, MAX_PUBLISH_BLOB_BYTES,
};
use crate::tree_merge::{changed_paths, tree_with_entries_from};
use crate::workspace_git::{
    nul_list, temp_index_dir, zero_oid, GitIdentity, RunOpts, TreeEntry, WorkspaceGit,
};

/// The salvage commit's subject.
pub(crate) const SUBJECT: &str = "Keep unsaved edits from the retired file gateway";
/// A path the salvage kept in its private archive, with why:
/// `Instafy-Private-Path: <reason> <path>`. Restores list these paths as not
/// restored.
pub(crate) const PRIVATE_PATH_TRAILER: &str = "Instafy-Private-Path";
/// Paths named in one salvage commit's message, per trailer key.
const MAX_TRAILER_PATHS: usize = 200;
/// The commit date of a salvage commit for a repository without commits,
/// fixed so that a rerun makes the same commit.
const UNBORN_DATE: &str = "1000000000 +0000";

/// A temporary index holding `HEAD` (or nothing), into which the work tree's
/// state of chosen paths is read. The entry's own index is never touched.
pub(crate) struct WorkIndex {
    _scratch: tempfile::TempDir,
    index: PathBuf,
}

impl WorkIndex {
    pub(crate) fn new(git: &WorkspaceGit<'_>, head: Option<&str>) -> Result<Self> {
        let scratch = temp_index_dir(git)?;
        let index = scratch.path().join("index");
        let work = Self {
            _scratch: scratch,
            index,
        };
        match head {
            Some(head) => git.ok_opts(&["read-tree", head], &work.opts())?,
            None => git.ok_opts(&["read-tree", "--empty"], &work.opts())?,
        }
        Ok(work)
    }

    fn opts(&self) -> RunOpts<'_> {
        RunOpts {
            index_file: Some(&self.index),
            ..RunOpts::default()
        }
    }

    /// Record each path as the work tree holds it now: its content, a link
    /// as a link, or no entry when it is gone. Ignore rules play no part.
    /// Returns the paths git refuses (one below a link, a folder where the
    /// index has a file), which are left as they were.
    pub(crate) fn take_from_worktree(
        &self,
        git: &WorkspaceGit<'_>,
        paths: &[String],
    ) -> Result<Vec<String>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let args = ["update-index", "--add", "--remove", "-z", "--stdin"];
        let list = nul_list(paths);
        let batch = git.run_opts(
            &args,
            &RunOpts {
                index_file: Some(&self.index),
                stdin: Some(&list),
                ..RunOpts::default()
            },
        )?;
        if batch.status.success() {
            return Ok(Vec::new());
        }
        // A refused path stops the whole batch and leaves the index as it
        // was: take the paths one at a time.
        let mut refused = Vec::new();
        for path in paths {
            let one = nul_list(std::slice::from_ref(path));
            let output = git.run_opts(
                &args,
                &RunOpts {
                    index_file: Some(&self.index),
                    stdin: Some(&one),
                    ..RunOpts::default()
                },
            )?;
            if !output.status.success() {
                refused.push(path.clone());
            }
        }
        Ok(refused)
    }

    /// The index's entry for each path (`None` when it has none).
    pub(crate) fn entries(
        &self,
        git: &WorkspaceGit<'_>,
        paths: &[String],
    ) -> Result<BTreeMap<String, Option<TreeEntry>>> {
        let mut entries: BTreeMap<String, Option<TreeEntry>> =
            paths.iter().map(|path| (path.clone(), None)).collect();
        for chunk in paths.chunks(256) {
            let mut args: Vec<&str> = vec!["ls-files", "-s", "-z", "--"];
            args.extend(chunk.iter().map(String::as_str));
            let raw = git.bytes_opts(
                &args,
                &RunOpts {
                    index_file: Some(&self.index),
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
                if let Some(slot) = entries.get_mut(&path) {
                    *slot = Some(TreeEntry {
                        kind: if mode == "160000" { "commit" } else { "blob" }.to_string(),
                        mode,
                        oid,
                        path,
                    });
                }
            }
        }
        Ok(entries)
    }

    /// Put `head`'s entries (or none) back for `paths`.
    pub(crate) fn reset(
        &self,
        git: &WorkspaceGit<'_>,
        head: Option<&str>,
        paths: &[String],
    ) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let kept = match head {
            Some(head) => git.tree_entries(head, paths)?,
            None => BTreeMap::new(),
        };
        let zero = zero_oid(&git.empty_tree()?);
        let mut info = Vec::new();
        for path in paths {
            let line = match kept.get(path) {
                Some(entry) => format!("{} {}\t{path}", entry.mode, entry.oid),
                None => format!("0 {zero}\t{path}"),
            };
            info.extend_from_slice(line.as_bytes());
            info.push(0);
        }
        git.ok_opts(
            &["update-index", "-z", "--index-info"],
            &RunOpts {
                index_file: Some(&self.index),
                stdin: Some(&info),
                ..RunOpts::default()
            },
        )
    }

    pub(crate) fn write_tree(&self, git: &WorkspaceGit<'_>) -> Result<String> {
        git.stdout_opts(&["write-tree"], &self.opts())
    }
}

/// `<epoch> <zone>` of a commit's committer.
pub(crate) fn committer_date(git: &WorkspaceGit<'_>, commit: Option<&str>) -> Result<String> {
    let Some(commit) = commit else {
        return Ok(UNBORN_DATE.to_string());
    };
    let object = git
        .read_objects(&[commit.to_string()])?
        .pop()
        .context("commit missing")?;
    let text = String::from_utf8_lossy(&object.data);
    let line = text
        .lines()
        .take_while(|line| !line.is_empty())
        .find_map(|line| line.strip_prefix("committer "))
        .context("commit has no committer")?;
    let date = line
        .rsplit_once('>')
        .map(|(_, date)| date.trim())
        .filter(|date| !date.is_empty())
        .context("commit has no committer date")?;
    Ok(date.to_string())
}

/// The salvage commit's message: the subject, then trailers naming the
/// changed paths and the paths kept privately (at most 200 of each; names
/// with control characters are left out of the message).
pub(crate) fn message(paths: &[String], private: &[PrivatePath]) -> Vec<u8> {
    let mut text = format!("{SUBJECT}\n\nInstafy-Recovery-Kind: salvage\n");
    let printable = |path: &str| !path.chars().any(char::is_control) && path.trim() == path;
    for path in paths
        .iter()
        .filter(|path| printable(path))
        .take(MAX_TRAILER_PATHS)
    {
        text.push_str(&format!("Instafy-Path: {path}\n"));
    }
    for kept in private
        .iter()
        .filter(|kept| kept.commit.is_none() && printable(&kept.path))
        .take(MAX_TRAILER_PATHS)
    {
        text.push_str(&format!(
            "{PRIVATE_PATH_TRAILER}: {} {}\n",
            kept.reason, kept.path
        ));
    }
    text.into_bytes()
}

/// Commit `tree` under the gateway's identity at `date`.
pub(crate) fn commit(
    git: &WorkspaceGit<'_>,
    tree: &str,
    parent: Option<&str>,
    identity: &GitIdentity,
    date: &str,
    message: &[u8],
) -> Result<String> {
    let who = identity.clone().at(Some(date.to_string()));
    let parents: Vec<&str> = parent.into_iter().collect();
    git.commit_tree(tree, &parents, &who, &who, message)
}

/// One version of a path that a commit holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Version {
    pub commit: String,
    pub mode: String,
    pub oid: String,
}

/// A path that may not reach canonical.
#[derive(Clone, Debug)]
pub(crate) struct Hit {
    pub reason: RejectReason,
    /// The versions the tip's local history adds.
    pub versions: Vec<Version>,
}

/// What a tip's local history holds.
#[derive(Debug, Default)]
pub(crate) struct Scan {
    pub hits: BTreeMap<String, Hit>,
    /// Every path a local commit changes.
    pub touched: BTreeSet<String>,
}

/// Check every commit of `tip` that `main` lacks, and `tip`'s whole change
/// against `main`, with the publish rules: the shard's hook checks only the
/// net change and has no secret rules, while a salvage ref is permanent and
/// readable by every holder of `git.read`.
pub(crate) fn scan(git: &WorkspaceGit<'_>, tip: &str, main: Option<&str>) -> Result<Scan> {
    let mut args = vec![
        "rev-list".to_string(),
        "--topo-order".to_string(),
        "--reverse".to_string(),
        tip.to_string(),
    ];
    if let Some(main) = main {
        args.push(format!("^{main}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let listing = git.stdout(&arg_refs)?;
    let commits: Vec<&str> = listing.lines().filter(|line| !line.is_empty()).collect();

    let mut changes: Vec<(String, RawChange)> = Vec::new();
    if !commits.is_empty() {
        let mut input = String::new();
        for commit in &commits {
            input.push_str(commit);
            input.push('\n');
        }
        let raw = git.bytes_opts(
            &[
                "diff-tree",
                "--stdin",
                "-r",
                "-z",
                "--no-renames",
                "--raw",
                "-m",
                "--root",
            ],
            &RunOpts {
                stdin: Some(input.as_bytes()),
                ..RunOpts::default()
            },
        )?;
        for (commit, list) in parse_stdin_diff_tree(&raw) {
            changes.extend(list.into_iter().map(|change| (commit.clone(), change)));
        }
    }
    let base = match main {
        Some(main) => main.to_string(),
        None => git.empty_tree()?,
    };
    let net = git.bytes(&["diff-tree", "-r", "-z", "--no-renames", "--raw", &base, tip])?;
    changes.extend(
        parse_raw_changes(&net)
            .into_iter()
            .map(|change| (tip.to_string(), change)),
    );

    let ids: Vec<String> = changes
        .iter()
        .filter(|(_, change)| change.status != 'D' && change.new_mode != "160000")
        .map(|(_, change)| change.new_oid.clone())
        .collect();
    let sizes: HashMap<String, u64> = ids
        .iter()
        .cloned()
        .zip(git.object_sizes(&ids)?)
        .filter_map(|(id, size)| size.map(|(_, size)| (id, size)))
        .collect();

    let mut scanned = Scan::default();
    for (commit, change) in changes {
        if commits.contains(&commit.as_str()) {
            scanned.touched.insert(change.path.clone());
        }
        let Some(reason) = change_reason(&change, &sizes) else {
            continue;
        };
        let hit = scanned.hits.entry(change.path.clone()).or_insert(Hit {
            reason,
            versions: Vec::new(),
        });
        let version = Version {
            commit,
            mode: change.new_mode.clone(),
            oid: change.new_oid.clone(),
        };
        if change.status != 'D'
            && matches!(change.new_mode.as_str(), "100644" | "100755" | "120000")
            && !hit.versions.iter().any(|known| known.oid == version.oid)
        {
            hit.versions.push(version);
        }
    }
    Ok(scanned)
}

/// Why a change may not reach canonical, by the publish rules.
fn change_reason(change: &RawChange, sizes: &HashMap<String, u64>) -> Option<RejectReason> {
    if change.status == 'D' {
        return (!deletion_allowed(&change.path)).then_some(RejectReason::Excluded);
    }
    if let Some(reason) = unpublishable_reason(&change.path) {
        return Some(reason);
    }
    if is_unsafe_path(&change.path) || change.new_mode == "160000" {
        return Some(RejectReason::Unsupported);
    }
    sizes
        .get(&change.new_oid)
        .is_some_and(|size| *size > MAX_PUBLISH_BLOB_BYTES)
        .then_some(RejectReason::TooLarge)
}

/// `tip`'s content as one commit on the last commit `main` shares with it
/// (none for an unrelated or empty `main`), with every path in `filtered` as
/// `main` has it, so neither the commit nor anything below it carries those
/// paths' local versions. Returns the commit, or the shared commit itself when
/// nothing is left once the paths are filtered.
pub(crate) fn squash(
    git: &WorkspaceGit<'_>,
    tip: &str,
    main: Option<&str>,
    filtered: &[String],
    identity: &GitIdentity,
    date: &str,
    private: &[PrivatePath],
) -> Result<Option<String>> {
    let tree = tree_with_entries_from(git, tip, main, filtered)?;
    let parent = match main {
        Some(main) => git.merge_base(tip, main)?,
        None => None,
    };
    let parent_tree = match parent.as_deref() {
        Some(parent) => git.tree_id(parent)?,
        None => git.empty_tree()?,
    };
    if tree == parent_tree {
        return Ok(parent);
    }
    let paths = changed_paths(git, &parent_tree, &tree)?;
    commit(
        git,
        &tree,
        parent.as_deref(),
        identity,
        date,
        &message(&paths, private),
    )
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_names_paths_and_private_files_as_trailers() {
        let paths = vec![
            "README.md".to_string(),
            "line\nbreak".to_string(),
            " padded".to_string(),
        ];
        let private = vec![
            PrivatePath {
                path: ".env".to_string(),
                reason: "secret",
                commit: None,
            },
            PrivatePath {
                path: "old/.env".to_string(),
                reason: "secret",
                commit: Some("abc".to_string()),
            },
        ];
        let text = String::from_utf8(message(&paths, &private)).unwrap();
        assert_eq!(
            text,
            "Keep unsaved edits from the retired file gateway\n\n\
             Instafy-Recovery-Kind: salvage\n\
             Instafy-Path: README.md\n\
             Instafy-Private-Path: secret .env\n"
        );
        let many: Vec<String> = (0..300).map(|n| format!("f{n}")).collect();
        let text = String::from_utf8(message(&many, &[])).unwrap();
        assert_eq!(text.matches("Instafy-Path: ").count(), 200);
    }
}
