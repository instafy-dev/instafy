//! What a run leaves under `<root>/.salvage/`: the owner-only archive of
//! files that may never reach canonical, and the bundle of an entry's local
//! history.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use uuid::Uuid;

use super::archive::{EntryData, TarWriter};
use super::canonical::FETCHED_MAIN;
use super::classify::{self, Kind};
use super::options::Settings;
use crate::hosted::{ensure_private_dir, rename_no_replace};
use crate::workspace_fs::WorkspaceDir;
use crate::workspace_git::WorkspaceGit;

/// Local refs the bundle names besides the salvage ref.
const LOCAL_HEAD_REF: &str = "refs/instafy/salvage-local/head";
const LOCAL_WORK_REF: &str = "refs/instafy/salvage-local/work";

/// One file of the private archive.
pub(super) enum ArchiveItem {
    Worktree(String),
    Blob {
        commit: String,
        path: String,
        oid: String,
        link: bool,
        executable: bool,
    },
}

/// A work-tree file read without following any link: its bytes and whether
/// it is executable.
pub(super) fn read_worktree_file(root: &Path, path: &str) -> Result<(Vec<u8>, bool)> {
    use std::io::Read as _;
    let workspace = WorkspaceDir::open(root).with_context(|| format!("failed to open {root:?}"))?;
    let mut file = workspace
        .open_file(path)
        .with_context(|| format!("failed to open {path:?} without following links"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {path:?}"))?;
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt as _;
        file.metadata()?.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    Ok((bytes, executable))
}

pub(super) fn read_blob(git: &WorkspaceGit<'_>, oid: &str) -> Result<Vec<u8>> {
    Ok(git
        .read_objects(&[oid.to_string()])?
        .pop()
        .context("blob missing")?
        .data)
}

/// Write the private archive, never replacing an earlier one: the same
/// content is kept once, and different content gets a name of its own.
pub(super) fn write_private_archive(
    settings: &Settings,
    root: &Path,
    git: Option<&WorkspaceGit<'_>>,
    entry: &str,
    items: &[ArchiveItem],
) -> Result<Option<String>> {
    if items.is_empty() {
        return Ok(None);
    }
    let dir = settings.salvage_dir();
    ensure_private_dir(&dir)?;
    let temp = dir.join(format!(".tmp-{}.tar", Uuid::new_v4().simple()));
    let result = (|| -> Result<PathBuf> {
        let mut writer = TarWriter::create(&temp)?;
        for item in items {
            match item {
                ArchiveItem::Worktree(path) => {
                    let name = format!("worktree/{path}");
                    match classify::kind_of(&root.join(path)) {
                        Kind::Link => {
                            let target = std::fs::read_link(root.join(path))
                                .with_context(|| format!("failed to read the link {path:?}"))?;
                            writer.append(
                                &name,
                                &EntryData::Link {
                                    target: target.to_string_lossy().as_bytes().to_vec(),
                                },
                            )?;
                        }
                        _ => {
                            let (bytes, executable) = read_worktree_file(root, path)?;
                            writer.append(&name, &EntryData::File { bytes, executable })?;
                        }
                    }
                }
                ArchiveItem::Blob {
                    commit,
                    path,
                    oid,
                    link,
                    executable,
                } => {
                    let git = git.context("history items need the repository")?;
                    let bytes = read_blob(git, oid)?;
                    let name = format!("history/{commit}/{path}");
                    let data = if *link {
                        EntryData::Link { target: bytes }
                    } else {
                        EntryData::File {
                            bytes,
                            executable: *executable,
                        }
                    };
                    writer.append(&name, &data)?;
                }
            }
        }
        writer.finish()?;
        keep_archive(&dir, entry, &temp)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map(|path| Some(path.to_string_lossy().to_string()))
}

fn keep_archive(dir: &Path, entry: &str, temp: &Path) -> Result<PathBuf> {
    let target = dir.join(format!("{entry}.private.tar"));
    if classify::kind_of(&target) == Kind::Missing {
        rename_no_replace(temp, &target).with_context(|| format!("failed to keep {target:?}"))?;
        return Ok(target);
    }
    if same_content(&target, temp)? {
        std::fs::remove_file(temp).ok();
        return Ok(target);
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    for n in 1..1000 {
        let other = dir.join(format!("{entry}.private-{stamp}-{n}.tar"));
        match rename_no_replace(temp, &other) {
            Ok(()) => return Ok(other),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).with_context(|| format!("failed to keep {other:?}")),
        }
    }
    bail!("no free name for another private archive of {entry}")
}

fn same_content(a: &Path, b: &Path) -> Result<bool> {
    use sha2::{Digest as _, Sha256};
    let digest = |path: &Path| -> Result<Vec<u8>> {
        let mut file =
            std::fs::File::open(path).with_context(|| format!("failed to read {path:?}"))?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)?;
        Ok(hasher.finalize().to_vec())
    };
    Ok(digest(a)? == digest(b)?)
}

/// What the bundle holds.
pub(super) struct Bundled<'a> {
    pub(super) head: Option<&'a str>,
    /// W before any filtering.
    pub(super) raw: Option<&'a str>,
    /// The salvage ref and the commit it names.
    pub(super) pushed: Option<(&'a str, &'a str)>,
    pub(super) main: Option<&'a str>,
}

/// `<entry>.bundle`: the entry's history canonical lacks (all of it without
/// canonical `main`), under local refs of the entry's own repository.
pub(super) fn write_bundle(
    settings: &Settings,
    git: &WorkspaceGit<'_>,
    entry: &str,
    bundled: &Bundled<'_>,
) -> Result<Option<String>> {
    let mut refs: Vec<(String, String)> = Vec::new();
    if let Some((reference, tip)) = bundled.pushed {
        refs.push((reference.to_string(), tip.to_string()));
    }
    if let Some(head) = bundled.head {
        refs.push((LOCAL_HEAD_REF.to_string(), head.to_string()));
    }
    if let Some(raw) = bundled.raw.filter(|raw| Some(*raw) != bundled.head) {
        refs.push((LOCAL_WORK_REF.to_string(), raw.to_string()));
    }
    let mut needed = Vec::new();
    for (reference, tip) in refs {
        let on_main = match bundled.main {
            Some(main) => git.is_ancestor(&tip, main)?,
            None => false,
        };
        if !on_main && !needed.iter().any(|(known, _)| known == &reference) {
            needed.push((reference, tip));
        }
    }
    if needed.is_empty() {
        return Ok(None);
    }
    for (reference, tip) in &needed {
        git.ok(&["update-ref", "-m", "instafy: salvage", reference, tip])?;
    }
    let dir = settings.salvage_dir();
    ensure_private_dir(&dir)?;
    let temp = dir.join(format!(".tmp-{}.bundle", Uuid::new_v4().simple()));
    let temp_text = temp.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["bundle", "create", &temp_text];
    args.extend(needed.iter().map(|(reference, _)| reference.as_str()));
    if bundled.main.is_some() {
        args.extend(["--not", FETCHED_MAIN]);
    }
    let created = git.ok(&args);
    if let Err(error) = created {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("failed to restrict {temp:?}"))?;
    }
    let target = dir.join(format!("{entry}.bundle"));
    std::fs::rename(&temp, &target).with_context(|| format!("failed to keep {target:?}"))?;
    Ok(Some(target.to_string_lossy().to_string()))
}
