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

/// Transfer rate, in bytes per second, below which curl counts a git HTTP
/// transfer as stalled. It only has to separate "moving" from "stopped": a
/// healthy transfer moves orders of magnitude faster, and the quiet phases of
/// a healthy exchange send at most a few bytes of keep-alive.
const HTTP_LOW_SPEED_LIMIT_BYTES_PER_SECOND: u32 = 1_000;

/// Seconds a git HTTP transfer may stay below
/// [`HTTP_LOW_SPEED_LIMIT_BYTES_PER_SECOND`] before curl aborts it with
/// "Operation too slow". One window covers every command. The longest quiet
/// phase of a healthy exchange is a push waiting for the remote's update hook,
/// which checks every changed path and takes longer for large commits (a
/// 2,000-path commit kept a macOS test remote quiet for about 90 seconds), so
/// the window is 300 seconds. A fetch from a stalled remote still fails after
/// about five minutes instead of holding the workspace locks forever.
const HTTP_LOW_SPEED_TIME_SECONDS: u32 = 300;

#[cfg(test)]
thread_local! {
    /// Shortens the low-speed window for git commands built on the current
    /// thread, so stall tests finish in seconds.
    static HTTP_LOW_SPEED_TIME_OVERRIDE: std::cell::Cell<Option<u32>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
thread_local! {
    /// Replaces the `git` executable for commands built on the current thread,
    /// so a test can run the server against a wrapper that emulates an older
    /// or misbehaving git.
    pub(crate) static GIT_PROGRAM_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

fn git_program() -> std::ffi::OsString {
    #[cfg(test)]
    if let Some(program) = GIT_PROGRAM_OVERRIDE.with(|program| program.borrow().clone()) {
        return program.into_os_string();
    }
    std::ffi::OsString::from("git")
}

fn http_low_speed_time_seconds() -> u32 {
    #[cfg(test)]
    if let Some(seconds) = HTTP_LOW_SPEED_TIME_OVERRIDE.with(std::cell::Cell::get) {
        return seconds;
    }
    HTTP_LOW_SPEED_TIME_SECONDS
}

/// Construct every git process owned by the origin server with repository
/// hooks disabled. Workspaces are user-controlled, while these commands can
/// run with server credentials (including bearer tokens), so repository hook
/// configuration must never be allowed to execute workspace code.
pub(crate) fn server_git_command() -> Command {
    let mut command = Command::new(git_program());
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
    // Without a transfer-speed floor a stalled fetch, push or ls-remote waits
    // forever while the caller holds the workspace locks. Only the HTTP
    // transport reads these settings, so local commands are unaffected. Git
    // lets `GIT_HTTP_LOW_SPEED_*` override every config source, so the
    // environment is pinned to the same values; an inherited value (for
    // example a limit of 0) would otherwise remove the bound.
    let low_speed_limit = HTTP_LOW_SPEED_LIMIT_BYTES_PER_SECOND.to_string();
    let low_speed_time = http_low_speed_time_seconds().to_string();
    command
        .env("GIT_HTTP_LOW_SPEED_LIMIT", &low_speed_limit)
        .env("GIT_HTTP_LOW_SPEED_TIME", &low_speed_time)
        .arg("-c")
        .arg(format!("http.lowSpeedLimit={low_speed_limit}"))
        .arg("-c")
        .arg(format!("http.lowSpeedTime={low_speed_time}"));
    // The stall tests talk to a loopback remote and check the request it
    // received, so a proxy inherited from the test runner must not intercept
    // it. Production commands keep the server's proxy settings.
    #[cfg(test)]
    if HTTP_LOW_SPEED_TIME_OVERRIDE
        .with(std::cell::Cell::get)
        .is_some()
    {
        for key in [
            "http_proxy",
            "HTTP_PROXY",
            "https_proxy",
            "HTTPS_PROXY",
            "all_proxy",
            "ALL_PROXY",
        ] {
            command.env_remove(key);
        }
    }
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
pub(crate) fn pin_command_cwd(command: &mut Command, directory: &WorkspaceDir) -> Result<()> {
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
pub(crate) fn pin_command_cwd(command: &mut Command, directory: &WorkspaceDir) -> Result<()> {
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

pub(crate) fn instafy_git_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".instafy").join(".git")
}

fn instafy_git_dir_has_config(workspace_root: &Path) -> bool {
    WorkspaceDir::open(workspace_root)
        .and_then(|workspace| workspace.open_file(".instafy/.git/config"))
        .is_ok()
}

pub(crate) fn validate_instafy_git_layout(workspace_root: &Path) -> Result<()> {
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

    // The seed of the working folder's id (see `crate::working_state`): data
    // only, kept only as a lower-case UUID. A slot is named by a hash of it,
    // so whatever a turn writes here can only rename this folder's own slot.
    if key == crate::working_state::WORKING_SET_CONFIG_KEY.to_ascii_lowercase() {
        let value = value.trim();
        if !crate::working_state::is_working_set_id(value) {
            return None;
        }
        return Some(TrustedGitConfigEntry {
            section: "instafy",
            subsection: None,
            name: "workingSet",
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

pub(crate) fn refresh_instafy_git_worktree_config(workspace_root: &Path) -> Result<()> {
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

pub(crate) fn is_network_git_command(args: &[&str]) -> bool {
    matches!(
        args.first().copied().unwrap_or_default(),
        "fetch" | "pull" | "push" | "ls-remote" | "remote"
    )
}

fn stage_applied_paths(workspace_root: &Path, applied_paths: &[String]) -> Result<(), OriginError> {
    git_with_literal_paths(
        workspace_root,
        &[
            "add",
            "--force",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        applied_paths,
    )
}

fn stage_deleted_paths(workspace_root: &Path, deleted_paths: &[String]) -> Result<(), OriginError> {
    git_with_literal_paths(
        workspace_root,
        &[
            "rm",
            "-r",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        deleted_paths,
    )
}

/// Run `args` (a command that reads its paths with `--pathspec-from-file=-
/// --pathspec-file-nul`) in the checkout under the workspace's git lock,
/// with `paths` on stdin, each read as a name: an apply's paths come from
/// the request, so they are never arguments of git, and a name such as
/// `notes[1].md` never matches `notes1.md` as a pattern would.
fn git_with_literal_paths<S: AsRef<str>>(
    workspace_root: &Path,
    args: &[&str],
    paths: &[S],
) -> Result<(), OriginError> {
    if paths.is_empty() {
        return Ok(());
    }
    let lock = workspace_git_lock(workspace_root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let list = crate::workspace_git::nul_list(paths);
    crate::workspace_git::WorkspaceGit::new(workspace_root, None)
        .ok_opts(
            args,
            &crate::workspace_git::RunOpts {
                stdin: Some(&list),
                literal_pathspecs: true,
                ..Default::default()
            },
        )
        .map_err(|error| OriginError::internal(error.to_string()))
}

/// Run `args` (a command that reads its paths with `--pathspec-from-file=-
/// --pathspec-file-nul`) in the checkout under the workspace's git lock,
/// with `path` alone on stdin, read as a name, as
/// [`git_with_literal_paths`] does; the output whatever the exit status,
/// for callers that read git's own message.
fn git_literal_path(
    workspace_root: &Path,
    args: &[&str],
    path: &str,
) -> Result<std::process::Output, OriginError> {
    let lock = workspace_git_lock(workspace_root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let list = crate::workspace_git::nul_list(&[path]);
    crate::workspace_git::WorkspaceGit::new(workspace_root, None)
        .run_opts(
            args,
            &crate::workspace_git::RunOpts {
                stdin: Some(&list),
                literal_pathspecs: true,
                ..Default::default()
            },
        )
        .map_err(|error| OriginError::internal(error.to_string()))
}

/// Commit what is staged in the checkout under the workspace's git lock,
/// with `message` on stdin (`--file=-`): an apply's message comes from the
/// request, so it is never an argument of git, and a long one is never cut
/// off by the system's limit on an argument's length.
fn commit_staged(workspace_root: &Path, message: &str) -> Result<(), OriginError> {
    let lock = workspace_git_lock(workspace_root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    crate::workspace_git::WorkspaceGit::new(workspace_root, None)
        .ok_opts(
            &["commit", "--no-gpg-sign", "--file=-"],
            &crate::workspace_git::RunOpts {
                stdin: Some(message.as_bytes()),
                ..Default::default()
            },
        )
        .map_err(|error| OriginError::internal(error.to_string()))
}

/// Unstage what a sync never commits, and list what stays staged. Local
/// git only: no credential goes with it.
fn unstage_sync_reserved_paths(workspace_root: &Path) -> Result<String, OriginError> {
    let staged = git_stdout(workspace_root, &["diff", "--cached", "--name-only"], None)
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
        run_git_ok(workspace_root, &args, None)
            .map_err(|error| OriginError::internal(error.to_string()))?;
    }

    git_stdout(workspace_root, &["diff", "--cached", "--name-only"], None)
        .map_err(|error| OriginError::internal(error.to_string()))
}

pub(crate) fn looks_like_transient_http_error(stderr: &str) -> bool {
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

pub(crate) struct EmbeddedGitDirGuard {
    workspace: WorkspaceDir,
    renames: Vec<(String, String)>,
}

impl EmbeddedGitDirGuard {
    pub(crate) fn hide(workspace_root: &Path, paths: &[&str]) -> Result<Self> {
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

/// Commit an apply's `applied_paths` and `deleted_paths` (and nothing else
/// staged) on the checkout, with `message`. Every command it runs is local,
/// so it takes no credential: a caller's bearer never reaches git here.
pub fn commit_apply_locally(
    workspace_root: &Path,
    applied_paths: &[String],
    deleted_paths: &[String],
    message: &str,
) -> Result<Option<String>, OriginError> {
    if !is_git_repo(workspace_root) {
        return Ok(None);
    }

    // Snapshot the real index before clearing it. The import commit is built
    // from only its own paths; afterward the original index is restored and
    // just those touched entries are advanced to the new HEAD. This preserves
    // unrelated staged content byte-for-byte, including partial staging.
    let base_head = optional_head_rev(workspace_root)?;
    let mut index_snapshot = GitIndexSnapshot::capture(workspace_root)?;
    let operation = (|| -> Result<Option<String>, OriginError> {
        let reset_args = if base_head.is_some() {
            &["reset", "--mixed", "HEAD"][..]
        } else {
            &["read-tree", "--empty"][..]
        };
        run_git_ok(workspace_root, reset_args, None)
            .map_err(|error| OriginError::internal(error.to_string()))?;

        let mut touched = Vec::with_capacity(applied_paths.len() + deleted_paths.len());
        touched.extend(applied_paths.iter().map(String::as_str));
        touched.extend(deleted_paths.iter().map(String::as_str));
        let _embedded_guard = EmbeddedGitDirGuard::hide(workspace_root, &touched)
            .map_err(|error| OriginError::internal(error.to_string()))?;

        stage_applied_paths(workspace_root, applied_paths)?;
        stage_deleted_paths(workspace_root, deleted_paths)?;

        let staged = unstage_sync_reserved_paths(workspace_root)?;
        if staged.trim().is_empty() {
            index_snapshot.restore_original()?;
            return Ok(base_head.clone());
        }

        commit_staged(workspace_root, message)?;

        let head = git_stdout(workspace_root, &["rev-parse", "HEAD"], None)
            .map_err(|error| OriginError::internal(error.to_string()))?;
        index_snapshot.restore_original()?;
        reset_index_paths_to_head(workspace_root, &touched)?;
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

fn optional_head_rev(workspace_root: &Path) -> Result<Option<String>, OriginError> {
    let output = run_git(workspace_root, &["rev-parse", "--verify", "HEAD"], None)
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
    index_snapshot: &mut GitIndexSnapshot,
) -> Result<()> {
    // The route-level workspace lock guarantees that a changed HEAD here was
    // produced by this apply attempt. CAS on the observed commit still keeps a
    // surprising concurrent ref update from being overwritten silently.
    let current_head =
        optional_head_rev(workspace_root).map_err(|error| anyhow::anyhow!(error.to_string()));
    let head_rollback = match current_head {
        Err(error) => Err(error),
        Ok(current_head) => match (base_head, current_head.as_deref()) {
            (Some(base), Some(current)) if !base.eq_ignore_ascii_case(current) => {
                run_git_ok(workspace_root, &["update-ref", "HEAD", base, current], None).map(|_| ())
            }
            (None, Some(current)) => {
                run_git_ok(workspace_root, &["update-ref", "-d", "HEAD", current], None).map(|_| ())
            }
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

fn reset_index_paths_to_head(workspace_root: &Path, touched: &[&str]) -> Result<(), OriginError> {
    git_with_literal_paths(
        workspace_root,
        &[
            "reset",
            "-q",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        touched,
    )
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

pub(crate) fn is_sync_reserved_path(path: &str) -> bool {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    /// The commit's first parent, when the listing asked for parents (a
    /// revert of the commit undoes its change against this one). Absent for
    /// a root commit and from listings that do not ask.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_parent: Option<String>,
    /// How many parents the commit has, when the listing asked for parents:
    /// more than one is a merge, which a revert needs a base for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_count: Option<usize>,
    /// Who made the version, when the listing decides it (see
    /// [`HistoryActor::of_author`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<HistoryActor>,
}

/// Who made a version in History.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryActor {
    /// A person saving in Studio, named by their per-space pseudonym.
    User,
    /// Instafy itself: an origin, a workspace runtime's publish, a service.
    Service,
    /// Anyone else, such as a person committing with their own git identity.
    External,
}

impl HistoryActor {
    /// Decide by the author address: an author pseudonym
    /// (`…@users.noreply.instafy.dev`) is a person; `service_email` (the
    /// origin's own identity) or any other `@instafy.dev` address is
    /// Instafy; anything else is external. Letter case is ignored.
    pub fn of_author(author_email: &str, service_email: &str) -> Self {
        let email = author_email.trim().to_ascii_lowercase();
        if email.ends_with(crate::auth::AUTHOR_PSEUDONYM_DOMAIN) {
            return Self::User;
        }
        let service = service_email.trim().to_ascii_lowercase();
        if (!service.is_empty() && email == service) || email.ends_with("@instafy.dev") {
            return Self::Service;
        }
        Self::External
    }
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
    let format = HistoryFormat::new();
    let stdout = git_stdout(
        workspace_root,
        &[
            "log",
            "--max-count",
            max_count.as_str(),
            "--date=iso-strict",
            &format.pretty_arg(),
        ],
        bearer_token,
    )
    .map_err(|error| OriginError::internal(error.to_string()))?;

    Ok(format.parse(&stdout))
}

/// The `git log` format of one history listing: per commit the id, short
/// id, committer date, author name and email, subject and the
/// `Instafy-Resolved-By` trailer.
///
/// Commit text can hold any byte but NUL, separator bytes included, so the
/// field and record separators carry a random token made for this one
/// listing: no commit written before it can contain them, and no text can
/// split a record or add one. The id comes first and must be a commit id.
pub(crate) struct HistoryFormat {
    field: String,
    record: String,
    token: String,
}

impl HistoryFormat {
    const FIELDS: usize = 7;

    pub(crate) fn new() -> Self {
        let token = Uuid::new_v4().simple().to_string();
        Self {
            field: format!("\u{1f}{token}\u{1f}"),
            record: format!("\u{1e}{token}\u{1e}"),
            token,
        }
    }

    /// The `--pretty=format:` argument.
    pub(crate) fn pretty_arg(&self) -> String {
        let field = format!("%x1f{}%x1f", self.token);
        let record = format!("%x1e{}%x1e", self.token);
        let fields = [
            "%H",
            "%h",
            "%cI",
            "%an",
            "%ae",
            "%s",
            "%(trailers:key=Instafy-Resolved-By,valueonly)",
        ];
        format!("--pretty=format:{}{record}", fields.join(&field))
    }

    /// Parse the output of `git log` run with [`Self::pretty_arg`]. A record
    /// with the wrong number of fields, or whose first field is not a commit
    /// id, is left out. Entries never carry a first parent.
    pub(crate) fn parse(&self, stdout: &str) -> Vec<GitHistoryEntry> {
        let mut entries = Vec::new();
        for raw_record in stdout.split(self.record.as_str()) {
            let record = raw_record.trim();
            if record.is_empty() {
                continue;
            }
            let fields: Vec<&str> = record.split(self.field.as_str()).collect();
            if fields.len() != Self::FIELDS {
                continue;
            }
            let commit = fields[0].trim();
            if !is_full_object_id(commit) {
                continue;
            }
            let resolved_by = fields[6]
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string);
            entries.push(GitHistoryEntry {
                commit: commit.to_string(),
                short_commit: fields[1].trim().to_string(),
                committed_at: fields[2].trim().to_string(),
                author_name: fields[3].trim().to_string(),
                author_email: fields[4].trim().to_string(),
                subject: fields[5].trim().to_string(),
                resolved_by,
                first_parent: None,
                parent_count: None,
                actor: None,
            });
        }
        entries
    }
}

/// A full 40- or 64-digit hex object id.
pub(crate) fn is_full_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
    if !is_safe_git_rev(normalized_commit) {
        return Err(OriginError::bad_request("invalid git rev"));
    }

    let stdout = git_stdout(
        workspace_root,
        &[
            "show",
            "--format=",
            "--name-status",
            "--find-renames",
            "--find-copies",
            "--end-of-options",
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
pub(crate) fn is_safe_git_rev(rev: &str) -> bool {
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

/// Put each of `paths` back as `HEAD` has it, or remove it when `HEAD`
/// lacks it. Local git only, so no credential goes with it, and every path
/// reaches git on stdin as a name ([`git_literal_path`]): a request's
/// `notes[1].md` is never a pattern that also puts back `notes1.md`.
pub fn revert_paths(
    workspace_root: &Path,
    paths: &[String],
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
            let output = git_literal_path(
                workspace_root,
                &[
                    "checkout",
                    "HEAD",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &path,
            )?;

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

        let _ = git_literal_path(
            workspace_root,
            &[
                "rm",
                "--cached",
                "-r",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            &path,
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

        assert!(revert_paths(workspace.path(), &["escape/secret.txt".to_string()]).is_err());
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
        )?;
        assert!(commit.is_some());

        let tree = run_git_ok(&workspace_dir, &["ls-tree", "--name-only", "HEAD"], None)?;
        let tree = String::from_utf8_lossy(&tree.stdout).trim_end().to_string();

        assert_eq!(tree, "README.md");
        Ok(())
    }

    /// An apply's local commit, and the HEAD the apply route reads before
    /// it, run local git only, so no command carries a credential: none of
    /// git's argument lists holds an HTTP header.
    #[test]
    fn an_apply_commit_hands_git_no_http_header() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("kept.txt"), "kept\n")?;
        run_git(&workspace_dir, &["add", "-A"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;
        fs::write(workspace_dir.join("applied.txt"), "applied\n")?;

        let log = sandbox.path().join("argv.log");
        let wrapper = crate::test_support::GitWrapper::install(
            sandbox.path(),
            &format!("printf '%s\\n' \"$*\" >> '{}'", log.display()),
        );
        let base = head_rev(&workspace_dir, None);
        let commit = commit_apply_locally(
            &workspace_dir,
            &["applied.txt".to_string()],
            &[],
            "test: apply",
        );
        drop(wrapper);
        let commit = commit?;
        assert!(base.is_some() && commit.is_some() && base != commit);
        let argv = fs::read_to_string(&log)?;
        assert!(argv.lines().any(|line| line.contains("commit")), "{argv}");
        assert!(!argv.to_ascii_lowercase().contains("header"), "{argv}");
        Ok(())
    }

    /// A discard (`/git/revert`) runs local git only, so no command carries
    /// a credential, and it hands git its paths on stdin, never as
    /// arguments.
    #[test]
    fn a_discard_hands_git_no_http_header_and_no_path_argument() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let workspace_dir = sandbox.path().join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        init_repo(&workspace_dir, "main")?;
        run_git(&workspace_dir, &["config", "user.name", "Instafy Test"])?;
        run_git(
            &workspace_dir,
            &["config", "user.email", "playwright@instafy.dev"],
        )?;
        fs::write(workspace_dir.join("kept.txt"), "kept\n")?;
        run_git(&workspace_dir, &["add", "-A"])?;
        run_git(&workspace_dir, &["commit", "-m", "init"])?;
        fs::create_dir_all(workspace_dir.join(".instafy"))?;
        fs::rename(
            workspace_dir.join(".git"),
            workspace_dir.join(".instafy").join(".git"),
        )?;
        fs::write(workspace_dir.join("kept.txt"), "edited\n")?;
        fs::write(workspace_dir.join("fresh.txt"), "new\n")?;

        let log = sandbox.path().join("argv.log");
        let wrapper = crate::test_support::GitWrapper::install(
            sandbox.path(),
            &format!("printf '%s\\n' \"$*\" >> '{}'", log.display()),
        );
        let summary = revert_paths(
            &workspace_dir,
            &["kept.txt".to_string(), "fresh.txt".to_string()],
        );
        drop(wrapper);
        let summary = summary?;
        assert_eq!(summary.reverted, vec!["kept.txt".to_string()]);
        assert_eq!(summary.removed, vec!["fresh.txt".to_string()]);
        assert_eq!(
            fs::read_to_string(workspace_dir.join("kept.txt"))?,
            "kept\n"
        );
        assert!(!workspace_dir.join("fresh.txt").exists());
        let argv = fs::read_to_string(&log)?;
        assert!(argv.lines().any(|line| line.contains("checkout")), "{argv}");
        assert!(!argv.to_ascii_lowercase().contains("header"), "{argv}");
        assert!(
            !argv.contains("kept.txt") && !argv.contains("fresh.txt"),
            "{argv}"
        );
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
            controller_token_source: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
            hosted_checkout: false,
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
            controller_token_source: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
            hosted_checkout: false,
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
            controller_token_source: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
            hosted_checkout: false,
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
            controller_token_source: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json")?,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(1),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
            hosted_checkout: false,
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

    /// Commit text can hold any byte but NUL, including the separator bytes
    /// the listing once split on: it can neither add a row, nor change a
    /// field of its own or another commit, and the single-tenant listing
    /// never carries a first parent.
    #[test]
    fn history_rows_cannot_be_forged_by_commit_text() {
        use crate::workspace_git::{GitIdentity, WorkspaceGit};
        let sandbox = tempdir().unwrap();
        let ws = sandbox.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        crate::test_support::init_workspace_repo(&ws);
        let git = WorkspaceGit::new(&ws, None);
        let tree = git.empty_tree().unwrap();
        let fake = "0123456789abcdef0123456789abcdef01234567";
        let who = |name: &str| GitIdentity::new(name, "someone@instafy.dev");
        let root = git
            .commit_tree(&tree, &[], &who("Root"), &who("Root"), b"root\n")
            .unwrap();
        let shifted = git
            .commit_tree(
                &tree,
                &[&root],
                &who(&format!("Mal\u{1f}lory\u{1e}{fake}")),
                &who("Committer"),
                format!("change\u{1f}\u{1f}{fake}\n").as_bytes(),
            )
            .unwrap();
        let injected = git
            .commit_tree(
                &tree,
                &[&shifted],
                &who("Plain"),
                &who("Committer"),
                format!(
                    "evil\u{1e}{fake}\u{1f}0123456\u{1f}2026-10-04T00:00:00+00:00\u{1f}Victim\u{1f}\
                     victim@x\u{1f}forged\u{1f}\u{1f}{fake}\nmore\n\n\
                     Instafy-Resolved-By: assistant\u{1e}{fake}\u{1f}x\n"
                )
                .as_bytes(),
            )
            .unwrap();
        git.update_ref("refs/heads/main", &injected, None, "test")
            .unwrap();

        let entries = list_recent_commits(&ws, 10, None).unwrap();
        let ids: Vec<&str> = entries.iter().map(|entry| entry.commit.as_str()).collect();
        assert_eq!(
            ids,
            vec![injected.as_str(), shifted.as_str(), root.as_str()]
        );
        for entry in &entries {
            let field = |format: &str| {
                crate::test_support::ig(
                    &ws,
                    &["log", "-1", &format!("--format={format}"), &entry.commit],
                )
                .trim()
                .to_string()
            };
            assert_eq!(entry.short_commit, field("%h"));
            assert_eq!(entry.committed_at, field("%cI"));
            assert_eq!(entry.author_name, field("%an"));
            assert_eq!(entry.author_email, field("%ae"));
            assert_eq!(entry.subject, field("%s"));
            let resolved = field("%(trailers:key=Instafy-Resolved-By,valueonly)");
            assert_eq!(
                entry.resolved_by.as_deref(),
                resolved
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
            );
            assert_eq!(entry.first_parent, None);
        }
        assert_eq!(entries[1].author_name, format!("Mal\u{1f}lory\u{1e}{fake}"));

        // An ordinary commit serializes exactly as before.
        let json = serde_json::to_value(&entries).unwrap();
        assert!(!json.to_string().contains("firstParent"), "{json}");
        assert_eq!(
            json[2],
            serde_json::json!({
                "commit": root,
                "shortCommit": entries[2].short_commit,
                "committedAt": entries[2].committed_at,
                "authorName": "Root",
                "authorEmail": "someone@instafy.dev",
                "subject": "root",
            })
        );
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

    use std::io::Read as _;
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    /// Low-speed window the stall tests run under instead of the production
    /// window, so a stalled command fails in about a second.
    const TEST_LOW_SPEED_TIME_SECONDS: u32 = 1;

    /// How long one git command against a stalled remote may take under the
    /// test window before the test fails. Generous for slow CI.
    const STALL_BOUND: Duration = Duration::from_secs(30);

    /// How long the fake remote holds a connection before closing it on its
    /// own. It is longer than `STALL_BOUND`, so reaching it cannot make a test
    /// pass; it only releases a git process that a regression left waiting.
    const REMOTE_HARD_CAP: Duration = Duration::from_secs(3 * STALL_BOUND.as_secs());

    #[derive(Clone, Copy, Debug)]
    enum StallMode {
        /// Accept the connection and never send a byte.
        Silent,
        /// Send the headers of a git advertisement, then nothing.
        HeadersThenSilent,
    }

    const STALL_MODES: [StallMode; 2] = [StallMode::Silent, StallMode::HeadersThenSilent];

    /// A git HTTP remote that accepts connections and then stops making
    /// progress, like a load balancer whose backend hung.
    struct StalledRemote {
        url: String,
        address: SocketAddr,
        requests: mpsc::Receiver<String>,
        stop: Arc<AtomicBool>,
    }

    impl StalledRemote {
        fn start(mode: StallMode) -> anyhow::Result<Self> {
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let address = listener.local_addr()?;
            let (sender, requests) = mpsc::channel();
            let stop = Arc::new(AtomicBool::new(false));
            let stop_accepting = stop.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop_accepting.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { break };
                    let sender = sender.clone();
                    std::thread::spawn(move || hold_stalled_connection(stream, mode, sender));
                }
            });
            Ok(Self {
                url: format!("http://{address}/stalled.git"),
                address,
                requests,
                stop,
            })
        }

        /// The request line of the next connection, proving the command
        /// reached this listener rather than failing early or using a proxy.
        fn next_request(&self) -> anyhow::Result<String> {
            Ok(self.requests.recv_timeout(Duration::from_secs(5))?)
        }
    }

    impl Drop for StalledRemote {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wake the accept loop so its thread exits.
            let _ = TcpStream::connect(self.address);
        }
    }

    fn hold_stalled_connection(
        mut stream: TcpStream,
        mode: StallMode,
        requests: mpsc::Sender<String>,
    ) {
        let give_up_at = Instant::now() + REMOTE_HARD_CAP;
        // Reads wake up periodically so the hard cap is checked even while
        // the client sends nothing.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let mut request = Vec::new();
        let mut answered = false;
        let mut buffer = [0_u8; 4096];
        while Instant::now() < give_up_at {
            match stream.read(&mut buffer) {
                // The client closed the connection.
                Ok(0) => return,
                Ok(read) if !answered => {
                    request.extend_from_slice(&buffer[..read]);
                    if !request.windows(4).any(|window| window == b"\r\n\r\n") {
                        continue;
                    }
                    answered = true;
                    let request_line = String::from_utf8_lossy(&request)
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let service = if request_line.contains("git-receive-pack") {
                        "git-receive-pack"
                    } else {
                        "git-upload-pack"
                    };
                    let _ = requests.send(request_line);
                    if let StallMode::HeadersThenSilent = mode {
                        let _ = stream.write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\n\
                                 Content-Type: application/x-{service}-advertisement\r\n\
                                 Cache-Control: no-cache\r\n\
                                 Transfer-Encoding: chunked\r\n\r\n"
                            )
                            .as_bytes(),
                        );
                    }
                    // Never send anything more.
                }
                Ok(_) => {}
                // A read interrupted by a signal (frequent on a loaded or
                // emulated host) is not the client going away.
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return,
            }
        }
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }

    /// Runs `operation` on its own thread under the test low-speed window and
    /// fails the test if it has not returned within `STALL_BOUND`, so a change
    /// that leaves git waiting on the remote fails the test instead of hanging
    /// the suite.
    fn within_stall_bound<T: Send + 'static>(
        label: &str,
        operation: impl FnOnce() -> T + Send + 'static,
    ) -> T {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            HTTP_LOW_SPEED_TIME_OVERRIDE
                .with(|window| window.set(Some(TEST_LOW_SPEED_TIME_SECONDS)));
            let _ = sender.send(operation());
        });
        match receiver.recv_timeout(STALL_BOUND) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                panic!("{label} against a stalled remote did not return within {STALL_BOUND:?}")
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("{label} panicked"),
        }
    }

    /// A workspace checked out from a seeded local remote, as the origin
    /// server leaves it after its first sync.
    fn checked_out_workspace(root: &Path) -> anyhow::Result<(PathBuf, ServerConfig)> {
        let remote_dir = root.join("remote.git");
        seed_remote_with_readme(root, &remote_dir)?;
        let workspace_dir = root.join("workspace");
        fs::create_dir_all(&workspace_dir)?;
        let config = revert_test_config(&workspace_dir, &remote_dir)?;
        ensure_git_checkout(&config, None)?;
        Ok((workspace_dir, config))
    }

    #[test]
    fn server_git_commands_pin_the_http_low_speed_bound() -> anyhow::Result<()> {
        let command = server_git_command();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-c", "http.lowSpeedLimit=1000"]),
            "{args:?}"
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-c", "http.lowSpeedTime=300"]),
            "{args:?}"
        );
        // Git reads these variables after every config source, so they are
        // pinned rather than inherited from the server's environment.
        let envs: HashMap<String, Option<String>> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            envs.get("GIT_HTTP_LOW_SPEED_LIMIT"),
            Some(&Some("1000".to_string()))
        );
        assert_eq!(
            envs.get("GIT_HTTP_LOW_SPEED_TIME"),
            Some(&Some("300".to_string()))
        );

        let outside_any_repo = tempdir()?;
        for (key, expected) in [("http.lowSpeedLimit", "1000"), ("http.lowSpeedTime", "300")] {
            let output = server_git_command()
                .current_dir(outside_any_repo.path())
                .args(["config", "--get", key])
                .output()?;
            assert!(output.status.success(), "git config --get {key} failed");
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected);
        }
        Ok(())
    }

    #[test]
    fn workspace_fetch_fails_when_the_remote_stops_responding() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let (_workspace_dir, config) = checked_out_workspace(sandbox.path())?;

        // The workspace refresh path: re-point the remote, then fetch.
        for mode in STALL_MODES {
            let remote = StalledRemote::start(mode)?;
            let mut config = config.clone();
            config.git_remote_url = Some(remote.url.clone());
            let error = within_stall_bound(&format!("{mode:?} fetch"), move || {
                ensure_git_checkout(&config, None).map_err(|error| error.to_string())
            })
            .expect_err("a fetch from a stalled remote must fail");
            assert!(error.contains("Operation too slow"), "{mode:?}: {error}");
            assert_eq!(
                remote.next_request()?,
                "GET /stalled.git/info/refs?service=git-upload-pack HTTP/1.1"
            );
        }
        Ok(())
    }

    #[test]
    fn push_and_ls_remote_fail_when_the_remote_stops_responding() -> anyhow::Result<()> {
        let sandbox = tempdir()?;
        let (workspace_dir, _config) = checked_out_workspace(sandbox.path())?;

        // Pushing agent commits and probing the remote go through `run_git`.
        for mode in STALL_MODES {
            let remote = StalledRemote::start(mode)?;
            run_git_ok(
                &workspace_dir,
                &["remote", "set-url", "origin", remote.url.as_str()],
                None,
            )?;
            for (args, service) in [
                (
                    vec!["push", "origin", "HEAD:refs/heads/main"],
                    "git-receive-pack",
                ),
                (vec!["ls-remote", "--heads", "origin"], "git-upload-pack"),
            ] {
                let label = format!("{mode:?} {args:?}");
                let workspace_dir = workspace_dir.clone();
                let output = within_stall_bound(&label, move || {
                    super::run_git(&workspace_dir, &args, None)
                })?;
                let stderr = String::from_utf8_lossy(&output.stderr);
                assert!(!output.status.success(), "{label} succeeded");
                assert!(stderr.contains("Operation too slow"), "{label}: {stderr}");
                assert_eq!(
                    remote.next_request()?,
                    format!("GET /stalled.git/info/refs?service={service} HTTP/1.1")
                );
            }
        }
        Ok(())
    }
}
