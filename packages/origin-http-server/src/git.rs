use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::fs::Permissions;
use std::io::{ErrorKind, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use tempfile::NamedTempFile;
use uuid::Uuid;

use crate::config::ServerConfig;
use crate::error::OriginError;
use crate::paths::is_reserved_path;
use crate::untrusted_git::list_untrusted_worktree_status;
use crate::workspace_fs::{WorkspaceDir, WorkspaceEntryKind};

// Git writes (e.g. remote config updates) are prone to transient lockfiles when multiple
// HTTP requests hit the same workspace concurrently. Serialize git operations per workspace
// to keep Playwright and multi-agent flows stable.
static WORKSPACE_GIT_LOCKS: Lazy<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const GIT_STAGE_CHUNK_SIZE: usize = 256;
const DISABLED_GIT_HOOKS_CONFIG: &str = "core.hooksPath=/dev/null";
const DISABLED_GIT_HELPER: &str = "/usr/bin/false";

/// Construct every git process owned by the origin server with repository
/// hooks disabled. Workspaces are user-controlled, while these commands can
/// run with server credentials (including bearer tokens), so repository hook
/// configuration must never be allowed to execute workspace code.
fn server_git_command() -> Command {
    let mut command = Command::new("git");
    // Do not inherit config injection or helper-program variables from the
    // origin process. Explicit gitdir/worktree arguments are supplied by the
    // caller, and the only authentication material is the scoped HTTP header
    // added by `run_git` below.
    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if key_text.starts_with("GIT_CONFIG_")
            || matches!(
                key_text.as_ref(),
                "GIT_SSH"
                    | "GIT_SSH_COMMAND"
                    | "GIT_ASKPASS"
                    | "SSH_ASKPASS"
                    | "GIT_PROXY_COMMAND"
                    | "GIT_EXTERNAL_DIFF"
            )
        {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", DISABLED_GIT_HELPER)
        .env("SSH_ASKPASS", DISABLED_GIT_HELPER)
        .env("GIT_SSH_COMMAND", DISABLED_GIT_HELPER)
        .args([
            "-c",
            DISABLED_GIT_HOOKS_CONFIG,
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.sshCommand=/usr/bin/false",
            "-c",
            "credential.helper=",
            "-c",
            "credential.interactive=never",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.http.allow=always",
            "-c",
            "protocol.https.allow=always",
            "-c",
            // Local bare repositories are used by development/tests. Unknown
            // remote helpers (including ext::) remain denied.
            "protocol.file.allow=always",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "protocol.ssh.allow=never",
            "-c",
            "protocol.git.allow=never",
            "-c",
            "http.followRedirects=initial",
            "-c",
            "fetch.recurseSubmodules=false",
            "-c",
            "push.recurseSubmodules=no",
        ]);
    command
}

fn workspace_git_lock(workspace_root: &Path) -> Arc<Mutex<()>> {
    let mut locks = WORKSPACE_GIT_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(workspace_root.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[cfg(unix)]
fn pin_command_cwd(command: &mut Command, directory: &WorkspaceDir) -> Result<()> {
    let directory_fd = directory
        .duplicate_fd()
        .context("failed to pin command working directory")?;
    // SAFETY: the child-only hook performs one async-signal-safe `fchdir`
    // syscall against an already-open directory fd. It allocates nothing and
    // does not touch shared process state before exec.
    unsafe {
        command.pre_exec(move || {
            rustix::process::fchdir(&directory_fd)
                .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))
        });
    }
    Ok(())
}

#[cfg(windows)]
fn pin_command_cwd(command: &mut Command, directory: &WorkspaceDir) -> Result<()> {
    // Windows process spawning exposes only an ambient pathname for cwd, not
    // an inherited directory-handle-relative chdir operation. The surrounding
    // Git layout checks and every HTTP/apply filesystem operation remain
    // capability-handle-relative, but this pathname can still be raced by an
    // unrestricted local process. That is one reason self-hosted Team runtime
    // sharing remains disabled rather than treating this facade as an OS
    // sandbox.
    command.current_dir(directory.ambient_path());
    Ok(())
}

fn instafy_git_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".instafy").join(".git")
}

fn instafy_git_dir_has_config(workspace_root: &Path) -> bool {
    WorkspaceDir::open(workspace_root)
        .and_then(|workspace| workspace.open_file(".instafy/.git/config"))
        .is_ok()
}

fn validate_instafy_git_layout(workspace_root: &Path) -> Result<()> {
    let workspace = WorkspaceDir::open(workspace_root)
        .with_context(|| format!("failed to open workspace {:?}", workspace_root))?;
    for relative in [".instafy", ".instafy/.git"] {
        match workspace.entry_kind(relative) {
            Ok(WorkspaceEntryKind::Directory) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => anyhow::bail!("protected git path {relative:?} is not a directory"),
            Err(error) => {
                anyhow::bail!("protected git path {relative:?} is not safely contained: {error}")
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Eq, Ord, PartialEq, PartialOrd)]
struct TrustedGitConfigEntry {
    section: &'static str,
    subsection: Option<String>,
    name: &'static str,
    value: String,
}

fn normalized_git_bool(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some("true".to_string()),
        "false" | "no" | "off" | "0" => Some("false".to_string()),
        _ => None,
    }
}

fn trusted_git_config_entry(key: &str, value: &str) -> Option<TrustedGitConfigEntry> {
    let key = key.trim().to_ascii_lowercase();
    if let Some(name) = key.strip_prefix("core.") {
        let (name, value) = match name {
            "repositoryformatversion" if matches!(value.trim(), "0" | "1") => {
                ("repositoryformatversion", value.trim().to_string())
            }
            "filemode" => ("filemode", normalized_git_bool(value)?),
            "logallrefupdates" => ("logallrefupdates", normalized_git_bool(value)?),
            "ignorecase" => ("ignorecase", normalized_git_bool(value)?),
            "precomposeunicode" => ("precomposeunicode", normalized_git_bool(value)?),
            "symlinks" => ("symlinks", normalized_git_bool(value)?),
            // `core.worktree` and `core.bare` are forced by the sanitizer.
            // All executable/helper-bearing core keys are intentionally dropped.
            _ => return None,
        };
        return Some(TrustedGitConfigEntry {
            section: "core",
            subsection: None,
            name,
            value,
        });
    }

    if let Some(name) = key.strip_prefix("extensions.") {
        let (name, value) = match name {
            "objectformat" if matches!(value.trim(), "sha1" | "sha256") => {
                ("objectformat", value.trim().to_string())
            }
            "refstorage" if matches!(value.trim(), "files" | "reftable") => {
                ("refstorage", value.trim().to_string())
            }
            // In particular, do not preserve worktreeConfig: it would make
            // config.worktree another workspace-controlled config source.
            _ => return None,
        };
        return Some(TrustedGitConfigEntry {
            section: "extensions",
            subsection: None,
            name,
            value,
        });
    }

    if let Some(rest) = key.strip_prefix("remote.") {
        let (remote_name, name) = rest.rsplit_once('.')?;
        if remote_name.is_empty() {
            return None;
        }
        let value = match name {
            // Remote URLs are replaced from trusted ServerConfig before every
            // network operation. Protocol allowlisting on the command is a
            // second boundary against URL rewrites or remote helpers.
            "url" => value.to_string(),
            "fetch" => {
                let expected = format!("+refs/heads/*:refs/remotes/{remote_name}/*");
                if value.trim() != expected {
                    return None;
                }
                expected
            }
            _ => return None,
        };
        return Some(TrustedGitConfigEntry {
            section: "remote",
            subsection: Some(remote_name.to_string()),
            name: if name == "url" { "url" } else { "fetch" },
            value,
        });
    }

    if let Some(name) = key.strip_prefix("user.") {
        let name = match name {
            "name" => "name",
            "email" => "email",
            _ => return None,
        };
        return Some(TrustedGitConfigEntry {
            section: "user",
            subsection: None,
            name,
            value: value.to_string(),
        });
    }

    None
}

fn escape_git_config_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\t' => escaped.push_str("\\t"),
            '\u{8}' => escaped.push_str("\\b"),
            character => escaped.push(character),
        }
    }
    escaped
}

fn render_trusted_git_config(mut entries: Vec<TrustedGitConfigEntry>) -> String {
    entries.sort();
    entries.dedup();

    // Single-valued settings keep only their first parsed value. This prevents
    // a second remote URL or identity entry from surviving as a hidden
    // workspace-controlled fallback. The one validated fetch refspec is the
    // only multi-valued shape we retain, and exact duplicates were removed.
    let mut seen_single = HashSet::new();
    entries.retain(|entry| {
        if entry.section == "remote" && entry.name == "fetch" {
            return true;
        }
        seen_single.insert((entry.section, entry.subsection.clone(), entry.name))
    });

    let mut output = String::new();
    let mut current_section: Option<(&str, Option<&str>)> = None;
    for entry in &entries {
        let section = (entry.section, entry.subsection.as_deref());
        if current_section != Some(section) {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push('[');
            output.push_str(entry.section);
            if let Some(subsection) = entry.subsection.as_deref() {
                output.push_str(" \"");
                output.push_str(&escape_git_config_string(subsection));
                output.push('"');
            }
            output.push_str("]\n");
            current_section = Some(section);
        }
        output.push('\t');
        output.push_str(entry.name);
        output.push_str(" = \"");
        output.push_str(&escape_git_config_string(&entry.value));
        output.push_str("\"\n");
    }
    output
}

fn refresh_instafy_git_worktree_config(workspace_root: &Path) -> Result<()> {
    let config_path = instafy_git_dir(workspace_root).join("config");
    let workspace = WorkspaceDir::open(workspace_root)
        .with_context(|| format!("failed to open workspace {:?}", workspace_root))?;
    let mut config_file = match workspace.open_file(".instafy/.git/config") {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("protected git config is not safely contained"),
    };

    let mut existing = Vec::new();
    {
        use std::io::Read as _;
        config_file
            .read_to_end(&mut existing)
            .with_context(|| format!("failed to read git config {:?}", config_path))?;
    }

    // `.instafy/.git` is a reserved, service-owned boundary. Before any Git
    // operation, reduce its local config to data-only repository settings.
    // This removes includes, credential helpers, filters/process drivers,
    // fsmonitor/SSH commands, URL rewrites, aliases, diff/merge drivers, and
    // every other workspace-controlled executable setting. Atomic replacement
    // narrows races, but absolute isolation still requires this directory not
    // be writable by an attacker running as the same OS uid as the server.
    let mut command = server_git_command();
    pin_command_cwd(&mut command, &workspace)?;
    let parsed = command
        .arg("config")
        .arg("--file")
        .arg(".instafy/.git/config")
        .arg("--null")
        .arg("--list")
        .arg("--no-includes")
        .output()
        .with_context(|| format!("failed to inspect git config {:?}", config_path))?;
    if !parsed.status.success() {
        let stderr = String::from_utf8_lossy(&parsed.stderr);
        anyhow::bail!(
            "failed to inspect git config {:?}: {}",
            config_path,
            stderr.trim()
        );
    }

    let mut entries = Vec::new();
    for raw_entry in parsed.stdout.split(|byte| *byte == 0) {
        if raw_entry.is_empty() {
            continue;
        }
        let entry = std::str::from_utf8(raw_entry)
            .with_context(|| format!("git config {:?} contains invalid UTF-8", config_path))?;
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        if let Some(entry) = trusted_git_config_entry(key, value) {
            entries.push(entry);
        }
    }
    entries.retain(|entry| !(entry.section == "core" && entry.name == "bare"));
    entries.push(TrustedGitConfigEntry {
        section: "core",
        subsection: None,
        name: "bare",
        value: "false".to_string(),
    });
    entries.push(TrustedGitConfigEntry {
        section: "core",
        subsection: None,
        name: "worktree",
        value: workspace_root.to_string_lossy().to_string(),
    });

    let sanitized = render_trusted_git_config(entries);
    if existing == sanitized.as_bytes() {
        return Ok(());
    }

    let git_dir = config_path.parent().context("git config has no parent")?;
    let original_permissions = std::fs::metadata(&config_path)?.permissions();
    let mut replacement = NamedTempFile::new_in(git_dir)
        .with_context(|| format!("failed to create sanitized git config in {git_dir:?}"))?;
    replacement.write_all(sanitized.as_bytes())?;
    replacement.flush()?;
    replacement
        .as_file()
        .set_permissions(original_permissions)?;
    replacement.as_file().sync_all()?;
    replacement
        .persist(&config_path)
        .map_err(|error| error.error)
        .with_context(|| format!("failed to replace git config {:?}", config_path))?;
    sync_directory(git_dir)?;

    Ok(())
}

fn remove_instafy_git_dir(workspace_root: &Path) -> Result<(), String> {
    let workspace = WorkspaceDir::open(workspace_root)
        .map_err(|error| format!("failed to open workspace: {error}"))?;
    match workspace.remove(".instafy/.git") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to remove protected git dir: {error}")),
    }

    Ok(())
}

fn is_git_repo(workspace_root: &Path) -> bool {
    let has_contained_git_dir = WorkspaceDir::open(workspace_root)
        .and_then(|workspace| workspace.entry_kind(".instafy/.git"))
        .is_ok_and(|kind| kind == WorkspaceEntryKind::Directory);
    if !has_contained_git_dir {
        return false;
    }
    git_status_success(workspace_root, &["rev-parse", "--git-dir"]).unwrap_or(false)
}

fn workspace_dir_empty(workspace_root: &Path) -> Result<bool> {
    let entries = std::fs::read_dir(workspace_root)
        .with_context(|| format!("failed to read workspace dir {:?}", workspace_root))?;
    for entry in entries {
        let entry =
            entry.with_context(|| format!("failed to read workspace dir {:?}", workspace_root))?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name == ".instafy" || name == ".git" || name == ".DS_Store" {
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

fn run_git(workspace_root: &Path, args: &[&str], bearer_token: Option<&str>) -> Result<Output> {
    validate_instafy_git_layout(workspace_root)?;
    refresh_instafy_git_worktree_config(workspace_root)?;
    let workspace = WorkspaceDir::open(workspace_root)
        .with_context(|| format!("failed to open workspace {:?}", workspace_root))?;

    let mut command = server_git_command();
    pin_command_cwd(&mut command, &workspace)?;
    command
        .arg("--git-dir")
        .arg(".instafy/.git")
        .arg("--work-tree")
        .arg(".");
    if let Some(token) = bearer_token {
        let header = format!("http.extraHeader=Authorization: Bearer {token}");
        command.args(["-c", header.as_str()]);
    }
    command
        .args(args)
        .output()
        .with_context(|| format!("failed to run git command {:?}", args))
}

fn run_git_ok(workspace_root: &Path, args: &[&str], bearer_token: Option<&str>) -> Result<Output> {
    let lock = workspace_git_lock(workspace_root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut lock_wait_attempts = 0usize;
    let mut http_attempts = 0usize;
    loop {
        let output = run_git(workspace_root, args, bearer_token)?;
        if output.status.success() {
            return Ok(output);
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let looks_like_lock_error = stderr.contains("index.lock")
            && (stderr.contains("File exists") || stderr.contains("Unable to create"));
        let looks_like_config_lock_error = stderr.contains("could not lock config file")
            && (stderr.contains("File exists") || stderr.contains("Unable to create"));
        let looks_like_ref_lock_error = stderr.contains("cannot lock ref '")
            && stderr.contains("refs/")
            && (stderr.contains("reference already exists")
                || stderr.contains("File exists")
                || stderr.contains("Unable to create"));
        let looks_like_concurrent_git = stderr.contains("Another git process seems to be running");

        // Lockfiles and ref paths may belong to a live Git process. Never
        // delete workspace Git state based only on stderr text; bounded retry
        // is safe, and the caller receives the conflict/error if it persists.
        if (looks_like_lock_error
            || looks_like_config_lock_error
            || looks_like_ref_lock_error
            || looks_like_concurrent_git)
            && lock_wait_attempts < 4
        {
            let delay_ms = 50_u64.saturating_mul(1_u64 << lock_wait_attempts);
            std::thread::sleep(Duration::from_millis(delay_ms));
            lock_wait_attempts += 1;
            continue;
        }

        if http_attempts < 2
            && is_network_git_command(args)
            && looks_like_transient_http_error(&stderr)
        {
            let delay_ms = 250_u64.saturating_mul(1_u64 << http_attempts);
            std::thread::sleep(Duration::from_millis(delay_ms));
            http_attempts += 1;
            continue;
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        anyhow::bail!(
            "git command failed ({:?}): {}{}",
            args,
            stdout.trim(),
            if stderr.trim().is_empty() {
                "".to_string()
            } else {
                format!("\n{}", stderr.trim())
            }
        );
    }
}

fn git_status_success(workspace_root: &Path, args: &[&str]) -> Result<bool> {
    validate_instafy_git_layout(workspace_root)?;
    refresh_instafy_git_worktree_config(workspace_root)?;
    let workspace = WorkspaceDir::open(workspace_root)
        .with_context(|| format!("failed to open workspace {:?}", workspace_root))?;
    let mut command = server_git_command();
    pin_command_cwd(&mut command, &workspace)?;
    let status = command
        .arg("--git-dir")
        .arg(".instafy/.git")
        .arg("--work-tree")
        .arg(".")
        .args(args)
        .status()
        .with_context(|| format!("failed to run git status check {:?}", args))?;
    Ok(status.success())
}

fn has_tracked_worktree_changes(workspace_root: &Path, bearer_token: Option<&str>) -> Result<bool> {
    let output = run_git_ok(
        workspace_root,
        &[
            "status",
            "--porcelain",
            "--untracked-files=no",
            "--ignore-submodules=all",
        ],
        bearer_token,
    )?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn is_network_git_command(args: &[&str]) -> bool {
    matches!(
        args.first().copied().unwrap_or_default(),
        "fetch" | "pull" | "push" | "ls-remote" | "remote"
    )
}

fn stage_applied_paths(
    workspace_root: &Path,
    applied_paths: &[String],
    bearer_token: Option<&str>,
) -> Result<(), OriginError> {
    if applied_paths.is_empty() {
        return Ok(());
    }

    for chunk in applied_paths.chunks(GIT_STAGE_CHUNK_SIZE) {
        let mut args: Vec<&str> = Vec::with_capacity(3 + chunk.len());
        args.push("add");
        args.push("--force");
        args.push("--");
        for path in chunk {
            args.push(path.as_str());
        }
        run_git_ok(workspace_root, &args, bearer_token)
            .map_err(|error| OriginError::internal(error.to_string()))?;
    }

    Ok(())
}

fn stage_deleted_paths(
    workspace_root: &Path,
    deleted_paths: &[String],
    bearer_token: Option<&str>,
) -> Result<(), OriginError> {
    if deleted_paths.is_empty() {
        return Ok(());
    }

    for chunk in deleted_paths.chunks(GIT_STAGE_CHUNK_SIZE) {
        let mut args: Vec<&str> = Vec::with_capacity(4 + chunk.len());
        args.push("rm");
        args.push("-r");
        args.push("--ignore-unmatch");
        args.push("--");
        for path in chunk {
            args.push(path.as_str());
        }
        run_git_ok(workspace_root, &args, bearer_token)
            .map_err(|error| OriginError::internal(error.to_string()))?;
    }

    Ok(())
}

fn unstage_sync_reserved_paths(
    workspace_root: &Path,
    bearer_token: Option<&str>,
) -> Result<String, OriginError> {
    let staged = git_stdout(
        workspace_root,
        &["diff", "--cached", "--name-only"],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    let reserved = staged
        .lines()
        .filter(|path| is_sync_reserved_path(path))
        .collect::<Vec<_>>();
    if reserved.is_empty() {
        return Ok(staged);
    }

    for chunk in reserved.chunks(GIT_STAGE_CHUNK_SIZE) {
        let mut args: Vec<&str> = Vec::with_capacity(2 + chunk.len());
        args.push("reset");
        args.push("--");
        for path in chunk {
            args.push(path);
        }
        run_git_ok(workspace_root, &args, bearer_token)
            .map_err(|error| OriginError::internal(error.to_string()))?;
    }

    git_stdout(
        workspace_root,
        &["diff", "--cached", "--name-only"],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))
}

fn looks_like_transient_http_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    for code in ["500", "502", "503", "504"] {
        if lower.contains(&format!("http {code}")) {
            return true;
        }
        if lower.contains(&format!("error: {code}")) {
            return true;
        }
        if lower.contains(&format!("returned error: {code}")) {
            return true;
        }
    }
    false
}

fn git_stdout(workspace_root: &Path, args: &[&str], bearer_token: Option<&str>) -> Result<String> {
    let output = run_git_ok(workspace_root, args, bearer_token)?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn remote_exists(
    workspace_root: &Path,
    remote_name: &str,
    bearer_token: Option<&str>,
) -> Result<bool> {
    let output = run_git(workspace_root, &["remote"], bearer_token)?;
    if !output.status.success() {
        return Ok(false);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().any(|line| line.trim() == remote_name))
}

fn align_local_branch_to_remote_tip_preserving_worktree(
    config: &ServerConfig,
    workspace_root: &Path,
    bearer_token: Option<&str>,
) -> Result<(), OriginError> {
    run_git_ok(
        workspace_root,
        &[
            "fetch",
            "--prune",
            &config.git_remote_name,
            &config.git_branch,
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
    let has_remote_branch = git_status_success(
        workspace_root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{}", remote_branch),
        ],
    )
    .unwrap_or(false);

    if !has_remote_branch {
        return Ok(());
    }

    let has_head =
        git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"]).unwrap_or(false);
    if !has_head {
        run_git_ok(
            workspace_root,
            &["checkout", "-B", &config.git_branch, &remote_branch],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;
        return Ok(());
    }

    let remote_is_ancestor_of_head = git_status_success(
        workspace_root,
        &["merge-base", "--is-ancestor", &remote_branch, "HEAD"],
    )
    .unwrap_or(false);
    if remote_is_ancestor_of_head {
        return Ok(());
    }

    run_git_ok(
        workspace_root,
        &["reset", "--mixed", &remote_branch],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    Ok(())
}

fn discard_local_sync_commit_preserving_worktree(
    workspace_root: &Path,
    remote_branch: &str,
    bearer_token: Option<&str>,
) {
    let _ = run_git(
        workspace_root,
        &["reset", "--mixed", remote_branch],
        bearer_token,
    );
}

struct EmbeddedGitDirGuard {
    workspace: WorkspaceDir,
    renames: Vec<(String, String)>,
}

impl EmbeddedGitDirGuard {
    fn hide(workspace_root: &Path, paths: &[&str]) -> Result<Self> {
        let workspace = WorkspaceDir::open(workspace_root)
            .with_context(|| format!("failed to open workspace {:?}", workspace_root))?;
        let staging_base = ".instafy/origin-staging/embedded-git";
        workspace
            .create_dir_all(staging_base)
            .context("failed to create embedded git staging dir")?;
        let mut candidates: HashSet<String> = HashSet::new();

        for path in paths {
            let mut cursor = Path::new(path);
            loop {
                if cursor.as_os_str().is_empty() {
                    break;
                }

                let candidate = format!("{}/.git", cursor.to_string_lossy().replace('\\', "/"));
                if matches!(
                    workspace.entry_kind(&candidate),
                    Ok(WorkspaceEntryKind::Directory)
                ) {
                    candidates.insert(candidate);
                }

                match cursor.parent() {
                    Some(parent) => cursor = parent,
                    None => break,
                }
            }
        }

        let mut candidates = candidates.into_iter().collect::<Vec<_>>();
        candidates.sort_by(|a, b| b.split('/').count().cmp(&a.split('/').count()));

        let mut renames = Vec::new();
        for candidate in candidates {
            let mut hidden = format!("{staging_base}/{}", Uuid::new_v4());
            for _ in 0..8 {
                if workspace.entry_kind(&hidden).is_err() {
                    break;
                }
                hidden = format!("{staging_base}/{}", Uuid::new_v4());
            }
            workspace.rename(&candidate, &hidden).with_context(|| {
                format!(
                    "failed to hide embedded git dir {:?} -> {:?}",
                    candidate, hidden
                )
            })?;
            renames.push((candidate, hidden));
        }

        Ok(Self { workspace, renames })
    }
}

impl Drop for EmbeddedGitDirGuard {
    fn drop(&mut self) {
        for (original, hidden) in self.renames.iter().rev() {
            let _ = self.workspace.rename(hidden, original);
        }
    }
}

pub fn ensure_git_checkout(
    config: &ServerConfig,
    bearer_token: Option<&str>,
) -> Result<(), OriginError> {
    let Some(remote_url) = config.git_remote_url.as_deref() else {
        return Ok(());
    };

    let workspace_root = config.workspace_root.as_path();
    validate_instafy_git_layout(workspace_root)
        .map_err(|error| OriginError::internal(error.to_string()))?;
    maybe_migrate_legacy_git_dir(workspace_root, &config.git_remote_name, remote_url)
        .map_err(|error| OriginError::internal(error.to_string()))?;
    let mut stale_cleanup_error: Option<String> = None;
    let instafy_git_dir_exists = WorkspaceDir::open(workspace_root)
        .and_then(|workspace| workspace.entry_kind(".instafy/.git"))
        .is_ok_and(|kind| kind == WorkspaceEntryKind::Directory);
    if instafy_git_dir_exists && !instafy_git_dir_has_config(workspace_root) {
        if let Err(error) = remove_instafy_git_dir(workspace_root) {
            stale_cleanup_error = Some(error);
        }
    }
    if is_git_repo(workspace_root) {
        // Ensure the expected remote exists and always points at the configured URL.
        //
        // Hosted runtimes can reuse a persisted `.instafy/.git` across restarts while the
        // controller-side git service endpoint changes (e.g. `git-edge` → `host.docker.internal`).
        // If we only check that the remote *name* exists, `git fetch` can keep hitting a stale URL
        // forever, preventing the origin server from starting.
        let has_remote =
            remote_exists(workspace_root, &config.git_remote_name, bearer_token).unwrap_or(false);
        if has_remote {
            run_git_ok(
                workspace_root,
                &["remote", "set-url", &config.git_remote_name, remote_url],
                bearer_token,
            )
            .map_err(|error| OriginError::internal(error.to_string()))?;
        } else {
            match run_git_ok(
                workspace_root,
                &["remote", "add", &config.git_remote_name, remote_url],
                bearer_token,
            ) {
                Ok(_) => {}
                Err(error) => {
                    let message = error.to_string().to_ascii_lowercase();
                    if message.contains("already exists") && message.contains("remote") {
                        run_git_ok(
                            workspace_root,
                            &["remote", "set-url", &config.git_remote_name, remote_url],
                            bearer_token,
                        )
                        .map_err(|error| OriginError::internal(error.to_string()))?;
                    } else {
                        return Err(OriginError::internal(error.to_string()));
                    }
                }
            }
        }

        run_git_ok(
            workspace_root,
            &["fetch", "--prune", &config.git_remote_name],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        // Ensure the branch is checked out (or created from the remote tracking ref).
        let local_branch_ref = format!("refs/heads/{}", config.git_branch);
        let has_local_branch = git_status_success(
            workspace_root,
            &["show-ref", "--verify", "--quiet", &local_branch_ref],
        )
        .unwrap_or(false);

        if has_local_branch {
            run_git_ok(
                workspace_root,
                &["checkout", &config.git_branch],
                bearer_token,
            )
            .map_err(|error| OriginError::internal(error.to_string()))?;

            let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
            let remote_branch_ref = format!("refs/remotes/{}", remote_branch);
            let has_remote_branch = git_status_success(
                workspace_root,
                &["show-ref", "--verify", "--quiet", &remote_branch_ref],
            )
            .unwrap_or(false);

            // If the branch exists but is still "unborn" (no commits yet), and the remote
            // branch now has commits, reset to the remote tip so later operations (rebase/push)
            // have a valid HEAD.
            let has_head = git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"])
                .unwrap_or(false);
            if !has_head {
                if has_remote_branch {
                    run_git_ok(
                        workspace_root,
                        &["checkout", "-B", &config.git_branch, &remote_branch],
                        bearer_token,
                    )
                    .map_err(|error| OriginError::internal(error.to_string()))?;
                }
            } else if has_remote_branch
                && !has_tracked_worktree_changes(workspace_root, bearer_token)
                    .map_err(|error| OriginError::internal(error.to_string()))?
            {
                // Keep read/list calls in sync with remote updates (for example, external pushes).
                // We only fast-forward when tracked workspace files are clean.
                let ff_merge = run_git(
                    workspace_root,
                    &["merge", "--ff-only", &remote_branch],
                    bearer_token,
                )
                .map_err(|error| OriginError::internal(error.to_string()))?;
                if !ff_merge.status.success() {
                    let stderr = String::from_utf8_lossy(&ff_merge.stderr).to_ascii_lowercase();
                    // Ignore non-FF/diverged states here; write/sync paths handle conflicts explicitly.
                    let ignorable = stderr.contains("not possible to fast-forward")
                        || stderr.contains("refusing to merge unrelated histories")
                        || stderr.contains("would be overwritten by merge");
                    if !ignorable {
                        return Err(OriginError::internal(format!(
                            "git fast-forward merge failed: {}",
                            String::from_utf8_lossy(&ff_merge.stderr).trim()
                        )));
                    }
                }
            }
        } else {
            let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
            let remote_branch_ref = format!("refs/remotes/{}", remote_branch);
            let has_remote_branch = git_status_success(
                workspace_root,
                &["show-ref", "--verify", "--quiet", &remote_branch_ref],
            )
            .unwrap_or(false);

            if has_remote_branch {
                run_git_ok(
                    workspace_root,
                    &["checkout", "-B", &config.git_branch, &remote_branch],
                    bearer_token,
                )
                .map_err(|error| OriginError::internal(error.to_string()))?;
            } else {
                // Empty remotes can report success on fetch but have no branch tips yet.
                // Keep the local branch "unborn" so /git/sync can push the first commit.
                run_git_ok(
                    workspace_root,
                    &["checkout", "-B", &config.git_branch],
                    bearer_token,
                )
                .map_err(|error| OriginError::internal(error.to_string()))?;
            }
        }
    } else {
        // Fresh checkout into an explicit gitdir to avoid a `.git/` directory in the workspace.
        if !workspace_dir_empty(workspace_root)
            .map_err(|error| OriginError::internal(error.to_string()))?
        {
            return Err(OriginError::internal(
                "workspace root is not empty but ORIGIN_GIT_REMOTE_URL is set".to_string(),
            ));
        }

        WorkspaceDir::open(workspace_root)
            .and_then(|workspace| workspace.create_dir_all(".instafy"))
            .with_context(|| format!("failed to create .instafy dir in {:?}", workspace_root))
            .map_err(|error| OriginError::internal(error.to_string()))?;
        if stale_cleanup_error.is_none() {
            if let Err(error) = remove_instafy_git_dir(workspace_root) {
                stale_cleanup_error = Some(error);
            }
        }

        run_git_ok(
            workspace_root,
            &["init", "-b", &config.git_branch],
            bearer_token,
        )
        .map_err(|error| {
            let mut message = error.to_string();
            if let Some(cleanup_error) = stale_cleanup_error {
                message = format!(
                    "git init failed after stale gitdir cleanup error ({cleanup_error}): {message}"
                );
            }
            OriginError::internal(message)
        })?;

        match run_git_ok(
            workspace_root,
            &["remote", "add", &config.git_remote_name, remote_url],
            bearer_token,
        ) {
            Ok(_) => {}
            Err(error) => {
                let message = error.to_string().to_ascii_lowercase();
                if message.contains("already exists") && message.contains("remote") {
                    run_git_ok(
                        workspace_root,
                        &["remote", "set-url", &config.git_remote_name, remote_url],
                        bearer_token,
                    )
                    .map_err(|error| OriginError::internal(error.to_string()))?;
                } else {
                    return Err(OriginError::internal(error.to_string()));
                }
            }
        }

        run_git_ok(
            workspace_root,
            &["fetch", "--prune", &config.git_remote_name],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
        let remote_branch_ref = format!("refs/remotes/{}", remote_branch);
        let has_remote_branch = git_status_success(
            workspace_root,
            &["show-ref", "--verify", "--quiet", &remote_branch_ref],
        )
        .unwrap_or(false);
        if has_remote_branch {
            run_git_ok(
                workspace_root,
                &["checkout", "-B", &config.git_branch, &remote_branch],
                bearer_token,
            )
            .map_err(|error| OriginError::internal(error.to_string()))?;
        } else {
            // Fresh + empty remote: leave the local branch unborn until first sync.
            run_git_ok(
                workspace_root,
                &["checkout", "-B", &config.git_branch],
                bearer_token,
            )
            .map_err(|error| OriginError::internal(error.to_string()))?;
        }
    }

    // Ensure author identity is configured (repo-local) so `git commit` is stable.
    let _ = run_git_ok(
        workspace_root,
        &["config", "user.name", &config.git_author_name],
        bearer_token,
    );
    let _ = run_git_ok(
        workspace_root,
        &["config", "user.email", &config.git_author_email],
        bearer_token,
    );

    let _ = ensure_instafy_info_exclude(workspace_root);

    Ok(())
}

fn ensure_instafy_info_exclude(workspace_root: &Path) -> Result<()> {
    let workspace = WorkspaceDir::open(workspace_root)
        .with_context(|| format!("failed to open workspace {:?}", workspace_root))?;
    workspace
        .create_dir_all(".instafy/.git/info")
        .context("failed to create protected git info dir")?;
    let existing = workspace
        .open_file(".instafy/.git/info/exclude")
        .and_then(|mut file| {
            let mut value = String::new();
            use std::io::Read as _;
            file.read_to_string(&mut value)?;
            Ok(value)
        })
        .unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let deprecated_patterns = ["/AGENTS.md", "/AGENTS.py", "/INSTAFY.md", "/learnings/"];
    let mut removed_deprecated = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if deprecated_patterns
            .iter()
            .any(|pattern| trimmed.eq_ignore_ascii_case(pattern))
        {
            removed_deprecated = true;
            continue;
        }
        lines.push(line.to_string());
    }

    let patterns = [
        "# Instafy workspace metadata (auto-added)",
        "/.instafy/space.json",
        "/.codex/",
        "/.codex-runtime-fallback/",
        "/.agents/.instafy-managed-defaults-state.json",
    ];

    let mut changed = false;
    if removed_deprecated {
        changed = true;
    }
    for pattern in patterns {
        let trimmed = pattern.trim();
        if trimmed.is_empty() {
            continue;
        }
        let already_present = lines
            .iter()
            .any(|line| line.trim().eq_ignore_ascii_case(trimmed));
        if already_present {
            continue;
        }
        lines.push(trimmed.to_string());
        changed = true;
    }

    if !changed {
        return Ok(());
    }

    let mut out = lines.join("\n");
    out.push('\n');
    let mut contents = out.as_bytes();
    workspace
        .replace_file(".instafy/.git/info/exclude", &mut contents, false)
        .context("failed to write protected git exclude file")?;
    Ok(())
}

pub fn cleanup_origin_staging(workspace_root: &Path) -> Result<(), OriginError> {
    let workspace = WorkspaceDir::open(workspace_root)
        .map_err(|error| OriginError::internal(format!("failed to open workspace: {error}")))?;
    match workspace.remove(".instafy/origin-staging") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(OriginError::internal(format!(
                "failed to remove origin staging dir: {error}"
            )))
        }
    }
    workspace
        .create_dir_all(".instafy/origin-staging")
        .map_err(|error| {
            OriginError::internal(format!("failed to recreate origin staging dir: {error}"))
        })?;

    Ok(())
}

fn maybe_migrate_legacy_git_dir(
    workspace_root: &Path,
    remote_name: &str,
    remote_url: &str,
) -> Result<()> {
    let workspace = WorkspaceDir::open(workspace_root)
        .with_context(|| format!("failed to open workspace {:?}", workspace_root))?;
    if matches!(
        workspace.entry_kind(".instafy/.git"),
        Ok(WorkspaceEntryKind::Directory)
    ) {
        return Ok(());
    }

    if !matches!(
        workspace.entry_kind(".git"),
        Ok(WorkspaceEntryKind::Directory)
    ) {
        return Ok(());
    }

    let mut command = server_git_command();
    pin_command_cwd(&mut command, &workspace)?;
    let output = command
        .args(["remote", "get-url", remote_name])
        .output()
        .with_context(|| format!("failed to query legacy git remote {remote_name:?}"))?;
    if !output.status.success() {
        return Ok(());
    }

    let legacy_remote = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if legacy_remote.trim_end_matches('/') != remote_url.trim().trim_end_matches('/') {
        return Ok(());
    }

    workspace
        .create_dir_all(".instafy")
        .context("failed to create protected instafy dir")?;
    workspace
        .rename(".git", ".instafy/.git")
        .context("failed to migrate legacy git dir into protected metadata")?;

    Ok(())
}

pub fn commit_and_push_apply(
    config: &ServerConfig,
    workspace_root: &Path,
    applied_paths: &[String],
    deleted_paths: &[String],
    message: &str,
    bearer_token: Option<&str>,
) -> Result<String, OriginError> {
    let Some(_remote_url) = config.git_remote_url.as_deref() else {
        return Err(OriginError::internal(
            "commit_and_push_apply called without git remote configured",
        ));
    };

    let mut touched = Vec::with_capacity(applied_paths.len() + deleted_paths.len());
    for path in applied_paths {
        touched.push(path.as_str());
    }
    for path in deleted_paths {
        touched.push(path.as_str());
    }
    let _embedded_guard = EmbeddedGitDirGuard::hide(workspace_root, &touched)
        .map_err(|error| OriginError::internal(error.to_string()))?;

    stage_applied_paths(workspace_root, applied_paths, bearer_token)?;
    stage_deleted_paths(workspace_root, deleted_paths, bearer_token)?;

    let staged = unstage_sync_reserved_paths(workspace_root, bearer_token)?;
    if staged.trim().is_empty() {
        let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
            .unwrap_or_else(|_| "unknown".to_string());
        return Ok(head);
    }

    run_git_ok(
        workspace_root,
        &["commit", "--no-gpg-sign", "-m", message],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    // Human-like loop: fetch → rebase if needed → fast-forward push, retry once on race.
    let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
    for attempt in 0..2 {
        run_git_ok(
            workspace_root,
            &[
                "fetch",
                "--prune",
                &config.git_remote_name,
                &config.git_branch,
            ],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        let has_remote_branch = git_status_success(
            workspace_root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{}", remote_branch),
            ],
        )
        .unwrap_or(false);

        if has_remote_branch {
            let has_head = git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"])
                .unwrap_or(false);
            if !has_head {
                // If the local branch is "unborn" but the remote branch exists, fast-forward the
                // local checkout to the remote tip before attempting merge-base/rebase checks.
                run_git_ok(
                    workspace_root,
                    &["checkout", "-B", &config.git_branch, &remote_branch],
                    bearer_token,
                )
                .map_err(|error| OriginError::internal(error.to_string()))?;
            }

            let is_fast_forward_ok = git_status_success(
                workspace_root,
                &["merge-base", "--is-ancestor", &remote_branch, "HEAD"],
            )
            .unwrap_or(false);

            if !is_fast_forward_ok {
                let output = run_git(workspace_root, &["rebase", &remote_branch], bearer_token)
                    .map_err(|error| OriginError::internal(error.to_string()))?;
                if !output.status.success() {
                    let _ = run_git(workspace_root, &["rebase", "--abort"], bearer_token);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(OriginError::conflict(format!(
                        "git rebase onto {remote_branch} failed: {}",
                        stderr.trim()
                    )));
                }
            }
        }

        let dest_ref = format!("HEAD:refs/heads/{}", config.git_branch);
        let push = run_git(
            workspace_root,
            &["push", &config.git_remote_name, &dest_ref],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        if push.status.success() {
            break;
        }

        let stderr = String::from_utf8_lossy(&push.stderr);
        let looks_like_non_ff = stderr.contains("non-fast-forward")
            || stderr.contains("fetch first")
            || stderr.contains("[rejected]");

        if looks_like_non_ff && attempt == 0 {
            continue;
        }

        if looks_like_non_ff {
            discard_local_sync_commit_preserving_worktree(
                workspace_root,
                &remote_branch,
                bearer_token,
            );
            return Err(OriginError::conflict(format!(
                "git push rejected (non-fast-forward): {}",
                stderr.trim()
            )));
        }

        discard_local_sync_commit_preserving_worktree(workspace_root, &remote_branch, bearer_token);
        return Err(OriginError::internal(format!(
            "git push failed: {}",
            stderr.trim()
        )));
    }

    let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
        .map_err(|error| OriginError::internal(error.to_string()))?;
    Ok(head)
}

pub fn commit_apply_locally(
    workspace_root: &Path,
    applied_paths: &[String],
    deleted_paths: &[String],
    message: &str,
    bearer_token: Option<&str>,
) -> Result<Option<String>, OriginError> {
    if !is_git_repo(workspace_root) {
        return Ok(None);
    }

    // Snapshot the real index before clearing it. The import commit is built
    // from only its own paths; afterward the original index is restored and
    // just those touched entries are advanced to the new HEAD. This preserves
    // unrelated staged content byte-for-byte, including partial staging.
    let base_head = optional_head_rev(workspace_root, bearer_token)?;
    let mut index_snapshot = GitIndexSnapshot::capture(workspace_root)?;
    let operation = (|| -> Result<Option<String>, OriginError> {
        let reset_args = if base_head.is_some() {
            &["reset", "--mixed", "HEAD"][..]
        } else {
            &["read-tree", "--empty"][..]
        };
        run_git_ok(workspace_root, reset_args, bearer_token)
            .map_err(|error| OriginError::internal(error.to_string()))?;

        let mut touched = Vec::with_capacity(applied_paths.len() + deleted_paths.len());
        touched.extend(applied_paths.iter().map(String::as_str));
        touched.extend(deleted_paths.iter().map(String::as_str));
        let _embedded_guard = EmbeddedGitDirGuard::hide(workspace_root, &touched)
            .map_err(|error| OriginError::internal(error.to_string()))?;

        stage_applied_paths(workspace_root, applied_paths, bearer_token)?;
        stage_deleted_paths(workspace_root, deleted_paths, bearer_token)?;

        let staged = unstage_sync_reserved_paths(workspace_root, bearer_token)?;
        if staged.trim().is_empty() {
            index_snapshot.restore_original()?;
            return Ok(base_head.clone());
        }

        run_git_ok(
            workspace_root,
            &["commit", "--no-gpg-sign", "-m", message],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
            .map_err(|error| OriginError::internal(error.to_string()))?;
        index_snapshot.restore_original()?;
        reset_index_paths_to_head(workspace_root, &touched, bearer_token)?;
        maybe_fail_commit_apply_after_path_reset()?;
        index_snapshot.flush_after_path_reset()?;
        Ok(Some(head))
    })();

    match operation {
        Ok(head) => Ok(head),
        Err(operation_error) => {
            if let Err(rollback_error) = rollback_failed_local_apply_commit(
                workspace_root,
                base_head.as_deref(),
                bearer_token,
                &mut index_snapshot,
            ) {
                return Err(OriginError::internal(format!(
                    "local apply commit failed ({operation_error}); rollback also failed: {rollback_error}"
                )));
            }
            Err(operation_error)
        }
    }
}

fn optional_head_rev(
    workspace_root: &Path,
    bearer_token: Option<&str>,
) -> Result<Option<String>, OriginError> {
    let output = run_git(
        workspace_root,
        &["rev-parse", "--verify", "HEAD"],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    if output.status.success() {
        let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if is_safe_git_rev(&head) {
            return Ok(Some(head));
        }
        return Err(OriginError::internal(
            "git HEAD resolved to an invalid commit id",
        ));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let unborn = stderr.contains("needed a single revision")
        || stderr.contains("ambiguous argument 'head'")
        || stderr.contains("unknown revision")
        || stderr.contains("bad revision 'head'");
    if unborn {
        return Ok(None);
    }
    Err(OriginError::internal(format!(
        "failed to resolve git HEAD: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

fn rollback_failed_local_apply_commit(
    workspace_root: &Path,
    base_head: Option<&str>,
    bearer_token: Option<&str>,
    index_snapshot: &mut GitIndexSnapshot,
) -> Result<()> {
    // The route-level workspace lock guarantees that a changed HEAD here was
    // produced by this apply attempt. CAS on the observed commit still keeps a
    // surprising concurrent ref update from being overwritten silently.
    let current_head = optional_head_rev(workspace_root, bearer_token)
        .map_err(|error| anyhow::anyhow!(error.to_string()));
    let head_rollback = match current_head {
        Err(error) => Err(error),
        Ok(current_head) => match (base_head, current_head.as_deref()) {
            (Some(base), Some(current)) if !base.eq_ignore_ascii_case(current) => run_git_ok(
                workspace_root,
                &["update-ref", "HEAD", base, current],
                bearer_token,
            )
            .map(|_| ()),
            (None, Some(current)) => run_git_ok(
                workspace_root,
                &["update-ref", "-d", "HEAD", current],
                bearer_token,
            )
            .map(|_| ()),
            (Some(_), None) => Err(anyhow::anyhow!(
                "git HEAD disappeared while rolling back local apply commit"
            )),
            _ => Ok(()),
        },
    };
    // Always put the exact captured index back, even if it had already been
    // restored and then partially rewritten while advancing touched paths.
    let index_rollback = index_snapshot.restore_original_again();
    match (head_rollback, index_rollback) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(head_error), Ok(())) => Err(head_error.context("failed to restore apply HEAD")),
        (Ok(()), Err(index_error)) => {
            Err(anyhow::anyhow!(index_error.to_string()).context("failed to restore apply index"))
        }
        (Err(head_error), Err(index_error)) => {
            anyhow::bail!("failed to restore apply HEAD ({head_error}) and index ({index_error})")
        }
    }
}

#[cfg(test)]
thread_local! {
    static FAIL_COMMIT_APPLY_AFTER_PATH_RESET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn maybe_fail_commit_apply_after_path_reset() -> Result<(), OriginError> {
    let should_fail = FAIL_COMMIT_APPLY_AFTER_PATH_RESET.with(|flag| flag.replace(false));
    if should_fail {
        return Err(OriginError::internal(
            "injected local apply failure after commit",
        ));
    }
    Ok(())
}

#[cfg(not(test))]
fn maybe_fail_commit_apply_after_path_reset() -> Result<(), OriginError> {
    Ok(())
}

struct GitIndexSnapshot {
    index_path: PathBuf,
    backup: NamedTempFile,
    index_existed: bool,
    index_permissions: Option<Permissions>,
    restored: bool,
}

impl GitIndexSnapshot {
    fn capture(workspace_root: &Path) -> Result<Self, OriginError> {
        let git_dir = instafy_git_dir(workspace_root);
        let index_path = git_dir.join("index");
        let backup = NamedTempFile::new_in(&git_dir).map_err(|error| {
            OriginError::internal(format!("failed to create git index backup: {error}"))
        })?;
        let index_metadata = match std::fs::metadata(&index_path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => {
                return Err(OriginError::internal(format!(
                    "failed to inspect git index: {error}"
                )))
            }
        };
        let index_existed = index_metadata.is_some();
        let index_permissions = index_metadata.map(|metadata| metadata.permissions());
        if index_existed {
            std::fs::copy(&index_path, backup.path()).map_err(|error| {
                OriginError::internal(format!("failed to snapshot git index: {error}"))
            })?;
            backup.as_file().sync_all().map_err(|error| {
                OriginError::internal(format!("failed to flush git index backup: {error}"))
            })?;
        }
        Ok(Self {
            index_path,
            backup,
            index_existed,
            index_permissions,
            restored: false,
        })
    }

    fn restore_original(&mut self) -> Result<(), OriginError> {
        self.restore().map_err(|error| {
            OriginError::internal(format!("failed to restore original git index: {error}"))
        })
    }

    fn restore_original_again(&mut self) -> Result<(), OriginError> {
        self.restored = false;
        self.restore_original()
    }

    /// `reset_index_paths_to_head` intentionally rewrites the restored index
    /// after the atomic replacement. Reapply the original permissions and
    /// durably flush that final index state as well.
    fn flush_after_path_reset(&self) -> Result<(), OriginError> {
        let flush = || -> Result<()> {
            match File::open(&self.index_path) {
                Ok(index) => {
                    if let Some(permissions) = self.index_permissions.as_ref() {
                        index.set_permissions(permissions.clone())?;
                    }
                    index.sync_all()?;
                }
                Err(error) if error.kind() == ErrorKind::NotFound && !self.index_existed => {}
                Err(error) => return Err(error.into()),
            }
            let parent = self
                .index_path
                .parent()
                .context("git index path has no parent")?;
            sync_directory(parent)
        };
        flush().map_err(|error| {
            OriginError::internal(format!("failed to flush restored git index: {error}"))
        })
    }

    fn restore(&mut self) -> Result<()> {
        if self.restored {
            return Ok(());
        }
        if self.index_existed {
            let parent = self
                .index_path
                .parent()
                .context("git index path has no parent")?;
            let mut replacement = NamedTempFile::new_in(parent)?;
            let mut backup = File::open(self.backup.path())?;
            std::io::copy(&mut backup, &mut replacement)?;
            replacement.flush()?;
            if let Some(permissions) = self.index_permissions.as_ref() {
                replacement.as_file().set_permissions(permissions.clone())?;
            }
            replacement.as_file_mut().sync_all()?;
            replacement.persist(&self.index_path)?;
            sync_directory(parent)?;
        } else {
            match std::fs::remove_file(&self.index_path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let parent = self
                .index_path
                .parent()
                .context("git index path has no parent")?;
            sync_directory(parent)?;
        }
        self.restored = true;
        Ok(())
    }
}

impl Drop for GitIndexSnapshot {
    fn drop(&mut self) {
        if !self.restored {
            let _ = self.restore();
        }
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .with_context(|| format!("failed to open directory for fsync {path:?}"))?
        .sync_all()
        .with_context(|| format!("failed to fsync directory {path:?}"))
}

fn reset_index_paths_to_head(
    workspace_root: &Path,
    touched: &[&str],
    bearer_token: Option<&str>,
) -> Result<(), OriginError> {
    for chunk in touched.chunks(GIT_STAGE_CHUNK_SIZE) {
        let mut args = Vec::with_capacity(3 + chunk.len());
        args.extend(["reset", "HEAD", "--"]);
        args.extend(chunk.iter().copied());
        run_git_ok(workspace_root, &args, bearer_token)
            .map_err(|error| OriginError::internal(error.to_string()))?;
    }
    Ok(())
}

fn is_dependency_churn_path(path: &str) -> bool {
    path.trim()
        .trim_matches('/')
        .split('/')
        .any(|segment| matches!(segment, "node_modules" | ".pnpm-store"))
}

fn is_repo_hygiene_blocked_path(path: &str) -> bool {
    path.trim()
        .trim_matches('/')
        .split('/')
        .any(|segment| segment == "tmp")
}

fn is_sync_reserved_path(path: &str) -> bool {
    let normalized = path.trim().trim_start_matches('/').to_ascii_lowercase();
    let trimmed = normalized.as_str();
    trimmed == ".instafy"
        || trimmed.starts_with(".instafy/")
        || is_reserved_path(trimmed)
        || is_dependency_churn_path(trimmed)
        || is_repo_hygiene_blocked_path(trimmed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyPathEntry {
    pub path: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded_repo_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyPathGroup {
    pub prefix: String,
    pub label: String,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded_repo_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyPathStatusView {
    pub dirty_count: usize,
    pub dirty_paths: Vec<DirtyPathEntry>,
    pub dirty_groups: Vec<DirtyPathGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_prefix: Option<String>,
    pub page_offset: usize,
    pub page_limit: usize,
    pub has_more_files: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryEntry {
    pub commit: String,
    pub short_commit: String,
    pub committed_at: String,
    pub author_name: String,
    pub author_email: String,
    pub subject: String,
    /// Value of the `Instafy-Resolved-By` trailer when present (e.g.
    /// "assistant" for agent-made conflict resolutions).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryHeadRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
}

fn parse_porcelain_status_lines(
    status: &str,
    skip: impl Fn(&str) -> bool,
) -> BTreeMap<String, String> {
    let mut entries: BTreeMap<String, String> = BTreeMap::new();

    for line in status.lines() {
        if line.len() < 4 {
            continue;
        }

        let code = line[..2].to_string();
        let raw = line[3..].trim();
        if raw.is_empty() {
            continue;
        }

        let mut record_path = |candidate: &str| {
            let normalized = candidate.trim().trim_end_matches('/');
            if normalized.is_empty() || skip(normalized) {
                return;
            }
            entries
                .entry(normalized.to_string())
                .or_insert_with(|| code.clone());
        };

        if let Some((before, after)) = raw.split_once(" -> ") {
            record_path(before);
            record_path(after);
            continue;
        }

        record_path(raw);
    }

    entries
}

fn find_embedded_repo_root(workspace_root: &Path, path: &str) -> Option<String> {
    let workspace = WorkspaceDir::open(workspace_root).ok()?;
    let mut cursor = Path::new(path.trim().trim_matches('/'));

    loop {
        if cursor.as_os_str().is_empty() {
            return None;
        }

        let candidate = format!("{}/.git", cursor.to_string_lossy().replace('\\', "/"));
        if matches!(
            workspace.entry_kind(&candidate),
            Ok(WorkspaceEntryKind::Directory)
        ) {
            return Some(cursor.to_string_lossy().replace('\\', "/"));
        }

        match cursor.parent() {
            Some(parent) => cursor = parent,
            None => return None,
        }
    }
}

fn list_embedded_repo_dirty_files(
    workspace_root: &Path,
    embedded_repo_root: &str,
) -> Result<Vec<DirtyPathEntry>, OriginError> {
    let repo_root = workspace_root.join(embedded_repo_root);
    let inner_entries = list_untrusted_worktree_status(workspace_root, &repo_root)
        .with_context(|| format!("failed to inspect embedded repository {repo_root:?}"))
        .map_err(|error| OriginError::internal(error.to_string()))?;
    let root = embedded_repo_root
        .trim()
        .trim_matches('/')
        .replace('\\', "/");
    let prefixed = inner_entries
        .into_iter()
        .map(|(path, code)| DirtyPathEntry {
            path: format!("{root}/{path}"),
            code,
            embedded_repo_root: Some(root.clone()),
        })
        .collect::<Vec<_>>();

    Ok(prefixed)
}

pub fn list_dirty_files(
    workspace_root: &Path,
    bearer_token: Option<&str>,
) -> Result<Vec<DirtyPathEntry>, OriginError> {
    let status = git_stdout(
        workspace_root,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    if status.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut entries = parse_porcelain_status_lines(&status, is_sync_reserved_path);
    let mut embedded_roots = entries
        .keys()
        .filter_map(|path| find_embedded_repo_root(workspace_root, path))
        .collect::<Vec<_>>();
    embedded_roots.sort();
    embedded_roots.dedup();

    let mut expanded_embedded_entries = Vec::new();
    for root in &embedded_roots {
        let inner_entries = list_embedded_repo_dirty_files(workspace_root, root)?;
        if inner_entries.is_empty() {
            continue;
        }
        entries.retain(|path, _| path != root && !path.starts_with(&format!("{root}/")));
        expanded_embedded_entries.extend(inner_entries);
    }

    let mut dirty_paths = entries
        .into_iter()
        .map(|(path, code)| DirtyPathEntry {
            embedded_repo_root: find_embedded_repo_root(workspace_root, &path),
            path,
            code,
        })
        .collect::<Vec<_>>();
    dirty_paths.extend(expanded_embedded_entries);
    dirty_paths.sort_by(|a, b| a.path.cmp(&b.path));
    dirty_paths.dedup_by(|a, b| a.path == b.path);
    Ok(dirty_paths)
}

fn normalize_dirty_scope_prefix(scope_prefix: Option<&str>) -> Option<String> {
    let normalized = scope_prefix
        .unwrap_or_default()
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn dirty_path_relative_to_scope(path: &str, scope_prefix: Option<&str>) -> Option<String> {
    let normalized_path = path.trim().trim_matches('/');
    if normalized_path.is_empty() {
        return None;
    }

    match scope_prefix {
        Some(scope) if !scope.is_empty() => normalized_path
            .strip_prefix(scope)
            .and_then(|remaining| remaining.strip_prefix('/'))
            .map(|remaining| remaining.to_string()),
        _ => Some(normalized_path.to_string()),
    }
}

pub fn summarize_dirty_files(
    entries: &[DirtyPathEntry],
    scope_prefix: Option<&str>,
    offset: usize,
    limit: usize,
) -> DirtyPathStatusView {
    let mut normalized_scope = normalize_dirty_scope_prefix(scope_prefix);
    let (mut direct_files, groups, normalized_scope) = loop {
        let mut direct_files: Vec<DirtyPathEntry> = Vec::new();
        let mut groups: BTreeMap<String, DirtyPathGroup> = BTreeMap::new();

        for entry in entries {
            let Some(relative_path) =
                dirty_path_relative_to_scope(&entry.path, normalized_scope.as_deref())
            else {
                continue;
            };
            if relative_path.is_empty() {
                continue;
            }

            if let Some((segment, _rest)) = relative_path.split_once('/') {
                let prefix = normalized_scope
                    .as_ref()
                    .map(|scope| format!("{scope}/{segment}"))
                    .unwrap_or_else(|| segment.to_string());
                let group = groups
                    .entry(prefix.clone())
                    .or_insert_with(|| DirtyPathGroup {
                        prefix: prefix.clone(),
                        label: segment.to_string(),
                        count: 0,
                        embedded_repo_root: None,
                    });
                group.count += 1;
                if group.embedded_repo_root.is_none() {
                    if let Some(root) = entry.embedded_repo_root.as_deref() {
                        if root == prefix {
                            group.embedded_repo_root = Some(root.to_string());
                        }
                    }
                }
            } else {
                direct_files.push(entry.clone());
            }
        }

        if direct_files.is_empty() && groups.len() == 1 {
            if let Some(next_scope) = groups.keys().next().cloned() {
                if normalized_scope.as_deref() != Some(next_scope.as_str()) {
                    normalized_scope = Some(next_scope);
                    continue;
                }
            }
        }

        break (direct_files, groups, normalized_scope);
    };

    direct_files.sort_by(|a, b| a.path.cmp(&b.path));
    let total_direct_files = direct_files.len();
    let page_limit = limit.clamp(1, 200);
    let page_offset = offset.min(total_direct_files);
    let page_dirty_paths = direct_files
        .into_iter()
        .skip(page_offset)
        .take(page_limit)
        .collect::<Vec<_>>();

    DirtyPathStatusView {
        dirty_count: entries.len(),
        dirty_paths: page_dirty_paths,
        dirty_groups: groups.into_values().collect(),
        scope_prefix: normalized_scope,
        page_offset,
        page_limit,
        has_more_files: page_offset.saturating_add(page_limit) < total_direct_files,
    }
}

pub fn list_recent_commits(
    workspace_root: &Path,
    limit: usize,
    bearer_token: Option<&str>,
) -> Result<Vec<GitHistoryEntry>, OriginError> {
    if limit == 0 || !is_git_repo(workspace_root) {
        return Ok(Vec::new());
    }

    let has_head =
        git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"]).unwrap_or(false);
    if !has_head {
        return Ok(Vec::new());
    }

    let max_count = limit.min(25).to_string();
    let pretty =
        "%H%x1f%h%x1f%cI%x1f%an%x1f%ae%x1f%s%x1f%(trailers:key=Instafy-Resolved-By,valueonly)%x1e";
    let stdout = git_stdout(
        workspace_root,
        &[
            "log",
            "--max-count",
            max_count.as_str(),
            "--date=iso-strict",
            &format!("--pretty=format:{pretty}"),
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    let mut entries = Vec::new();
    for raw_record in stdout.split('\u{1e}') {
        let record = raw_record.trim();
        if record.is_empty() {
            continue;
        }
        let mut fields = record.split('\u{1f}');
        let commit = match fields.next().map(str::trim) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => continue,
        };
        let short_commit = fields.next().map(str::trim).unwrap_or("").to_string();
        let committed_at = fields.next().map(str::trim).unwrap_or("").to_string();
        let author_name = fields.next().map(str::trim).unwrap_or("").to_string();
        let author_email = fields.next().map(str::trim).unwrap_or("").to_string();
        let subject = fields.next().map(str::trim).unwrap_or("").to_string();
        let resolved_by = fields
            .next()
            .and_then(|value| value.lines().map(str::trim).find(|line| !line.is_empty()))
            .map(str::to_string);
        entries.push(GitHistoryEntry {
            commit,
            short_commit,
            committed_at,
            author_name,
            author_email,
            subject,
            resolved_by,
        });
    }

    Ok(entries)
}

pub fn list_commit_files(
    workspace_root: &Path,
    commit: &str,
    bearer_token: Option<&str>,
) -> Result<Vec<DirtyPathEntry>, OriginError> {
    let normalized_commit = commit.trim();
    if normalized_commit.is_empty() || !is_git_repo(workspace_root) {
        return Ok(Vec::new());
    }

    let stdout = git_stdout(
        workspace_root,
        &[
            "show",
            "--format=",
            "--name-status",
            "--find-renames",
            "--find-copies",
            normalized_commit,
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    let mut entries = Vec::new();
    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\t');
        let raw_code = fields.next().map(str::trim).unwrap_or("");
        if raw_code.is_empty() {
            continue;
        }
        let code = raw_code
            .chars()
            .next()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let first_path = fields.next().map(str::trim).unwrap_or("");
        let second_path = fields.next().map(str::trim).unwrap_or("");
        let path = if raw_code.starts_with('R') || raw_code.starts_with('C') {
            second_path
        } else {
            first_path
        };
        if path.is_empty() || is_sync_reserved_path(path) {
            continue;
        }
        entries.push(DirtyPathEntry {
            embedded_repo_root: find_embedded_repo_root(workspace_root, path),
            path: path.to_string(),
            code,
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries.dedup_by(|a, b| a.path == b.path);
    Ok(entries)
}

pub fn resolve_history_head_ref(
    workspace_root: &Path,
    bearer_token: Option<&str>,
) -> Result<GitHistoryHeadRef, OriginError> {
    if !is_git_repo(workspace_root) {
        return Ok(GitHistoryHeadRef::default());
    }

    let has_head =
        git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"]).unwrap_or(false);
    if !has_head {
        return Ok(GitHistoryHeadRef::default());
    }

    if let Ok(branch) = git_stdout(
        workspace_root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        bearer_token,
    ) {
        let branch = branch.trim();
        if !branch.is_empty() {
            let branch = branch.to_string();
            return Ok(GitHistoryHeadRef {
                branch: Some(branch.clone()),
                head_ref: Some(branch),
            });
        }
    }

    if let Ok(head_commit) = git_stdout(
        workspace_root,
        &["rev-parse", "--short", "HEAD"],
        bearer_token,
    ) {
        let head_commit = head_commit.trim();
        if !head_commit.is_empty() {
            return Ok(GitHistoryHeadRef {
                branch: None,
                head_ref: Some(format!("detached @ {head_commit}")),
            });
        }
    }

    Ok(GitHistoryHeadRef::default())
}

#[derive(Debug, Clone, Serialize)]
pub struct GitDiffOutput {
    pub diff: String,
    pub truncated: bool,
}

const MAX_GIT_DIFF_BYTES: usize = 200_000;

fn truncate_diff(mut diff: String) -> GitDiffOutput {
    let mut truncated = false;
    if diff.len() > MAX_GIT_DIFF_BYTES {
        diff.truncate(MAX_GIT_DIFF_BYTES);
        diff.push_str("\n… (diff truncated)\n");
        truncated = true;
    }

    GitDiffOutput {
        diff: diff.trim_end().to_string(),
        truncated,
    }
}

pub fn diff_for_path(
    workspace_root: &Path,
    path: &str,
    bearer_token: Option<&str>,
) -> Result<GitDiffOutput, OriginError> {
    let normalized = path.trim().trim_start_matches('/').trim_end_matches('/');
    if normalized.is_empty() || is_sync_reserved_path(normalized) {
        return Err(OriginError::bad_request("invalid git diff path"));
    }

    let workspace = WorkspaceDir::open(workspace_root)
        .map_err(|error| OriginError::internal(format!("failed to open workspace: {error}")))?;
    let entry_kind = workspace.entry_kind(normalized).ok();
    if entry_kind == Some(WorkspaceEntryKind::Directory) {
        return Ok(GitDiffOutput {
            diff: format!("Diff preview is not available for directories.\n\nPath: {normalized}"),
            truncated: false,
        });
    }

    let has_head =
        git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"]).unwrap_or(false);

    let mut diff = if has_head {
        let output = run_git_ok(
            workspace_root,
            &[
                "diff",
                "--no-ext-diff",
                "--patch",
                "--no-color",
                "HEAD",
                "--",
                normalized,
            ],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::new()
    };

    // Agent changes are auto-synced (committed) right after they are applied, so a
    // working-tree-vs-HEAD diff is empty even though the file just changed. Fall back to
    // the most recent commit that touched this path so the change is still shown.
    if diff.trim().is_empty() && has_head {
        if let Ok(output) = run_git_ok(
            workspace_root,
            &[
                "log",
                "-1",
                "--format=",
                "--no-ext-diff",
                "--patch",
                "--no-color",
                "HEAD",
                "--",
                normalized,
            ],
            bearer_token,
        ) {
            diff = String::from_utf8_lossy(&output.stdout)
                .trim_start()
                .to_string();
        }
    }

    if diff.trim().is_empty() {
        if entry_kind == Some(WorkspaceEntryKind::File) {
            let mut file = workspace
                .open_file(normalized)
                .map_err(|error| OriginError::internal(format!("failed to open file: {error}")))?;
            let mut bytes = Vec::new();
            use std::io::Read as _;
            file.read_to_end(&mut bytes)
                .map_err(|error| OriginError::internal(format!("failed to read file: {error}")))?;

            if bytes.iter().any(|byte| *byte == 0) {
                diff = format!("Binary file: {normalized}");
            } else {
                let contents = String::from_utf8_lossy(&bytes).to_string();
                let line_count = contents.lines().count();

                let mut out = String::new();
                out.push_str(&format!("diff --git a/{normalized} b/{normalized}\n"));
                out.push_str("new file mode 100644\n");
                out.push_str("--- /dev/null\n");
                out.push_str(&format!("+++ b/{normalized}\n"));
                out.push_str(&format!("@@ -0,0 +1,{} @@\n", line_count));
                for line in contents.lines() {
                    out.push('+');
                    out.push_str(line);
                    out.push('\n');
                }
                diff = out;
            }
        } else if entry_kind.is_some() {
            diff = format!("Diff preview unavailable.\n\nPath: {normalized}");
        }
    }

    Ok(truncate_diff(diff))
}

/// Revs accepted from callers are commit ids only (the frontend sends full
/// shas). Anything else — names, ranges, and especially values starting with
/// `-` — is rejected so query params can never be parsed as git options
/// (e.g. `--output=<path>` would write outside the workspace).
fn is_safe_git_rev(rev: &str) -> bool {
    !rev.is_empty() && rev.len() <= 64 && rev.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Current HEAD commit of the workspace repo, if any.
pub fn head_rev(workspace_root: &Path, bearer_token: Option<&str>) -> Option<String> {
    if !is_git_repo(workspace_root) {
        return None;
    }
    git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Tree-to-tree diff for one path between an explicit base commit and either an
/// explicit head commit or the working tree. Unlike `git show`/`git log -1 -p`,
/// this does not rely on parent links, so it renders real edit diffs on
/// snapshot-history origins where each sync is a fresh commit.
pub fn diff_for_path_between(
    workspace_root: &Path,
    base: &str,
    head: Option<&str>,
    path: &str,
    bearer_token: Option<&str>,
) -> Result<GitDiffOutput, OriginError> {
    let normalized_base = base.trim();
    let normalized_head = head.map(str::trim).filter(|value| !value.is_empty());
    let normalized_path = path.trim().trim_start_matches('/').trim_end_matches('/');
    if normalized_path.is_empty() || is_sync_reserved_path(normalized_path) {
        return Err(OriginError::bad_request("invalid git diff path"));
    }
    if !is_safe_git_rev(normalized_base)
        || normalized_head.is_some_and(|head| !is_safe_git_rev(head))
    {
        return Err(OriginError::bad_request("invalid git rev"));
    }

    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--patch",
        "--no-color",
        normalized_base,
    ];
    if let Some(head) = normalized_head {
        args.push(head);
    }
    args.extend(["--", normalized_path]);

    let output = run_git_ok(workspace_root, &args, bearer_token)
        .map_err(|error| OriginError::internal(error.to_string()))?;
    let diff = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(truncate_diff(diff))
}

pub fn diff_for_path_at_commit(
    workspace_root: &Path,
    commit: &str,
    path: &str,
    bearer_token: Option<&str>,
) -> Result<GitDiffOutput, OriginError> {
    let normalized_commit = commit.trim();
    let normalized_path = path.trim().trim_start_matches('/').trim_end_matches('/');
    if normalized_path.is_empty() || is_sync_reserved_path(normalized_path) {
        return Err(OriginError::bad_request("invalid git diff path"));
    }
    if !is_safe_git_rev(normalized_commit) {
        return Err(OriginError::bad_request("invalid git rev"));
    }

    let output = run_git_ok(
        workspace_root,
        &[
            "show",
            "--no-ext-diff",
            "--patch",
            "--no-color",
            normalized_commit,
            "--",
            normalized_path,
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    let diff = String::from_utf8_lossy(&output.stdout).to_string();
    if diff.trim().is_empty() {
        return Ok(GitDiffOutput {
            diff: format!(
                "No line-by-line diff available for saved version path.\n\nCommit: {normalized_commit}\nPath: {normalized_path}"
            ),
            truncated: false,
        });
    }

    Ok(truncate_diff(diff))
}

#[derive(Debug, Clone, Serialize)]
pub struct GitRevertSummary {
    pub reverted: Vec<String>,
    pub removed: Vec<String>,
}

pub fn revert_paths(
    workspace_root: &Path,
    paths: &[String],
    bearer_token: Option<&str>,
) -> Result<GitRevertSummary, OriginError> {
    let mut touched = paths
        .iter()
        .map(|path| path.trim().trim_end_matches('/'))
        .filter(|path| !path.is_empty() && !is_sync_reserved_path(path))
        .map(|path| path.to_string())
        .collect::<Vec<_>>();
    touched.sort();
    touched.dedup();

    if touched.is_empty() {
        return Ok(GitRevertSummary {
            reverted: Vec::new(),
            removed: Vec::new(),
        });
    }

    let touched_refs = touched.iter().map(|path| path.as_str()).collect::<Vec<_>>();
    let _embedded_guard = EmbeddedGitDirGuard::hide(workspace_root, &touched_refs)
        .map_err(|error| OriginError::internal(error.to_string()))?;

    let has_head =
        git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"]).unwrap_or(false);

    let mut reverted = Vec::new();
    let mut removed = Vec::new();

    for path in touched {
        if has_head {
            let output = run_git(
                workspace_root,
                &["checkout", "HEAD", "--", path.as_str()],
                bearer_token,
            )
            .map_err(|error| OriginError::internal(error.to_string()))?;

            if output.status.success() {
                reverted.push(path);
                continue;
            }

            let combined = format!("{}{}", String::from_utf8_lossy(&output.stdout).trim(), {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if stderr.trim().is_empty() {
                    "".to_string()
                } else {
                    format!("\n{}", stderr.trim())
                }
            });
            let combined_lower = combined.to_ascii_lowercase();
            let looks_like_pathspec_missing = combined_lower.contains("pathspec")
                && combined_lower.contains("did not match any file");
            let looks_like_invalid_head = combined_lower.contains("invalid reference")
                || combined_lower.contains("bad revision")
                || combined_lower.contains("unknown revision")
                || combined_lower.contains("reference is not a tree");

            if !looks_like_pathspec_missing && !looks_like_invalid_head {
                let message = format!("git checkout HEAD failed for {path}: {}", combined.trim());
                if combined_lower.contains("unmerged")
                    || combined_lower.contains("merge")
                    || combined_lower.contains("conflict")
                {
                    return Err(OriginError::conflict(message));
                }
                return Err(OriginError::internal(message));
            }
        }

        let _ = run_git(
            workspace_root,
            &[
                "rm",
                "--cached",
                "-r",
                "--ignore-unmatch",
                "--",
                path.as_str(),
            ],
            bearer_token,
        );

        let workspace = WorkspaceDir::open(workspace_root)
            .map_err(|error| OriginError::internal(format!("failed to open workspace: {error}")))?;
        if let Err(error) = workspace.remove(path.as_str()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(OriginError::internal(format!(
                    "failed to remove workspace entry {path}: {error}"
                )));
            }
        }

        removed.push(path);
    }

    Ok(GitRevertSummary { reverted, removed })
}

/// Refresh the configured remote branch without touching HEAD, the worktree,
/// or the index, then return its tip only when it contains `expected_rev`.
/// The explicit remote-tracking refspec avoids merging or checking out remote
/// content as part of this idempotency check.
fn remote_branch_tip_containing_expected_rev(
    config: &ServerConfig,
    workspace_root: &Path,
    expected_rev: &str,
    bearer_token: Option<&str>,
) -> Result<Option<String>, OriginError> {
    let branch_ref = format!("refs/heads/{}", config.git_branch);
    let advertised = git_stdout(
        workspace_root,
        &[
            "ls-remote",
            "--heads",
            config.git_remote_name.as_str(),
            branch_ref.as_str(),
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    let advertised_tip = advertised
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .find(|value| is_safe_git_rev(value));
    let Some(advertised_tip) = advertised_tip else {
        return Ok(None);
    };
    if advertised_tip.eq_ignore_ascii_case(expected_rev) {
        return Ok(Some(advertised_tip.to_string()));
    }

    let tracking_ref = format!(
        "refs/remotes/{}/{}",
        config.git_remote_name, config.git_branch
    );
    let refspec = format!("+{branch_ref}:{tracking_ref}");
    run_git_ok(
        workspace_root,
        &[
            "fetch",
            "--no-tags",
            config.git_remote_name.as_str(),
            refspec.as_str(),
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    let contains_expected = git_status_success(
        workspace_root,
        &[
            "merge-base",
            "--is-ancestor",
            expected_rev,
            tracking_ref.as_str(),
        ],
    )
    .unwrap_or(false);
    if !contains_expected {
        return Ok(None);
    }
    let remote_tip = git_stdout(
        workspace_root,
        &["rev-parse", tracking_ref.as_str()],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    Ok(Some(remote_tip))
}

/// Push an already-created commit without inspecting or mutating the index or
/// worktree. The explicit object-id refspec prevents a concurrent HEAD change
/// from causing a different commit to be pushed after validation.
pub fn push_existing_head(
    config: &ServerConfig,
    workspace_root: &Path,
    expected_rev: &str,
    bearer_token: Option<&str>,
) -> Result<String, OriginError> {
    let Some(remote_url) = config.git_remote_url.as_deref() else {
        return Err(OriginError::internal(
            "push_existing_head called without git remote configured",
        ));
    };
    let expected_rev = expected_rev.trim();
    if !is_safe_git_rev(expected_rev) {
        return Err(OriginError::bad_request(
            "expectedRev must be a hexadecimal commit id",
        ));
    }
    if !is_git_repo(workspace_root) {
        return Err(OriginError::conflict(
            "git HEAD is unavailable for expectedRev sync",
        ));
    }

    let current_head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
        .map_err(|_| OriginError::conflict("git HEAD is unavailable for expectedRev sync"))?;

    let has_remote =
        remote_exists(workspace_root, &config.git_remote_name, bearer_token).unwrap_or(false);
    let remote_args = if has_remote {
        vec![
            "remote",
            "set-url",
            config.git_remote_name.as_str(),
            remote_url,
        ]
    } else {
        vec!["remote", "add", config.git_remote_name.as_str(), remote_url]
    };
    run_git_ok(workspace_root, &remote_args, bearer_token)
        .map_err(|error| OriginError::internal(error.to_string()))?;

    let expected_object = format!("{expected_rev}^{{commit}}");
    let expected_exists = git_status_success(
        workspace_root,
        &["cat-file", "-e", expected_object.as_str()],
    )
    .unwrap_or(false);
    if !expected_exists {
        return Err(OriginError::conflict(format!(
            "expected git commit is unavailable: {expected_rev}"
        )));
    }

    // A retry can arrive after both the local and remote branches advanced
    // from expected A to descendant B. Remote containment proves A was
    // published, so acknowledge the requested revision without resetting local
    // HEAD, rewriting the remote, or touching index/worktree state.
    if !current_head.eq_ignore_ascii_case(expected_rev) {
        if remote_branch_tip_containing_expected_rev(
            config,
            workspace_root,
            expected_rev,
            bearer_token,
        )?
        .is_some()
        {
            return Ok(expected_rev.to_string());
        }
        return Err(OriginError::conflict(format!(
            "git HEAD changed and remote does not contain expected commit: expected {expected_rev}, found {current_head}"
        )));
    }

    // A previous push can have succeeded even if its HTTP response was lost.
    // Another writer may then have advanced the branch from A to B. Treat A
    // being in B's history as a successful replay and leave B untouched.
    if remote_branch_tip_containing_expected_rev(
        config,
        workspace_root,
        expected_rev,
        bearer_token,
    )?
    .is_some()
    {
        return Ok(expected_rev.to_string());
    }

    let destination = format!("{current_head}:refs/heads/{}", config.git_branch);
    let push = run_git(
        workspace_root,
        &["push", config.git_remote_name.as_str(), &destination],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    if push.status.success() {
        return Ok(current_head);
    }

    let stderr = String::from_utf8_lossy(&push.stderr);
    let lower = stderr.to_ascii_lowercase();
    let non_fast_forward = lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("[rejected]");
    if non_fast_forward {
        // Close the race between the pre-push ancestry check and the push. A
        // concurrent descendant of the expected commit is still a successful
        // replay; a missing/divergent expected commit remains a conflict.
        if remote_branch_tip_containing_expected_rev(
            config,
            workspace_root,
            expected_rev,
            bearer_token,
        )?
        .is_some()
        {
            return Ok(expected_rev.to_string());
        }
        return Err(OriginError::conflict(format!(
            "git push rejected (non-fast-forward): {}",
            stderr.trim()
        )));
    }
    Err(OriginError::internal(format!(
        "git push failed: {}",
        stderr.trim()
    )))
}

pub fn commit_and_push_dirty(
    config: &ServerConfig,
    workspace_root: &Path,
    message: &str,
    bearer_token: Option<&str>,
) -> Result<String, OriginError> {
    commit_and_push_dirty_inner(config, workspace_root, message, bearer_token, true)
}

/// Variant WITHOUT the pre-commit remote alignment, for callers that must not
/// risk `reset --mixed` onto a newer remote tip (which would make externally
/// pushed changes reappear as local "dirty" reversions). Local WIP is
/// committed on top of the local HEAD; the push loop below already fetches
/// and rebases onto the remote tip on rejection, preserving both sides.
pub fn commit_and_push_dirty_without_align(
    config: &ServerConfig,
    workspace_root: &Path,
    message: &str,
    bearer_token: Option<&str>,
) -> Result<String, OriginError> {
    commit_and_push_dirty_inner(config, workspace_root, message, bearer_token, false)
}

fn commit_and_push_dirty_inner(
    config: &ServerConfig,
    workspace_root: &Path,
    message: &str,
    bearer_token: Option<&str>,
    align_first: bool,
) -> Result<String, OriginError> {
    let Some(_remote_url) = config.git_remote_url.as_deref() else {
        return Err(OriginError::internal(
            "commit_and_push_dirty called without git remote configured",
        ));
    };

    if align_first {
        align_local_branch_to_remote_tip_preserving_worktree(config, workspace_root, bearer_token)?;
    }

    let dirty = list_dirty_files(workspace_root, bearer_token)?;
    let touched = dirty
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<Vec<_>>();

    let _embedded_guard = if touched.is_empty() {
        None
    } else {
        Some(
            EmbeddedGitDirGuard::hide(workspace_root, &touched)
                .map_err(|error| OriginError::internal(error.to_string()))?,
        )
    };

    if !touched.is_empty() {
        for path in &touched {
            run_git_ok(workspace_root, &["add", "-A", "--", path], bearer_token)
                .map_err(|error| OriginError::internal(error.to_string()))?;
        }

        let staged = git_stdout(
            workspace_root,
            &["diff", "--cached", "--name-only"],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;
        if !staged.trim().is_empty() {
            run_git_ok(
                workspace_root,
                &["commit", "--no-gpg-sign", "-m", message],
                bearer_token,
            )
            .map_err(|error| OriginError::internal(error.to_string()))?;
        }
    }

    // Human-like loop: fetch → rebase if needed → fast-forward push, retry once on race.
    let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
    for attempt in 0..2 {
        run_git_ok(
            workspace_root,
            &[
                "fetch",
                "--prune",
                &config.git_remote_name,
                &config.git_branch,
            ],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        let has_remote_branch = git_status_success(
            workspace_root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{}", remote_branch),
            ],
        )
        .unwrap_or(false);

        if has_remote_branch {
            let has_head = git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"])
                .unwrap_or(false);
            if !has_head {
                // If the local branch is "unborn" but the remote branch exists, fast-forward the
                // local checkout to the remote tip before attempting merge-base/rebase checks.
                run_git_ok(
                    workspace_root,
                    &["checkout", "-B", &config.git_branch, &remote_branch],
                    bearer_token,
                )
                .map_err(|error| OriginError::internal(error.to_string()))?;
            }

            let is_fast_forward_ok = git_status_success(
                workspace_root,
                &["merge-base", "--is-ancestor", &remote_branch, "HEAD"],
            )
            .unwrap_or(false);

            if !is_fast_forward_ok {
                let output = run_git(workspace_root, &["rebase", &remote_branch], bearer_token)
                    .map_err(|error| OriginError::internal(error.to_string()))?;
                if !output.status.success() {
                    let _ = run_git(workspace_root, &["rebase", "--abort"], bearer_token);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(OriginError::conflict(format!(
                        "git rebase onto {remote_branch} failed: {}",
                        stderr.trim()
                    )));
                }
            }
        }

        let dest_ref = format!("HEAD:refs/heads/{}", config.git_branch);
        let push = run_git(
            workspace_root,
            &["push", &config.git_remote_name, &dest_ref],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        if push.status.success() {
            break;
        }

        let stderr = String::from_utf8_lossy(&push.stderr);
        let looks_like_non_ff = stderr.contains("non-fast-forward")
            || stderr.contains("fetch first")
            || stderr.contains("[rejected]");

        if looks_like_non_ff && attempt == 0 {
            continue;
        }

        if looks_like_non_ff {
            discard_local_sync_commit_preserving_worktree(
                workspace_root,
                &remote_branch,
                bearer_token,
            );
            return Err(OriginError::conflict(format!(
                "git push rejected (non-fast-forward): {}",
                stderr.trim()
            )));
        }

        discard_local_sync_commit_preserving_worktree(workspace_root, &remote_branch, bearer_token);
        return Err(OriginError::internal(format!(
            "git push failed: {}",
            stderr.trim()
        )));
    }

    let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
        .map_err(|error| OriginError::internal(error.to_string()))?;
    Ok(head)
}

/// Create a forward revert of `commit` on top of the remote tip and push it.
/// Requires a clean tracked worktree so user edits are never entangled with
/// the revert; conflicts abort cleanly and surface as HTTP 409. History is
/// never rewritten — the revert is a new commit.
pub fn revert_commit_and_push(
    config: &ServerConfig,
    workspace_root: &Path,
    commit: &str,
    bearer_token: Option<&str>,
) -> Result<String, OriginError> {
    let Some(_remote_url) = config.git_remote_url.as_deref() else {
        return Err(OriginError::internal(
            "revert_commit_and_push called without git remote configured",
        ));
    };

    let commit = commit.trim();
    if commit.len() < 7
        || commit.len() > 64
        || !commit
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(OriginError::bad_request("invalid commit id"));
    }

    if has_tracked_worktree_changes(workspace_root, bearer_token)
        .map_err(|error| OriginError::internal(error.to_string()))?
    {
        return Err(OriginError::conflict(
            "workspace has unsaved changes; save or discard them before reverting a version",
        ));
    }

    align_local_branch_to_remote_tip_preserving_worktree(config, workspace_root, bearer_token)?;

    let commit_exists = git_status_success(
        workspace_root,
        &["cat-file", "-e", &format!("{commit}^{{commit}}")],
    )
    .unwrap_or(false);
    if !commit_exists {
        return Err(OriginError::not_found("commit not found"));
    }

    let revert = run_git(
        workspace_root,
        &["revert", "--no-edit", "--no-gpg-sign", commit],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    if !revert.status.success() {
        let _ = run_git(workspace_root, &["revert", "--abort"], bearer_token);
        let stderr = String::from_utf8_lossy(&revert.stderr);
        return Err(OriginError::conflict(format!(
            "git revert {commit} failed: {}",
            stderr.trim()
        )));
    }

    // Human-like loop: fetch → rebase if needed → fast-forward push, retry once on race.
    // The worktree was clean before the revert, so failure paths hard-reset to
    // the remote tip instead of leaving reverted content as dirty state.
    let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
    let restore_remote_tip = |reason: String, conflict: bool| -> OriginError {
        let _ = run_git(
            workspace_root,
            &["reset", "--hard", &remote_branch],
            bearer_token,
        );
        if conflict {
            OriginError::conflict(reason)
        } else {
            OriginError::internal(reason)
        }
    };
    for attempt in 0..2 {
        run_git_ok(
            workspace_root,
            &[
                "fetch",
                "--prune",
                &config.git_remote_name,
                &config.git_branch,
            ],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        let is_fast_forward_ok = git_status_success(
            workspace_root,
            &["merge-base", "--is-ancestor", &remote_branch, "HEAD"],
        )
        .unwrap_or(false);

        if !is_fast_forward_ok {
            let output = run_git(workspace_root, &["rebase", &remote_branch], bearer_token)
                .map_err(|error| OriginError::internal(error.to_string()))?;
            if !output.status.success() {
                let _ = run_git(workspace_root, &["rebase", "--abort"], bearer_token);
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(restore_remote_tip(
                    format!(
                        "git rebase onto {remote_branch} failed while reverting: {}",
                        stderr.trim()
                    ),
                    true,
                ));
            }
        }

        let dest_ref = format!("HEAD:refs/heads/{}", config.git_branch);
        let push = run_git(
            workspace_root,
            &["push", &config.git_remote_name, &dest_ref],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        if push.status.success() {
            let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
                .map_err(|error| OriginError::internal(error.to_string()))?;
            return Ok(head);
        }

        let stderr = String::from_utf8_lossy(&push.stderr);
        let looks_like_non_ff = stderr.contains("non-fast-forward")
            || stderr.contains("fetch first")
            || stderr.contains("[rejected]");

        if looks_like_non_ff && attempt == 0 {
            continue;
        }

        return Err(restore_remote_tip(
            format!("git push rejected while reverting: {}", stderr.trim()),
            looks_like_non_ff,
        ));
    }

    Err(OriginError::internal(
        "git revert push did not complete".to_string(),
    ))
}

pub fn commit_and_push_paths(
    config: &ServerConfig,
    workspace_root: &Path,
    paths: &[String],
    message: &str,
    bearer_token: Option<&str>,
) -> Result<String, OriginError> {
    let Some(_remote_url) = config.git_remote_url.as_deref() else {
        return Err(OriginError::internal(
            "commit_and_push_paths called without git remote configured",
        ));
    };

    align_local_branch_to_remote_tip_preserving_worktree(config, workspace_root, bearer_token)?;

    let normalized_paths = paths
        .iter()
        .map(|path| path.trim().trim_end_matches('/'))
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let blocked = normalized_paths
        .iter()
        .copied()
        .filter(|path| is_sync_reserved_path(path))
        .collect::<Vec<_>>();
    if !blocked.is_empty() {
        let detail = blocked.join(", ");
        return Err(OriginError::bad_request(format!(
            "path is excluded from space history: {detail}"
        )));
    }

    let mut touched = normalized_paths;
    touched.sort();
    touched.dedup();

    if touched.is_empty() {
        let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
            .unwrap_or_else(|_| "unknown".to_string());
        return Ok(head);
    }

    run_git_ok(workspace_root, &["reset"], bearer_token)
        .map_err(|error| OriginError::internal(error.to_string()))?;

    let _embedded_guard = EmbeddedGitDirGuard::hide(workspace_root, &touched)
        .map_err(|error| OriginError::internal(error.to_string()))?;

    for path in &touched {
        run_git_ok(workspace_root, &["add", "-A", "--", path], bearer_token)
            .map_err(|error| OriginError::internal(error.to_string()))?;
    }

    let staged = git_stdout(
        workspace_root,
        &["diff", "--cached", "--name-only"],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;
    if staged.trim().is_empty() {
        let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
            .unwrap_or_else(|_| "unknown".to_string());
        return Ok(head);
    }

    run_git_ok(
        workspace_root,
        &["commit", "--no-gpg-sign", "-m", message],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    // Human-like loop: fetch → rebase if needed → fast-forward push, retry once on race.
    let remote_branch = format!("{}/{}", config.git_remote_name, config.git_branch);
    for attempt in 0..2 {
        run_git_ok(
            workspace_root,
            &[
                "fetch",
                "--prune",
                &config.git_remote_name,
                &config.git_branch,
            ],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        let has_remote_branch = git_status_success(
            workspace_root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{}", remote_branch),
            ],
        )
        .unwrap_or(false);

        if has_remote_branch {
            let has_head = git_status_success(workspace_root, &["rev-parse", "--verify", "HEAD"])
                .unwrap_or(false);
            if !has_head {
                run_git_ok(
                    workspace_root,
                    &["checkout", "-B", &config.git_branch, &remote_branch],
                    bearer_token,
                )
                .map_err(|error| OriginError::internal(error.to_string()))?;
            }

            let is_fast_forward_ok = git_status_success(
                workspace_root,
                &["merge-base", "--is-ancestor", &remote_branch, "HEAD"],
            )
            .unwrap_or(false);

            if !is_fast_forward_ok {
                let output = run_git(workspace_root, &["rebase", &remote_branch], bearer_token)
                    .map_err(|error| OriginError::internal(error.to_string()))?;
                if !output.status.success() {
                    let _ = run_git(workspace_root, &["rebase", "--abort"], bearer_token);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(OriginError::conflict(format!(
                        "git rebase onto {remote_branch} failed: {}",
                        stderr.trim()
                    )));
                }
            }
        }

        let dest_ref = format!("HEAD:refs/heads/{}", config.git_branch);
        let push = run_git(
            workspace_root,
            &["push", &config.git_remote_name, &dest_ref],
            bearer_token,
        )
        .map_err(|error| OriginError::internal(error.to_string()))?;

        if push.status.success() {
            break;
        }

        let stderr = String::from_utf8_lossy(&push.stderr);
        let looks_like_non_ff = stderr.contains("non-fast-forward")
            || stderr.contains("fetch first")
            || stderr.contains("[rejected]");

        if looks_like_non_ff && attempt == 0 {
            continue;
        }

        if looks_like_non_ff {
            discard_local_sync_commit_preserving_worktree(
                workspace_root,
                &remote_branch,
                bearer_token,
            );
            return Err(OriginError::conflict(format!(
                "git push rejected (non-fast-forward): {}",
                stderr.trim()
            )));
        }

        discard_local_sync_commit_preserving_worktree(workspace_root, &remote_branch, bearer_token);
        return Err(OriginError::internal(format!(
            "git push failed: {}",
            stderr.trim()
        )));
    }

    let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], bearer_token)
        .map_err(|error| OriginError::internal(error.to_string()))?;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Url;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::process::Command;
    use std::time::Duration;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[test]
    fn git_fallback_reads_and_reverts_never_follow_outbound_symlinks() {
        let workspace = tempdir().expect("workspace");
        let outside = tempdir().expect("outside");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "outside-secret\n").expect("outside secret");
        symlink(outside.path(), workspace.path().join("escape")).expect("outbound link");

        let diff = diff_for_path(workspace.path(), "escape/secret.txt", None)
            .expect("symlink diff remains contained");
        assert!(!diff.diff.contains("outside-secret"));

        assert!(revert_paths(workspace.path(), &["escape/secret.txt".to_string()], None,).is_err());
        assert_eq!(
            fs::read_to_string(&outside_file).unwrap(),
            "outside-secret\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn embedded_git_discovery_and_guard_ignore_outbound_symlink_trees() {
        let workspace = tempdir().expect("workspace");
        let outside = tempdir().expect("outside");
        fs::create_dir_all(outside.path().join("project/.git")).expect("outside gitdir");
        fs::write(outside.path().join("project/.git/HEAD"), "outside\n")
            .expect("outside git metadata");
        symlink(outside.path(), workspace.path().join("escape")).expect("outbound link");

        assert_eq!(
            find_embedded_repo_root(workspace.path(), "escape/project/file.txt"),
            None
        );
        {
            let guard = EmbeddedGitDirGuard::hide(workspace.path(), &["escape/project/file.txt"])
                .expect("guard safely ignores outbound tree");
            assert!(guard.renames.is_empty());
            assert!(outside.path().join("project/.git").is_dir());
        }
        assert_eq!(
            fs::read_to_string(outside.path().join("project/.git/HEAD")).unwrap(),
            "outside\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn protected_git_layout_rejects_an_outbound_instafy_symlink() {
        let workspace = tempdir().expect("workspace");
        let outside = tempdir().expect("outside");
        fs::create_dir_all(outside.path().join(".git")).expect("outside gitdir");
        fs::write(outside.path().join(".git/config"), "outside\n").expect("outside config");
        symlink(outside.path(), workspace.path().join(".instafy")).expect("protected path symlink");

        assert!(validate_instafy_git_layout(workspace.path()).is_err());
        assert!(remove_instafy_git_dir(workspace.path()).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join(".git/config")).unwrap(),
            "outside\n"
        );
    }

    fn run_git(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .with_context(|| format!("failed to run git {:?}", args))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        anyhow::bail!(
            "git {:?} failed: {}{}",
            args,
            stdout.trim(),
            if stderr.trim().is_empty() {
                "".to_string()
            } else {
                format!("\n{}", stderr.trim())
            }
        );
    }

    fn git_stdout(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .with_context(|| format!("failed to run git {:?}", args))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            anyhow::bail!(
                "git {:?} failed: {}{}",
                args,
                stdout.trim(),
                if stderr.trim().is_empty() {
                    "".to_string()
                } else {
                    format!("\n{}", stderr.trim())
                }
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    }

    fn init_repo(dir: &Path, branch: &str) -> anyhow::Result<()> {
        run_git(dir, &["init", "-b", branch])?;
        Ok(())
    }

    fn git_config_get(config_path: &Path, key: &str) -> anyhow::Result<String> {
        let output = Command::new("git")
            .arg("config")
            .arg("--file")
            .arg(config_path)
            .arg("--get")
            .arg(key)
            .output()
            .with_context(|| format!("failed to read git config key {key}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("git config --get {key} failed: {}", stderr.trim());
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    }

    fn git_config_set(config_path: &Path, key: &str, value: &str) -> anyhow::Result<()> {
        let output = Command::new("git")
            .arg("config")
            .arg("--file")
            .arg(config_path)
            .arg(key)
            .arg(value)
            .output()
            .with_context(|| format!("failed to write git config key {key}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("git config {key} failed: {}", stderr.trim());
        }
        Ok(())
    }

    fn install_block_path_hook(remote_dir: &Path, blocked_segment: &str) -> anyhow::Result<()> {
        let hook_path = remote_dir.join("hooks").join("update");
        let escaped_segment = blocked_segment.replace('"', "\\\"");
        fs::write(
            &hook_path,
            (
                r#"#!/usr/bin/env bash
set -euo pipefail
oldrev="${1:-}"
refname="${2:-}"
newrev="${3:-}"

diff_args=()
if [[ "$oldrev" =~ ^0{40}$ ]]; then
  diff_args=(--root "$newrev")
else
  diff_args=("$oldrev" "$newrev")
fi

while IFS=$'\t' read -r status path1 path2; do
  [[ -z "$status" ]] && continue
  local_path="$path1"
  case "$status" in
    R*|C*) local_path="$path2" ;;
  esac
  if [[ -n "$local_path" && ( "$local_path" == "__BLOCKED_SEGMENT__"/* || "$local_path" == */"__BLOCKED_SEGMENT__"/* ) ]]; then
    echo "instafy: blocked path '$local_path' (repo hygiene policy)" >&2
    exit 1
  fi
done < <(git diff-tree --no-commit-id --name-status -r "${diff_args[@]}")
"#
            )
            .replace("__BLOCKED_SEGMENT__", &escaped_segment),
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&hook_path)?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&hook_path, perms)?;
        }
        Ok(())
    }

    #[test]
    fn run_git_repairs_stale_instafy_worktree_config() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        let config_path = workspace_dir.join(".instafy").join(".git").join("config");
        git_config_set(&config_path, "core.worktree", "/workspaces/missing")?;

        run_git_ok(
            &workspace_dir,
            &[
                "status",
                "--porcelain",
                "--untracked-files=no",
                "--ignore-submodules=all",
            ],
            None,
        )?;

        assert_eq!(
            git_config_get(&config_path, "core.worktree")?,
            workspace_dir.to_string_lossy()
        );
        Ok(())
    }

    #[test]
    fn run_git_never_deletes_an_unknown_index_lock() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "before\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        fs::write(workspace_dir.join("README.md"), "after\n")?;
        let lock_path = workspace_dir
            .join(".instafy")
            .join(".git")
            .join("index.lock");
        fs::write(&lock_path, "owned by another git process")?;

        let error = run_git_ok(&workspace_dir, &["add", "--", "README.md"], None)
            .expect_err("live-looking index lock must make the command fail");
        assert!(error.to_string().contains("index.lock"));
        assert_eq!(
            fs::read_to_string(&lock_path)?,
            "owned by another git process"
        );
        Ok(())
    }

    #[test]
    fn list_dirty_files_repairs_stale_worktree_and_ignores_instafy_git_metadata(
    ) -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "hello\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;

        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;
        let config_path = workspace_dir.join(".instafy").join(".git").join("config");
        git_config_set(&config_path, "core.worktree", "/workspaces/missing")?;

        fs::write(workspace_dir.join("README.md"), "hello world\n")?;

        let dirty = list_dirty_files(&workspace_dir, None)?;
        let paths = dirty
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["README.md"]);
        assert_eq!(
            git_config_get(&config_path, "core.worktree")?,
            workspace_dir.to_string_lossy()
        );
        Ok(())
    }

    #[test]
    fn info_exclude_ignores_space_marker_metadata() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(workspace_dir.join(".instafy").join(".git"))?;

        ensure_instafy_info_exclude(&workspace_dir)?;

        let exclude = fs::read_to_string(
            workspace_dir
                .join(".instafy")
                .join(".git")
                .join("info")
                .join("exclude"),
        )?;
        assert!(
            exclude.lines().any(|line| line == "/.instafy/space.json"),
            "expected .instafy/space.json to be excluded, got: {exclude}"
        );
        Ok(())
    }

    #[test]
    fn list_dirty_files_ignores_space_marker_metadata() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "hello\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;

        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;
        fs::write(
            workspace_dir.join(".instafy").join("space.json"),
            r#"{"spaceId":"00000000-0000-0000-0000-000000000000"}"#,
        )?;
        fs::write(workspace_dir.join("README.md"), "hello world\n")?;

        let dirty = list_dirty_files(&workspace_dir, None)?;
        let paths = dirty
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["README.md"]);
        Ok(())
    }

    #[test]
    fn commit_apply_locally_does_not_stage_instafy_git_metadata() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        fs::write(workspace_dir.join("README.md"), "hello\n")?;

        let commit = commit_apply_locally(
            &workspace_dir,
            &["README.md".to_string()],
            &[],
            "test: import baseline",
            None,
        )?;
        assert!(commit.is_some());

        let tree = run_git_ok(&workspace_dir, &["ls-tree", "--name-only", "HEAD"], None)?;
        let tree = String::from_utf8_lossy(&tree.stdout).trim_end().to_string();

        assert_eq!(tree, "README.md");
        Ok(())
    }

    #[test]
    fn commit_apply_locally_commits_only_applied_and_deleted_paths() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("applied.txt"), "before\n")?;
        fs::write(workspace_dir.join("deleted.txt"), "remove me\n")?;
        fs::write(workspace_dir.join("unrelated.txt"), "original\n")?;
        run_git(&workspace_dir, &["add", "-A"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        fs::write(workspace_dir.join("applied.txt"), "after\n")?;
        fs::remove_file(workspace_dir.join("deleted.txt"))?;
        fs::write(workspace_dir.join("unrelated.txt"), "staged user dirt\n")?;
        fs::write(workspace_dir.join("untracked.txt"), "staged new file\n")?;
        run_git_ok(&workspace_dir, &["add", "-A"], None)?;
        // Preserve partial staging too: the index and worktree deliberately
        // contain different unrelated content when the apply commit runs.
        fs::write(workspace_dir.join("unrelated.txt"), "working user dirt\n")?;
        fs::write(workspace_dir.join("untracked.txt"), "working new file\n")?;
        let unrelated_index_before = run_git_ok(
            &workspace_dir,
            &[
                "ls-files",
                "--stage",
                "--",
                "unrelated.txt",
                "untracked.txt",
            ],
            None,
        )?
        .stdout;
        let unrelated_staged_diff_before = run_git_ok(
            &workspace_dir,
            &[
                "diff",
                "--cached",
                "--binary",
                "--",
                "unrelated.txt",
                "untracked.txt",
            ],
            None,
        )?
        .stdout;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let index_path = workspace_dir.join(".instafy").join(".git").join("index");
            let mut permissions = fs::metadata(&index_path)?.permissions();
            permissions.set_mode(0o640);
            fs::set_permissions(&index_path, permissions)?;
        }

        let commit = commit_apply_locally(
            &workspace_dir,
            &["applied.txt".to_string()],
            &["deleted.txt".to_string()],
            "test: scoped import",
            None,
        )?
        .expect("scoped import commit");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let index_path = workspace_dir.join(".instafy").join(".git").join("index");
            assert_eq!(
                fs::metadata(index_path)?.permissions().mode() & 0o777,
                0o640
            );
        }

        let applied = run_git_ok(
            &workspace_dir,
            &["show", &format!("{commit}:applied.txt")],
            None,
        )?;
        assert_eq!(String::from_utf8_lossy(&applied.stdout), "after\n");
        let unrelated = run_git_ok(
            &workspace_dir,
            &["show", &format!("{commit}:unrelated.txt")],
            None,
        )?;
        assert_eq!(String::from_utf8_lossy(&unrelated.stdout), "original\n");
        assert!(!git_status_success(
            &workspace_dir,
            &["cat-file", "-e", &format!("{commit}:deleted.txt")],
        )?);

        let unrelated_index_after = run_git_ok(
            &workspace_dir,
            &[
                "ls-files",
                "--stage",
                "--",
                "unrelated.txt",
                "untracked.txt",
            ],
            None,
        )?
        .stdout;
        let unrelated_staged_diff_after = run_git_ok(
            &workspace_dir,
            &[
                "diff",
                "--cached",
                "--binary",
                "--",
                "unrelated.txt",
                "untracked.txt",
            ],
            None,
        )?
        .stdout;
        assert_eq!(unrelated_index_after, unrelated_index_before);
        assert_eq!(unrelated_staged_diff_after, unrelated_staged_diff_before);

        let status = run_git_ok(
            &workspace_dir,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?;
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(status.contains("MM unrelated.txt"), "status was: {status}");
        assert!(status.contains("AM untracked.txt"), "status was: {status}");
        assert!(!status.contains("applied.txt"), "status was: {status}");
        assert!(!status.contains("deleted.txt"), "status was: {status}");
        Ok(())
    }

    #[test]
    fn commit_apply_failure_restores_head_and_exact_original_index() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("applied.txt"), "before\n")?;
        fs::write(workspace_dir.join("unrelated.txt"), "base\n")?;
        run_git(&workspace_dir, &["add", "-A"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        fs::write(workspace_dir.join("applied.txt"), "after apply\n")?;
        fs::write(workspace_dir.join("unrelated.txt"), "staged user change\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "unrelated.txt"], None)?;
        fs::write(
            workspace_dir.join("unrelated.txt"),
            "unstaged user change\n",
        )?;

        let status_before = run_git_ok(
            &workspace_dir,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .stdout;
        let head_before = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;
        let index_path = workspace_dir.join(".instafy").join(".git").join("index");
        let index_before = fs::read(&index_path)?;
        let permissions_before = fs::metadata(&index_path)?.permissions();

        FAIL_COMMIT_APPLY_AFTER_PATH_RESET.with(|flag| flag.set(true));
        let error = commit_apply_locally(
            &workspace_dir,
            &["applied.txt".to_string()],
            &[],
            "test: injected failure",
            None,
        )
        .expect_err("injected post-commit failure must surface");
        assert!(error.to_string().contains("injected local apply failure"));

        // Read the index before running another Git command so the assertion
        // covers the exact bytes restored by the failure path.
        assert_eq!(fs::read(&index_path)?, index_before);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&index_path)?.permissions().mode(),
                permissions_before.mode()
            );
        }
        assert_eq!(
            super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?,
            head_before
        );
        let status_after = run_git_ok(
            &workspace_dir,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .stdout;
        assert_eq!(status_after, status_before);
        assert_eq!(
            fs::read_to_string(workspace_dir.join("applied.txt"))?,
            "after apply\n"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn server_git_commands_ignore_workspace_controlled_hooks() -> anyhow::Result<()> {
        use std::os::unix::fs::PermissionsExt;

        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "before\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        let hooks_dir = workspace_dir.join("workspace-controlled-hooks");
        fs::create_dir_all(&hooks_dir)?;
        let marker = workspace_dir.join("hook-executed");
        let pre_commit = hooks_dir.join("pre-commit");
        fs::write(
            &pre_commit,
            format!(
                "#!/bin/sh\nprintf 'executed' > \"{}\"\nexit 1\n",
                marker.display()
            ),
        )?;
        let mut permissions = fs::metadata(&pre_commit)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&pre_commit, permissions)?;
        run_git_ok(
            &workspace_dir,
            &[
                "config",
                "core.hooksPath",
                hooks_dir.to_str().expect("utf-8 hook path"),
            ],
            None,
        )?;

        fs::write(workspace_dir.join("README.md"), "after\n")?;
        let commit = commit_apply_locally(
            &workspace_dir,
            &["README.md".to_string()],
            &[],
            "test: hooks disabled",
            None,
        )?;
        assert!(commit.is_some());
        assert!(
            !marker.exists(),
            "workspace-controlled pre-commit hook must not execute"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn server_git_sanitizes_workspace_controlled_helpers_and_filters() -> anyhow::Result<()> {
        use std::os::unix::fs::PermissionsExt;

        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("filtered.txt"), "before\n")?;
        run_git(&workspace_dir, &["add", "filtered.txt"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        let marker = workspace_dir.join("helper-executed");
        let helper = workspace_dir.join("malicious-git-helper");
        fs::write(
            &helper,
            format!(
                "#!/bin/sh\nprintf 'executed' > \"{}\"\ncat\n",
                marker.display()
            ),
        )?;
        let mut permissions = fs::metadata(&helper)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&helper, permissions)?;

        let config_path = workspace_dir.join(".instafy").join(".git").join("config");
        let helper_path = helper.to_str().expect("utf-8 helper path");
        git_config_set(&config_path, "filter.exfil.clean", helper_path)?;
        git_config_set(&config_path, "filter.exfil.required", "true")?;
        git_config_set(
            &config_path,
            "credential.helper",
            &format!("!{helper_path}"),
        )?;
        git_config_set(&config_path, "core.fsmonitor", helper_path)?;
        git_config_set(&config_path, "core.sshCommand", helper_path)?;
        let included_config = workspace_dir.join("included-malicious.config");
        fs::write(
            &included_config,
            format!("[diff]\n\texternal = \"{}\"\n", helper.display()),
        )?;
        git_config_set(
            &config_path,
            "include.path",
            included_config.to_str().expect("utf-8 include path"),
        )?;

        fs::write(
            workspace_dir.join(".gitattributes"),
            "filtered.txt filter=exfil\n",
        )?;
        fs::write(workspace_dir.join("filtered.txt"), "after\n")?;
        let commit = commit_apply_locally(
            &workspace_dir,
            &[".gitattributes".to_string(), "filtered.txt".to_string()],
            &[],
            "test: helpers sanitized",
            None,
        )?
        .expect("sanitized helper commit");

        assert!(
            !marker.exists(),
            "workspace-controlled Git helper/filter must not execute"
        );
        let committed = run_git_ok(
            &workspace_dir,
            &["show", &format!("{commit}:filtered.txt")],
            None,
        )?;
        assert_eq!(String::from_utf8_lossy(&committed.stdout), "after\n");

        let sanitized = fs::read_to_string(&config_path)?.to_ascii_lowercase();
        for forbidden in [
            "credential",
            "filter",
            "fsmonitor",
            "sshcommand",
            "include",
            "diff",
        ] {
            assert!(
                !sanitized.contains(forbidden),
                "sanitized config retained {forbidden}: {sanitized}"
            );
        }
        assert_eq!(
            git_config_get(&config_path, "core.worktree")?,
            workspace_dir.to_string_lossy()
        );
        Ok(())
    }

    #[test]
    fn diff_for_path_between_renders_edits_across_snapshot_commits() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        fs::write(
            workspace_dir.join("about.html"),
            "<h1>About</h1>\n<p>Old copy</p>\n",
        )?;
        let base = commit_apply_locally(
            &workspace_dir,
            &["about.html".to_string()],
            &[],
            "test: baseline",
            None,
        )?
        .expect("baseline commit");

        // Snapshot-style history: the next state lands on an orphan commit with no
        // parent link back to the baseline.
        run_git_ok(&workspace_dir, &["checkout", "--orphan", "snapshot"], None)?;
        fs::write(
            workspace_dir.join("about.html"),
            "<h1>About</h1>\n<p>New copy</p>\n",
        )?;
        let head = commit_apply_locally(
            &workspace_dir,
            &["about.html".to_string()],
            &[],
            "test: snapshot",
            None,
        )?
        .expect("snapshot commit");

        // Parent-based diffs read the orphan snapshot as a whole-file add…
        let at_commit = diff_for_path_at_commit(&workspace_dir, &head, "about.html", None)?;
        assert!(at_commit.diff.contains("+<h1>About</h1>"));

        // …while the tree-to-tree diff renders the real edit.
        let between =
            diff_for_path_between(&workspace_dir, &base, Some(&head), "about.html", None)?;
        assert!(between.diff.contains("-<p>Old copy</p>"));
        assert!(between.diff.contains("+<p>New copy</p>"));
        assert!(!between.diff.contains("-<h1>About</h1>"));
        assert!(!between.diff.contains("new file mode"));

        // Revs that are not plain commit ids are rejected before reaching git,
        // so query params can never be parsed as git options.
        assert!(diff_for_path_between(
            &workspace_dir,
            "--output=/tmp/x",
            Some(&head),
            "about.html",
            None
        )
        .is_err());
        assert!(diff_for_path_between(
            &workspace_dir,
            &base,
            Some("--output=/tmp/x"),
            "about.html",
            None
        )
        .is_err());
        assert!(
            diff_for_path_between(&workspace_dir, "HEAD", Some(&head), "about.html", None).is_err()
        );
        assert!(
            diff_for_path_at_commit(&workspace_dir, "--output=/tmp/x", "about.html", None).is_err()
        );
        Ok(())
    }

    #[test]
    fn list_dirty_files_marks_paths_inside_embedded_git_repos() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "hello\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;

        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        fs::write(workspace_dir.join("README.md"), "hello world\n")?;

        let embedded_dir = workspace_dir.join("nested");
        fs::create_dir_all(&embedded_dir)?;
        init_repo(&embedded_dir, "main")?;
        run_git(&embedded_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &embedded_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(embedded_dir.join("inner.txt"), "inner\n")?;
        run_git(&embedded_dir, &["add", "inner.txt"])?;
        run_git(&embedded_dir, &["commit", "-m", "inner"])?;
        fs::write(embedded_dir.join("hello.txt"), "embedded hello\n")?;

        #[cfg(unix)]
        let fsmonitor_probe = {
            use std::os::unix::fs::PermissionsExt;

            let marker = sandbox.path().join("fsmonitor-ran");
            let script = sandbox.path().join("fsmonitor-probe.sh");
            fs::write(&script, format!("#!/bin/sh\n: > '{}'\n", marker.display()))?;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755))?;
            run_git(
                &embedded_dir,
                &["config", "core.fsmonitor", &script.to_string_lossy()],
            )?;
            marker
        };

        let dirty = list_dirty_files(&workspace_dir, None)?;
        #[cfg(unix)]
        assert!(
            !fsmonitor_probe.exists(),
            "embedded repo fsmonitor must not execute in the origin process"
        );
        let root_entry = dirty
            .iter()
            .find(|entry| entry.path == "README.md")
            .expect("expected dirty root README");
        assert_eq!(root_entry.embedded_repo_root, None);

        let embedded_entry = dirty
            .iter()
            .find(|entry| entry.embedded_repo_root.as_deref() == Some("nested"))
            .expect("expected dirty entry inside embedded repo");
        assert_eq!(embedded_entry.path, "nested/hello.txt");
        assert_eq!(embedded_entry.embedded_repo_root.as_deref(), Some("nested"));
        assert!(
            dirty.iter().all(|entry| entry.path != "nested"),
            "expected embedded repo root placeholder to be replaced with file paths: {:?}",
            dirty
                .iter()
                .map(|entry| entry.path.clone())
                .collect::<Vec<_>>()
        );

        Ok(())
    }

    #[test]
    fn list_dirty_files_ignores_dependency_churn_and_repo_hygiene_paths() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "hello\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;

        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        fs::create_dir_all(workspace_dir.join("app").join("node_modules"))?;
        fs::write(
            workspace_dir
                .join("app")
                .join("node_modules")
                .join("left-pad.js"),
            "module.exports = 1;\n",
        )?;
        fs::create_dir_all(workspace_dir.join(".pnpm-store").join("v3"))?;
        fs::write(
            workspace_dir.join(".pnpm-store").join("v3").join("lock"),
            "cache\n",
        )?;
        fs::create_dir_all(workspace_dir.join("tmp"))?;
        fs::write(workspace_dir.join("tmp").join("scratch.txt"), "throwaway\n")?;
        fs::write(workspace_dir.join("README.md"), "hello world\n")?;

        let dirty = list_dirty_files(&workspace_dir, None)?;
        let paths = dirty
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["README.md"]);
        Ok(())
    }

    #[test]
    fn commit_and_push_paths_rejects_repo_hygiene_paths_before_git_push() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().into_owned()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: String::from("instafy-origin"),
            git_author_email: String::from("origin@instafy.dev"),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        fs::create_dir_all(workspace_dir.join("tmp"))?;
        fs::write(workspace_dir.join("tmp/random_01.txt"), "blocked\n")?;

        let error = commit_and_push_paths(
            &config,
            workspace_dir.as_path(),
            &[String::from("tmp/random_01.txt")],
            "test: blocked",
            None,
        )
        .expect_err("expected tmp path to be rejected before sync");
        let message = error.to_string();
        assert!(
            message.contains("path is excluded from space history: tmp/random_01.txt"),
            "expected explicit repo hygiene error, got: {message}"
        );

        Ok(())
    }

    #[test]
    fn summarize_dirty_files_collapses_single_child_folder_chains() {
        let entries = vec![
            DirtyPathEntry {
                path: "playwright/large-dirty-abc/file-0000.txt".to_string(),
                code: "??".to_string(),
                embedded_repo_root: None,
            },
            DirtyPathEntry {
                path: "playwright/large-dirty-abc/file-0001.txt".to_string(),
                code: "??".to_string(),
                embedded_repo_root: None,
            },
            DirtyPathEntry {
                path: "playwright/large-dirty-abc/file-0002.txt".to_string(),
                code: "??".to_string(),
                embedded_repo_root: None,
            },
        ];

        let summary = summarize_dirty_files(&entries, None, 0, 100);
        assert_eq!(summary.dirty_count, 3);
        assert_eq!(
            summary.scope_prefix.as_deref(),
            Some("playwright/large-dirty-abc")
        );
        assert!(summary.dirty_groups.is_empty());
        assert_eq!(summary.dirty_paths.len(), 3);
        assert_eq!(
            summary.dirty_paths[0].path,
            "playwright/large-dirty-abc/file-0000.txt"
        );
        assert!(!summary.has_more_files);
    }

    #[test]
    fn commit_and_push_apply_persists_files_inside_embedded_git_repos() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;
        assert!(
            workspace_dir.join(".instafy").join(".git").exists(),
            "expected instafy git dir to exist after checkout"
        );
        assert!(
            !workspace_dir.join(".git").exists(),
            "expected no workspace root .git after checkout"
        );

        // Simulate a user cloning/creating a nested git repo inside the workspace.
        let embedded_dir = workspace_dir.join("nested");
        fs::create_dir_all(&embedded_dir)?;
        init_repo(&embedded_dir, "main")?;
        run_git(&embedded_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &embedded_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(embedded_dir.join("inner.txt"), "inner\n")?;
        run_git(&embedded_dir, &["add", "inner.txt"])?;
        run_git(&embedded_dir, &["commit", "-m", "inner"])?;

        // Create a new file under the embedded repo root that should still be committed to the
        // outer (git-canonical) repository.
        fs::write(embedded_dir.join("hello.txt"), "embedded-hello\n")?;

        let commit = commit_and_push_apply(
            &config,
            workspace_dir.as_path(),
            &[String::from("nested/hello.txt")],
            &[],
            "test: persist embedded",
            None,
        )?;

        // Confirm the embedded git dir was restored after staging/commit.
        assert!(
            embedded_dir.join(".git").exists(),
            "embedded repo .git should be present after commit, got commit {commit}"
        );

        let verify_dir = root.join("verify");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_dir.to_str().unwrap(),
            ],
        )?;

        let persisted = fs::read_to_string(verify_dir.join("nested/hello.txt"))?;
        assert_eq!(persisted, "embedded-hello\n");

        Ok(())
    }

    #[test]
    fn commit_and_push_dirty_persists_non_reserved_workspace_changes() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        fs::write(workspace_dir.join("README.md"), "hello world\n")?;
        fs::create_dir_all(workspace_dir.join("nested"))?;
        fs::write(workspace_dir.join("nested/hello.txt"), "nested\n")?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::write(
            workspace_dir.join(".instafy/should-not-commit.txt"),
            "nope\n",
        )?;

        let commit =
            commit_and_push_dirty(&config, workspace_dir.as_path(), "test: sync dirty", None)?;

        let verify_dir = root.join("verify");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_dir.to_str().unwrap(),
            ],
        )?;

        let readme = fs::read_to_string(verify_dir.join("README.md"))?;
        assert_eq!(readme, "hello world\n");
        let nested = fs::read_to_string(verify_dir.join("nested/hello.txt"))?;
        assert_eq!(nested, "nested\n");
        assert!(
            !verify_dir.join(".instafy/should-not-commit.txt").exists(),
            "reserved .instafy paths should not be committed (got commit {commit})"
        );

        Ok(())
    }

    #[test]
    fn commit_and_push_dirty_persists_files_inside_embedded_git_repos() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        let embedded_dir = workspace_dir.join("nested");
        fs::create_dir_all(&embedded_dir)?;
        init_repo(&embedded_dir, "main")?;
        run_git(&embedded_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &embedded_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(embedded_dir.join("inner.txt"), "inner\n")?;
        run_git(&embedded_dir, &["add", "inner.txt"])?;
        run_git(&embedded_dir, &["commit", "-m", "inner"])?;

        fs::write(embedded_dir.join("hello.txt"), "embedded-hello\n")?;

        let commit = commit_and_push_dirty(
            &config,
            workspace_dir.as_path(),
            "test: sync embedded",
            None,
        )?;

        assert!(
            embedded_dir.join(".git").exists(),
            "embedded repo .git should be restored after sync (got commit {commit})"
        );

        let verify_dir = root.join("verify");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_dir.to_str().unwrap(),
            ],
        )?;

        let persisted = fs::read_to_string(verify_dir.join("nested/hello.txt"))?;
        assert_eq!(persisted, "embedded-hello\n");
        assert!(
            !verify_dir.join("nested/.git").exists(),
            "embedded .git directories should not be committed to canonical (got commit {commit})"
        );

        let tree = git_stdout(&verify_dir, &["ls-tree", "-r", "--name-only", "HEAD"])?;
        assert!(
            !tree.lines().any(|line| {
                line == ".instafy/origin-staging"
                    || line.starts_with(".instafy/origin-staging/")
                    || line.contains("/.git/")
                    || line.ends_with("/.git")
                    || line.contains(".git.instafy-hidden-")
            }),
            "canonical commit should not include nested .git metadata (got commit {commit})"
        );

        Ok(())
    }

    #[test]
    fn commit_and_push_dirty_pushes_clean_workspace_commits() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        // Create a local commit without pushing (workspace remains clean afterwards).
        fs::write(workspace_dir.join("README.md"), "local\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "README.md"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "local commit"],
            None,
        )?;

        let verify_before = root.join("verify-before");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_before.to_str().unwrap(),
            ],
        )?;
        let before = fs::read_to_string(verify_before.join("README.md"))?;
        assert_eq!(before, "hello\n");

        // Sync should push the existing local commit even though there are no dirty paths.
        let commit =
            commit_and_push_dirty(&config, workspace_dir.as_path(), "test: sync clean", None)?;

        let verify_after = root.join("verify-after");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_after.to_str().unwrap(),
            ],
        )?;
        let after = fs::read_to_string(verify_after.join("README.md"))?;
        assert_eq!(after, "local\n");

        let remote_head = git_stdout(&verify_after, &["rev-parse", "HEAD"])?;
        assert_eq!(remote_head, commit);

        Ok(())
    }

    #[test]
    fn push_existing_head_preserves_staged_and_untracked_dirt() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;

        fs::write(workspace_dir.join("README.md"), "committed import\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "README.md"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "import baseline"],
            None,
        )?;
        let expected = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;

        fs::write(workspace_dir.join("README.md"), "staged user dirt\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "README.md"], None)?;
        fs::write(workspace_dir.join("untracked.txt"), "untracked user dirt\n")?;
        let status_before = run_git_ok(
            &workspace_dir,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .stdout;

        let pushed = push_existing_head(&config, &workspace_dir, &expected, None)?;
        assert_eq!(pushed, expected);
        let status_after = run_git_ok(
            &workspace_dir,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .stdout;
        assert_eq!(status_after, status_before);

        let remote_head = git_stdout(&remote_dir, &["rev-parse", "refs/heads/main"])?;
        assert_eq!(remote_head, expected);
        let verify_dir = root.join("verify");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_dir.to_str().unwrap(),
            ],
        )?;
        assert_eq!(
            fs::read_to_string(verify_dir.join("README.md"))?,
            "committed import\n"
        );
        assert!(!verify_dir.join("untracked.txt").exists());
        Ok(())
    }

    #[test]
    fn push_existing_head_treats_remote_descendant_as_successful_replay() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;

        fs::write(workspace_dir.join("imported.txt"), "imported\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "imported.txt"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "import commit"],
            None,
        )?;
        let expected = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;

        // The first request reached the remote, but model its response as lost.
        assert_eq!(
            push_existing_head(&config, &workspace_dir, &expected, None)?,
            expected
        );

        // A separate writer advances the remote from expected A to descendant B.
        let competitor_dir = root.join("competitor");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                competitor_dir.to_str().unwrap(),
            ],
        )?;
        run_git(&competitor_dir, &["config", "user.name", "Competitor"])?;
        run_git(
            &competitor_dir,
            &["config", "user.email", "competitor@instafy.dev"],
        )?;
        fs::write(competitor_dir.join("newer.txt"), "newer remote work\n")?;
        run_git(&competitor_dir, &["add", "newer.txt"])?;
        run_git(&competitor_dir, &["commit", "-m", "advance remote"])?;
        run_git(&competitor_dir, &["push", "origin", "main"])?;
        let remote_descendant = git_stdout(&competitor_dir, &["rev-parse", "HEAD"])?;
        assert_ne!(remote_descendant, expected);

        // Retrying A succeeds idempotently and must not rewrite newer remote B.
        let replayed = push_existing_head(&config, &workspace_dir, &expected, None)?;
        assert_eq!(replayed, expected);
        assert_eq!(
            git_stdout(&remote_dir, &["rev-parse", "refs/heads/main"])?,
            remote_descendant
        );
        assert_eq!(
            super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?,
            expected
        );
        Ok(())
    }

    #[test]
    fn push_existing_head_accepts_replay_after_local_and_remote_advance() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;

        fs::write(workspace_dir.join("imported.txt"), "import A\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "imported.txt"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "import A"],
            None,
        )?;
        let expected_a = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;
        assert_eq!(
            push_existing_head(&config, &workspace_dir, &expected_a, None)?,
            expected_a
        );

        fs::write(workspace_dir.join("newer.txt"), "descendant B\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "newer.txt"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "descendant B"],
            None,
        )?;
        let descendant_b = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;
        assert_eq!(
            push_existing_head(&config, &workspace_dir, &descendant_b, None)?,
            descendant_b
        );

        fs::write(workspace_dir.join("local-dirt.txt"), "leave untouched\n")?;
        let status_before = run_git_ok(
            &workspace_dir,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .stdout;

        let replayed = push_existing_head(&config, &workspace_dir, &expected_a, None)?;
        assert_eq!(replayed, expected_a);
        assert_eq!(
            super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?,
            descendant_b
        );
        assert_eq!(
            git_stdout(&remote_dir, &["rev-parse", "refs/heads/main"])?,
            descendant_b
        );
        let status_after = run_git_ok(
            &workspace_dir,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .stdout;
        assert_eq!(status_after, status_before);
        Ok(())
    }

    #[test]
    fn push_existing_head_rejects_head_mismatch_without_push() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;
        let remote_before = git_stdout(&remote_dir, &["rev-parse", "refs/heads/main"])?;

        fs::write(workspace_dir.join("imported.txt"), "unpublished import\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "imported.txt"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "unpublished import"],
            None,
        )?;
        let expected = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;

        fs::write(workspace_dir.join("README.md"), "new local head\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "README.md"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "new local head"],
            None,
        )?;
        let actual = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;
        assert_ne!(actual, expected);

        let error = push_existing_head(&config, &workspace_dir, &expected, None)
            .expect_err("mismatched HEAD must fail");
        assert!(matches!(error, OriginError::Conflict(_)));
        assert!(error
            .to_string()
            .contains("remote does not contain expected commit"));
        assert_eq!(
            git_stdout(&remote_dir, &["rev-parse", "refs/heads/main"])?,
            remote_before
        );
        assert_eq!(
            super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?,
            actual
        );
        Ok(())
    }

    #[test]
    fn push_existing_head_returns_conflict_when_remote_advanced() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;
        fs::write(workspace_dir.join("local.txt"), "local import\n")?;
        run_git_ok(&workspace_dir, &["add", "--", "local.txt"], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "local import"],
            None,
        )?;
        let expected = super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?;

        let competitor_dir = root.join("competitor");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                competitor_dir.to_str().unwrap(),
            ],
        )?;
        run_git(&competitor_dir, &["config", "user.name", "Competitor"])?;
        run_git(
            &competitor_dir,
            &["config", "user.email", "competitor@instafy.dev"],
        )?;
        fs::write(competitor_dir.join("remote.txt"), "remote advance\n")?;
        run_git(&competitor_dir, &["add", "remote.txt"])?;
        run_git(&competitor_dir, &["commit", "-m", "remote advance"])?;
        run_git(&competitor_dir, &["push", "origin", "main"])?;
        let remote_advanced = git_stdout(&competitor_dir, &["rev-parse", "HEAD"])?;

        let error = push_existing_head(&config, &workspace_dir, &expected, None)
            .expect_err("non-fast-forward push must fail");
        assert!(matches!(error, OriginError::Conflict(_)));
        assert!(error.to_string().contains("non-fast-forward"));
        assert_eq!(
            git_stdout(&remote_dir, &["rev-parse", "refs/heads/main"])?,
            remote_advanced
        );
        assert_eq!(
            super::git_stdout(&workspace_dir, &["rev-parse", "HEAD"], None)?,
            expected
        );
        Ok(())
    }

    #[test]
    fn commit_and_push_paths_discards_failed_local_sync_commit_before_next_selected_sync(
    ) -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;
        install_block_path_hook(&remote_dir, "blocked")?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        fs::create_dir_all(workspace_dir.join("blocked"))?;
        fs::write(workspace_dir.join("blocked/random_01.txt"), "blocked\n")?;
        fs::create_dir_all(workspace_dir.join("nested"))?;
        fs::write(workspace_dir.join("nested/ok.txt"), "allowed\n")?;

        let blocked_error = commit_and_push_paths(
            &config,
            workspace_dir.as_path(),
            &[String::from("blocked/random_01.txt")],
            "test: blocked",
            None,
        )
        .expect_err("expected blocked path push to be rejected by remote hook");
        let blocked_message = blocked_error.to_string();
        assert!(
            blocked_message.contains("blocked path 'blocked/random_01.txt'"),
            "expected blocked-path error, got: {blocked_message}"
        );

        let commit = commit_and_push_paths(
            &config,
            workspace_dir.as_path(),
            &[String::from("nested/ok.txt")],
            "test: allowed",
            None,
        )?;
        assert!(!commit.trim().is_empty());

        let verify_dir = root.join("verify");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_dir.to_str().unwrap(),
            ],
        )?;

        let persisted = fs::read_to_string(verify_dir.join("nested/ok.txt"))?;
        assert_eq!(persisted, "allowed\n");
        assert!(
            !verify_dir.join("blocked/random_01.txt").exists(),
            "blocked file should not have been pushed after later selective sync"
        );

        Ok(())
    }

    #[test]
    fn commit_and_push_dirty_handles_unborn_local_branch_when_remote_has_commits(
    ) -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(workspace_dir.join(".instafy"))?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        // Simulate a broken/unborn local branch state even though the remote branch exists.
        run_git_ok(&workspace_dir, &["init", "-b", "main"], None)?;
        run_git_ok(
            &workspace_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
            None,
        )?;
        run_git_ok(&workspace_dir, &["fetch", "--prune", "origin"], None)?;
        run_git_ok(&workspace_dir, &["checkout", "-B", "main"], None)?;

        let has_remote_branch = git_status_success(
            &workspace_dir,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                "refs/remotes/origin/main",
            ],
        )
        .unwrap_or(false);
        assert!(has_remote_branch, "expected origin/main to be fetched");

        let has_head =
            git_status_success(&workspace_dir, &["rev-parse", "--verify", "HEAD"]).unwrap_or(false);
        assert!(!has_head, "expected HEAD to be unborn before sync");

        let commit =
            commit_and_push_dirty(&config, workspace_dir.as_path(), "test: sync unborn", None)?;

        let remote_verify = root.join("remote-verify");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                remote_verify.to_str().unwrap(),
            ],
        )?;
        let remote_head = git_stdout(&remote_verify, &["rev-parse", "HEAD"])?;
        assert_eq!(remote_head, commit);

        Ok(())
    }

    #[test]
    fn ensure_git_checkout_preserves_user_root_git_dir() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        init_repo(&workspace_dir, "main")?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        assert!(
            workspace_dir.join(".git").exists(),
            "expected user root .git to remain after checkout"
        );
        assert!(
            workspace_dir.join(".instafy").join(".git").exists(),
            "expected instafy git dir to exist after checkout"
        );

        let readme = fs::read_to_string(workspace_dir.join("README.md"))?;
        assert_eq!(readme, "hello\n");

        Ok(())
    }

    #[test]
    fn ensure_git_checkout_fast_forwards_clean_workspace_after_remote_push() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        let updater_dir = root.join("updater");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                updater_dir.to_str().unwrap(),
            ],
        )?;
        run_git(&updater_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &updater_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(updater_dir.join("REMOTE_ONLY.txt"), "from-remote\n")?;
        run_git(&updater_dir, &["add", "REMOTE_ONLY.txt"])?;
        run_git(&updater_dir, &["commit", "-m", "remote update"])?;
        run_git(&updater_dir, &["push", "origin", "main"])?;

        ensure_git_checkout(&config, None)?;

        let workspace_file = fs::read_to_string(workspace_dir.join("REMOTE_ONLY.txt"))?;
        assert_eq!(workspace_file, "from-remote\n");

        let workspace_head = String::from_utf8_lossy(
            &run_git_ok(&workspace_dir, &["rev-parse", "HEAD"], None)?.stdout,
        )
        .trim()
        .to_string();
        let remote_head = git_stdout(&updater_dir, &["rev-parse", "HEAD"])?;
        assert_eq!(workspace_head, remote_head);

        Ok(())
    }

    #[test]
    fn align_local_branch_preserves_clean_local_commit_ahead_of_remote() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        let imported_dir = workspace_dir.join("repos").join("octocat-hello-world");
        fs::create_dir_all(&imported_dir)?;
        fs::write(imported_dir.join("README"), "Hello World!\n")?;
        run_git_ok(&workspace_dir, &["add", "-A", "--", "."], None)?;
        run_git_ok(
            &workspace_dir,
            &["commit", "--no-gpg-sign", "-m", "imported baseline"],
            None,
        )?;

        let head_before = String::from_utf8_lossy(
            &run_git_ok(&workspace_dir, &["rev-parse", "HEAD"], None)?.stdout,
        )
        .trim()
        .to_string();

        align_local_branch_to_remote_tip_preserving_worktree(&config, &workspace_dir, None)?;

        let head_after = String::from_utf8_lossy(
            &run_git_ok(&workspace_dir, &["rev-parse", "HEAD"], None)?.stdout,
        )
        .trim()
        .to_string();
        assert_eq!(head_after, head_before);
        assert_eq!(
            fs::read_to_string(
                workspace_dir
                    .join("repos")
                    .join("octocat-hello-world")
                    .join("README")
            )?,
            "Hello World!\n"
        );

        Ok(())
    }

    #[test]
    fn ensure_git_checkout_recovers_from_broken_instafy_git_dir() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();

        let remote_dir = root.join("remote.git");
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;

        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(workspace_dir.join(".instafy").join(".git"))?;
        fs::write(
            workspace_dir.join(".instafy").join(".git").join("HEAD"),
            "ref: refs/heads/main\n",
        )?;

        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.clone(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        };

        ensure_git_checkout(&config, None)?;

        let readme = fs::read_to_string(workspace_dir.join("README.md"))?;
        assert_eq!(readme, "hello\n");
        assert!(workspace_dir
            .join(".instafy")
            .join(".git")
            .join("config")
            .exists());

        Ok(())
    }

    #[test]
    fn list_recent_commits_returns_latest_first() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "first\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "first version"])?;
        fs::write(workspace_dir.join("README.md"), "second\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "second version"])?;

        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        let history = list_recent_commits(&workspace_dir, 5, None)?;
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].subject, "second version");
        assert_eq!(history[1].subject, "first version");
        assert_eq!(history[0].author_name, "Instafy Test");
        assert_eq!(history[0].author_email, "playwright@instafy.dev");
        assert!(!history[0].commit.is_empty());
        assert!(!history[0].short_commit.is_empty());
        assert!(!history[0].committed_at.is_empty());

        Ok(())
    }

    #[test]
    fn resolve_history_head_ref_returns_current_branch() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;

        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("README.md"), "first\n")?;
        run_git(&workspace_dir, &["add", "README.md"])?;
        run_git(&workspace_dir, &["commit", "-m", "first version"])?;

        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;

        let head = resolve_history_head_ref(&workspace_dir, None)?;
        assert_eq!(head.branch.as_deref(), Some("main"));
        assert_eq!(head.head_ref.as_deref(), Some("main"));

        Ok(())
    }

    fn revert_test_config(workspace_dir: &Path, remote_dir: &Path) -> anyhow::Result<ServerConfig> {
        Ok(ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace_dir.to_path_buf(),
            git_remote_url: Some(remote_dir.to_string_lossy().to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "playwright@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: Url::parse("http://127.0.0.1:8788")?,
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        })
    }

    fn seed_remote_with_readme(root: &Path, remote_dir: &Path) -> anyhow::Result<()> {
        run_git(root, &["init", "--bare", remote_dir.to_str().unwrap()])?;
        let seed_dir = root.join("seed");
        fs::create_dir_all(&seed_dir)?;
        init_repo(&seed_dir, "main")?;
        run_git(&seed_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &seed_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(seed_dir.join("README.md"), "hello\n")?;
        run_git(&seed_dir, &["add", "README.md"])?;
        run_git(&seed_dir, &["commit", "-m", "init"])?;
        run_git(
            &seed_dir,
            &["remote", "add", "origin", remote_dir.to_str().unwrap()],
        )?;
        run_git(&seed_dir, &["push", "-u", "origin", "main"])?;
        Ok(())
    }

    #[test]
    fn revert_commit_and_push_creates_forward_revert() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;

        fs::write(workspace_dir.join("README.md"), "world\n")?;
        let bad_commit = commit_and_push_dirty(
            &config,
            workspace_dir.as_path(),
            "instafy: bad change",
            None,
        )?;

        let revert_commit =
            revert_commit_and_push(&config, workspace_dir.as_path(), &bad_commit, None)?;
        assert_ne!(revert_commit, bad_commit);

        // The workspace content is back to the pre-change state...
        let local = fs::read_to_string(workspace_dir.join("README.md"))?;
        assert_eq!(local, "hello\n");

        // ...and so is a fresh clone of canonical, with history intact.
        let verify_dir = root.join("verify");
        run_git(
            root,
            &[
                "clone",
                "--branch",
                "main",
                remote_dir.to_str().unwrap(),
                verify_dir.to_str().unwrap(),
            ],
        )?;
        let persisted = fs::read_to_string(verify_dir.join("README.md"))?;
        assert_eq!(persisted, "hello\n");
        let log = git_stdout(&verify_dir, &["log", "--pretty=%s"])?;
        let subjects = log.lines().collect::<Vec<_>>();
        assert_eq!(subjects.len(), 3, "expected init, change, revert: {log}");
        assert!(
            subjects[0].starts_with("Revert"),
            "tip should be the revert commit: {log}"
        );

        Ok(())
    }

    #[test]
    fn revert_commit_and_push_requires_clean_worktree() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;

        fs::write(workspace_dir.join("README.md"), "world\n")?;
        let commit =
            commit_and_push_dirty(&config, workspace_dir.as_path(), "instafy: change", None)?;

        // Dirty the tracked worktree and expect the revert to refuse.
        fs::write(workspace_dir.join("README.md"), "dirty edit\n")?;
        let result = revert_commit_and_push(&config, workspace_dir.as_path(), &commit, None);
        let error = result.expect_err("revert should refuse on dirty worktree");
        assert!(
            error.to_string().contains("unsaved changes"),
            "unexpected error: {error}"
        );

        // The dirty edit must survive untouched.
        let local = fs::read_to_string(workspace_dir.join("README.md"))?;
        assert_eq!(local, "dirty edit\n");

        Ok(())
    }

    #[test]
    fn list_recent_commits_surfaces_resolution_trailer() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let root = sandbox.path();
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;

        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;

        fs::write(workspace_dir.join("notes.txt"), "merged\n")?;
        run_instafy_git(&workspace_dir, &["add", "notes.txt"])?;
        run_instafy_git(
            &workspace_dir,
            &[
                "commit",
                "--no-gpg-sign",
                "-m",
                "instafy: resolve sync conflict (notes.txt)",
                "-m",
                "Instafy-Resolved-By: assistant",
            ],
        )?;

        let entries = list_recent_commits(&workspace_dir, 5, None)?;
        assert!(!entries.is_empty());
        let tip = &entries[0];
        assert_eq!(tip.resolved_by.as_deref(), Some("assistant"));
        assert!(entries
            .iter()
            .skip(1)
            .all(|entry| entry.resolved_by.is_none()));

        Ok(())
    }

    fn run_instafy_git(workspace_dir: &Path, args: &[&str]) -> anyhow::Result<()> {
        let git_dir = workspace_dir.join(".instafy").join(".git");
        let mut full_args = vec![
            "--git-dir",
            git_dir.to_str().unwrap(),
            "--work-tree",
            workspace_dir.to_str().unwrap(),
        ];
        full_args.extend_from_slice(args);
        let output = Command::new("git")
            .current_dir(workspace_dir)
            .args(&full_args)
            .output()
            .with_context(|| format!("failed to run instafy git {:?}", args))?;
        if output.status.success() {
            return Ok(());
        }
        anyhow::bail!(
            "instafy git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
}
