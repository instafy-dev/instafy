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
//!   the root whether tracked or not, and every file they import, followed with a bound: no `@`
//!   import outside code spans and code blocks is absolute, starts with `~`, resolves outside the
//!   folder after following links, or resolves to an existing file git does not track. Such a
//!   file exists only on this computer (a `.env`), and its import would put it in front of a turn
//!   whose reply everyone in the space reads. A memory file that is itself a link is an import of
//!   its target. A file's imports are resolved both from the path that brought it in, as written,
//!   and from its own place once links are followed: Claude Code may read either way. The root
//!   `AGENTS.md` and `INSTAFY.md` Instafy seeds may be untracked (D-B): the Desktop scaffold
//!   commits them only into `.instafy/.git`, so a folder whose repository is the person's own
//!   `.git` leaves them out. Every other rule holds for them, and every rule for what they import.
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
//! A memory file's `@` imports are read every way Claude Code may read them (`imports_in`): line
//! by line outside fences and code spans, and as CommonMark parses the file. That reading has a
//! budget for each byte of the file: a file built so that its words start inside one another,
//! whose reading would grow with the square of its size, is refused as `preflight_failed`
//! instead of read in part.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use tokio::process::Command;

use super::FailureCode;
use super::events::{LaneFailure, redact_tokens};
use super::saves::{name_key, same_name};

/// How long one git command of the pre-flight may run.
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How many imports deep the import check follows, as Claude Code follows them.
const MAX_IMPORT_DEPTH: usize = 5;
/// How many files the import check reads at most.
const MAX_IMPORTED_FILES: usize = 512;
/// The largest memory file the import check reads. A larger one cannot be checked.
const MAX_MEMORY_FILE_BYTES: u64 = 1024 * 1024;
/// What reading a memory file's `@` words may cost for each byte of the file: one for each
/// character scanned after an `@` that starts a word, and one for each byte of each reading of
/// it ([`word_readings`]). A file whose words do not overlap costs less than 16: it is read three
/// ways, and each way scans a word at most twice and gives at most three readings of it. Words
/// that each start inside the one before cost up to the square of their stretch of text, so a
/// file of them is refused instead of read (preflight-1).
const READING_COST_PER_BYTE: usize = 16;
/// What reading a memory file's `@` words may cost beyond [`READING_COST_PER_BYTE`], so a short
/// file's few words that overlap are read.
const READING_COST_ALLOWANCE: usize = 64 * 1024;
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
/// Punctuation a word's end may hold that is not part of the path it names, emphasis and
/// strikethrough delimiters included: `~~@~/x~~` is a struck-through `@~/x` to a Markdown lexer
/// that pairs those tildes, where the CommonMark parser leaves them as text.
const TRAILING_PUNCTUATION: [char; 15] = [
    '.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '"', '\'', '*', '_', '~',
];

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
/// with its code and the paths it refused.
pub async fn check(folder: &Path) -> Result<(), LaneFailure> {
    // Without a repository nothing records what a turn changes: no turn could save or say what
    // it changed (D-A).
    let Some(repository) = Repository::of(folder) else {
        return Err(failed(NO_REPOSITORY));
    };
    let entries = tracked_files(folder, repository).await?;
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || check_folder(&folder, entries))
        .await
        .map_err(|error| {
            failed(format!(
                "Instafy couldn't check this space's folder: {error}"
            ))
        })?
}

fn check_folder(root: &Path, entries: Vec<Entry>) -> Result<(), LaneFailure> {
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
    let folder = Folder {
        root: root.to_path_buf(),
        canonical,
        entries,
        root_names: root_names(root)?,
        tracked_paths,
        tracked_by_key,
    };
    check_project_config(&folder)?;
    // Links first: the import check then reads no tracked file through a link that leads out.
    check_links(&folder)?;
    check_imports(&folder)?;
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
fn check_links(folder: &Folder) -> Result<(), LaneFailure> {
    let mut refused = BTreeSet::new();
    for entry in folder.entries.iter().filter(|entry| entry.symlink) {
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

/// Whether the file at `canonical` (resolved, inside the folder) is one git tracks: its path, or
/// a tracked path a Mac's folder reads as the same name ([`name_key`]) that is the same file.
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
                std::fs::canonicalize(folder.root.join(candidate))
                    .is_ok_and(|resolved| same_file(&resolved, canonical))
            })
        })
}

/// Whether `resolved` (canonical, inside the folder) is a root `AGENTS.md` or `INSTAFY.md` that
/// Instafy seeds (D-B): the regular file, never a link, that the folder's root holds under that
/// name. The name an import was written with never decides it.
fn is_seeded_root_file(folder: &Folder, resolved: &Path) -> bool {
    SEEDED_ROOT_FILES.iter().any(|seeded| {
        root_entries_named(folder, seeded).iter().any(|name| {
            let at_root = folder.root.join(name);
            std::fs::symlink_metadata(&at_root).is_ok_and(|metadata| metadata.file_type().is_file())
                && same_file(&at_root, resolved)
        })
    })
}

fn same_file(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(left), Ok(right)) = (std::fs::metadata(left), std::fs::metadata(right)) {
            return left.dev() == right.dev() && left.ino() == right.ino();
        }
    }
    false
}

/// What may not load: an import a memory file brings in, or the target of a memory file that is
/// a link.
enum UnsafeImport {
    Import { file: String, import: String },
    Link { file: String, target: String },
}

impl UnsafeImport {
    fn shown(&self) -> String {
        match self {
            Self::Import { file, import } => format!("{file} brings in @{import}"),
            Self::Link { file, target } => format!("{file} links to {target}"),
        }
    }
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
fn check_imports(folder: &Folder) -> Result<(), LaneFailure> {
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
    // The paths files were reached by, as written: each is read once.
    let mut queued: HashSet<String> = HashSet::new();
    for path in starts {
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
    let mut read = 0usize;
    while let Some(file) = queue.pop_front() {
        read += 1;
        if read > MAX_IMPORTED_FILES {
            return Err(failed(
                "This space's CLAUDE.md and AGENTS.md files bring in too many files for Instafy to check.",
            ));
        }
        let absolute = folder.canonical.join(&file.canonical);
        let Ok(metadata) = std::fs::metadata(&absolute) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
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
        let text = String::from_utf8_lossy(&text);
        // From the path that brought the file in, as written, and from its own place: whichever
        // Claude Code uses, both must be safe.
        let mut bases = vec![parent_of(&file.lexical)];
        let own = parent_of(&file.canonical);
        if own != bases[0] {
            bases.push(own);
        }
        // Words built to start inside one another would take minutes and gigabytes to read
        // every way: the file is refused, never read in part.
        let Some(imports) = imports_in(&text) else {
            return Err(failed(format!(
                "{} has too many @ imports for Instafy to check what it brings in.",
                redact_tokens(&file.lexical)
            )));
        };
        for import in imports {
            for base in &bases {
                match resolve_import(folder, base, &import) {
                    ImportTarget::Unsafe => refused.push(UnsafeImport::Import {
                        file: file.lexical.clone(),
                        import: import.clone(),
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
        return Ok(());
    }
    let shown: BTreeSet<String> = refused.iter().map(UnsafeImport::shown).collect();
    Err(LaneFailure::new(
        FailureCode::UnsafeImport,
        format!(
            "These imports bring in files that aren't part of the space: {}.",
            named(&shown)
        ),
    ))
}

fn parent_of(path: &str) -> &Path {
    Path::new(path).parent().unwrap_or(Path::new(""))
}

enum ImportTarget {
    /// Absolute, from the home folder, outside the folder, or a file git does not track.
    Unsafe,
    /// Nothing loads: the path names no file.
    Nothing,
    /// A file in the folder, whose own imports load too: the path the import names, read as
    /// written, and the file's own, with every link followed (both relative to the folder).
    File { lexical: String, canonical: String },
}

/// Where an `@` import of a memory file in the folder-relative `base` folder leads.
fn resolve_import(folder: &Folder, base: &Path, import: &str) -> ImportTarget {
    if import.starts_with('~') {
        return ImportTarget::Unsafe;
    }
    let written = Path::new(import);
    if written.is_absolute() || written.has_root() {
        return ImportTarget::Unsafe;
    }
    let joined = folder.root.join(base).join(written);
    let Some(lexical) = lexically_inside(&folder.root, &joined) else {
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

/// JavaScript's white space (`\s`) outside U+2000 to U+200A. It holds U+FEFF, and not U+0085.
const JS_SPACES: [char; 14] = [
    '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2028}', '\u{2029}',
    '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
];

/// White space as Claude Code's import pattern reads it: JavaScript's `\s`.
fn is_js_space(character: char) -> bool {
    JS_SPACES.contains(&character) || ('\u{2000}'..='\u{200a}').contains(&character)
}

/// White space as either JavaScript or Rust reads it: a word may start after it.
fn is_any_space(character: char) -> bool {
    character.is_whitespace() || is_js_space(character)
}

/// The `@` imports of a memory file, read every way Claude Code may read them, so none slips past
/// (each listed once):
/// - line by line, outside fenced code blocks and code spans: a word that starts with `@` at the
///   start of a line or after white space;
/// - as CommonMark parses the file, with and without GitHub's tables, strikethrough and task
///   lists: a word that starts with `@` outside code, at the start of a text, after white space,
///   or right after a character a backslash escaped (Claude Code's lexer makes the escape a token
///   of its own, so the text after it starts a new one).
///
/// A lone carriage return ends a line, as it does for CommonMark. Each word counts in every
/// reading [`word_readings`] gives it, with and without punctuation at its end.
///
/// `None` when reading the file's words would cost more than its budget
/// ([`READING_COST_PER_BYTE`]), as only words built to start inside one another do.
pub(crate) fn imports_in(text: &str) -> Option<Vec<String>> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut imports = Imports::of(&text);
    line_imports(&text, &mut imports)?;
    let extensions =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for options in [Options::empty(), extensions] {
        commonmark_imports(&text, options, &mut imports)?;
    }
    Some(imports.found)
}

/// What [`imports_in`] reads a memory file's `@` words into: the imports found, each once in the
/// order first found, and what reading the rest of the file may still cost.
struct Imports {
    found: Vec<String>,
    seen: HashSet<String>,
    budget: usize,
}

impl Imports {
    /// Nothing found yet in `text`, and its whole budget left.
    fn of(text: &str) -> Self {
        Self {
            found: Vec::new(),
            seen: HashSet::new(),
            budget: text
                .len()
                .saturating_mul(READING_COST_PER_BYTE)
                .saturating_add(READING_COST_ALLOWANCE),
        }
    }

    /// Spends `cost` of the budget: `None`, with nothing left, once it is spent.
    fn spend(&mut self, cost: usize) -> Option<()> {
        match self.budget.checked_sub(cost) {
            Some(left) => {
                self.budget = left;
                Some(())
            }
            None => {
                self.budget = 0;
                None
            }
        }
    }

    fn push(&mut self, import: String) {
        if !self.seen.contains(&import) {
            self.seen.insert(import.clone());
            self.found.push(import);
        }
    }
}

/// The `@` words of `text` read line by line, outside fenced code blocks and code spans.
fn line_imports(text: &str, imports: &mut Imports) -> Option<()> {
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        // A fence is indented by three spaces at most; a deeper one is a code line's text.
        let indent = line.len() - line.trim_start_matches(' ').len();
        let trimmed = if indent <= 3 { &line[indent..] } else { "" };
        let fence_run = |marker: char| trimmed.chars().take_while(|ch| *ch == marker).count();
        match fence {
            Some((marker, length)) => {
                if fence_run(marker) >= length
                    && trimmed[fence_run(marker) * marker.len_utf8()..]
                        .trim()
                        .is_empty()
                {
                    fence = None;
                }
                continue;
            }
            None => {
                let ticks = fence_run('`');
                let tildes = fence_run('~');
                if ticks >= 3 {
                    fence = Some(('`', ticks));
                    continue;
                }
                if tildes >= 3 {
                    fence = Some(('~', tildes));
                    continue;
                }
            }
        }
        let outside_code: Vec<char> = without_code_spans(line).chars().collect();
        words_in(&outside_code, &[], imports)?;
    }
    Some(())
}

/// The `@` words of the text of `text` as CommonMark parses it with `options`, outside code spans
/// and code blocks. Texts that follow one another are read as one, as Claude Code's lexer joins
/// them (the parser splits a text at a delimiter it then leaves as text, such as the `~` of
/// `@~/x` within strikethrough), and a word may also start where each of them begins.
fn commonmark_imports(text: &str, options: Options, imports: &mut Imports) -> Option<()> {
    let mut code_blocks = 0usize;
    let mut run: Vec<char> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    for (event, range) in Parser::new_ext(text, options).into_offset_iter() {
        match event {
            Event::Text(part) if code_blocks == 0 => {
                starts.push(run.len());
                // A text that starts with a character a backslash escaped: the escape is a token
                // of its own, so a word may also start right after that character.
                if range.start > 0 && text.as_bytes()[range.start - 1] == b'\\' {
                    starts.push(run.len() + 1);
                }
                run.extend(part.chars());
                continue;
            }
            Event::Start(Tag::CodeBlock(_)) => code_blocks += 1,
            Event::End(TagEnd::CodeBlock) => code_blocks = code_blocks.saturating_sub(1),
            _ => {}
        }
        words_in(&run, &starts, imports)?;
        run.clear();
        starts.clear();
    }
    words_in(&run, &starts, imports)
}

/// The `@` words of `run`, a stretch of text in which a word starts at its start, after white
/// space, and at each of `starts` (in order). A word ends at white space as JavaScript reads it,
/// which is Claude Code's reading (U+FEFF ends a word), and at white space as either reads it. A
/// word that only Rust's white space starts (after U+0085, where Claude Code's pattern starts
/// none) ends only the second way: read on to JavaScript's white space, each such word would run
/// past the next, which no reading of words does.
fn words_in(run: &[char], starts: &[usize], imports: &mut Imports) -> Option<()> {
    for (index, character) in run.iter().enumerate() {
        if *character != '@' {
            continue;
        }
        let after_space =
            index == 0 || is_js_space(run[index - 1]) || starts.binary_search(&index).is_ok();
        let after_rust_space = index > 0 && run[index - 1].is_whitespace();
        let ends: &[fn(char) -> bool] = if after_space {
            &[is_js_space, is_any_space]
        } else if after_rust_space {
            &[is_any_space]
        } else {
            continue;
        };
        for word in word_readings(&run[index + 1..], ends, imports)? {
            let stripped = word.trim_end_matches(TRAILING_PUNCTUATION);
            if !stripped.is_empty() && stripped != word {
                imports.push(stripped.to_string());
            }
            imports.push(word);
        }
    }
    Some(())
}

/// The readings of the word after an `@`, each up to white space as one of `ends` reads it, with
/// an escaped space (`\ `) read as a space: as written, and cut at the first backslash that
/// escapes no space, where Claude Code's pattern ends a path. Empty readings are left out. Each
/// character scanned and each byte of a reading is spent from the budget of `imports`: `None`
/// once it is spent.
fn word_readings(
    rest: &[char],
    ends: &[fn(char) -> bool],
    imports: &mut Imports,
) -> Option<Vec<String>> {
    let mut readings: Vec<String> = Vec::new();
    for ends_word in ends {
        let mut word = String::new();
        let mut cut: Option<usize> = None;
        let mut next = 0;
        while next < rest.len() {
            imports.spend(1)?;
            let character = rest[next];
            if character == '\\' && rest.get(next + 1) == Some(&' ') {
                word.push(' ');
                next += 2;
                continue;
            }
            if ends_word(character) {
                break;
            }
            if character == '\\' && cut.is_none() {
                cut = Some(word.len());
            }
            word.push(character);
            next += 1;
        }
        let cut = cut.map(|at| word[..at].to_string());
        for reading in [Some(word), cut].into_iter().flatten() {
            if !reading.is_empty() && !readings.contains(&reading) {
                imports.spend(reading.len())?;
                readings.push(reading);
            }
        }
    }
    Some(readings)
}

/// `line` with its code spans (text between two runs of the same number of backticks) blanked.
fn without_code_spans(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '`' {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        let run = chars[index..].iter().take_while(|ch| **ch == '`').count();
        // The closing run of the same length, if any.
        let mut search = index + run;
        let mut close = None;
        while search < chars.len() {
            if chars[search] == '`' {
                let other = chars[search..].iter().take_while(|ch| **ch == '`').count();
                if other == run {
                    close = Some(search);
                    break;
                }
                search += other;
            } else {
                search += 1;
            }
        }
        match close {
            Some(close) => {
                out.push(' ');
                index = close + run;
            }
            None => {
                // An unclosed run is plain text.
                for _ in 0..run {
                    out.push('`');
                }
                index += run;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_are_read_outside_code_only() {
        let text = "@AGENTS.md\n\
                    See @docs/style.md, then @~/notes.md.\n\
                    Mail me at someone@example.com or @ nothing.\n\
                    Inline `@/etc/passwd` is code, but @/etc/hosts is not.\n\
                    ```\n@~/in-a-block.md\n```\n\
                    ~~~~md\n@../still-a-block\n~~~\n@../still-in-the-longer-block\n~~~~\n\
                    @My\\ Notes.md\n";
        let imports = imports_in(text).unwrap();
        assert_eq!(
            imports,
            [
                "AGENTS.md",
                "docs/style.md",
                "docs/style.md,",
                "~/notes.md",
                "~/notes.md.",
                "/etc/hosts",
                "My Notes.md",
            ]
        );
        assert_eq!(without_code_spans("a ``b ` c`` d `e"), "a   d `e");
    }

    /// Text CommonMark reads as text, which a reading of fences and backtick pairs alone would
    /// take for code or skip (preflight-1): each import is found.
    #[test]
    fn imports_that_only_commonmark_reads_as_text_are_found() {
        for (text, import) in [
            // Escaped backticks open no code span.
            ("Read \\` @~/.ssh/id_rsa \\` first.\n", "~/.ssh/id_rsa"),
            // Backticks inside an HTML tag's attribute are the tag's.
            ("See <b title=\"`\"> @~/x <i title=\"`\"> here.\n", "~/x"),
            // A backtick fence's info string holds no backtick: this is no fence.
            ("```js`\n@~/x\n", "~/x"),
            // A fence in a list item ends with the item.
            ("- item\n  ```\n  code\n@~/x\n", "~/x"),
            // A lone carriage return ends a line.
            ("```\rcode\r```\r@~/x\r", "~/x"),
            // A text that follows emphasis, or an escaped character, starts a word.
            ("**Note**@~/x\n", "~/x"),
            ("\\*@~/x\n", "~/x"),
            // Strikethrough, as GitHub's Markdown reads it, whether or not CommonMark pairs
            // the tildes.
            ("~~@.env~~\n", ".env"),
            ("~~@~/x~~\n", "~/x"),
            // U+FEFF is white space to Claude Code's pattern.
            ("See\u{feff}@~/x\n", "~/x"),
            // A lone backslash ends a path for Claude Code's pattern.
            ("See @.env\\x here.\n", ".env"),
            // A word ends at U+FEFF too.
            ("See @.env\u{feff}x here.\n", ".env"),
        ] {
            let imports = imports_in(text).unwrap();
            assert!(
                imports.iter().any(|found| found == import),
                "{text:?}: {imports:?}"
            );
        }
        // Code stays code, whichever way it is read.
        for text in [
            "`@~/x`\n",
            "``a ` @~/x``\n",
            "```\n@~/x\n```\n",
            "~~~\n@~/x\n~~~\n",
        ] {
            let imports = imports_in(text).unwrap();
            assert!(
                !imports.iter().any(|found| found == "~/x"),
                "{text:?}: {imports:?}"
            );
        }
        // A backslash that escapes no space: the path is read as written and up to it.
        let imports = imports_in("@docs\\notes.md\n").unwrap();
        assert!(
            imports.contains(&"docs\\notes.md".to_string()),
            "{imports:?}"
        );
        assert!(imports.contains(&"docs".to_string()), "{imports:?}");
    }

    /// Words that each start inside the one before, after an escaped character, an unmatched
    /// `[` or an entity, are refused at once: reading every one of them every way would take a
    /// file as large as the check reads minutes and gigabytes (preflight-1). A word that only
    /// U+0085 starts ends at the next U+0085, so a file of those is read, and so is an ordinary
    /// file as large, to its end.
    #[test]
    fn words_that_start_inside_one_another_are_refused_at_once() {
        let size = MAX_MEMORY_FILE_BYTES as usize;
        // Generous for a debug build on a slow machine; reading them all took hours.
        let bound = Duration::from_secs(20);
        for unit in ["\\@", "[@", "&amp;@"] {
            let text = unit.repeat(size / unit.len());
            let started = std::time::Instant::now();
            assert_eq!(imports_in(&text), None, "{unit:?}");
            assert!(
                started.elapsed() < bound,
                "{unit:?}: {:?}",
                started.elapsed()
            );
        }

        // The first word starts the line and reads on as Claude Code's pattern reads it; each
        // word after a U+0085 ends at the next one.
        let text = "@a\u{85}".repeat(size / "@a\u{85}".len());
        let started = std::time::Instant::now();
        let imports = imports_in(&text).unwrap();
        assert!(started.elapsed() < bound, "{:?}", started.elapsed());
        assert_eq!(imports.len(), 2);
        assert!(imports[0] == text[1..] && imports[1] == "a");
        let imports = imports_in("x\u{85}@.env\u{85}y @a\u{85}b\n").unwrap();
        assert_eq!(imports, [".env", "a\u{85}b", "a"]);

        // An ordinary file as large as the check reads is read to its end.
        let line = "See @docs/a.md, then @b.md.\n";
        let mut text = line.repeat(size / line.len() - 1);
        text.push_str("Last, @c.md\n");
        assert!(text.len() <= size);
        let started = std::time::Instant::now();
        let imports = imports_in(&text).unwrap();
        assert!(started.elapsed() < bound, "{:?}", started.elapsed());
        assert_eq!(
            imports,
            ["docs/a.md", "docs/a.md,", "b.md", "b.md.", "c.md"]
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

        // An import inside code, or of a file that is not there, loads nothing.
        let space = seeded_space();
        write(
            space.path(),
            "AGENTS.md",
            "`@~/.ssh/config`\n```\n@/etc/hosts\n```\n@docs/missing.md\n",
        );
        git(space.path(), &["add", "AGENTS.md"]);
        assert_eq!(code_of(space.path()).await, None);
    }

    /// Each way of writing an import that only CommonMark, or Claude Code's own pattern, reads as
    /// one is refused end to end when it brings in an untracked `.env` (preflight-1).
    #[cfg(unix)]
    #[tokio::test]
    async fn an_import_hidden_from_a_line_reading_is_still_refused() {
        for text in [
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
            write(space.path(), ".env", "SECRET=1\n");
            assert_eq!(
                code_of(space.path()).await,
                Some(FailureCode::UnsafeImport),
                "{text:?}"
            );
        }
        // In a code span it loads nothing.
        let space = seeded_space();
        write(space.path(), "AGENTS.md", "Never `@.env`.\n");
        git(space.path(), &["add", "AGENTS.md"]);
        write(space.path(), ".env", "SECRET=1\n");
        assert_eq!(code_of(space.path()).await, None);
    }

    /// A tracked memory file whose words start inside one another is refused as
    /// `preflight_failed` at once, by its name, wherever it is (preflight-1). An ordinary memory
    /// file as large as the check reads is read to its end.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_memory_file_too_costly_to_read_is_refused() {
        let space = seeded_space();
        write(space.path(), "docs/CLAUDE.md", &"\\@".repeat(300_000));
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
}
