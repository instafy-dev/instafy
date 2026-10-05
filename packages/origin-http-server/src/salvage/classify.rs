//! Which of a parked working copy's changes may go into its salvage commit,
//! which stay private, which are left behind, and which are stale copies of
//! versions canonical `main` already has.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use crate::git::is_sync_reserved_path;
use crate::paths::is_reserved_path;
use crate::publish_policy::{
    deletion_allowed, is_legacy_attachment_path, is_secret_path, is_unsafe_path,
    MAX_PUBLISH_BLOB_BYTES,
};
use crate::workspace_git::{RunOpts, TreeEntry, WorkspaceGit};

/// Folders of build output, dependencies and caches. Anything skipped below
/// them can be made again, so it never holds up removing an entry.
const BUILD_OUTPUT_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    "coverage",
];

/// How `git status` lists a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Listed {
    /// Tracked, and changed or deleted in the work tree.
    Tracked,
    Untracked,
    Ignored,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub path: String,
    pub listed: Listed,
    /// Listed as a folder (an ignored folder, or a repository inside the
    /// work tree), without its trailing `/`.
    pub folder: bool,
}

/// A path left out of the salvage commit and out of the private archive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Skipped {
    /// The path; a folder ends with `/`.
    pub path: String,
    pub size: u64,
    pub reason: &'static str,
}

impl Skipped {
    /// Whether the path lies in build output, which may be made again.
    pub(crate) fn rebuildable(&self) -> bool {
        match self.path.strip_suffix('/') {
            Some(folder) => within_build_output(folder, true),
            None => within_build_output(&self.path, false),
        }
    }
}

/// A file kept in the private archive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct PrivatePath {
    pub path: String,
    pub reason: &'static str,
    /// For a version taken from a local commit rather than the work tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// The candidates, sorted.
#[derive(Debug, Default)]
pub(crate) struct Sorted {
    /// Paths whose work-tree state goes into the salvage commit (unless they
    /// turn out to be stale copies).
    pub work: Vec<String>,
    /// Work-tree files for the private archive.
    pub private: Vec<PrivatePath>,
    /// Root chat images to export.
    pub attachments: Vec<String>,
    pub skipped: Vec<Skipped>,
}

/// What a work-tree entry is, never following a link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    File { size: u64 },
    Link,
    Folder,
    Other,
    Missing,
}

pub(crate) fn kind_of(path: &Path) -> Kind {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Kind::Link,
        Ok(metadata) if metadata.is_file() => Kind::File {
            size: metadata.len(),
        },
        Ok(metadata) if metadata.is_dir() => Kind::Folder,
        Ok(_) => Kind::Other,
        Err(_) => Kind::Missing,
    }
}

/// Changed, untracked and ignored paths, as `git status` lists them
/// (folders it does not descend into are listed once). Reserved paths are
/// left out. Names that are not UTF-8 are returned apart.
pub(crate) fn candidates(git: &WorkspaceGit<'_>) -> Result<(Vec<Candidate>, Vec<String>)> {
    let raw = git.bytes_opts(
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=all",
            "--no-renames",
        ],
        &RunOpts {
            // Never refresh the entry's own index.
            env: vec![("GIT_OPTIONAL_LOCKS", "0".into())],
            ..RunOpts::default()
        },
    )?;
    let mut listed = Vec::new();
    let mut unreadable = Vec::new();
    for record in raw.split(|byte| *byte == 0).filter(|r| r.len() > 3) {
        let code = &record[..2];
        let Ok(path) = std::str::from_utf8(&record[3..]) else {
            unreadable.push(String::from_utf8_lossy(&record[3..]).to_string());
            continue;
        };
        let folder = path.ends_with('/');
        let path = path.trim_end_matches('/').to_string();
        if path.is_empty() || is_reserved_path(&path) || path == ".instafy" {
            continue;
        }
        let listed_as = match code {
            b"??" => Listed::Untracked,
            b"!!" => Listed::Ignored,
            _ => Listed::Tracked,
        };
        listed.push(Candidate {
            path,
            listed: listed_as,
            folder,
        });
    }
    listed.sort_by(|a, b| a.path.cmp(&b.path));
    listed.dedup_by(|a, b| a.path == b.path);
    Ok((listed, unreadable))
}

/// Sort the candidates of the work tree at `root`.
pub(crate) fn sort(root: &Path, listed: &[Candidate]) -> Sorted {
    let mut sorted = Sorted::default();
    for candidate in listed {
        let path = candidate.path.as_str();
        let kind = kind_of(&root.join(path));
        if candidate.folder || kind == Kind::Folder {
            match candidate.listed {
                Listed::Ignored if !within_build_output(path, true) => {
                    walk_private(root, path, "ignored", &mut sorted);
                }
                Listed::Ignored => sorted.skipped.push(Skipped {
                    path: format!("{path}/"),
                    size: crate::hosted::tree_size(&root.join(path)),
                    reason: "excluded",
                }),
                // A repository inside the work tree, or a folder git will not
                // descend into: never turned into a gitlink.
                _ => sorted.skipped.push(Skipped {
                    path: format!("{path}/"),
                    size: crate::hosted::tree_size(&root.join(path)),
                    reason: "unsupported",
                }),
            }
            continue;
        }
        if kind == Kind::Missing {
            // A tracked file the work tree no longer has.
            if deletion_allowed(path) {
                sorted.work.push(path.to_string());
            } else {
                sorted.skipped.push(Skipped {
                    path: path.to_string(),
                    size: 0,
                    reason: "excluded",
                });
            }
            continue;
        }
        sort_file(path, candidate.listed, kind, &mut sorted);
    }
    sorted.work.sort();
    sorted.work.dedup();
    sorted
}

fn sort_file(path: &str, listed: Listed, kind: Kind, sorted: &mut Sorted) {
    let size = match kind {
        Kind::File { size } => size,
        _ => 0,
    };
    let skip = |reason: &'static str, sorted: &mut Sorted| {
        sorted.skipped.push(Skipped {
            path: path.to_string(),
            size,
            reason,
        })
    };
    let private = |reason: &'static str, sorted: &mut Sorted| {
        sorted.private.push(PrivatePath {
            path: path.to_string(),
            reason,
            commit: None,
        })
    };
    let secret = is_secret_path(path);
    if is_root_chat_upload(path) && matches!(kind, Kind::File { .. }) {
        sorted.attachments.push(path.to_string());
    } else if kind == Kind::Other {
        skip("unsupported", sorted);
    } else if within_build_output(path, false) && !secret {
        skip("excluded", sorted);
    } else if size > MAX_PUBLISH_BLOB_BYTES {
        skip("too_large", sorted);
    } else if is_legacy_attachment_path(path) {
        private("attachment", sorted);
    } else if secret {
        private("secret", sorted);
    } else if listed == Listed::Ignored {
        private("ignored", sorted);
    } else if git_service::policy::repo_policy_denies_path(path) || is_sync_reserved_path(path) {
        skip("excluded", sorted);
    } else if is_unsafe_path(path) {
        skip("unsupported", sorted);
    } else {
        sorted.work.push(path.to_string());
    }
}

/// Every file under the folder `path`, for the private archive: regular
/// files and links (as links) up to the size cap; repositories inside it,
/// special files and larger files are listed as skipped. Links to folders are
/// never entered.
pub(crate) fn walk_private(root: &Path, path: &str, reason: &'static str, sorted: &mut Sorted) {
    let mut pending = vec![path.to_string()];
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(root.join(&folder)) else {
            sorted.skipped.push(Skipped {
                path: format!("{folder}/"),
                size: 0,
                reason: "unsupported",
            });
            continue;
        };
        let mut names: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            match entry.file_name().into_string() {
                Ok(name) => names.push(name),
                Err(name) => sorted.skipped.push(Skipped {
                    path: format!("{folder}/{}", name.to_string_lossy()),
                    size: 0,
                    reason: "unsupported",
                }),
            }
        }
        names.sort();
        for name in names {
            let child = if folder.is_empty() {
                name.clone()
            } else {
                format!("{folder}/{name}")
            };
            if is_reserved_path(&child) || child == ".instafy" {
                if name.eq_ignore_ascii_case(".git") {
                    // A repository inside the folder: its history is not
                    // copied file by file.
                    sorted.skipped.push(Skipped {
                        path: format!("{child}/"),
                        size: crate::hosted::tree_size(&root.join(&child)),
                        reason: "unsupported",
                    });
                }
                continue;
            }
            match kind_of(&root.join(&child)) {
                Kind::Folder => pending.push(child),
                Kind::File { size } if size > MAX_PUBLISH_BLOB_BYTES => {
                    sorted.skipped.push(Skipped {
                        path: child,
                        size,
                        reason: "too_large",
                    })
                }
                Kind::File { .. } | Kind::Link => {
                    let reason = if is_secret_path(&child) {
                        "secret"
                    } else {
                        reason
                    };
                    sorted.private.push(PrivatePath {
                        path: child,
                        reason,
                        commit: None,
                    });
                }
                Kind::Other => sorted.skipped.push(Skipped {
                    path: child,
                    size: 0,
                    reason: "unsupported",
                }),
                Kind::Missing => {}
            }
        }
    }
}

/// A chat image the web app wrote into the space's root.
pub(crate) fn is_root_chat_upload(path: &str) -> bool {
    !path.contains('/')
        && path.len() > 12
        && path
            .get(..12)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("chat-upload-"))
}

/// Whether `path` lies in a build output folder (for a folder, or is one).
pub(crate) fn within_build_output(path: &str, folder: bool) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    let parents = if folder {
        &segments[..]
    } else {
        &segments[..segments.len().saturating_sub(1)]
    };
    parents
        .iter()
        .any(|segment| BUILD_OUTPUT_DIRS.contains(segment))
}

/// The paths among `current` whose work-tree state is a copy of a version
/// canonical `main` already has, left behind when an old sync moved the
/// branch without the files:
///
/// - a file whose content (and mode) some commit of `main`'s history holds at
///   that path (the version main has now included);
/// - a deleted file that a commit the old sync reset away from lacked, when
///   `main` reaches that commit (the reflog's `reset: moving to origin/main`
///   entries, or `ORIG_HEAD`).
///
/// A version only a local commit held is never stale: it is not on
/// canonical, so it is kept.
pub(crate) fn stale_paths(
    git: &WorkspaceGit<'_>,
    root: &Path,
    main: &str,
    current: &BTreeMap<String, Option<TreeEntry>>,
) -> Result<BTreeSet<String>> {
    let mut stale = BTreeSet::new();
    let present: Vec<String> = current
        .iter()
        .filter(|(_, entry)| entry.is_some())
        .map(|(path, _)| path.clone())
        .collect();
    let versions = canonical_versions(git, main, &present)?;
    for path in &present {
        let Some(Some(entry)) = current.get(path) else {
            continue;
        };
        if versions
            .get(path)
            .is_some_and(|known| known.contains(&(entry.mode.clone(), entry.oid.clone())))
        {
            stale.insert(path.clone());
        }
    }

    let absent: Vec<String> = current
        .iter()
        .filter(|(_, entry)| entry.is_none())
        .map(|(path, _)| path.clone())
        .collect();
    if absent.is_empty() {
        return Ok(stale);
    }
    let mut old_heads = Vec::new();
    if let Ok(workspace) = crate::workspace_fs::WorkspaceDir::open(root) {
        if let Some(lines) = crate::stale_align::read_reflog(&workspace) {
            old_heads.extend(crate::stale_align::old_heads_before_resets(
                &lines,
                "origin/main",
            ));
        }
    }
    if let Some(orig) = git.commit_id("ORIG_HEAD")? {
        old_heads.push(orig);
    }
    let mut checked = BTreeSet::new();
    for old in old_heads.into_iter().take(40) {
        let Some(old) = git.commit_id(&old).ok().flatten() else {
            continue;
        };
        if !checked.insert(old.clone()) || !git.is_ancestor(&old, main).unwrap_or(false) {
            continue;
        }
        let held = git.tree_entries(&old, &absent)?;
        for path in &absent {
            if !held.contains_key(path) {
                stale.insert(path.clone());
            }
        }
    }
    Ok(stale)
}

/// Every `(mode, blob)` each path held anywhere in `main`'s history.
fn canonical_versions(
    git: &WorkspaceGit<'_>,
    main: &str,
    paths: &[String],
) -> Result<BTreeMap<String, BTreeSet<(String, String)>>> {
    let mut versions: BTreeMap<String, BTreeSet<(String, String)>> = BTreeMap::new();
    for chunk in paths.chunks(256) {
        let mut args: Vec<&str> = vec![
            "log",
            "--format=",
            "--raw",
            "-z",
            "--no-renames",
            "--no-abbrev",
            "-m",
            "--full-history",
            "--root",
            "--end-of-options",
            main,
            "--",
        ];
        args.extend(chunk.iter().map(String::as_str));
        let raw = git.bytes_opts(
            &args,
            &RunOpts {
                literal_pathspecs: true,
                ..RunOpts::default()
            },
        )?;
        for change in parse_raw(&raw) {
            let known = versions.entry(change.path).or_default();
            for (mode, oid) in [change.old, change.new] {
                if !oid.bytes().all(|byte| byte == b'0') {
                    known.insert((mode, oid));
                }
            }
        }
    }
    Ok(versions)
}

/// One `--raw` record with both sides.
pub(crate) struct RawRecord {
    pub old: (String, String),
    pub new: (String, String),
    pub path: String,
}

pub(crate) fn parse_raw(raw: &[u8]) -> Vec<RawRecord> {
    let mut records = Vec::new();
    let mut fields = raw.split(|byte| *byte == 0).filter(|r| !r.is_empty());
    while let Some(meta) = fields.next() {
        let meta = String::from_utf8_lossy(meta);
        let Some(meta) = meta.trim_start().strip_prefix(':') else {
            continue;
        };
        let Some(path) = fields.next() else { break };
        let parts: Vec<&str> = meta.split(' ').collect();
        if parts.len() < 5 {
            continue;
        }
        records.push(RawRecord {
            old: (parts[0].to_string(), parts[2].to_string()),
            new: (parts[1].to_string(), parts[3].to_string()),
            path: String::from_utf8_lossy(path).to_string(),
        });
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_output_is_recognised_by_folder() {
        assert!(within_build_output("node_modules", true));
        assert!(within_build_output("web/dist/app.js", false));
        assert!(within_build_output("a/.next/cache", true));
        assert!(!within_build_output("src/build.rs", false));
        assert!(!within_build_output("build", false));
        assert!(!within_build_output("tmp/big", false));
        let skipped = |path: &str| Skipped {
            path: path.to_string(),
            size: 0,
            reason: "excluded",
        };
        assert!(skipped("node_modules/").rebuildable());
        assert!(skipped("pkg/target/debug/x").rebuildable());
        assert!(!skipped("tmp/big").rebuildable());
        assert!(!skipped("data/").rebuildable());
    }

    #[test]
    fn root_chat_uploads_are_recognised() {
        assert!(is_root_chat_upload("chat-upload-1-a.png"));
        assert!(is_root_chat_upload("Chat-Upload-1"));
        assert!(!is_root_chat_upload("chat-upload-"));
        assert!(!is_root_chat_upload("img/chat-upload-1.png"));
        assert!(!is_root_chat_upload("chat-uploads.md"));
    }

    #[test]
    fn raw_records_keep_both_sides() {
        let raw = b":100644 100755 aaaa bbbb M\0x/y z\0\n:000000 120000 0000 cccc A\0link\0";
        let records = parse_raw(raw);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].old, ("100644".to_string(), "aaaa".to_string()));
        assert_eq!(records[0].new, ("100755".to_string(), "bbbb".to_string()));
        assert_eq!(records[0].path, "x/y z");
        assert_eq!(records[1].new, ("120000".to_string(), "cccc".to_string()));
        assert_eq!(records[1].path, "link");
    }
}
