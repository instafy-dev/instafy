//! Local-engine turns: a turn of one of the person's agents whose AI is Claude Code, which the
//! person's own Claude Code, signed in on their own computer, carries out
//! (docs/Local-Engine-Turns.md, section 11 for version 2). This module holds what the lane needs
//! before a turn starts:
//!
//! - the launch grant Desktop hands this process (`INSTAFY_CLAUDE_CODE_*`), read and removed at
//!   startup before any thread exists, with a snapshot of the launch environment (3.2, 3.4): the
//!   program, and the person's Claude Code logins on this computer, each a configuration folder
//!   they signed in to themselves (11.19);
//! - the checks on the granted binary, each login's folder, the CA file and PATH entries (3.2),
//!   which run at capture and again before every spawn;
//! - the probe of `claude --version` and `--help` for the program and of `auth status` for each
//!   login, and the version 2 `claudeCode` registration capability it gives (2.10, 3.2, 11.19):
//!   the program once, and each login apart, which says not ready while its Claude plan's usage
//!   limit holds it, until it resets (11.11);
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

use runtime_contracts::claude_code_lane::{CAPABILITY_VERSION, MAX_LOGINS};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;
use tracing::{debug, info, warn};
use uuid::Uuid;

/// The registration capability this module reports (2.10), at
/// `runtime_contracts::claude_code_lane::CAPABILITY_VERSION` (11.19).
pub const CAPABILITY_KEY: &str = "claudeCode";

/// The absolute path of the `claude` the person confirmed in Desktop (4.1). It may be a link.
pub const BIN_ENV: &str = "INSTAFY_CLAUDE_CODE_BIN";
/// Desktop's login-shell PATH entries, as a PATH-style list (3.4, PATH source 2).
pub const PATH_ENV: &str = "INSTAFY_CLAUDE_CODE_PATH";
/// The Instafy user who consented; every lane job must be theirs (3.9).
pub const USER_ID_ENV: &str = "INSTAFY_CLAUDE_CODE_USER_ID";
/// The login-shell values D26 grants every login alike, as a JSON object of strings.
pub const ENV_JSON_ENV: &str = "INSTAFY_CLAUDE_CODE_ENV_JSON";
/// The person's Claude Code logins on this computer (11.19), as a JSON list of
/// `{"id": "<uuid>", "configDir": "/absolute/path" | null}`, `null` for Claude Code's usual folder.
pub const LOGINS_JSON_ENV: &str = "INSTAFY_CLAUDE_CODE_LOGINS_JSON";
/// Every launch value of the grant (4.3, 11.19). All of them leave the environment at startup.
pub const LAUNCH_GRANT_ENV_KEYS: [&str; 5] = [
    BIN_ENV,
    PATH_ENV,
    USER_ID_ENV,
    ENV_JSON_ENV,
    LOGINS_JSON_ENV,
];

/// The names `INSTAFY_CLAUDE_CODE_ENV_JSON` can grant (D26), shared by every login. Any other
/// name in it is ignored, `CLAUDE_CONFIG_DIR` too: each login brings its own (11.19).
pub const GRANTED_ENV_KEYS: [&str; 4] = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", CA_FILE_KEY];
/// The one `CLAUDE_*` name the child can get: its login's own folder, never another value (3.4).
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

/// The oldest Claude Code the lane runs (3.2): 2.1.325, the version Phase 0's checks ran on
/// (B.4). It is also the evidence for the flags of 3.3: `--permission-prompts` (2.1.259),
/// the time limit on background commands in `-p` runs (2.1.285), and the 2.1.314 fixes to
/// `-p` startup failures and to `--setting-sources`.
pub const MIN_SUPPORTED_VERSION: CliVersion = CliVersion::new(2, 1, 325);
/// Before this version `auth status` also reported a Console sign-in's stored API key as
/// `claude.ai`, so an earlier report never counts as a Claude plan sign-in (3.2).
pub const PLAN_SIGN_IN_REPORTED_FROM: CliVersion = CliVersion::new(2, 1, 286);

/// How long one probe command may run before it is killed (3.2).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// How much output one probe command may print, stdout and stderr together (3.2).
pub const PROBE_OUTPUT_CAP: usize = 256 * 1024;
/// How often a runtime whose capability says not ready probes again (3.2).
pub const NOT_READY_REPROBE_INTERVAL: Duration = Duration::from_secs(60);
/// How far ahead a plan limit holds the lane at most (11.11): a reset time Claude Code gives
/// further ahead counts as this.
pub const PLAN_LIMIT_HOLD_AT_MOST: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// How long a plan limit holds the lane when Claude Code gave no reset time (11.11).
pub const PLAN_LIMIT_HOLD_WITHOUT_A_RESET_TIME: Duration = Duration::from_secs(60 * 60);

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

/// Why the program, or one login, is not ready (3.2, 11.19). The controller keeps only these
/// values (2.10): `runtime_contracts::claude_code_lane::NOT_READY_REASONS`, which a test holds
/// [`Self::ALL`] to. The program's own reason is any but `plan_limit`
/// (`PROGRAM_NOT_READY_REASONS`); a login's is the program's while the program is not ready,
/// otherwise `binary_unsafe` for a folder that fails its checks, or `plan_limit` while its hold
/// lasts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NotReadyReason {
    /// No runnable file at the granted path, or no granted path.
    BinaryMissing,
    /// The grant, a granted path or a login's folder fails a check of 3.2.
    BinaryUnsafe,
    /// `--version` or `--help` failed, timed out, printed too much, or printed no version.
    ProbeFailed,
    /// The version is older than [`MIN_SUPPORTED_VERSION`].
    UnsupportedVersion,
    /// `--help` says bare mode is the default in print mode.
    BareDefault,
    /// A turn on a login failed at its Claude plan's usage limit, which has not reset yet: a
    /// [`PlanLimitHold`] of that login (11.11). No probe gives it.
    PlanLimit,
}

impl NotReadyReason {
    /// Every reason, in the order of the shared list.
    pub const ALL: [Self; 6] = [
        Self::BinaryMissing,
        Self::BinaryUnsafe,
        Self::ProbeFailed,
        Self::UnsupportedVersion,
        Self::BareDefault,
        Self::PlanLimit,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BinaryMissing => "binary_missing",
            Self::BinaryUnsafe => "binary_unsafe",
            Self::ProbeFailed => "probe_failed",
            Self::UnsupportedVersion => "unsupported_version",
            Self::BareDefault => "bare_default",
            Self::PlanLimit => "plan_limit",
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
    /// The person's Claude plan reached its usage limit (a rejected `rate_limit_event`), or a
    /// [`PlanLimitHold`] kept the turn from starting (11.11).
    PlanLimit,
    BinaryMissing,
    BinaryUnsafe,
    UnsupportedVersion,
    ProbeFailed,
    BareDefault,
    /// The turn ran past `INSTAFY_CLAUDE_CODE_TURN_TIMEOUT_SECONDS` (3.6).
    TurnTimeout,
    /// Claude Code printed nothing for 15 minutes (3.6).
    Stalled,
    /// Claude Code stopped without a result, or printed what the lane cannot read (3.6).
    Crashed,
    /// The `init` event shows a flag that did not take effect, or names the space's own Claude
    /// Code configuration (3.6).
    UnexpectedConfiguration,
    UnsafeImport,
    UnsafeLink,
    PreflightFailed,
}

impl FailureCode {
    pub const ALL: [Self; 14] = [
        Self::NotSignedIn,
        Self::PlanLimit,
        Self::BinaryMissing,
        Self::BinaryUnsafe,
        Self::UnsupportedVersion,
        Self::ProbeFailed,
        Self::BareDefault,
        Self::TurnTimeout,
        Self::Stalled,
        Self::Crashed,
        Self::UnexpectedConfiguration,
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
            Self::TurnTimeout => "turn_timeout",
            Self::Stalled => "stalled",
            Self::Crashed => "crashed",
            Self::UnexpectedConfiguration => "unexpected_configuration",
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
            NotReadyReason::PlanLimit => Self::PlanLimit,
        }
    }
}

impl fmt::Display for FailureCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// What a lane turn may do, from its job's `metadata.execution_mode` (11.12): `apply`, which an
/// absent mode is too, changes the space's files and saves them; `plan_only`, an automation's
/// read-only mode, runs Claude Code in its plan mode and saves nothing. No other mode runs on the
/// lane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ExecutionMode {
    Apply,
    PlanOnly,
}

impl ExecutionMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::PlanOnly => "plan_only",
        }
    }

    /// The mode `text` names, read as the job loop reads it: without the white space around it
    /// and in any ASCII letter case.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        [Self::Apply, Self::PlanOnly]
            .into_iter()
            .find(|mode| text.eq_ignore_ascii_case(mode.as_str()))
    }

    /// The `--permission-mode` a turn passes, which every `init` it prints must report (3.3,
    /// 3.6): `acceptEdits` to apply, Claude Code's own `plan` mode to plan only.
    pub const fn permission_mode(self) -> &'static str {
        match self {
            Self::Apply => "acceptEdits",
            Self::PlanOnly => "plan",
        }
    }

    /// Whether the turn saves what it changed in the folder (3.8): a `plan_only` turn saves
    /// nothing, and its reply is delivered all the same.
    pub const fn saves(self) -> bool {
        matches!(self, Self::Apply)
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

/// The five launch values of the grant, as Desktop set them (4.3, 11.19).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RawLaunchGrant {
    pub bin: Option<OsString>,
    pub path: Option<OsString>,
    pub user_id: Option<OsString>,
    pub env_json: Option<OsString>,
    pub logins_json: Option<OsString>,
}

impl RawLaunchGrant {
    pub fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Self {
        Self {
            bin: lookup(BIN_ENV),
            path: lookup(PATH_ENV),
            user_id: lookup(USER_ID_ENV),
            env_json: lookup(ENV_JSON_ENV),
            logins_json: lookup(LOGINS_JSON_ENV),
        }
    }

    /// Desktop granted nothing: the capability is absent.
    pub fn is_absent(&self) -> bool {
        self.bin.is_none()
            && self.path.is_none()
            && self.user_id.is_none()
            && self.env_json.is_none()
            && self.logins_json.is_none()
    }
}

/// One of the person's Claude Code logins on this computer (11.19): a Claude Code configuration
/// folder they signed in to themselves, and the id the controller knows the login by. Claude Code
/// keeps each folder's sign-in, settings and sessions apart, so each holds one subscription.
/// Instafy reads nothing inside it: it only sets `CLAUDE_CONFIG_DIR` to it for `claude`, or sets
/// none for Claude Code's usual folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Login {
    id: Uuid,
    config_dir: Option<PathBuf>,
}

impl Login {
    /// The login's id, which a lane job's lease names (`claude_code_login_id`).
    pub fn id(&self) -> Uuid {
        self.id
    }

    /// The folder Desktop granted, as it granted it; `None` for Claude Code's usual folder, whose
    /// child gets no `CLAUDE_CONFIG_DIR` at all.
    pub fn config_dir(&self) -> Option<&Path> {
        self.config_dir.as_deref()
    }
}

/// A grant whose values are well formed (3.2, 11.19): an absolute binary path, a UUID user id,
/// granted values that are strings, with an absolute CA file path, and one to [`MAX_LOGINS`]
/// logins, each id and each folder once, each folder absolute or Claude Code's usual one. What
/// they point at is checked by [`LaunchGrant::check`] and [`LaunchGrant::check_login`], at
/// capture and before every spawn.
#[derive(Clone, Debug)]
pub struct LaunchGrant {
    binary: PathBuf,
    path_entries: Vec<PathBuf>,
    user_id: Uuid,
    env: Vec<(&'static str, OsString)>,
    logins: Vec<Login>,
    snapshot: LaunchEnvSnapshot,
    confinement: Confinement,
    trust: Trust,
}

impl LaunchGrant {
    /// `Ok(None)` when Desktop granted nothing; a malformed grant is not ready as a whole, with
    /// the reason: `binary_missing` without a binary path, otherwise `binary_unsafe`, a list of
    /// logins that is absent or not well formed included.
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
        let logins = parse_logins(raw.logins_json.as_deref())?;
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
            logins,
            snapshot,
            confinement,
            trust,
        }))
    }

    /// The granted logins, in the order Desktop granted them.
    pub fn logins(&self) -> &[Login] {
        &self.logins
    }

    /// The granted login `id`, if the grant has it.
    pub fn login(&self, id: Uuid) -> Option<&Login> {
        self.logins.iter().find(|login| login.id == id)
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

    /// The granted D26 values every login shares, unchecked, in [`GRANTED_ENV_KEYS`] order.
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

    /// The checks of 3.2 on what the grant points at now, for the program: the binary and the CA
    /// file every login shares. They run at capture and before every spawn, since Claude Code's
    /// updates move the link's target (4.1); the runtime then spawns the checked target, not the
    /// link. A login's folder has checks of its own ([`Self::check_login`]).
    pub fn check(&self) -> Result<CheckedLaunch, NotReadyReason> {
        let (program, identity) = self.check_binary()?;
        for (name, value) in &self.env {
            if *name == CA_FILE_KEY {
                self.check_private_location(Path::new(value), false)?;
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

    /// The checks of 3.2 on a login's folder now (11.19): those a granted `CLAUDE_CONFIG_DIR`
    /// gets (D26), at capture and before every spawn. One that fails makes only its own login
    /// not ready, as `binary_unsafe`: nothing starts `claude` with that folder, and nothing starts
    /// it without, since Claude Code would then load its usual folder instead. Claude Code's usual
    /// folder itself has no granted path to check, as before a grant named folders.
    pub fn check_login(&self, login: &Login) -> Result<CheckedLogin, NotReadyReason> {
        if let Some(folder) = &login.config_dir {
            self.check_private_location(folder, true)?;
        }
        Ok(CheckedLogin(login.clone()))
    }

    /// [`Self::check_login`] again, on a login that passed it at its probe, right before a spawn.
    pub fn recheck_login(&self, login: &CheckedLogin) -> Result<(), NotReadyReason> {
        self.check_login(&login.0).map(drop)
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

    /// A login's folder, its `CLAUDE_CONFIG_DIR` (a directory), or the granted CA file: absolute,
    /// outside the confinement with every link on the way, owned by the effective user or root,
    /// and neither group- nor world-writable (D26). A failure is `binary_unsafe`: the value is
    /// never just left out, since without it Claude Code would load its default configuration.
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
        if value.contains('\0') || (name == CA_FILE_KEY && !Path::new(value).is_absolute()) {
            return Err(malformed);
        }
        env.push((name, OsString::from(value)));
    }
    Ok(env)
}

/// One entry of `INSTAFY_CLAUDE_CODE_LOGINS_JSON`, as Desktop writes it (11.19). Read into this
/// shape, an entry with another key, a key twice (which a JSON object read as a map would let
/// through, keeping its last value), no `configDir`, or a value of another type fails.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantedLogin {
    id: String,
    /// Required, though it may be `null`: an `Option` read the usual way would take a missing
    /// `configDir` for `null`, Claude Code's usual folder.
    #[serde(rename = "configDir", deserialize_with = "Option::deserialize")]
    config_dir: Option<String>,
}

/// `INSTAFY_CLAUDE_CODE_LOGINS_JSON` (11.19), read strictly: a list of one to [`MAX_LOGINS`]
/// objects with exactly an `id`, a UUID in its hyphenated form, and a `configDir`, an absolute
/// path or `null` for Claude Code's usual folder, each key once; no id twice, and no folder twice
/// (the usual one included), as paths compare on a Mac. Anything else, an absent value included,
/// makes the whole grant malformed (`binary_unsafe`): a list the runtime only half understood
/// could start `claude` with a folder the person never consented to.
fn parse_logins(json: Option<&OsStr>) -> Result<Vec<Login>, NotReadyReason> {
    let malformed = NotReadyReason::BinaryUnsafe;
    let text = json.and_then(OsStr::to_str).ok_or(malformed)?;
    // Each entry is an object: serde reads a struct from a list of its fields' values too.
    let shapes: Vec<Value> = serde_json::from_str(text).map_err(|_| malformed)?;
    if !shapes.iter().all(Value::is_object) {
        return Err(malformed);
    }
    let entries: Vec<GrantedLogin> = serde_json::from_str(text).map_err(|_| malformed)?;
    if entries.is_empty() || entries.len() > MAX_LOGINS {
        return Err(malformed);
    }
    let mut logins: Vec<Login> = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = Some(entry.id.as_str())
            .filter(|id| id.len() == 36)
            .and_then(|id| Uuid::parse_str(id).ok())
            .ok_or(malformed)?;
        let config_dir = match entry.config_dir {
            None => None,
            Some(folder) if !folder.contains('\0') && Path::new(&folder).is_absolute() => {
                Some(PathBuf::from(folder))
            }
            Some(_) => return Err(malformed),
        };
        let taken = logins.iter().any(|login| {
            login.id == id
                || match (&login.config_dir, &config_dir) {
                    (None, None) => true,
                    (Some(taken), Some(folder)) => same_folder(taken, folder),
                    _ => false,
                }
        });
        if taken {
            return Err(malformed);
        }
        logins.push(Login { id, config_dir });
    }
    Ok(logins)
}

/// Whether two absolute paths name the same folder as written: component by component, ignoring
/// ASCII case as a Mac's folders do, and a trailing `/` or a `.`.
fn same_folder(left: &Path, right: &Path) -> bool {
    let (mut left, mut right) = (left.components(), right.components());
    loop {
        match (left.next(), right.next()) {
            (None, None) => return true,
            (Some(left), Some(right)) if same_component(left, right) => {}
            _ => return false,
        }
    }
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
/// first PATH entry), and the granted values every login shares.
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

    /// The granted D26 values every login shares that passed their checks.
    pub fn granted_env(&self) -> &[(&'static str, OsString)] {
        &self.granted_env
    }
}

/// A login whose folder passed [`LaunchGrant::check_login`]: what its `claude` gets as
/// `CLAUDE_CONFIG_DIR`, or nothing for Claude Code's usual folder (3.4, 11.19).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedLogin(Login);

impl CheckedLogin {
    pub fn id(&self) -> Uuid {
        self.0.id
    }

    /// The `CLAUDE_CONFIG_DIR` the child gets, the person's own folder as Desktop granted it;
    /// `None` for Claude Code's usual folder, where the child gets none.
    pub fn config_dir(&self) -> Option<&Path> {
        self.0.config_dir()
    }
}

/// What a login's last `claude auth status` said (3.2, 11.19), the one sign-in check the lane
/// makes. Nothing else of its output is kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SignIn {
    signed_in: Option<bool>,
    plan_sign_in: bool,
}

impl SignIn {
    /// What a run of `auth status` on `cli` says that exited with `status` and printed `stdout`.
    fn of(status: ExitStatus, stdout: &[u8], cli: CliVersion) -> Self {
        Self {
            signed_in: match status.code() {
                Some(0) => Some(true),
                Some(1) => Some(false),
                _ => None,
            },
            plan_sign_in: plan_sign_in(status.success(), stdout, cli),
        }
    }

    /// The capability's `signedIn`: true when `auth status` exited 0, false when it exited 1,
    /// `None` when the probe could not tell or has not run it. A sign-out never makes a login not
    /// ready: a turn on it fails as `not_signed_in`, and Studio says beforehand that the login is
    /// not signed in (3.2).
    pub fn signed_in(&self) -> Option<bool> {
        self.signed_in
    }

    /// The capability's `planSignIn`: a Claude plan sign-in, as [`plan_sign_in`] reads one.
    pub fn plan_sign_in(&self) -> bool {
        self.plan_sign_in
    }
}

/// What a probe found for one login (3.2, 11.19): a turn's, or one whose plan limit just reset.
#[derive(Clone, Debug)]
pub enum Readiness {
    /// The program and the login are ready.
    Ready(ReadyLane),
    /// The program's reason or, with the program ready, the login's own: `binary_unsafe` for a
    /// folder that fails its checks.
    NotReady(NotReadyReason),
    /// A plan limit holds the login (11.11): nothing was probed.
    Held(PlanLimitHold),
}

impl Readiness {
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready(_))
    }

    pub fn reason(&self) -> Option<NotReadyReason> {
        match self {
            Self::Ready(_) => None,
            Self::NotReady(reason) => Some(*reason),
            Self::Held(_) => Some(NotReadyReason::PlanLimit),
        }
    }

    pub fn ready(&self) -> Option<&ReadyLane> {
        match self {
            Self::Ready(ready) => Some(ready),
            Self::NotReady(_) | Self::Held(_) => None,
        }
    }
}

/// A login's Claude plan reached its usage limit, and the login holds until the limit resets
/// (11.11, 11.19, D37): after a turn on it failed as `plan_limit`, the capability says that login
/// is not ready, with the reason `plan_limit` and the reset time, so the controller leases this
/// runtime no lane job on it and the person's other waiting turns on it wait for the reset instead
/// of each starting and failing in turn. The person's other logins keep taking turns. A turn
/// leased on it all the same fails as `plan_limit` at its probe. The hold lives only in memory: a
/// restart forgets it, and the next turn that reaches the limit sets it again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlanLimitHold {
    resets_at: chrono::DateTime<chrono::Utc>,
}

impl PlanLimitHold {
    /// The hold of a turn that failed at the limit at `now`: until `resets_at`, in seconds since
    /// the epoch as Claude Code's `rate_limit_event` gives it, at most [`PLAN_LIMIT_HOLD_AT_MOST`]
    /// ahead, or [`PLAN_LIMIT_HOLD_WITHOUT_A_RESET_TIME`] ahead when it gave none. None when that
    /// time has passed already: the limit reset, and nothing waits for it.
    pub fn after(resets_at: Option<i64>, now: chrono::DateTime<chrono::Utc>) -> Option<Self> {
        let seconds = |duration: Duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX);
        let latest = now
            .timestamp()
            .saturating_add(seconds(PLAN_LIMIT_HOLD_AT_MOST));
        let until = match resets_at {
            Some(resets_at) => resets_at.min(latest),
            None => now
                .timestamp()
                .saturating_add(seconds(PLAN_LIMIT_HOLD_WITHOUT_A_RESET_TIME)),
        };
        let resets_at = chrono::DateTime::from_timestamp(until, 0)?;
        (resets_at > now).then_some(Self { resets_at })
    }

    /// When the limit resets, in whole seconds.
    pub fn resets_at(&self) -> chrono::DateTime<chrono::Utc> {
        self.resets_at
    }

    /// `resets_at` as the capability carries it: RFC 3339, in UTC, to the second.
    pub fn resets_at_rfc3339(&self) -> String {
        self.resets_at
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    /// Whether it still holds at `now`.
    pub fn holds_at(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        now < self.resets_at
    }

    /// How long it holds from now on.
    pub fn remaining(&self) -> Duration {
        (self.resets_at - chrono::Utc::now())
            .to_std()
            .unwrap_or(Duration::ZERO)
    }
}

/// A supported `claude`, a login whose folder passed its checks, and what a turn on that login
/// needs from its probe.
#[derive(Clone, Debug)]
pub struct ReadyLane {
    cli: CliVersion,
    verified: bool,
    help: HelpFacts,
    launch: CheckedLaunch,
    login: CheckedLogin,
    sign_in: SignIn,
}

impl ReadyLane {
    pub fn cli(&self) -> CliVersion {
        self.cli
    }

    pub fn verified(&self) -> bool {
        self.verified
    }

    /// Whether the login's `auth status` reports a Claude plan sign-in.
    pub fn plan_sign_in(&self) -> bool {
        self.sign_in.plan_sign_in
    }

    /// How the login's `auth status` exited: [`SignIn::signed_in`].
    pub fn signed_in(&self) -> Option<bool> {
        self.sign_in.signed_in
    }

    pub fn help(&self) -> &HelpFacts {
        &self.help
    }

    pub fn launch(&self) -> &CheckedLaunch {
        &self.launch
    }

    /// The login the turn runs on, whose folder passed its checks at the probe.
    pub fn login(&self) -> &CheckedLogin {
        &self.login
    }
}

/// The capability of a grant that is not well formed as a whole (11.19): not ready, with its
/// reason, and no login, since the runtime trusts nothing such a grant names:
/// `{"version": 2, "ready": false, "reason": …, "logins": {}}`.
pub fn malformed_grant_capability(reason: NotReadyReason) -> Value {
    json!({
        "version": CAPABILITY_VERSION,
        "ready": false,
        "reason": reason.as_str(),
        "logins": {},
    })
}

/// What the program's last probe found that the capability carries (3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProgramFacts {
    cli: CliVersion,
    verified: bool,
}

impl ProgramFacts {
    fn of(cli: CliVersion) -> Self {
        Self {
            cli,
            verified: is_verified(cli),
        }
    }
}

/// What the lane knows of one login (11.19).
#[derive(Clone, Debug)]
struct LoginState {
    id: Uuid,
    /// Its folder's checks, as they last ran: at capture, then at each probe of the login.
    folder: Result<(), NotReadyReason>,
    /// What its last `auth status` said; nothing before the first.
    sign_in: SignIn,
    /// The plan limit that holds it (11.11). One whose reset time has passed holds nothing, and
    /// stays only until the login's next probe, which the timed re-probe runs at that time.
    hold: Option<PlanLimitHold>,
}

impl LoginState {
    /// The login's entry in the capability at `now`, under a program that is ready, or not ready
    /// for `program_reason`.
    fn capability_at(
        &self,
        program_reason: Option<NotReadyReason>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Value {
        let hold = self.hold.filter(|hold| hold.holds_at(now));
        let reason = program_reason
            .or(self.folder.err())
            .or(hold.map(|_| NotReadyReason::PlanLimit));
        let mut entry = serde_json::Map::new();
        entry.insert("ready".into(), Value::Bool(reason.is_none()));
        if let Some(reason) = reason {
            entry.insert("reason".into(), reason.as_str().into());
        }
        if let (Some(NotReadyReason::PlanLimit), Some(hold)) = (reason, hold) {
            entry.insert("resetsAt".into(), hold.resets_at_rfc3339().into());
        }
        entry.insert("planSignIn".into(), Value::Bool(self.sign_in.plan_sign_in));
        if let Some(signed_in) = self.sign_in.signed_in {
            entry.insert("signedIn".into(), Value::Bool(signed_in));
        }
        Value::Object(entry)
    }
}

/// What the lane knows of the program and of each login, which the capability is built from.
#[derive(Clone, Debug)]
struct LaneState {
    /// The program's last probe: `None` before the first, unless the program failed its checks
    /// at capture.
    program: Option<Result<ProgramFacts, NotReadyReason>>,
    /// Every granted login, in the grant's order.
    logins: Vec<LoginState>,
    /// How many turns this runtime runs at once, each in a folder of its own (11.23, D54): 1
    /// until the job pipeline says it can give each turn one ([`Lane::set_turns_at_once`]).
    turns_at_once: u64,
}

impl LaneState {
    fn login_mut(&mut self, id: Uuid) -> Option<&mut LoginState> {
        self.logins.iter_mut().find(|login| login.id == id)
    }

    /// The version 2 `claudeCode` capability at `now` (2.10, 3.2, 11.19), or `None` before the
    /// program's first probe:
    /// `{"version": 2, "ready", "reason"?, "cli"?, "verified"?, "partialMessages"?,
    /// "turnsAtOnce"?, "logins"}`. `turnsAtOnce` is there while the program is ready and the
    /// runtime runs more than one turn at once (11.23); without it the controller reads 1.
    /// The top level is the program's: `cli`, `verified` and `partialMessages` while it is ready
    /// (the lane always streams partial messages, `--include-partial-messages`, 3.3), and its
    /// `reason` while it is not. Every granted login is listed under its id, lowercase and
    /// hyphenated, with `ready`, a `reason` while it is not ready, `resetsAt` with `plan_limit`
    /// only, `planSignIn`, and `signedIn` when its last `auth status` told. A login is ready only
    /// while the program is, and otherwise carries the program's reason; with the program ready,
    /// `binary_unsafe` for a folder that fails its checks, or `plan_limit` while its hold lasts.
    /// It never holds a path, which would name the OS user.
    fn capability_at(&self, now: chrono::DateTime<chrono::Utc>) -> Option<Value> {
        let program = self.program.as_ref()?;
        let program_reason = program.as_ref().err().copied();
        let logins: serde_json::Map<String, Value> = self
            .logins
            .iter()
            .map(|login| {
                (
                    login.id.to_string(),
                    login.capability_at(program_reason, now),
                )
            })
            .collect();
        let mut capability = match program {
            Ok(facts) => {
                let mut capability = json!({
                    "version": CAPABILITY_VERSION,
                    "ready": true,
                    "cli": facts.cli.to_string(),
                    "verified": facts.verified,
                    "partialMessages": true,
                });
                if self.turns_at_once > 1 {
                    capability["turnsAtOnce"] = json!(self.turns_at_once);
                }
                capability
            }
            Err(reason) => json!({
                "version": CAPABILITY_VERSION,
                "ready": false,
                "reason": reason.as_str(),
            }),
        };
        capability["logins"] = Value::Object(logins);
        Some(capability)
    }

    /// What the timed re-probe has to look at now (3.2, 11.11, 11.19).
    fn reprobe_due(&self, now: chrono::DateTime<chrono::Utc>) -> Reprobe {
        if !matches!(self.program, Some(Ok(_))) {
            return Reprobe::Everything;
        }
        let folders: Vec<Uuid> = self
            .logins
            .iter()
            .filter(|login| login.folder.is_err())
            .map(|login| login.id)
            .collect();
        let reset: Vec<Uuid> = self
            .logins
            .iter()
            .filter(|login| {
                login.folder.is_ok() && login.hold.is_some_and(|hold| !hold.holds_at(now))
            })
            .map(|login| login.id)
            .collect();
        if folders.is_empty() && reset.is_empty() {
            Reprobe::Nothing
        } else {
            Reprobe::Logins { folders, reset }
        }
    }
}

/// What the timed re-probe looks at.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Reprobe {
    /// The program is not ready: no lane turn runs to notice that the person fixed it, so the
    /// program and every login no plan limit holds are probed again.
    Everything,
    /// The program is ready. The logins of `folders` have a folder that failed its checks: those
    /// checks alone run again, which read the folder's owner and mode and start nothing, and a
    /// login whose folder passes them is probed again. The plan limits of `reset` reset: each of
    /// those logins is probed again.
    Logins {
        folders: Vec<Uuid>,
        reset: Vec<Uuid>,
    },
    Nothing,
}

/// A probe of one login and whether it changed the published capability. A change while
/// registered means the runtime must register again with the new value (3.2).
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

/// The lane of a captured grant: its probes, the `--help` reading it keeps, what it knows of the
/// program and of each login, the published `claudeCode` capability built from that, and the
/// plan limits that hold its logins, while they do (11.19).
///
/// The capability is fixed for each registration. Registration reads [`Lane::capability`]; a
/// probe that changes it, a plan limit's hold and its end ([`Lane::hold_for_plan_limit`]), and
/// [`Lane::reprobe_while_not_ready`] publish the new value to [`Lane::subscribe`] for the
/// registration loop to register again.
pub struct Lane {
    grant: LaunchGrant,
    probe_timeout: Duration,
    /// The last `--help` reading. The probe that runs holds it, so probes run one at a time.
    help: tokio::sync::Mutex<Option<CachedHelp>>,
    /// What the capability is built from. It is never held across an await.
    state: parking_lot::Mutex<LaneState>,
    capability: watch::Sender<Option<Value>>,
    /// Wakes the timed re-probe when a hold starts, so it probes that login again at its reset
    /// time.
    hold_started: tokio::sync::Notify,
}

impl Lane {
    /// The lane of `grant`, each login's folder checked once, as the capture checks it (3.2).
    /// Nothing is published before the program's first probe.
    pub fn new(grant: LaunchGrant) -> Self {
        let logins = grant
            .logins
            .iter()
            .map(|login| LoginState {
                id: login.id,
                folder: grant.check_login(login).map(drop),
                sign_in: SignIn::default(),
                hold: None,
            })
            .collect();
        Self {
            grant,
            probe_timeout: PROBE_TIMEOUT,
            help: tokio::sync::Mutex::new(None),
            state: parking_lot::Mutex::new(LaneState {
                program: None,
                logins,
                turns_at_once: 1,
            }),
            capability: watch::channel(None).0,
            hold_started: tokio::sync::Notify::new(),
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

    /// Probes the granted `claude` for a turn on `login` (3.2, 11.19): checks the grant and the
    /// login's folder again, then runs `--version`, `--help` only when the version or the binary
    /// changed since it last ran, and `auth status`, each with the login's lane environment,
    /// stdin from null, a fresh empty runtime folder as working directory, [`PROBE_TIMEOUT`] and
    /// [`PROBE_OUTPUT_CAP`]. It never sends a prompt. Probes run one at a time. While a plan limit
    /// holds the login, it runs nothing and says so ([`Readiness::Held`], 11.11): the limit, not
    /// `claude`, keeps the login's turns from running. A login the grant does not have is not
    /// ready (`binary_unsafe`), and nothing runs for it; no lane job names one (3.9). What it
    /// finds is kept for the capability, which [`Self::probe_and_publish`] publishes.
    pub async fn probe(&self, login: Uuid) -> Readiness {
        let Some(login) = self.grant.login(login) else {
            return Readiness::NotReady(NotReadyReason::BinaryUnsafe);
        };
        if let Some(hold) = self.hold_or_clear(login.id) {
            return Readiness::Held(hold);
        }
        let mut cached_help = self.help.lock().await;
        let checked = self.grant.check_login(login);
        self.keep_folder(login.id, &checked);
        let launch = match self.grant.check() {
            Ok(launch) => launch,
            Err(reason) => {
                self.keep_program(Err(reason));
                return Readiness::NotReady(reason);
            }
        };
        let checked = match checked {
            Ok(checked) => checked,
            Err(reason) => return Readiness::NotReady(reason),
        };
        let environment = command::lane_environment(&self.grant, &launch, &checked);
        let (cli, help) = match self
            .probe_program(&mut cached_help, &launch, &environment, None)
            .await
        {
            Ok(found) => found,
            Err(reason) => {
                self.keep_program(Err(reason));
                return Readiness::NotReady(reason);
            }
        };
        self.keep_program(Ok(ProgramFacts::of(cli)));
        // Without a deadline nothing cuts `auth status` short.
        let sign_in = self
            .auth_status(&launch, cli, &environment, None)
            .await
            .unwrap_or_default();
        self.keep_sign_in(login.id, sign_in);
        drop(cached_help);
        // A plan limit's hold that started while the probe ran says what the login is (11.11).
        if let Some(hold) = self.plan_limit_hold(login.id) {
            return Readiness::Held(hold);
        }
        Readiness::Ready(ReadyLane {
            cli,
            verified: is_verified(cli),
            help,
            launch,
            login: checked,
            sign_in,
        })
    }

    /// [`Self::probe`] of `login`, then publishes what the lane knows.
    pub async fn probe_and_publish(&self, login: Uuid) -> LaneProbe {
        let readiness = self.probe(login).await;
        let capability_changed = self.publish();
        LaneProbe {
            readiness,
            capability_changed,
        }
    }

    /// Probes the program and every login, then publishes what the lane knows, and says whether
    /// that changed the capability (3.2, 11.19). `--version`, and `--help` as [`Self::probe`]
    /// runs it, run once for the program; then `auth status` runs once for each login whose folder
    /// passes its checks and that no plan limit holds, all at the same time, each with its login's
    /// `CLAUDE_CONFIG_DIR` and nothing else changed. The program's commands run in a login's
    /// environment too, the first one's whose folder passes its checks, so `claude` never runs
    /// with a folder the person did not grant, or one that failed its checks. When every folder
    /// fails them, nothing runs, and the program is not ready either (`binary_unsafe`).
    pub async fn probe_and_publish_all(&self) -> bool {
        self.probe_all(None).await;
        self.publish()
    }

    /// The startup probe (3.2): [`Self::probe_and_publish_all`], with one limit for every command
    /// together, the limit of one ([`PROBE_TIMEOUT`]), the logins' `auth status` running side by
    /// side within it. The runtime registers, and so takes any turn, Codex's too, only once it
    /// ended, so a `claude` that stalls delays that by this limit and the last commands' kill at
    /// most. A probe that runs out of it, an `auth status` cut short included, leaves the program
    /// `probe_failed`, which the timed re-probe ([`Self::reprobe_while_not_ready`]) corrects by
    /// registering again.
    pub async fn probe_and_publish_at_startup(&self) -> bool {
        self.probe_all(Some(Instant::now() + self.probe_timeout))
            .await;
        self.publish()
    }

    async fn probe_all(&self, deadline: Option<Instant>) {
        let mut cached_help = self.help.lock().await;
        let checked: Vec<Result<CheckedLogin, NotReadyReason>> = self
            .grant
            .logins
            .iter()
            .map(|login| {
                let checked = self.grant.check_login(login);
                self.keep_folder(login.id, &checked);
                checked
            })
            .collect();
        // The probe that starts now is the one an ended hold called for.
        self.clear_ended_holds();
        let launch = match self.grant.check() {
            Ok(launch) => launch,
            Err(reason) => return self.keep_program(Err(reason)),
        };
        let Some(first) = checked.iter().find_map(|checked| checked.as_ref().ok()) else {
            return self.keep_program(Err(NotReadyReason::BinaryUnsafe));
        };
        let environment = command::lane_environment(&self.grant, &launch, first);
        let cli = match self
            .probe_program(&mut cached_help, &launch, &environment, deadline)
            .await
        {
            Ok((cli, _)) => cli,
            Err(reason) => return self.keep_program(Err(reason)),
        };
        let launch = &launch;
        let signs_in = futures_util::future::join_all(
            checked
                .iter()
                .filter_map(|checked| checked.as_ref().ok())
                .filter(|login| self.plan_limit_hold(login.id()).is_none())
                .map(|login| async move {
                    let environment = command::lane_environment(&self.grant, launch, login);
                    let sign_in = self.auth_status(launch, cli, &environment, deadline).await;
                    (login.id(), sign_in)
                }),
        )
        .await;
        let mut cut_short = false;
        for (login, sign_in) in signs_in {
            cut_short |= sign_in.is_none();
            self.keep_sign_in(login, sign_in.unwrap_or_default());
        }
        self.keep_program(if cut_short {
            Err(NotReadyReason::ProbeFailed)
        } else {
            Ok(ProgramFacts::of(cli))
        });
    }

    /// `--version`, and `--help` unless its last reading still holds, with `environment`: the
    /// program's version and `--help` facts, or why it is not ready (3.2).
    async fn probe_program(
        &self,
        cached_help: &mut Option<CachedHelp>,
        launch: &CheckedLaunch,
        environment: &[(OsString, OsString)],
        deadline: Option<Instant>,
    ) -> Result<(CliVersion, HelpFacts), NotReadyReason> {
        let version = self
            .run(launch, environment, &["--version"], deadline)
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
                    .run(launch, environment, &["--help"], deadline)
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
        Ok((version, help))
    }

    /// What `auth status` says of a login, run with its `environment` (3.2). `None` only when the
    /// startup probe's `deadline` cut it short, which fails that probe; one that fails otherwise
    /// says nothing of the sign-in, and the login stays ready.
    async fn auth_status(
        &self,
        launch: &CheckedLaunch,
        cli: CliVersion,
        environment: &[(OsString, OsString)],
        deadline: Option<Instant>,
    ) -> Option<SignIn> {
        match self
            .run(launch, environment, &["auth", "status"], deadline)
            .await
        {
            Ok(run) => Some(SignIn::of(run.status, &run.stdout, cli)),
            Err(ProbeRunError::TimedOut)
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) =>
            {
                None
            }
            Err(_) => Some(SignIn::default()),
        }
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

    fn keep_program(&self, program: Result<ProgramFacts, NotReadyReason>) {
        self.state.lock().program = Some(program);
    }

    fn keep_folder(&self, login: Uuid, checked: &Result<CheckedLogin, NotReadyReason>) {
        if let Some(state) = self.state.lock().login_mut(login) {
            state.folder = checked.as_ref().map(|_| ()).map_err(|reason| *reason);
        }
    }

    fn keep_sign_in(&self, login: Uuid, sign_in: SignIn) {
        if let Some(state) = self.state.lock().login_mut(login) {
            state.sign_in = sign_in;
        }
    }

    /// Holds `login` after a turn on it failed at its Claude plan's usage limit (11.11, 11.19):
    /// until `resets_at` (seconds since the epoch), or as [`PlanLimitHold::after`] says without
    /// it. It publishes the capability with that login not ready, so this runtime registers again,
    /// and wakes the timed re-probe, which probes the login again at the reset time. The person's
    /// other logins keep taking turns. Returns the hold, or None when the reset time has passed
    /// already or the grant has no such login.
    pub fn hold_for_plan_limit(
        &self,
        login: Uuid,
        resets_at: Option<i64>,
    ) -> Option<PlanLimitHold> {
        let hold = PlanLimitHold::after(resets_at, chrono::Utc::now())?;
        self.state.lock().login_mut(login)?.hold = Some(hold);
        if self.publish() {
            info!(
                %login,
                resets_at = %hold.resets_at_rfc3339(),
                "a Claude Code login reached its Claude plan's limit; this runtime takes no Claude Code turn on it until it resets"
            );
        }
        self.hold_started.notify_one();
        Some(hold)
    }

    /// The plan limit that holds `login` now, if one does. A hold whose reset time has passed
    /// holds nothing: the login's next probe runs, and publishes what it finds.
    pub fn plan_limit_hold(&self, login: Uuid) -> Option<PlanLimitHold> {
        let now = chrono::Utc::now();
        self.state
            .lock()
            .logins
            .iter()
            .find(|state| state.id == login)?
            .hold
            .filter(|hold| hold.holds_at(now))
    }

    /// The hold a probe of `login` respects; one that has ended is dropped, since the probe that
    /// starts now is the one its end called for.
    fn hold_or_clear(&self, login: Uuid) -> Option<PlanLimitHold> {
        let now = chrono::Utc::now();
        let mut state = self.state.lock();
        let login = state.login_mut(login)?;
        if login.hold.is_some_and(|hold| !hold.holds_at(now)) {
            login.hold = None;
        }
        login.hold
    }

    fn clear_ended_holds(&self) {
        let now = chrono::Utc::now();
        for login in &mut self.state.lock().logins {
            if login.hold.is_some_and(|hold| !hold.holds_at(now)) {
                login.hold = None;
            }
        }
    }

    /// How long until the first of the logins' holds ends, zero for one that ended unprobed;
    /// `None` while no hold is kept.
    fn until_a_hold_ends(&self) -> Option<Duration> {
        self.state
            .lock()
            .logins
            .iter()
            .filter_map(|login| login.hold)
            .map(|hold| hold.remaining())
            .min()
    }

    /// Publishes the capability the lane's state gives now, if it changed; returns whether it
    /// did. The state stays locked while it publishes, so values go out in the order the state
    /// took them.
    fn publish(&self) -> bool {
        let state = self.state.lock();
        let Some(capability) = state.capability_at(chrono::Utc::now()) else {
            return false;
        };
        let changed = self.capability.send_if_modified(|current| {
            if current.as_ref() == Some(&capability) {
                return false;
            }
            *current = Some(capability.clone());
            true
        });
        drop(state);
        if changed {
            info!(%capability, "the Claude Code capability changed");
        }
        changed
    }

    /// Says how many turns this runtime runs at once, each in a folder of its own (11.23, D54):
    /// 1 to `MAX_TURNS_AT_ONCE`, 1 for a computer that cannot give each turn one. A change is
    /// published, and the registration loop registers again with it.
    pub fn set_turns_at_once(&self, turns: u64) {
        let turns = turns.clamp(1, runtime_contracts::claude_code_lane::MAX_TURNS_AT_ONCE);
        let changed = {
            let mut state = self.state.lock();
            let changed = state.turns_at_once != turns;
            state.turns_at_once = turns;
            changed
        };
        if changed {
            self.publish();
        }
    }

    /// The published capability, `None` before the first probe.
    pub fn capability(&self) -> Option<Value> {
        self.capability.borrow().clone()
    }

    /// Each capability this lane publishes.
    pub fn subscribe(&self) -> watch::Receiver<Option<Value>> {
        self.capability.subscribe()
    }

    /// Looks again while the program or a login is not ready, and publishes a changed result
    /// (3.2, 11.11, 11.19), since no lane turn, and so no per-turn probe, runs to notice that the
    /// person fixed what was wrong:
    /// - every `interval` while the program is not ready, the program and every login again;
    /// - every `interval` while a login's folder fails its checks, those checks alone, which start
    ///   nothing, so a folder that stays unusable, one that was deleted say, costs no `claude`
    ///   command for as long as it stays granted; once it passes, that login alone is probed;
    /// - each login a plan limit holds, at its reset time, however soon that comes, so it reports
    ///   ready again, or what the probe finds.
    ///
    /// Each change registers again. A held login is probed for nothing until its reset, and ready
    /// ones are left to their turns' probes. A hold that starts while it waits wakes it to wait
    /// for that reset too. Runs until dropped.
    pub async fn reprobe_while_not_ready(&self, interval: Duration) {
        loop {
            let wait = self
                .until_a_hold_ends()
                .map_or(interval, |left| left.min(interval));
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = self.hold_started.notified() => continue,
            }
            let due = self.state.lock().reprobe_due(chrono::Utc::now());
            match due {
                Reprobe::Everything => {
                    self.probe_and_publish_all().await;
                }
                Reprobe::Logins { folders, reset } => {
                    for login in folders {
                        self.recheck_folder_and_publish(login).await;
                    }
                    for login in reset {
                        self.probe_and_publish(login).await;
                    }
                }
                Reprobe::Nothing => {}
            }
        }
    }

    /// The timed look at a login whose folder failed its checks (11.19): the checks again, alone,
    /// which read the folder's owner and mode and start nothing. Once they pass, the login is
    /// probed, unless a plan limit holds it; either way only a change is published.
    async fn recheck_folder_and_publish(&self, login: Uuid) {
        let Some(granted) = self.grant.login(login) else {
            return;
        };
        // A hold that has ended is dropped: this look is the one its end called for.
        let held = self.hold_or_clear(login).is_some();
        let checked = self.grant.check_login(granted);
        self.keep_folder(login, &checked);
        if checked.is_ok() && !held {
            self.probe_and_publish(login).await;
        } else {
            self.publish();
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
                    runtime.block_on(self.probe_and_publish_at_startup());
                    Some(())
                })
                .join()
                .ok()
                .flatten()
        });
        if probed.is_none() || self.capability().is_none() {
            self.keep_program(Err(NotReadyReason::ProbeFailed));
            self.publish();
        }
        self.capability()
            .unwrap_or_else(|| malformed_grant_capability(NotReadyReason::ProbeFailed))
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
    /// A malformed grant: not ready as a whole, with the reason and no login, until a new grant
    /// restarts the runtime.
    Unusable(NotReadyReason),
    /// A well-formed grant and its lane.
    Granted(Lane),
}

impl CapturedGrant {
    /// Parses the grant and checks it once, the program and each login's folder, so a program
    /// that fails its checks gives a not-ready capability from the start, and a login whose
    /// folder fails them is not ready from the startup probe on. Nothing here stops startup.
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
                    lane.keep_program(Err(reason));
                    lane.publish();
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

/// Reads and removes the launch grant (`INSTAFY_CLAUDE_CODE_*`, the logins included), snapshots
/// the launch environment the child gets (3.4), checks the grant (3.2, 11.19) and keeps all of it
/// for the life of the process. A bad value leaves the lane not ready (`binary_missing` or
/// `binary_unsafe`), or, for a login's folder, that login; it never stops startup. The variables
/// leave the environment whatever the platform, so nothing the runtime starts inherits them.
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

/// The `claudeCode` registration capability (2.10, 3.2, 11.19): absent without a grant, off
/// macOS and on a Personal Browser runtime; for a malformed grant, not ready with no login;
/// otherwise the published value, or the startup probe's.
pub fn registration_capability() -> Option<Value> {
    if !lane_is_offered_here() {
        return None;
    }
    match CAPTURED.get()? {
        CapturedGrant::Absent => None,
        CapturedGrant::Unusable(reason) => Some(malformed_grant_capability(*reason)),
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
        let floor = CliVersion::new(2, 1, 325);
        assert_eq!(CliVersion::parse("2.1.325 (Claude Code)\n"), Some(floor));
        assert_eq!(CliVersion::parse("\n  2.1.325"), Some(floor));
        assert_eq!(CliVersion::parse("2.1.325-beta.2"), Some(floor));
        assert_eq!(
            CliVersion::parse("2.1.3250"),
            Some(CliVersion::new(2, 1, 3250))
        );
        for text in [
            "Claude Code 2.1.325",
            "v2.1.325",
            "2.1",
            "2.1.",
            "2..325",
            "",
            "99999999999999999999.1.1",
        ] {
            assert_eq!(CliVersion::parse(text), None, "{text:?}");
        }
        assert_eq!(floor.to_string(), "2.1.325");
        assert_eq!(MIN_SUPPORTED_VERSION, floor);
        // Numbers compare as numbers.
        assert!(CliVersion::new(2, 1, 1000) > CliVersion::new(2, 1, 999));
        assert!(CliVersion::new(2, 2, 0) > CliVersion::new(2, 1, 999));
        assert!(CliVersion::new(2, 1, 324) < MIN_SUPPORTED_VERSION);
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
        std::fs::write(versions.join("2.1.325"), "").unwrap();
        std::fs::create_dir_all(root.join("home/.local/bin")).unwrap();
        // A relative directory link that climbs, an absolute file link, and a directory link
        // on the way to the granted path.
        symlink("../claude/versions", root.join("opt/claude/current")).unwrap();
        symlink(
            root.join("opt/claude/current/2.1.325"),
            root.join("home/.local/bin/claude"),
        )
        .unwrap();
        symlink("home/.local", root.join("alias")).unwrap();
        let granted = root.join("alias/bin/claude");
        let walk = walk_symlinks(&granted).unwrap();
        assert_eq!(walk.target, std::fs::canonicalize(&granted).unwrap());
        assert_eq!(walk.target, versions.join("2.1.325"));
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
            "HOME" => Some("/home/person".into()),
            "PATH" => Some("/usr/bin:/bin".into()),
            _ => None,
        })
    }

    /// `INSTAFY_CLAUDE_CODE_LOGINS_JSON` for `logins`, each an id and its folder, `None` for
    /// Claude Code's usual one.
    fn logins_json(logins: &[(Uuid, Option<&str>)]) -> OsString {
        Value::Array(
            logins
                .iter()
                .map(|(id, folder)| json!({ "id": id.to_string(), "configDir": folder }))
                .collect(),
        )
        .to_string()
        .into()
    }

    /// A grant of the binary `bin` with one login, Claude Code's usual folder.
    fn raw(bin: &str) -> RawLaunchGrant {
        RawLaunchGrant {
            bin: Some(bin.into()),
            path: None,
            user_id: Some(Uuid::new_v4().to_string().into()),
            env_json: None,
            logins_json: Some(logins_json(&[(Uuid::new_v4(), None)])),
        }
    }

    /// `raw` parsed with the process's own trust: a test that checks a real folder through the
    /// grant needs that folder's owner, the effective user, to be trusted, whatever uid the
    /// platform gives it (501 on a Mac, 1001 on a Linux CI runner). Tests of made-up ownership
    /// build a `Trust` of their own.
    fn parse(raw: RawLaunchGrant) -> Result<Option<LaunchGrant>, NotReadyReason> {
        LaunchGrant::parse(
            raw,
            snapshot(),
            Confinement::new([PathBuf::from("/workspace")]),
            Trust::current(),
        )
    }

    fn lane_fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../../runtime-contracts/src/claude_code_lane_fixtures.json"
        ))
        .expect("the lane fixtures are JSON")
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
        // Logins alone are a grant too, one without a binary.
        let only_logins = RawLaunchGrant {
            logins_json: raw("/usr/local/bin/claude").logins_json,
            ..RawLaunchGrant::default()
        };
        assert_eq!(
            parse(only_logins).err(),
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
            r#""HTTPS_PROXY""#,
            r#"{"HTTPS_PROXY": 7}"#,
            r#"{"HTTPS_PROXY": ["http://proxy.example:3128"]}"#,
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

    /// The logins are read strictly (11.19): one to ten of them, each with exactly a UUID `id`
    /// and an absolute or `null` `configDir`, no id and no folder twice. Anything else, an absent
    /// list included, makes the whole grant malformed, `binary_unsafe`.
    #[test]
    fn a_list_of_logins_that_is_not_well_formed_makes_the_whole_grant_malformed() {
        let id = Uuid::new_v4().to_string();
        let other = Uuid::new_v4().to_string();
        let folders = |count: usize| -> Value {
            (0..count)
                .map(|n| {
                    json!({
                        "id": Uuid::new_v4().to_string(),
                        "configDir": format!("/home/person/.claude-{n}"),
                    })
                })
                .collect()
        };
        let with_logins = |logins: &str| RawLaunchGrant {
            logins_json: Some(logins.into()),
            ..raw("/usr/local/bin/claude")
        };
        for logins in [
            "not json".to_string(),
            "null".to_string(),
            "{}".to_string(),
            "[]".to_string(),
            folders(11).to_string(),
            json!([7]).to_string(),
            json!([{ "id": id }]).to_string(),
            json!([{ "configDir": null }]).to_string(),
            json!([{ "id": id, "configDir": null, "label": "Work" }]).to_string(),
            // A key twice: read as a map, the object would keep its last value.
            format!(r#"[{{"id": "{id}", "configDir": null, "id": "{other}"}}]"#),
            format!(r#"[{{"id": "{id}", "configDir": null, "configDir": "/home/person/.claude-work"}}]"#),
            // An entry that is a list of the values, not an object.
            json!([[id, null]]).to_string(),
            json!([{ "id": "not-a-uuid", "configDir": null }]).to_string(),
            json!([{ "id": Uuid::parse_str(&id).unwrap().simple().to_string(), "configDir": null }])
                .to_string(),
            json!([{ "id": format!("{{{id}}}"), "configDir": null }]).to_string(),
            json!([{ "id": format!(" {id}"), "configDir": null }]).to_string(),
            json!([{ "id": 7, "configDir": null }]).to_string(),
            json!([{ "id": id, "configDir": "relative/.claude" }]).to_string(),
            json!([{ "id": id, "configDir": "~/.claude-work" }]).to_string(),
            json!([{ "id": id, "configDir": "" }]).to_string(),
            json!([{ "id": id, "configDir": 7 }]).to_string(),
            json!([{ "id": id, "configDir": "/home/person/.claude\u{0}work" }]).to_string(),
            json!([
                { "id": id, "configDir": null },
                { "id": id, "configDir": "/home/person/.claude-work" },
            ])
            .to_string(),
            json!([
                { "id": id, "configDir": null },
                { "id": id.to_uppercase(), "configDir": "/home/person/.claude-work" },
            ])
            .to_string(),
            json!([
                { "id": id, "configDir": null },
                { "id": other, "configDir": null },
            ])
            .to_string(),
            json!([
                { "id": id, "configDir": "/home/person/.claude-work" },
                { "id": other, "configDir": "/home/person/.claude-work/" },
            ])
            .to_string(),
            json!([
                { "id": id, "configDir": "/home/person/.claude-work" },
                { "id": other, "configDir": "/Home/Person/.Claude-Work" },
            ])
            .to_string(),
            json!([
                { "id": id, "configDir": "/home/person/./.claude-work" },
                { "id": other, "configDir": "/home/person/.claude-work" },
            ])
            .to_string(),
        ] {
            assert_eq!(
                parse(with_logins(&logins)).err(),
                Some(NotReadyReason::BinaryUnsafe),
                "{logins}"
            );
        }
        let absent = RawLaunchGrant {
            logins_json: None,
            ..raw("/usr/local/bin/claude")
        };
        assert_eq!(parse(absent).err(), Some(NotReadyReason::BinaryUnsafe));
        // Ten is the most, and folders that differ in more than case or a trailing slash are
        // folders of their own.
        let ten = parse(with_logins(&folders(10).to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(
            ten.logins().len(),
            runtime_contracts::claude_code_lane::MAX_LOGINS
        );
        let apart = json!([
            { "id": id, "configDir": "/home/person/.claude-work" },
            { "id": other, "configDir": "/home/person/.claude-work-2" },
        ]);
        assert_eq!(
            parse(with_logins(&apart.to_string()))
                .unwrap()
                .unwrap()
                .logins()
                .len(),
            2
        );
    }

    #[test]
    fn a_grant_keeps_only_the_d26_names_its_logins_and_its_path_entries_as_given() {
        let user_id = Uuid::new_v4();
        let (work, usual) = (Uuid::new_v4(), Uuid::new_v4());
        let grant = parse(RawLaunchGrant {
            bin: Some("/opt/homebrew/bin/claude".into()),
            path: Some("/opt/homebrew/bin::relative/bin:/usr/bin".into()),
            user_id: Some(format!(" {} ", user_id.to_string().to_uppercase()).into()),
            env_json: Some(
                r#"{
                    "NODE_EXTRA_CA_CERTS": "/etc/ssl/corporate.pem",
                    "CLAUDE_CONFIG_DIR": "/home/person/.claude-elsewhere",
                    "HTTPS_PROXY": "http://proxy.example:3128",
                    "HTTP_PROXY": null,
                    "NO_PROXY": "",
                    "ANTHROPIC_API_KEY": "not-a-real-key",
                    "CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token",
                    "PATH": "/evil"
                }"#
                .into(),
            ),
            logins_json: Some(
                json!([
                    { "id": work.to_string().to_uppercase(), "configDir": "/home/person/.claude-work" },
                    { "id": usual.to_string(), "configDir": null },
                ])
                .to_string()
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
        // `CLAUDE_CONFIG_DIR` is no longer one of these: each login brings its own.
        assert_eq!(
            grant.granted_env(),
            [
                ("HTTPS_PROXY", OsString::from("http://proxy.example:3128")),
                (
                    "NODE_EXTRA_CA_CERTS",
                    OsString::from("/etc/ssl/corporate.pem")
                ),
            ]
        );
        assert_eq!(
            grant.logins(),
            [
                Login {
                    id: work,
                    config_dir: Some(PathBuf::from("/home/person/.claude-work")),
                },
                Login {
                    id: usual,
                    config_dir: None,
                },
            ]
        );
        assert_eq!(
            grant.login(work).and_then(Login::config_dir),
            Some(Path::new("/home/person/.claude-work"))
        );
        assert_eq!(grant.login(usual).map(Login::config_dir), Some(None));
        assert_eq!(grant.login(Uuid::new_v4()), None);
        // A `CLAUDE_CONFIG_DIR` there is ignored whatever it holds.
        for ignored in [
            r#"{"CLAUDE_CONFIG_DIR": 7}"#,
            r#"{"CLAUDE_CONFIG_DIR": "relative/.claude"}"#,
        ] {
            let grant = parse(RawLaunchGrant {
                env_json: Some(ignored.into()),
                ..raw("/usr/local/bin/claude")
            })
            .unwrap()
            .unwrap();
            assert!(grant.granted_env().is_empty(), "{ignored}");
        }
    }

    /// A runtime that runs turns at once says how many while its program is ready (11.23), and a
    /// runtime that runs one at a time, or whose program is not ready, says nothing of it.
    #[test]
    fn the_capability_says_how_many_turns_run_at_once() {
        let login = Uuid::new_v4();
        let state = |program, turns_at_once| LaneState {
            program,
            logins: vec![LoginState {
                id: login,
                folder: Ok(()),
                sign_in: SignIn::default(),
                hold: None,
            }],
            turns_at_once,
        };
        let now = chrono::Utc::now();
        let ready = || Some(Ok(ProgramFacts::of(MIN_SUPPORTED_VERSION)));
        assert_eq!(
            state(ready(), 3).capability_at(now).unwrap()["turnsAtOnce"],
            json!(3)
        );
        assert!(
            state(ready(), 1)
                .capability_at(now)
                .unwrap()
                .get("turnsAtOnce")
                .is_none()
        );
        assert!(
            state(Some(Err(NotReadyReason::BinaryMissing)), 3)
                .capability_at(now)
                .unwrap()
                .get("turnsAtOnce")
                .is_none()
        );
    }

    /// The capability a runtime with two logins reports is runtime-contracts' `capability`
    /// fixture, which the controller's attestation keeps unchanged and Studio reads (11.19): the
    /// program ready on 2.1.325, one login ready and signed in with a Claude plan, and one that a
    /// plan limit holds until 2026-11-22T18:00:00Z, which keeps what its last `auth status` said.
    #[test]
    fn two_logins_give_the_capability_runtime_contracts_records() {
        let fixture = lane_fixtures()["capability"].clone();
        let ready = Uuid::parse_str("6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01").unwrap();
        let held = Uuid::parse_str("0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02").unwrap();
        let resets_at = chrono::DateTime::from_timestamp(
            chrono::DateTime::parse_from_rfc3339("2026-11-22T18:00:00Z")
                .unwrap()
                .timestamp(),
            0,
        )
        .unwrap();
        let now = resets_at - chrono::Duration::hours(6);
        let plan = SignIn {
            signed_in: Some(true),
            plan_sign_in: true,
        };
        let state = LaneState {
            program: Some(Ok(ProgramFacts::of(MIN_SUPPORTED_VERSION))),
            logins: vec![
                LoginState {
                    id: ready,
                    folder: Ok(()),
                    sign_in: plan,
                    hold: None,
                },
                LoginState {
                    id: held,
                    folder: Ok(()),
                    sign_in: plan,
                    hold: PlanLimitHold::after(Some(resets_at.timestamp()), now),
                },
            ],
            turns_at_once: 1,
        };
        assert_eq!(state.capability_at(now), Some(fixture));
        assert_eq!(
            CAPABILITY_VERSION,
            lane_fixtures()["capabilityVersion"].as_u64().unwrap()
        );
    }

    /// The capability's shapes (11.19): the program at the top, with `cli`, `verified` and
    /// `partialMessages` only while it is ready, and every login under its id, which is ready
    /// only while the program is and otherwise carries the first reason that holds: the
    /// program's, then `binary_unsafe` for its folder, then `plan_limit` with `resetsAt` while its
    /// hold lasts. `signedIn` only when its last `auth status` told; never a path.
    #[test]
    fn each_login_is_ready_only_while_the_program_is_and_says_the_first_reason_that_holds() {
        let now = chrono::DateTime::from_timestamp(1_900_000_000, 0).unwrap();
        let hold = PlanLimitHold::after(Some(1_900_003_600), now);
        let (ready, folder_unsafe, held) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let (ready_key, unsafe_key, held_key) = (
            ready.to_string(),
            folder_unsafe.to_string(),
            held.to_string(),
        );
        let logins = vec![
            LoginState {
                id: ready,
                folder: Ok(()),
                sign_in: SignIn {
                    signed_in: Some(false),
                    plan_sign_in: false,
                },
                hold: None,
            },
            LoginState {
                id: folder_unsafe,
                folder: Err(NotReadyReason::BinaryUnsafe),
                sign_in: SignIn::default(),
                hold,
            },
            LoginState {
                id: held,
                folder: Ok(()),
                sign_in: SignIn {
                    signed_in: Some(true),
                    plan_sign_in: true,
                },
                hold,
            },
        ];
        let state = |program| LaneState {
            program,
            logins: logins.clone(),
            turns_at_once: 1,
        };
        assert_eq!(
            state(None).capability_at(now),
            None,
            "nothing before a probe"
        );
        let program_ready = state(Some(Ok(ProgramFacts {
            cli: CliVersion::new(2, 1, 400),
            verified: false,
        })));
        let ready_capability = program_ready.capability_at(now).unwrap();
        assert_eq!(
            ready_capability,
            json!({
                "version": 2,
                "ready": true,
                "cli": "2.1.400",
                "verified": false,
                "partialMessages": true,
                "logins": {
                    ready_key.clone(): { "ready": true, "planSignIn": false, "signedIn": false },
                    unsafe_key.clone(): { "ready": false, "reason": "binary_unsafe", "planSignIn": false },
                    held_key.clone(): {
                        "ready": false,
                        "reason": "plan_limit",
                        "resetsAt": "2030-03-17T18:46:40Z",
                        "planSignIn": true,
                        "signedIn": true,
                    },
                },
            })
        );
        let not_ready = state(Some(Err(NotReadyReason::UnsupportedVersion)))
            .capability_at(now)
            .unwrap();
        assert_eq!(
            not_ready,
            json!({
                "version": 2,
                "ready": false,
                "reason": "unsupported_version",
                "logins": {
                    ready_key.clone(): {
                        "ready": false,
                        "reason": "unsupported_version",
                        "planSignIn": false,
                        "signedIn": false,
                    },
                    unsafe_key.clone(): { "ready": false, "reason": "unsupported_version", "planSignIn": false },
                    held_key.clone(): {
                        "ready": false,
                        "reason": "unsupported_version",
                        "planSignIn": true,
                        "signedIn": true,
                    },
                },
            })
        );
        // At its reset time a hold holds nothing.
        let reset = program_ready
            .capability_at(chrono::DateTime::from_timestamp(1_900_003_600, 0).unwrap())
            .unwrap();
        assert_eq!(
            reset["logins"][held_key.as_str()],
            json!({ "ready": true, "planSignIn": true, "signedIn": true })
        );
        assert_eq!(
            reset["logins"][unsafe_key.as_str()]["reason"],
            "binary_unsafe"
        );
        for capability in [&ready_capability, &not_ready, &reset] {
            assert!(!capability.to_string().contains('/'), "{capability}");
            let keys: Vec<&String> = capability["logins"].as_object().unwrap().keys().collect();
            assert_eq!(keys.len(), 3, "every granted login is listed");
            for key in keys {
                assert_eq!(*key, Uuid::parse_str(key).unwrap().hyphenated().to_string());
            }
        }
        // A grant that is not well formed lists no login.
        assert_eq!(
            malformed_grant_capability(NotReadyReason::BinaryUnsafe),
            json!({ "version": 2, "ready": false, "reason": "binary_unsafe", "logins": {} })
        );
        assert_eq!(
            malformed_grant_capability(NotReadyReason::BinaryMissing)["reason"],
            "binary_missing"
        );
    }

    /// The program's own reason is never a login's `plan_limit` (11.19): the program reasons are
    /// runtime-contracts' `PROGRAM_NOT_READY_REASONS`.
    #[test]
    fn the_programs_reasons_are_every_reason_but_a_logins_plan_limit() {
        use runtime_contracts::claude_code_lane::PROGRAM_NOT_READY_REASONS;
        let program: Vec<&str> = NotReadyReason::ALL
            .iter()
            .filter(|reason| **reason != NotReadyReason::PlanLimit)
            .map(|reason| reason.as_str())
            .collect();
        assert_eq!(program, PROGRAM_NOT_READY_REASONS);
    }

    /// A plan limit holds a login until the reset time Claude Code gave, at most a week ahead, or
    /// an hour without one; a reset time that has passed holds nothing (11.11). Meanwhile its
    /// login says not ready, as `plan_limit`, with the reset time in RFC 3339, UTC.
    #[test]
    fn a_plan_limit_holds_until_its_reset_time_and_at_most_a_week() {
        let now = chrono::DateTime::from_timestamp(1_900_000_000, 0).unwrap();
        let hold = PlanLimitHold::after(Some(1_900_000_600), now).expect("a hold");
        assert_eq!(hold.resets_at().timestamp(), 1_900_000_600);
        assert!(hold.holds_at(now));
        assert!(!hold.holds_at(hold.resets_at()));
        let at = |resets_at: Option<i64>| {
            PlanLimitHold::after(resets_at, now).map(|hold| hold.resets_at().timestamp())
        };
        let week = 1_900_000_000 + 7 * 24 * 3_600;
        assert_eq!(at(None), Some(1_900_003_600));
        assert_eq!(at(Some(1_900_000_000 + 30 * 24 * 3_600)), Some(week));
        assert_eq!(at(Some(i64::MAX)), Some(week));
        assert_eq!(at(Some(week)), Some(week));
        for passed in [1_900_000_000, 1_899_999_999, 0, -1, i64::MIN] {
            assert_eq!(at(Some(passed)), None, "{passed}");
        }
        let login = LoginState {
            id: Uuid::new_v4(),
            folder: Ok(()),
            sign_in: SignIn::default(),
            hold: Some(hold),
        };
        assert_eq!(
            login.capability_at(None, now),
            json!({
                "ready": false,
                "reason": "plan_limit",
                "resetsAt": "2030-03-17T17:56:40Z",
                "planSignIn": false,
            })
        );
        assert_eq!(
            login.capability_at(None, hold.resets_at()),
            json!({ "ready": true, "planSignIn": false })
        );
        let held = Readiness::Held(hold);
        assert_eq!(held.reason(), Some(NotReadyReason::PlanLimit));
        assert!(!held.is_ready() && held.ready().is_none());
    }

    /// The timed re-probe probes what no turn would (3.2, 11.11): everything while the program
    /// or a login's folder is not ready, a login whose plan limit reset, and nothing while every
    /// login is ready or only held.
    #[test]
    fn the_timed_probe_probes_what_no_turn_would() {
        let now = chrono::DateTime::from_timestamp(1_900_000_000, 0).unwrap();
        let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
        let live = PlanLimitHold::after(Some(1_900_000_600), now);
        let ended = PlanLimitHold::after(
            Some(1_899_999_000),
            chrono::DateTime::from_timestamp(1_899_990_000, 0).unwrap(),
        );
        let state = |program: Option<Result<ProgramFacts, NotReadyReason>>,
                     folder: Result<(), NotReadyReason>,
                     hold: Option<PlanLimitHold>| LaneState {
            program,
            logins: vec![
                LoginState {
                    id: first,
                    folder,
                    sign_in: SignIn::default(),
                    hold,
                },
                LoginState {
                    id: second,
                    folder: Ok(()),
                    sign_in: SignIn::default(),
                    hold: None,
                },
            ],
            turns_at_once: 1,
        };
        let ready = Some(Ok(ProgramFacts::of(MIN_SUPPORTED_VERSION)));
        let unsafe_folder = Err(NotReadyReason::BinaryUnsafe);
        assert_eq!(
            state(ready, Ok(()), None).reprobe_due(now),
            Reprobe::Nothing
        );
        assert_eq!(
            state(ready, Ok(()), live).reprobe_due(now),
            Reprobe::Nothing
        );
        assert_eq!(
            state(ready, Ok(()), ended).reprobe_due(now),
            Reprobe::Logins {
                folders: vec![],
                reset: vec![first],
            }
        );
        // A program that is not ready is probed again, and every login with it.
        for program in [None, Some(Err(NotReadyReason::ProbeFailed))] {
            assert_eq!(
                state(program, Ok(()), ended).reprobe_due(now),
                Reprobe::Everything
            );
            assert_eq!(
                state(program, unsafe_folder, None).reprobe_due(now),
                Reprobe::Everything
            );
        }
        // A folder that fails its checks is looked at alone, held or not, and the other login,
        // ready, is left to its turns.
        for hold in [None, live, ended] {
            assert_eq!(
                state(ready, unsafe_folder, hold).reprobe_due(now),
                Reprobe::Logins {
                    folders: vec![first],
                    reset: vec![],
                },
                "{hold:?}"
            );
        }
    }

    /// The timed look at a folder that failed its checks runs those checks alone (11.19): while
    /// it still fails, nothing changes and nothing is published; once it passes, a login a plan
    /// limit holds says so in place of the folder's reason, and nothing is probed for it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_folder_is_checked_again_alone() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let work = Uuid::new_v4();
        let grant = parse(RawLaunchGrant {
            logins_json: Some(logins_json(&[(
                work,
                Some(folder.path().to_str().unwrap()),
            )])),
            ..raw("/usr/local/bin/claude")
        })
        .unwrap()
        .unwrap();
        std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o770)).unwrap();
        let lane = Lane::new(grant);
        lane.keep_program(Ok(ProgramFacts::of(MIN_SUPPORTED_VERSION)));
        assert!(lane.publish());
        let hold = lane
            .hold_for_plan_limit(work, Some(chrono::Utc::now().timestamp() + 3_600))
            .expect("a hold");
        let mut updates = lane.subscribe();
        let entry = |updates: &mut watch::Receiver<Option<Value>>| {
            updates.borrow_and_update().as_ref().expect("published")["logins"][work.to_string()]
                .clone()
        };
        assert_eq!(entry(&mut updates)["reason"], "binary_unsafe");
        assert_eq!(
            lane.state.lock().reprobe_due(chrono::Utc::now()),
            Reprobe::Logins {
                folders: vec![work],
                reset: vec![],
            }
        );
        lane.recheck_folder_and_publish(work).await;
        assert!(!updates.has_changed().unwrap());

        std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        lane.recheck_folder_and_publish(work).await;
        assert!(updates.has_changed().unwrap());
        assert_eq!(
            entry(&mut updates),
            json!({
                "ready": false,
                "reason": "plan_limit",
                "resetsAt": hold.resets_at_rfc3339(),
                "planSignIn": false,
            })
        );
        assert_eq!(lane.plan_limit_hold(work), Some(hold));
        assert_eq!(
            lane.state.lock().reprobe_due(chrono::Utc::now()),
            Reprobe::Nothing
        );
    }

    #[test]
    fn a_turn_applies_or_only_plans_and_passes_the_permission_mode_of_its_mode() {
        for (text, mode) in [
            ("apply", ExecutionMode::Apply),
            (" Apply ", ExecutionMode::Apply),
            ("plan_only", ExecutionMode::PlanOnly),
            ("PLAN_ONLY\n", ExecutionMode::PlanOnly),
        ] {
            assert_eq!(ExecutionMode::parse(text), Some(mode), "{text:?}");
        }
        for other in ["approval_required", "plan", "plan-only", "", "acceptEdits"] {
            assert_eq!(ExecutionMode::parse(other), None, "{other:?}");
        }
        assert_eq!(ExecutionMode::Apply.permission_mode(), "acceptEdits");
        assert_eq!(ExecutionMode::PlanOnly.permission_mode(), "plan");
        assert!(ExecutionMode::Apply.saves());
        assert!(!ExecutionMode::PlanOnly.saves());
        assert_eq!(ExecutionMode::PlanOnly.as_str(), "plan_only");
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
            "claudeCode": { "version": 2, "ready": true, "cli": "2.1.325", "logins": {} },
            "claude_code": { "ready": true },
        });
        // Before any probe the launch value stands.
        assert_eq!(with_published_capability(&launched, &lane), launched);
        lane.keep_program(Err(NotReadyReason::UnsupportedVersion));
        assert!(lane.publish());
        let not_ready = lane.capability().expect("published");
        assert_eq!(not_ready["reason"], "unsupported_version");
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
        assert!(!lane.publish(), "nothing before the program's first probe");
        lane.keep_program(Err(NotReadyReason::BinaryMissing));
        assert!(lane.publish());
        assert!(updates.has_changed().unwrap());
        let missing = updates.borrow_and_update().clone().expect("published");
        assert_eq!(missing["reason"], "binary_missing");
        assert!(!lane.publish());
        assert!(!updates.has_changed().unwrap());
        assert_eq!(
            lane.state.lock().reprobe_due(chrono::Utc::now()),
            Reprobe::Everything
        );
        assert_eq!(lane.startup_capability(), missing);
    }

    /// A plan limit holds the login a turn ran on, and only it (11.19): the capability says that
    /// login is not ready, with its reset time, while the program and the person's other login
    /// stay ready; the timed re-probe waits for the reset rather than probing now. Neither a login
    /// the grant does not have nor a reset time that passed holds anything, and nothing runs for
    /// a login the grant does not have.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hold_is_its_logins_alone() {
        let folder = tempfile::tempdir().unwrap();
        let (work, usual) = (Uuid::new_v4(), Uuid::new_v4());
        let grant = parse(RawLaunchGrant {
            logins_json: Some(logins_json(&[
                (work, Some(folder.path().to_str().unwrap())),
                (usual, None),
            ])),
            ..raw("/usr/local/bin/claude")
        })
        .unwrap()
        .unwrap();
        let lane = Lane::new(grant);
        lane.keep_program(Ok(ProgramFacts::of(MIN_SUPPORTED_VERSION)));
        assert!(lane.publish());
        let mut updates = lane.subscribe();
        updates.borrow_and_update();
        let resets_at = chrono::Utc::now().timestamp() + 3_600;
        let hold = lane
            .hold_for_plan_limit(work, Some(resets_at))
            .expect("a hold");
        assert_eq!(lane.plan_limit_hold(work), Some(hold));
        assert_eq!(lane.plan_limit_hold(usual), None);
        assert!(updates.has_changed().unwrap());
        let capability = updates.borrow_and_update().clone().expect("published");
        assert_eq!(capability["ready"], true);
        assert_eq!(
            capability["logins"][work.to_string()],
            json!({
                "ready": false,
                "reason": "plan_limit",
                "resetsAt": hold.resets_at_rfc3339(),
                "planSignIn": false,
            })
        );
        assert_eq!(
            capability["logins"][usual.to_string()],
            json!({ "ready": true, "planSignIn": false })
        );
        assert_eq!(
            lane.hold_for_plan_limit(Uuid::new_v4(), Some(resets_at)),
            None
        );
        assert_eq!(
            lane.hold_for_plan_limit(usual, Some(resets_at - 7_200)),
            None
        );
        assert!(!updates.has_changed().unwrap());
        assert_eq!(
            lane.state.lock().reprobe_due(chrono::Utc::now()),
            Reprobe::Nothing
        );
        let left = lane.until_a_hold_ends().expect("a hold to wait for");
        assert!(left > Duration::from_secs(3_500) && left <= Duration::from_secs(3_600));
        // A held login's probe runs nothing and says it is held.
        assert!(matches!(lane.probe(work).await, Readiness::Held(found) if found == hold));
        assert_eq!(
            lane.probe(Uuid::new_v4()).await.reason(),
            Some(NotReadyReason::BinaryUnsafe)
        );
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
