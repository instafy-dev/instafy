//! The folder pre-flight of a local-engine turn (docs/Local-Engine-Turns.md 3.9), run on the
//! space's folder after the pre-turn refresh and before `claude` starts. It keeps a teammate's
//! Claude Code settings, hooks, MCP servers and out-of-folder imports from loading by
//! construction, in case `--setting-sources user` or `--strict-mcp-config` behaves otherwise
//! than expected (D6):
//!
//! - **`project_config`.** No tracked path at any depth has a `.claude` segment, and the folder's
//!   root holds no `.claude` entry and no `.mcp.json`, tracked or not: Claude Code reads the
//!   folder, not git's index. The failure names each path, relative to the folder.
//! - **`unsafe_import`.** Every tracked `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`, those at
//!   the root whether tracked or not, and every file they import, followed with a bound: no path
//!   a word after an `@` could import, anywhere in the file (code included), is in the home folder
//!   (`~/`), is absolute below an entry the filesystem's root holds, leads out of the folder to
//!   anything but a folder above it, resolves outside the folder after following links, or
//!   resolves to an existing file git does not track. Such a file exists only on this computer (a
//!   `.env`), and its import would put it in front of a turn whose reply everyone in the space
//!   reads. Of the paths imports name outside the folder, only the root's own entries are looked
//!   up: an absolute path whose first name the root does not hold, such as a path alias
//!   (`@/components/ui/button`), names nothing, and so does a folder above the folder (`@..`). A
//!   memory file that is itself a link is an import of its target. A file's imports are resolved
//!   both from the path that brought it in, as written, and from its own place once links are
//!   followed: Claude Code may read either way. Each file is read once, however many paths reach
//!   it. The root `AGENTS.md` and `INSTAFY.md` Instafy seeds may be untracked (D-B): the Desktop
//!   scaffold commits them only into `.instafy/.git`, so a folder whose repository is the
//!   person's own `.git` leaves them out. Every other rule holds for them, and every rule for
//!   what they import.
//! - **`unsafe_link`.** No tracked symbolic link resolves outside the folder.
//!
//! Its git commands read `.instafy/.git`, the repository the origin saves to, with the folder as
//! work tree whenever that exists, otherwise the folder's own `.git`, with hooks and the file
//! monitor off and the allowlisted environment, as the job's own git commands run. A git command
//! that fails refuses the turn as `preflight_failed`, and so does a folder with neither
//! repository (D-A): nothing there could say what a turn changed, so no turn could save.
//!
//! Names compare as a Mac's folders compare them (`saves::same_name`): ignoring case, beyond
//! ASCII too, so Claude Code opens a tracked `.Claude/settings.json` as `.claude/settings.json`
//! and a root `.mcp.jſon` (a long s) as `.mcp.json`. The root's own entries are also looked up
//! through the folder, which opens a name as Claude Code will.
//!
//! A memory file's `@` imports are not read as Markdown (D-L): one linear pass over its text
//! finds every path Claude Code could import from it, and more (`imports_in`). Every `@` starts a
//! word, wherever it is, and the word and each of its parts that ends at ASCII punctuation is a
//! candidate, as written, with its HTML comments removed, and with the escaped brackets of a
//! link's text read as brackets. That reading has a budget for each byte of the file, a word runs
//! for a bounded number of characters, and one pre-flight resolves a bounded number of
//! candidates: a file built to cost more, or with a longer word, is refused as
//! `preflight_failed`, never read in part.
//!
//! The whole pre-flight has a deadline ([`PREFLIGHT_WITHIN`]): a folder it cannot check by then is
//! refused as `preflight_failed`. Once it ends, by its deadline or because a Stop dropped it, work
//! left on its blocking thread stops at its next file.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::process::Command;
use unicode_normalization::UnicodeNormalization;

use super::FailureCode;
use super::events::{LaneFailure, redact_tokens};
use super::saves::{name_key, same_name};

/// How long the whole pre-flight may run: its git command and its reading of the folder.
const PREFLIGHT_WITHIN: Duration = Duration::from_secs(60);
/// The refusal of a pre-flight that ran past [`PREFLIGHT_WITHIN`].
const TOOK_TOO_LONG: &str = "Instafy took too long to check this space's folder.";
/// How long one git command of the pre-flight may run.
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How many imports deep the import check follows, as Claude Code follows them.
const MAX_IMPORT_DEPTH: usize = 5;
/// How many memory files the import check follows at most, counting a file once for each path
/// that reaches it.
const MAX_IMPORTED_FILES: usize = 512;
/// How many import candidates one pre-flight resolves at most: each memory file's, once for each
/// path that reaches it. Each is resolved from up to two places.
const MAX_IMPORT_CANDIDATES: usize = 20_000;
/// The largest memory file the import check reads. A larger one cannot be checked.
const MAX_MEMORY_FILE_BYTES: u64 = 1024 * 1024;
/// The most characters a word after an `@` may run for. A file with a longer one is refused,
/// never read in part: Claude Code resolves `..` as written before it opens a path, so a word of
/// any length can name a short path (`@aaaa…/../.env`).
const MAX_WORD_CHARS: usize = 4096;
/// What reading a memory file's `@` words may cost for each byte of the file: one for each
/// character a word reading scans, and one for each byte of each candidate it gives
/// ([`imports_in`]). An ordinary file costs a few for each byte. A word cut at punctuation in many
/// places costs up to the square of its length, and so do words that each start inside the one
/// before: a file built of them is refused instead of read.
const READING_COST_PER_BYTE: usize = 16;
/// What reading a memory file's `@` words may cost beyond [`READING_COST_PER_BYTE`], so a short
/// file's few long words are read: in a line of minified JSON, each `@` starts a word that runs
/// to the line's end, so a line of a thousand characters can cost over a million.
const READING_COST_ALLOWANCE: usize = 4 * 1024 * 1024;
/// How many paths a failure names before it counts the rest.
const MAX_NAMED_PATHS: usize = 50;

/// The memory files Claude Code reads as project instructions.
const MEMORY_FILES: [&str; 3] = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
/// The root files Instafy seeds, which may be untracked in a folder whose repository is the
/// person's own (D-B).
const SEEDED_ROOT_FILES: [&str; 2] = ["AGENTS.md", "INSTAFY.md"];
/// What a failure names for a link's target outside the folder: never its path, which can name
/// the OS user.
const OUTSIDE_THE_FOLDER: &str = "a file outside this space";
/// The refusal of a folder with no repository (D-A).
const NO_REPOSITORY: &str = "This space's folder on this computer has no git repository, so Instafy couldn't tell what a turn changes.";

/// Which repository the pre-flight reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Repository {
    /// `.instafy/.git`, with the folder as work tree: the repository the origin saves to.
    Instafy,
    /// The folder's own `.git`.
    Folder,
}

impl Repository {
    /// The repository of `folder`, if it has one.
    fn of(folder: &Path) -> Option<Self> {
        if folder.join(".instafy").join(".git").exists() {
            Some(Self::Instafy)
        } else if folder.join(".git").exists() {
            Some(Self::Folder)
        } else {
            None
        }
    }
}

/// A file git tracks in the folder.
#[derive(Clone, Debug)]
struct Entry {
    /// Relative to the folder, `/`-separated.
    path: String,
    symlink: bool,
}

/// What the checks know of the folder.
struct Folder {
    root: PathBuf,
    /// The folder's own path with every link resolved.
    canonical: PathBuf,
    /// The tracked files.
    entries: Vec<Entry>,
    /// The names the folder's root holds.
    root_names: Vec<String>,
    /// The tracked paths, and the same by [`name_key`], for the import check.
    tracked_paths: HashSet<String>,
    tracked_by_key: HashMap<String, Vec<String>>,
    /// The root files Instafy seeds, as the root holds them (D-B).
    seeded: SeededRootFiles,
}

impl Folder {
    /// What the checks know of the folder at `root`, whose tracked files are `entries`.
    fn read(root: &Path, entries: Vec<Entry>) -> Result<Self, LaneFailure> {
        let canonical = std::fs::canonicalize(root).map_err(|error| {
            failed(format!(
                "Instafy couldn't read this space's folder: {error}"
            ))
        })?;
        let mut tracked_paths = HashSet::new();
        let mut tracked_by_key: HashMap<String, Vec<String>> = HashMap::new();
        for entry in &entries {
            tracked_paths.insert(entry.path.clone());
            tracked_by_key
                .entry(name_key(&entry.path))
                .or_default()
                .push(entry.path.clone());
        }
        let mut folder = Self {
            root: root.to_path_buf(),
            canonical,
            entries,
            root_names: root_names(root)?,
            tracked_paths,
            tracked_by_key,
            seeded: SeededRootFiles::default(),
        };
        folder.seeded = SeededRootFiles::of(&folder);
        Ok(folder)
    }
}

/// The root `AGENTS.md` and `INSTAFY.md` Instafy seeds (D-B), found once per pre-flight: each
/// regular file, never a link, that the folder's root holds under one of those names.
#[derive(Default)]
struct SeededRootFiles {
    paths: Vec<PathBuf>,
    /// Their devices and inodes.
    ids: HashSet<(u64, u64)>,
}

impl SeededRootFiles {
    fn of(folder: &Folder) -> Self {
        let mut seeded = Self::default();
        for name in SEEDED_ROOT_FILES {
            for entry in root_entries_named(folder, name) {
                let at_root = folder.root.join(&entry);
                let Ok(metadata) = std::fs::symlink_metadata(&at_root) else {
                    continue;
                };
                if metadata.file_type().is_file() {
                    seeded.ids.extend(file_id(&metadata));
                    seeded.paths.push(at_root);
                }
            }
        }
        seeded
    }

    /// Whether the file at `resolved` (canonical) is one of them.
    fn hold(&self, resolved: &Path) -> bool {
        self.paths.iter().any(|path| path == resolved)
            || std::fs::metadata(resolved)
                .ok()
                .and_then(|metadata| file_id(&metadata))
                .is_some_and(|id| self.ids.contains(&id))
    }
}

/// A file's device and inode.
#[cfg(unix)]
fn file_id(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_id(_: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

fn failed(message: impl Into<String>) -> LaneFailure {
    LaneFailure::new(FailureCode::PreflightFailed, redact_tokens(&message.into()))
}

fn named(paths: &BTreeSet<String>) -> String {
    let mut shown: Vec<String> = paths
        .iter()
        .take(MAX_NAMED_PATHS)
        .map(|path| redact_tokens(path))
        .collect();
    if paths.len() > MAX_NAMED_PATHS {
        shown.push(format!("and {} more", paths.len() - MAX_NAMED_PATHS));
    }
    shown.join(", ")
}

/// Runs the pre-flight on `folder`. `Ok` when Claude Code may start there; otherwise the failure,
/// with its code and the paths it refused. One that runs past [`PREFLIGHT_WITHIN`] is refused as
/// `preflight_failed`. Dropping it ends it too: a Stop ends the turn while it runs.
pub async fn check(folder: &Path) -> Result<(), LaneFailure> {
    check_within(folder, PREFLIGHT_WITHIN).await
}

/// [`check`], refused once it has run for `within`.
async fn check_within(folder: &Path, within: Duration) -> Result<(), LaneFailure> {
    // However this ends, work it left on its blocking thread stops at its next file. Its git
    // command is killed when dropped.
    let abandoned = Abandoned::default();
    tokio::time::timeout(within, check_now(folder, abandoned.flag()))
        .await
        .unwrap_or_else(|_| Err(failed(TOOK_TOO_LONG)))
}

async fn check_now(folder: &Path, abandoned: Arc<AtomicBool>) -> Result<(), LaneFailure> {
    // Without a repository nothing records what a turn changes: no turn could save or say what
    // it changed (D-A).
    let Some(repository) = Repository::of(folder) else {
        return Err(failed(NO_REPOSITORY));
    };
    let entries = tracked_files(folder, repository).await?;
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || check_folder(&folder, entries, &abandoned))
        .await
        .map_err(|error| {
            failed(format!(
                "Instafy couldn't check this space's folder: {error}"
            ))
        })?
}

/// Set once the pre-flight that holds it has ended, however it ended (its deadline, or a Stop
/// that dropped it): its blocking work reads it before each file, and stops.
#[derive(Default)]
struct Abandoned(Arc<AtomicBool>);

impl Abandoned {
    fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.0)
    }
}

impl Drop for Abandoned {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// `Err` once the pre-flight this work is for has ended ([`Abandoned`]); nothing reads that error.
fn still_wanted(abandoned: &AtomicBool) -> Result<(), LaneFailure> {
    if abandoned.load(Ordering::Relaxed) {
        return Err(failed("Instafy stopped checking this space's folder."));
    }
    Ok(())
}

fn check_folder(
    root: &Path,
    entries: Vec<Entry>,
    abandoned: &AtomicBool,
) -> Result<(), LaneFailure> {
    still_wanted(abandoned)?;
    let folder = Folder::read(root, entries)?;
    check_project_config(&folder)?;
    // Links first: the import check then reads no tracked file through a link that leads out.
    check_links(&folder, abandoned)?;
    check_imports(&folder, abandoned)?;
    Ok(())
}

/// The names the folder's root holds.
fn root_names(root: &Path) -> Result<Vec<String>, LaneFailure> {
    let read = std::fs::read_dir(root).map_err(|error| {
        failed(format!(
            "Instafy couldn't read this space's folder: {error}"
        ))
    })?;
    let mut names = Vec::new();
    for entry in read {
        let entry = entry.map_err(|error| {
            failed(format!(
                "Instafy couldn't read this space's folder: {error}"
            ))
        })?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

/// `git` in the repository the pre-flight reads, as the job's own git commands run it: hooks and
/// the file monitor off, pathspecs literal, no optional locks, and only the allowlisted
/// environment, since a teammate can write the repository's settings.
fn git_command(folder: &Path, repository: Repository, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "--literal-pathspecs",
    ]);
    if repository == Repository::Instafy {
        command
            .arg("--git-dir")
            .arg(folder.join(".instafy").join(".git"))
            .arg("--work-tree")
            .arg(folder);
    }
    command.args(args).current_dir(folder);
    crate::model_environment::apply_allowlisted_tokio_environment(&mut command, &[]);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// Every tracked file, with whether it is a symbolic link (mode 120000), from
/// `git ls-files --stage -z`.
async fn tracked_files(folder: &Path, repository: Repository) -> Result<Vec<Entry>, LaneFailure> {
    let mut command = git_command(folder, repository, &["ls-files", "--stage", "-z"]);
    let output = match tokio::time::timeout(GIT_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Err(failed(format!(
                "Instafy couldn't run git to check this space's folder: {error}"
            )));
        }
        Err(_) => {
            return Err(failed(
                "git took too long to list this space's files, so Instafy couldn't check them.",
            ));
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_line = stderr.lines().next().unwrap_or_default().trim();
        let shown: String = first_line.chars().take(300).collect();
        return Err(failed(format!(
            "git couldn't list this space's files, so Instafy couldn't check them: {shown}"
        )));
    }
    let mut entries = Vec::new();
    for record in output.stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let parsed = std::str::from_utf8(record).ok().and_then(|record| {
            let (meta, path) = record.split_once('\t')?;
            let mode = meta.split(' ').next()?;
            Some(Entry {
                path: path.to_string(),
                symlink: mode == "120000",
            })
        });
        match parsed {
            Some(entry) => entries.push(entry),
            None => {
                return Err(failed(
                    "git listed a file of this space that Instafy couldn't read.",
                ));
            }
        }
    }
    Ok(entries)
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn slashed(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The entries of the folder's root that Claude Code opens as `wanted`: each named the same on a
/// Mac's folder ([`same_name`]), and the one the folder itself opens under that name, whatever
/// its spelling.
fn root_entries_named(folder: &Folder, wanted: &str) -> Vec<String> {
    let mut names: Vec<String> = folder
        .root_names
        .iter()
        .filter(|name| same_name(name, wanted))
        .cloned()
        .collect();
    if let Ok(opened) = std::fs::symlink_metadata(folder.root.join(wanted)) {
        let name = folder
            .root_names
            .iter()
            .find(|name| same_entry(&opened, &folder.root.join(name)))
            .cloned()
            .unwrap_or_else(|| wanted.to_string());
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// Whether the folder entry at `path`, a link not followed, is the one `entry` describes.
fn same_entry(entry: &std::fs::Metadata, path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(other) = std::fs::symlink_metadata(path) {
            return entry.dev() == other.dev() && entry.ino() == other.ino();
        }
    }
    let _ = (entry, path);
    false
}

/// `project_config`: a `.claude` path anywhere in the tracked files, or a `.claude` entry or a
/// `.mcp.json` at the root.
fn check_project_config(folder: &Folder) -> Result<(), LaneFailure> {
    let mut refused = BTreeSet::new();
    for entry in &folder.entries {
        let in_claude = entry
            .path
            .split('/')
            .any(|segment| same_name(segment, ".claude"));
        let root_mcp = !entry.path.contains('/') && same_name(&entry.path, ".mcp.json");
        if in_claude || root_mcp {
            refused.insert(entry.path.clone());
        }
    }
    refused.extend(root_entries_named(folder, ".mcp.json"));
    for name in root_entries_named(folder, ".claude") {
        let files = files_below(&folder.root, &name);
        if files.is_empty() {
            refused.insert(format!("{name}/"));
        }
        refused.extend(files);
    }
    if refused.is_empty() {
        return Ok(());
    }
    Err(LaneFailure::new(
        FailureCode::ProjectConfig,
        format!(
            "Claude Code turns from Instafy can't run while this space's folder holds these Claude Code files: {}.",
            named(&refused)
        ),
    ))
}

/// The files below `name` at the root (a folder), relative to the root, at most a bounded number;
/// `name` itself when it is no folder.
fn files_below(root: &Path, name: &str) -> Vec<String> {
    let start = root.join(name);
    let Ok(metadata) = std::fs::symlink_metadata(&start) else {
        return vec![name.to_string()];
    };
    if !metadata.is_dir() {
        return vec![name.to_string()];
    }
    let mut files = Vec::new();
    let mut pending = VecDeque::from([PathBuf::from(name)]);
    while let Some(relative) = pending.pop_front() {
        let Ok(read) = std::fs::read_dir(root.join(&relative)) else {
            files.push(format!("{}/", relative.to_string_lossy()));
            continue;
        };
        for entry in read.flatten() {
            if files.len() > MAX_NAMED_PATHS {
                return files;
            }
            let path = relative.join(entry.file_name());
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push_back(path);
            } else {
                files.push(slashed(&path));
            }
        }
    }
    files
}

/// `unsafe_link`: a tracked symbolic link that resolves outside the folder.
fn check_links(folder: &Folder, abandoned: &AtomicBool) -> Result<(), LaneFailure> {
    let mut refused = BTreeSet::new();
    for entry in folder.entries.iter().filter(|entry| entry.symlink) {
        still_wanted(abandoned)?;
        let link = folder.root.join(&entry.path);
        let Ok(metadata) = std::fs::symlink_metadata(&link) else {
            // Not in the folder now: nothing resolves through it.
            continue;
        };
        if !metadata.file_type().is_symlink() {
            continue;
        }
        if !link_stays_inside(folder, &link) {
            refused.insert(entry.path.clone());
        }
    }
    if refused.is_empty() {
        return Ok(());
    }
    Err(LaneFailure::new(
        FailureCode::UnsafeLink,
        format!(
            "These links in this space's folder point outside it: {}.",
            named(&refused)
        ),
    ))
}

/// Whether the link at `link` (absolute, in the folder) resolves inside the folder: followed when
/// it leads to something, and read as written when it leads to nothing.
fn link_stays_inside(folder: &Folder, link: &Path) -> bool {
    if let Ok(resolved) = std::fs::canonicalize(link) {
        return resolved.starts_with(&folder.canonical);
    }
    let Ok(target) = std::fs::read_link(link) else {
        return false;
    };
    let next = if target.is_absolute() {
        target
    } else {
        link.parent().unwrap_or(&folder.root).join(target)
    };
    lexically_inside(&folder.root, &next).is_some()
        || lexically_inside(&folder.canonical, &next).is_some()
}

/// `path` with `.` and `..` read as written, when it stays inside the folder `root`.
fn lexically_inside(root: &Path, path: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts: Vec<&std::ffi::OsStr> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let mut inside = root.to_path_buf();
    inside.extend(parts);
    Some(inside)
}

/// Whether the file at `canonical` (resolved, inside the folder, a regular file) is one git
/// tracks: its path, or a tracked path a Mac's folder reads as the same name ([`name_key`]) whose
/// own folder entry is that file. A tracked link to it is not: the link is tracked, the file it
/// points at is not.
fn is_tracked(folder: &Folder, canonical: &Path) -> bool {
    let Ok(relative) = canonical.strip_prefix(&folder.canonical) else {
        return false;
    };
    let relative = slashed(relative);
    if folder.tracked_paths.contains(&relative) {
        return true;
    }
    folder
        .tracked_by_key
        .get(&name_key(&relative))
        .is_some_and(|candidates| {
            candidates.iter().any(|candidate| {
                std::fs::symlink_metadata(folder.root.join(candidate))
                    .is_ok_and(|entry| same_entry(&entry, canonical))
            })
        })
}

/// Whether `resolved` (canonical, inside the folder) is a root `AGENTS.md` or `INSTAFY.md` that
/// Instafy seeds (D-B): the regular file, never a link, that the folder's root holds under that
/// name. The name an import was written with never decides it.
fn is_seeded_root_file(folder: &Folder, resolved: &Path) -> bool {
    folder.seeded.hold(resolved)
}

/// What may not load: an import a memory file brings in (a candidate of its `word`th word), or
/// the target of a memory file that is a link.
enum UnsafeImport {
    Import {
        file: String,
        word: usize,
        import: String,
    },
    Link {
        file: String,
        target: String,
    },
}

/// What a refusal names: each link, and for each word of a file, the longest candidate of it that
/// may not load. The shorter ones are its parts, and say no more.
fn shown(refused: Vec<UnsafeImport>) -> BTreeSet<String> {
    let mut shown = BTreeSet::new();
    let mut longest: BTreeMap<(String, usize), String> = BTreeMap::new();
    for unsafe_import in refused {
        match unsafe_import {
            UnsafeImport::Import { file, word, import } => {
                let kept = longest.entry((file, word)).or_default();
                if import.len() > kept.len() {
                    *kept = import;
                }
            }
            UnsafeImport::Link { file, target } => {
                shown.insert(format!("{file} links to {target}"));
            }
        }
    }
    for ((file, _), import) in longest {
        shown.insert(format!("{file} brings in @{import}"));
    }
    shown
}

/// A memory file the import check reads, by two folder-relative paths: the one it was reached
/// by, read as written, and its own, with every link followed. Claude Code may resolve its
/// imports from either.
struct MemoryFile {
    lexical: String,
    canonical: String,
    depth: usize,
}

/// What a memory file Claude Code finds at a folder-relative path loads.
enum MemoryTarget {
    /// Nothing: there is no file there now.
    Nothing,
    /// A file it may not load, through a link: the target as the failure names it.
    Unsafe(String),
    /// The file, relative to the folder with every link followed.
    File(String),
}

/// What the memory file at the folder-relative `path` loads. One reached through a link is an
/// import of the link's target, which must be a file git tracks inside the folder, or a root file
/// Instafy seeds (D-B).
fn memory_file_target(folder: &Folder, path: &str) -> MemoryTarget {
    let absolute = folder.root.join(path);
    let Ok(metadata) = std::fs::symlink_metadata(&absolute) else {
        return MemoryTarget::Nothing;
    };
    let resolved = match std::fs::canonicalize(&absolute) {
        Ok(resolved) => resolved,
        // A link that leads to nothing loads nothing, unless its words lead out of the folder.
        Err(_) if metadata.file_type().is_symlink() && !link_stays_inside(folder, &absolute) => {
            return MemoryTarget::Unsafe(OUTSIDE_THE_FOLDER.to_string());
        }
        Err(_) => return MemoryTarget::Nothing,
    };
    let Ok(relative) = resolved.strip_prefix(&folder.canonical) else {
        return MemoryTarget::Unsafe(OUTSIDE_THE_FOLDER.to_string());
    };
    let relative = slashed(relative);
    if !resolved.is_file() {
        return MemoryTarget::Nothing;
    }
    let through_a_link = relative != path;
    if through_a_link && !is_tracked(folder, &resolved) && !is_seeded_root_file(folder, &resolved) {
        return MemoryTarget::Unsafe(relative);
    }
    MemoryTarget::File(relative)
}

/// `unsafe_import`: the memory files and what they import, followed recursively with a bound.
/// Each file is read once, however many paths reach it, and its imports are resolved from each
/// of those paths. `Ok` holds how many files it read.
fn check_imports(folder: &Folder, abandoned: &AtomicBool) -> Result<usize, LaneFailure> {
    let is_memory_file = |path: &str| {
        MEMORY_FILES
            .iter()
            .any(|memory| same_name(file_name(path), memory))
    };
    let mut starts: Vec<String> = folder
        .entries
        .iter()
        .filter(|entry| is_memory_file(&entry.path))
        .map(|entry| entry.path.clone())
        .collect();
    for memory in MEMORY_FILES {
        starts.extend(root_entries_named(folder, memory));
    }
    let mut refused: Vec<UnsafeImport> = Vec::new();
    let mut queue: VecDeque<MemoryFile> = VecDeque::new();
    // The paths files were reached by, as written: each is followed once.
    let mut queued: HashSet<String> = HashSet::new();
    for path in starts {
        still_wanted(abandoned)?;
        if !queued.insert(path.clone()) {
            continue;
        }
        match memory_file_target(folder, &path) {
            MemoryTarget::Nothing => {}
            MemoryTarget::Unsafe(target) => {
                refused.push(UnsafeImport::Link { file: path, target });
            }
            MemoryTarget::File(canonical) => queue.push_back(MemoryFile {
                lexical: path,
                canonical,
                depth: 0,
            }),
        }
    }
    // What each file imports, by its own path with every link followed: a file reached by
    // several paths (links, or names a Mac's folder reads as the same) is read once.
    let mut read: HashMap<String, Rc<Vec<Candidate>>> = HashMap::new();
    let mut files_read = 0usize;
    let mut followed = 0usize;
    let mut resolved = 0usize;
    while let Some(file) = queue.pop_front() {
        still_wanted(abandoned)?;
        followed += 1;
        if followed > MAX_IMPORTED_FILES {
            return Err(failed(
                "This space's CLAUDE.md and AGENTS.md files bring in too many files for Instafy to check.",
            ));
        }
        let imports = match read.get(&file.canonical) {
            Some(imports) => Rc::clone(imports),
            None => {
                let Some(imports) = read_imports(folder, &file)? else {
                    continue;
                };
                files_read += 1;
                let imports = Rc::new(imports);
                read.insert(file.canonical.clone(), Rc::clone(&imports));
                imports
            }
        };
        resolved += imports.len();
        if resolved > MAX_IMPORT_CANDIDATES {
            return Err(failed(
                "This space's CLAUDE.md and AGENTS.md files have too many @ imports for Instafy to check what they bring in.",
            ));
        }
        // From the path that brought the file in, as written, and from its own place: whichever
        // Claude Code uses, both must be safe.
        let mut bases = vec![parent_of(&file.lexical)];
        let own = parent_of(&file.canonical);
        if own != bases[0] {
            bases.push(own);
        }
        for import in imports.iter() {
            for base in &bases {
                match resolve_import(folder, base, &import.path) {
                    ImportTarget::Unsafe => refused.push(UnsafeImport::Import {
                        file: file.lexical.clone(),
                        word: import.word,
                        import: import.path.clone(),
                    }),
                    ImportTarget::Nothing => {}
                    ImportTarget::File { lexical, canonical } => {
                        if file.depth + 1 < MAX_IMPORT_DEPTH && queued.insert(lexical.clone()) {
                            queue.push_back(MemoryFile {
                                lexical,
                                canonical,
                                depth: file.depth + 1,
                            });
                        }
                    }
                }
            }
        }
    }
    if refused.is_empty() {
        return Ok(files_read);
    }
    Err(LaneFailure::new(
        FailureCode::UnsafeImport,
        format!(
            "These imports bring in files that aren't part of the space: {}.",
            named(&shown(refused))
        ),
    ))
}

/// What the memory file `file` may import ([`imports_in`]), read at its own path: `None` when no
/// regular file is there now.
fn read_imports(folder: &Folder, file: &MemoryFile) -> Result<Option<Vec<Candidate>>, LaneFailure> {
    let absolute = folder.canonical.join(&file.canonical);
    let Ok(metadata) = std::fs::metadata(&absolute) else {
        return Ok(None);
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_MEMORY_FILE_BYTES {
        return Err(failed(format!(
            "{} is too large for Instafy to check what it brings in.",
            redact_tokens(&file.lexical)
        )));
    }
    let text = std::fs::read(&absolute).map_err(|error| {
        failed(format!(
            "Instafy couldn't read {}: {error}",
            redact_tokens(&file.lexical)
        ))
    })?;
    // A file built to take minutes and gigabytes to read is refused, never read in part, and so is
    // one with a word longer than the check reads.
    match imports_in(&String::from_utf8_lossy(&text)) {
        Ok(imports) => Ok(Some(imports)),
        Err(Unread::Costly) => Err(failed(format!(
            "{} has too many @ imports for Instafy to check what it brings in.",
            redact_tokens(&file.lexical)
        ))),
        Err(Unread::LongWord) => Err(failed(format!(
            "{} has an @ import too long for Instafy to check what it brings in.",
            redact_tokens(&file.lexical)
        ))),
    }
}

fn parent_of(path: &str) -> &Path {
    Path::new(path).parent().unwrap_or(Path::new(""))
}

enum ImportTarget {
    /// From the home folder, absolute below an entry the filesystem's root holds, out of the
    /// folder to anything but a folder above it, or a file git does not track.
    Unsafe,
    /// Nothing loads: the path names no file.
    Nothing,
    /// A file in the folder, whose own imports load too: the path the import names, read as
    /// written, and the file's own, with every link followed (both relative to the folder).
    File { lexical: String, canonical: String },
}

/// Where an `@` import of a memory file in the folder-relative `base` folder leads.
fn resolve_import(folder: &Folder, base: &Path, import: &str) -> ImportTarget {
    // Claude Code reads `~` as the home folder only before `/`. Any other `~…`, such as the
    // version range of `zod@~3.22.4`, is a path like any other.
    if import.starts_with("~/") {
        return ImportTarget::Unsafe;
    }
    let written = Path::new(import);
    if written.is_absolute() || written.has_root() {
        return absolute_import(written);
    }
    let joined = folder.root.join(base).join(written);
    let Some(lexical) = lexically_inside(&folder.root, &joined) else {
        // Out of the folder, only a folder above it is known to load nothing.
        if leads_to_a_folder_above(base, written) {
            return ImportTarget::Nothing;
        }
        return ImportTarget::Unsafe;
    };
    // Read as written first, as a path is resolved, then with its links followed. A path that
    // leads to nothing loads nothing.
    let Ok(resolved) = std::fs::canonicalize(&lexical) else {
        return ImportTarget::Nothing;
    };
    if !resolved.starts_with(&folder.canonical) {
        return ImportTarget::Unsafe;
    }
    if !resolved.is_file() {
        return ImportTarget::Nothing;
    }
    if !is_tracked(folder, &resolved) && !is_seeded_root_file(folder, &resolved) {
        return ImportTarget::Unsafe;
    }
    match (
        lexical.strip_prefix(&folder.root),
        resolved.strip_prefix(&folder.canonical),
    ) {
        (Ok(lexical), Ok(canonical)) => ImportTarget::File {
            lexical: slashed(lexical),
            canonical: slashed(canonical),
        },
        _ => ImportTarget::Unsafe,
    }
}

/// What the absolute import `written` loads, looked up no further than the filesystem's root:
/// nothing when it names the root, or when the root holds no entry by its first name, as for a
/// path alias such as `@/components/ui/button`. Anything else may be a file outside the folder.
fn absolute_import(written: &Path) -> ImportTarget {
    // As Claude Code resolves it: `.` and `..` read as written, and `..` at the root stays there.
    let mut names: Vec<&std::ffi::OsStr> = Vec::new();
    for component in written.components() {
        match component {
            Component::Normal(name) => names.push(name),
            Component::ParentDir => {
                names.pop();
            }
            Component::RootDir | Component::CurDir => {}
            Component::Prefix(_) => return ImportTarget::Unsafe,
        }
    }
    let Some(first) = names.first() else {
        return ImportTarget::Nothing;
    };
    let Some(first) = first.to_str() else {
        return ImportTarget::Unsafe;
    };
    for name in spellings(first) {
        match std::fs::symlink_metadata(Path::new("/").join(name)) {
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::InvalidInput
                        | std::io::ErrorKind::InvalidFilename
                ) => {}
            _ => return ImportTarget::Unsafe,
        }
    }
    ImportTarget::Nothing
}

/// The spellings of a name an import was written with that Claude Code may open: as written, and
/// in the NFC form it gives every path it resolves, which a folder that compares names exactly
/// holds apart.
fn spellings(name: &str) -> Vec<String> {
    let nfc: String = name.nfc().collect();
    if nfc == name {
        vec![nfc]
    } else {
        vec![name.to_string(), nfc]
    }
}

/// Whether `import`, read from the folder-relative `base` folder with `.` and `..` read as written,
/// as Claude Code resolves it, names a folder above the folder (`@..`), which loads nothing.
fn leads_to_a_folder_above(base: &Path, import: &Path) -> bool {
    // How deep inside the folder it is, how far above it it has climbed, and how deep below there
    // it has gone again.
    let (mut inside, mut above, mut below) = (base.components().count(), 0usize, 0usize);
    for component in import.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if below > 0 => below -= 1,
            Component::ParentDir if inside > 0 => inside -= 1,
            Component::ParentDir => above += 1,
            Component::Normal(_) if above > 0 => below += 1,
            Component::Normal(_) => inside += 1,
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    above > 0 && below == 0
}

/// JavaScript's white space (`\s`) outside U+2000 to U+200A. It holds U+FEFF, and not U+0085.
const JS_SPACES: [char; 14] = [
    '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2028}', '\u{2029}',
    '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
];

/// White space as Claude Code's import pattern reads it: JavaScript's `\s`.
fn is_js_space(character: char) -> bool {
    JS_SPACES.contains(&character) || ('\u{2000}'..='\u{200a}').contains(&character)
}

/// A path a memory file's `@` word could import, and the word it is a candidate of: the first in
/// the file that gives it, counted from 0.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) path: String,
    pub(crate) word: usize,
}

/// Why [`imports_in`] did not read a memory file. It is refused, never read in part.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unread {
    /// Reading it would cost more than its budget ([`READING_COST_PER_BYTE`]), as only a file
    /// built to cost that does.
    Costly,
    /// A word after one of its `@`s runs for more than [`MAX_WORD_CHARS`] characters.
    LongWord,
}

/// The paths a memory file's `@` words could import: every path Claude Code could import from it,
/// and more (D-L). The text is read once, as text, never as Markdown, so code spans, code blocks,
/// HTML and comments are read too:
/// - A carriage return, alone or before a line feed, is a line feed, as Claude Code reads it.
/// - Every `@` starts a word, whatever comes before it: in Claude Code's reading a word starts at
///   a Markdown token's start too, and a token can start anywhere.
/// - A word runs to white space as JavaScript reads it, or to a backslash that escapes no space,
///   for at most [`MAX_WORD_CHARS`] characters. An escaped space (`\ `) is a space of the word.
/// - Its candidates are the word, and each part of it from its start up to an ASCII punctuation
///   character, without it and with it: a Markdown token can end there, and Claude Code cuts a
///   path at its first `#`.
/// - A word that stops at `\[` or `\]` is read again past them, as brackets: in a link's text,
///   Claude Code's Markdown reads them as `[` and `]` before it reads the words.
/// - So are the candidates of the word with its HTML comments removed, as Claude Code reads an
///   HTML block that opens with one ([`Closing`]).
///
/// Each candidate counts once, in the order first found.
pub(crate) fn imports_in(text: &str) -> Result<Vec<Candidate>, Unread> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut imports = Imports::of(&text);
    let comments = Comments::of(&text);
    // The line of the `@` read last, from the bytes counted so far.
    let (mut line, mut counted) = (0usize, 0usize);
    for (at, _) in text.match_indices('@') {
        let start = at + 1;
        let (word, stop) = read_word(&text, start, None, false, &mut imports)?;
        imports.next_word();
        candidates(&word, &mut imports)?;
        if text[stop..].starts_with("\\[") || text[stop..].starts_with("\\]") {
            let (in_a_link, _) = read_word(&text, start, None, true, &mut imports)?;
            candidates(&in_a_link, &mut imports)?;
        }
        let Some(comments) = comments.as_ref() else {
            continue;
        };
        // Removing comments changes a word only when one opens where it was read, or right
        // after the backslash it stopped at.
        let reach = &text.as_bytes()[start..(stop + 5).min(text.len())];
        if !reach.windows(4).any(|bytes| bytes == b"<!--") {
            continue;
        }
        line += newlines(&text.as_bytes()[counted..at]);
        counted = at;
        for closing in [Closing::OnLine(line), Closing::Anywhere] {
            let removing = Some((comments, closing));
            let (removed, _) = read_word(&text, start, removing, false, &mut imports)?;
            if removed != word {
                candidates(&removed, &mut imports)?;
            }
        }
    }
    Ok(imports.found)
}

fn newlines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == b'\n').count()
}

/// What [`imports_in`] reads a memory file's `@` words into: the candidates found, each once in
/// the order first found, the word being read, and what reading the rest of the file may still
/// cost.
struct Imports {
    found: Vec<Candidate>,
    seen: HashSet<String>,
    words: usize,
    budget: usize,
}

impl Imports {
    /// Nothing found yet in `text`, and its whole budget left.
    fn of(text: &str) -> Self {
        Self {
            found: Vec::new(),
            seen: HashSet::new(),
            words: 0,
            budget: text
                .len()
                .saturating_mul(READING_COST_PER_BYTE)
                .saturating_add(READING_COST_ALLOWANCE),
        }
    }

    /// Spends `cost` of the budget: [`Unread::Costly`], with nothing left, once it is spent.
    fn spend(&mut self, cost: usize) -> Result<(), Unread> {
        match self.budget.checked_sub(cost) {
            Some(left) => {
                self.budget = left;
                Ok(())
            }
            None => {
                self.budget = 0;
                Err(Unread::Costly)
            }
        }
    }

    /// The candidates found from now on are another word's.
    fn next_word(&mut self) {
        self.words += 1;
    }

    fn push(&mut self, path: String) {
        if !self.seen.contains(&path) {
            self.seen.insert(path.clone());
            self.found.push(Candidate {
                path,
                word: self.words - 1,
            });
        }
    }
}

/// Where the HTML comments of a memory file may close: each `-->`, by its byte and its line.
struct Comments {
    closes: Vec<(usize, usize)>,
}

impl Comments {
    /// `None` when `text` opens no comment.
    fn of(text: &str) -> Option<Self> {
        if !text.contains("<!--") {
            return None;
        }
        let (mut line, mut counted) = (0usize, 0usize);
        let closes = text
            .match_indices("-->")
            .map(|(at, _)| {
                line += newlines(&text.as_bytes()[counted..at]);
                counted = at;
                (at, line)
            })
            .collect();
        Some(Self { closes })
    }

    /// The byte right after the comment that opens at `open` (its `<!--`), when it closes as
    /// `closing` says: at the first `-->` after its opening, as Claude Code's
    /// `/<!--[\s\S]*?-->/g` removes it.
    fn end_of(&self, open: usize, closing: Closing) -> Option<usize> {
        let first = self.closes.partition_point(|(at, _)| *at < open + 4);
        let (at, line) = *self.closes.get(first)?;
        match closing {
            Closing::OnLine(opened_on) if line != opened_on => None,
            _ => Some(at + 3),
        }
    }
}

/// Where a comment removed from a word must close. Claude Code removes the comments of an HTML
/// block that opens with one, and such a block ends with the line its first comment closes on: a
/// comment that opens after that one closes on that line or stays (`OnLine`, the line of the
/// word's `@`). `Anywhere` reads the comments of a word as removed from the whole text.
#[derive(Clone, Copy)]
enum Closing {
    OnLine(usize),
    Anywhere,
}

/// The word after an `@`, from byte `start` of `text`: up to white space as JavaScript reads it,
/// or to a backslash that escapes no space, with an escaped space kept as written. In a link's
/// text (`in_a_link`), a backslash also escapes a `[` or `]`, read as the bracket. With
/// `removing`, each HTML comment in the word is removed while comments close as it says; from the
/// first that does not, the rest is read as written. The word, and the byte the reading stopped
/// at. Each character read and each comment removed is spent from the budget of `imports`, and a
/// word of more than [`MAX_WORD_CHARS`] characters is refused.
fn read_word(
    text: &str,
    start: usize,
    mut removing: Option<(&Comments, Closing)>,
    in_a_link: bool,
    imports: &mut Imports,
) -> Result<(String, usize), Unread> {
    let mut word = String::new();
    let mut at = start;
    let mut length = 0usize;
    loop {
        at = past_comments(text, at, &mut removing, imports)?;
        let Some(character) = text[at..].chars().next() else {
            break;
        };
        imports.spend(1)?;
        if is_js_space(character) {
            break;
        }
        // What the word takes here, and where its reading goes on.
        let (taken, next) = if character == '\\' {
            let next = past_comments(text, at + 1, &mut removing, imports)?;
            match text[next..].chars().next() {
                Some(' ') => ("\\ ", next + 1),
                Some('[' | ']') if in_a_link => (&text[next..=next], next + 1),
                _ => break,
            }
        } else {
            let next = at + character.len_utf8();
            (&text[at..next], next)
        };
        length += taken.chars().count();
        if length > MAX_WORD_CHARS {
            return Err(Unread::LongWord);
        }
        word.push_str(taken);
        at = next;
    }
    Ok((word, at))
}

/// `at`, moved past each HTML comment that opens there and is removed ([`read_word`]).
fn past_comments(
    text: &str,
    mut at: usize,
    removing: &mut Option<(&Comments, Closing)>,
    imports: &mut Imports,
) -> Result<usize, Unread> {
    while let Some((comments, closing)) = *removing {
        if !text[at..].starts_with("<!--") {
            break;
        }
        match comments.end_of(at, closing) {
            Some(end) => {
                imports.spend(1)?;
                at = end;
            }
            // A comment that does not close stays, and so does every one after it.
            None => *removing = None,
        }
    }
    Ok(at)
}

/// The candidates of `word` ([`imports_in`]): the word, and each part of it from its start up to
/// an ASCII punctuation character, without it and with it, each with its escaped spaces read as
/// spaces. Each byte of each is spent from the budget of `imports`.
fn candidates(word: &str, imports: &mut Imports) -> Result<(), Unread> {
    let mut ends: Vec<usize> = Vec::new();
    for (index, character) in word.char_indices() {
        if character.is_ascii_punctuation() {
            ends.extend([index, index + 1]);
        }
    }
    ends.push(word.len());
    ends.dedup();
    for end in ends {
        if end == 0 {
            continue;
        }
        let candidate = &word[..end];
        imports.spend(candidate.len())?;
        imports.push(candidate.replace("\\ ", " "));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paths `text` could import ([`imports_in`]), read within its budget.
    fn paths(text: &str) -> Vec<String> {
        imports_in(text)
            .expect("read within its budget")
            .into_iter()
            .map(|candidate| candidate.path)
            .collect()
    }

    /// Every `@` starts a word, wherever it is: code spans, code blocks and HTML are read too
    /// (D-L). A word ends at white space, and each part of it up to an ASCII punctuation
    /// character is a candidate too.
    #[test]
    fn every_at_starts_a_word_wherever_it_is() {
        let text = "@AGENTS.md\n\
                    See @docs/style.md, then @~/notes.md.\n\
                    Mail me at someone@example.com or @ nothing.\n\
                    Inline `@/etc/passwd` is code, and @/etc/hosts is not.\n\
                    ```\n@~/in-a-block.md\n```\n\
                    ~~~~md\n@../in-a-tilde-block\n~~~~\n\
                    @My\\ Notes.md\n";
        let found = paths(text);
        for path in [
            "AGENTS.md",
            "docs/style.md",
            "~/notes.md",
            "example.com",
            "/etc/passwd",
            "/etc/hosts",
            "~/in-a-block.md",
            "../in-a-tilde-block",
            "My Notes.md",
            // Parts of words, up to punctuation.
            "AGENTS",
            "docs",
            "docs/",
            "docs/style.md,",
            "~",
            "~/notes.md.",
            "My",
        ] {
            assert!(found.iter().any(|found| found == path), "{path}: {found:?}");
        }
        // No candidate runs past white space, or is empty; a word runs to white space, a code
        // span's closing backtick included.
        assert!(
            found
                .iter()
                .all(|path| !path.is_empty() && !path.contains('\n') && path != "nothing"),
            "{found:?}"
        );
        assert!(found.contains(&"/etc/passwd`".to_string()), "{found:?}");
        // Each counts once, in the order first found, with the word it is of.
        let candidate = |path: &str, word: usize| Candidate {
            path: path.to_string(),
            word,
        };
        assert_eq!(
            imports_in("@a.md and @a.md, @b\n").unwrap(),
            [
                candidate("a", 0),
                candidate("a.", 0),
                candidate("a.md", 0),
                candidate("a.md,", 1),
                candidate("b", 2),
            ]
        );
    }

    /// Each form of an import that a review found Claude Code reads and a reading of the text as
    /// Markdown did not (preflight-1, preflight-list-item-codespans,
    /// preflight-paragraph-interrupt-differences, preflight-escape-does-not-end-word), or that a
    /// reading of the raw text missed (superset-link-text-escaped-brackets): each is found.
    #[test]
    fn every_form_the_reviews_found_is_read() {
        for (text, import) in [
            // Claude Code's Markdown reads `\[` and `\]` in a link's text as `[` and `]` before it
            // reads its words, and resolves `x]/..` as written.
            (
                "Read [@x\\]/../.env](https://example.invalid) first.\n",
                "x]/../.env",
            ),
            ("[see @x\\[\\]/../.env](u)\n", "x[]/../.env"),
            ("[a]: u\n\n[@x\\]/../.env][a]\n", "x]/../.env"),
            ("[@a\\]\\]\\[b](u)\n", "a]][b"),
            ("[x @y\\]\\ z](u)\n", "y] z"),
            // A list item's code spans are the item's text to Claude Code.
            (
                "- Never run `cat @.env | less` in a shared terminal.\n",
                ".env",
            ),
            ("1. Use `` @~/.ssh/id_rsa `` here\n", "~/.ssh/id_rsa"),
            ("> - First `see @.env here` item\n\n- Second\n", ".env"),
            // A fence on a last line with no line end after it opens no block for Claude Code.
            ("Read this first.\n```text @.env", ".env"),
            ("Read this first.\n~~~ @.env", ".env"),
            // An HTML block that interrupts a paragraph is inline HTML to Claude Code.
            ("Read the notes.\n <div>@.env\n", ".env"),
            ("Read the notes.\n <div>**x**@.env\n", ".env"),
            // An HTML comment block, as Claude Code reads it with its comments removed.
            ("<!-- c -->@.env\n", ".env"),
            ("<!-- a -->@.e<!-- b -->nv\n", ".env"),
            ("<!-- a -->@My\\<!-- b --> Notes.md\n", "My Notes.md"),
            // An escape is a token of its own: the word ends before it.
            ("**Note**@.env\\#\n", ".env"),
            ("<b>@.env\\@\n", ".env"),
            ("\\*@.env\\$ more\n", ".env"),
            ("[see](u)@.env\\=\n", ".env"),
            // Claude Code cuts a path at its first `#`.
            ("See @.env#x here.\n", ".env"),
            // Escaped backticks open no code span; backticks in an attribute are the tag's.
            ("Read \\` @~/.ssh/id_rsa \\` first.\n", "~/.ssh/id_rsa"),
            ("See <b title=\"`\"> @~/x <i title=\"`\"> here.\n", "~/x"),
            ("```js`\n@~/x\n", "~/x"),
            ("- item\n  ```\n  code\n@~/x\n", "~/x"),
            // Code is read too (D-L).
            ("`@~/x`\n", "~/x"),
            ("``a ` @~/x``\n", "~/x"),
            ("```\n@~/x\n```\n", "~/x"),
            ("~~~\n@~/x\n~~~\n", "~/x"),
            // A lone carriage return ends a line.
            ("```\rcode\r```\r@~/x\r", "~/x"),
            // Emphasis, strikethrough and escapes start and end tokens anywhere.
            ("**Note**@~/x\n", "~/x"),
            ("\\*@~/x\n", "~/x"),
            ("~~@.env~~\n", ".env"),
            ("~~@~/x~~\n", "~/x"),
            // White space is JavaScript's: U+FEFF ends a word.
            ("See\u{feff}@~/x\n", "~/x"),
            ("See @.env\u{feff}x here.\n", ".env"),
            // A backslash that escapes no space ends a word.
            ("See @.env\\x here.\n", ".env"),
        ] {
            let found = paths(text);
            assert!(
                found.iter().any(|found| found == import),
                "{text:?}: {found:?}"
            );
        }
        // A word runs as Claude Code's pattern runs it: through U+0085, which JavaScript reads as
        // no white space, and never past a backslash that escapes no space.
        let found = paths("x\u{85}@.env\u{85}y\n");
        assert!(found.contains(&".env\u{85}y".to_string()), "{found:?}");
        let found = paths("@docs\\notes.md\n");
        assert!(found == ["docs"], "{found:?}");
        // A comment that does not close on its line stays in the HTML block it opens; removed
        // from the whole text, it goes.
        let found = paths("<!-- a -->@.e<!-- b\n-->nv\n");
        assert!(
            found.contains(&".e<!--".to_string()) && found.contains(&".env".to_string()),
            "{found:?}"
        );
        // In that block, a comment that closes on its line goes, and the first that does not
        // stays, with the rest of the word: `.env<!--` is the path Claude Code reads.
        let found = paths("<!-- a -->@.e<!-- x -->nv<!-- y\n-->z\n");
        assert!(
            found.contains(&".env<!--".to_string()) && found.contains(&".envz".to_string()),
            "{found:?}"
        );
    }

    /// A file built to cost more than its budget is refused at once, never read in part: words
    /// cut at punctuation in many places, words that each start inside the one before, or that
    /// run across comments (preflight-1, D-L), each within the length a word may run for. Text
    /// where no word starts costs nothing, however a Markdown parser would take it
    /// (preflight-parser-cost-unbudgeted), and an ordinary file as large as the check reads is
    /// read to its end.
    #[test]
    fn a_file_too_costly_to_read_is_refused_at_once() {
        let size = MAX_MEMORY_FILE_BYTES as usize;
        // Generous for a debug build on a slow machine.
        let bound = Duration::from_secs(20);
        for unit in [
            "@",
            "[@",
            "&amp;@",
            "@a\u{85}",
            "@<!---->",
            "@x<!-- -->",
            "@a\\[",
            "[@x\\]",
            "@\\]",
        ] {
            // Lines of words shorter than MAX_WORD_CHARS.
            let line = format!("{}\n", unit.repeat(4000 / unit.chars().count()));
            let text = line.repeat(size / line.len());
            let started = std::time::Instant::now();
            assert_eq!(imports_in(&text), Err(Unread::Costly), "{unit:?}");
            assert!(
                started.elapsed() < bound,
                "{unit:?}: {:?}",
                started.elapsed()
            );
        }
        for text in [
            format!("</{}", "<!--".repeat((size - 2) / 4)),
            "*a_ ".repeat(size / 4),
            // Each word ends where it starts.
            "\\@".repeat(size / 2),
        ] {
            let started = std::time::Instant::now();
            assert_eq!(imports_in(&text), Ok(Vec::new()));
            assert!(started.elapsed() < bound, "{:?}", started.elapsed());
        }

        let line = "See @docs/a.md, then @b.md.\n";
        let mut text = line.repeat(size / line.len() - 1);
        text.push_str("Last, @c.md\n");
        assert!(text.len() <= size);
        let started = std::time::Instant::now();
        let found = paths(&text);
        assert!(started.elapsed() < bound, "{:?}", started.elapsed());
        assert_eq!(
            found,
            [
                "docs",
                "docs/",
                "docs/a",
                "docs/a.",
                "docs/a.md",
                "docs/a.md,",
                "b",
                "b.",
                "b.md",
                "b.md.",
                "c",
                "c.",
                "c.md"
            ]
        );
    }

    /// A word longer than MAX_WORD_CHARS refuses its file, never read in part
    /// (superset-word-cap-truncates): Claude Code resolves `..` as written, so the end of a long
    /// word can bring it back to a short path. A word of MAX_WORD_CHARS characters is read whole.
    #[test]
    fn a_word_longer_than_the_check_reads_is_refused() {
        let long = "a".repeat(MAX_WORD_CHARS);
        let half = "a".repeat(MAX_WORD_CHARS / 2);
        for text in [
            format!("@{long}/../.env\n"),
            format!("@{long}\\ x\n"),
            // Longer once a link's escaped bracket is read, or once a comment is removed.
            format!("[@{}\\]/../.env](u)\n", &long[1..]),
            format!("<!-- a -->@{half}<!-- b -->{half}/../.env\n"),
        ] {
            assert_eq!(imports_in(&text), Err(Unread::LongWord), "{}", text.len());
        }
        // At once, whatever follows.
        let text = format!("@{}", "a.".repeat((MAX_MEMORY_FILE_BYTES as usize - 1) / 2));
        let started = std::time::Instant::now();
        assert_eq!(imports_in(&text), Err(Unread::LongWord));
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );

        let found = paths(&format!("See @{long} here, and @{long}"));
        assert_eq!(found, [long]);
    }

    /// A short file whose few long lines are dense with `@`s and punctuation, as minified JSON in a
    /// code block is, is read within its budget (budget-allowance-refuses-dense-benign-lines): each
    /// `@` there starts a word that runs to the line's end.
    #[test]
    fn a_short_file_of_minified_lines_is_read() {
        let dependencies: Vec<String> = (0..16)
            .map(|n| format!("\"@scope-{n}/package-{n}\":\"^{n}.2.3\""))
            .collect();
        let text = format!(
            "# Project\n\nUse pnpm.\n\n```json\n{{\"name\":\"app\",\"dependencies\":{{{}}}}}\n```\n",
            dependencies.join(",")
        );
        assert!(text.len() < 1024, "{}", text.len());
        let found = paths(&text);
        assert!(
            found.contains(&"scope-0/package-0".to_string()),
            "{found:?}"
        );
    }

    #[cfg(unix)]
    fn git(folder: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=Instafy Test",
                "-c",
                "user.email=test@instafy.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(folder)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", folder)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[cfg(unix)]
    fn write(folder: &Path, path: &str, text: &str) {
        let path = folder.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[cfg(unix)]
    fn link(folder: &Path, path: &str, target: &str) {
        let path = folder.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        std::os::unix::fs::symlink(target, path).unwrap();
    }

    #[cfg(unix)]
    async fn code_of(folder: &Path) -> Option<FailureCode> {
        check(folder).await.err().map(|failure| {
            assert!(failure.code.is_some(), "{failure:?}");
            failure.code.unwrap()
        })
    }

    /// A space folder whose own repository tracks the seeded files.
    #[cfg(unix)]
    fn seeded_space() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path();
        write(folder, "CLAUDE.md", "@AGENTS.md\n");
        write(folder, "AGENTS.md", "# Rules\nRead @docs/style.md first.\n");
        write(folder, "docs/style.md", "Short sentences.\n");
        write(folder, "README.md", "# Demo\n");
        git(folder, &["init", "-q", "-b", "main"]);
        git(folder, &["add", "."]);
        git(folder, &["commit", "-q", "-m", "seed"]);
        temp
    }

    /// A folder whose own repository tracks only its README: the person's own `.git`, where the
    /// files Instafy seeds stay untracked (D-B).
    #[cfg(unix)]
    fn own_repository() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path();
        write(folder, "README.md", "# Demo\n");
        git(folder, &["init", "-q", "-b", "main"]);
        git(folder, &["add", "."]);
        git(folder, &["commit", "-q", "-m", "seed"]);
        temp
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_seeded_space_passes() {
        let space = seeded_space();
        assert_eq!(code_of(space.path()).await, None);
        // A deeper .mcp.json is a plugin's, and an untracked file nothing imports is fine.
        write(space.path(), "claude-plugin/instafy/.mcp.json", "{}");
        write(space.path(), ".env", "SECRET=1\n");
        git(space.path(), &["add", "claude-plugin"]);
        assert_eq!(code_of(space.path()).await, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn project_configuration_is_refused_tracked_at_any_depth_or_at_the_root_untracked() {
        // Tracked, at any depth, in any case.
        let space = seeded_space();
        write(space.path(), "app/.Claude/settings.json", "{\"hooks\":{}}");
        git(space.path(), &["add", "app"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::ProjectConfig));
        assert!(
            failure.message.contains("app/.Claude/settings.json"),
            "{failure:?}"
        );

        // At the root, untracked: the person's own settings, and a root .mcp.json.
        let space = seeded_space();
        write(space.path(), ".claude/settings.local.json", "{}");
        write(space.path(), ".MCP.json", "{\"mcpServers\":{}}");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::ProjectConfig));
        assert!(
            failure.message.contains(".claude/settings.local.json")
                && failure.message.contains(".MCP.json"),
            "{failure:?}"
        );

        // An empty .claude folder at the root is named as the folder.
        let space = seeded_space();
        std::fs::create_dir(space.path().join(".claude")).unwrap();
        let failure = check(space.path()).await.unwrap_err();
        assert!(failure.message.contains(".claude/"), "{failure:?}");
    }

    /// A Mac opens a root `.mcp.jſon` (a long s, U+017F) as `.mcp.json` (preflight-3): it is
    /// refused tracked or not, and a tracked `AGENTſ.md` is read as the `AGENTS.md` it opens as.
    #[cfg(unix)]
    #[tokio::test]
    async fn names_a_mac_opens_as_claude_codes_are_refused_too() {
        let mcp = ".mcp.j\u{17f}on";
        let space = own_repository();
        write(space.path(), mcp, "{\"mcpServers\":{}}");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::ProjectConfig),
            "{failure:?}"
        );
        assert!(failure.message.contains(mcp), "{failure:?}");
        git(space.path(), &["add", mcp]);
        assert_eq!(
            code_of(space.path()).await,
            Some(FailureCode::ProjectConfig)
        );

        let space = own_repository();
        write(space.path(), "AGENT\u{17f}.md", "Read @.env first.\n");
        git(space.path(), &["add", "AGENT\u{17f}.md"]);
        write(space.path(), ".env", "SECRET=1\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(failure.message.contains("@.env"), "{failure:?}");

        // Below the root, where only the name says it is a memory file.
        let space = own_repository();
        write(
            space.path(),
            "docs/AGENT\u{17f}.md",
            "Read @../.env first.\n",
        );
        git(space.path(), &["add", "docs"]);
        write(space.path(), ".env", "SECRET=1\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure
                .message
                .contains("docs/AGENT\u{17f}.md brings in @../.env"),
            "{failure:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_import_of_an_untracked_or_outside_file_is_refused() {
        // Recursively, through AGENTS.md: a tracked file that imports an untracked one.
        let space = seeded_space();
        write(
            space.path(),
            "docs/style.md",
            "Short sentences. See @../.env\n",
        );
        git(space.path(), &["add", "docs/style.md"]);
        write(space.path(), ".env", "SECRET=1\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport));
        assert!(
            failure.message.contains("docs/style.md brings in @../.env"),
            "{failure:?}"
        );

        // A root CLAUDE.local.md that git does not track, importing from the home folder.
        let space = seeded_space();
        write(space.path(), "CLAUDE.local.md", "@~/.ssh/config\n");
        assert_eq!(code_of(space.path()).await, Some(FailureCode::UnsafeImport));

        // Absolute, and one that climbs out of the folder.
        for import in ["@/etc/hosts", "@../outside.md", "@docs/../../outside.md"] {
            let space = seeded_space();
            write(space.path(), "AGENTS.md", &format!("{import}\n"));
            git(space.path(), &["add", "AGENTS.md"]);
            assert_eq!(
                code_of(space.path()).await,
                Some(FailureCode::UnsafeImport),
                "{import}"
            );
        }

        // A tracked link that points at an untracked file.
        let space = seeded_space();
        write(space.path(), ".env", "SECRET=1\n");
        std::os::unix::fs::symlink(".env", space.path().join("env-link")).unwrap();
        git(space.path(), &["add", "env-link"]);
        write(space.path(), "AGENTS.md", "@env-link\n");
        git(space.path(), &["add", "AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, Some(FailureCode::UnsafeImport));

        // An import of a file that is not there, or of a folder, loads nothing.
        let space = seeded_space();
        write(
            space.path(),
            "AGENTS.md",
            "@docs/missing.md, @docs/ and @docs\n",
        );
        git(space.path(), &["add", "AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, None);

        // One inside code is read too, unlike Claude Code's reading (D-L).
        for text in ["`@~/.ssh/config`\n", "```\n@/etc/hosts\n```\n"] {
            let space = seeded_space();
            write(space.path(), "AGENTS.md", text);
            git(space.path(), &["add", "AGENTS.md"]);
            assert_eq!(
                code_of(space.path()).await,
                Some(FailureCode::UnsafeImport),
                "{text:?}"
            );
        }
    }

    /// A path alias names no file: an absolute import whose first name the filesystem's root does
    /// not hold loads nothing, in code or not, beside an untracked `.env`
    /// (false-refusals-absolute-home-outside-anywhere). One below an entry the root holds may be a
    /// file outside the folder, and is refused without being looked up further, `..` read as
    /// written first.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_absolute_import_below_no_entry_of_the_root_names_nothing() {
        for text in [
            "```tsx\nimport { Button } from \"@/components/ui/button\"\n```\n",
            "Use the `@/` alias, as in `@/hooks/use-toast`.\n",
            "\"paths\": { \"@/*\": [\"./src/*\"] }\n",
            "const utils = require('@/utils')\n",
            "See @/ and @/./components/../hooks.\n",
        ] {
            let space = seeded_space();
            write(space.path(), ".env", "SECRET=1\n");
            write(space.path(), "AGENTS.md", text);
            git(space.path(), &["add", "AGENTS.md"]);
            assert_eq!(code_of(space.path()).await, None, "{text:?}");
        }
        for (text, named) in [
            ("```sh\ncurl -d @/etc/hosts\n```\n", "@/etc/hosts"),
            ("See @/../etc/hosts\n", "@/../etc/hosts"),
            (
                "See @/components/../etc/hosts\n",
                "@/components/../etc/hosts",
            ),
        ] {
            let space = seeded_space();
            write(space.path(), "AGENTS.md", text);
            git(space.path(), &["add", "AGENTS.md"]);
            let failure = check(space.path()).await.unwrap_err();
            assert_eq!(
                failure.code,
                Some(FailureCode::UnsafeImport),
                "{text:?}: {failure:?}"
            );
            assert!(
                failure
                    .message
                    .ends_with(&format!(": AGENTS.md brings in {named}.")),
                "{failure:?}"
            );
        }
    }

    /// Claude Code reads `~` as the home folder only before `/`: a version range after `@~`, in
    /// code or not, is a path like any other, which names nothing here
    /// (false-refusals-absolute-home-outside-anywhere). A `~/` path is still refused.
    #[cfg(unix)]
    #[tokio::test]
    async fn only_a_tilde_before_a_slash_is_the_home_folder() {
        let space = seeded_space();
        write(space.path(), ".env", "SECRET=1\n");
        write(
            space.path(),
            "AGENTS.md",
            "`pnpm add zod@~3.22.4`, then `npm i lodash@~4.17.21` and @~ alone.\n",
        );
        git(space.path(), &["add", "AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, None);
        // A path like any other: an untracked file of that name may not load.
        write(space.path(), "~3.22.4", "x");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure.message.ends_with(": AGENTS.md brings in @~3.22.4."),
            "{failure:?}"
        );

        let space = seeded_space();
        write(space.path(), "AGENTS.md", "Notes live in `@~/notes.md`\n");
        git(space.path(), &["add", "AGENTS.md"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure
                .message
                .ends_with(": AGENTS.md brings in @~/notes.md`."),
            "{failure:?}"
        );
    }

    /// Claude Code opens every path it resolves in its NFC form, so the root is asked for a name
    /// in that form too: a folder that compares names exactly holds the two apart.
    #[test]
    fn a_name_is_looked_up_as_written_and_as_claude_code_opens_it() {
        assert_eq!(spellings("components"), ["components"]);
        assert_eq!(spellings("caf\u{e9}"), ["caf\u{e9}"]);
        assert_eq!(spellings("cafe\u{301}"), ["cafe\u{301}", "caf\u{e9}"]);
    }

    /// A path out of the folder is read as Claude Code resolves it, `..` as written: it names a
    /// folder above the folder only when nothing below where it climbed to is left.
    #[test]
    fn a_folder_above_is_read_with_dot_dot_as_written() {
        for (base, import, above) in [
            ("", "..", true),
            ("", "../..", true),
            ("", "./../.", true),
            ("docs", "../..", true),
            ("", "../x/..", true),
            ("docs", "../../x/../..", true),
            ("", "../x", false),
            ("", "../x/../y", false),
            ("", "../../x/.", false),
            // Inside the folder.
            ("docs", "..", false),
            ("", "x/..", false),
        ] {
            assert_eq!(
                leads_to_a_folder_above(Path::new(base), Path::new(import)),
                above,
                "{base:?} {import:?}"
            );
        }
    }

    /// `..` out of the folder names a folder above it, which loads nothing, in code or not
    /// (false-refusals-absolute-home-outside-anywhere). A path that climbs out and, `..` read as
    /// written, names anything below where it climbed to is still refused, without being looked
    /// up.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_above_the_folder_loads_nothing() {
        let space = seeded_space();
        write(space.path(), ".env", "SECRET=1\n");
        write(
            space.path(),
            "AGENTS.md",
            "Read @docs/style.md. Imports look like @... here, or @.. and @../.. too.\n",
        );
        write(space.path(), "docs/style.md", "Up: `@../..` and @../../\n");
        git(space.path(), &["add", "AGENTS.md", "docs/style.md"]);
        assert_eq!(code_of(space.path()).await, None);

        for (text, named) in [
            ("```sh\ncat @../README.md\n```\n", "@../README.md"),
            ("See @../../.. and @../x/../y here.\n", "@../x/../y"),
        ] {
            let space = seeded_space();
            write(space.path(), "AGENTS.md", text);
            git(space.path(), &["add", "AGENTS.md"]);
            let failure = check(space.path()).await.unwrap_err();
            assert_eq!(
                failure.code,
                Some(FailureCode::UnsafeImport),
                "{text:?}: {failure:?}"
            );
            assert!(
                failure
                    .message
                    .ends_with(&format!(": AGENTS.md brings in {named}.")),
                "{failure:?}"
            );
        }
    }

    /// Each way of writing an import a review found is refused end to end when it brings in an
    /// untracked `.env`, and the refusal names the longest path of the word that may not load
    /// (preflight-1, preflight-list-item-codespans, preflight-paragraph-interrupt-differences,
    /// preflight-escape-does-not-end-word).
    #[cfg(unix)]
    #[tokio::test]
    async fn every_way_of_writing_an_import_is_refused_end_to_end() {
        for text in [
            "# Rules\n\n- Never run `cat @.env | less` in a shared terminal.\n",
            "1. Use `` @.env `` here\n",
            "Read this first.\n```text @.env",
            "Read the notes.\n <div>@.env\n",
            "<!-- c -->@.env\n",
            "<!-- a -->@.e<!-- b -->nv\n",
            "**Note**@.env\\#\n",
            "<b>@.env\\@\n",
            "See @.env#x here.\n",
            "Never `@.env`.\n",
            "Read \\` @.env \\` first.\n",
            "See <b title=\"`\"> @.env <i title=\"`\"> here.\n",
            "```js`\n@.env\n",
            "- item\n  ```\n  code\n@.env\n",
            "```\rcode\r```\r@.env\r",
            "**Note**@.env\n",
            "\\*@.env\n",
            "~~@.env~~\n",
            "See\u{feff}@.env\n",
            "See @.env\\x here.\n",
        ] {
            let space = seeded_space();
            write(space.path(), "AGENTS.md", text);
            git(space.path(), &["add", "AGENTS.md"]);
            assert_eq!(code_of(space.path()).await, None, "no .env: {text:?}");
            write(space.path(), ".env", "SECRET=1\n");
            let failure = check(space.path()).await.unwrap_err();
            assert_eq!(
                failure.code,
                Some(FailureCode::UnsafeImport),
                "{text:?}: {failure:?}"
            );
            assert!(
                failure.message.ends_with(": AGENTS.md brings in @.env."),
                "{text:?}: {failure:?}"
            );
        }
        // A home folder import is named by its whole path, not by each part of it.
        let space = seeded_space();
        write(
            space.path(),
            "AGENTS.md",
            "1. Use `` @~/.ssh/id_rsa `` here\n",
        );
        git(space.path(), &["add", "AGENTS.md"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport));
        assert!(
            failure
                .message
                .ends_with(": AGENTS.md brings in @~/.ssh/id_rsa."),
            "{failure:?}"
        );

        // A link's text, whose escaped brackets Claude Code reads as brackets
        // (superset-link-text-escaped-brackets): named by the path it reads.
        let space = seeded_space();
        write(
            space.path(),
            "AGENTS.md",
            "Read [@x\\]/../.env](https://example.invalid) first.\n",
        );
        git(space.path(), &["add", "AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, None, "no .env");
        write(space.path(), ".env", "SECRET=1\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure
                .message
                .ends_with(": AGENTS.md brings in @x]/../.env."),
            "{failure:?}"
        );
    }

    /// A tracked memory file built to cost more than its budget is refused as `preflight_failed`
    /// at once, by its name, wherever it is (preflight-1), and so is one with a word longer than
    /// the check reads (superset-word-cap-truncates). An ordinary memory file as large as the
    /// check reads is read to its end.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_memory_file_too_costly_to_read_is_refused() {
        let space = seeded_space();
        write(
            space.path(),
            "docs/CLAUDE.md",
            &format!("{}\n", "@".repeat(4000)).repeat(75),
        );
        git(space.path(), &["add", "docs/CLAUDE.md"]);
        let started = std::time::Instant::now();
        let failure = check(space.path()).await.unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );
        assert!(
            failure
                .message
                .contains("docs/CLAUDE.md has too many @ imports for Instafy to check"),
            "{failure:?}"
        );

        // A word whose end brings it back to the untracked .env, read in part, would pass.
        let space = seeded_space();
        write(space.path(), ".env", "SECRET=1\n");
        write(
            space.path(),
            "AGENTS.md",
            &format!("See @{}/../.env\n", "a".repeat(MAX_WORD_CHARS)),
        );
        git(space.path(), &["add", "AGENTS.md"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );
        assert!(
            failure
                .message
                .contains("AGENTS.md has an @ import too long for Instafy to check"),
            "{failure:?}"
        );

        // An ordinary AGENTS.md as large as the check reads, whose last line imports the
        // untracked .env: the import is found.
        let space = seeded_space();
        let line = "See @docs/style.md, then @README.md.\n";
        let mut text = line.repeat(MAX_MEMORY_FILE_BYTES as usize / line.len() - 1);
        text.push_str("Last, @.env\n");
        write(space.path(), "AGENTS.md", &text);
        git(space.path(), &["add", "AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, None, "no .env: nothing loads");
        write(space.path(), ".env", "SECRET=1\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure.message.contains("AGENTS.md brings in @.env"),
            "{failure:?}"
        );
    }

    /// A memory file that is a link is an import of its target, and a nested import is resolved
    /// from the path that brought its file in as well as from the file's own place
    /// (preflight-2).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_memory_file_through_a_link_and_an_import_through_a_linked_folder_are_checked() {
        // A tracked AGENTS.md that links to an untracked .env.
        let space = seeded_space();
        write(space.path(), ".env", "SECRET=1\n");
        link(space.path(), "AGENTS.md", ".env");
        git(space.path(), &["add", "AGENTS.md"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure.message.contains("AGENTS.md links to .env"),
            "{failure:?}"
        );

        // A nested CLAUDE.md that links up to it.
        let space = seeded_space();
        write(space.path(), ".env", "SECRET=1\n");
        link(space.path(), "docs/CLAUDE.md", "../.env");
        git(space.path(), &["add", "docs/CLAUDE.md"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure.message.contains("docs/CLAUDE.md links to .env"),
            "{failure:?}"
        );

        // A root CLAUDE.local.md of the person's own that links out of the folder.
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "notes.md", "x");
        let space = seeded_space();
        link(
            space.path(),
            "CLAUDE.local.md",
            outside.path().join("notes.md").to_str().unwrap(),
        );
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure
                .message
                .contains("CLAUDE.local.md links to a file outside this space"),
            "{failure:?}"
        );
        assert!(
            !failure
                .message
                .contains(&outside.path().display().to_string()),
            "{failure:?}"
        );

        // A link to a tracked memory file is fine.
        let space = seeded_space();
        write(space.path(), "docs/AGENTS.md", "Docs rules.\n");
        link(space.path(), "AGENTS.md", "docs/AGENTS.md");
        git(space.path(), &["add", "AGENTS.md", "docs/AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, None);

        // `guides` links to `notes/en`: `@../.env` in notes/en/guide.md, brought in as
        // guides/guide.md, is the root .env when read from the path that brought it in.
        let space = seeded_space();
        write(space.path(), "AGENTS.md", "Read @guides/guide.md first.\n");
        write(space.path(), "notes/en/guide.md", "Setup: @../.env\n");
        link(space.path(), "guides", "notes/en");
        git(space.path(), &["add", "AGENTS.md", "notes", "guides"]);
        assert_eq!(code_of(space.path()).await, None, "no .env: nothing loads");
        write(space.path(), ".env", "SECRET=1\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure
                .message
                .contains("guides/guide.md brings in @../.env"),
            "{failure:?}"
        );
        // Read from its own place it is notes/.env.
        std::fs::remove_file(space.path().join(".env")).unwrap();
        write(space.path(), "notes/.env", "SECRET=1\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
    }

    /// In a folder whose repository is the person's own `.git`, the root `AGENTS.md` and
    /// `INSTAFY.md` Instafy seeds are untracked, and may be imported (D-B). Every other rule holds
    /// for them, and for what they import; the exemption is never a link and never a name as
    /// written.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_root_files_instafy_seeds_may_be_untracked() {
        let seeded = |space: &Path| {
            write(space, "CLAUDE.md", "@AGENTS.md\n@INSTAFY.md\n");
            write(space, "AGENTS.md", "# Rules\nShort sentences.\n");
            write(space, "INSTAFY.md", "# Instafy\n");
        };
        let space = own_repository();
        seeded(space.path());
        assert_eq!(code_of(space.path()).await, None);
        // Their names compare ignoring case.
        std::fs::rename(
            space.path().join("AGENTS.md"),
            space.path().join("agents.md"),
        )
        .unwrap();
        write(space.path(), "CLAUDE.md", "@agents.md\n@INSTAFY.md\n");
        assert_eq!(code_of(space.path()).await, None);

        // What they import follows every rule, the untracked rule included.
        let space = own_repository();
        seeded(space.path());
        write(
            space.path(),
            "AGENTS.md",
            "# Rules\nRead @notes.md first.\n",
        );
        write(space.path(), "notes.md", "Notes.\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure.message.contains("AGENTS.md brings in @notes.md"),
            "{failure:?}"
        );
        let space = own_repository();
        seeded(space.path());
        write(space.path(), "INSTAFY.md", "@~/.ssh/config\n");
        assert_eq!(code_of(space.path()).await, Some(FailureCode::UnsafeImport));

        // Never a link: a root INSTAFY.md that links to an untracked file.
        let space = own_repository();
        seeded(space.path());
        write(space.path(), "private/instafy.md", "SECRET=1\n");
        link(space.path(), "INSTAFY.md", "private/instafy.md");
        assert_eq!(code_of(space.path()).await, Some(FailureCode::UnsafeImport));

        // Never by name: an untracked AGENTS.md below the root is no seeded file.
        let space = own_repository();
        seeded(space.path());
        write(space.path(), "CLAUDE.md", "@docs/AGENTS.md\n");
        write(space.path(), "docs/AGENTS.md", "Docs rules.\n");
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure
                .message
                .contains("CLAUDE.md brings in @docs/AGENTS.md"),
            "{failure:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tracked_link_that_points_outside_is_refused() {
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "secret.txt", "x");
        let space = seeded_space();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            space.path().join("secret-link"),
        )
        .unwrap();
        std::os::unix::fs::symlink("README.md", space.path().join("readme-link")).unwrap();
        git(space.path(), &["add", "secret-link", "readme-link"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeLink));
        assert!(failure.message.contains("secret-link"), "{failure:?}");
        assert!(!failure.message.contains("readme-link"), "{failure:?}");

        // An untracked link outside is not this check's (git saves none of it).
        let space = seeded_space();
        std::os::unix::fs::symlink(outside.path(), space.path().join("untracked-link")).unwrap();
        assert_eq!(code_of(space.path()).await, None);

        // A dangling tracked link whose words lead out.
        let space = seeded_space();
        std::os::unix::fs::symlink("../../nowhere", space.path().join("dangling")).unwrap();
        git(space.path(), &["add", "dangling"]);
        assert_eq!(code_of(space.path()).await, Some(FailureCode::UnsafeLink));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_preflight_reads_instafy_git_when_both_repositories_exist() {
        // The folder's own .git tracks a .claude file, but the repository the origin saves to,
        // .instafy/.git, does not: the pre-flight reads the latter.
        let space = seeded_space();
        write(space.path(), "nested/.claude/settings.json", "{}");
        git(space.path(), &["add", "nested"]);
        git(space.path(), &["commit", "-q", "-m", "nested"]);
        assert_eq!(
            code_of(space.path()).await,
            Some(FailureCode::ProjectConfig)
        );
        let instafy_git = space.path().join(".instafy/.git");
        std::fs::create_dir_all(space.path().join(".instafy")).unwrap();
        git(
            space.path(),
            &[
                "--git-dir",
                instafy_git.to_str().unwrap(),
                "--work-tree",
                space.path().to_str().unwrap(),
                "init",
                "-q",
                "-b",
                "main",
            ],
        );
        for path in ["CLAUDE.md", "AGENTS.md", "docs/style.md", "README.md"] {
            git(
                space.path(),
                &[
                    "--git-dir",
                    instafy_git.to_str().unwrap(),
                    "--work-tree",
                    space.path().to_str().unwrap(),
                    "add",
                    path,
                ],
            );
        }
        assert_eq!(code_of(space.path()).await, None);
        // And it reads that repository's own tracked files: one tracked there is refused.
        git(
            space.path(),
            &[
                "--git-dir",
                instafy_git.to_str().unwrap(),
                "--work-tree",
                space.path().to_str().unwrap(),
                "add",
                "nested/.claude/settings.json",
            ],
        );
        assert_eq!(
            code_of(space.path()).await,
            Some(FailureCode::ProjectConfig)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_git_command_that_fails_is_preflight_failed() {
        let space = seeded_space();
        // A repository git cannot read.
        std::fs::remove_dir_all(space.path().join(".git")).unwrap();
        std::fs::write(
            space.path().join(".git"),
            "gitdir: /nonexistent/repository\n",
        )
        .unwrap();
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );
    }

    /// A folder with neither `.instafy/.git` nor `.git` is refused before anything is read
    /// (D-A): nothing there could say what a turn changed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_without_a_repository_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path();
        write(folder, "README.md", "# Demo\n");
        let failure = check(folder).await.unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );
        assert_eq!(
            failure.message.lines().next(),
            Some(
                "This space's folder on this computer has no git repository, so Instafy couldn't tell what a turn changes."
            )
        );
        // Whatever it holds.
        write(folder, "app/.claude/agents/x.md", "x");
        assert_eq!(code_of(folder).await, Some(FailureCode::PreflightFailed));
    }

    /// The memory files Instafy seeds, as they are now and as every earlier version was, pass
    /// in a space whose repository tracks them and in one whose repository is the person's own
    /// (D-B), beside an untracked `.env`.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_memory_files_instafy_seeds_pass() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let assets = manifest.join("assets/instafy");
        let mut versions: Vec<(&str, PathBuf)> = ["CLAUDE.md", "AGENTS.md", "INSTAFY.md"]
            .into_iter()
            .map(|name| (name, assets.join(name)))
            .collect();
        for entry in std::fs::read_dir(manifest.join("src/jobs/legacy")).unwrap() {
            let path = entry.unwrap().path();
            let file = path.file_name().unwrap().to_string_lossy().into_owned();
            let name = if file.starts_with("claude-doc-") {
                "CLAUDE.md"
            } else if file.starts_with("agents-doc-") {
                "AGENTS.md"
            } else if file.starts_with("instafy-doc-") {
                "INSTAFY.md"
            } else {
                continue;
            };
            versions.push((name, path));
        }
        assert!(versions.len() > 20, "{versions:?}");
        for tracked in [true, false] {
            let space = own_repository();
            write(space.path(), ".env", "SECRET=1\n");
            for (name, path) in &versions {
                std::fs::copy(path, space.path().join(name)).unwrap();
                if tracked {
                    git(space.path(), &["add", name]);
                }
                assert_eq!(
                    code_of(space.path()).await,
                    None,
                    "{path:?}, tracked: {tracked}"
                );
            }
        }
    }

    /// A memory file reached by several paths, through a link or by names a Mac's folder reads
    /// as the same, is read once, and what it imports is still resolved from each of those paths
    /// (preflight-parser-cost-unbudgeted).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_memory_file_reached_by_several_paths_is_read_once() {
        let space = seeded_space();
        write(
            space.path(),
            "AGENTS.md",
            "@notes/slow.md @notes/SLOW.md @notes/Slow.md @alias.md\n",
        );
        write(space.path(), "notes/slow.md", "See @sibling.md\n");
        write(space.path(), "notes/sibling.md", "Sibling.\n");
        link(space.path(), "alias.md", "notes/slow.md");
        git(space.path(), &["add", "AGENTS.md", "notes", "alias.md"]);
        let folder = Folder::read(
            space.path(),
            tracked_files(space.path(), Repository::Folder)
                .await
                .unwrap(),
        )
        .unwrap();
        // CLAUDE.md, AGENTS.md, notes/slow.md and notes/sibling.md, each once.
        assert_eq!(check_imports(&folder, &AtomicBool::new(false)).unwrap(), 4);

        // Through alias.md, notes/slow.md's `@sibling.md` is the root's, which git does not
        // track.
        write(space.path(), "sibling.md", "Untracked.\n");
        let folder = Folder::read(
            space.path(),
            tracked_files(space.path(), Repository::Folder)
                .await
                .unwrap(),
        )
        .unwrap();
        let failure = check_imports(&folder, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure.message.contains("alias.md brings in @sibling.md"),
            "{failure:?}"
        );
    }

    /// One pre-flight resolves a bounded number of candidates: memory files that give more are
    /// refused as `preflight_failed`, though each is within its own reading budget.
    #[cfg(unix)]
    #[tokio::test]
    async fn memory_files_with_too_many_candidates_are_refused() {
        // Five candidates a word: d0, d0/, d0/a0, d0/a0. and d0/a0.md.
        let words =
            |count: usize| -> String { (0..count).map(|n| format!("@d{n}/a{n}.md ")).collect() };
        let space = seeded_space();
        write(space.path(), "AGENTS.md", &words(3_000));
        git(space.path(), &["add", "AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, None);
        write(
            space.path(),
            "AGENTS.md",
            &words(MAX_IMPORT_CANDIDATES / 5 + 1),
        );
        git(space.path(), &["add", "AGENTS.md"]);
        let failure = check(space.path()).await.unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );
        assert!(
            failure.message.contains("have too many @ imports"),
            "{failure:?}"
        );
    }

    /// The root files Instafy seeds are found once per pre-flight, not again for each import of
    /// an untracked file: a root of thousands of entries and a memory file of a thousand such
    /// imports is refused in moments (preflight-seeded-root-rescan).
    #[cfg(unix)]
    #[tokio::test]
    async fn the_seeded_root_files_are_found_once_per_preflight() {
        let space = own_repository();
        write(space.path(), "INSTAFY.md", "# Instafy\n");
        // They sort before the seeded files' names.
        for n in 0..6_000 {
            std::fs::write(space.path().join(format!(".a{n:05}")), "").unwrap();
        }
        let imports: String = (0..1_000)
            .map(|n| format!("@a{n:05}/../.git/HEAD\n"))
            .collect();
        write(space.path(), "AGENTS.md", &imports);
        let started = std::time::Instant::now();
        let failure = check(space.path()).await.unwrap_err();
        let elapsed = started.elapsed();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        assert!(
            failure
                .message
                .contains("AGENTS.md brings in @a00000/../.git/HEAD"),
            "{failure:?}"
        );
        // Generous for a debug build on a slow machine; finding them for each import took 27 s.
        assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
    }

    /// A tracked path counts for an untracked file only when its own folder entry is that file,
    /// never when it is a link to it (preflight-tracked-fallback-follows-link). On a
    /// case-sensitive folder, a teammate's tracked link `Credentials.json` to the person's
    /// untracked `credentials.json` is read as that same name; here the link's name is made to
    /// read as the file's, which a Mac's own folder never does.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_tracked_link_never_makes_the_file_it_points_at_tracked() {
        let space = seeded_space();
        write(space.path(), "credentials.json", "{}");
        link(space.path(), "credentials-link", "credentials.json");
        std::fs::hard_link(
            space.path().join("credentials.json"),
            space.path().join("credentials-name"),
        )
        .unwrap();
        git(
            space.path(),
            &["add", "credentials-link", "credentials-name"],
        );
        let mut folder = Folder::read(
            space.path(),
            tracked_files(space.path(), Repository::Folder)
                .await
                .unwrap(),
        )
        .unwrap();
        let file = folder.canonical.join("credentials.json");
        let key = name_key("credentials.json");
        folder
            .tracked_by_key
            .insert(key.clone(), vec!["credentials-link".to_string()]);
        assert!(!is_tracked(&folder, &file));
        assert!(matches!(
            resolve_import(&folder, Path::new(""), "credentials.json"),
            ImportTarget::Unsafe
        ));
        // Another name of the same folder entry, as the index may spell it, does count.
        folder
            .tracked_by_key
            .insert(key, vec!["credentials-name".to_string()]);
        assert!(is_tracked(&folder, &file));
    }

    #[cfg(unix)]
    fn named_pipe(path: &Path) {
        let status = std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success(), "mkfifo {path:?}");
    }

    /// A pre-flight that runs past its deadline is refused as `preflight_failed`, and its git
    /// command is stopped: here git waits to open an index that is a named pipe, which no one
    /// writes (preflight-parser-cost-unbudgeted).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_preflight_past_its_deadline_is_refused() {
        assert_eq!(PREFLIGHT_WITHIN, Duration::from_secs(60));
        let space = seeded_space();
        let index = space.path().join(".git/index");
        std::fs::remove_file(&index).unwrap();
        named_pipe(&index);
        let started = std::time::Instant::now();
        let failure = check_within(space.path(), Duration::from_millis(500))
            .await
            .unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );
        assert_eq!(failure.message, TOOK_TOO_LONG);
        // Well before git's own limit of 30 seconds.
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    /// Once the pre-flight has ended (its deadline, or a Stop that dropped it), the work it left
    /// on its blocking thread stops at its next file (preflight-parser-cost-unbudgeted).
    #[cfg(unix)]
    #[tokio::test]
    async fn an_abandoned_preflight_stops_at_its_next_file() {
        let space = seeded_space();
        write(space.path(), "docs/style.md", "See @../.env\n");
        git(space.path(), &["add", "docs/style.md"]);
        write(space.path(), ".env", "SECRET=1\n");
        let entries = tracked_files(space.path(), Repository::Folder)
            .await
            .unwrap();
        let failure =
            check_folder(space.path(), entries.clone(), &AtomicBool::new(false)).unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        let failure =
            check_folder(space.path(), entries.clone(), &AtomicBool::new(true)).unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );

        // The flag is set once what holds it is dropped.
        let folder = Folder::read(space.path(), entries).unwrap();
        let abandoned = Abandoned::default();
        let flag = abandoned.flag();
        let failure = check_imports(&folder, &flag).unwrap_err();
        assert_eq!(failure.code, Some(FailureCode::UnsafeImport), "{failure:?}");
        drop(abandoned);
        let failure = check_imports(&folder, &flag).unwrap_err();
        assert_eq!(
            failure.code,
            Some(FailureCode::PreflightFailed),
            "{failure:?}"
        );
        assert!(failure.message.contains("stopped"), "{failure:?}");
    }
}
