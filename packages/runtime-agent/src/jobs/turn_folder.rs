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
//! - **Its repository** is fixed when the folder is made ([`TurnRepo`]): the clone's copy of the
//!   origin's `.instafy/.git`, else of the folder's own `.git` directory. A `git init` the turn
//!   runs changes nothing of what it reads, and a folder whose `.git` is a file (a linked
//!   worktree or a submodule, which would share the person's real repository with the clone) gets
//!   no turn folder at all.
//! - **What the turn changed** has two parts, both read from how the folder began
//!   ([`TurnFolder::begin`], [`TurnFolder::changes`]):
//!   - the files a save sends: what differs between two trees of the clone's repository, as the
//!     turn began and as it ended, so ignored files stay out, as a status delta leaves them out,
//!     and a commit Claude Code made in its copy counts too;
//!   - everything else: what differs between two walks of the folder, its ignored files, Claude
//!     Code's own files, unpublishable files and nested repositories included, by kind, size and
//!     modification time, which a clone keeps.
//! - **Its save** merges the first part into the space's folder ([`plan_merge`],
//!   `workspace_commit::save_turn_folder`): a path the space's folder still holds as the turn
//!   found it takes the turn's version, a text file both changed merges three ways, and anything
//!   else is kept aside, never overwritten. The second part goes into the space's folder as it is,
//!   where the space's folder still holds what the turn found ([`bring_back`]), as a turn that ran
//!   there would have left it.
//! - **It is removed** once its changes reached the space's folder ([`TurnFolder::done`]), in the
//!   background. A record beside it ([`Record`]) says how it began, so what a process that stopped
//!   mid-turn left is brought into the space's folder when the runtime starts again
//!   ([`recover`]).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{CodexFileDescriptor, FileChangeDescriptor, FileChangeKind};

/// The folder under `WORKSPACE_DIR` that holds each space's turn folders.
pub(crate) const PLACE: &str = ".instafy-turns";

/// The end of a turn folder's record's name, beside the folder.
const RECORD_SUFFIX: &str = ".start.json";

/// The most turn folders one name takes at once: `<name>`, `<name>-2`, … A runtime runs at most
/// `MAX_TURNS_AT_ONCE` turns at once, so this is never reached.
const MAX_NAMES: usize = 9;

/// How long a git command of a turn folder may take.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// How long bringing changes into the space's folder waits for its apply lock.
const SPACE_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// The turn folders this process holds, by path: a name stays taken until its folder is gone.
static IN_USE: LazyLock<parking_lot::Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashSet::new()));

/// Where one space's turn folders go, when a turn folder can be a clone of the space's folder.
#[derive(Clone, Debug)]
pub(crate) struct TurnFolderPlace {
    root: PathBuf,
    space_folder: PathBuf,
}

/// A folder an earlier process of this space left, with its record when it has one.
#[derive(Debug)]
pub(crate) struct Leftover {
    folder: PathBuf,
    record: PathBuf,
}

impl TurnFolderPlace {
    /// The place of `project_id`'s turn folders under `workspace_root`, when each can be a
    /// copy-on-write clone of `space_folder`: on macOS, outside the space's folder (and the space's
    /// folder outside it), and on the same APFS volume. `None` otherwise: the computer then runs one
    /// turn at a time, in the space's folder (D54).
    pub(crate) fn of(workspace_root: &Path, space_folder: &Path, project_id: Uuid) -> Option<Self> {
        if !cfg!(target_os = "macos") {
            return None;
        }
        let workspace_root = workspace_root.canonicalize().ok()?;
        let space_folder = space_folder.canonicalize().ok()?;
        let root = workspace_root.join(PLACE).join(project_id.to_string());
        if root.starts_with(&space_folder) || space_folder.starts_with(&root) {
            return None;
        }
        std::fs::create_dir_all(&root).ok()?;
        if !clones_between(&space_folder, &root) {
            return None;
        }
        Some(Self { root, space_folder })
    }

    /// What an earlier process left here, each folder taken, so no new turn's name removes it
    /// before [`recover`] brings its changes into the space's folder.
    pub(crate) fn leftovers(&self) -> Vec<Leftover> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut in_use = IN_USE.lock();
        let mut leftovers = Vec::new();
        let mut records = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(folder) = name.strip_suffix(RECORD_SUFFIX) {
                records.push((self.root.join(folder), path));
                continue;
            }
            if in_use.contains(&path) {
                continue;
            }
            in_use.insert(path.clone());
            leftovers.push(Leftover {
                record: record_of(&path),
                folder: path,
            });
        }
        // A record whose folder is gone: the folder was being removed.
        for (folder, record) in records {
            if !folder.exists() {
                let _ = std::fs::remove_file(record);
            }
        }
        leftovers
    }
}

/// The record beside `folder`.
fn record_of(folder: &Path) -> PathBuf {
    let mut name = folder
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(RECORD_SUFFIX);
    folder.with_file_name(name)
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

/// Removes `folder` and its record in a thread of its own, then frees its name: a large folder
/// takes seconds to remove. The record goes first, so a folder half removed is never read as a
/// turn's change.
fn remove_in_the_background(folder: PathBuf) {
    let work = move || {
        let _ = std::fs::remove_file(record_of(&folder));
        remove(&folder);
        IN_USE.lock().remove(&folder);
    };
    if let Err(error) = std::thread::Builder::new()
        .name("turn-folder-removal".to_string())
        .spawn(work)
    {
        tracing::warn!(%error, "no thread to remove a turn folder");
    }
}

/// The repository a turn folder's own reads use, fixed when the folder is made: its copy of the
/// origin's `.instafy/.git`, else its own `.git` directory.
#[derive(Clone, Debug)]
pub(crate) struct TurnRepo {
    git_dir: PathBuf,
    work_tree: PathBuf,
}

impl TurnRepo {
    /// The repository of `folder`, as the pre-flight picks it (`.instafy/.git`, else `.git`), when
    /// a clone of it is a repository of its own: `None` for a folder with no repository, and for
    /// one whose `.git` is a file, a linked worktree or a submodule, whose clone would still name
    /// the person's real repository.
    pub(crate) fn of(folder: &Path) -> Option<Self> {
        let own = std::fs::symlink_metadata(folder.join(".git")).ok();
        if own.as_ref().is_some_and(|metadata| !metadata.is_dir()) {
            return None;
        }
        let instafy = folder.join(".instafy").join(".git");
        let git_dir = if std::fs::symlink_metadata(&instafy).is_ok_and(|metadata| metadata.is_dir())
        {
            instafy
        } else if own.is_some() {
            folder.join(".git")
        } else {
            return None;
        };
        Some(Self {
            git_dir,
            work_tree: folder.to_path_buf(),
        })
    }

    /// Its git directory, relative to the folder.
    fn relative_git_dir(&self) -> PathBuf {
        self.git_dir
            .strip_prefix(&self.work_tree)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| PathBuf::from(".git"))
    }

    /// The same repository in `folder`, a clone of this one's folder.
    fn in_folder(&self, folder: &Path) -> Self {
        Self {
            git_dir: folder.join(self.relative_git_dir()),
            work_tree: folder.to_path_buf(),
        }
    }

    /// `git` in this repository, with its hooks and file monitor off, only the allowlisted
    /// environment, and stat checks that a clone keeps: a clone's files have new inodes and change
    /// times, but their sizes and modification times are the space folder's.
    fn git(&self, args: &[&str], index: Option<&Path>) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("git");
        command
            .args([
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
            ])
            .arg("--git-dir")
            .arg(&self.git_dir)
            .arg("--work-tree")
            .arg(&self.work_tree)
            .args(args)
            .current_dir(&self.work_tree);
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

/// What a folder held at a path, as two walks compare it: its kind, and a file's or a link's size
/// and modification time, which a clone keeps. A folder compares by kind alone, since a clone's
/// folders get times of their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WalkEntry {
    kind: EntryKind,
    len: u64,
    mtime_secs: i64,
    mtime_nanos: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum EntryKind {
    File,
    Dir,
    Link,
    Other,
}

impl WalkEntry {
    fn of(metadata: &std::fs::Metadata) -> Self {
        let kind = if metadata.is_dir() {
            EntryKind::Dir
        } else if metadata.file_type().is_symlink() {
            EntryKind::Link
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        let (mtime_secs, mtime_nanos) = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| (time.as_secs() as i64, time.subsec_nanos()))
            .unwrap_or((0, 0));
        Self {
            kind,
            len: if kind == EntryKind::Dir {
                0
            } else {
                metadata.len()
            },
            mtime_secs,
            mtime_nanos,
        }
    }

    /// Whether `other` is what this was: the same kind, and for anything but a folder the same
    /// size and modification time.
    fn same_as(&self, other: &Self) -> bool {
        self.kind == other.kind
            && (self.kind == EntryKind::Dir
                || (self.len == other.len
                    && self.mtime_secs == other.mtime_secs
                    && self.mtime_nanos == other.mtime_nanos))
    }
}

/// Every entry of a folder, by its `/`-separated path relative to the folder, without the
/// runtime's own `.instafy/` and the folder's own `.git/`, which no turn's change goes back
/// through.
pub(crate) type Walk = BTreeMap<String, WalkEntry>;

/// Walks `folder` ([`Walk`]), links not followed.
fn walk(folder: &Path) -> Walk {
    let mut entries = Walk::new();
    let mut pending: Vec<(PathBuf, String)> = vec![(folder.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if prefix.is_empty() && (name == ".instafy" || name == ".git") {
                continue;
            }
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let walked = WalkEntry::of(&metadata);
            if walked.kind == EntryKind::Dir {
                pending.push((entry.path(), relative.clone()));
            }
            entries.insert(relative, walked);
        }
    }
    entries
}

/// The folders of `walks` that hold a repository of their own (a `.git` folder or file), in path
/// order: what a snapshot leaves out.
fn nested_repos<'a>(walks: impl IntoIterator<Item = &'a Walk>) -> Vec<String> {
    let mut nested: Vec<String> = walks
        .into_iter()
        .flat_map(|walk| walk.keys())
        .filter_map(|path| path.strip_suffix("/.git").map(str::to_string))
        .collect();
    nested.sort();
    nested.dedup();
    nested
}

/// How a turn folder began, which [`TurnFolder::begin`] writes beside it: its repository, its first
/// tree and its first walk.
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    version: u32,
    /// The repository's folder, relative to the turn folder.
    git_dir: PathBuf,
    first_tree: String,
    walk: Walk,
}

/// How a turn folder began.
#[derive(Clone, Debug)]
pub(crate) struct Started {
    pub(crate) first_tree: String,
    walk: Arc<Walk>,
}

struct Inner {
    path: PathBuf,
    repo: TurnRepo,
    begun: AtomicBool,
    done: AtomicBool,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.path);
        if self.begun.load(Ordering::SeqCst) && !self.done.load(Ordering::SeqCst) {
            // Its changes never reached the space's folder: it stays, with its record, for the
            // runtime's next start to bring them there (`recover`).
            tracing::warn!(
                folder = %path.display(),
                "a turn folder's changes did not reach the space's folder; it stays until the runtime starts again"
            );
            return;
        }
        remove_in_the_background(path);
    }
}

/// A turn's folder of its own. The last of its clones to go removes it in the background, once
/// its changes reached the space's folder ([`Self::done`]) or before it began; otherwise it stays.
#[derive(Clone)]
pub(crate) struct TurnFolder(Arc<Inner>);

impl std::fmt::Debug for TurnFolder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("TurnFolder")
            .field(&self.0.path)
            .finish()
    }
}

impl TurnFolder {
    /// A clone of `place`'s space folder, as it is now, named for `name` (the turn's agent):
    /// `name`, or `name-2` and so on while another turn of this process holds a name. Its
    /// repositories are told to keep their stat caches valid for it ([`TurnRepo::git`]).
    pub(crate) async fn clone_of(
        place: &TurnFolderPlace,
        repo: &TurnRepo,
        name: &str,
    ) -> Result<Self> {
        let place = place.clone();
        let name = folder_name(name);
        let path = tokio::task::spawn_blocking(move || {
            let path = take_a_name(&place.root, &name)?;
            // A folder an earlier process left under this name goes first.
            let _ = std::fs::remove_file(record_of(&path));
            remove(&path);
            if let Err(error) = clone_tree(&place.space_folder, &path) {
                remove(&path);
                IN_USE.lock().remove(&path);
                return Err(error);
            }
            Ok(path)
        })
        .await
        .map_err(|error| anyhow!("the turn folder task failed: {error}"))??;
        let folder = Self(Arc::new(Inner {
            repo: repo.in_folder(&path),
            path,
            begun: AtomicBool::new(false),
            done: AtomicBool::new(false),
        }));
        folder.keep_stat_caches().await;
        Ok(folder)
    }

    /// Tells the clone's repositories to compare files by size and modification time alone, and
    /// writes their indexes so, as `git status` in the clone would otherwise read every file again.
    async fn keep_stat_caches(&self) {
        let own = self.0.path.join(".git");
        let mut git_dirs = vec![self.0.repo.git_dir.clone()];
        if own != self.0.repo.git_dir && own.is_dir() {
            git_dirs.push(own);
        }
        for git_dir in git_dirs {
            let repo = TurnRepo {
                git_dir,
                work_tree: self.0.path.clone(),
            };
            for (key, value) in [("core.checkStat", "minimal"), ("core.trustctime", "false")] {
                if let Err(error) =
                    output_of(repo.git(&["config", key, value], None), "config").await
                {
                    tracing::warn!(?error, "a turn folder's repository kept its stat checks");
                }
            }
            let _ = output_of(
                repo.git(&["update-index", "-q", "--refresh"], None),
                "update-index",
            )
            .await;
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0.path
    }

    /// A turn folder over `folder` itself, for a test: no clone, and nothing removed but its
    /// record.
    #[cfg(test)]
    pub(crate) fn at(folder: &Path) -> Self {
        Self(Arc::new(Inner {
            path: folder.to_path_buf(),
            repo: TurnRepo::of(folder).expect("a repository"),
            begun: AtomicBool::new(false),
            done: AtomicBool::new(false),
        }))
    }

    /// Reads how the folder begins, its first tree and its first walk, and writes them beside it,
    /// so a process that stops mid-turn leaves what its next start needs to bring the turn's
    /// changes into the space's folder.
    pub(crate) async fn begin(&self) -> Result<Started> {
        let path = self.0.path.clone();
        let walked = tokio::task::spawn_blocking(move || walk(&path))
            .await
            .map_err(|error| anyhow!("the walk failed: {error}"))?;
        let first_tree = snapshot_tree(&self.0.repo, &nested_repos([&walked])).await?;
        let record = Record {
            version: 1,
            git_dir: self.0.repo.relative_git_dir(),
            first_tree: first_tree.clone(),
            walk: walked,
        };
        let bytes = serde_json::to_vec(&record)?;
        tokio::fs::write(record_of(&self.0.path), bytes)
            .await
            .context("the turn folder's record could not be written")?;
        self.0.begun.store(true, Ordering::SeqCst);
        Ok(Started {
            first_tree,
            walk: Arc::new(record.walk),
        })
    }

    /// What the turn changed since it began ([`TurnChanges`]); `None` when the folder cannot be
    /// read.
    pub(super) async fn changes(&self, started: &Started) -> Option<TurnChanges> {
        changes_in(&self.0.repo, started).await
    }

    /// Says the turn's changes reached the space's folder: its record goes, and the folder is
    /// removed once the last of its clones does.
    pub(crate) fn done(&self) {
        let _ = std::fs::remove_file(record_of(&self.0.path));
        self.0.done.store(true, Ordering::SeqCst);
    }
}

/// What a turn changed in its folder.
#[derive(Debug, Default)]
pub(super) struct TurnChanges {
    /// The files a save sends: what differs between its first tree and its last, in path order.
    pub(crate) files: Vec<CodexFileDescriptor>,
    /// What the turn found at each of them, as the space's folder held it ([`BaseEntry`]).
    pub(crate) found: BTreeMap<String, BaseEntry>,
    /// Everything else, by path: what differs between its first walk and its last.
    pub(crate) rest: Vec<RestChange>,
}

/// A change of a turn's beyond the files a save sends: a file, a link or a folder that is new,
/// changed or gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestChange {
    pub(crate) path: String,
    /// What the turn left there; `None` when it left nothing.
    left: Option<WalkEntry>,
    /// What the turn found there, as the space's folder held it; `None` for nothing.
    found: Option<WalkEntry>,
}

async fn changes_in(repo: &TurnRepo, started: &Started) -> Option<TurnChanges> {
    let read = async {
        let folder = repo.work_tree.clone();
        let last_walk = tokio::task::spawn_blocking(move || walk(&folder))
            .await
            .map_err(|error| anyhow!("the walk failed: {error}"))?;
        let nested = nested_repos([started.walk.as_ref(), &last_walk]);
        let last_tree = snapshot_tree(repo, &nested).await?;
        let files = changed_files(repo, &started.first_tree, &last_tree).await?;
        let paths: Vec<String> = files
            .iter()
            .map(|file| file.workspace_path.clone())
            .collect();
        let first = tree_listing(repo, &started.first_tree).await?;
        let found = entries_in(repo, &first, &paths).await?;
        // Whatever either tree holds that a save could send is the trees' to tell; what the walks
        // add is the rest, unpublishable files among it.
        let mut tracked: HashSet<String> = first.keys().cloned().collect();
        tracked.extend(tree_listing(repo, &last_tree).await?.into_keys());
        tracked.retain(|path| a_save_sends(path));
        let tracked: HashSet<&str> = tracked.iter().map(String::as_str).collect();
        let rest = rest_of(&started.walk, &last_walk, &tracked);
        Ok::<_, anyhow::Error>(TurnChanges { files, found, rest })
    };
    match read.await {
        Ok(changes) => Some(changes),
        Err(error) => {
            tracing::warn!(?error, "a turn folder's changes could not be read");
            None
        }
    }
}

/// What differs between two walks, beyond `tree_paths`, in path order: new, changed and gone
/// files and links, and new and gone folders.
fn rest_of(first: &Walk, last: &Walk, tree_paths: &HashSet<&str>) -> Vec<RestChange> {
    let mut rest = Vec::new();
    for (path, left) in last {
        if tree_paths.contains(path.as_str()) {
            continue;
        }
        let found = first.get(path).copied();
        if found.is_some_and(|found| found.same_as(left)) {
            continue;
        }
        rest.push(RestChange {
            path: path.clone(),
            left: Some(*left),
            found,
        });
    }
    for (path, found) in first {
        if !last.contains_key(path) && !tree_paths.contains(path.as_str()) {
            rest.push(RestChange {
                path: path.clone(),
                left: None,
                found: Some(*found),
            });
        }
    }
    rest.sort_by(|left, right| left.path.cmp(&right.path));
    rest
}

/// The changes at `paths` in `folder` since the turn began, as [`bring_back`] takes them: for
/// files the save leaves to go in as they are, such as Claude Code's own files (3.8).
pub(crate) fn rest_of_files(folder: &Path, paths: &[String], started: &Started) -> Vec<RestChange> {
    paths
        .iter()
        .filter_map(|path| {
            let left = std::fs::symlink_metadata(folder.join(path))
                .ok()
                .map(|metadata| WalkEntry::of(&metadata));
            let found = started.walk.get(path).copied();
            let same = match (left, found) {
                (Some(left), Some(found)) => left.same_as(&found),
                (None, None) => true,
                _ => false,
            };
            (!same).then(|| RestChange {
                path: path.clone(),
                left,
                found,
            })
        })
        .collect()
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

/// The tree of the folder's files as they are now, by `repo`: what `git add -A` stages into an
/// index of its own, a copy of the repository's, so the files the repository ignores stay out,
/// written into the repository's objects. Neither the repository's index nor its HEAD moves.
async fn snapshot_tree(repo: &TurnRepo, nested: &[String]) -> Result<String> {
    let scratch = tempfile::Builder::new()
        .prefix("instafy-turn-snapshot-")
        .tempdir()
        .context("no scratch folder for the snapshot's index")?;
    let index = scratch.path().join("index");
    // The repository's own index, when it has one, so only files that changed are read again.
    let own_index = repo.git_dir.join("index");
    if own_index.is_file() {
        tokio::fs::copy(&own_index, &index)
            .await
            .context("the repository's index could not be copied")?;
    } else {
        output_of(
            repo.git(&["read-tree", "--empty"], Some(&index)),
            "read-tree",
        )
        .await?;
    }
    // The runtime's own `.instafy/` (its logs, its staging, the controller's pages) is never a
    // turn's to save (`is_reserved_path`), so it is not read at all. Nor is a repository nested in
    // the folder, which `git add` cannot take while it has no commit: its files go with the rest
    // of the turn's changes ([`bring_back`]).
    let excluded: Vec<String> = nested
        .iter()
        .map(|folder| format!(":(top,literal,exclude){folder}"))
        .collect();
    let mut args = vec!["add", "-A", "--", ".", ":(top,exclude).instafy"];
    args.extend(excluded.iter().map(String::as_str));
    output_of(repo.git(&args, Some(&index)), "add").await?;
    let tree = output_of(repo.git(&["write-tree"], Some(&index)), "write-tree").await?;
    let tree = String::from_utf8(tree)?.trim().to_string();
    if tree.is_empty() || !tree.chars().all(|character| character.is_ascii_hexdigit()) {
        bail!("git write-tree gave no tree id");
    }
    Ok(tree)
}

/// What a tree held at a path, as a turn folder's save reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BaseEntry {
    /// The blob id of the file's bytes as the folder held them ([`working_bytes`]), which is
    /// what the origin compares an `expected` id with.
    pub(crate) oid: String,
    /// The blob's id in the repository, from which [`working_bytes`] reads it again.
    tree_oid: String,
    /// Whether it is a link (mode 120000), which a save never sends.
    pub(crate) link: bool,
}

/// What changed between the trees `from` and `to` of `repo`, as the files a save sends: created,
/// changed or deleted, by folder-relative path, in path order, with the paths a save never sends
/// left out (as `status_delta_files_for_checkpoint` leaves them out), and nested repositories
/// (gitlinks), whose files go back with the rest of the turn's changes.
async fn changed_files(repo: &TurnRepo, from: &str, to: &str) -> Result<Vec<CodexFileDescriptor>> {
    let listed = output_of(
        repo.git(
            &["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to],
            None,
        ),
        "diff-tree",
    )
    .await?;
    Ok(files_of_raw_diff(&listed))
}

/// The files of `git diff-tree -z --raw` output.
fn files_of_raw_diff(listed: &[u8]) -> Vec<CodexFileDescriptor> {
    let mut fields = listed
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let (Some(meta), Some(path)) = (fields.next(), fields.next()) {
        let Ok(meta) = std::str::from_utf8(meta) else {
            continue;
        };
        let Ok(path) = std::str::from_utf8(path) else {
            continue;
        };
        // `:<old mode> <new mode> <old oid> <new oid> <status>`
        let parts: Vec<&str> = meta.trim_start_matches(':').split(' ').collect();
        let [old_mode, new_mode, _, _, status] = parts.as_slice() else {
            continue;
        };
        if *old_mode == "160000" || *new_mode == "160000" {
            continue;
        }
        let kind = match status.chars().next() {
            Some('A') => FileChangeKind::Created,
            Some('D') => FileChangeKind::Deleted,
            _ => FileChangeKind::Changed,
        };
        let Some(sanitized) = super::sanitize_relative_workspace_path(path) else {
            continue;
        };
        let path = sanitized.to_string_lossy().replace('\\', "/");
        if !a_save_sends(&path) {
            continue;
        }
        files.push(changed_file(path, kind));
    }
    files.sort_by(|left, right| left.workspace_path.cmp(&right.workspace_path));
    files
}

/// Whether a save may send `path`, a folder-relative path: never a reserved or an unpublishable
/// one, as `status_delta_files_for_checkpoint` leaves them out.
fn a_save_sends(path: &str) -> bool {
    !path.is_empty()
        && !origin_http_server::paths::is_reserved_path(path)
        && !origin_http_server::publish_policy::is_unpublishable(path)
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

/// Every file and link the tree `tree` of `repo` holds, by path: its mode and its blob's id.
async fn tree_listing(repo: &TurnRepo, tree: &str) -> Result<BTreeMap<String, (String, String)>> {
    let listed = output_of(
        repo.git(&["ls-tree", "-r", "-z", "--full-tree", tree], None),
        "ls-tree",
    )
    .await?;
    let mut listing = BTreeMap::new();
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
        let mut meta = meta.split(' ');
        let (Some(mode), Some("blob"), Some(oid)) = (meta.next(), meta.next(), meta.next()) else {
            continue;
        };
        listing.insert(path.to_string(), (mode.to_string(), oid.to_string()));
    }
    Ok(listing)
}

/// What `listing`, a tree's ([`tree_listing`]), held at each of `paths`: an entry for a file or a
/// link, none for a path it did not hold as one.
async fn entries_in(
    repo: &TurnRepo,
    listing: &BTreeMap<String, (String, String)>,
    paths: &[String],
) -> Result<BTreeMap<String, BaseEntry>> {
    let mut entries = BTreeMap::new();
    for path in paths {
        let Some((mode, tree_oid)) = listing.get(path) else {
            continue;
        };
        let link = mode == "120000";
        let oid = if link {
            tree_oid.clone()
        } else {
            let bytes = working_bytes(repo, tree_oid, path).await?;
            origin_http_server::workspace_git::blob_oid(&bytes)
        };
        entries.insert(
            path.clone(),
            BaseEntry {
                oid,
                tree_oid: tree_oid.clone(),
                link,
            },
        );
    }
    Ok(entries)
}

/// The bytes of the blob `oid` as the folder held them at `path`: through the repository's
/// filters (line endings, LFS), which `git add` applied to them, else as stored.
async fn working_bytes(repo: &TurnRepo, oid: &str, path: &str) -> Result<Vec<u8>> {
    let path_arg = format!("--path={path}");
    match output_of(
        repo.git(&["cat-file", "--filters", &path_arg, oid], None),
        "cat-file --filters",
    )
    .await
    {
        Ok(bytes) => Ok(bytes),
        Err(_) => output_of(repo.git(&["cat-file", "blob", oid], None), "cat-file").await,
    }
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

/// Plans a turn folder's save (11.23): for each of `files` the turn changed, its version in the
/// turn's folder, what the turn found there (`found`), and what `space_folder` holds now.
/// - The space still holds what the turn found: the turn's version goes, with that as expected.
/// - The space already holds the turn's version: nothing goes.
/// - The space changed it too, and all three are text: they merge three ways (`git merge-file`).
///   A clean merge goes, with the space's version now as expected.
/// - Anything else (lines both changed, a binary file, one side removed it, a link, a merge that
///   could not run) is kept.
pub(super) async fn plan_merge(
    turn_folder: &TurnFolder,
    space_folder: &Path,
    files: &[CodexFileDescriptor],
    found: &BTreeMap<String, BaseEntry>,
    agent: &str,
) -> Result<MergePlan> {
    let repo = &turn_folder.0.repo;
    let mut plan = MergePlan::default();
    for file in files {
        if file.is_read_reference() {
            continue;
        }
        let path = file.workspace_path.clone();
        let theirs = version_at(turn_folder.path(), &path);
        let current = version_at(space_folder, &path);
        let base = found.get(&path);
        if base.is_some_and(|entry| entry.link)
            || matches!(theirs, Version::Other)
            || matches!(current, Version::Other)
        {
            plan.kept.push(path);
            continue;
        }
        let found_oid = base.map(|entry| entry.oid.clone());
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
        let (Version::File(ours), Version::File(other), Some(base)) = (&current, &theirs, base)
        else {
            plan.kept.push(path);
            continue;
        };
        let merged = match working_bytes(repo, &base.tree_oid, &path).await {
            Ok(found_bytes) => merge_three_ways(ours, &found_bytes, other, agent).await,
            Err(error) => Err(error),
        };
        match merged {
            Ok(Some(merged)) => {
                plan.writes.push((path.clone(), merged));
                plan.expected.insert(path.clone(), current_oid);
                plan.merged.push(path);
            }
            Ok(None) => plan.kept.push(path),
            Err(error) => {
                tracing::warn!(?error, %path, "a merge could not run; the space keeps its version");
                plan.kept.push(path);
            }
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

/// What [`bring_back`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct BroughtBack {
    /// The paths it brought into the space's folder (written, made or removed).
    pub(crate) put: Vec<String>,
    /// The paths the space's folder changed since the turn began, which it left as they are.
    pub(crate) changed_meanwhile: Vec<String>,
}

/// Brings `rest`, the turn's changes beyond the files a save sends, from its folder into
/// `space_folder`, under the space's apply lock: each where the space's folder still holds what
/// the turn found there, as a turn that ran there would have left it. A new folder goes in whole;
/// a file or a link is copied in; what the turn removed is removed, a folder once it is empty.
pub(crate) async fn bring_back(
    turn_folder: &Path,
    space_folder: &Path,
    rest: &[RestChange],
) -> BroughtBack {
    if rest.is_empty() {
        return BroughtBack::default();
    }
    let (turn_folder, space_folder, rest) = (
        turn_folder.to_path_buf(),
        space_folder.to_path_buf(),
        rest.to_vec(),
    );
    tokio::task::spawn_blocking(move || {
        let lock = match origin_http_server::acquire_workspace_apply_lock_within(
            &space_folder,
            SPACE_LOCK_WAIT,
        ) {
            Ok(Some(lock)) => lock,
            _ => {
                tracing::warn!("the space's folder stayed locked; a turn's other changes stay out");
                return BroughtBack {
                    put: Vec::new(),
                    changed_meanwhile: rest.into_iter().map(|change| change.path).collect(),
                };
            }
        };
        let brought = bring_back_locked(&turn_folder, &space_folder, &rest);
        drop(lock);
        brought
    })
    .await
    .unwrap_or_default()
}

fn bring_back_locked(turn_folder: &Path, space_folder: &Path, rest: &[RestChange]) -> BroughtBack {
    let mut brought = BroughtBack::default();
    // Folders the turn made, which went in whole: nothing under them is looked at again.
    let mut moved_whole: Vec<String> = Vec::new();
    let under = |path: &str, folders: &[String]| {
        folders.iter().any(|folder| {
            path.starts_with(folder.as_str()) && path[folder.len()..].starts_with('/')
        })
    };
    for change in rest.iter().filter(|change| change.left.is_some()) {
        if under(&change.path, &moved_whole) {
            continue;
        }
        let left = change.left.expect("filtered");
        let source = turn_folder.join(&change.path);
        let target = space_folder.join(&change.path);
        let current = std::fs::symlink_metadata(&target)
            .ok()
            .map(|metadata| WalkEntry::of(&metadata));
        if left.kind == EntryKind::Dir {
            match current {
                Some(entry) if entry.kind == EntryKind::Dir => {}
                None if change.found.is_none() => {
                    // A folder the turn made: it goes in whole.
                    if clone_into(&source, &target).is_ok() {
                        brought.put.push(change.path.clone());
                        moved_whole.push(change.path.clone());
                    } else {
                        brought.changed_meanwhile.push(change.path.clone());
                    }
                }
                _ => brought.changed_meanwhile.push(change.path.clone()),
            }
            continue;
        }
        let unchanged = match (current, change.found) {
            (None, None) => true,
            (Some(current), Some(found)) => current.same_as(&found),
            _ => false,
        };
        if !unchanged || left.kind == EntryKind::Other {
            brought.changed_meanwhile.push(change.path.clone());
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if replace_with_clone(&source, &target).is_ok() {
            brought.put.push(change.path.clone());
        } else {
            brought.changed_meanwhile.push(change.path.clone());
        }
    }
    // What the turn removed, deepest first, so a folder is empty by the time it goes.
    let mut removed: Vec<&RestChange> =
        rest.iter().filter(|change| change.left.is_none()).collect();
    removed.sort_by(|left, right| right.path.cmp(&left.path));
    for change in removed {
        let target = space_folder.join(&change.path);
        let Some(found) = change.found else {
            continue;
        };
        let current = std::fs::symlink_metadata(&target)
            .ok()
            .map(|metadata| WalkEntry::of(&metadata));
        match current {
            None => {}
            Some(current) if current.same_as(&found) => {
                let gone = if current.kind == EntryKind::Dir {
                    std::fs::remove_dir(&target)
                } else {
                    std::fs::remove_file(&target)
                };
                if gone.is_ok() {
                    brought.put.push(change.path.clone());
                } else {
                    brought.changed_meanwhile.push(change.path.clone());
                }
            }
            Some(_) => brought.changed_meanwhile.push(change.path.clone()),
        }
    }
    brought.put.sort();
    brought.changed_meanwhile.sort();
    brought
}

/// `source` cloned to `target`, which must not exist: a whole folder, a file or a link.
fn clone_into(source: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    clone_tree(source, target).or_else(|_| copy_plainly(source, target))
}

/// `source` copied to `target` without a clone, where a clone cannot be made (another volume, a
/// file system without clones): a file, a link, or a folder with everything under it. What is
/// neither (a socket, a pipe) is left out, as nothing of a turn's lives in one.
fn copy_plainly(source: &Path, target: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(std::fs::read_link(source)?, target)?;
        return Ok(());
    }
    if metadata.is_file() {
        std::fs::copy(source, target)?;
        return Ok(());
    }
    if metadata.is_dir() {
        std::fs::create_dir(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_plainly(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    Ok(())
}

/// `target` replaced by a clone of `source`, a file or a link, through a name of its own beside
/// it, so the space's folder never holds half of it.
fn replace_with_clone(source: &Path, target: &Path) -> Result<()> {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staged = target.with_file_name(format!(".{name}.instafy-turn-{}", Uuid::new_v4()));
    clone_into(source, &staged)?;
    if let Err(error) = std::fs::rename(&staged, target) {
        remove(&staged);
        return Err(error.into());
    }
    Ok(())
}

/// The name a turn's version of `path` gets beside it when the space's history cannot keep it
/// (a folder whose origin has no repository): `notes (Claude Code's version).md`, then ` 2` and so
/// on while the space's folder holds a file of that name.
pub(crate) fn kept_copy_name(space_folder: &Path, path: &str) -> String {
    let (dir, name) = match path.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name),
        None => (String::new(), path),
    };
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    for index in 1..100 {
        let suffix = if index == 1 {
            "Claude Code's version".to_string()
        } else {
            format!("Claude Code's version {index}")
        };
        let candidate = format!("{dir}{stem} ({suffix}){extension}");
        if !space_folder.join(&candidate).exists() {
            return candidate;
        }
    }
    format!(
        "{dir}{stem} (Claude Code's version {}){extension}",
        Uuid::new_v4()
    )
}

/// What an earlier process left in `leftover`: when its record says how the turn began, its
/// changes go into the space's folder unsaved, the files a save sends through `put` (each with
/// what the turn found there), the files the space changed meanwhile kept through `keep`, and the
/// rest as [`bring_back`] brings it. The folder is removed afterwards, and with no record it is
/// removed as it is.
pub(crate) async fn recover<P, PF, K, KF>(leftover: Leftover, space_folder: &Path, put: P, keep: K)
where
    P: FnOnce(Vec<(String, Option<Vec<u8>>)>, BTreeMap<String, Option<String>>) -> PF,
    PF: std::future::Future<Output = Option<Vec<String>>>,
    K: FnOnce(PathBuf, Vec<String>) -> KF,
    KF: std::future::Future<Output = ()>,
{
    let Leftover { folder, record } = leftover;
    let read = tokio::fs::read(&record).await.ok().and_then(|bytes| {
        serde_json::from_slice::<Record>(&bytes)
            .ok()
            .filter(|record| record.version == 1)
    });
    if let Some(record) = read
        && folder.is_dir()
    {
        let repo = TurnRepo {
            git_dir: folder.join(&record.git_dir),
            work_tree: folder.clone(),
        };
        let started = Started {
            first_tree: record.first_tree,
            walk: Arc::new(record.walk),
        };
        let Some(changes) = changes_in(&repo, &started).await else {
            tracing::warn!(
                folder = %folder.display(),
                "a turn folder a stopped process left could not be read; it stays"
            );
            return;
        };
        let (files, expected) = unsaved_changes(&folder, &changes.files, &changes.found);
        if !files.is_empty() {
            match put(files, expected).await {
                None => {
                    tracing::warn!(
                        folder = %folder.display(),
                        "a turn folder a stopped process left could not be put into the space's folder; it stays"
                    );
                    return;
                }
                Some(changed) if !changed.is_empty() => keep(folder.clone(), changed).await,
                Some(_) => {}
            }
        }
        bring_back(&folder, space_folder, &changes.rest).await;
        tracing::info!(
            folder = %folder.display(),
            "a turn folder a stopped process left was brought into the space's folder"
        );
    }
    remove_in_the_background(folder);
}

/// The turn's `files` as they are in `folder`, each with what the space's folder must still hold
/// for it to go in unsaved: its bytes, or `None` for a file the turn removed, and the blob id the
/// turn found there. Links, folders and unreadable files are left out.
#[allow(clippy::type_complexity)]
pub(super) fn unsaved_changes(
    folder: &Path,
    files: &[CodexFileDescriptor],
    found: &BTreeMap<String, BaseEntry>,
) -> (
    Vec<(String, Option<Vec<u8>>)>,
    BTreeMap<String, Option<String>>,
) {
    let mut changes = Vec::new();
    let mut expected = BTreeMap::new();
    for file in files {
        let path = file.workspace_path.clone();
        if found.get(&path).is_some_and(|entry| entry.link) {
            continue;
        }
        let bytes = match std::fs::symlink_metadata(folder.join(&path)) {
            Ok(metadata) if metadata.is_file() => match std::fs::read(folder.join(&path)) {
                Ok(bytes) => Some(bytes),
                Err(_) => continue,
            },
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => continue,
        };
        expected.insert(
            path.clone(),
            found.get(&path).map(|entry| entry.oid.clone()),
        );
        changes.push((path, bytes));
    }
    (changes, expected)
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

    /// A turn folder over `folder` itself, as a test's own: no clone, and nothing removed.
    fn turn_folder_at(folder: &Path) -> TurnFolder {
        TurnFolder(Arc::new(Inner {
            path: folder.to_path_buf(),
            repo: TurnRepo::of(folder).expect("a repository"),
            begun: AtomicBool::new(true),
            done: AtomicBool::new(false),
        }))
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

    #[test]
    fn the_repository_is_the_origins_else_the_folders_own_and_never_a_git_file() {
        let folder = tempfile::tempdir().expect("folder");
        assert!(TurnRepo::of(folder.path()).is_none(), "no repository");
        std::fs::create_dir_all(folder.path().join(".git")).expect(".git");
        assert_eq!(
            TurnRepo::of(folder.path()).expect("own").git_dir,
            folder.path().join(".git")
        );
        std::fs::create_dir_all(folder.path().join(".instafy/.git")).expect("origin's");
        assert_eq!(
            TurnRepo::of(folder.path()).expect("origin's").git_dir,
            folder.path().join(".instafy/.git")
        );
        std::fs::remove_dir_all(folder.path().join(".git")).expect("gone");
        std::fs::write(folder.path().join(".git"), "gitdir: /elsewhere\n").expect("a git file");
        assert!(TurnRepo::of(folder.path()).is_none(), "a .git file");
    }

    /// What a turn changed: the files a save sends are what differs between the folder's trees
    /// as it began and ended (edits, new and removed files, a commit the turn made itself), and
    /// everything else (ignored files, a nested repository) is what differs between two walks. A
    /// `git init` the turn ran changes neither, and the runtime's own files are in neither.
    #[tokio::test]
    async fn a_turn_changed_what_differs_between_its_first_and_last_tree_and_walk() {
        let folder = tempfile::tempdir().expect("folder");
        let root = folder.path();
        repository(
            root,
            &[
                ("README.md", "one\n"),
                ("gone.md", "bye\n"),
                ("same.md", "same\n"),
                (".gitignore", "node_modules/\n.env\n"),
            ],
        );
        std::fs::write(root.join(".env"), "A=1\n").expect("ignored");
        // An edit the person had not saved when the turn began is where the turn starts.
        std::fs::write(root.join("draft.md"), "draft\n").expect("draft");
        std::fs::create_dir_all(root.join(".instafy/agent")).expect("runtime's");
        std::fs::write(root.join(".instafy/agent/log"), "runtime\n").expect("runtime's");
        // The origin's own repository, a clone of the folder's, as Desktop keeps it.
        let origin = root.join(".instafy/.git");
        git_in(
            root,
            &["clone", "-q", "--bare", ".", origin.to_str().expect("utf8")],
        );
        git_in(
            root,
            &[
                "--git-dir",
                origin.to_str().unwrap(),
                "config",
                "core.bare",
                "false",
            ],
        );
        git_in(
            root,
            &[
                "--git-dir",
                origin.to_str().unwrap(),
                "--work-tree",
                ".",
                "reset",
                "-q",
            ],
        );
        let turn = turn_folder_at(root);
        assert_eq!(turn.0.repo.git_dir, origin);
        let started = turn.begin().await.expect("began");
        assert!(record_of(root).exists(), "the record is beside the folder");

        std::fs::write(root.join("README.md"), "one\ntwo\n").expect("edit");
        std::fs::remove_file(root.join("gone.md")).expect("remove");
        std::fs::write(root.join("same.md"), "changed\n").expect("edit");
        std::fs::write(root.join("same.md"), "same\n").expect("taken back");
        std::fs::write(root.join(".env"), "A=2\n").expect("ignored edit");
        std::fs::create_dir_all(root.join("node_modules/x")).expect("ignored");
        std::fs::write(root.join("node_modules/x/index.js"), "x\n").expect("ignored");
        std::fs::create_dir_all(root.join("app")).expect("nested");
        git_in(&root.join("app"), &["init", "-q"]);
        std::fs::write(root.join("app/page.js"), "page\n").expect("nested file");
        std::fs::write(root.join(".instafy/agent/log"), "runtime, later\n").expect("log");
        // The turn's own commit, in its copy of the origin's repository, and a `git init` at the
        // top, which the turn's reads never follow.
        std::fs::write(root.join("committed.md"), "by the turn\n").expect("new");
        git_in(
            root,
            &[
                "--git-dir",
                origin.to_str().unwrap(),
                "--work-tree",
                ".",
                "add",
                "committed.md",
            ],
        );
        git_in(
            root,
            &[
                "--git-dir",
                origin.to_str().unwrap(),
                "--work-tree",
                ".",
                "commit",
                "-q",
                "-m",
                "the turn's own commit",
            ],
        );
        let changes = turn.changes(&started).await.expect("changes");
        assert_eq!(
            paths(&changes.files),
            vec![
                ("README.md".to_string(), "changed".to_string()),
                ("committed.md".to_string(), "created".to_string()),
                ("gone.md".to_string(), "deleted".to_string()),
            ]
        );
        assert_eq!(
            changes
                .found
                .get("README.md")
                .map(|entry| entry.oid.clone()),
            Some(origin_http_server::workspace_git::blob_oid(b"one\n"))
        );
        let rest: Vec<&str> = changes
            .rest
            .iter()
            .map(|change| change.path.as_str())
            .collect();
        assert!(rest.contains(&".env"), "{rest:?}");
        assert!(rest.contains(&"node_modules/x/index.js"), "{rest:?}");
        assert!(rest.contains(&"app/page.js"), "{rest:?}");
        assert!(rest.contains(&"app/.git"), "{rest:?}");
        assert!(
            !rest.iter().any(|path| path.starts_with(".instafy")),
            "{rest:?}"
        );
        assert!(
            !rest.contains(&"README.md") && !rest.contains(&"same.md"),
            "{rest:?}"
        );
        turn.done();
        assert!(
            !record_of(root).exists(),
            "the record goes once the changes are in"
        );
    }

    /// A save merges: a path the space still holds as the turn found it takes the turn's
    /// version, one it already holds as the turn left it sends nothing, a text file both changed
    /// merges three ways, and lines both changed, or a file one side removed, are kept aside.
    #[tokio::test]
    async fn a_turn_folders_save_merges_into_the_space() {
        let turn_dir = tempfile::tempdir().expect("turn");
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
        repository(turn_dir.path(), &files);
        for (path, content) in files {
            std::fs::write(space.path().join(path), content).expect("space");
        }
        let turn = turn_folder_at(turn_dir.path());
        let started = turn.begin().await.expect("began");

        // The turn's changes.
        let at = |path: &str| turn_dir.path().join(path);
        std::fs::write(at("plain.md"), "plain, by the turn\n").expect("turn");
        std::fs::write(at("same.md"), "same, by both\n").expect("turn");
        std::fs::write(at("both.md"), shared.replace("two\n", "TWO, by the turn\n")).expect("turn");
        std::fs::write(at("clash.md"), "the turn's\n").expect("turn");
        std::fs::write(at("removed.md"), "edited by the turn\n").expect("turn");
        std::fs::write(at("binary.bin"), b"\0turn").expect("turn");
        std::fs::write(at("new.md"), "new\n").expect("turn");
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

        let changes = turn.changes(&started).await.expect("changes");
        let plan = plan_merge(&turn, space.path(), &changes.files, &changes.found, "alpha")
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
        turn.done();
    }

    /// A turn that removes a file the space still holds as the turn found it removes it there,
    /// and one the space removed too sends nothing.
    #[tokio::test]
    async fn a_removal_goes_while_the_space_holds_what_the_turn_found() {
        let turn_dir = tempfile::tempdir().expect("turn");
        let space = tempfile::tempdir().expect("space");
        repository(turn_dir.path(), &[("a.md", "a\n"), ("b.md", "b\n")]);
        for (path, content) in [("a.md", "a\n"), ("b.md", "b\n")] {
            std::fs::write(space.path().join(path), content).expect("space");
        }
        let turn = turn_folder_at(turn_dir.path());
        let started = turn.begin().await.expect("began");
        std::fs::remove_file(turn_dir.path().join("a.md")).expect("turn");
        std::fs::remove_file(turn_dir.path().join("b.md")).expect("turn");
        std::fs::remove_file(space.path().join("b.md")).expect("space");
        let changes = turn.changes(&started).await.expect("changes");
        let plan = plan_merge(&turn, space.path(), &changes.files, &changes.found, "beta")
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
        turn.done();
    }

    /// What a save never sends goes into the space's folder as it is, where the space still holds
    /// what the turn found: an edit of an ignored file, a new folder whole, a removal; a file the
    /// space changed meanwhile stays as the space has it.
    #[tokio::test]
    async fn the_rest_of_a_turns_changes_goes_where_the_space_holds_what_the_turn_found() {
        let turn = tempfile::tempdir().expect("turn");
        let space = tempfile::tempdir().expect("space");
        for root in [turn.path(), space.path()] {
            std::fs::create_dir_all(root.join("cache")).expect("dir");
            std::fs::write(root.join(".env"), "A=1\n").expect("env");
            std::fs::write(root.join("cache/old"), "old\n").expect("old");
            std::fs::write(root.join("local.txt"), "mine\n").expect("local");
        }
        // The two folders as a clone keeps them: the same times.
        for path in [".env", "cache/old", "local.txt"] {
            let time = std::fs::metadata(space.path().join(path))
                .expect("time")
                .modified()
                .expect("modified");
            let file = std::fs::File::options()
                .write(true)
                .open(turn.path().join(path))
                .expect("open");
            file.set_modified(time).expect("set");
        }
        let first = walk(turn.path());
        std::fs::write(turn.path().join(".env"), "A=2\n").expect("turn");
        std::fs::create_dir_all(turn.path().join("node_modules/lodash")).expect("turn");
        std::fs::write(turn.path().join("node_modules/lodash/index.js"), "x\n").expect("turn");
        std::fs::remove_file(turn.path().join("cache/old")).expect("turn");
        std::fs::write(turn.path().join("local.txt"), "the turn's\n").expect("turn");
        std::fs::write(space.path().join("local.txt"), "the person's\n").expect("space");
        let last = walk(turn.path());
        let rest = rest_of(&first, &last, &HashSet::new());
        let brought = bring_back(turn.path(), space.path(), &rest).await;
        assert_eq!(
            std::fs::read_to_string(space.path().join(".env"))
                .ok()
                .as_deref(),
            Some("A=2\n")
        );
        assert_eq!(
            std::fs::read_to_string(space.path().join("node_modules/lodash/index.js"))
                .ok()
                .as_deref(),
            Some("x\n")
        );
        assert!(!space.path().join("cache/old").exists());
        assert_eq!(
            std::fs::read_to_string(space.path().join("local.txt"))
                .ok()
                .as_deref(),
            Some("the person's\n")
        );
        assert_eq!(brought.changed_meanwhile, ["local.txt"]);
        assert!(brought.put.contains(&".env".to_string()), "{brought:?}");
        assert!(
            brought.put.contains(&"node_modules".to_string()),
            "{brought:?}"
        );
        assert!(
            brought.put.contains(&"cache/old".to_string()),
            "{brought:?}"
        );
    }

    /// Where no clone can be made, a folder is copied with everything under it, links as links.
    #[test]
    fn a_folder_is_copied_plainly_where_no_clone_can_be_made() {
        let root = tempfile::tempdir().expect("root");
        let source = root.path().join("source");
        std::fs::create_dir_all(source.join("lodash/lib")).expect("dirs");
        std::fs::write(source.join("lodash/index.js"), "x\n").expect("file");
        std::fs::write(source.join("lodash/lib/a.js"), "a\n").expect("file");
        #[cfg(unix)]
        std::os::unix::fs::symlink("index.js", source.join("lodash/main.js")).expect("link");
        let target = root.path().join("target");
        copy_plainly(&source, &target).expect("copied");
        assert_eq!(
            std::fs::read_to_string(target.join("lodash/index.js"))
                .ok()
                .as_deref(),
            Some("x\n")
        );
        assert_eq!(
            std::fs::read_to_string(target.join("lodash/lib/a.js"))
                .ok()
                .as_deref(),
            Some("a\n")
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_link(target.join("lodash/main.js")).ok(),
            Some(PathBuf::from("index.js"))
        );
    }

    #[test]
    fn a_kept_copy_takes_a_name_the_folder_does_not_hold() {
        let space = tempfile::tempdir().expect("space");
        assert_eq!(
            kept_copy_name(space.path(), "docs/notes.md"),
            "docs/notes (Claude Code's version).md"
        );
        std::fs::create_dir_all(space.path().join("docs")).expect("docs");
        std::fs::write(
            space.path().join("docs/notes (Claude Code's version).md"),
            "x",
        )
        .expect("x");
        assert_eq!(
            kept_copy_name(space.path(), "docs/notes.md"),
            "docs/notes (Claude Code's version 2).md"
        );
        assert_eq!(
            kept_copy_name(space.path(), "Makefile"),
            "Makefile (Claude Code's version)"
        );
        assert_eq!(
            kept_copy_name(space.path(), ".env"),
            ".env (Claude Code's version)"
        );
    }

    /// On macOS a turn folder is a clone of the whole space folder, ignored files and the
    /// repository included, named for its agent, its repository told to keep its stat cache, and
    /// gone once done and dropped; the place refuses a root inside the space's folder. A folder a
    /// process left is taken as a leftover, and `recover` brings its changes into the space's
    /// folder and removes it.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_turn_folder_is_a_clone_of_the_whole_space_folder_and_a_leftover_is_recovered() {
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
        let repo = TurnRepo::of(&space).expect("a repository");
        let folder = TurnFolder::clone_of(&place, &repo, "agent-1")
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
        assert_eq!(
            git_in(&path, &["config", "core.checkStat"]).trim(),
            "minimal"
        );

        // A turn that began and was left, as a process that stopped mid-turn leaves it.
        let started = folder.begin().await.expect("began");
        std::fs::write(path.join("README.md"), "one, by the turn\n").expect("turn");
        std::fs::write(path.join(".env"), "LOCAL=2\n").expect("turn");
        drop(started);
        drop(folder);
        assert!(path.exists(), "a turn whose changes never went in stays");
        IN_USE.lock().remove(&path);
        let leftovers = place.leftovers();
        assert_eq!(leftovers.len(), 1, "{leftovers:?}");
        let put_space = space.clone();
        recover(
            leftovers.into_iter().next().expect("one"),
            &space,
            |files, _expected| async move {
                for (path, bytes) in files {
                    if let Some(bytes) = bytes {
                        std::fs::write(put_space.join(path), bytes).expect("put");
                    }
                }
                Some(Vec::new())
            },
            |_, _| async {},
        )
        .await;
        assert_eq!(
            std::fs::read_to_string(space.join("README.md"))
                .ok()
                .as_deref(),
            Some("one, by the turn\n")
        );
        assert_eq!(
            std::fs::read_to_string(space.join(".env")).ok().as_deref(),
            Some("LOCAL=2\n")
        );
        for _ in 0..100 {
            if !path.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!path.exists());
        assert!(!record_of(&path).exists());
    }
}
