//! A Claude Code turn's folder of its own (docs/Local-Engine-Turns.md 11.23, D55).
//!
//! On a computer that runs Claude Code turns at once, each turn works in a copy of the space's
//! folder, made after the pre-turn refresh, the scaffold and the controller's pages: a
//! copy-on-write clone of the whole folder (APFS `clonefile`), so tracked, untracked and ignored
//! files and the repository are all there, at the cost of a moment and no disk until a file in
//! it changes ([`TurnFolder::clone_of`]).
//!
//! - **Its place** is `<WORKSPACE_DIR>/.instafy-turns/<space id>/<name>` ([`TurnFolderPlace`]):
//!   outside the space's folder, so no tool or watcher there sees it, and on its volume. The name
//!   is the turn's agent's, so an agent's Claude Code sessions, kept by folder, stay in one place;
//!   a second running turn of the same agent takes `<name>-2`, and so on.
//! - **What the turn changed** is what differs between the folder's files as the turn began and
//!   as it ended, both read as trees of the folder's own copy of the repository ([`snapshot`],
//!   [`changed_files`]): ignored files stay out, as a status delta leaves them out, and a commit
//!   Claude Code made in its copy counts as a change.
//! - **Its save** merges into the space's folder ([`plan_merge`],
//!   `workspace_commit::save_turn_folder`): a path the space's folder still holds as the turn
//!   found it takes the turn's version, a text file both changed merges three ways, and anything
//!   else is kept aside, never overwritten.
//! - **It is removed** when the turn is done with it, in the background ([`TurnFolder`]'s drop),
//!   and a runtime that starts removes what an earlier process left ([`TurnFolderPlace::of`]).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use anyhow::{Context, Result, anyhow, bail};
use uuid::Uuid;

use super::{CodexFileDescriptor, FileChangeDescriptor, FileChangeKind};

/// The folder under `WORKSPACE_DIR` that holds each space's turn folders.
pub(crate) const PLACE: &str = ".instafy-turns";

/// The most turn folders one name takes at once: `<name>`, `<name>-2`, … A runtime runs at most
/// `MAX_TURNS_AT_ONCE` turns at once, so this is never reached.
const MAX_NAMES: usize = 9;

/// How long a git command of a turn folder may take.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// The turn folders this process holds, by path: a name stays taken until its folder is gone.
static IN_USE: LazyLock<parking_lot::Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashSet::new()));

/// Where one space's turn folders go, when a turn folder can be a clone of the space's folder.
#[derive(Clone, Debug)]
pub(crate) struct TurnFolderPlace {
    root: PathBuf,
    space_folder: PathBuf,
}

impl TurnFolderPlace {
    /// The place of `project_id`'s turn folders under `workspace_root`, when each can be a
    /// copy-on-write clone of `space_folder`: on macOS, outside the space's folder (and the space's
    /// folder outside it), and on the same APFS volume. What an earlier process left there is
    /// removed. `None` otherwise: the computer then runs one turn at a time, in the space's
    /// folder (D54).
    pub(crate) fn of(workspace_root: &Path, space_folder: &Path, project_id: Uuid) -> Option<Self> {
        if !cfg!(target_os = "macos") {
            return None;
        }
        let root = workspace_root.join(PLACE).join(project_id.to_string());
        std::fs::create_dir_all(&root).ok()?;
        let root = root.canonicalize().ok()?;
        let space_folder = space_folder.canonicalize().ok()?;
        if root.starts_with(&space_folder) || space_folder.starts_with(&root) {
            return None;
        }
        if !clones_between(&space_folder, &root) {
            return None;
        }
        let place = Self { root, space_folder };
        place.remove_leftovers();
        Some(place)
    }

    /// Removes every folder here that no turn of this process holds: what a process that stopped
    /// mid-turn left.
    fn remove_leftovers(&self) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        let in_use = IN_USE.lock().clone();
        for entry in entries.flatten() {
            let path = entry.path();
            if !in_use.contains(&path) {
                remove(&path);
            }
        }
    }
}

/// Whether a folder of `space_folder`'s can be cloned into `root`: both on one APFS volume.
#[cfg(target_os = "macos")]
fn clones_between(space_folder: &Path, root: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(space), Ok(place)) = (std::fs::metadata(space_folder), std::fs::metadata(root)) else {
        return false;
    };
    space.dev() == place.dev() && is_apfs(space_folder)
}

#[cfg(not(target_os = "macos"))]
fn clones_between(_space_folder: &Path, _root: &Path) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn is_apfs(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `statfs` writes into the zeroed buffer it is given, and `path` is a valid C string
    // for the length of the call.
    let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut stats) } != 0 {
        return false;
    }
    let name: Vec<u8> = stats
        .f_fstypename
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    name == b"apfs"
}

/// Clones `source`, a folder, to `target`, which must not exist: one `clonefile` of the whole
/// tree, links copied as links.
#[cfg(target_os = "macos")]
fn clone_tree(source: &Path, target: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    /// `CLONE_NOFOLLOW` of `<sys/clonefile.h>`: a link is cloned as a link.
    const CLONE_NOFOLLOW: u32 = 0x0001;
    let source_c = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let target_c = std::ffi::CString::new(target.as_os_str().as_bytes())?;
    // SAFETY: both are valid C strings for the length of the call.
    if unsafe { libc::clonefile(source_c.as_ptr(), target_c.as_ptr(), CLONE_NOFOLLOW) } != 0 {
        return Err(std::io::Error::last_os_error()).context("clonefile failed");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn clone_tree(_source: &Path, _target: &Path) -> Result<()> {
    bail!("a turn folder is a copy-on-write clone, which only macOS makes here")
}

/// Removes `path` and everything under it, links as links, ignoring what is already gone.
fn remove(path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            let _ = std::fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = std::fs::remove_file(path);
        }
        Err(_) => {}
    }
}

/// A turn's folder of its own, removed in the background once dropped.
#[derive(Debug)]
pub(crate) struct TurnFolder {
    path: PathBuf,
}

impl TurnFolder {
    /// A clone of `place`'s space folder, as it is now, named for `name` (the turn's agent):
    /// `name`, or `name-2` and so on while another turn of this process holds a name.
    pub(crate) async fn clone_of(place: &TurnFolderPlace, name: &str) -> Result<Self> {
        let place = place.clone();
        let name = folder_name(name);
        tokio::task::spawn_blocking(move || {
            let path = take_a_name(&place.root, &name)?;
            // A folder an earlier process left under this name goes first.
            remove(&path);
            if let Err(error) = clone_tree(&place.space_folder, &path) {
                IN_USE.lock().remove(&path);
                remove(&path);
                return Err(error);
            }
            Ok(Self { path })
        })
        .await
        .map_err(|error| anyhow!("the turn folder task failed: {error}"))?
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TurnFolder {
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.path);
        // A large folder takes seconds to remove: never on the turn's way.
        let removal = std::thread::Builder::new()
            .name("turn-folder-removal".to_string())
            .spawn({
                let path = path.clone();
                move || {
                    remove(&path);
                    IN_USE.lock().remove(&path);
                }
            });
        if removal.is_err() {
            remove(&path);
            IN_USE.lock().remove(&path);
        }
    }
}

/// `name` as a folder name: letters, digits, `-` and `_` only, at most 64 of them, `turn` when
/// none is left.
fn folder_name(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect();
    if name.is_empty() {
        "turn".to_string()
    } else {
        name
    }
}

/// The first of `name`, `name-2`, … under `root` that no turn of this process holds, now taken.
fn take_a_name(root: &Path, name: &str) -> Result<PathBuf> {
    let mut in_use = IN_USE.lock();
    for index in 1..=MAX_NAMES {
        let candidate = if index == 1 {
            root.join(name)
        } else {
            root.join(format!("{name}-{index}"))
        };
        if in_use.insert(candidate.clone()) {
            return Ok(candidate);
        }
    }
    bail!("every turn folder name of {name} is taken")
}

/// `git` in `folder`'s own repository, as the turn's status reads run it (`workspace_git_args`),
/// with stat checks that a clone keeps: a clone's files have new inodes and change times, but
/// their sizes and modification times are the space folder's.
fn git(folder: &Path, args: &[&str], index: Option<&Path>) -> tokio::process::Command {
    let mut full = vec![
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.checkStat=minimal",
        "-c",
        "core.trustctime=false",
        "-c",
        "core.quotePath=false",
    ];
    full.extend_from_slice(args);
    let mut command = tokio::process::Command::new("git");
    command
        .args(super::workspace_git_args(folder, &full))
        .current_dir(folder);
    crate::model_environment::apply_allowlisted_tokio_environment(&mut command, &[]);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    command
}

/// Runs `command`; its stdout when it succeeds.
async fn output_of(mut command: tokio::process::Command, what: &str) -> Result<Vec<u8>> {
    let output = tokio::time::timeout(GIT_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow!("git {what} took too long"))?
        .with_context(|| format!("git {what} did not run"))?;
    if !output.status.success() {
        bail!(
            "git {what} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

/// The repository directory of `folder`: its `.instafy/.git`, as the origin's checkout keeps
/// it, else its own `.git` directory.
fn git_dir(folder: &Path) -> Option<PathBuf> {
    [folder.join(".instafy").join(".git"), folder.join(".git")]
        .into_iter()
        .find(|dir| dir.is_dir())
}

/// The tree of `folder`'s files as they are now, by its own repository: what `git add -A` stages
/// into an index of its own, so the files the repository ignores stay out, written into the
/// repository's objects. Neither the repository's index nor its HEAD moves. `None` when it
/// cannot be read.
pub(crate) async fn snapshot(folder: &Path) -> Option<String> {
    match snapshot_tree(folder).await {
        Ok(tree) => Some(tree),
        Err(error) => {
            tracing::warn!(?error, "a turn folder's files could not be read as a tree");
            None
        }
    }
}

async fn snapshot_tree(folder: &Path) -> Result<String> {
    let git_dir = git_dir(folder).ok_or_else(|| anyhow!("the folder has no repository"))?;
    let scratch = tempfile::Builder::new()
        .prefix("instafy-turn-snapshot-")
        .tempdir()
        .context("no scratch folder for the snapshot's index")?;
    let index = scratch.path().join("index");
    // The repository's own index, when it has one, so only files that changed are read again.
    let own_index = git_dir.join("index");
    if own_index.is_file() {
        tokio::fs::copy(&own_index, &index)
            .await
            .context("the repository's index could not be copied")?;
    } else {
        output_of(
            git(folder, &["read-tree", "--empty"], Some(&index)),
            "read-tree",
        )
        .await?;
    }
    // The runtime's own `.instafy/` (its logs, its staging, the controller's pages) is never a
    // turn's to save (`is_reserved_path`), so it is not read at all.
    output_of(
        git(
            folder,
            &["add", "-A", "--", ".", ":(top,exclude).instafy"],
            Some(&index),
        ),
        "add",
    )
    .await?;
    let tree = output_of(git(folder, &["write-tree"], Some(&index)), "write-tree").await?;
    let tree = String::from_utf8(tree)?.trim().to_string();
    if tree.is_empty() || !tree.chars().all(|character| character.is_ascii_hexdigit()) {
        bail!("git write-tree gave no tree id");
    }
    Ok(tree)
}

/// What a tree held at a path, as a turn folder's save reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BaseEntry {
    /// The blob's id.
    pub(crate) oid: String,
    /// Whether it is a link (mode 120000), which a save never sends.
    pub(crate) link: bool,
}

/// What changed between the trees `from` and `to` of `folder`'s repository, as the files a save
/// sends: created, changed or deleted, by folder-relative path, in path order, with the paths a
/// save never sends left out (as `status_delta_files_for_checkpoint` leaves them out). `None`
/// when it cannot be read.
pub(super) async fn changed_files(
    folder: &Path,
    from: &str,
    to: &str,
) -> Option<Vec<CodexFileDescriptor>> {
    let listed = output_of(
        git(
            folder,
            &[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--name-status",
                from,
                to,
            ],
            None,
        ),
        "diff-tree",
    )
    .await
    .map_err(|error| tracing::warn!(?error, "a turn folder's changes could not be read"))
    .ok()?;
    Some(files_of_name_status(&listed))
}

/// The files of `git diff-tree -z --name-status` output.
fn files_of_name_status(listed: &[u8]) -> Vec<CodexFileDescriptor> {
    let mut fields = listed
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        let Ok(path) = std::str::from_utf8(path) else {
            continue;
        };
        let kind = match status.first() {
            Some(b'A') => FileChangeKind::Created,
            Some(b'D') => FileChangeKind::Deleted,
            _ => FileChangeKind::Changed,
        };
        let Some(sanitized) = super::sanitize_relative_workspace_path(path) else {
            continue;
        };
        let path = sanitized.to_string_lossy().replace('\\', "/");
        if path.is_empty()
            || origin_http_server::paths::is_reserved_path(&path)
            || origin_http_server::publish_policy::is_unpublishable(&path)
        {
            continue;
        }
        files.push(changed_file(path, kind));
    }
    files.sort_by(|left, right| left.workspace_path.cmp(&right.workspace_path));
    files
}

/// A file a turn changed, as its save and its reply list it.
fn changed_file(path: String, kind: FileChangeKind) -> CodexFileDescriptor {
    let raw = match kind {
        FileChangeKind::Created => serde_json::json!({ "type": "created" }),
        FileChangeKind::Deleted => serde_json::json!({ "type": "deleted" }),
        _ => serde_json::json!({ "type": "changed" }),
    };
    CodexFileDescriptor {
        path: path.clone(),
        workspace_path: path,
        label: None,
        description: None,
        mime_type: None,
        content: None,
        content_base64: None,
        change: Some(FileChangeDescriptor {
            kind,
            lines: Vec::new(),
            raw,
        }),
    }
}

/// What the tree `tree` of `folder`'s repository held at each of `paths`: an entry for a file or
/// a link, none for a path it did not hold as one. `None` when it cannot be read.
pub(crate) async fn entries_in(
    folder: &Path,
    tree: &str,
    paths: &[String],
) -> Option<BTreeMap<String, BaseEntry>> {
    let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let listed = output_of(
        git(folder, &["ls-tree", "-r", "-z", "--full-tree", tree], None),
        "ls-tree",
    )
    .await
    .map_err(|error| tracing::warn!(?error, "a turn folder's first tree could not be read"))
    .ok()?;
    let mut entries = BTreeMap::new();
    for line in listed
        .split(|byte| *byte == 0)
        .filter(|line| !line.is_empty())
    {
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        let Some((meta, path)) = line.split_once('\t') else {
            continue;
        };
        if !wanted.contains(path) {
            continue;
        }
        let mut meta = meta.split(' ');
        let (Some(mode), Some("blob"), Some(oid)) = (meta.next(), meta.next(), meta.next()) else {
            continue;
        };
        entries.insert(
            path.to_string(),
            BaseEntry {
                oid: oid.to_string(),
                link: mode == "120000",
            },
        );
    }
    Some(entries)
}

/// The bytes of the blob `oid` in `folder`'s repository.
async fn blob_bytes(folder: &Path, oid: &str) -> Result<Vec<u8>> {
    output_of(git(folder, &["cat-file", "blob", oid], None), "cat-file").await
}

/// What a turn folder's save sends, and what it keeps aside.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct MergePlan {
    /// Files to write, with the bytes the space's folder gets.
    pub(crate) writes: Vec<(String, Vec<u8>)>,
    /// Files to remove.
    pub(crate) deletes: Vec<String>,
    /// What the space's folder must hold at each path written or removed: the blob id the plan
    /// read there, or `None` for nothing (the origin's `expected`).
    pub(crate) expected: BTreeMap<String, Option<String>>,
    /// The paths among them whose content is a merge of the turn's change and the space's.
    pub(crate) merged: Vec<String>,
    /// The paths the turn changed that the space's folder changed too, where the two could not
    /// be merged: the space keeps its version, and the turn's is kept aside.
    pub(crate) kept: Vec<String>,
}

/// One version of a path: a file's bytes, nothing, or something no save sends (a link, a folder,
/// a file that cannot be read).
#[derive(Debug, PartialEq, Eq)]
enum Version {
    File(Vec<u8>),
    Nothing,
    Other,
}

fn version_at(folder: &Path, path: &str) -> Version {
    let absolute = folder.join(path);
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) if metadata.is_file() => match std::fs::read(&absolute) {
            Ok(bytes) => Version::File(bytes),
            Err(_) => Version::Other,
        },
        Ok(_) => Version::Other,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Version::Nothing,
        Err(_) => Version::Other,
    }
}

/// The blob id a version has, as the origin reads one; `None` for nothing.
fn version_oid(version: &Version) -> Option<Option<String>> {
    match version {
        Version::File(bytes) => Some(Some(origin_http_server::workspace_git::blob_oid(bytes))),
        Version::Nothing => Some(None),
        Version::Other => None,
    }
}

/// Plans a turn folder's save (11.23): for each of `files` the turn changed, its version in
/// `turn_folder`, what the turn found there (`base`, read from the turn's first tree), and what
/// `space_folder` holds now.
/// - The space still holds what the turn found: the turn's version goes, with that as expected.
/// - The space already holds the turn's version: nothing goes.
/// - The space changed it too, and all three are text: they merge three ways (`git merge-file`).
///   A clean merge goes, with the space's version now as expected.
/// - Anything else (lines both changed, a binary file, one side removed it, a link) is kept.
pub(super) async fn plan_merge(
    turn_folder: &Path,
    space_folder: &Path,
    files: &[CodexFileDescriptor],
    base: &BTreeMap<String, BaseEntry>,
    agent: &str,
) -> Result<MergePlan> {
    let mut plan = MergePlan::default();
    for file in files {
        if file.is_read_reference() {
            continue;
        }
        let path = file.workspace_path.clone();
        let theirs = version_at(turn_folder, &path);
        let current = version_at(space_folder, &path);
        let found = base.get(&path);
        if found.is_some_and(|entry| entry.link)
            || matches!(theirs, Version::Other)
            || matches!(current, Version::Other)
        {
            plan.kept.push(path);
            continue;
        }
        let found_oid = found.map(|entry| entry.oid.clone());
        let current_oid = version_oid(&current).flatten();
        if current_oid == found_oid {
            match theirs {
                Version::File(bytes) => plan.writes.push((path.clone(), bytes)),
                Version::Nothing if matches!(current, Version::Nothing) => continue,
                Version::Nothing => plan.deletes.push(path.clone()),
                Version::Other => unreachable!("kept above"),
            }
            plan.expected.insert(path, found_oid);
            continue;
        }
        if theirs == current {
            continue;
        }
        let (Version::File(ours), Version::File(other), Some(found_oid)) =
            (&current, &theirs, found_oid.as_deref())
        else {
            plan.kept.push(path);
            continue;
        };
        let found_bytes = blob_bytes(turn_folder, found_oid).await?;
        match merge_three_ways(ours, &found_bytes, other, agent).await? {
            Some(merged) => {
                plan.writes.push((path.clone(), merged));
                plan.expected.insert(path.clone(), current_oid);
                plan.merged.push(path);
            }
            None => plan.kept.push(path),
        }
    }
    Ok(plan)
}

/// Whether `bytes` read as text a line merge can take: no NUL byte, and UTF-8.
fn is_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

/// `ours` (the space's version now) and `theirs` (the turn's), both changed from `found`, merged
/// by `git merge-file`; `None` when lines both changed, or any of them is not text.
async fn merge_three_ways(
    ours: &[u8],
    found: &[u8],
    theirs: &[u8],
    agent: &str,
) -> Result<Option<Vec<u8>>> {
    if !(is_text(ours) && is_text(found) && is_text(theirs)) {
        return Ok(None);
    }
    let scratch = tempfile::Builder::new()
        .prefix("instafy-turn-merge-")
        .tempdir()
        .context("no scratch folder for a merge")?;
    let [ours_path, found_path, theirs_path] =
        ["space", "found", "turn"].map(|name| scratch.path().join(name));
    for (path, bytes) in [
        (&ours_path, ours),
        (&found_path, found),
        (&theirs_path, theirs),
    ] {
        tokio::fs::write(path, bytes)
            .await
            .context("a merge's version could not be written")?;
    }
    let label = format!("@{}", folder_name(agent));
    let mut command = tokio::process::Command::new("git");
    command
        .args(["merge-file", "-p", "-q", "-L", "space", "-L", "found", "-L"])
        .arg(&label)
        .args([&ours_path, &found_path, &theirs_path])
        .current_dir(scratch.path());
    crate::model_environment::apply_allowlisted_tokio_environment(&mut command, &[]);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(GIT_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow!("git merge-file took too long"))?
        .context("git merge-file did not run")?;
    match output.status.code() {
        Some(0) => Ok(Some(output.stdout)),
        Some(code) if (1..=127).contains(&code) => Ok(None),
        _ => bail!(
            "git merge-file failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_in(folder: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .current_dir(folder)
            .output()
            .expect("git");
        assert!(output.status.success(), "git {args:?}: {output:?}");
        String::from_utf8(output.stdout).expect("utf8")
    }

    /// A repository at `folder` with `files` committed.
    fn repository(folder: &Path, files: &[(&str, &str)]) {
        git_in(folder, &["init", "-q", "-b", "main"]);
        for (path, content) in files {
            let absolute = folder.join(path);
            std::fs::create_dir_all(absolute.parent().expect("parent")).expect("dir");
            std::fs::write(absolute, content).expect("write");
        }
        git_in(folder, &["add", "-A"]);
        git_in(folder, &["commit", "-q", "-m", "first"]);
    }

    fn paths(files: &[CodexFileDescriptor]) -> Vec<(String, String)> {
        files
            .iter()
            .map(|file| {
                (
                    file.workspace_path.clone(),
                    file.change
                        .as_ref()
                        .map(|change| change.raw["type"].as_str().unwrap_or("").to_string())
                        .unwrap_or_default(),
                )
            })
            .collect()
    }

    #[test]
    fn a_folder_name_keeps_only_safe_characters() {
        assert_eq!(folder_name("4e9f3c4a-6a47-4a0e"), "4e9f3c4a-6a47-4a0e");
        assert_eq!(folder_name("../../etc"), "etc");
        assert_eq!(folder_name("@alpha_1"), "alpha_1");
        assert_eq!(folder_name("/"), "turn");
        assert_eq!(folder_name(&"a".repeat(80)).len(), 64);
    }

    #[test]
    fn a_second_turn_of_an_agent_takes_the_next_name() {
        let root = tempfile::tempdir().expect("root");
        let first = take_a_name(root.path(), "agent").expect("first");
        let second = take_a_name(root.path(), "agent").expect("second");
        assert_eq!(first, root.path().join("agent"));
        assert_eq!(second, root.path().join("agent-2"));
        IN_USE.lock().remove(&first);
        assert_eq!(take_a_name(root.path(), "agent").expect("again"), first);
        IN_USE.lock().remove(&first);
        IN_USE.lock().remove(&second);
    }

    /// What a turn changed is what differs between the folder's trees as it began and ended:
    /// edits, new and removed files, a commit the turn made itself, and none of what the
    /// repository ignores, nor a change made and taken back.
    #[tokio::test]
    async fn a_turn_changed_what_differs_between_its_first_and_last_tree() {
        let folder = tempfile::tempdir().expect("folder");
        repository(
            folder.path(),
            &[
                ("README.md", "one\n"),
                ("gone.md", "bye\n"),
                ("same.md", "same\n"),
                (".gitignore", "node_modules/\n"),
            ],
        );
        // An edit the person had not saved when the turn began is where the turn starts.
        std::fs::write(folder.path().join("draft.md"), "draft\n").expect("draft");
        // The runtime's own files are never read into a tree.
        std::fs::create_dir_all(folder.path().join(".instafy/agent")).expect("runtime's");
        std::fs::write(folder.path().join(".instafy/agent/log"), "runtime\n").expect("runtime's");
        let first = snapshot(folder.path()).await.expect("first tree");

        std::fs::write(folder.path().join("README.md"), "one\ntwo\n").expect("edit");
        std::fs::remove_file(folder.path().join("gone.md")).expect("remove");
        std::fs::create_dir_all(folder.path().join("node_modules/x")).expect("ignored");
        std::fs::write(folder.path().join("node_modules/x/index.js"), "x\n").expect("ignored");
        std::fs::write(folder.path().join("same.md"), "changed\n").expect("edit");
        std::fs::write(folder.path().join("same.md"), "same\n").expect("taken back");
        std::fs::write(folder.path().join("committed.md"), "by the turn\n").expect("new");
        git_in(folder.path(), &["add", "committed.md"]);
        git_in(
            folder.path(),
            &["commit", "-q", "-m", "the turn's own commit"],
        );
        std::fs::write(folder.path().join(".instafy/agent/log"), "runtime, later\n").expect("log");
        let last = snapshot(folder.path()).await.expect("last tree");
        assert!(
            !git_in(folder.path(), &["ls-tree", "-r", "--name-only", &last]).contains(".instafy"),
            "the runtime's own files stay out"
        );

        let files = changed_files(folder.path(), &first, &last)
            .await
            .expect("changes");
        assert_eq!(
            paths(&files),
            vec![
                ("README.md".to_string(), "changed".to_string()),
                ("committed.md".to_string(), "created".to_string()),
                ("gone.md".to_string(), "deleted".to_string()),
            ]
        );
        // Neither the repository's index nor its HEAD moved for the reads.
        assert!(git_in(folder.path(), &["status", "--porcelain"]).contains("README.md"));

        let entries = entries_in(
            folder.path(),
            &first,
            &[
                "README.md".to_string(),
                "committed.md".to_string(),
                "draft.md".to_string(),
            ],
        )
        .await
        .expect("entries");
        assert_eq!(
            entries.get("README.md").map(|entry| entry.oid.clone()),
            Some(origin_http_server::workspace_git::blob_oid(b"one\n"))
        );
        assert_eq!(
            entries.get("draft.md").map(|entry| entry.oid.clone()),
            Some(origin_http_server::workspace_git::blob_oid(b"draft\n"))
        );
        assert!(!entries.contains_key("committed.md"));
    }

    /// A save merges: a path the space still holds as the turn found it takes the turn's
    /// version, one it already holds as the turn left it sends nothing, a text file both changed
    /// merges three ways, and lines both changed, or a file one side removed, are kept aside.
    #[tokio::test]
    async fn a_turn_folders_save_merges_into_the_space() {
        let turn = tempfile::tempdir().expect("turn");
        let space = tempfile::tempdir().expect("space");
        let shared = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
        let files = [
            ("plain.md", "plain\n"),
            ("same.md", "same\n"),
            ("both.md", shared),
            ("clash.md", "first\n"),
            ("removed.md", "here\n"),
            ("binary.bin", "a\n"),
        ];
        repository(turn.path(), &files);
        for (path, content) in files {
            std::fs::write(space.path().join(path), content).expect("space");
        }
        let first = snapshot(turn.path()).await.expect("first");

        // The turn's changes.
        std::fs::write(turn.path().join("plain.md"), "plain, by the turn\n").expect("turn");
        std::fs::write(turn.path().join("same.md"), "same, by both\n").expect("turn");
        std::fs::write(
            turn.path().join("both.md"),
            shared.replace("two\n", "TWO, by the turn\n"),
        )
        .expect("turn");
        std::fs::write(turn.path().join("clash.md"), "the turn's\n").expect("turn");
        std::fs::write(turn.path().join("removed.md"), "edited by the turn\n").expect("turn");
        std::fs::write(turn.path().join("binary.bin"), b"\0turn").expect("turn");
        std::fs::write(turn.path().join("new.md"), "new\n").expect("turn");
        // Meanwhile, in the space (another turn's save, the person's own edit).
        std::fs::write(space.path().join("same.md"), "same, by both\n").expect("space");
        std::fs::write(
            space.path().join("both.md"),
            shared.replace("six\n", "SIX, by the space\n"),
        )
        .expect("space");
        std::fs::write(space.path().join("clash.md"), "the space's\n").expect("space");
        std::fs::remove_file(space.path().join("removed.md")).expect("space");
        std::fs::write(space.path().join("binary.bin"), b"\0space").expect("space");

        let last = snapshot(turn.path()).await.expect("last");
        let changed = changed_files(turn.path(), &first, &last)
            .await
            .expect("changed");
        let changed_paths: Vec<String> = changed
            .iter()
            .map(|file| file.workspace_path.clone())
            .collect();
        let base = entries_in(turn.path(), &first, &changed_paths)
            .await
            .expect("base");
        let plan = plan_merge(turn.path(), space.path(), &changed, &base, "alpha")
            .await
            .expect("plan");

        let blob = origin_http_server::workspace_git::blob_oid;
        let written: BTreeMap<String, String> = plan
            .writes
            .iter()
            .map(|(path, bytes)| (path.clone(), String::from_utf8_lossy(bytes).into_owned()))
            .collect();
        assert_eq!(
            written,
            BTreeMap::from([
                (
                    "both.md".to_string(),
                    shared
                        .replace("two\n", "TWO, by the turn\n")
                        .replace("six\n", "SIX, by the space\n")
                ),
                ("new.md".to_string(), "new\n".to_string()),
                ("plain.md".to_string(), "plain, by the turn\n".to_string()),
            ])
        );
        assert!(plan.deletes.is_empty());
        assert_eq!(plan.merged, ["both.md"]);
        assert_eq!(plan.kept, ["binary.bin", "clash.md", "removed.md"]);
        assert_eq!(
            plan.expected,
            BTreeMap::from([
                (
                    "both.md".to_string(),
                    Some(blob(
                        shared.replace("six\n", "SIX, by the space\n").as_bytes()
                    ))
                ),
                ("new.md".to_string(), None),
                ("plain.md".to_string(), Some(blob(b"plain\n"))),
            ])
        );
    }

    /// A turn that removes a file the space still holds as the turn found it removes it there,
    /// and one the space removed too sends nothing.
    #[tokio::test]
    async fn a_removal_goes_while_the_space_holds_what_the_turn_found() {
        let turn = tempfile::tempdir().expect("turn");
        let space = tempfile::tempdir().expect("space");
        repository(turn.path(), &[("a.md", "a\n"), ("b.md", "b\n")]);
        for (path, content) in [("a.md", "a\n"), ("b.md", "b\n")] {
            std::fs::write(space.path().join(path), content).expect("space");
        }
        let first = snapshot(turn.path()).await.expect("first");
        std::fs::remove_file(turn.path().join("a.md")).expect("turn");
        std::fs::remove_file(turn.path().join("b.md")).expect("turn");
        std::fs::remove_file(space.path().join("b.md")).expect("space");
        let last = snapshot(turn.path()).await.expect("last");
        let changed = changed_files(turn.path(), &first, &last)
            .await
            .expect("changed");
        let base = entries_in(
            turn.path(),
            &first,
            &["a.md".to_string(), "b.md".to_string()],
        )
        .await
        .expect("base");
        let plan = plan_merge(turn.path(), space.path(), &changed, &base, "beta")
            .await
            .expect("plan");
        assert_eq!(plan.deletes, ["a.md"]);
        assert!(plan.writes.is_empty() && plan.kept.is_empty(), "{plan:?}");
        assert_eq!(
            plan.expected,
            BTreeMap::from([(
                "a.md".to_string(),
                Some(origin_http_server::workspace_git::blob_oid(b"a\n"))
            )])
        );
    }

    /// On macOS a turn folder is a clone of the whole space folder, ignored files and the
    /// repository included, named for its agent, and gone once dropped; the place refuses a
    /// root inside the space's folder.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_turn_folder_is_a_clone_of_the_whole_space_folder() {
        let workspace = tempfile::tempdir().expect("workspace");
        let space = workspace.path().join("space");
        std::fs::create_dir_all(&space).expect("space");
        repository(&space, &[("README.md", "one\n"), (".gitignore", ".env\n")]);
        std::fs::write(space.join(".env"), "LOCAL=1\n").expect("ignored");
        let project = Uuid::new_v4();
        assert!(TurnFolderPlace::of(&space, &space, project).is_none());
        let Some(place) = TurnFolderPlace::of(workspace.path(), &space, project) else {
            // Not an APFS volume here: nothing to clone on.
            return;
        };
        let folder = TurnFolder::clone_of(&place, "agent-1")
            .await
            .expect("clone");
        let path = folder.path().to_path_buf();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("agent-1")
        );
        assert_eq!(
            std::fs::read_to_string(path.join(".env")).ok().as_deref(),
            Some("LOCAL=1\n")
        );
        assert_eq!(git_in(&path, &["status", "--porcelain"]), "");
        drop(folder);
        for _ in 0..50 {
            if !path.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!path.exists());
    }
}
