use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::UNIX_EPOCH;

use origin_http_server::untrusted_git::list_untrusted_worktree_status;
use tokio::process::Command;
use tracing::warn;

use crate::model_environment::apply_allowlisted_tokio_environment;

const FULL_FINGERPRINT_MAX_BYTES: u64 = 1024 * 1024;
const LARGE_FILE_SAMPLE_BYTES: usize = 64 * 1024;
const MAX_FINGERPRINT_FILES: usize = 4096;
const MAX_FINGERPRINT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const GIT_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GitStatusEntry {
    pub(super) code: String,
    fingerprint: Option<String>,
}

impl GitStatusEntry {
    pub(super) fn new(code: impl Into<String>, fingerprint: Option<String>) -> Self {
        Self {
            code: code.into(),
            fingerprint,
        }
    }
}

pub(super) async fn collect_git_status_porcelain(
    workspace_dir: &Path,
    git_args: &[String],
) -> Option<HashMap<String, GitStatusEntry>> {
    let mut command = Command::new("git");
    command
        .args(["-c", "core.fsmonitor=false"])
        .args(git_args)
        .current_dir(workspace_dir);
    apply_allowlisted_tokio_environment(&mut command, &[]);
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command.kill_on_drop(true);
    let output = match tokio::time::timeout(GIT_STATUS_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            warn!(
                workspace_dir = %workspace_dir.display(),
                %error,
                "failed to run git status; workspace file-change detection is unavailable"
            );
            return None;
        }
        Err(_) => {
            warn!(
                workspace_dir = %workspace_dir.display(),
                "git status timed out; workspace file-change detection is unavailable"
            );
            return None;
        }
    };

    if !output.status.success() {
        warn!(
            workspace_dir = %workspace_dir.display(),
            stderr = %String::from_utf8_lossy(&output.stderr).trim(),
            "git status failed; workspace file-change detection is unavailable"
        );
        return None;
    }

    let Some(mut statuses) = parse_porcelain_status(&output.stdout) else {
        warn!(
            workspace_dir = %workspace_dir.display(),
            "git status returned an invalid path; workspace file-change detection is unavailable"
        );
        return None;
    };
    expand_embedded_repo_statuses(workspace_dir, &mut statuses).await;

    let fingerprint_root = workspace_dir.to_path_buf();
    let mut fingerprint_paths = statuses.keys().cloned().collect::<Vec<_>>();
    fingerprint_paths.sort();
    let fingerprints = tokio::task::spawn_blocking(move || {
        let mut budget = FingerprintBudget::default();
        fingerprint_paths
            .into_iter()
            .map(|path| {
                let fingerprint = workspace_path_fingerprint(&fingerprint_root, &path, &mut budget);
                (path, fingerprint)
            })
            .collect::<HashMap<_, _>>()
    })
    .await
    .unwrap_or_default();
    for (path, status) in &mut statuses {
        status.fingerprint = fingerprints.get(path).cloned().flatten();
    }

    Some(statuses)
}

fn parse_porcelain_status(raw: &[u8]) -> Option<HashMap<String, GitStatusEntry>> {
    let mut statuses = HashMap::new();
    for record in raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if record.len() < 4 || record[2] != b' ' {
            return None;
        }
        let status = std::str::from_utf8(&record[..2]).ok()?;
        let path = std::str::from_utf8(&record[3..]).ok()?.replace('\\', "/");
        let relative = Path::new(&path);
        if relative.as_os_str().is_empty()
            || !relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
        {
            return None;
        }
        if path == ".git" || path.starts_with(".git/") {
            continue;
        }
        statuses.insert(path, GitStatusEntry::new(status, None));
    }
    Some(statuses)
}

async fn expand_embedded_repo_statuses(
    workspace_dir: &Path,
    statuses: &mut HashMap<String, GitStatusEntry>,
) {
    let mut embedded_roots = statuses
        .keys()
        .filter_map(|path| find_embedded_repo_root(workspace_dir, path))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    embedded_roots.sort();

    for embedded_root in embedded_roots {
        let status_workspace = workspace_dir.to_path_buf();
        let status_repo = workspace_dir.join(&embedded_root);
        let inner_statuses = match tokio::task::spawn_blocking(move || {
            list_untrusted_worktree_status(&status_workspace, &status_repo)
        })
        .await
        {
            Ok(Ok(statuses)) => statuses,
            Ok(Err(error)) => {
                warn!(
                    embedded_repo_root = %embedded_root,
                    %error,
                    "isolated embedded git status failed during workspace change detection"
                );
                continue;
            }
            Err(error) => {
                warn!(
                    embedded_repo_root = %embedded_root,
                    %error,
                    "embedded git status task failed during workspace change detection"
                );
                continue;
            }
        };
        if inner_statuses.is_empty() {
            continue;
        }

        let prefix = format!("{embedded_root}/");
        statuses.retain(|path, _| path != &embedded_root && !path.starts_with(&prefix));
        for (path, code) in inner_statuses {
            statuses.insert(
                format!("{embedded_root}/{path}"),
                GitStatusEntry::new(code, None),
            );
        }
    }
}

fn find_embedded_repo_root(workspace_dir: &Path, path: &str) -> Option<String> {
    let canonical_git_dir = workspace_dir.join(".instafy").join(".git");
    let mut cursor = PathBuf::from(path.trim().trim_matches('/'));

    loop {
        if cursor.as_os_str().is_empty() {
            return None;
        }
        let candidate = workspace_dir.join(&cursor).join(".git");
        if candidate.exists() && candidate != canonical_git_dir {
            return Some(cursor.to_string_lossy().replace('\\', "/"));
        }
        if !cursor.pop() {
            return None;
        }
    }
}

#[derive(Debug)]
struct FingerprintBudget {
    files_remaining: usize,
    bytes_remaining: u64,
}

impl Default for FingerprintBudget {
    fn default() -> Self {
        Self {
            files_remaining: MAX_FINGERPRINT_FILES,
            bytes_remaining: MAX_FINGERPRINT_TOTAL_BYTES,
        }
    }
}

impl FingerprintBudget {
    fn reserve(&mut self, requested_bytes: u64) -> bool {
        if self.files_remaining == 0 || requested_bytes > self.bytes_remaining {
            return false;
        }
        self.files_remaining -= 1;
        self.bytes_remaining -= requested_bytes;
        true
    }
}

fn workspace_path_fingerprint(
    workspace_dir: &Path,
    relative_path: &str,
    budget: &mut FingerprintBudget,
) -> Option<String> {
    let path = workspace_dir.join(relative_path);
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();

    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(&path).ok()?;
        return Some(format!("link:{modified_nanos}:{}", target.display()));
    }
    if !metadata.is_file() {
        return Some(format!("other:{modified_nanos}:{}", metadata.len()));
    }

    let requested_bytes = if metadata.len() <= FULL_FINGERPRINT_MAX_BYTES {
        metadata.len()
    } else {
        (LARGE_FILE_SAMPLE_BYTES * 2) as u64
    };
    if !budget.reserve(requested_bytes) {
        return Some(format!("file-meta:{modified_nanos}:{}", metadata.len()));
    }

    let mut file = File::open(path).ok()?;
    let mut hash = FNV_OFFSET_BASIS;
    if metadata.len() <= FULL_FINGERPRINT_MAX_BYTES {
        hash_reader(&mut file, &mut hash, metadata.len() as usize).ok()?;
    } else {
        hash_reader(&mut file, &mut hash, LARGE_FILE_SAMPLE_BYTES).ok()?;
        file.seek(SeekFrom::End(-(LARGE_FILE_SAMPLE_BYTES as i64)))
            .ok()?;
        hash_reader(&mut file, &mut hash, LARGE_FILE_SAMPLE_BYTES).ok()?;
    }

    Some(format!(
        "file:{modified_nanos}:{}:{hash:016x}",
        metadata.len()
    ))
}

fn hash_reader(file: &mut File, hash: &mut u64, max_bytes: usize) -> std::io::Result<()> {
    let mut remaining = max_bytes;
    let mut buffer = [0_u8; 16 * 1024];
    while remaining > 0 {
        let chunk_len = remaining.min(buffer.len());
        let read = file.read(&mut buffer[..chunk_len])?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            *hash ^= u64::from(*byte);
            *hash = hash.wrapping_mul(FNV_PRIME);
        }
        remaining -= read;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::process::Command as StdCommand;

    use anyhow::{Context, Result, ensure};

    use super::*;

    fn run_git(repo: &Path, args: &[&str]) -> Result<()> {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(repo)
            .output()?;
        ensure!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    fn init_repo(repo: &Path) -> Result<()> {
        std::fs::create_dir_all(repo)?;
        run_git(repo, &["init", "-b", "main"])?;
        run_git(repo, &["config", "user.name", "Instafy Test"])?;
        run_git(repo, &["config", "user.email", "test@instafy.dev"])?;
        Ok(())
    }

    #[tokio::test]
    async fn fingerprints_dirty_embedded_edits_in_canonical_layout_without_touching_git_metadata()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path();
        init_repo(workspace)?;
        std::fs::write(workspace.join("README.md"), "outer\n")?;
        run_git(workspace, &["add", "README.md"])?;
        run_git(workspace, &["commit", "-m", "outer"])?;

        let canonical_git_dir = workspace.join(".instafy").join(".git");
        std::fs::create_dir_all(canonical_git_dir.parent().context("canonical parent")?)?;
        std::fs::rename(workspace.join(".git"), &canonical_git_dir)?;

        let nested = workspace.join("nested");
        init_repo(&nested)?;
        std::fs::write(nested.join("tracked.txt"), "clean\n")?;
        run_git(&nested, &["add", "tracked.txt"])?;
        run_git(&nested, &["commit", "-m", "nested"])?;
        std::fs::write(nested.join("tracked.txt"), "alpha\n")?;
        std::fs::write(nested.join("notes.md"), "alpha\n")?;
        let nested_git_config_before = std::fs::read(nested.join(".git/config"))?;

        let args = [
            "--git-dir".to_string(),
            canonical_git_dir.display().to_string(),
            "--work-tree".to_string(),
            workspace.display().to_string(),
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "-z".to_string(),
            "--no-renames".to_string(),
            "--untracked-files=all".to_string(),
        ];
        let before = collect_git_status_porcelain(workspace, &args)
            .await
            .context("missing before status")?;
        std::fs::write(nested.join("notes.md"), "bravo\n")?;
        std::fs::write(nested.join("tracked.txt"), "bravo\n")?;
        let after = collect_git_status_porcelain(workspace, &args)
            .await
            .context("missing after status")?;

        ensure!(before.contains_key("nested/notes.md"));
        ensure!(after.contains_key("nested/notes.md"));
        ensure!(before.get("nested/notes.md") != after.get("nested/notes.md"));
        ensure!(before.get("nested/tracked.txt") != after.get("nested/tracked.txt"));
        ensure!(!after.contains_key("nested"));
        ensure!(nested.join(".git/config").is_file());
        ensure!(std::fs::read(nested.join(".git/config"))? == nested_git_config_before);
        Ok(())
    }

    #[tokio::test]
    async fn fingerprints_repeated_edits_with_the_same_git_status_code() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path();
        init_repo(workspace)?;
        std::fs::write(workspace.join("tracked.txt"), "clean\n")?;
        run_git(workspace, &["add", "tracked.txt"])?;
        run_git(workspace, &["commit", "-m", "baseline"])?;
        std::fs::write(workspace.join("tracked.txt"), "alpha\n")?;

        let args = [
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "-z".to_string(),
            "--no-renames".to_string(),
            "--untracked-files=all".to_string(),
        ];
        let before = collect_git_status_porcelain(workspace, &args)
            .await
            .context("missing before status")?;
        std::fs::write(workspace.join("tracked.txt"), "bravo\n")?;
        let after = collect_git_status_porcelain(workspace, &args)
            .await
            .context("missing after status")?;

        ensure!(before.get("tracked.txt") != after.get("tracked.txt"));
        Ok(())
    }

    #[test]
    fn fingerprint_budget_falls_back_to_metadata_without_exceeding_limits() -> Result<()> {
        let temp = tempfile::tempdir()?;
        std::fs::write(temp.path().join("tracked.txt"), "content\n")?;
        let mut budget = FingerprintBudget {
            files_remaining: 0,
            bytes_remaining: 0,
        };

        let fingerprint = workspace_path_fingerprint(temp.path(), "tracked.txt", &mut budget)
            .context("missing metadata fingerprint")?;

        ensure!(fingerprint.starts_with("file-meta:"));
        ensure!(budget.files_remaining == 0);
        ensure!(budget.bytes_remaining == 0);
        Ok(())
    }
}
