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
//!   whose reply everyone in the space reads.
//! - **`unsafe_link`.** No tracked symbolic link resolves outside the folder.
//!
//! Its git commands read `.instafy/.git`, the repository the origin saves to, with the folder as
//! work tree whenever that exists, otherwise the folder's own `.git`, with hooks and the file
//! monitor off and the allowlisted environment, as the job's own git commands run. A git command
//! that fails refuses the turn as `preflight_failed`. A folder with neither repository has no
//! tracked files: the checks walk the folder instead, and every file it holds counts as one git
//! does not track.
//!
//! Names compare ignoring ASCII case, as macOS folders do: Claude Code opens a tracked
//! `.Claude/settings.json` as `.claude/settings.json`.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::FailureCode;
use super::events::{LaneFailure, redact_tokens};

/// How long one git command of the pre-flight may run.
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How many imports deep the import check follows, as Claude Code follows them.
const MAX_IMPORT_DEPTH: usize = 5;
/// How many files the import check reads at most.
const MAX_IMPORTED_FILES: usize = 512;
/// The largest memory file the import check reads. A larger one cannot be checked.
const MAX_MEMORY_FILE_BYTES: u64 = 1024 * 1024;
/// How many entries the walk of a folder without a repository reads at most.
const MAX_WALKED_ENTRIES: usize = 100_000;
/// How many paths a failure names before it counts the rest.
const MAX_NAMED_PATHS: usize = 50;

/// The memory files Claude Code reads as project instructions.
const MEMORY_FILES: [&str; 3] = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];

/// Which repository the pre-flight reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Repository {
    /// `.instafy/.git`, with the folder as work tree: the repository the origin saves to.
    Instafy,
    /// The folder's own `.git`.
    Folder,
    /// Neither: the folder is walked.
    None,
}

impl Repository {
    fn of(folder: &Path) -> Self {
        if folder.join(".instafy").join(".git").exists() {
            Self::Instafy
        } else if folder.join(".git").exists() {
            Self::Folder
        } else {
            Self::None
        }
    }
}

/// A file the folder holds, as the checks see it: tracked by git, or walked.
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
    /// The tracked files, or every file the walk found when there is no repository.
    entries: Vec<Entry>,
    /// Whether the folder has a repository: without one, no file is tracked.
    tracked: bool,
    /// The tracked paths, and the same in ASCII lower case, for the import check.
    tracked_paths: HashSet<String>,
    tracked_lower: HashMap<String, Vec<String>>,
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
    let repository = Repository::of(folder);
    let listing = match repository {
        Repository::None => None,
        repository => Some(tracked_files(folder, repository).await?),
    };
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || check_folder(&folder, listing))
        .await
        .map_err(|error| {
            failed(format!(
                "Instafy couldn't check this space's folder: {error}"
            ))
        })?
}

fn check_folder(root: &Path, listing: Option<Vec<Entry>>) -> Result<(), LaneFailure> {
    let canonical = std::fs::canonicalize(root).map_err(|error| {
        failed(format!(
            "Instafy couldn't read this space's folder: {error}"
        ))
    })?;
    let tracked = listing.is_some();
    let entries = match listing {
        Some(entries) => entries,
        None => walk(root)?,
    };
    let mut tracked_paths = HashSet::new();
    let mut tracked_lower: HashMap<String, Vec<String>> = HashMap::new();
    if tracked {
        for entry in &entries {
            tracked_paths.insert(entry.path.clone());
            tracked_lower
                .entry(entry.path.to_ascii_lowercase())
                .or_default()
                .push(entry.path.clone());
        }
    }
    let folder = Folder {
        root: root.to_path_buf(),
        canonical,
        entries,
        tracked,
        tracked_paths,
        tracked_lower,
    };
    let root_names = root_names(root)?;
    check_project_config(&folder, &root_names)?;
    // Links first: the import check then reads no tracked file through a link that leads out.
    check_links(&folder)?;
    check_imports(&folder, &root_names)?;
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

/// Every file and link below a folder with no repository, without following links, and
/// without the folders of other repositories.
fn walk(root: &Path) -> Result<Vec<Entry>, LaneFailure> {
    let mut entries = Vec::new();
    let mut pending: VecDeque<PathBuf> = VecDeque::from([PathBuf::new()]);
    let mut seen = 0usize;
    while let Some(relative) = pending.pop_front() {
        let read = std::fs::read_dir(root.join(&relative)).map_err(|error| {
            failed(format!(
                "Instafy couldn't read this space's folder: {error}"
            ))
        })?;
        for entry in read {
            let entry = entry.map_err(|error| {
                failed(format!(
                    "Instafy couldn't read this space's folder: {error}"
                ))
            })?;
            seen += 1;
            if seen > MAX_WALKED_ENTRIES {
                return Err(failed(
                    "This space's folder holds too many files for Instafy to check.",
                ));
            }
            let name = entry.file_name();
            let path = relative.join(&name);
            let file_type = entry.file_type().map_err(|error| {
                failed(format!(
                    "Instafy couldn't read this space's folder: {error}"
                ))
            })?;
            let text = path.to_string_lossy().replace('\\', "/");
            if file_type.is_dir() {
                if name.to_string_lossy().eq_ignore_ascii_case(".git") {
                    continue;
                }
                pending.push_back(path);
            } else {
                entries.push(Entry {
                    path: text,
                    symlink: file_type.is_symlink(),
                });
            }
        }
    }
    Ok(entries)
}

fn is_named(name: &str, wanted: &str) -> bool {
    name.eq_ignore_ascii_case(wanted)
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `project_config`: a `.claude` path anywhere in the tracked (or walked) files, or a `.claude`
/// entry or a `.mcp.json` at the root.
fn check_project_config(folder: &Folder, root_names: &[String]) -> Result<(), LaneFailure> {
    let mut refused = BTreeSet::new();
    for entry in &folder.entries {
        let in_claude = entry
            .path
            .split('/')
            .any(|segment| is_named(segment, ".claude"));
        let root_mcp = !entry.path.contains('/') && is_named(&entry.path, ".mcp.json");
        if in_claude || root_mcp {
            refused.insert(entry.path.clone());
        }
    }
    for name in root_names {
        if is_named(name, ".mcp.json") {
            refused.insert(name.clone());
        } else if is_named(name, ".claude") {
            let files = files_below(&folder.root, name);
            if files.is_empty() {
                refused.insert(format!("{name}/"));
            }
            refused.extend(files);
        }
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
                files.push(path.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    files
}

/// `unsafe_link`: a tracked (or walked) symbolic link that resolves outside the folder.
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
/// a tracked path that differs only in ASCII case and is the same file, as on a case-insensitive
/// folder.
fn is_tracked(folder: &Folder, canonical: &Path) -> bool {
    if !folder.tracked {
        return false;
    }
    let Ok(relative) = canonical.strip_prefix(&folder.canonical) else {
        return false;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    if folder.tracked_paths.contains(&relative) {
        return true;
    }
    folder
        .tracked_lower
        .get(&relative.to_ascii_lowercase())
        .is_some_and(|candidates| {
            candidates.iter().any(|candidate| {
                std::fs::canonicalize(folder.root.join(candidate))
                    .is_ok_and(|resolved| same_file(&resolved, canonical))
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

/// An import that may not load.
struct UnsafeImport {
    file: String,
    import: String,
}

/// `unsafe_import`: the memory files and what they import, followed recursively with a bound.
fn check_imports(folder: &Folder, root_names: &[String]) -> Result<(), LaneFailure> {
    let is_memory_file = |path: &str| {
        MEMORY_FILES
            .iter()
            .any(|memory| is_named(file_name(path), memory))
    };
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    let mut queued: HashSet<String> = HashSet::new();
    for entry in &folder.entries {
        if is_memory_file(&entry.path) && queued.insert(entry.path.clone()) {
            queue.push_back((entry.path.clone(), 0));
        }
    }
    for name in root_names {
        if is_memory_file(name) && queued.insert(name.clone()) {
            queue.push_back((name.clone(), 0));
        }
    }
    let mut refused: Vec<UnsafeImport> = Vec::new();
    let mut read = 0usize;
    while let Some((path, depth)) = queue.pop_front() {
        read += 1;
        if read > MAX_IMPORTED_FILES {
            return Err(failed(
                "This space's CLAUDE.md and AGENTS.md files bring in too many files for Instafy to check.",
            ));
        }
        let absolute = folder.root.join(&path);
        let Ok(metadata) = std::fs::metadata(&absolute) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_MEMORY_FILE_BYTES {
            return Err(failed(format!(
                "{} is too large for Instafy to check what it brings in.",
                redact_tokens(&path)
            )));
        }
        let text = std::fs::read(&absolute).map_err(|error| {
            failed(format!(
                "Instafy couldn't read {}: {error}",
                redact_tokens(&path)
            ))
        })?;
        let text = String::from_utf8_lossy(&text);
        let base = Path::new(&path).parent().unwrap_or(Path::new(""));
        for import in imports_in(&text) {
            match resolve_import(folder, base, &import) {
                ImportTarget::Unsafe => refused.push(UnsafeImport {
                    file: path.clone(),
                    import,
                }),
                ImportTarget::Nothing => {}
                ImportTarget::File(relative) => {
                    if depth + 1 < MAX_IMPORT_DEPTH && queued.insert(relative.clone()) {
                        queue.push_back((relative, depth + 1));
                    }
                }
            }
        }
    }
    if refused.is_empty() {
        return Ok(());
    }
    let shown: BTreeSet<String> = refused
        .iter()
        .map(|unsafe_import| format!("{} brings in @{}", unsafe_import.file, unsafe_import.import))
        .collect();
    Err(LaneFailure::new(
        FailureCode::UnsafeImport,
        format!(
            "These imports bring in files that aren't part of the space: {}.",
            named(&shown)
        ),
    ))
}

enum ImportTarget {
    /// Absolute, from the home folder, outside the folder, or a file git does not track.
    Unsafe,
    /// Nothing loads: the path names no file.
    Nothing,
    /// A tracked file in the folder, relative to it, whose own imports load too.
    File(String),
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
    if !is_tracked(folder, &resolved) {
        return ImportTarget::Unsafe;
    }
    match resolved.strip_prefix(&folder.canonical) {
        Ok(relative) => ImportTarget::File(relative.to_string_lossy().replace('\\', "/")),
        Err(_) => ImportTarget::Unsafe,
    }
}

/// The `@` imports of a memory file: a word that starts with `@` at the start of a line or after
/// white space, outside fenced code blocks and code spans. An escaped space (`\ `) stays in the
/// path. A word whose end is punctuation is read both with and without it, so neither way slips
/// past.
pub(crate) fn imports_in(text: &str) -> Vec<String> {
    let mut imports = Vec::new();
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
        let outside_code = without_code_spans(line);
        let chars: Vec<char> = outside_code.chars().collect();
        let mut index = 0;
        while index < chars.len() {
            let starts_word = index == 0 || chars[index - 1].is_whitespace();
            if chars[index] == '@' && starts_word {
                let mut word = String::new();
                let mut next = index + 1;
                while next < chars.len() {
                    if chars[next] == '\\' && chars.get(next + 1) == Some(&' ') {
                        word.push(' ');
                        next += 2;
                        continue;
                    }
                    if chars[next].is_whitespace() {
                        break;
                    }
                    word.push(chars[next]);
                    next += 1;
                }
                if !word.is_empty() {
                    let stripped = word
                        .trim_end_matches([
                            '.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '"', '\'',
                        ])
                        .to_string();
                    if !stripped.is_empty() && stripped != word {
                        imports.push(stripped);
                    }
                    imports.push(word);
                }
                index = next;
            } else {
                index += 1;
            }
        }
    }
    imports
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
        let imports = imports_in(text);
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

    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_without_a_repository_is_walked() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path();
        write(folder, "README.md", "# Demo\n");
        assert_eq!(code_of(folder).await, None);
        // Every file it holds counts as one git does not track.
        write(folder, "AGENTS.md", "@README.md\n");
        assert_eq!(code_of(folder).await, Some(FailureCode::UnsafeImport));
        std::fs::remove_file(folder.join("AGENTS.md")).unwrap();
        write(folder, "app/.claude/agents/x.md", "x");
        assert_eq!(code_of(folder).await, Some(FailureCode::ProjectConfig));
        std::fs::remove_dir_all(folder.join("app")).unwrap();
        std::os::unix::fs::symlink("/etc", folder.join("etc")).unwrap();
        assert_eq!(code_of(folder).await, Some(FailureCode::UnsafeLink));
    }
}
