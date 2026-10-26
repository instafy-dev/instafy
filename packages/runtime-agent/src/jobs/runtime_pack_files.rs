//! The files each space gets for the skill packs installed with the runtime
//! ([`crate::skill_packs`]).
//!
//! A pack itself (its scripts, references and templates) stays in the runtime's packs folder. A
//! space gets `.agents/skills/<pack>/SKILL.md` (the pack's skill with a short note on where the
//! rest is) and, for a pack with a command, a small launcher at the path the skill names
//! (`.agents/skills/<pack>/<space_path>`). These files are the runtime's, not the space's:
//!
//! - They are never committed. Before writing them, the runtime lists them in a managed block of
//!   the `info/exclude` file of the git folder the checkout uses: `.instafy/.git` in a hosted
//!   git-canonical checkout, otherwise the repository `git rev-parse` finds. So no status, save
//!   or turn-end upload sees them. A folder without git just gets the files.
//! - The runtime writes a path only while it owns it: the file is missing, or its content's
//!   sha256 is the one the block recorded when the runtime last wrote it, or it is a `SKILL.md`
//!   whose [`SKILL_MARKER_PREFIX`] line still names the sha256 of the rest of the file (so an
//!   unchanged copy is upgraded in a folder without git too), or it is a launcher that still
//!   carries [`LAUNCHER_MARKER`] on its second line. A file someone edited, a full copy
//!   of the pack imported with `/skills import`, or a path the repository tracks is left alone
//!   (and drops out of the block, so its changes are saved like any other work).
//! - Writes never follow a symlink ([`WorkspaceDir`]).
//! - A pack that is no longer installed, or whose scripts need a Node.js that is not on PATH,
//!   takes its unchanged files with it.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use origin_http_server::workspace_fs::{WorkspaceDir, WorkspaceEntryKind};
use sha2::{Digest, Sha256};

use crate::skill_packs::{InstalledPack, NodeVersion};

const SPACE_NOTE_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/skill-pack-space/space-note.md"
));
const LAUNCHER_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/skill-pack-space/launcher.mjs"
));
/// The second line of every launcher the runtime writes.
pub(crate) const LAUNCHER_MARKER: &str = "// instafy:managed-launcher";
/// The line the runtime writes after the space note of every pack `SKILL.md`, followed by the
/// sha256 of the file without this line and [`SKILL_MARKER_SUFFIX`]: a copy nobody changed proves
/// itself, with or without git.
pub(crate) const SKILL_MARKER_PREFIX: &str = "<!-- instafy:managed-skill sha256:";
const SKILL_MARKER_SUFFIX: &str = " -->";
/// The largest per-space SKILL.md the runtime writes (the project memory snapshot cuts a skill
/// longer than this).
pub(crate) const MAX_SPACE_SKILL_BYTES: usize = 12_000;
pub(crate) const SKILLS_ROOT: &str = ".agents/skills";
const BLOCK_BEGIN: &str =
    "# BEGIN instafy runtime skill packs (written by the runtime; do not edit)";
const BLOCK_END: &str = "# END instafy runtime skill packs";
const HASH_PREFIX: &str = "# sha256 ";

/// One file a space should have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpaceFile {
    /// Workspace-relative, `/`-separated.
    pub path: String,
    pub content: Vec<u8>,
    pub launcher: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether `pack`'s scripts can run with `node` (a pack that names no Node.js version can).
pub(crate) fn pack_runs_with(pack: &InstalledPack, node: Option<NodeVersion>) -> bool {
    match &pack.node {
        None => true,
        Some(requirement) => node.is_some_and(|version| requirement.allows(version)),
    }
}

/// The pack's skill with the space note after its frontmatter, or `None` when it cannot be read
/// or the result is over [`MAX_SPACE_SKILL_BYTES`].
pub(crate) fn space_skill(pack: &InstalledPack) -> Option<String> {
    let skill = std::fs::read_to_string(pack.dir.join(&pack.skill)).ok()?;
    let launcher = pack
        .cli
        .as_ref()
        .map(|cli| format!(" and its launcher `{}`", cli.space_path))
        .unwrap_or_default();
    let note = SPACE_NOTE_TEMPLATE
        .replace("{{name}}", &pack.name)
        .replace("{{launcher}}", &launcher);
    let note = note.trim_end();
    let assemble = |note: &str| match frontmatter_end(&skill) {
        Some(end) => format!("{}\n{note}\n{}", &skill[..end], &skill[end..]),
        None => format!("{note}\n\n{skill}"),
    };
    let unmarked = assemble(note);
    let marker = format!(
        "{SKILL_MARKER_PREFIX}{}{SKILL_MARKER_SUFFIX}",
        sha256_hex(unmarked.as_bytes())
    );
    let body = assemble(&format!("{note}\n{marker}"));
    (body.len() <= MAX_SPACE_SKILL_BYTES).then_some(body)
}

/// Whether `bytes` is a pack `SKILL.md` the runtime wrote and nobody changed since: its marker
/// line names the sha256 of the file without that line.
fn has_intact_skill_marker(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix(SKILL_MARKER_PREFIX) {
            let Some(hash) = rest
                .strip_suffix('\n')
                .and_then(|rest| rest.strip_suffix(SKILL_MARKER_SUFFIX))
            else {
                return false;
            };
            let unmarked = format!("{}{}", &text[..offset], &text[offset + line.len()..]);
            return sha256_hex(unmarked.as_bytes()) == hash;
        }
        offset += line.len();
    }
    false
}

/// The byte offset just after a leading `---` frontmatter block.
fn frontmatter_end(text: &str) -> Option<usize> {
    let rest = text.strip_prefix("---\n")?;
    let mut offset = 4;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end() == "---" {
            return Some(offset);
        }
    }
    None
}

/// The launcher for a pack command, its values written as JSON strings.
pub(crate) fn launcher(name: &str, entry: &str) -> String {
    let quote = |value: &str| serde_json::to_string(value).expect("a string serializes");
    LAUNCHER_TEMPLATE
        .replace("{{name}}", &quote(name))
        .replace("{{entry}}", &quote(entry))
}

/// Every file the installed, runnable packs give a space.
pub(crate) fn space_files(packs: &[InstalledPack], node: Option<NodeVersion>) -> Vec<SpaceFile> {
    let mut files = Vec::new();
    for pack in packs {
        if !pack_runs_with(pack, node) {
            tracing::warn!(pack = %pack.name, "skill pack skipped: no matching node on PATH");
            continue;
        }
        let Some(skill) = space_skill(pack) else {
            tracing::warn!(pack = %pack.name, "skill pack skipped: its SKILL.md is missing or too long for a space");
            continue;
        };
        let folder = format!("{SKILLS_ROOT}/{}", pack.name);
        files.push(SpaceFile {
            path: format!("{folder}/SKILL.md"),
            content: skill.into_bytes(),
            launcher: false,
        });
        if let Some(cli) = &pack.cli {
            files.push(SpaceFile {
                path: format!("{folder}/{}", cli.space_path),
                content: launcher(&pack.name, &cli.entry).into_bytes(),
                launcher: true,
            });
        }
    }
    files
}

/// A git folder the workspace is checked out from, and how to address it.
struct GitLink {
    /// Arguments that put git on this repository with the workspace as the work tree.
    args: Vec<OsString>,
    /// The `info/exclude` file.
    exclude: PathBuf,
    /// The workspace's path inside the work tree (`""` at its top, else ending in `/`).
    prefix: String,
}

fn git(workspace_dir: &Path, link_args: &[OsString], args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .current_dir(workspace_dir)
        .args(link_args)
        .args(args)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn git_text(workspace_dir: &Path, link_args: &[OsString], args: &[&str]) -> Option<String> {
    let stdout = git(workspace_dir, link_args, args)?;
    Some(
        String::from_utf8_lossy(&stdout)
            .trim_end_matches('\n')
            .to_string(),
    )
}

/// The git folders whose status would list the workspace's files: a hosted checkout's
/// `.instafy/.git`, and the repository plain `git` finds from the workspace.
fn git_links(workspace_dir: &Path) -> Vec<GitLink> {
    let mut links = Vec::new();
    let canonical = workspace_dir.join(".instafy").join(".git");
    if canonical.is_dir() {
        links.push(GitLink {
            args: vec![
                "--git-dir".into(),
                canonical.clone().into_os_string(),
                "--work-tree".into(),
                workspace_dir.as_os_str().to_os_string(),
            ],
            exclude: canonical.join("info").join("exclude"),
            prefix: String::new(),
        });
    }
    let plain: Vec<OsString> = Vec::new();
    let inside = git_text(
        workspace_dir,
        &plain,
        &["rev-parse", "--is-inside-work-tree"],
    );
    if inside.as_deref() == Some("true")
        && let Some(exclude) = git_text(
            workspace_dir,
            &plain,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/exclude",
            ],
        )
    {
        let exclude = PathBuf::from(exclude);
        let exclude = if exclude.is_absolute() {
            exclude
        } else {
            workspace_dir.join(exclude)
        };
        let prefix =
            git_text(workspace_dir, &plain, &["rev-parse", "--show-prefix"]).unwrap_or_default();
        if !links.iter().any(|link| same_file(&link.exclude, &exclude)) {
            links.push(GitLink {
                args: plain,
                exclude,
                prefix,
            });
        }
    }
    links
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (
        a.parent().and_then(|p| p.canonicalize().ok()),
        b.parent().and_then(|p| p.canonicalize().ok()),
    ) {
        (Some(a_dir), Some(b_dir)) => a_dir == b_dir && a.file_name() == b.file_name(),
        _ => a == b,
    }
}

/// The paths any of `links` tracks among `paths`.
fn tracked(workspace_dir: &Path, links: &[GitLink], paths: &[&str]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    if paths.is_empty() {
        return found;
    }
    for link in links {
        let mut args = vec!["ls-files", "-z", "--"];
        args.extend(paths.iter().copied());
        let Some(stdout) = git(workspace_dir, &link.args, &args) else {
            continue;
        };
        for record in stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            found.insert(String::from_utf8_lossy(record).to_string());
        }
    }
    found
}

/// Workspace-relative path to sha256, as the managed block records it.
type Recorded = BTreeMap<String, String>;

fn parse_block(text: &str, prefix: &str) -> Recorded {
    let mut recorded = Recorded::new();
    let mut inside = false;
    let mut hash: Option<String> = None;
    for line in text.lines() {
        if line == BLOCK_BEGIN {
            inside = true;
        } else if line == BLOCK_END {
            inside = false;
        } else if inside {
            if let Some(value) = line.strip_prefix(HASH_PREFIX) {
                hash = Some(value.trim().to_string());
            } else if let Some(pattern) = line.strip_prefix('/')
                && let Some(path) = pattern.strip_prefix(prefix)
                && let Some(hash) = hash.take()
            {
                recorded.insert(path.to_string(), hash);
            }
        }
    }
    recorded
}

/// `text` without any managed block, then `entries` as a new block (none when empty).
fn render_exclude(text: &str, entries: &Recorded, prefix: &str) -> String {
    let mut kept = String::new();
    let mut inside = false;
    for line in text.lines() {
        if line == BLOCK_BEGIN {
            inside = true;
        } else if line == BLOCK_END {
            inside = false;
        } else if !inside {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    if entries.is_empty() {
        return kept;
    }
    if !kept.is_empty() && !kept.ends_with("\n\n") {
        kept.push('\n');
    }
    kept.push_str(BLOCK_BEGIN);
    kept.push('\n');
    for (path, hash) in entries {
        kept.push_str(&format!("{HASH_PREFIX}{hash}\n/{prefix}{path}\n"));
    }
    kept.push_str(BLOCK_END);
    kept.push('\n');
    kept
}

/// The workspace-relative form of `path` when it is inside the workspace.
fn inside_workspace(workspace_dir: &Path, path: &Path) -> Option<String> {
    let relative = path
        .strip_prefix(workspace_dir)
        .ok()
        .map(Path::to_path_buf)
        .or_else(|| {
            let canonical = workspace_dir.canonicalize().ok()?;
            path.strip_prefix(&canonical).ok().map(Path::to_path_buf)
        })?;
    let text = relative.to_str()?.replace('\\', "/");
    (!text.is_empty() && !text.split('/').any(|part| part == "..")).then_some(text)
}

fn read_exclude(workspace: Option<&WorkspaceDir>, workspace_dir: &Path, exclude: &Path) -> String {
    let mut text = String::new();
    match (workspace, inside_workspace(workspace_dir, exclude)) {
        (Some(workspace), Some(relative)) => {
            if let Ok(mut file) = workspace.open_file(&relative) {
                let _ = file.read_to_string(&mut text);
            }
        }
        _ => {
            if std::fs::symlink_metadata(exclude).is_ok_and(|metadata| metadata.is_file()) {
                text = std::fs::read_to_string(exclude).unwrap_or_default();
            }
        }
    }
    text
}

fn write_exclude(
    workspace: &WorkspaceDir,
    workspace_dir: &Path,
    link: &GitLink,
    entries: &Recorded,
) -> std::io::Result<()> {
    let current = read_exclude(Some(workspace), workspace_dir, &link.exclude);
    let next = render_exclude(&current, entries, &link.prefix);
    if next == current {
        return Ok(());
    }
    match inside_workspace(workspace_dir, &link.exclude) {
        Some(relative) => workspace
            .replace_file(&relative, &mut next.as_bytes(), false)
            .map(|_| ()),
        None => {
            // A repository outside the workspace (a parent repository, a worktree's common folder).
            if std::fs::symlink_metadata(&link.exclude).is_ok_and(|metadata| !metadata.is_file()) {
                return Err(std::io::Error::other("info/exclude is not a regular file"));
            }
            if let Some(parent) = link.exclude.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temporary = link
                .exclude
                .with_extension(format!("instafy-{}", uuid::Uuid::new_v4().simple()));
            std::fs::write(&temporary, next)?;
            std::fs::rename(&temporary, &link.exclude)
        }
    }
}

enum Current {
    Missing,
    File(Vec<u8>),
    /// A folder, a symlink or anything else the runtime does not write over.
    Other,
}

fn current(workspace: &WorkspaceDir, path: &str) -> Current {
    match workspace.entry_kind(path) {
        Ok(WorkspaceEntryKind::File) => {
            let mut bytes = Vec::new();
            match workspace
                .open_file(path)
                .and_then(|mut file| file.read_to_end(&mut bytes))
            {
                Ok(_) => Current::File(bytes),
                Err(_) => Current::Other,
            }
        }
        Ok(WorkspaceEntryKind::Directory) => Current::Other,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Current::Missing,
        Err(_) => Current::Other,
    }
}

fn has_launcher_marker(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes).lines().nth(1) == Some(LAUNCHER_MARKER)
}

/// Brings the space's copies of the runtime's skill packs up to date (see the module docs).
pub(crate) fn keep_current(
    workspace_dir: &Path,
    packs: &[InstalledPack],
    node: Option<NodeVersion>,
) {
    let wanted = space_files(packs, node);
    let links = git_links(workspace_dir);
    let Ok(workspace) = WorkspaceDir::open(workspace_dir) else {
        return;
    };
    let recorded = links
        .first()
        .map(|link| {
            parse_block(
                &read_exclude(Some(&workspace), workspace_dir, &link.exclude),
                &link.prefix,
            )
        })
        .unwrap_or_default();
    if wanted.is_empty() && recorded.is_empty() {
        return;
    }
    let wanted_paths: Vec<&str> = wanted.iter().map(|file| file.path.as_str()).collect();
    let mut all_paths: Vec<&str> = wanted_paths.clone();
    all_paths.extend(recorded.keys().map(String::as_str));
    let tracked = tracked(workspace_dir, &links, &all_paths);

    // The files this runtime owns and will keep, with the hash each will have.
    let mut owned = Recorded::new();
    let mut writes = Vec::new();
    for file in &wanted {
        if tracked.contains(&file.path) {
            continue;
        }
        let ours = match current(&workspace, &file.path) {
            Current::Missing => true,
            Current::File(bytes) => {
                bytes == file.content
                    || recorded.get(&file.path) == Some(&sha256_hex(&bytes))
                    || (file.launcher && has_launcher_marker(&bytes))
                    || (!file.launcher && has_intact_skill_marker(&bytes))
            }
            Current::Other => false,
        };
        if !ours {
            continue;
        }
        owned.insert(file.path.clone(), sha256_hex(&file.content));
        writes.push(file);
    }
    // Recorded files no pack wants any more, still as the runtime wrote them.
    let removals: Vec<(&String, &String)> = recorded
        .iter()
        .filter(|(path, _)| !wanted_paths.contains(&path.as_str()) && !tracked.contains(*path))
        .collect();

    // Exclude everything about to be written or removed before touching a file, so no status run
    // in between sees it.
    let mut during = owned.clone();
    for (path, hash) in &removals {
        during.insert((*path).clone(), (*hash).clone());
    }
    for link in &links {
        if let Err(error) = write_exclude(&workspace, workspace_dir, link, &during) {
            tracing::warn!(%error, "could not record the runtime's skill pack files; not writing them");
            return;
        }
    }

    for file in writes {
        if matches!(current(&workspace, &file.path), Current::File(ref bytes) if *bytes == file.content)
        {
            continue;
        }
        if let Err(error) =
            workspace.replace_file(&file.path, &mut file.content.as_slice(), file.launcher)
        {
            tracing::warn!(path = %file.path, %error, "could not write a skill pack file");
            owned.remove(&file.path);
        }
    }
    for (path, hash) in removals {
        if let Current::File(bytes) = current(&workspace, path)
            && sha256_hex(&bytes) == *hash
            && workspace.remove_file(path).is_ok()
        {
            remove_empty_parents(&workspace, path);
        }
    }

    if during != owned {
        for link in &links {
            let _ = write_exclude(&workspace, workspace_dir, link, &owned);
        }
    }
}

/// Removes the folders above `path`, up to the skills root, that are now empty.
fn remove_empty_parents(workspace: &WorkspaceDir, path: &str) {
    let mut folder = path;
    while let Some((parent, _)) = folder.rsplit_once('/') {
        if parent == SKILLS_ROOT || !parent.starts_with(&format!("{SKILLS_ROOT}/")) {
            return;
        }
        match workspace.list(Some(parent)) {
            Ok(entries) if entries.is_empty() => {
                if workspace.remove(parent).is_err() {
                    return;
                }
            }
            _ => return,
        }
        folder = parent;
    }
}

/// Whether every file in the skill folder `skill_dir` (workspace-relative) is one the runtime
/// wrote and nobody changed since (by its recorded hash, or by its own marker in a folder without
/// git): an import may then write over it as if it were empty.
pub(crate) fn is_runtime_provided_skill_dir(workspace_dir: &Path, skill_dir: &str) -> bool {
    let Ok(workspace) = WorkspaceDir::open(workspace_dir) else {
        return false;
    };
    let recorded = git_links(workspace_dir)
        .into_iter()
        .next()
        .map(|link| {
            parse_block(
                &read_exclude(Some(&workspace), workspace_dir, &link.exclude),
                &link.prefix,
            )
        })
        .unwrap_or_default();
    let mut files = Vec::new();
    if !collect_files(&workspace, skill_dir, &mut files) || files.is_empty() {
        return false;
    }
    files.iter().all(|path| {
        matches!(current(&workspace, path), Current::File(bytes)
            if recorded.get(path) == Some(&sha256_hex(&bytes))
                || has_intact_skill_marker(&bytes)
                || has_launcher_marker(&bytes))
    })
}

fn collect_files(workspace: &WorkspaceDir, folder: &str, files: &mut Vec<String>) -> bool {
    let Ok(entries) = workspace.list(Some(folder)) else {
        return false;
    };
    for entry in entries {
        let Some(name) = entry.name.to_str() else {
            return false;
        };
        let path = format!("{folder}/{name}");
        match entry.kind {
            WorkspaceEntryKind::File => files.push(path),
            WorkspaceEntryKind::Directory => {
                if !collect_files(workspace, &path, files) {
                    return false;
                }
            }
        }
    }
    true
}

/// Hands the runtime's files under the skill folder `skill_dir` (workspace-relative) over to the
/// space: their lines leave the managed block, so an import that writes over them is saved, and
/// later edits are too. Returns whether anything was released.
pub(crate) fn release(workspace_dir: &Path, skill_dir: &str) -> bool {
    let Ok(workspace) = WorkspaceDir::open(workspace_dir) else {
        return false;
    };
    let folder = format!("{}/", skill_dir.trim_end_matches('/'));
    let mut released = false;
    for link in git_links(workspace_dir) {
        let recorded = parse_block(
            &read_exclude(Some(&workspace), workspace_dir, &link.exclude),
            &link.prefix,
        );
        let kept: Recorded = recorded
            .iter()
            .filter(|(path, _)| !path.starts_with(&folder))
            .map(|(path, hash)| (path.clone(), hash.clone()))
            .collect();
        if kept.len() != recorded.len()
            && write_exclude(&workspace, workspace_dir, &link, &kept).is_ok()
        {
            released = true;
        }
    }
    released
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_packs::{NodeRequirement, PackCli};
    use std::fs;

    const NODE: Option<NodeVersion> = Some((22, 11, 0));

    fn pack(root: &Path, name: &str, with_cli: bool) -> InstalledPack {
        let dir = root.join(name);
        fs::create_dir_all(dir.join("scripts")).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: test\n---\n\n# {name}\n\nRun `node .agents/skills/{name}/scripts/run.mjs`.\n"),
        )
        .unwrap();
        fs::write(
            dir.join("scripts/run.mjs"),
            "console.log('the pack ran', process.argv.slice(2).join(' '));\n",
        )
        .unwrap();
        InstalledPack {
            name: name.to_string(),
            version: "0.1.0".into(),
            dir,
            skill: "SKILL.md".into(),
            cli: with_cli.then(|| PackCli {
                entry: "scripts/run.mjs".into(),
                space_path: "scripts/run.mjs".into(),
            }),
            node: NodeRequirement::parse(">=22"),
        }
    }

    fn run_git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    /// A hosted git-canonical checkout: the repository in `.instafy/.git`, no `.git` at the top.
    fn canonical_checkout(dir: &Path) -> Vec<String> {
        let git_dir = dir.join(".instafy/.git");
        let args = vec![
            "--git-dir".to_string(),
            git_dir.display().to_string(),
            "--work-tree".to_string(),
            dir.display().to_string(),
        ];
        fs::create_dir_all(dir.join(".instafy")).unwrap();
        let output = Command::new("git")
            .arg("init")
            .arg("-q")
            .arg("--bare")
            .arg(&git_dir)
            .output()
            .unwrap();
        assert!(output.status.success());
        let mut config = args.clone();
        config.extend(["config", "core.bare", "false"].map(String::from));
        run_git(dir, &config.iter().map(String::as_str).collect::<Vec<_>>());
        args
    }

    fn git_with(dir: &Path, link: &[String], args: &[&str]) -> String {
        let mut all: Vec<&str> = link.iter().map(String::as_str).collect();
        all.extend_from_slice(args);
        run_git(dir, &all)
    }

    fn plain_checkout(dir: &Path) {
        run_git(dir, &["init", "-q"]);
    }

    #[test]
    fn runtime_pack_files_are_written_and_kept_current() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let demo = pack(packs_root.path(), "demo", true);
        keep_current(workspace.path(), std::slice::from_ref(&demo), NODE);

        let skill =
            fs::read_to_string(workspace.path().join(".agents/skills/demo/SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: demo\n"), "{skill}");
        assert!(skill.contains("`$INSTAFY_SKILL_PACKS_DIR/demo/`"));
        assert!(skill.contains("its launcher `scripts/run.mjs`"));
        let launcher_path = workspace.path().join(".agents/skills/demo/scripts/run.mjs");
        let launcher = fs::read_to_string(&launcher_path).unwrap();
        assert_eq!(launcher.lines().nth(1), Some(LAUNCHER_MARKER));
        assert!(launcher.contains("const PACK = \"demo\";"));
        assert!(launcher.contains("const ENTRY = \"scripts/run.mjs\";"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&launcher_path).unwrap().permissions().mode() & 0o111,
                0o111
            );
        }
        // Only these two small files reach the space.
        let mut total = 0;
        for entry in walk(workspace.path()) {
            total += fs::metadata(&entry).unwrap().len();
        }
        assert!(total < 64 * 1024, "{total} bytes");
        assert!(
            !workspace
                .path()
                .join(".agents/skills/demo/scripts/lib")
                .exists()
        );

        // Without git there is no record of what the runtime wrote: an unchanged older copy
        // proves itself with its marker and is upgraded, an edited one is left as it is.
        let space_skill_path = workspace.path().join(".agents/skills/demo/SKILL.md");
        assert!(has_intact_skill_marker(
            &fs::read(&space_skill_path).unwrap()
        ));
        fs::write(
            demo.dir.join("SKILL.md"),
            "---\nname: demo\n---\n\n# demo v2\n",
        )
        .unwrap();
        keep_current(workspace.path(), std::slice::from_ref(&demo), NODE);
        let upgraded = fs::read_to_string(&space_skill_path).unwrap();
        assert!(upgraded.contains("# demo v2"), "{upgraded}");
        assert!(has_intact_skill_marker(upgraded.as_bytes()));

        fs::write(
            &space_skill_path,
            upgraded.replace("# demo v2", "# our demo"),
        )
        .unwrap();
        assert!(!has_intact_skill_marker(
            &fs::read(&space_skill_path).unwrap()
        ));
        fs::write(
            demo.dir.join("SKILL.md"),
            "---\nname: demo\n---\n\n# demo v3\n",
        )
        .unwrap();
        keep_current(workspace.path(), std::slice::from_ref(&demo), NODE);
        let kept = fs::read_to_string(&space_skill_path).unwrap();
        assert!(
            kept.contains("# our demo") && !kept.contains("# demo v3"),
            "{kept}"
        );
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(walk(&path));
            } else {
                files.push(path);
            }
        }
        files
    }

    #[test]
    fn runtime_pack_files_are_excluded_in_an_instafy_canonical_checkout() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let link = canonical_checkout(&workspace);
        fs::write(workspace.join("README.md"), "hello\n").unwrap();
        git_with(&workspace, &link, &["add", "README.md"]);
        git_with(
            &workspace,
            &link,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        );
        let demo = pack(packs_root.path(), "demo", true);

        keep_current(&workspace, std::slice::from_ref(&demo), NODE);

        assert!(workspace.join(".agents/skills/demo/SKILL.md").is_file());
        assert!(
            workspace
                .join(".agents/skills/demo/scripts/run.mjs")
                .is_file()
        );
        let status = git_with(
            &workspace,
            &link,
            &["status", "--porcelain", "--untracked-files=all"],
        );
        assert_eq!(status, "", "the runtime's files are invisible to status");
        let exclude = fs::read_to_string(workspace.join(".instafy/.git/info/exclude")).unwrap();
        assert!(
            exclude.contains("/.agents/skills/demo/SKILL.md\n"),
            "{exclude}"
        );
        assert!(exclude.contains("/.agents/skills/demo/scripts/run.mjs\n"));
        assert!(exclude.contains(HASH_PREFIX));
        assert!(!workspace.join(".git").exists());

        // A pack upgrade replaces the runtime's unchanged copy, and stays excluded.
        fs::write(
            demo.dir.join("SKILL.md"),
            "---\nname: demo\n---\n\n# demo v2\n",
        )
        .unwrap();
        keep_current(&workspace, std::slice::from_ref(&demo), NODE);
        assert!(
            fs::read_to_string(workspace.join(".agents/skills/demo/SKILL.md"))
                .unwrap()
                .contains("# demo v2")
        );
        assert_eq!(
            git_with(
                &workspace,
                &link,
                &["status", "--porcelain", "--untracked-files=all"]
            ),
            ""
        );
    }

    #[test]
    fn runtime_pack_files_are_excluded_in_a_plain_git_checkout() {
        let packs_root = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let repo = repo.path().canonicalize().unwrap();
        plain_checkout(&repo);
        // The workspace is a folder inside the repository.
        let workspace = repo.join("app");
        fs::create_dir_all(&workspace).unwrap();
        let demo = pack(packs_root.path(), "demo", false);
        keep_current(&workspace, std::slice::from_ref(&demo), NODE);
        assert!(workspace.join(".agents/skills/demo/SKILL.md").is_file());
        assert!(
            !workspace.join(".agents/skills/demo/scripts").exists(),
            "no launcher without a command"
        );
        assert_eq!(
            run_git(&repo, &["status", "--porcelain", "--untracked-files=all"]),
            ""
        );
        let exclude = fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert!(
            exclude.contains("/app/.agents/skills/demo/SKILL.md\n"),
            "{exclude}"
        );
    }

    #[test]
    fn edited_pack_skill_is_left_alone() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let link = canonical_checkout(&workspace);
        // A pack without a command: only its SKILL.md, guarded by the recorded hash alone.
        let docs = pack(packs_root.path(), "docs", false);
        keep_current(&workspace, std::slice::from_ref(&docs), NODE);
        let skill = workspace.join(".agents/skills/docs/SKILL.md");
        fs::write(&skill, "my own notes\n").unwrap();
        fs::write(docs.dir.join("SKILL.md"), "---\nname: docs\n---\n\n# v2\n").unwrap();

        keep_current(&workspace, std::slice::from_ref(&docs), NODE);

        assert_eq!(fs::read_to_string(&skill).unwrap(), "my own notes\n");
        // The edit is the space's now: no longer excluded, so it is saved like any work.
        let status = git_with(
            &workspace,
            &link,
            &["status", "--porcelain", "--untracked-files=all"],
        );
        assert!(status.contains(".agents/skills/docs/SKILL.md"), "{status}");
    }

    #[test]
    fn a_full_pack_copy_keeps_its_own_cli() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        canonical_checkout(&workspace);
        let demo = pack(packs_root.path(), "demo", true);
        // The pack imported in full: its own command, without the launcher marker.
        let cli = workspace.join(".agents/skills/demo/scripts/run.mjs");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, "#!/usr/bin/env node\n// the pack's own CLI\n").unwrap();
        let skill = workspace.join(".agents/skills/demo/SKILL.md");
        fs::write(&skill, "---\nname: demo\n---\nthe pack's own skill\n").unwrap();

        keep_current(&workspace, std::slice::from_ref(&demo), NODE);

        assert_eq!(
            fs::read_to_string(&cli).unwrap(),
            "#!/usr/bin/env node\n// the pack's own CLI\n"
        );
        assert_eq!(
            fs::read_to_string(&skill).unwrap(),
            "---\nname: demo\n---\nthe pack's own skill\n"
        );
        // A launcher the runtime wrote earlier (marker intact) is still its own to update.
        fs::write(&cli, launcher("demo", "scripts/old.mjs")).unwrap();
        keep_current(&workspace, std::slice::from_ref(&demo), NODE);
        assert!(
            fs::read_to_string(&cli)
                .unwrap()
                .contains("\"scripts/run.mjs\"")
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_pack_files_are_not_written_through_a_symlinked_folder() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let skills = workspace.path().join(SKILLS_ROOT);
        fs::create_dir_all(&skills).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), skills.join("demo")).unwrap();
        let demo = pack(packs_root.path(), "demo", true);
        keep_current(workspace.path(), std::slice::from_ref(&demo), NODE);
        assert!(!elsewhere.path().join("SKILL.md").exists());
        assert!(!elsewhere.path().join("scripts").exists());
        // Nor through a symlinked skills root.
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join(".agents")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), workspace.path().join(SKILLS_ROOT)).unwrap();
        keep_current(workspace.path(), std::slice::from_ref(&demo), NODE);
        assert!(!elsewhere.path().join("demo").exists());
    }

    #[test]
    fn removed_pack_takes_its_unchanged_files_with_it() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let link = canonical_checkout(&workspace);
        let demo = pack(packs_root.path(), "demo", true);
        let docs = pack(packs_root.path(), "docs", false);
        keep_current(&workspace, &[demo.clone(), docs.clone()], NODE);
        fs::write(workspace.join(".agents/skills/docs/SKILL.md"), "edited\n").unwrap();

        keep_current(&workspace, &[], NODE);

        assert!(
            !workspace.join(".agents/skills/demo").exists(),
            "unchanged files and their folder go"
        );
        assert_eq!(
            fs::read_to_string(workspace.join(".agents/skills/docs/SKILL.md")).unwrap(),
            "edited\n"
        );
        let exclude = fs::read_to_string(workspace.join(".instafy/.git/info/exclude")).unwrap();
        assert!(!exclude.contains(BLOCK_BEGIN), "{exclude}");
        let status = git_with(
            &workspace,
            &link,
            &["status", "--porcelain", "--untracked-files=all"],
        );
        assert_eq!(status.trim(), "?? .agents/skills/docs/SKILL.md");
    }

    #[test]
    fn oversized_pack_skill_is_not_written() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let big = pack(packs_root.path(), "big", true);
        fs::write(
            big.dir.join("SKILL.md"),
            format!("---\nname: big\n---\n{}", "x".repeat(MAX_SPACE_SKILL_BYTES)),
        )
        .unwrap();
        keep_current(workspace.path(), &[big], NODE);
        assert!(!workspace.path().join(".agents/skills/big").exists());
    }

    #[test]
    fn pack_is_skipped_without_a_matching_node() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        canonical_checkout(&workspace);
        let demo = pack(packs_root.path(), "demo", true);
        keep_current(&workspace, std::slice::from_ref(&demo), None);
        assert!(!workspace.join(".agents/skills/demo").exists());
        keep_current(&workspace, std::slice::from_ref(&demo), Some((20, 18, 0)));
        assert!(!workspace.join(".agents/skills/demo").exists());
        // Installed while node matched, then node went away: the unchanged files go.
        keep_current(&workspace, std::slice::from_ref(&demo), NODE);
        assert!(workspace.join(".agents/skills/demo/SKILL.md").is_file());
        keep_current(&workspace, std::slice::from_ref(&demo), None);
        assert!(!workspace.join(".agents/skills/demo").exists());
    }

    #[test]
    fn tracked_pack_files_are_left_to_the_repository() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let link = canonical_checkout(&workspace);
        let skill = workspace.join(".agents/skills/demo/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        fs::write(&skill, "committed\n").unwrap();
        git_with(&workspace, &link, &["add", "-A"]);
        git_with(
            &workspace,
            &link,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-q",
                "-m",
                "pack",
            ],
        );
        let demo = pack(packs_root.path(), "demo", false);
        keep_current(&workspace, std::slice::from_ref(&demo), NODE);
        assert_eq!(fs::read_to_string(&skill).unwrap(), "committed\n");
        let exclude =
            fs::read_to_string(workspace.join(".instafy/.git/info/exclude")).unwrap_or_default();
        assert!(!exclude.contains("/.agents/skills/demo/SKILL.md"));
    }

    #[test]
    fn the_launcher_runs_the_pack_command() {
        // Any node runs the launcher; the pack's own `engines.node` is not what is tested here.
        if crate::skill_packs::node_on_path().is_none() {
            return;
        }
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let demo = pack(packs_root.path(), "demo", true);
        keep_current(workspace.path(), std::slice::from_ref(&demo), NODE);
        let launcher = workspace.path().join(".agents/skills/demo/scripts/run.mjs");
        let run = |args: &[&str], dir: Option<&Path>| {
            let mut command = Command::new("node");
            command
                .arg(&launcher)
                .args(args)
                .env_remove(crate::skill_packs::SKILL_PACKS_DIR_ENV);
            if let Some(dir) = dir {
                command.env(crate::skill_packs::SKILL_PACKS_DIR_ENV, dir);
            }
            command.output().unwrap()
        };
        let output = run(&["hello", "there"], Some(packs_root.path()));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "the pack ran hello there\n"
        );
        let output = run(&["--pack-dir"], Some(packs_root.path()));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            demo.dir.display().to_string()
        );
        if !Path::new(crate::skill_packs::IMAGE_SKILL_PACKS_DIR)
            .join("demo")
            .exists()
        {
            let output = run(&[], None);
            assert_eq!(output.status.code(), Some(1));
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("is not installed in this runtime")
            );
        }
    }

    /// The installed packs end to end: `pnpm skill-packs:install`, then
    /// `cargo test -p runtime-agent runtime_pack_install_smoke -- --ignored`.
    #[test]
    #[ignore = "needs installed skill packs (pnpm skill-packs:install) and node"]
    fn runtime_pack_install_smoke() {
        let root = std::env::var_os(crate::skill_packs::SKILL_PACKS_DIR_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/skill-packs"))
            });
        let packs = crate::skill_packs::list_packs(&root);
        assert!(!packs.is_empty(), "no packs in {}", root.display());
        let node = crate::skill_packs::node_on_path().expect("node on PATH");
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let link = canonical_checkout(&workspace);

        keep_current(&workspace, &packs, Some(node));

        let exclude = fs::read_to_string(workspace.join(".instafy/.git/info/exclude")).unwrap();
        for pack in &packs {
            let skill = format!(".agents/skills/{}/SKILL.md", pack.name);
            assert!(exclude.contains(&format!("/{skill}\n")), "{exclude}");
            let written = fs::read_to_string(workspace.join(&skill)).unwrap();
            assert!(written.len() <= MAX_SPACE_SKILL_BYTES);
            let Some(cli) = &pack.cli else {
                continue;
            };
            let launcher =
                workspace.join(format!(".agents/skills/{}/{}", pack.name, cli.space_path));
            let run = |args: &[&str]| {
                Command::new("node")
                    .arg(&launcher)
                    .args(args)
                    .env(crate::skill_packs::SKILL_PACKS_DIR_ENV, &root)
                    .current_dir(&workspace)
                    .output()
                    .unwrap()
            };
            let output = run(&["--pack-dir"]);
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim(),
                pack.dir.display().to_string()
            );
            let output = run(&["--help"]);
            assert!(
                output.status.success(),
                "{}: {}",
                pack.name,
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert_eq!(
            git_with(
                &workspace,
                &link,
                &["status", "--porcelain", "--untracked-files=all"]
            ),
            ""
        );
    }

    #[test]
    fn launcher_values_are_json_strings() {
        let text = launcher("a\"b", "scripts/x.mjs\n");
        assert!(text.contains("const PACK = \"a\\\"b\";"));
        assert!(text.contains("const ENTRY = \"scripts/x.mjs\\n\";"));
        assert!(!text.contains("{{"));
        assert!(
            !text.contains(".instafy/skill-packs"),
            "no folder a space can write to"
        );
    }

    #[test]
    fn space_note_stays_small() {
        let packs_root = tempfile::tempdir().unwrap();
        let mut demo = pack(packs_root.path(), &"n".repeat(64), true);
        demo.cli = Some(PackCli {
            entry: "scripts/run.mjs".into(),
            space_path: format!("scripts/{}.mjs", "l".repeat(40)),
        });
        let skill = fs::read_to_string(demo.dir.join("SKILL.md")).unwrap();
        let written = space_skill(&demo).unwrap();
        assert!(
            written.len() - skill.len() <= 512,
            "{}",
            written.len() - skill.len()
        );
        const { assert!(MAX_SPACE_SKILL_BYTES - 512 >= 11_400) };
    }

    #[test]
    fn released_files_leave_the_block() {
        let packs_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let link = canonical_checkout(&workspace);
        let demo = pack(packs_root.path(), "demo", true);
        keep_current(&workspace, std::slice::from_ref(&demo), NODE);
        assert!(is_runtime_provided_skill_dir(
            &workspace,
            ".agents/skills/demo"
        ));
        assert!(release(&workspace, ".agents/skills/demo"));
        // As an import does: the folder now holds the space's own files.
        fs::write(
            workspace.join(".agents/skills/demo/SKILL.md"),
            "---\nname: demo\n---\n\n# The full pack\n",
        )
        .unwrap();
        assert!(!is_runtime_provided_skill_dir(
            &workspace,
            ".agents/skills/demo"
        ));
        let status = git_with(
            &workspace,
            &link,
            &["status", "--porcelain", "--untracked-files=all"],
        );
        assert!(status.contains(".agents/skills/demo/SKILL.md"), "{status}");
        assert!(
            status.contains(".agents/skills/demo/scripts/run.mjs"),
            "{status}"
        );
    }
}
