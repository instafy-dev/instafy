//! Local-engine turns: one @octo turn that the person's own Claude Code, signed in on their own
//! computer, carries out (docs/Local-Engine-Turns.md). This module holds what the lane needs
//! before a turn starts:
//!
//! - the launch grant Desktop hands this process (`INSTAFY_CLAUDE_CODE_*`), read and removed at
//!   startup before any thread exists, with a snapshot of the launch environment (3.2, 3.4);
//! - the checks on the granted binary, configuration directory, CA file and PATH entries (3.2),
//!   which run at capture and again before every spawn;
//! - the probe of `claude --version`, `--help` and `auth status`, and the `claudeCode`
//!   registration capability it gives (2.10, 3.2);
//! - the cleanup latch that stops leasing when a turn's processes cannot be confirmed gone (3.6).
//!
//! [`command`] builds the exact argv and environment of the `claude` process (3.3, 3.4),
//! [`supervise`] runs it and stops it (3.6), and [`events`] reads what it prints (3.7). [`job`]
//! holds the checks of a leased job that need only the job and the grant (3.9), [`preflight`]
//! the checks of the space's folder before `claude` starts (3.9), and [`saves`] the filter of
//! what a lane turn saves (3.8). The turn itself is `jobs::claude_code_turn` (3.1).
//!
//! The runtime never looks `claude` up by name and never copies, wraps, patches or writes it
//! (D25: its authenticity is not checked). The capability exists only on macOS (D18), never on a
//! Personal Browser runtime, and never holds a path, which would name the OS user.

pub mod command;
pub mod events;
pub mod job;
pub mod preflight;
pub mod saves;
pub mod supervise;

#[cfg(unix)]
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::ExitStatus;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;
use tracing::{debug, info, warn};
use uuid::Uuid;

/// The registration capability this module reports (2.10).
pub const CAPABILITY_KEY: &str = "claudeCode";

/// The absolute path of the `claude` the person confirmed in Desktop (4.1). It may be a link.
pub const BIN_ENV: &str = "INSTAFY_CLAUDE_CODE_BIN";
/// Desktop's login-shell PATH entries, as a PATH-style list (3.4, PATH source 2).
pub const PATH_ENV: &str = "INSTAFY_CLAUDE_CODE_PATH";
/// The Instafy user who consented; every lane job must be theirs (3.9).
pub const USER_ID_ENV: &str = "INSTAFY_CLAUDE_CODE_USER_ID";
/// The login-shell values D26 grants, as a JSON object of strings.
pub const ENV_JSON_ENV: &str = "INSTAFY_CLAUDE_CODE_ENV_JSON";
/// Every launch value of the grant (4.3). All of them leave the environment at startup.
pub const LAUNCH_GRANT_ENV_KEYS: [&str; 4] = [BIN_ENV, PATH_ENV, USER_ID_ENV, ENV_JSON_ENV];

/// The names `INSTAFY_CLAUDE_CODE_ENV_JSON` can grant (D26). Any other name in it is ignored.
pub const GRANTED_ENV_KEYS: [&str; 5] = [
    CONFIG_DIR_KEY,
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    CA_FILE_KEY,
];
const CONFIG_DIR_KEY: &str = "CLAUDE_CONFIG_DIR";
const CA_FILE_KEY: &str = "NODE_EXTRA_CA_CERTS";

/// What the child gets from the launch environment snapshot (3.4): the persistent helper
/// baseline (`model_environment::PERSISTENT_HELPER_BASE_ENV_KEYS`) minus `PATH`, `TERM`,
/// `COLORTERM`, `TMP` and `TEMP`. The launch `PATH` is kept apart, as a PATH source.
pub const SNAPSHOT_ENV_KEYS: [&str; 12] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// The oldest Claude Code the lane runs (3.2). It is the evidence for the flags of 3.3:
/// `--permission-prompts` (2.1.259), the time limit on background commands in `-p` runs
/// (2.1.285), and the 2.1.314 fixes to `-p` startup failures and to `--setting-sources`.
pub const MIN_SUPPORTED_VERSION: CliVersion = CliVersion::new(2, 1, 314);
/// Before this version `auth status` also reported a Console sign-in's stored API key as
/// `claude.ai`, so an earlier report never counts as a Claude plan sign-in (3.2).
pub const PLAN_SIGN_IN_REPORTED_FROM: CliVersion = CliVersion::new(2, 1, 286);

/// How long one probe command may run before it is killed (3.2).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// How much output one probe command may print, stdout and stderr together (3.2).
pub const PROBE_OUTPUT_CAP: usize = 256 * 1024;
/// How often a runtime whose capability says not ready probes again (3.2).
pub const NOT_READY_REPROBE_INTERVAL: Duration = Duration::from_secs(60);

/// The flags of the lane's command (3.3). A flag `--help` does not list is logged and never
/// fails the probe: `--help` does not list every flag, and an unknown flag fails at startup.
pub const LANE_FLAGS: [&str; 10] = [
    "--print",
    "--output-format",
    "--verbose",
    "--permission-mode",
    "--permission-prompts",
    "--setting-sources",
    "--strict-mcp-config",
    "--mcp-config",
    "--include-partial-messages",
    "--resume",
];

/// Why the lane is not ready (3.2). The controller keeps only these values (2.10):
/// `runtime_contracts::claude_code_lane::NOT_READY_REASONS`, which a test holds [`Self::ALL`] to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NotReadyReason {
    /// No runnable file at the granted path, or no granted path.
    BinaryMissing,
    /// The grant or a granted path fails a check of 3.2.
    BinaryUnsafe,
    /// `--version` or `--help` failed, timed out, printed too much, or printed no version.
    ProbeFailed,
    /// The version is older than [`MIN_SUPPORTED_VERSION`].
    UnsupportedVersion,
    /// `--help` says bare mode is the default in print mode.
    BareDefault,
}

impl NotReadyReason {
    /// Every reason, in the order of the shared list.
    pub const ALL: [Self; 5] = [
        Self::BinaryMissing,
        Self::BinaryUnsafe,
        Self::ProbeFailed,
        Self::UnsupportedVersion,
        Self::BareDefault,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BinaryMissing => "binary_missing",
            Self::BinaryUnsafe => "binary_unsafe",
            Self::ProbeFailed => "probe_failed",
            Self::UnsupportedVersion => "unsupported_version",
            Self::BareDefault => "bare_default",
        }
    }
}

impl fmt::Display for NotReadyReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Why a lane turn failed: the code of its `claude-code/failure` artifact, which the controller
/// checks and copies onto the failure message as `claudeCodeFailure` (2.6). These are the rows
/// of 5.5's table above `claude_code_turn_not_allowed`, the controller's list
/// (`runtime_contracts::claude_code_lane::RUNTIME_FAILURE_CODES`), which a test holds
/// [`Self::ALL`] to. A failure that is none of them (5.5's "anything else") has no code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FailureCode {
    /// Claude Code is not signed in (an `assistant` message's `error` is `authentication_failed`).
    NotSignedIn,
    /// The person's Claude plan reached its usage limit (a rejected `rate_limit_event`).
    PlanLimit,
    BinaryMissing,
    BinaryUnsafe,
    UnsupportedVersion,
    ProbeFailed,
    BareDefault,
    /// `--resume` named a session Claude Code no longer has (2.7).
    SessionUnavailable,
    /// The turn ran past `INSTAFY_CLAUDE_CODE_TURN_TIMEOUT_SECONDS` (3.6).
    TurnTimeout,
    /// Claude Code printed nothing for 15 minutes (3.6).
    Stalled,
    /// Claude Code stopped without a result, or printed what the lane cannot read (3.6).
    Crashed,
    /// The `init` event shows a flag that did not take effect (3.6).
    UnexpectedConfiguration,
    ProjectConfig,
    UnsafeImport,
    UnsafeLink,
    PreflightFailed,
}

impl FailureCode {
    pub const ALL: [Self; 16] = [
        Self::NotSignedIn,
        Self::PlanLimit,
        Self::BinaryMissing,
        Self::BinaryUnsafe,
        Self::UnsupportedVersion,
        Self::ProbeFailed,
        Self::BareDefault,
        Self::SessionUnavailable,
        Self::TurnTimeout,
        Self::Stalled,
        Self::Crashed,
        Self::UnexpectedConfiguration,
        Self::ProjectConfig,
        Self::UnsafeImport,
        Self::UnsafeLink,
        Self::PreflightFailed,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotSignedIn => "not_signed_in",
            Self::PlanLimit => "plan_limit",
            Self::BinaryMissing => "binary_missing",
            Self::BinaryUnsafe => "binary_unsafe",
            Self::UnsupportedVersion => "unsupported_version",
            Self::ProbeFailed => "probe_failed",
            Self::BareDefault => "bare_default",
            Self::SessionUnavailable => "session_unavailable",
            Self::TurnTimeout => "turn_timeout",
            Self::Stalled => "stalled",
            Self::Crashed => "crashed",
            Self::UnexpectedConfiguration => "unexpected_configuration",
            Self::ProjectConfig => "project_config",
            Self::UnsafeImport => "unsafe_import",
            Self::UnsafeLink => "unsafe_link",
            Self::PreflightFailed => "preflight_failed",
        }
    }

    pub fn parse(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|known| known.as_str() == code)
    }
}

impl From<NotReadyReason> for FailureCode {
    fn from(reason: NotReadyReason) -> Self {
        match reason {
            NotReadyReason::BinaryMissing => Self::BinaryMissing,
            NotReadyReason::BinaryUnsafe => Self::BinaryUnsafe,
            NotReadyReason::ProbeFailed => Self::ProbeFailed,
            NotReadyReason::UnsupportedVersion => Self::UnsupportedVersion,
            NotReadyReason::BareDefault => Self::BareDefault,
        }
    }
}

impl fmt::Display for FailureCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A Claude Code version, read as `^\d+\.\d+\.\d+` (3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CliVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl CliVersion {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// The version `text` starts with, after leading white space; `None` without one.
    pub fn parse(text: &str) -> Option<Self> {
        let mut rest = text.trim_start();
        let mut parts = [0u64; 3];
        for (index, part) in parts.iter_mut().enumerate() {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            *part = rest[..digits].parse().ok()?;
            rest = &rest[digits..];
            if index < 2 {
                rest = rest.strip_prefix('.')?;
            }
        }
        Some(Self::new(parts[0], parts[1], parts[2]))
    }
}

impl fmt::Display for CliVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// `runtime_contracts::CLAUDE_CODE_LANE_VERIFIED_THROUGH`, the newest version the live suite
/// verified (8).
pub fn verified_through() -> Option<CliVersion> {
    CliVersion::parse(runtime_contracts::CLAUDE_CODE_LANE_VERIFIED_THROUGH)
}

/// Whether `cli` is at most [`verified_through`], the capability's `verified` (2.10).
pub fn is_verified(cli: CliVersion) -> bool {
    verified_through().is_some_and(|through| cli <= through)
}

/// What the lane reads from `claude --help` (3.2): only the bare-mode wording and whether
/// `--no-bare` exists. The flags of 3.3 that it does not list are kept for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelpFacts {
    bare_is_default: bool,
    lists_no_bare: bool,
    missing_flags: Vec<&'static str>,
}

/// Options print at this indentation or less; description lines that wrap print deeper.
const OPTION_LINE_MAX_INDENT: usize = 4;

impl HelpFacts {
    pub fn read(help: &str) -> Self {
        Self {
            bare_is_default: option_description(help, "--bare")
                .is_some_and(|description| says_bare_is_the_default(&description)),
            lists_no_bare: help_lists_option(help, "--no-bare"),
            missing_flags: LANE_FLAGS
                .into_iter()
                .filter(|flag| !help_lists_option(help, flag))
                .collect(),
        }
    }

    /// The `--bare` help line says bare mode *is* the default in print mode: the lane is not
    /// ready (`bare_default`). Wording that it will become the default does not count.
    pub fn bare_is_default(&self) -> bool {
        self.bare_is_default
    }

    /// `--help` lists `--no-bare`, so the lane passes it (3.3).
    pub fn lists_no_bare(&self) -> bool {
        self.lists_no_bare
    }

    /// Flags of the lane's command that `--help` does not list. Logged, never a failure.
    pub fn missing_flags(&self) -> &[&'static str] {
        &self.missing_flags
    }
}

fn indentation(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn is_option_line(line: &str) -> bool {
    line.trim_start().starts_with('-') && indentation(line) <= OPTION_LINE_MAX_INDENT
}

/// The leading `-x, --flag <value>` tokens of an option line.
fn option_spec_tokens(line: &str) -> impl Iterator<Item = &str> {
    line.split_whitespace()
        .take_while(|token| token.starts_with(['-', '<', '[']))
        .map(|token| token.trim_end_matches(','))
}

fn help_lists_option(help: &str, flag: &str) -> bool {
    help.lines()
        .filter(|line| is_option_line(line))
        .any(|line| {
            option_spec_tokens(line).any(|token| {
                token == flag
                    || token
                        .strip_prefix(flag)
                        .is_some_and(|rest| rest.starts_with('='))
            })
        })
}

/// The description of `flag` in `help`, its wrapped lines joined.
fn option_description(help: &str, flag: &str) -> Option<String> {
    let lines: Vec<&str> = help.lines().collect();
    let index = lines.iter().position(|line| {
        is_option_line(line) && option_spec_tokens(line).any(|token| token == flag)
    })?;
    let indent = indentation(lines[index]);
    let mut description = description_after_spec(lines[index]).to_string();
    for line in &lines[index + 1..] {
        let text = line.trim();
        if text.is_empty() || is_option_line(line) || indentation(line) <= indent {
            break;
        }
        description.push(' ');
        description.push_str(text);
    }
    Some(description)
}

fn description_after_spec(line: &str) -> &str {
    let mut rest = line.trim_start();
    while rest.starts_with(['-', '<', '[']) {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        rest = rest[end..].trim_start();
    }
    rest.trim_end()
}

/// Whether a `--bare` description says bare mode is the default. A clause that puts it in the
/// future ("will become the default", "in a future release"), negates it, or annotates a false
/// default does not count.
fn says_bare_is_the_default(description: &str) -> bool {
    const FUTURE: [&str; 8] = [
        "will become",
        "will be the default",
        "will default",
        "future",
        "upcoming",
        "next release",
        "later release",
        "planned",
    ];
    const NEGATED: [&str; 4] = [
        "not the default",
        "no longer the default",
        "isn't the default",
        "not default",
    ];
    let text = description.to_ascii_lowercase();
    text.split(['.', ';', '(', ')', '[', ']'])
        .filter(|clause| clause.contains("default"))
        .any(|clause| {
            !FUTURE.iter().any(|marker| clause.contains(marker))
                && !NEGATED.iter().any(|marker| clause.contains(marker))
                && !annotates_a_false_default(clause)
        })
}

fn annotates_a_false_default(clause: &str) -> bool {
    clause.split("default:").skip(1).any(|value| {
        matches!(
            value
                .trim_start()
                .split(|ch: char| !ch.is_ascii_alphanumeric())
                .next(),
            Some("false" | "off" | "no" | "0")
        )
    })
}

/// Whether `claude auth status` reports a Claude plan sign-in, the capability's `planSignIn`
/// (3.2): it exited 0 and its JSON `authMethod` is `claude.ai` or `oauth_token`, on a version
/// that no longer reports a Console API key as `claude.ai`. Nothing else of the output is kept.
pub fn plan_sign_in(signed_in: bool, auth_status_stdout: &[u8], cli: CliVersion) -> bool {
    signed_in
        && cli >= PLAN_SIGN_IN_REPORTED_FROM
        && serde_json::from_slice::<Value>(auth_status_stdout)
            .ok()
            .as_ref()
            .and_then(|status| status.get("authMethod"))
            .and_then(Value::as_str)
            .is_some_and(|method| matches!(method, "claude.ai" | "oauth_token"))
}

/// The effective user and the `admin` group the checks of 3.2 trust.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Trust {
    pub euid: u32,
    /// The macOS `admin` group, whose members are root-equivalent through sudo. Homebrew makes
    /// `/opt/homebrew/bin` writable by it. `None` elsewhere, where nothing gets the allowance.
    pub admin_gid: Option<u32>,
}

/// The owner, group and mode bits of a file or directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ownership {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
}

impl Ownership {
    #[cfg(unix)]
    fn of(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode(),
        }
    }
}

impl Trust {
    pub fn current() -> Self {
        #[cfg(unix)]
        {
            Self {
                // SAFETY: geteuid has no preconditions.
                euid: unsafe { libc::geteuid() },
                admin_gid: admin_group_id(),
            }
        }
        #[cfg(not(unix))]
        {
            // No check passes off Unix; the lane exists only on macOS (D18).
            Self {
                euid: u32::MAX,
                admin_gid: None,
            }
        }
    }

    /// Owned by the effective user or by root.
    pub fn owner_is_trusted(&self, uid: u32) -> bool {
        uid == self.euid || uid == 0
    }

    /// Only its owner (the effective user or root) can write it, or its only other writer is
    /// the `admin` group (3.2).
    pub fn writers_are_trusted(&self, ownership: Ownership) -> bool {
        self.owner_is_trusted(ownership.uid)
            && ownership.mode & 0o002 == 0
            && (ownership.mode & 0o020 == 0 || Some(ownership.gid) == self.admin_gid)
    }

    /// Owned by the effective user or root, and neither group- nor world-writable: the rule for
    /// a granted `CLAUDE_CONFIG_DIR` and `NODE_EXTRA_CA_CERTS` (3.2, D26).
    pub fn is_private(&self, ownership: Ownership) -> bool {
        self.owner_is_trusted(ownership.uid) && ownership.mode & 0o022 == 0
    }
}

#[cfg(target_os = "macos")]
fn admin_group_id() -> Option<u32> {
    let mut buffer = vec![0 as libc::c_char; 1024];
    loop {
        let mut group = std::mem::MaybeUninit::<libc::group>::uninit();
        let mut result: *mut libc::group = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the duration of the call, and `buffer` is as long
        // as the length passed with it.
        let status = unsafe {
            libc::getgrnam_r(
                c"admin".as_ptr(),
                group.as_mut_ptr(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE && buffer.len() < 1 << 20 {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if status != 0 || result.is_null() {
            return None;
        }
        // SAFETY: a zero status with a result means `group` was filled in.
        return Some(unsafe { group.assume_init() }.gr_gid);
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn admin_group_id() -> Option<u32> {
    None
}

/// The folders no granted path, link or PATH entry may be in: `WORKSPACE_DIR` and the project
/// folder override (`Config::project_workspace_dir`). Paths compare ignoring ASCII case, as
/// macOS folders do, both as given and resolved.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Confinement {
    roots: Vec<PathBuf>,
}

impl Confinement {
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        Self {
            roots: roots
                .into_iter()
                .filter(|root| !root.as_os_str().is_empty())
                .map(|root| std::path::absolute(&root).unwrap_or(root))
                .collect(),
        }
    }

    /// The folders `Config::from_env` reads: `WORKSPACE_DIR` (default `/workspace`) and
    /// `WORKSPACE_PROJECT_DIR`.
    pub fn from_launch_env() -> Self {
        let workspace = std::env::var("WORKSPACE_DIR").unwrap_or_else(|_| "/workspace".into());
        let project = std::env::var("WORKSPACE_PROJECT_DIR")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self::new(std::iter::once(PathBuf::from(workspace)).chain(project.map(PathBuf::from)))
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Whether `path`, as given or resolved, is one of the folders or inside one.
    pub fn contains(&self, path: &Path) -> bool {
        let resolved = std::fs::canonicalize(path).ok();
        let candidates = [Some(path), resolved.as_deref()];
        self.roots.iter().any(|root| {
            let resolved_root = std::fs::canonicalize(root).ok();
            let roots = [Some(root.as_path()), resolved_root.as_deref()];
            candidates.iter().flatten().any(|candidate| {
                roots
                    .iter()
                    .flatten()
                    .any(|root| is_within(candidate, root))
            })
        })
    }
}

fn is_within(path: &Path, root: &Path) -> bool {
    let mut components = path.components();
    root.components().all(|expected| {
        components
            .next()
            .is_some_and(|component| same_component(component, expected))
    })
}

fn same_component(left: Component<'_>, right: Component<'_>) -> bool {
    match (left, right) {
        (Component::Normal(left), Component::Normal(right)) => left.eq_ignore_ascii_case(right),
        (left, right) => left == right,
    }
}

/// A path resolved one component at a time, with every symbolic link met on the way, as the
/// kernel resolves it. Each link is recorded where it physically is.
#[cfg(unix)]
struct Walk {
    target: PathBuf,
    links: Vec<PathBuf>,
}

#[cfg(unix)]
const MAX_SYMLINKS: usize = 40;

#[cfg(unix)]
enum Step {
    Parent,
    Name(OsString),
}

#[cfg(unix)]
fn steps(path: &Path) -> impl Iterator<Item = Step> + '_ {
    path.components().filter_map(|component| match component {
        Component::Normal(name) => Some(Step::Name(name.to_owned())),
        Component::ParentDir => Some(Step::Parent),
        Component::CurDir | Component::RootDir | Component::Prefix(_) => None,
    })
}

#[cfg(unix)]
fn walk_symlinks(path: &Path) -> io::Result<Walk> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the path is not absolute",
        ));
    }
    let mut pending: VecDeque<Step> = steps(path).collect();
    let mut current = PathBuf::from("/");
    let mut links = Vec::new();
    while let Some(step) = pending.pop_front() {
        let name = match step {
            Step::Parent => {
                current.pop();
                continue;
            }
            Step::Name(name) => name,
        };
        let next = current.join(&name);
        let metadata = std::fs::symlink_metadata(&next)?;
        if !metadata.file_type().is_symlink() {
            current = next;
            continue;
        }
        if links.len() >= MAX_SYMLINKS {
            return Err(io::Error::other("too many symbolic links"));
        }
        let destination = std::fs::read_link(&next)?;
        links.push(next);
        if destination.is_absolute() {
            current = PathBuf::from("/");
        }
        let mut expanded: VecDeque<Step> = steps(&destination).collect();
        expanded.extend(pending.drain(..));
        pending = expanded;
    }
    Ok(Walk {
        target: current,
        links,
    })
}

/// A lookup that failed: nothing there is `binary_missing`, anything else `binary_unsafe`.
#[cfg(unix)]
fn binary_lookup_failure(error: io::Error) -> NotReadyReason {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => NotReadyReason::BinaryMissing,
        _ => NotReadyReason::BinaryUnsafe,
    }
}

/// The launch environment, as it was before anything could change it (3.4): the
/// [`SNAPSHOT_ENV_KEYS`] values and the launch `PATH`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchEnvSnapshot {
    values: Vec<(&'static str, OsString)>,
    path: Option<OsString>,
}

impl LaunchEnvSnapshot {
    pub fn from_process() -> Self {
        Self::from_lookup(|key| std::env::var_os(key))
    }

    /// Keeps only the [`SNAPSHOT_ENV_KEYS`] and `PATH` that `lookup` has.
    pub fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Self {
        Self {
            values: SNAPSHOT_ENV_KEYS
                .into_iter()
                .filter_map(|key| lookup(key).map(|value| (key, value)))
                .collect(),
            path: lookup("PATH"),
        }
    }

    pub fn values(&self) -> &[(&'static str, OsString)] {
        &self.values
    }

    pub fn path(&self) -> Option<&OsStr> {
        self.path.as_deref()
    }

    /// The launch `HOME`, which a turn's steps show as `~` (3.6).
    pub fn home(&self) -> Option<&Path> {
        self.values
            .iter()
            .find(|(key, _)| *key == "HOME")
            .map(|(_, value)| Path::new(value))
    }

    fn tmpdir(&self) -> Option<&Path> {
        self.values
            .iter()
            .find(|(key, _)| *key == "TMPDIR")
            .map(|(_, value)| Path::new(value))
    }
}

/// The four launch values of the grant, as Desktop set them (4.3).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RawLaunchGrant {
    pub bin: Option<OsString>,
    pub path: Option<OsString>,
    pub user_id: Option<OsString>,
    pub env_json: Option<OsString>,
}

impl RawLaunchGrant {
    pub fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Self {
        Self {
            bin: lookup(BIN_ENV),
            path: lookup(PATH_ENV),
            user_id: lookup(USER_ID_ENV),
            env_json: lookup(ENV_JSON_ENV),
        }
    }

    /// Desktop granted nothing: the capability is absent.
    pub fn is_absent(&self) -> bool {
        self.bin.is_none()
            && self.path.is_none()
            && self.user_id.is_none()
            && self.env_json.is_none()
    }
}

/// A grant whose values are well formed (3.2): an absolute binary path, a UUID user id, and
/// granted values that are strings, with absolute `CLAUDE_CONFIG_DIR` and CA file paths. What
/// they point at is checked by [`LaunchGrant::check`], at capture and before every spawn.
#[derive(Clone, Debug)]
pub struct LaunchGrant {
    binary: PathBuf,
    path_entries: Vec<PathBuf>,
    user_id: Uuid,
    env: Vec<(&'static str, OsString)>,
    snapshot: LaunchEnvSnapshot,
    confinement: Confinement,
    trust: Trust,
}

impl LaunchGrant {
    /// `Ok(None)` when Desktop granted nothing; a malformed grant is not ready, with the reason.
    pub fn parse(
        raw: RawLaunchGrant,
        snapshot: LaunchEnvSnapshot,
        confinement: Confinement,
        trust: Trust,
    ) -> Result<Option<Self>, NotReadyReason> {
        if raw.is_absent() {
            return Ok(None);
        }
        let binary = raw
            .bin
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or(NotReadyReason::BinaryMissing)?;
        if !binary.is_absolute() || binary.file_name().is_none() {
            return Err(NotReadyReason::BinaryUnsafe);
        }
        let user_id = raw
            .user_id
            .as_deref()
            .and_then(OsStr::to_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok())
            .ok_or(NotReadyReason::BinaryUnsafe)?;
        let env = match raw.env_json {
            Some(json) => parse_granted_env(&json)?,
            None => Vec::new(),
        };
        let path_entries = raw
            .path
            .map(|value| {
                std::env::split_paths(&value)
                    .filter(|entry| !entry.as_os_str().is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some(Self {
            binary,
            path_entries,
            user_id,
            env,
            snapshot,
            confinement,
            trust,
        }))
    }

    /// The granted path, as Desktop stored it (a link, so Claude Code's updates keep working).
    pub fn binary(&self) -> &Path {
        &self.binary
    }

    /// The consenting Instafy user. Every lane job must be theirs (3.9).
    pub fn user_id(&self) -> Uuid {
        self.user_id
    }

    /// Desktop's login-shell PATH entries, unchecked.
    pub fn path_entries(&self) -> &[PathBuf] {
        &self.path_entries
    }

    /// The granted D26 values, unchecked, in [`GRANTED_ENV_KEYS`] order.
    pub fn granted_env(&self) -> &[(&'static str, OsString)] {
        &self.env
    }

    pub fn snapshot(&self) -> &LaunchEnvSnapshot {
        &self.snapshot
    }

    pub fn confinement(&self) -> &Confinement {
        &self.confinement
    }

    pub fn trust(&self) -> Trust {
        self.trust
    }

    /// The checks of 3.2 on what the grant points at now. They run at capture and before every
    /// spawn, since Claude Code's updates move the link's target (4.1); the runtime then spawns
    /// the checked target, not the link.
    pub fn check(&self) -> Result<CheckedLaunch, NotReadyReason> {
        let (program, identity) = self.check_binary()?;
        for (name, value) in &self.env {
            match *name {
                CONFIG_DIR_KEY => self.check_private_location(Path::new(value), true)?,
                CA_FILE_KEY => self.check_private_location(Path::new(value), false)?,
                _ => {}
            }
        }
        let granted_dir = self
            .binary
            .parent()
            .ok_or(NotReadyReason::BinaryUnsafe)?
            .to_path_buf();
        Ok(CheckedLaunch {
            program,
            granted_dir,
            identity,
            granted_env: self.env.clone(),
        })
    }

    /// The granted path: neither it, a link on the way, nor its target is in the confinement;
    /// every link and the target's folder are owned and writable only as [`Trust`] allows, and
    /// so is the target, which is a regular file with an execute bit.
    #[cfg(unix)]
    fn check_binary(&self) -> Result<(PathBuf, BinaryIdentity), NotReadyReason> {
        use std::os::unix::fs::MetadataExt;
        let unsafe_binary = NotReadyReason::BinaryUnsafe;
        if self.confinement.contains(&self.binary) {
            return Err(unsafe_binary);
        }
        let walk = walk_symlinks(&self.binary).map_err(binary_lookup_failure)?;
        // A link's own folder is where it can be replaced; the first such folder, or the
        // target's, is the granted path's own folder.
        for link in &walk.links {
            if self.confinement.contains(link) {
                return Err(unsafe_binary);
            }
            let metadata = std::fs::symlink_metadata(link).map_err(binary_lookup_failure)?;
            if !self.trust.owner_is_trusted(metadata.uid()) {
                return Err(unsafe_binary);
            }
            self.check_folder(link.parent().ok_or(unsafe_binary)?)?;
        }
        let target = walk.target;
        if self.confinement.contains(&target) {
            return Err(unsafe_binary);
        }
        let metadata = std::fs::symlink_metadata(&target).map_err(binary_lookup_failure)?;
        if !metadata.file_type().is_file() || metadata.mode() & 0o111 == 0 {
            return Err(NotReadyReason::BinaryMissing);
        }
        if !self.trust.writers_are_trusted(Ownership::of(&metadata)) {
            return Err(unsafe_binary);
        }
        self.check_folder(target.parent().ok_or(unsafe_binary)?)?;
        let identity = BinaryIdentity {
            canonical: target.clone(),
            size: metadata.len(),
            modified: metadata.modified().ok(),
        };
        Ok((target, identity))
    }

    #[cfg(not(unix))]
    fn check_binary(&self) -> Result<(PathBuf, BinaryIdentity), NotReadyReason> {
        Err(NotReadyReason::BinaryUnsafe)
    }

    #[cfg(unix)]
    fn check_folder(&self, folder: &Path) -> Result<(), NotReadyReason> {
        let metadata = std::fs::metadata(folder).map_err(|_| NotReadyReason::BinaryUnsafe)?;
        if metadata.is_dir() && self.trust.writers_are_trusted(Ownership::of(&metadata)) {
            Ok(())
        } else {
            Err(NotReadyReason::BinaryUnsafe)
        }
    }

    /// A granted `CLAUDE_CONFIG_DIR` (a directory) or CA file: absolute, outside the
    /// confinement with every link on the way, owned by the effective user or root, and neither
    /// group- nor world-writable (D26). A failure is `binary_unsafe`: the value is never just
    /// left out, since without it Claude Code would load its default configuration.
    #[cfg(unix)]
    fn check_private_location(&self, path: &Path, directory: bool) -> Result<(), NotReadyReason> {
        use std::os::unix::fs::MetadataExt;
        let refuse = NotReadyReason::BinaryUnsafe;
        if !path.is_absolute() || self.confinement.contains(path) {
            return Err(refuse);
        }
        let walk = walk_symlinks(path).map_err(|_| refuse)?;
        for link in &walk.links {
            let metadata = std::fs::symlink_metadata(link).map_err(|_| refuse)?;
            if self.confinement.contains(link) || !self.trust.owner_is_trusted(metadata.uid()) {
                return Err(refuse);
            }
        }
        if self.confinement.contains(&walk.target) {
            return Err(refuse);
        }
        let metadata = std::fs::symlink_metadata(&walk.target).map_err(|_| refuse)?;
        let kind = if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if kind && self.trust.is_private(Ownership::of(&metadata)) {
            Ok(())
        } else {
            Err(refuse)
        }
    }

    #[cfg(not(unix))]
    fn check_private_location(&self, _path: &Path, _directory: bool) -> Result<(), NotReadyReason> {
        Err(NotReadyReason::BinaryUnsafe)
    }

    /// Whether `entry` may be on the child's PATH (3.2, 3.4): absolute, an existing directory
    /// outside the confinement, and, with every link on the way, owned and writable only as
    /// [`Trust`] allows. A failing entry is dropped, not a failure.
    #[cfg(unix)]
    pub fn path_entry_is_safe(&self, entry: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        if !entry.is_absolute()
            || std::env::join_paths([entry]).is_err()
            || self.confinement.contains(entry)
        {
            return false;
        }
        let Ok(walk) = walk_symlinks(entry) else {
            return false;
        };
        let links_are_safe = walk.links.iter().all(|link| {
            !self.confinement.contains(link)
                && std::fs::symlink_metadata(link)
                    .is_ok_and(|metadata| self.trust.owner_is_trusted(metadata.uid()))
                && link
                    .parent()
                    .is_some_and(|folder| self.check_folder(folder).is_ok())
        });
        links_are_safe
            && !self.confinement.contains(&walk.target)
            && self.check_folder(&walk.target).is_ok()
    }

    #[cfg(not(unix))]
    pub fn path_entry_is_safe(&self, _entry: &Path) -> bool {
        false
    }
}

fn parse_granted_env(json: &OsStr) -> Result<Vec<(&'static str, OsString)>, NotReadyReason> {
    let malformed = NotReadyReason::BinaryUnsafe;
    let object: serde_json::Map<String, Value> = json
        .to_str()
        .and_then(|text| serde_json::from_str(text).ok())
        .ok_or(malformed)?;
    let mut env = Vec::new();
    for name in GRANTED_ENV_KEYS {
        let value = match object.get(name) {
            None | Some(Value::Null) => continue,
            Some(Value::String(value)) => value,
            Some(_) => return Err(malformed),
        };
        if value.is_empty() {
            continue;
        }
        if value.contains('\0')
            || (matches!(name, CONFIG_DIR_KEY | CA_FILE_KEY) && !Path::new(value).is_absolute())
        {
            return Err(malformed);
        }
        env.push((name, OsString::from(value)));
    }
    Ok(env)
}

/// Which file a probe ran: the `--help` reading stays valid while this and the version hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryIdentity {
    canonical: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
}

impl BinaryIdentity {
    pub fn canonical(&self) -> &Path {
        &self.canonical
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn modified(&self) -> Option<SystemTime> {
        self.modified
    }
}

/// What [`LaunchGrant::check`] passed: the target to spawn, the granted path's folder (the
/// first PATH entry), and the granted values to pass.
#[derive(Clone, Debug)]
pub struct CheckedLaunch {
    program: PathBuf,
    granted_dir: PathBuf,
    identity: BinaryIdentity,
    granted_env: Vec<(&'static str, OsString)>,
}

impl CheckedLaunch {
    /// The checked target the runtime spawns.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// The granted path's own folder, the first PATH source (3.4).
    pub fn granted_dir(&self) -> &Path {
        &self.granted_dir
    }

    pub fn identity(&self) -> &BinaryIdentity {
        &self.identity
    }

    /// The granted D26 values that passed their checks.
    pub fn granted_env(&self) -> &[(&'static str, OsString)] {
        &self.granted_env
    }
}

/// What a probe found (3.2).
#[derive(Clone, Debug)]
pub enum Readiness {
    Ready(ReadyLane),
    NotReady(NotReadyReason),
}

impl Readiness {
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready(_))
    }

    pub fn reason(&self) -> Option<NotReadyReason> {
        match self {
            Self::Ready(_) => None,
            Self::NotReady(reason) => Some(*reason),
        }
    }

    pub fn ready(&self) -> Option<&ReadyLane> {
        match self {
            Self::Ready(ready) => Some(ready),
            Self::NotReady(_) => None,
        }
    }

    /// The `claudeCode` registration capability (2.10, 3.2).
    pub fn capability(&self) -> Value {
        match self {
            Self::Ready(ready) => ready.capability(),
            Self::NotReady(reason) => not_ready_capability(*reason),
        }
    }
}

/// `{"version": 1, "ready": false, "reason": …}` (3.2).
pub fn not_ready_capability(reason: NotReadyReason) -> Value {
    json!({ "version": 1, "ready": false, "reason": reason.as_str() })
}

/// A supported `claude` and what a turn needs from its probe.
#[derive(Clone, Debug)]
pub struct ReadyLane {
    cli: CliVersion,
    verified: bool,
    plan_sign_in: bool,
    help: HelpFacts,
    launch: CheckedLaunch,
}

impl ReadyLane {
    pub fn cli(&self) -> CliVersion {
        self.cli
    }

    pub fn verified(&self) -> bool {
        self.verified
    }

    pub fn plan_sign_in(&self) -> bool {
        self.plan_sign_in
    }

    pub fn help(&self) -> &HelpFacts {
        &self.help
    }

    pub fn launch(&self) -> &CheckedLaunch {
        &self.launch
    }

    /// `{"version": 1, "ready": true, "cli", "verified", "planSignIn", "partialMessages"}`. The
    /// lane always streams partial messages (`--include-partial-messages`, 3.3).
    pub fn capability(&self) -> Value {
        json!({
            "version": 1,
            "ready": true,
            "cli": self.cli.to_string(),
            "verified": self.verified,
            "planSignIn": self.plan_sign_in,
            "partialMessages": true,
        })
    }
}

/// A probe and whether it changed the published capability. A change while registered means
/// the runtime must register again with the new value (3.2).
#[derive(Clone, Debug)]
pub struct LaneProbe {
    pub readiness: Readiness,
    pub capability_changed: bool,
}

struct CachedHelp {
    version: CliVersion,
    identity: BinaryIdentity,
    facts: HelpFacts,
}

/// The lane of a captured grant: its probe, the `--help` reading it keeps, and the published
/// `claudeCode` capability.
///
/// The capability is fixed for each registration. Registration reads [`Lane::capability`];
/// a per-turn probe that changes it, and [`Lane::reprobe_while_not_ready`], publish the new
/// value to [`Lane::subscribe`] for the registration loop to register again.
pub struct Lane {
    grant: LaunchGrant,
    probe_timeout: Duration,
    help: tokio::sync::Mutex<Option<CachedHelp>>,
    capability: watch::Sender<Option<Value>>,
}

impl Lane {
    pub fn new(grant: LaunchGrant) -> Self {
        Self {
            grant,
            probe_timeout: PROBE_TIMEOUT,
            help: tokio::sync::Mutex::new(None),
            capability: watch::channel(None).0,
        }
    }

    /// A shorter limit for each probe command, for tests of the limit itself.
    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = timeout;
        self
    }

    pub fn grant(&self) -> &LaunchGrant {
        &self.grant
    }

    /// Probes the granted `claude` (3.2): checks the grant again, then runs `--version`,
    /// `--help` only when the version or the binary changed since it last ran, and
    /// `auth status`, each with the lane environment, stdin from null, a fresh empty runtime
    /// folder as working directory, [`PROBE_TIMEOUT`] and [`PROBE_OUTPUT_CAP`]. It never sends a
    /// prompt. Probes run one at a time.
    pub async fn probe(&self) -> Readiness {
        self.probe_by(None).await
    }

    /// [`Self::probe`], with every command ending by `deadline` when there is one. A command the
    /// deadline cuts short fails the probe as `probe_failed`, `auth status` too.
    async fn probe_by(&self, deadline: Option<Instant>) -> Readiness {
        let mut cached_help = self.help.lock().await;
        match self.probe_with(&mut cached_help, deadline).await {
            Ok(ready) => Readiness::Ready(ready),
            Err(reason) => Readiness::NotReady(reason),
        }
    }

    async fn probe_with(
        &self,
        cached_help: &mut Option<CachedHelp>,
        deadline: Option<Instant>,
    ) -> Result<ReadyLane, NotReadyReason> {
        let launch = self.grant.check()?;
        let environment = command::lane_environment(&self.grant, &launch);
        let version = self
            .run(&launch, &environment, &["--version"], deadline)
            .await
            .ok()
            .filter(|run| run.status.success())
            .and_then(|run| CliVersion::parse(&String::from_utf8_lossy(&run.stdout)))
            .ok_or(NotReadyReason::ProbeFailed)?;
        if version < MIN_SUPPORTED_VERSION {
            return Err(NotReadyReason::UnsupportedVersion);
        }
        let cached = cached_help
            .as_ref()
            .filter(|cached| cached.version == version && cached.identity == launch.identity)
            .map(|cached| cached.facts.clone());
        let help = match cached {
            Some(facts) => facts,
            None => {
                let run = self
                    .run(&launch, &environment, &["--help"], deadline)
                    .await
                    .ok()
                    .filter(|run| run.status.success())
                    .ok_or(NotReadyReason::ProbeFailed)?;
                let facts = HelpFacts::read(&String::from_utf8_lossy(&run.stdout));
                if !facts.missing_flags().is_empty() {
                    warn!(
                        cli = %version,
                        flags = ?facts.missing_flags(),
                        "claude --help does not list every flag the lane passes; the version floor vouches for them"
                    );
                }
                *cached_help = Some(CachedHelp {
                    version,
                    identity: launch.identity.clone(),
                    facts: facts.clone(),
                });
                facts
            }
        };
        if help.bare_is_default() {
            return Err(NotReadyReason::BareDefault);
        }
        let plan_sign_in = match self
            .run(&launch, &environment, &["auth", "status"], deadline)
            .await
        {
            Ok(run) => plan_sign_in(run.status.success(), &run.stdout, version),
            Err(ProbeRunError::TimedOut)
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) =>
            {
                return Err(NotReadyReason::ProbeFailed);
            }
            Err(_) => false,
        };
        Ok(ReadyLane {
            cli: version,
            verified: is_verified(version),
            plan_sign_in,
            help,
            launch,
        })
    }

    async fn run(
        &self,
        launch: &CheckedLaunch,
        environment: &[(OsString, OsString)],
        args: &[&str],
        deadline: Option<Instant>,
    ) -> Result<BoundedRun, ProbeRunError> {
        let limit = match deadline {
            Some(deadline) => self
                .probe_timeout
                .min(deadline.saturating_duration_since(Instant::now())),
            None => self.probe_timeout,
        };
        if limit.is_zero() {
            return Err(ProbeRunError::TimedOut);
        }
        let folder = runtime_owned_dir(&self.grant, "instafy-claude-code-probe-")
            .map_err(ProbeRunError::Io)?;
        let command = command::probe_command(launch, environment, args, folder.path());
        let run = run_bounded(command, limit).await;
        if let Err(error) = &run {
            debug!(%error, command = args.join(" "), "a claude probe command failed");
        }
        run
    }

    /// Probes, then publishes the capability it gives.
    pub async fn probe_and_publish(&self) -> LaneProbe {
        self.probe_and_publish_by(None).await
    }

    /// The startup probe (3.2): [`Self::probe_and_publish`], with one limit for its commands
    /// together, the limit of one ([`PROBE_TIMEOUT`]). The runtime registers, and so takes any
    /// turn, Codex's too, only once it ended, so a `claude` that stalls delays that by this limit
    /// and the last command's kill at most. A probe that runs out of it is `probe_failed`, which
    /// the timed re-probe ([`Self::reprobe_while_not_ready`]) corrects by registering again.
    pub async fn probe_and_publish_at_startup(&self) -> LaneProbe {
        self.probe_and_publish_by(Some(Instant::now() + self.probe_timeout))
            .await
    }

    async fn probe_and_publish_by(&self, deadline: Option<Instant>) -> LaneProbe {
        let readiness = self.probe_by(deadline).await;
        let capability_changed = self.publish(readiness.capability());
        if capability_changed {
            match &readiness {
                Readiness::Ready(ready) => info!(
                    cli = %ready.cli,
                    verified = ready.verified,
                    plan_sign_in = ready.plan_sign_in,
                    "Claude Code lane is ready"
                ),
                Readiness::NotReady(reason) => {
                    info!(reason = reason.as_str(), "Claude Code lane is not ready")
                }
            }
        }
        LaneProbe {
            readiness,
            capability_changed,
        }
    }

    fn publish(&self, capability: Value) -> bool {
        self.capability.send_if_modified(|current| {
            if current.as_ref() == Some(&capability) {
                return false;
            }
            *current = Some(capability);
            true
        })
    }

    /// The published capability, `None` before the first probe.
    pub fn capability(&self) -> Option<Value> {
        self.capability.borrow().clone()
    }

    /// Each capability this lane publishes.
    pub fn subscribe(&self) -> watch::Receiver<Option<Value>> {
        self.capability.subscribe()
    }

    fn capability_says_ready(&self) -> bool {
        self.capability
            .borrow()
            .as_ref()
            .and_then(|capability| capability.get("ready"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// While the published capability says not ready, probes again every `interval` and
    /// publishes a changed result: no lane turn, and so no per-turn probe, runs to notice that
    /// the person fixed Claude Code (3.2). Runs until dropped.
    pub async fn reprobe_while_not_ready(&self, interval: Duration) {
        loop {
            tokio::time::sleep(interval).await;
            if !self.capability_says_ready() {
                self.probe_and_publish().await;
            }
        }
    }

    /// The capability for this runtime's registration: the published one, or the startup probe's.
    /// Runs from synchronous startup code, so the probe gets a thread and runtime of its own.
    fn startup_capability(&self) -> Value {
        if let Some(capability) = self.capability() {
            return capability;
        }
        let probed = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .ok()?;
                    Some(runtime.block_on(self.probe_and_publish_at_startup()))
                })
                .join()
                .ok()
                .flatten()
        });
        match probed {
            Some(probe) => probe.readiness.capability(),
            None => {
                let capability = not_ready_capability(NotReadyReason::ProbeFailed);
                self.publish(capability.clone());
                capability
            }
        }
    }
}

/// A fresh, empty folder of the runtime's own (mode 0700), outside every space folder: a probe's
/// working directory, or the home of a turn's MCP configuration (3.2, 3.3). It goes in the
/// launch `TMPDIR`, not whatever the process environment says by then.
fn runtime_owned_dir(grant: &LaunchGrant, prefix: &str) -> io::Result<tempfile::TempDir> {
    let base = grant
        .snapshot
        .tmpdir()
        .filter(|folder| folder.is_absolute() && folder.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let folder = builder.tempdir_in(base)?;
    if grant.confinement.contains(folder.path()) {
        return Err(io::Error::other(
            "the runtime's temporary folder is inside the workspace",
        ));
    }
    Ok(folder)
}

struct BoundedRun {
    status: ExitStatus,
    stdout: Vec<u8>,
}

#[derive(Debug)]
enum ProbeRunError {
    Spawn(io::Error),
    Io(io::Error),
    TimedOut,
    OutputTooLarge,
}

impl fmt::Display for ProbeRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "could not start: {error}"),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::TimedOut => formatter.write_str("timed out"),
            Self::OutputTooLarge => formatter.write_str("printed too much"),
        }
    }
}

/// Runs a probe command to its end within `timeout` and [`PROBE_OUTPUT_CAP`], killing it on
/// either limit. Only stdout is kept; stderr counts toward the cap.
async fn run_bounded(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Result<BoundedRun, ProbeRunError> {
    let mut child = command.spawn().map_err(ProbeRunError::Spawn)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let budget = AtomicUsize::new(PROBE_OUTPUT_CAP);
    let outcome = tokio::time::timeout(timeout, async {
        let (stdout, _) = tokio::try_join!(
            read_within(stdout, &budget, PROBE_OUTPUT_CAP),
            read_within(stderr, &budget, 0),
        )?;
        let status = child.wait().await.map_err(ProbeRunError::Io)?;
        Ok::<_, ProbeRunError>(BoundedRun { status, stdout })
    })
    .await
    .unwrap_or(Err(ProbeRunError::TimedOut));
    if outcome.is_err() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }
    outcome
}

async fn read_within(
    reader: Option<impl AsyncRead + Unpin>,
    budget: &AtomicUsize,
    keep: usize,
) -> Result<Vec<u8>, ProbeRunError> {
    let Some(mut reader) = reader else {
        return Ok(Vec::new());
    };
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8 * 1024];
    loop {
        let read = reader.read(&mut chunk).await.map_err(ProbeRunError::Io)?;
        if read == 0 {
            return Ok(kept);
        }
        budget
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
                left.checked_sub(read)
            })
            .map_err(|_| ProbeRunError::OutputTooLarge)?;
        let room = keep.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..read.min(room)]);
    }
}

/// What startup captured.
pub enum CapturedGrant {
    /// Desktop granted nothing: no capability.
    Absent,
    /// A malformed grant: not ready, with the reason, until a new grant restarts the runtime.
    Unusable(NotReadyReason),
    /// A well-formed grant and its lane.
    Granted(Lane),
}

impl CapturedGrant {
    /// Parses the grant and checks it once, so a grant that fails its checks gives a not-ready
    /// capability from the start. Nothing here stops startup.
    pub fn from_raw(
        raw: RawLaunchGrant,
        snapshot: LaunchEnvSnapshot,
        confinement: Confinement,
        trust: Trust,
    ) -> Self {
        match LaunchGrant::parse(raw, snapshot, confinement, trust) {
            Ok(None) => Self::Absent,
            Err(reason) => Self::Unusable(reason),
            Ok(Some(grant)) => {
                let checked = grant.check();
                let lane = Lane::new(grant);
                if let Err(reason) = checked {
                    lane.publish(not_ready_capability(reason));
                }
                Self::Granted(lane)
            }
        }
    }
}

static CAPTURED: OnceLock<CapturedGrant> = OnceLock::new();
/// `INSTAFY_CLAUDE_CODE_TURN_TIMEOUT_SECONDS` as the runtime was launched with it, before any
/// job's granted secrets could change the process environment.
static TURN_TIMEOUT_SETTING: OnceLock<Option<String>> = OnceLock::new();

/// The turn timeout setting ([`supervise::TURN_TIMEOUT_ENV`]): as captured at startup, or, where
/// nothing ran the capture, as the process environment has it now.
pub(crate) fn turn_timeout_setting() -> Option<String> {
    match TURN_TIMEOUT_SETTING.get() {
        Some(captured) => captured.clone(),
        None => std::env::var(supervise::TURN_TIMEOUT_ENV).ok(),
    }
}

/// Reads and removes the launch grant (`INSTAFY_CLAUDE_CODE_*`), snapshots the launch
/// environment the child gets (3.4), checks the grant (3.2) and keeps all of it for the life of
/// the process. A bad value leaves the lane not ready (`binary_missing` or `binary_unsafe`); it
/// never stops startup. The variables leave the environment whatever the platform, so nothing
/// the runtime starts inherits them.
///
/// It runs before any thread, the skill-pack export, `arg0_dispatch` (which may load
/// `$CODEX_HOME/.env`), the launch-credential scrub, the skill-pack shims joining PATH, and any
/// job's granted secrets (3.2). A second call keeps the first capture.
///
/// # Safety
///
/// Mutates the process environment. The caller must ensure no other thread reads or writes the
/// environment while it runs.
pub unsafe fn capture_and_scrub_launch_grant() {
    let raw = RawLaunchGrant::from_lookup(|key| std::env::var_os(key));
    for key in LAUNCH_GRANT_ENV_KEYS {
        // SAFETY: the caller guarantees no concurrent environment access.
        unsafe { std::env::remove_var(key) };
    }
    let _ = TURN_TIMEOUT_SETTING.set(std::env::var(supervise::TURN_TIMEOUT_ENV).ok());
    if CAPTURED.get().is_some() {
        return;
    }
    let captured = CapturedGrant::from_raw(
        raw,
        LaunchEnvSnapshot::from_process(),
        Confinement::from_launch_env(),
        Trust::current(),
    );
    let _ = CAPTURED.set(captured);
}

/// What startup captured, on any platform; `None` when nothing ran the capture.
pub fn captured_launch_grant() -> Option<&'static CapturedGrant> {
    CAPTURED.get()
}

/// The lane runs only on macOS in v1 (D18), and never on a Personal Browser runtime.
fn lane_is_offered(on_macos: bool, on_personal_browser_runtime: bool) -> bool {
    on_macos && !on_personal_browser_runtime
}

fn lane_is_offered_here() -> bool {
    lane_is_offered(
        cfg!(target_os = "macos"),
        crate::personal_browser::process_capability_is_present(),
    )
}

/// The lane of this process's grant, where the lane is offered.
pub fn lane() -> Option<&'static Lane> {
    if !lane_is_offered_here() {
        return None;
    }
    match CAPTURED.get()? {
        CapturedGrant::Granted(lane) => Some(lane),
        CapturedGrant::Absent | CapturedGrant::Unusable(_) => None,
    }
}

/// The lane a leased local-engine job runs on (3.1, 3.9): this process's captured grant, where the
/// lane is offered; otherwise why there is none. A malformed grant gives its own reason; no grant,
/// another platform or a Personal Browser runtime gives `binary_missing`.
pub fn lane_for_jobs() -> Result<&'static Lane, NotReadyReason> {
    if let Some(lane) = lane() {
        return Ok(lane);
    }
    match CAPTURED.get() {
        Some(CapturedGrant::Unusable(reason)) if lane_is_offered_here() => Err(*reason),
        _ => Err(NotReadyReason::BinaryMissing),
    }
}

/// `capabilities` with `lane`'s published `claudeCode` in place of whatever it held, for a
/// registration: a per-turn probe that disagrees with the capability, or a timed probe while it
/// says not ready, changes it after startup, and the controller attests what each registration
/// carries (2.10, 3.2). Unchanged before the lane's first probe.
pub fn with_published_capability(capabilities: &Value, lane: &Lane) -> Value {
    let mut capabilities = capabilities.clone();
    if let (Some(map), Some(capability)) = (capabilities.as_object_mut(), lane.capability()) {
        map.remove("claude_code");
        map.insert(CAPABILITY_KEY.to_string(), capability);
    }
    capabilities
}

/// The `claudeCode` registration capability (2.10, 3.2): absent without a grant, off macOS and
/// on a Personal Browser runtime; otherwise the published value, or the startup probe's.
pub fn registration_capability() -> Option<Value> {
    if !lane_is_offered_here() {
        return None;
    }
    match CAPTURED.get()? {
        CapturedGrant::Absent => None,
        CapturedGrant::Unusable(reason) => Some(not_ready_capability(*reason)),
        CapturedGrant::Granted(lane) => Some(lane.startup_capability()),
    }
}

/// Set when a lane turn's processes cannot be confirmed gone; the turn's process tree gets it
/// (`process_tree::ProcessTree::new`).
static CLEANUP_UNCONFIRMED: AtomicBool = AtomicBool::new(false);

/// False once a lane turn's cleanup could not be confirmed: the lease loop stops (3.2, 3.6).
pub fn runtime_reuse_is_safe() -> bool {
    !CLEANUP_UNCONFIRMED.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake-claude-fixtures")
            .join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
    }

    #[test]
    fn the_snapshot_is_the_persistent_helper_baseline_without_path_term_and_tmp() {
        let expected: Vec<&str> = crate::model_environment::PERSISTENT_HELPER_BASE_ENV_KEYS
            .iter()
            .copied()
            .filter(|key| !matches!(*key, "PATH" | "TERM" | "COLORTERM" | "TMP" | "TEMP"))
            .collect();
        assert_eq!(SNAPSHOT_ENV_KEYS.to_vec(), expected);
        let snapshot = LaunchEnvSnapshot::from_lookup(|key| Some(OsString::from(key)));
        let names: Vec<&str> = snapshot.values().iter().map(|(name, _)| *name).collect();
        assert_eq!(names, SNAPSHOT_ENV_KEYS);
        assert_eq!(snapshot.path(), Some(OsStr::new("PATH")));
    }

    #[test]
    fn versions_are_read_from_the_start_of_the_output() {
        let floor = CliVersion::new(2, 1, 314);
        assert_eq!(CliVersion::parse("2.1.314 (Claude Code)\n"), Some(floor));
        assert_eq!(CliVersion::parse("\n  2.1.314"), Some(floor));
        assert_eq!(CliVersion::parse("2.1.314-beta.2"), Some(floor));
        assert_eq!(
            CliVersion::parse("2.1.3140"),
            Some(CliVersion::new(2, 1, 3140))
        );
        for text in [
            "Claude Code 2.1.314",
            "v2.1.314",
            "2.1",
            "2.1.",
            "2..314",
            "",
            "99999999999999999999.1.1",
        ] {
            assert_eq!(CliVersion::parse(text), None, "{text:?}");
        }
        assert_eq!(floor.to_string(), "2.1.314");
        assert_eq!(MIN_SUPPORTED_VERSION, floor);
        // Numbers compare as numbers.
        assert!(CliVersion::new(2, 1, 1000) > CliVersion::new(2, 1, 999));
        assert!(CliVersion::new(2, 2, 0) > CliVersion::new(2, 1, 999));
        assert!(CliVersion::new(2, 1, 313) < MIN_SUPPORTED_VERSION);
    }

    #[test]
    fn verified_means_at_most_the_contract_constant() {
        let through = verified_through().expect("CLAUDE_CODE_LANE_VERIFIED_THROUGH is a version");
        assert!(through >= MIN_SUPPORTED_VERSION);
        assert!(is_verified(through));
        assert!(is_verified(MIN_SUPPORTED_VERSION));
        assert!(!is_verified(CliVersion::new(
            through.major,
            through.minor,
            through.patch + 1
        )));
        assert!(!is_verified(CliVersion::new(through.major + 1, 0, 0)));
    }

    #[test]
    fn the_help_fixtures_give_their_facts() {
        let full = HelpFacts::read(&fixture("help/full.txt"));
        assert!(!full.bare_is_default());
        assert!(!full.lists_no_bare());
        assert!(full.missing_flags().is_empty(), "{full:?}");

        let missing = HelpFacts::read(&fixture("help/missing-flags.txt"));
        assert_eq!(
            missing.missing_flags(),
            ["--permission-prompts", "--include-partial-messages"]
        );
        assert!(!missing.bare_is_default());

        let bare = HelpFacts::read(&fixture("help/bare-default.txt"));
        assert!(bare.bare_is_default());
        assert!(!bare.lists_no_bare());

        let bare_with_no_bare = HelpFacts::read(&fixture("help/bare-default-with-no-bare.txt"));
        assert!(bare_with_no_bare.bare_is_default());
        assert!(bare_with_no_bare.lists_no_bare());

        let future = HelpFacts::read(&fixture("help/bare-will-become-default.txt"));
        assert!(!future.bare_is_default());
        assert!(future.lists_no_bare());
    }

    #[test]
    fn only_wording_that_bare_is_the_default_now_counts() {
        for (description, is_default) in [
            ("Minimal mode, the default in print mode", true),
            ("Minimal mode (default for -p)", true),
            ("Minimal mode. Default: true", true),
            ("Minimal mode; on by default with --print", true),
            ("Minimal mode: skip hooks and plugins", false),
            (
                "Minimal mode. It will become the default for -p in a future release",
                false,
            ),
            ("Minimal mode. Planned as the default for -p", false),
            ("Minimal mode (default: false)", false),
            ("Minimal mode, not the default", false),
            ("Minimal mode, no longer the default in print mode", false),
        ] {
            assert_eq!(
                says_bare_is_the_default(description),
                is_default,
                "{description}"
            );
        }
    }

    #[test]
    fn options_count_only_on_option_lines() {
        let help = "Options:\n  --bare            Minimal mode; use\n                    --no-bare to keep it off\n  -p, --print       Print and exit\n  --output-format <format>  Output format\n  --mcp-config=<file>  Servers\n";
        assert!(!help_lists_option(help, "--no-bare"));
        assert!(help_lists_option(help, "--print"));
        assert!(help_lists_option(help, "--output-format"));
        assert!(help_lists_option(help, "--mcp-config"));
        assert!(!help_lists_option(help, "--bar"));
        assert!(!help_lists_option(help, "--verbose"));
        assert_eq!(
            option_description(help, "--bare").as_deref(),
            Some("Minimal mode; use --no-bare to keep it off")
        );
        assert_eq!(option_description(help, "--verbose"), None);
    }

    #[test]
    fn a_plan_sign_in_needs_a_plan_method_a_zero_exit_and_a_version_that_tells_them_apart() {
        let floor = MIN_SUPPORTED_VERSION;
        let claude_ai = fixture("auth/claude-ai.json");
        assert!(plan_sign_in(true, claude_ai.as_bytes(), floor));
        assert!(plan_sign_in(
            true,
            fixture("auth/oauth-token.json").as_bytes(),
            floor
        ));
        assert!(!plan_sign_in(
            true,
            fixture("auth/api-key.json").as_bytes(),
            floor
        ));
        assert!(!plan_sign_in(
            false,
            fixture("auth/signed-out.json").as_bytes(),
            floor
        ));
        // A report of a plan sign-in that exits 1 is not one.
        assert!(!plan_sign_in(false, claude_ai.as_bytes(), floor));
        // Before 2.1.286 a Console sign-in's API key was also reported as claude.ai.
        assert!(!plan_sign_in(
            true,
            claude_ai.as_bytes(),
            CliVersion::new(2, 1, 285)
        ));
        assert!(plan_sign_in(
            true,
            claude_ai.as_bytes(),
            PLAN_SIGN_IN_REPORTED_FROM
        ));
        assert!(!plan_sign_in(true, b"Signed in with Claude Pro", floor));
        for method in [
            "none",
            "api_key",
            "api_key_helper",
            "third_party",
            "Claude.ai",
        ] {
            let status = json!({ "loggedIn": true, "authMethod": method }).to_string();
            assert!(!plan_sign_in(true, status.as_bytes(), floor), "{method}");
        }
    }

    #[test]
    fn the_admin_group_is_the_only_other_writer_a_folder_or_binary_may_have() {
        let trust = Trust {
            euid: 501,
            admin_gid: Some(80),
        };
        let mine = |gid, mode| Ownership {
            uid: 501,
            gid,
            mode,
        };
        assert!(trust.writers_are_trusted(mine(20, 0o755)));
        assert!(trust.writers_are_trusted(Ownership {
            uid: 0,
            gid: 0,
            mode: 0o755
        }));
        // Homebrew's /opt/homebrew/bin: the person's, group admin, 0775.
        assert!(trust.writers_are_trusted(mine(80, 0o775)));
        assert!(trust.writers_are_trusted(Ownership {
            uid: 0,
            gid: 80,
            mode: 0o775
        }));
        // Any other group, or anyone at all.
        assert!(!trust.writers_are_trusted(mine(20, 0o775)));
        assert!(!trust.writers_are_trusted(mine(80, 0o777)));
        assert!(!trust.writers_are_trusted(mine(20, 0o757)));
        assert!(!trust.writers_are_trusted(mine(80, 0o1777)));
        // A foreign owner, whatever the mode.
        assert!(!trust.writers_are_trusted(Ownership {
            uid: 502,
            gid: 20,
            mode: 0o755
        }));
        assert!(!trust.owner_is_trusted(502));
        assert!(trust.owner_is_trusted(0));
        // Without an admin group, nobody gets the allowance.
        let no_admin = Trust {
            euid: 501,
            admin_gid: None,
        };
        assert!(!no_admin.writers_are_trusted(mine(80, 0o775)));
        // A granted CLAUDE_CONFIG_DIR or CA file may have no other writer at all.
        assert!(trust.is_private(mine(20, 0o700)));
        assert!(trust.is_private(mine(20, 0o644)));
        assert!(!trust.is_private(mine(80, 0o770)));
        assert!(!trust.is_private(mine(20, 0o702)));
        assert!(!trust.is_private(Ownership {
            uid: 502,
            gid: 20,
            mode: 0o700
        }));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_trusts_its_admin_group() {
        assert_eq!(Trust::current().admin_gid, Some(80));
    }

    #[cfg(unix)]
    #[test]
    fn the_confinement_matches_ignoring_case_and_through_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let workspace = root.join("Workspace");
        std::fs::create_dir_all(workspace.join("space")).unwrap();
        std::fs::write(workspace.join("space/claude"), "").unwrap();
        let confinement = Confinement::new([workspace.clone()]);
        assert!(confinement.contains(&workspace));
        assert!(confinement.contains(&workspace.join("space/claude")));
        assert!(confinement.contains(&root.join("workspace/space/claude")));
        assert!(confinement.contains(&root.join("WORKSPACE/not-there-yet")));
        assert!(!confinement.contains(&root.join("Workspace-2/claude")));
        assert!(!confinement.contains(&root));
        let link = root.join("link");
        std::os::unix::fs::symlink(&workspace, &link).unwrap();
        assert!(confinement.contains(&link.join("space/claude")));
        // A relative root is made absolute against the working directory.
        let relative = Confinement::new([PathBuf::from("relative-workspace")]);
        assert!(relative.roots()[0].is_absolute());
        assert!(Confinement::new([PathBuf::new()]).roots().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_walk_resolves_as_the_kernel_does_and_records_each_link() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let versions = root.join("opt/claude/versions");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::write(versions.join("2.1.314"), "").unwrap();
        std::fs::create_dir_all(root.join("home/.local/bin")).unwrap();
        // A relative directory link that climbs, an absolute file link, and a directory link
        // on the way to the granted path.
        symlink("../claude/versions", root.join("opt/claude/current")).unwrap();
        symlink(
            root.join("opt/claude/current/2.1.314"),
            root.join("home/.local/bin/claude"),
        )
        .unwrap();
        symlink("home/.local", root.join("alias")).unwrap();
        let granted = root.join("alias/bin/claude");
        let walk = walk_symlinks(&granted).unwrap();
        assert_eq!(walk.target, std::fs::canonicalize(&granted).unwrap());
        assert_eq!(walk.target, versions.join("2.1.314"));
        assert_eq!(
            walk.links,
            [
                root.join("alias"),
                root.join("home/.local/bin/claude"),
                root.join("opt/claude/current"),
            ]
        );
        symlink("b", root.join("a")).unwrap();
        symlink("a", root.join("b")).unwrap();
        assert!(walk_symlinks(&root.join("a")).is_err());
        assert_eq!(
            walk_symlinks(&root.join("missing/claude"))
                .err()
                .map(|error| error.kind()),
            Some(io::ErrorKind::NotFound)
        );
        assert!(walk_symlinks(Path::new("relative/claude")).is_err());
    }

    fn snapshot() -> LaunchEnvSnapshot {
        LaunchEnvSnapshot::from_lookup(|key| match key {
            "HOME" => Some("/Users/person".into()),
            "PATH" => Some("/usr/bin:/bin".into()),
            _ => None,
        })
    }

    fn raw(bin: &str) -> RawLaunchGrant {
        RawLaunchGrant {
            bin: Some(bin.into()),
            path: None,
            user_id: Some(Uuid::new_v4().to_string().into()),
            env_json: None,
        }
    }

    fn parse(raw: RawLaunchGrant) -> Result<Option<LaunchGrant>, NotReadyReason> {
        LaunchGrant::parse(
            raw,
            snapshot(),
            Confinement::new([PathBuf::from("/workspace")]),
            Trust {
                euid: 501,
                admin_gid: None,
            },
        )
    }

    #[test]
    fn nothing_granted_is_no_grant_and_a_malformed_grant_is_not_ready() {
        assert!(matches!(parse(RawLaunchGrant::default()), Ok(None)));
        let without_binary = RawLaunchGrant {
            bin: None,
            ..raw("/usr/local/bin/claude")
        };
        assert_eq!(
            parse(without_binary).err(),
            Some(NotReadyReason::BinaryMissing)
        );
        assert_eq!(parse(raw("")).err(), Some(NotReadyReason::BinaryMissing));
        for relative in ["claude", "bin/claude", "./claude", "~/.local/bin/claude"] {
            assert_eq!(
                parse(raw(relative)).err(),
                Some(NotReadyReason::BinaryUnsafe),
                "{relative}"
            );
        }
        for user_id in [None, Some("person@example.com"), Some("")] {
            let grant = RawLaunchGrant {
                user_id: user_id.map(OsString::from),
                ..raw("/usr/local/bin/claude")
            };
            assert_eq!(
                parse(grant).err(),
                Some(NotReadyReason::BinaryUnsafe),
                "{user_id:?}"
            );
        }
        for env_json in [
            "not json",
            "[]",
            r#""CLAUDE_CONFIG_DIR""#,
            r#"{"CLAUDE_CONFIG_DIR": 7}"#,
            r#"{"HTTPS_PROXY": ["http://proxy.example:3128"]}"#,
            r#"{"CLAUDE_CONFIG_DIR": "relative/.claude"}"#,
            r#"{"NODE_EXTRA_CA_CERTS": "ca.pem"}"#,
            r#"{"NO_PROXY": "a\u0000b"}"#,
        ] {
            let grant = RawLaunchGrant {
                env_json: Some(env_json.into()),
                ..raw("/usr/local/bin/claude")
            };
            assert_eq!(
                parse(grant).err(),
                Some(NotReadyReason::BinaryUnsafe),
                "{env_json}"
            );
        }
    }

    #[test]
    fn a_grant_keeps_only_the_d26_names_and_its_path_entries_as_given() {
        let user_id = Uuid::new_v4();
        let grant = parse(RawLaunchGrant {
            bin: Some("/opt/homebrew/bin/claude".into()),
            path: Some("/opt/homebrew/bin::relative/bin:/usr/bin".into()),
            user_id: Some(format!(" {} ", user_id.to_string().to_uppercase()).into()),
            env_json: Some(
                r#"{
                    "NODE_EXTRA_CA_CERTS": "/etc/ssl/corporate.pem",
                    "CLAUDE_CONFIG_DIR": "/Users/person/.claude-work",
                    "HTTPS_PROXY": "http://proxy.example:3128",
                    "HTTP_PROXY": null,
                    "NO_PROXY": "",
                    "ANTHROPIC_API_KEY": "not-a-real-key",
                    "CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token",
                    "PATH": "/evil"
                }"#
                .into(),
            ),
        })
        .unwrap()
        .unwrap();
        assert_eq!(grant.user_id(), user_id);
        assert_eq!(grant.binary(), Path::new("/opt/homebrew/bin/claude"));
        assert_eq!(
            grant.path_entries(),
            [
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("relative/bin"),
                PathBuf::from("/usr/bin"),
            ]
        );
        assert_eq!(
            grant.granted_env(),
            [
                (
                    "CLAUDE_CONFIG_DIR",
                    OsString::from("/Users/person/.claude-work")
                ),
                ("HTTPS_PROXY", OsString::from("http://proxy.example:3128")),
                (
                    "NODE_EXTRA_CA_CERTS",
                    OsString::from("/etc/ssl/corporate.pem")
                ),
            ]
        );
    }

    #[test]
    fn the_capability_has_the_two_shapes_of_3_2_and_never_a_path() {
        for (reason, text) in [
            (NotReadyReason::BinaryMissing, "binary_missing"),
            (NotReadyReason::BinaryUnsafe, "binary_unsafe"),
            (NotReadyReason::ProbeFailed, "probe_failed"),
            (NotReadyReason::UnsupportedVersion, "unsupported_version"),
            (NotReadyReason::BareDefault, "bare_default"),
        ] {
            assert_eq!(
                Readiness::NotReady(reason).capability(),
                json!({ "version": 1, "ready": false, "reason": text })
            );
        }
        let ready = Readiness::Ready(ReadyLane {
            cli: CliVersion::new(2, 1, 400),
            verified: false,
            plan_sign_in: true,
            help: HelpFacts::read(""),
            launch: CheckedLaunch {
                program: PathBuf::from("/Users/person/.local/share/claude/versions/2.1.400"),
                granted_dir: PathBuf::from("/Users/person/.local/bin"),
                identity: BinaryIdentity {
                    canonical: PathBuf::from("/Users/person/.local/share/claude/versions/2.1.400"),
                    size: 1,
                    modified: None,
                },
                granted_env: vec![(CONFIG_DIR_KEY, OsString::from("/Users/person/.claude"))],
            },
        });
        let capability = ready.capability();
        assert_eq!(
            capability,
            json!({
                "version": 1,
                "ready": true,
                "cli": "2.1.400",
                "verified": false,
                "planSignIn": true,
                "partialMessages": true,
            })
        );
        assert!(!capability.to_string().contains('/'));
    }

    #[test]
    fn the_lane_is_offered_only_on_macos_and_never_on_a_personal_browser_runtime() {
        assert!(lane_is_offered(true, false));
        assert!(!lane_is_offered(false, false));
        assert!(!lane_is_offered(true, true));
        assert!(!lane_is_offered(false, true));
    }

    #[test]
    fn a_registration_carries_the_capability_the_lane_last_published() {
        let grant = parse(raw("/usr/local/bin/claude")).unwrap().unwrap();
        let lane = Lane::new(grant);
        let launched = json!({
            "agent": true,
            "claudeCode": { "version": 1, "ready": true, "cli": "2.1.314" },
            "claude_code": { "ready": true },
        });
        // Before any probe the launch value stands.
        assert_eq!(with_published_capability(&launched, &lane), launched);
        let not_ready = not_ready_capability(NotReadyReason::UnsupportedVersion);
        lane.publish(not_ready.clone());
        assert_eq!(
            with_published_capability(&launched, &lane),
            json!({ "agent": true, "claudeCode": not_ready })
        );
    }

    /// Nothing in this test process ran the capture: a leased lane job has no lane, and fails as
    /// `binary_missing` (the child-process tests of tests/claude_code_lane.rs cover a capture).
    #[test]
    fn without_a_capture_a_lane_job_has_no_lane() {
        assert!(captured_launch_grant().is_none());
        assert!(lane().is_none());
        assert!(matches!(
            lane_for_jobs(),
            Err(NotReadyReason::BinaryMissing)
        ));
        assert_eq!(registration_capability(), None);
    }

    #[test]
    fn a_lane_publishes_only_changes() {
        let grant = parse(raw("/usr/local/bin/claude")).unwrap().unwrap();
        let lane = Lane::new(grant);
        let mut updates = lane.subscribe();
        assert_eq!(lane.capability(), None);
        let missing = not_ready_capability(NotReadyReason::BinaryMissing);
        assert!(lane.publish(missing.clone()));
        assert!(updates.has_changed().unwrap());
        assert_eq!(*updates.borrow_and_update(), Some(missing.clone()));
        assert!(!lane.publish(missing.clone()));
        assert!(!updates.has_changed().unwrap());
        assert!(!lane.capability_says_ready());
        assert_eq!(lane.startup_capability(), missing);
    }

    /// The codes and reasons are runtime-contracts' lists, which the controller keeps and Studio
    /// words (claude_code_lane_fixtures.json).
    #[test]
    fn failure_codes_are_the_rows_of_5_5_above_turn_not_allowed() {
        use runtime_contracts::claude_code_lane::{
            NOT_READY_REASONS, RUNTIME_FAILURE_CODES, STOP_AND_SWEEP_FAILURE_CODES,
        };
        let codes: Vec<&str> = FailureCode::ALL.iter().map(|code| code.as_str()).collect();
        assert_eq!(codes, RUNTIME_FAILURE_CODES);
        let reasons: Vec<&str> = NotReadyReason::ALL
            .iter()
            .map(|reason| reason.as_str())
            .collect();
        assert_eq!(reasons, NOT_READY_REASONS);
        for code in FailureCode::ALL {
            assert_eq!(FailureCode::parse(code.as_str()), Some(code));
        }
        assert_eq!(FailureCode::parse("claude_code_turn_not_allowed"), None);
        // Only the controller writes a stop's or a sweep's code.
        for code in STOP_AND_SWEEP_FAILURE_CODES {
            assert_eq!(FailureCode::parse(code), None, "{code}");
        }
        // A probe's reason is the failure of a turn whose per-turn probe gave it.
        for reason in NotReadyReason::ALL {
            assert_eq!(FailureCode::from(reason).as_str(), reason.as_str());
        }
    }
}
