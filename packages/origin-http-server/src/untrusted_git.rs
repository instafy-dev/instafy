use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};

const GIT_STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_GIT_INDEX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GIT_REF_BYTES: u64 = 4 * 1024;
const MAX_PACKED_REFS_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STATUS_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const SAFE_ENV_KEYS: &[&str] = &[
    "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TMP", "TEMP",
];

/// Read dirty paths from an embedded repository without trusting its Git config.
///
/// A normal `git status` loads `.git/config`, which can execute fsmonitor and
/// clean/process filters. This helper instead copies only the index and a
/// validated HEAD into a temporary Git directory, pins the work tree and object
/// directory, clears inherited Git configuration, and enforces a hard timeout.
pub fn list_untrusted_worktree_status(
    workspace_root: &Path,
    repo_root: &Path,
) -> Result<BTreeMap<String, String>> {
    let workspace_root = workspace_root
        .canonicalize()
        .with_context(|| format!("failed to resolve workspace root {workspace_root:?}"))?;
    let repo_root = repo_root
        .canonicalize()
        .with_context(|| format!("failed to resolve embedded repository {repo_root:?}"))?;
    ensure!(
        repo_root.starts_with(&workspace_root) && repo_root != workspace_root,
        "embedded repository escapes the workspace"
    );

    let git_entry = repo_root.join(".git");
    let git_metadata = std::fs::symlink_metadata(&git_entry)
        .with_context(|| format!("failed to inspect embedded git directory {git_entry:?}"))?;
    ensure!(
        git_metadata.file_type().is_dir(),
        "embedded .git must be a real directory"
    );
    let git_dir = git_entry
        .canonicalize()
        .with_context(|| format!("failed to resolve embedded git directory {git_entry:?}"))?;
    ensure!(
        git_dir.starts_with(&repo_root),
        "embedded .git escapes its repository"
    );

    let objects_entry = git_dir.join("objects");
    let objects_metadata = std::fs::symlink_metadata(&objects_entry)
        .with_context(|| format!("failed to inspect object directory {objects_entry:?}"))?;
    ensure!(
        objects_metadata.file_type().is_dir(),
        "embedded object store must be a real directory"
    );
    let objects_dir = objects_entry
        .canonicalize()
        .with_context(|| format!("failed to resolve object directory {objects_entry:?}"))?;
    ensure!(
        objects_dir.starts_with(&git_dir),
        "embedded object store escapes .git"
    );

    let shadow = tempfile::tempdir().context("failed to create isolated git directory")?;
    std::fs::create_dir_all(shadow.path().join("objects"))
        .context("failed to create isolated object directory")?;
    std::fs::create_dir_all(shadow.path().join("refs").join("heads"))
        .context("failed to create isolated refs directory")?;
    copy_optional_regular_file(
        &git_dir.join("index"),
        &shadow.path().join("index"),
        MAX_GIT_INDEX_BYTES,
    )?;
    copy_split_indexes(&git_dir, shadow.path())?;

    let head = isolated_head(&git_dir)?;
    std::fs::write(shadow.path().join("HEAD"), &head)
        .context("failed to write isolated git HEAD")?;

    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg(format!("core.worktree={}", repo_root.display()))
        .arg("--git-dir")
        .arg(shadow.path())
        .arg("--work-tree")
        .arg(&repo_root)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
        ]);
    apply_isolated_git_environment(&mut command, &workspace_root, &objects_dir, shadow.path());

    let output = output_with_timeout(&mut command, GIT_STATUS_TIMEOUT)?;
    if !output.status.success() {
        bail!(
            "isolated embedded git status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    parse_porcelain_v1_z(&output.stdout)
}

struct CommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn output_with_timeout(command: &mut Command, timeout: Duration) -> Result<CommandOutput> {
    let mut stdout_file = tempfile::tempfile().context("failed to create git stdout buffer")?;
    let mut stderr_file = tempfile::tempfile().context("failed to create git stderr buffer")?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            stdout_file
                .try_clone()
                .context("failed to clone git stdout buffer")?,
        ))
        .stderr(Stdio::from(
            stderr_file
                .try_clone()
                .context("failed to clone git stderr buffer")?,
        ));
    let mut child = command
        .spawn()
        .context("failed to start isolated git status")?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .context("failed while waiting for isolated git status")?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("isolated embedded git status timed out");
        }
        thread::sleep(Duration::from_millis(10));
    };

    let stdout = read_bounded_output(&mut stdout_file, MAX_STATUS_OUTPUT_BYTES, "stdout")?;
    let stderr = read_bounded_output(&mut stderr_file, MAX_STATUS_OUTPUT_BYTES, "stderr")?;
    Ok(CommandOutput {
        status,
        stdout,
        stderr,
    })
}

fn read_bounded_output(file: &mut File, max_bytes: u64, label: &str) -> Result<Vec<u8>> {
    let length = file
        .metadata()
        .with_context(|| format!("failed to inspect git {label}"))?
        .len();
    ensure!(
        length <= max_bytes,
        "isolated git {label} exceeded the output limit"
    );
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("failed to rewind git {label}"))?;
    let mut output = Vec::with_capacity(length as usize);
    file.read_to_end(&mut output)
        .with_context(|| format!("failed to read git {label}"))?;
    Ok(output)
}

fn apply_isolated_git_environment(
    command: &mut Command,
    workspace_root: &Path,
    objects_dir: &Path,
    shadow_git_dir: &Path,
) {
    let retained = SAFE_ENV_KEYS
        .iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (*key, value)))
        .collect::<Vec<_>>();
    command.env_clear();
    command.envs(retained);
    command.env("GIT_ATTR_NOSYSTEM", "1");
    command.env("GIT_CEILING_DIRECTORIES", workspace_root);
    command.env("GIT_CONFIG_GLOBAL", "/dev/null");
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    command.env("GIT_DIR", shadow_git_dir);
    command.env("GIT_INDEX_FILE", shadow_git_dir.join("index"));
    command.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", objects_dir);
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command.env("GIT_TERMINAL_PROMPT", "0");
}

fn copy_optional_regular_file(source: &Path, target: &Path, max_bytes: u64) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("failed to inspect {source:?}")),
    };
    ensure!(
        metadata.file_type().is_file(),
        "unsafe git metadata entry {source:?}"
    );
    ensure!(
        metadata.len() <= max_bytes,
        "git metadata entry is too large: {source:?}"
    );
    std::fs::copy(source, target)
        .with_context(|| format!("failed to copy isolated git metadata {source:?}"))?;
    Ok(())
}

fn copy_split_indexes(git_dir: &Path, shadow_git_dir: &Path) -> Result<()> {
    for entry in std::fs::read_dir(git_dir).context("failed to inspect embedded git directory")? {
        let entry = entry.context("failed to inspect embedded git entry")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(suffix) = name.strip_prefix("sharedindex.") else {
            continue;
        };
        if suffix.len() != 40 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        copy_optional_regular_file(
            &entry.path(),
            &shadow_git_dir.join(name),
            MAX_GIT_INDEX_BYTES,
        )?;
    }
    Ok(())
}

fn isolated_head(git_dir: &Path) -> Result<Vec<u8>> {
    let raw_head = read_regular_bounded(&git_dir.join("HEAD"), MAX_GIT_REF_BYTES)?;
    let head = std::str::from_utf8(&raw_head)
        .context("embedded HEAD is not UTF-8")?
        .trim();
    if is_object_id(head) {
        return Ok(format!("{head}\n").into_bytes());
    }
    let Some(reference) = head.strip_prefix("ref: ") else {
        bail!("embedded HEAD has an unsupported format");
    };
    validate_ref_name(reference)?;
    if let Some(object_id) = resolve_ref(git_dir, reference)? {
        return Ok(format!("{object_id}\n").into_bytes());
    }

    // An unresolved, validated symbolic HEAD is an ordinary unborn branch.
    Ok(format!("ref: {reference}\n").into_bytes())
}

fn resolve_ref(git_dir: &Path, reference: &str) -> Result<Option<String>> {
    let loose_ref = git_dir.join(reference);
    match std::fs::symlink_metadata(&loose_ref) {
        Ok(metadata) => {
            ensure!(
                metadata.file_type().is_file(),
                "unsafe loose ref {loose_ref:?}"
            );
            let value = read_regular_bounded(&loose_ref, MAX_GIT_REF_BYTES)?;
            let value = std::str::from_utf8(&value)
                .context("embedded loose ref is not UTF-8")?
                .trim();
            ensure!(is_object_id(value), "embedded loose ref is invalid");
            return Ok(Some(value.to_string()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect loose ref {loose_ref:?}"));
        }
    }

    let packed_refs = git_dir.join("packed-refs");
    let raw = match std::fs::symlink_metadata(&packed_refs) {
        Ok(metadata) => {
            ensure!(metadata.file_type().is_file(), "unsafe packed-refs entry");
            read_regular_bounded(&packed_refs, MAX_PACKED_REFS_BYTES)?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to inspect packed-refs"),
    };
    for line in std::str::from_utf8(&raw)
        .context("embedded packed-refs is not UTF-8")?
        .lines()
    {
        if line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let Some((object_id, name)) = line.split_once(' ') else {
            continue;
        };
        if name == reference {
            ensure!(is_object_id(object_id), "embedded packed ref is invalid");
            return Ok(Some(object_id.to_string()));
        }
    }
    Ok(None)
}

fn read_regular_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect git metadata {path:?}"))?;
    ensure!(
        metadata.file_type().is_file(),
        "unsafe git metadata entry {path:?}"
    );
    ensure!(
        metadata.len() <= max_bytes,
        "git metadata entry is too large: {path:?}"
    );
    std::fs::read(path).with_context(|| format!("failed to read git metadata {path:?}"))
}

fn validate_ref_name(reference: &str) -> Result<()> {
    let path = Path::new(reference);
    ensure!(
        reference.starts_with("refs/") && is_safe_relative_path(path),
        "unsafe HEAD ref"
    );
    Ok(())
}

fn is_object_id(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn parse_porcelain_v1_z(raw: &[u8]) -> Result<BTreeMap<String, String>> {
    let mut entries = BTreeMap::new();
    for record in raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        ensure!(
            record.len() >= 4 && record[2] == b' ',
            "invalid porcelain status record"
        );
        let code = std::str::from_utf8(&record[..2])
            .context("status code is not UTF-8")?
            .to_string();
        let path = std::str::from_utf8(&record[3..])
            .context("embedded path is not UTF-8")?
            .replace('\\', "/");
        let relative = Path::new(&path);
        ensure!(
            is_safe_relative_path(relative),
            "unsafe embedded status path"
        );
        if path == ".git" || path.starts_with(".git/") {
            continue;
        }
        entries.insert(path, code);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::process::Command as StdCommand;

    use super::*;

    fn git(repo: &Path, args: &[&str]) -> Result<()> {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(repo)
            .output()?;
        ensure!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    #[test]
    fn isolates_status_from_repo_config_and_preserves_unusual_paths() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path().join("workspace");
        let repo = workspace.join("nested");
        std::fs::create_dir_all(&repo)?;
        git(&repo, &["init", "-b", "main"])?;
        git(&repo, &["config", "user.name", "Instafy Test"])?;
        git(&repo, &["config", "user.email", "test@instafy.dev"])?;
        std::fs::write(repo.join("tracked.txt"), "clean\n")?;
        git(&repo, &["add", "tracked.txt"])?;
        git(&repo, &["commit", "-m", "baseline"])?;

        let probe = workspace.join("filter-ran");
        let filter = workspace.join("filter.sh");
        std::fs::write(
            &filter,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", probe.display()),
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&filter, std::fs::Permissions::from_mode(0o755))?;
        }
        git(
            &repo,
            &[
                "config",
                "filter.hostile.clean",
                &filter.display().to_string(),
            ],
        )?;
        git(
            &repo,
            &[
                "config",
                "filter.hostile.process",
                &filter.display().to_string(),
            ],
        )?;
        git(
            &repo,
            &["config", "core.fsmonitor", &filter.display().to_string()],
        )?;
        std::fs::write(repo.join(".gitattributes"), "tracked.txt filter=hostile\n")?;
        git(
            &repo,
            &["config", "core.worktree", temp.path().to_str().unwrap()],
        )?;

        std::fs::write(repo.join("tracked.txt"), "dirty\n")?;
        std::fs::write(repo.join("spaces -> arrows.txt"), "one\n")?;
        std::fs::write(repo.join("line\nbreak.txt"), "two\n")?;
        let config_before = std::fs::read(repo.join(".git/config"))?;

        let status = list_untrusted_worktree_status(&workspace, &repo)?;
        ensure!(status.contains_key("tracked.txt"));
        ensure!(status.contains_key("spaces -> arrows.txt"));
        ensure!(status.contains_key("line\nbreak.txt"));
        ensure!(!probe.exists(), "repo-configured filter was executed");
        ensure!(std::fs::read(repo.join(".git/config"))? == config_before);
        Ok(())
    }

    #[test]
    fn rejects_git_symlinks_and_out_of_workspace_repositories() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&workspace)?;
        std::fs::create_dir_all(&outside)?;
        git(&outside, &["init", "-b", "main"])?;
        ensure!(list_untrusted_worktree_status(&workspace, &outside).is_err());

        #[cfg(unix)]
        {
            let nested = workspace.join("nested");
            std::fs::create_dir_all(&nested)?;
            std::os::unix::fs::symlink(outside.join(".git"), nested.join(".git"))?;
            ensure!(list_untrusted_worktree_status(&workspace, &nested).is_err());
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_terminates_a_stuck_process() -> Result<()> {
        let started = Instant::now();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        let result = output_with_timeout(&mut command, Duration::from_millis(25));
        ensure!(result.is_err());
        ensure!(started.elapsed() < Duration::from_secs(1));
        Ok(())
    }
}
