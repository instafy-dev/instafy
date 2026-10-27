//! Skill packs the runtime ships once for every space instead of once per space.
//!
//! A skill pack is a skill with its own scripts, references and templates (for example a site
//! builder with a vendored engine, a few MB). `scripts/install-skill-packs.mjs` installs the packs
//! pinned in `skill-packs.json`, each checked against its release's sha256, commit and content
//! hash. Each space then gets only a small managed `SKILL.md` and, for a pack with a command, a
//! launcher (`jobs::runtime_pack_files`); both find the pack through `INSTAFY_SKILL_PACKS_DIR`,
//! which this module exports before any model process starts.
//!
//! Where packs live, in the order they are looked for:
//! - `INSTAFY_SKILL_PACKS_DIR`, when it holds a pack;
//! - container images: `/opt/instafy/skill-packs` (`docker/runtime/Dockerfile`);
//! - packaged Desktop runtimes: `skill-packs/` next to the `runtime-agent` binary, or
//!   `../share/instafy/skill-packs`;
//! - debug builds run from this checkout: the crate's `assets/skill-packs`
//!   (`pnpm skill-packs:install`). Release builds never look there.
//!
//! Each pack folder holds `.instafy-pack.json`:
//! `{"schema": 1, "name", "version", "skill" | "skills": [..], "cli": {"entry", "space_path"} | "entry",
//!   "engines": {"node": ">=22"}, "env": ["UW_*", "SOME_SETTING"], "bin": {"uw": "scripts/uw.mjs"}, ...}`.
//! A pack whose manifest does not parse or check out is skipped with a warning.
//!
//! Commands on PATH: `bin` names the pack's commands (at most 8, plain names that are not reserved),
//! each a file inside the pack that `node` runs. Model shells are login shells, which may reset PATH,
//! so runtime images carry a shim per command in `/usr/local/bin` (`scripts/install-skill-packs.mjs
//! --install-root`, `docker/runtime/Dockerfile`). Elsewhere [`prepare_pack_bins`] writes the shims to
//! a folder of its own at startup and appends it to the end of PATH, so a pack command never shadows
//! another command. A name that is already a command is skipped, and a name two packs declare is
//! skipped for both.
//!
//! Settings and state:
//! - `env` names the settings the pack's scripts read: exact names, or prefixes ending in `_*`. A
//!   process the runtime starts with a cleared environment (an isolated tool worker) gets the
//!   runtime's own values of those names ([`pack_settings_environment`]), never a name that looks
//!   like a credential, an internal credential, or one the runtime owns. Patterns that could reach
//!   process or runtime configuration (`PATH`, `LD_*`, `NODE_*`, `INSTAFY_*` …) make the manifest
//!   invalid.
//! - [`SKILL_PACK_CACHE_DIR_ENV`] (`INSTAFY_CACHE_DIR`) is a folder per project that outlasts the turn
//!   ([`skill_pack_cache_dir`]): a pack keeps its caches, rate-limit holds and health state there
//!   instead of in a tool turn's HOME or TMPDIR, which may be new every turn.

pub mod activity;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Deserialize;
use tracing::{info, warn};

pub const SKILL_PACKS_DIR_ENV: &str = "INSTAFY_SKILL_PACKS_DIR";
pub const IMAGE_SKILL_PACKS_DIR: &str = "/opt/instafy/skill-packs";
pub const PACK_MANIFEST: &str = ".instafy-pack.json";
/// The folder per project, outside the workspace, where skill packs keep state across turns.
pub const SKILL_PACK_CACHE_DIR_ENV: &str = "INSTAFY_CACHE_DIR";
/// At most this many `env` patterns per pack.
const MAX_SETTING_PATTERNS: usize = 32;
/// Prefixes no pack setting may start with: process configuration and the runtime's own settings.
const RESERVED_SETTING_PREFIXES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMP",
    "TEMP",
    "TZ",
    "LANG",
    "LC_",
    "TERM",
    "PWD",
    "LD_",
    "DYLD_",
    "NODE_",
    "NPM_",
    "PYTHON",
    "RUBY",
    "PERL",
    "RUST",
    "CARGO",
    "DENO_",
    "V8_",
    "BASH",
    "ZDOT",
    "XDG_",
    "GIT_",
    "SSL_",
    "HTTP",
    "ALL_PROXY",
    "NO_PROXY",
    "PROXY",
    "CODEX",
    "OPENAI",
    "CONTROLLER",
    "RUNTIME",
    "ORIGIN",
    "WORKSPACE",
    "SUPABASE",
    "AWS_",
    "GITHUB",
    "GH_",
    "PROJECT_ID",
    "SPACE_ID",
    "CONVERSATION_ID",
    "INSTAFY",
];
/// Namespaces under `INSTAFY_` that are open to skill packs (settings several packs may share).
const PACK_SETTING_NAMESPACES: &[&str] = &["INSTAFY_LOOKUP_"];
/// At most this many commands (`bin`) per pack.
pub const MAX_PACK_BINS: usize = 8;
/// Command names no pack may declare: the runtime's own tools and the commands every shell needs
/// (`scripts/install-skill-packs.mjs` refuses the same names). The runtime image's helpers are
/// here too, because some reach `/usr/local/bin` after the pack commands do, and Codex's
/// `applypatch` alias, which the runtime puts on PATH only at startup: an image build cannot see
/// either, and a pack command must never take their place.
pub const RESERVED_BIN_NAMES: &[&str] = &[
    "instafy",
    "node",
    "npm",
    "npx",
    "pnpm",
    "pnpx",
    "yarn",
    "corepack",
    "git",
    "sh",
    "bash",
    "zsh",
    "dash",
    "env",
    "python",
    "python3",
    "pip",
    "codex",
    "runtime-agent",
    "curl",
    "wget",
    "sudo",
    "make",
    "applypatch",
    "rathole",
    "runtime-entrypoint",
    "browser-egress-proxy",
    "browser-webrtc-sender",
];
/// Name prefixes no pack command may start with: Codex's and Instafy's own commands
/// (`codex-linux-sandbox`, `codex-code-mode-host`, `codex-execve-wrapper`, ...).
pub const RESERVED_BIN_PREFIXES: &[&str] = &["codex-", "instafy-"];
/// The second line of every pack command shim, followed by ` <pack> <version>`.
pub const PACK_BIN_MARKER: &str = "# instafy:managed-pack-bin";
/// The name of the folder [`prepare_pack_bins`] makes, followed by `<pid>-` and a random suffix.
pub const PACK_BIN_DIR_PREFIX: &str = "instafy-pack-bin-";
#[cfg(debug_assertions)]
const SOURCE_SKILL_PACKS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/skill-packs");

/// A pack installed with this runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledPack {
    pub name: String,
    pub version: String,
    /// The pack's folder.
    pub dir: PathBuf,
    /// The pack's skill document, relative to `dir`.
    pub skill: String,
    /// The pack's command, when it has one.
    pub cli: Option<PackCli>,
    /// The Node.js versions the pack's scripts need.
    pub node: Option<NodeRequirement>,
    /// The settings the pack's scripts read (`env`): exact names or `PREFIX_*` patterns, checked.
    pub env: Vec<String>,
    /// The pack's commands on PATH (`bin`), by name.
    pub bin: Vec<PackBin>,
}

/// A command a pack puts on PATH: `name` runs `entry`, a file inside the pack, with `node`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackBin {
    pub name: String,
    pub entry: String,
}

/// A pack's command: `entry` inside the pack, run through a launcher written at `space_path`
/// inside the space's copy of the skill folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackCli {
    pub entry: String,
    pub space_path: String,
}

/// A Node.js version as `(major, minor, patch)`.
pub type NodeVersion = (u64, u64, u64);

/// `engines.node`: a lowest version (`>=22`, `>=22.11.0`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRequirement {
    pub minimum: NodeVersion,
}

impl NodeRequirement {
    pub fn parse(text: &str) -> Option<Self> {
        let version = text.trim().strip_prefix(">=")?.trim();
        Some(Self {
            minimum: parse_version(version)?,
        })
    }

    pub fn allows(&self, version: NodeVersion) -> bool {
        version >= self.minimum
    }
}

fn parse_version(text: &str) -> Option<NodeVersion> {
    let text = text.trim().trim_start_matches('v');
    let mut parts = text.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |part| part.parse().ok())?;
    let patch = parts
        .next()
        .map_or(Some(0), |part| part.split('-').next()?.parse().ok())?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    name: String,
    version: String,
    #[serde(default)]
    skill: Option<String>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    cli: Option<ManifestCli>,
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    engines: Option<ManifestEngines>,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    bin: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct ManifestCli {
    entry: String,
    #[serde(default)]
    space_path: Option<String>,
}

#[derive(Deserialize)]
struct ManifestEngines {
    #[serde(default)]
    node: Option<String>,
}

/// A pack name: lowercase letters, digits and dashes, as a skill folder name.
pub fn is_pack_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// A relative path that stays inside its folder and needs no quoting in a gitignore pattern.
fn is_plain_relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 256
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && !path.ends_with('/')
        && !path.contains("//")
}

/// A command name a pack may declare (`bin`): a lowercase letter, then 1 to 31 lowercase letters,
/// digits or dashes, not one of [`RESERVED_BIN_NAMES`] and not starting with one of
/// [`RESERVED_BIN_PREFIXES`].
pub fn is_pack_bin_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (2..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !RESERVED_BIN_NAMES.contains(&name)
        && !RESERVED_BIN_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// A setting pattern a pack may declare: `NAME` or `PREFIX_*` (upper-case letters, digits and `_`,
/// a prefix of at least 3 characters), outside process configuration and the runtime's own names.
pub fn is_pack_setting_pattern(pattern: &str) -> bool {
    let (name, wildcard) = match pattern.strip_suffix('*') {
        Some(prefix) => (prefix, true),
        None => (pattern, false),
    };
    let shaped = !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_uppercase()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && (!wildcard || (name.len() >= 3 && name.ends_with('_')));
    if !shaped {
        return false;
    }
    if let Some(namespace) = PACK_SETTING_NAMESPACES
        .iter()
        .find(|namespace| name.starts_with(**namespace))
    {
        // `INSTAFY_LOOKUP_*` or a name inside it; never a pattern wider than the namespace
        return name.len() >= namespace.len();
    }
    !RESERVED_SETTING_PREFIXES
        .iter()
        .any(|reserved| name.starts_with(reserved) || (wildcard && reserved.starts_with(name)))
}

/// A name that looks like a credential never passes as a pack setting, whatever a pack declares.
fn looks_like_credential(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "PASSPHRASE",
        "CREDENTIAL",
        "PRIVATE",
        "COOKIE",
        "SESSION",
        "APIKEY",
        "API_KEY",
        "_KEY_",
    ]
    .iter()
    .any(|word| upper.contains(word))
        || upper.ends_with("_KEY")
        || upper == "KEY"
        // whole words only: `UW_OVERPASS` is a setting, `SMTP_PASS` is not
        || upper
            .split('_')
            .any(|word| matches!(word, "PASS" | "PWD" | "AUTH" | "BEARER" | "DSN"))
}

fn setting_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix) && name.len() > prefix.len(),
        None => name == pattern,
    }
}

/// Whether `name` is a setting one of `packs` declares and may receive from the runtime.
pub fn is_pack_setting(packs: &[InstalledPack], name: &str) -> bool {
    name != SKILL_PACK_CACHE_DIR_ENV
        && !looks_like_credential(name)
        && !crate::model_environment::is_model_child_excluded_env_key(name)
        && packs
            .iter()
            .flat_map(|pack| pack.env.iter())
            .any(|pattern| setting_matches(pattern, name))
}

/// The runtime's own values of the settings `packs` declare, from `vars` (the runtime's
/// environment), for a process started with a cleared environment.
pub fn pack_settings_environment(
    packs: &[InstalledPack],
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(key, value)| {
            key.to_str()
                .is_some_and(|name| is_pack_setting(packs, name))
                && value
                    .to_str()
                    .is_some_and(|value| !value_carries_credentials(value))
        })
        .collect()
}

/// A value with a credential inside it (a URL with `user:password@`, a `token=`/`key=` query
/// parameter, a bearer header) never passes as a pack setting, whatever its name.
fn value_carries_credentials(value: &str) -> bool {
    let userinfo = value.match_indices("://").any(|(at, _)| {
        value[at + 3..]
            .split(|c: char| {
                matches!(c, '/' | '?' | '#' | ',' | ';' | '"' | '\'') || c.is_whitespace()
            })
            .next()
            .is_some_and(|authority| authority.contains('@'))
    });
    let lower = value.to_ascii_lowercase();
    userinfo
        || lower.contains("bearer ")
        || [
            "token=",
            "key=",
            "secret=",
            "password=",
            "passwd=",
            "pass=",
            "auth=",
            "signature=",
            "sig=",
        ]
        .iter()
        .any(|param| {
            lower
                .match_indices(param)
                .any(|(at, _)| at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric())
        })
        || lower.contains("_key=")
        || lower.contains("-key=")
        || lower.contains("apikey=")
}

/// The folder where skill packs keep state for `project_id` on this runtime: outside the project's
/// workspace (nothing in it is ever saved or published) and kept across turns.
pub fn skill_pack_cache_dir(workspace_root: &Path, project_id: &uuid::Uuid) -> PathBuf {
    workspace_root
        .join(".instafy")
        .join("skill-pack-cache")
        .join(project_id.to_string())
}

/// Creates [`skill_pack_cache_dir`] (private to the runtime's user) and returns it.
pub fn prepare_skill_pack_cache_dir(
    workspace_root: &Path,
    project_id: &uuid::Uuid,
) -> std::io::Result<PathBuf> {
    let dir = skill_pack_cache_dir(workspace_root, project_id);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

/// Reads and checks one pack folder.
pub fn load_pack(dir: &Path) -> Result<InstalledPack, String> {
    let folder = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("the pack folder has no name")?;
    let manifest_path = dir.join(PACK_MANIFEST);
    if !is_regular_file(&manifest_path) {
        return Err(format!("no {PACK_MANIFEST}"));
    }
    let raw = std::fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|error| format!("{PACK_MANIFEST} does not parse: {error}"))?;
    if manifest.schema != 1 {
        return Err(format!(
            "{PACK_MANIFEST} schema {} is not 1",
            manifest.schema
        ));
    }
    if !is_pack_name(&manifest.name) {
        return Err(format!("{:?} is not a pack name", manifest.name));
    }
    if manifest.name != folder {
        return Err(format!(
            "{PACK_MANIFEST} names {:?} but the folder is {folder:?}",
            manifest.name
        ));
    }
    let skill = manifest
        .skill
        .clone()
        .or_else(|| manifest.skills.first().cloned())
        .ok_or("the manifest names no skill")?;
    if !is_plain_relative_path(&skill) || !is_regular_file(&dir.join(&skill)) {
        return Err(format!("the skill {skill:?} is not a file inside the pack"));
    }
    let cli = match (manifest.cli, manifest.entry) {
        (Some(cli), _) => Some(PackCli {
            space_path: cli.space_path.unwrap_or_else(|| cli.entry.clone()),
            entry: cli.entry,
        }),
        (None, Some(entry)) => Some(PackCli {
            space_path: entry.clone(),
            entry,
        }),
        (None, None) => None,
    };
    if let Some(cli) = &cli {
        if !is_plain_relative_path(&cli.entry) || !is_regular_file(&dir.join(&cli.entry)) {
            return Err(format!(
                "the command {:?} is not a file inside the pack",
                cli.entry
            ));
        }
        if !is_plain_relative_path(&cli.space_path) || cli.space_path == skill {
            return Err(format!(
                "the launcher path {:?} must be a relative path other than the skill",
                cli.space_path
            ));
        }
    }
    if manifest.env.len() > MAX_SETTING_PATTERNS {
        return Err(format!(
            "env lists more than {MAX_SETTING_PATTERNS} settings"
        ));
    }
    if let Some(bad) = manifest
        .env
        .iter()
        .find(|pattern| !is_pack_setting_pattern(pattern))
    {
        return Err(format!(
            "env {bad:?} is not a setting a pack may declare (NAME or PREFIX_*, outside process and runtime settings)"
        ));
    }
    let node = match manifest.engines.and_then(|engines| engines.node) {
        Some(text) => Some(
            NodeRequirement::parse(&text)
                .ok_or_else(|| format!("engines.node {text:?} is not `>=<version>`"))?,
        ),
        None => None,
    };
    if manifest.bin.len() > MAX_PACK_BINS {
        return Err(format!("bin lists more than {MAX_PACK_BINS} commands"));
    }
    let mut bin = Vec::with_capacity(manifest.bin.len());
    for (name, entry) in manifest.bin {
        if !is_pack_bin_name(&name) {
            return Err(format!(
                "bin {name:?} is not a command a pack may declare (a-z, 0-9 and -, 2 to 32 characters, not a reserved name)"
            ));
        }
        if !is_plain_relative_path(&entry) || !is_regular_file(&dir.join(&entry)) {
            return Err(format!(
                "the command {name:?} runs {entry:?}, which is not a file inside the pack"
            ));
        }
        bin.push(PackBin { name, entry });
    }
    Ok(InstalledPack {
        name: manifest.name,
        version: manifest.version,
        dir: dir.to_path_buf(),
        skill,
        cli,
        node,
        env: manifest.env,
        bin,
    })
}

/// Every pack in `root`, by name. Folders that are not valid packs are skipped with a warning.
pub fn list_packs(root: &Path) -> Vec<InstalledPack> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut packs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with('.') || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        match load_pack(&path) {
            Ok(pack) => packs.push(pack),
            Err(error) => {
                warn!(pack = name, %error, "skipping a skill pack that does not check out")
            }
        }
    }
    packs.sort_by(|a, b| a.name.cmp(&b.name));
    packs
}

/// A folder holding at least one pack whose manifest checks out.
fn contains_a_pack(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| load_pack(&entry.path()).is_ok())
    })
}

/// The first folder holding a pack, in the order the module docs list.
pub fn resolve_skill_packs_dir() -> Option<PathBuf> {
    let configured = std::env::var_os(SKILL_PACKS_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    resolve_from_candidates(configured, exe_dir.as_deref(), source_dir())
}

#[cfg(debug_assertions)]
fn source_dir() -> Option<PathBuf> {
    Some(PathBuf::from(SOURCE_SKILL_PACKS_DIR))
}

/// Release builds never look in the build machine's checkout.
#[cfg(not(debug_assertions))]
fn source_dir() -> Option<PathBuf> {
    None
}

fn resolve_from_candidates(
    configured: Option<PathBuf>,
    exe_dir: Option<&Path>,
    source: Option<PathBuf>,
) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.extend(configured);
    candidates.push(PathBuf::from(IMAGE_SKILL_PACKS_DIR));
    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join("skill-packs"));
        candidates.push(exe_dir.join("../share/instafy/skill-packs"));
    }
    candidates.extend(source);
    candidates.into_iter().find(|dir| contains_a_pack(dir))
}

/// The packs installed with this runtime, read once.
pub fn installed_packs() -> &'static [InstalledPack] {
    static PACKS: OnceLock<Vec<InstalledPack>> = OnceLock::new();
    PACKS.get_or_init(|| {
        resolve_skill_packs_dir()
            .map(|dir| list_packs(&dir))
            .unwrap_or_default()
    })
}

/// The version of `node` on this runtime's PATH, read once.
pub fn node_on_path() -> Option<NodeVersion> {
    static NODE: OnceLock<Option<NodeVersion>> = OnceLock::new();
    *NODE.get_or_init(|| {
        let output = Command::new("node").arg("--version").output().ok()?;
        output
            .status
            .success()
            .then(|| parse_version(String::from_utf8_lossy(&output.stdout).trim()))
            .flatten()
    })
}

/// Exports the resolved folder as `INSTAFY_SKILL_PACKS_DIR` for every process the runtime starts
/// (model shells inherit it). Leaves the environment alone when no pack is installed, so a launcher
/// reports "not installed" instead of using a wrong path.
///
/// # Safety
///
/// Mutates the process environment, so it must run before the process starts other threads.
pub unsafe fn export_skill_packs_dir_env() -> Option<PathBuf> {
    let dir = resolve_skill_packs_dir()?;
    let dir = dir.canonicalize().unwrap_or(dir);
    // SAFETY: the caller guarantees that no other thread reads or writes the environment.
    unsafe { std::env::set_var(SKILL_PACKS_DIR_ENV, &dir) };
    Some(dir)
}

/// Logs the packs this runtime gives every space.
pub fn report_startup() {
    let packs = installed_packs();
    if packs.is_empty() {
        info!("no skill packs installed with this runtime");
        return;
    }
    let node = node_on_path();
    for pack in packs {
        let runnable = pack
            .node
            .as_ref()
            .is_none_or(|requirement| node.is_some_and(|version| requirement.allows(version)));
        if runnable {
            info!(pack = %pack.name, version = %pack.version, dir = %pack.dir.display(), "skill pack installed");
        } else {
            warn!(
                pack = %pack.name,
                version = %pack.version,
                node = ?node,
                "skill pack installed, but no matching node is on PATH; spaces will not get it"
            );
        }
    }
}

/// The commands `packs` declare, each with its pack, in pack and name order. A name two packs
/// declare is left out for both, with a warning: neither pack may take it from the other.
pub fn declared_pack_bins(packs: &[InstalledPack]) -> Vec<(&InstalledPack, &PackBin)> {
    let mut owners: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for pack in packs {
        for bin in &pack.bin {
            owners.entry(&bin.name).or_default().push(&pack.name);
        }
    }
    for (name, packs) in &owners {
        if packs.len() > 1 {
            warn!(command = %name, packs = ?packs, "skill pack command declared by more than one pack; none of them gets it");
        }
    }
    packs
        .iter()
        .flat_map(|pack| pack.bin.iter().map(move |bin| (pack, bin)))
        .filter(|(_, bin)| {
            owners
                .get(bin.name.as_str())
                .is_some_and(|packs| packs.len() == 1)
        })
        .collect()
}

/// The marker line of `pack`'s command shims.
fn pack_bin_marker(pack: &InstalledPack) -> String {
    format!("{PACK_BIN_MARKER} {} {}", pack.name, pack.version)
}

/// The shell script that runs `bin` with `node`: `#!/bin/sh`, the marker line, then `exec node
/// '<pack folder>/<entry>' "$@"`. `None` when the path or version cannot be written into it as
/// plain text (a quote or a control character).
pub fn pack_bin_shim(pack: &InstalledPack, bin: &PackBin) -> Option<String> {
    let target = pack.dir.join(&bin.entry);
    let target = target.to_str()?;
    let plain_path =
        target.starts_with('/') && !target.chars().any(|c| c == '\'' || c.is_control());
    let plain_version = !pack.version.is_empty()
        && pack
            .version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'));
    (plain_path && plain_version).then(|| {
        format!(
            "#!/bin/sh\n{}\nexec node '{target}' \"$@\"\n",
            pack_bin_marker(pack)
        )
    })
}

/// The `(pack, command)` pairs a shell finds on PATH, set once by [`prepare_pack_bins`].
static LINKED_PACK_BINS: OnceLock<Vec<(String, String)>> = OnceLock::new();

/// The commands of the pack named `pack` that a shell finds on PATH (none before
/// [`prepare_pack_bins`] has run).
pub fn linked_pack_bins(pack: &str) -> Vec<String> {
    LINKED_PACK_BINS
        .get()
        .map(|linked| {
            linked
                .iter()
                .filter(|(owner, _)| owner == pack)
                .map(|(_, name)| name.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// What [`prepare_pack_bins_in`] did.
#[derive(Debug)]
pub struct PreparedPackBins {
    /// `(pack, command)` for every pack command a shell now finds on PATH: a shim this call wrote,
    /// or one already on PATH with the same marker (a runtime image's).
    pub linked: Vec<(String, String)>,
    /// PATH for the runtime's processes: the one given, with the new folder at its end when one
    /// was made.
    pub path: OsString,
    /// The folder of shims this call made, removed when it is dropped.
    pub dir: Option<tempfile::TempDir>,
}

/// Puts the commands of `packs` on `path`: a command whose name already resolves to a shim with the
/// same marker (a runtime image's) is kept; a name that resolves to anything else is skipped with a
/// warning; the rest get a shim in a new folder under `temp_root` (mode 0755, shims 0555), which
/// must let programs run, appended to the end of `path`. A pack whose scripts need a newer `node`
/// than `node` gets none.
#[cfg(unix)]
pub fn prepare_pack_bins_in(
    packs: &[InstalledPack],
    node: Option<NodeVersion>,
    temp_root: &Path,
    path: &std::ffi::OsStr,
) -> PreparedPackBins {
    let mut linked = Vec::new();
    let mut wanted: Vec<(&InstalledPack, &PackBin, String)> = Vec::new();
    for (pack, bin) in declared_pack_bins(packs) {
        let runnable = pack
            .node
            .as_ref()
            .is_none_or(|requirement| node.is_some_and(|version| requirement.allows(version)));
        if !runnable {
            warn!(pack = %pack.name, command = %bin.name, "skill pack command not put on PATH: no matching node on PATH");
            continue;
        }
        match find_command(&bin.name, path) {
            Some(found) if second_line(&found).as_deref() == Some(&pack_bin_marker(pack)) => {
                linked.push((pack.name.clone(), bin.name.clone()));
            }
            Some(found) => warn!(
                pack = %pack.name,
                command = %bin.name,
                found = %found.display(),
                "skill pack command not put on PATH: that name is already a command"
            ),
            None => match pack_bin_shim(pack, bin) {
                Some(shim) => wanted.push((pack, bin, shim)),
                None => warn!(
                    pack = %pack.name,
                    command = %bin.name,
                    "skill pack command not put on PATH: the pack's path cannot be written into a shim"
                ),
            },
        }
    }
    let unchanged = |linked| PreparedPackBins {
        linked,
        path: path.to_os_string(),
        dir: None,
    };
    if wanted.is_empty() {
        return unchanged(linked);
    }
    if path.is_empty() {
        warn!("skill pack commands not put on PATH: PATH is empty");
        return unchanged(linked);
    }
    let dir = match write_pack_bin_dir(temp_root, &wanted) {
        Ok(dir) => dir,
        Err(error) => {
            warn!(%error, "skill pack commands not put on PATH: could not make a folder for them");
            return unchanged(linked);
        }
    };
    let joined = std::env::join_paths(
        std::env::split_paths(path).chain(std::iter::once(dir.path().to_path_buf())),
    );
    match joined {
        Ok(joined) => {
            linked.extend(
                wanted
                    .iter()
                    .map(|(pack, bin, _)| (pack.name.clone(), bin.name.clone())),
            );
            PreparedPackBins {
                linked,
                path: joined,
                dir: Some(dir),
            }
        }
        Err(error) => {
            warn!(%error, "skill pack commands not put on PATH: their folder cannot join PATH");
            unchanged(linked)
        }
    }
}

/// The first executable file named `name` in the absolute folders of `path`.
#[cfg(unix)]
fn find_command(name: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| {
            std::fs::metadata(candidate).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
}

/// The second line of a small file (a shim's marker line).
#[cfg(unix)]
fn second_line(file: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = Vec::new();
    std::fs::File::open(file)
        .ok()?
        .take(1024)
        .read_to_end(&mut head)
        .ok()?;
    let text = String::from_utf8_lossy(&head);
    text.lines().nth(1).map(str::to_owned)
}

/// Makes `<temp_root>/instafy-pack-bin-<pid>-<random>` with one shim per wanted command, after
/// checking that a program in it runs (a temp folder mounted `noexec` cannot hold commands).
#[cfg(unix)]
fn write_pack_bin_dir(
    temp_root: &Path,
    wanted: &[(&InstalledPack, &PackBin, String)],
) -> std::io::Result<tempfile::TempDir> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let dir = tempfile::Builder::new()
        .prefix(&format!("{PACK_BIN_DIR_PREFIX}{}-", std::process::id()))
        .tempdir_in(temp_root)?;
    let write = |name: &str, content: &str| -> std::io::Result<PathBuf> {
        let file = dir.path().join(name);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o555)
            .open(&file)?
            .write_all(content.as_bytes())?;
        Ok(file)
    };
    let probe = write(".exec-probe", "#!/bin/sh\nexit 0\n")?;
    let ran = run_probe(&probe);
    std::fs::remove_file(&probe)?;
    if !ran {
        return Err(std::io::Error::other(format!(
            "programs cannot run from {}",
            temp_root.display()
        )));
    }
    for (_, bin, shim) in wanted {
        write(&bin.name, shim)?;
    }
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755))?;
    Ok(dir)
}

/// Runs the probe, retrying while another process still holds it open for writing (a fork in
/// another thread between our write and exec), which only test runs see.
#[cfg(unix)]
fn run_probe(probe: &Path) -> bool {
    for _ in 0..20 {
        match Command::new(probe)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(status) => return status.success(),
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return false,
        }
    }
    false
}

/// Removes the folders [`prepare_pack_bins`] left in `temp_root` (a runtime that did not exit
/// cleanly): owned by this user, not a link, older than a day, and made by a process that is gone.
#[cfg(unix)]
pub fn remove_stale_pack_bin_dirs(temp_root: &Path, now: std::time::SystemTime) {
    use std::os::unix::fs::MetadataExt;
    const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let Ok(entries) = std::fs::read_dir(temp_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(rest) = name
            .to_str()
            .and_then(|name| name.strip_prefix(PACK_BIN_DIR_PREFIX))
        else {
            continue;
        };
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let old = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_AFTER);
        let owner_alive = rest
            .split('-')
            .next()
            .and_then(|pid| pid.parse::<libc::pid_t>().ok())
            .filter(|pid| *pid > 0)
            // SAFETY: signal 0 only checks that the process exists.
            .is_some_and(|pid| unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM));
        if metadata.is_dir() && metadata.uid() == uid && old && !owner_alive {
            if let Err(error) = std::fs::remove_dir_all(&path) {
                warn!(%error, dir = %path.display(), "could not remove a stale skill pack command folder");
            }
        }
    }
}

/// Puts the installed packs' commands on PATH for every process the runtime starts
/// ([`prepare_pack_bins_in`] with the runtime's temp folder and PATH), records which a shell finds
/// ([`linked_pack_bins`]) and returns the folder to keep while the runtime runs; it is removed when
/// dropped. Stale folders from earlier runs are removed first. Windows gets no shims.
///
/// # Safety
///
/// Mutates the process environment, so it must run before the process starts other threads.
pub unsafe fn prepare_pack_bins() -> Option<tempfile::TempDir> {
    #[cfg(unix)]
    {
        let temp_root = std::env::temp_dir();
        remove_stale_pack_bin_dirs(&temp_root, std::time::SystemTime::now());
        let path = std::env::var_os("PATH").unwrap_or_default();
        let prepared = prepare_pack_bins_in(installed_packs(), node_on_path(), &temp_root, &path);
        for (pack, name) in &prepared.linked {
            info!(pack = %pack, command = %name, "skill pack command on PATH");
        }
        let _ = LINKED_PACK_BINS.set(prepared.linked);
        if prepared.dir.is_some() {
            // SAFETY: the caller guarantees that no other thread reads or writes the environment.
            unsafe { std::env::set_var("PATH", &prepared.path) };
        }
        prepared.dir
    }
    #[cfg(not(unix))]
    {
        let _ = LINKED_PACK_BINS.set(Vec::new());
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    /// A pack folder `<root>/<name>` with a SKILL.md, an optional command and a manifest.
    pub(crate) fn make_pack(root: &Path, name: &str, with_cli: bool) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(dir.join("scripts")).expect("pack dir");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: a test pack\n---\n\n# {name}\n\nRun it.\n"),
        )
        .expect("skill");
        let mut manifest = serde_json::json!({
            "schema": 1,
            "name": name,
            "version": "0.1.0",
            "skills": ["SKILL.md"],
            "engines": {"node": ">=22"},
        });
        if with_cli {
            fs::write(dir.join("scripts/run.mjs"), "console.log('pack');\n").expect("cli");
            manifest["entry"] = serde_json::json!("scripts/run.mjs");
        }
        fs::write(dir.join(PACK_MANIFEST), manifest.to_string()).expect("manifest");
        dir
    }

    #[test]
    fn configured_directory_wins_when_it_holds_a_pack() {
        let configured = tempfile::tempdir().expect("tmp");
        let exe = tempfile::tempdir().expect("tmp");
        make_pack(configured.path(), "demo", true);
        make_pack(&exe.path().join("skill-packs"), "demo", true);
        assert_eq!(
            resolve_from_candidates(
                Some(configured.path().to_path_buf()),
                Some(exe.path()),
                None
            ),
            Some(configured.path().to_path_buf())
        );
    }

    #[test]
    fn falls_back_past_folders_without_a_valid_pack_to_the_binary_folder() {
        let configured = tempfile::tempdir().expect("tmp");
        fs::write(configured.path().join("README.md"), "no packs").expect("readme");
        // A SKILL.md alone is not a pack.
        fs::create_dir_all(configured.path().join("loose")).expect("loose");
        fs::write(configured.path().join("loose/SKILL.md"), "---\n---\n").expect("skill");
        let exe = tempfile::tempdir().expect("tmp");
        make_pack(&exe.path().join("skill-packs"), "demo", false);
        let resolved = resolve_from_candidates(
            Some(configured.path().to_path_buf()),
            Some(exe.path()),
            None,
        );
        if contains_a_pack(Path::new(IMAGE_SKILL_PACKS_DIR)) {
            // Inside a runtime image the baked-in packs come before the binary folder.
            assert!(resolved.is_some());
        } else {
            assert_eq!(resolved, Some(exe.path().join("skill-packs")));
        }
    }

    #[test]
    fn the_published_manifest_shape_loads() {
        let root = tempfile::tempdir().expect("tmp");
        let dir = make_pack(root.path(), "demo", true);
        let pack = load_pack(&dir).expect("pack");
        assert_eq!(pack.name, "demo");
        assert_eq!(pack.version, "0.1.0");
        assert_eq!(pack.skill, "SKILL.md");
        assert_eq!(
            pack.cli,
            Some(PackCli {
                entry: "scripts/run.mjs".into(),
                space_path: "scripts/run.mjs".into()
            })
        );
        assert_eq!(pack.node, NodeRequirement::parse(">=22"));
        assert!(pack.node.as_ref().unwrap().allows((22, 0, 0)));
        assert!(!pack.node.as_ref().unwrap().allows((20, 18, 1)));
    }

    #[test]
    fn manifest_with_mismatched_name_is_skipped() {
        let root = tempfile::tempdir().expect("tmp");
        let dir = make_pack(root.path(), "demo", false);
        fs::rename(&dir, root.path().join("renamed")).expect("rename");
        assert!(
            load_pack(&root.path().join("renamed"))
                .unwrap_err()
                .contains("names \"demo\"")
        );
        make_pack(root.path(), "kept", false);
        let names: Vec<String> = list_packs(root.path())
            .into_iter()
            .map(|pack| pack.name)
            .collect();
        assert_eq!(names, vec!["kept".to_string()]);
    }

    #[test]
    fn manifest_paths_must_stay_inside_the_pack() {
        let root = tempfile::tempdir().expect("tmp");
        let dir = make_pack(root.path(), "demo", false);
        for (skill, entry) in [
            ("../SKILL.md", None),
            ("/etc/passwd", None),
            ("SKILL.md", Some("../../bin/sh")),
            ("SKILL.md", Some("scripts/missing.mjs")),
            ("missing.md", None),
        ] {
            let mut manifest = serde_json::json!({
                "schema": 1, "name": "demo", "version": "0.1.0", "skill": skill,
            });
            if let Some(entry) = entry {
                manifest["cli"] = serde_json::json!({"entry": entry});
            }
            fs::write(dir.join(PACK_MANIFEST), manifest.to_string()).expect("manifest");
            assert!(load_pack(&dir).is_err(), "{skill} {entry:?}");
        }
        fs::write(dir.join(PACK_MANIFEST), "{not json").expect("manifest");
        assert!(load_pack(&dir).unwrap_err().contains("does not parse"));
    }

    #[test]
    fn pack_without_cli_is_listed_without_a_launcher() {
        let root = tempfile::tempdir().expect("tmp");
        make_pack(root.path(), "docs-only", false);
        let packs = list_packs(root.path());
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].cli, None);
    }

    #[test]
    fn release_build_ignores_crate_assets() {
        #[cfg(debug_assertions)]
        assert_eq!(source_dir(), Some(PathBuf::from(SOURCE_SKILL_PACKS_DIR)));
        #[cfg(not(debug_assertions))]
        assert_eq!(source_dir(), None);
        // Without the source fallback, nothing in the checkout is found.
        assert!(
            resolve_from_candidates(None, None, None).is_none()
                || contains_a_pack(Path::new(IMAGE_SKILL_PACKS_DIR))
        );
    }

    #[test]
    fn a_pack_declares_the_settings_it_reads_and_nothing_wider() {
        for good in [
            "UW_*",
            "UW_PHOTON",
            "INSTAFY_LOOKUP_*",
            "INSTAFY_LOOKUP_PROVIDERS",
            "MAPS_TILE_URL",
        ] {
            assert!(is_pack_setting_pattern(good), "{good}");
        }
        for bad in [
            "",
            "*",
            "uw_*",
            "UW*",
            "U_*",
            "UW_PHOTON*",
            "PATH",
            "HOME",
            "LD_*",
            "LD_PRELOAD",
            "DYLD_*",
            "NODE_OPTIONS",
            "NODE_*",
            "XDG_*",
            "GIT_*",
            "HTTPS_PROXY",
            "OPENAI_API_KEY",
            "CODEX_*",
            "CONTROLLER_*",
            "INSTAFY_*",
            "INSTAFY_TURN_*",
            "INSTAFY_CACHE_DIR",
            "INSTAFY_SKILL_PACKS_DIR",
            "INSTAFY_LOOKUP*",
            "I_*",
            "A-B",
        ] {
            assert!(!is_pack_setting_pattern(bad), "{bad}");
        }
        let root = tempfile::tempdir().expect("tmp");
        let dir = make_pack(root.path(), "demo", true);
        let manifest_with = |env: serde_json::Value| {
            let mut manifest: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(dir.join(PACK_MANIFEST)).unwrap())
                    .unwrap();
            manifest["env"] = env;
            fs::write(dir.join(PACK_MANIFEST), manifest.to_string()).expect("manifest");
        };
        manifest_with(serde_json::json!(["UW_*", "INSTAFY_LOOKUP_*"]));
        assert_eq!(
            load_pack(&dir).expect("pack").env,
            vec!["UW_*", "INSTAFY_LOOKUP_*"]
        );
        manifest_with(serde_json::json!(["UW_*", "LD_PRELOAD"]));
        assert!(load_pack(&dir).unwrap_err().contains("LD_PRELOAD"));
    }

    #[test]
    fn only_declared_non_secret_settings_pass_to_a_cleared_environment() {
        let root = tempfile::tempdir().expect("tmp");
        let mut pack = load_pack(&make_pack(root.path(), "demo", true)).expect("pack");
        let vars = || {
            [
                ("PATH", "/bin"),
                ("UW_PHOTON", "https://photon.example"),
                ("UW_OVERPASS", "https://overpass.example/api?monkey=1"),
                ("UW_TURN_BUDGET", "0"),
                ("INSTAFY_LOOKUP_PROVIDERS", "{}"),
                ("UW_API_KEY", "x"),
                ("UW_SECRET", "x"),
                ("UW_SMTP_PASS", "x"),
                ("UW_BASIC_AUTH", "x"),
                ("UW_SENTRY_DSN", "x"),
                ("UW_GATEWAY", "https://user:hunter2@gateway.example/v1"),
                (
                    "UW_TILES",
                    "https://tiles.example/{z}/{x}/{y}.png?api_key=abc",
                ),
                (
                    "INSTAFY_LOOKUP_PROVIDERS_URL",
                    "https://p.example/x?token=abc",
                ),
                ("INSTAFY_LOOKUP_TOKEN", "x"),
                ("INSTAFY_TURN_DEADLINE", "2026-10-26T10:00:00Z"),
                ("INSTAFY_CACHE_DIR", "/elsewhere"),
                ("OPENAI_API_KEY", "x"),
                ("CONTROLLER_TOKEN", "x"),
            ]
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
        };
        let names = |packs: &[InstalledPack]| -> Vec<String> {
            pack_settings_environment(packs, vars())
                .into_iter()
                .map(|(key, _)| key.into_string().unwrap())
                .collect()
        };
        assert!(
            names(std::slice::from_ref(&pack)).is_empty(),
            "a pack that declares nothing gets nothing"
        );
        pack.env = vec!["UW_*".into(), "INSTAFY_LOOKUP_*".into()];
        assert_eq!(
            names(std::slice::from_ref(&pack)),
            [
                "UW_PHOTON",
                "UW_OVERPASS",
                "UW_TURN_BUDGET",
                "INSTAFY_LOOKUP_PROVIDERS"
            ]
        );
    }

    #[test]
    fn each_project_has_its_own_skill_pack_folder_outside_its_workspace() {
        let root = tempfile::tempdir().expect("tmp");
        let (one, two) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let dir = prepare_skill_pack_cache_dir(root.path(), &one).expect("dir");
        assert!(dir.is_dir());
        assert_eq!(dir, skill_pack_cache_dir(root.path(), &one));
        assert!(
            !dir.starts_with(root.path().join(one.to_string())),
            "not inside the project's workspace"
        );
        assert_ne!(dir, skill_pack_cache_dir(root.path(), &two));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn node_versions_parse() {
        assert_eq!(parse_version("v22.11.0"), Some((22, 11, 0)));
        assert_eq!(parse_version("24"), Some((24, 0, 0)));
        assert_eq!(parse_version("v25.0.0-nightly"), Some((25, 0, 0)));
        assert_eq!(parse_version("node"), None);
        assert_eq!(NodeRequirement::parse("^22"), None);
    }

    /// A Node.js version the test packs accept (they need `>=22`): tests that run a pack command
    /// prepare it for this version, whatever `node` the machine has.
    pub(crate) const TEST_PACK_NODE: NodeVersion = (22, 0, 0);

    /// Rewrites `dir`'s manifest with `bin`.
    pub(crate) fn declare_bin(dir: &Path, bin: serde_json::Value) {
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(PACK_MANIFEST)).unwrap()).unwrap();
        manifest["bin"] = bin;
        fs::write(dir.join(PACK_MANIFEST), manifest.to_string()).expect("manifest");
    }

    /// A pack `<root>/<name>` whose command `command` prints what it ran with.
    pub(crate) fn pack_with_command(root: &Path, name: &str, command: &str) -> InstalledPack {
        let dir = make_pack(root, name, true);
        fs::write(
            dir.join("scripts/run.mjs"),
            format!("console.log('{name} ran', process.argv.slice(2).join(' '));\n"),
        )
        .expect("entry");
        declare_bin(&dir, serde_json::json!({ command: "scripts/run.mjs" }));
        load_pack(&dir).expect("pack")
    }

    #[cfg(unix)]
    fn executable(dir: &Path, name: &str, content: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(dir).unwrap();
        let file = dir.join(name);
        fs::write(&file, content).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        file
    }

    #[test]
    fn a_bin_entry_must_be_a_file_inside_the_pack() {
        let root = tempfile::tempdir().expect("tmp");
        let dir = make_pack(root.path(), "demo", true);
        fs::write(root.path().join("outside.mjs"), "").unwrap();
        for entry in [
            "../outside.mjs",
            "/etc/passwd",
            "scripts/missing.mjs",
            "scripts",
            "scripts/../SKILL.md",
            "scripts/it's.mjs",
            "",
        ] {
            declare_bin(&dir, serde_json::json!({ "demo": entry }));
            let error = load_pack(&dir).unwrap_err();
            assert!(
                error.contains("not a file inside the pack"),
                "{entry}: {error}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                root.path().join("outside.mjs"),
                dir.join("scripts/link.mjs"),
            )
            .unwrap();
            declare_bin(&dir, serde_json::json!({ "demo": "scripts/link.mjs" }));
            assert!(
                load_pack(&dir).is_err(),
                "a link is not a file inside the pack"
            );
        }
        declare_bin(&dir, serde_json::json!(["scripts/run.mjs"]));
        assert!(load_pack(&dir).unwrap_err().contains("does not parse"));
        declare_bin(&dir, serde_json::json!({ "demo": "scripts/run.mjs" }));
        assert_eq!(
            load_pack(&dir).expect("pack").bin,
            vec![PackBin {
                name: "demo".into(),
                entry: "scripts/run.mjs".into()
            }]
        );
        // A manifest without `bin` declares no command.
        assert!(
            load_pack(&make_pack(root.path(), "plain", true))
                .unwrap()
                .bin
                .is_empty()
        );
    }

    #[test]
    fn a_bin_name_must_be_plain_and_unreserved() {
        for good in ["uw", "map-tool", "a1", &"x".repeat(32)] {
            assert!(is_pack_bin_name(good), "{good}");
        }
        for bad in [
            "",
            "u",
            "Uw",
            "1uw",
            "-uw",
            "uw_x",
            "uw x",
            "uw/x",
            "..",
            "uw.mjs",
            "üw",
            &"x".repeat(33),
            "node",
            "npx",
            "git",
            "instafy",
            "sh",
            "bash",
            "env",
            "codex",
            "runtime-agent",
            "sudo",
            // The runtime's helpers and Codex's commands, which an image build or a PATH check at
            // startup may not see yet.
            "applypatch",
            "rathole",
            "runtime-entrypoint",
            "browser-egress-proxy",
            "browser-webrtc-sender",
            "codex-linux-sandbox",
            "codex-code-mode-host",
            "codex-execve-wrapper",
            "instafy-helper",
        ] {
            assert!(!is_pack_bin_name(bad), "{bad}");
        }
        // Only the namespace is reserved, not every name that starts with the same letters.
        assert!(is_pack_bin_name("codexy"));
        let root = tempfile::tempdir().expect("tmp");
        let dir = make_pack(root.path(), "demo", true);
        declare_bin(&dir, serde_json::json!({ "node": "scripts/run.mjs" }));
        assert!(load_pack(&dir).unwrap_err().contains("\"node\""));
        let nine: serde_json::Map<String, serde_json::Value> = (0..9)
            .map(|index| (format!("cmd-{index}"), serde_json::json!("scripts/run.mjs")))
            .collect();
        declare_bin(&dir, serde_json::Value::Object(nine));
        assert!(
            load_pack(&dir)
                .unwrap_err()
                .contains("more than 8 commands")
        );
    }

    #[test]
    fn duplicate_bins_disable_both() {
        let root = tempfile::tempdir().expect("tmp");
        let one = pack_with_command(root.path(), "one", "demo");
        let two = pack_with_command(root.path(), "two", "demo");
        let mut three = pack_with_command(root.path(), "three", "other");
        three.bin.push(PackBin {
            name: "demo".into(),
            entry: "scripts/run.mjs".into(),
        });
        let names = |packs: &[InstalledPack]| -> Vec<(String, String)> {
            declared_pack_bins(packs)
                .into_iter()
                .map(|(pack, bin)| (pack.name.clone(), bin.name.clone()))
                .collect()
        };
        assert_eq!(
            names(std::slice::from_ref(&one)),
            [("one".into(), "demo".into())]
        );
        assert_eq!(
            names(&[one, two, three]),
            [("three".to_string(), "other".to_string())],
            "a name two packs declare goes to neither"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_bin_name_already_on_path_is_skipped() {
        let root = tempfile::tempdir().expect("tmp");
        let temp = tempfile::tempdir().expect("tmp");
        let pack = pack_with_command(root.path(), "demo", "demo");
        let system = root.path().join("system-bin");
        executable(&system, "demo", "#!/bin/sh\necho system\n");
        let path = std::env::join_paths([system.clone(), PathBuf::from("/usr/bin")]).unwrap();
        let prepared = prepare_pack_bins_in(
            std::slice::from_ref(&pack),
            Some((22, 0, 0)),
            temp.path(),
            &path,
        );
        assert!(prepared.linked.is_empty());
        assert!(prepared.dir.is_none());
        assert_eq!(prepared.path, path, "PATH is left alone");
        assert_eq!(
            fs::read_dir(temp.path()).unwrap().count(),
            0,
            "no folder is made"
        );

        // A runtime image's shim for this pack and version is the command itself.
        fs::write(
            system.join("demo"),
            pack_bin_shim(&pack, &pack.bin[0]).expect("shim"),
        )
        .unwrap();
        let prepared = prepare_pack_bins_in(
            std::slice::from_ref(&pack),
            Some((22, 0, 0)),
            temp.path(),
            &path,
        );
        assert_eq!(prepared.linked, [("demo".to_string(), "demo".to_string())]);
        assert!(prepared.dir.is_none());
        assert_eq!(prepared.path, path);

        // Another version's shim is someone else's command.
        let mut newer = pack.clone();
        newer.version = "0.2.0".into();
        let prepared = prepare_pack_bins_in(
            std::slice::from_ref(&newer),
            Some((22, 0, 0)),
            temp.path(),
            &path,
        );
        assert!(prepared.linked.is_empty());
        assert!(prepared.dir.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn prepared_bins_are_appended_to_path() {
        use std::os::unix::fs::PermissionsExt;
        // The shim runs the pack with whatever `node` is on PATH; the pack's own Node.js
        // requirement is checked in `a_pack_without_its_node_gets_no_command`, so this test does
        // not depend on the machine's Node.js major.
        if node_on_path().is_none() {
            return;
        }
        let root = tempfile::tempdir().expect("tmp");
        let temp = tempfile::tempdir().expect("tmp");
        let pack = pack_with_command(root.path(), "demo", "demo");
        let path = std::env::var_os("PATH").expect("PATH");
        let prepared = prepare_pack_bins_in(
            std::slice::from_ref(&pack),
            Some(TEST_PACK_NODE),
            temp.path(),
            &path,
        );
        assert_eq!(prepared.linked, [("demo".to_string(), "demo".to_string())]);
        let dir = prepared
            .dir
            .as_ref()
            .expect("a folder")
            .path()
            .to_path_buf();
        assert!(dir.starts_with(temp.path()));
        assert!(
            dir.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(&format!("{PACK_BIN_DIR_PREFIX}{}-", std::process::id()))
        );
        let entries: Vec<PathBuf> = std::env::split_paths(&prepared.path).collect();
        assert_eq!(
            entries.last(),
            Some(&dir),
            "the folder is the last PATH entry"
        );
        assert_eq!(
            entries[..entries.len() - 1],
            std::env::split_paths(&path).collect::<Vec<_>>()[..],
            "PATH is otherwise unchanged"
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(dir.join("demo")).unwrap().permissions().mode() & 0o777,
            0o555
        );
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "only the command, no probe left behind"
        );
        let output = run_with_path("command -v demo && demo hello there", &prepared.path);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{}\ndemo ran hello there\n", dir.join("demo").display())
        );
        drop(prepared);
        assert!(!dir.exists(), "the folder goes with the runtime");
    }

    /// Runs `script` with `sh -c` in a cleared environment with only `path`, retrying while a
    /// concurrent test's fork still holds a just-written shim open.
    #[cfg(unix)]
    pub(crate) fn run_with_path(script: &str, path: &std::ffi::OsStr) -> std::process::Output {
        let mut last = None;
        for _ in 0..20 {
            let output = Command::new("/bin/sh")
                .args(["-c", script])
                .env_clear()
                .env("PATH", path)
                .output()
                .expect("sh");
            if !String::from_utf8_lossy(&output.stderr).contains("busy") {
                return output;
            }
            last = Some(output);
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        last.unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_pack_without_its_node_gets_no_command() {
        let root = tempfile::tempdir().expect("tmp");
        let temp = tempfile::tempdir().expect("tmp");
        let pack = pack_with_command(root.path(), "demo", "demo");
        for node in [None, Some((20, 18, 0))] {
            let prepared = prepare_pack_bins_in(
                std::slice::from_ref(&pack),
                node,
                temp.path(),
                std::ffi::OsStr::new("/usr/bin:/bin"),
            );
            assert!(prepared.linked.is_empty() && prepared.dir.is_none());
        }
    }

    #[test]
    fn a_shim_runs_the_entry_with_node_and_quotes_its_path() {
        let root = tempfile::tempdir().expect("tmp");
        let pack = pack_with_command(root.path(), "demo", "demo");
        let shim = pack_bin_shim(&pack, &pack.bin[0]).expect("shim");
        assert_eq!(
            shim,
            format!(
                "#!/bin/sh\n# instafy:managed-pack-bin demo 0.1.0\nexec node '{}' \"$@\"\n",
                pack.dir.join("scripts/run.mjs").display()
            )
        );
        let mut quoted = pack.clone();
        quoted.dir = PathBuf::from("/tmp/it's here/demo");
        assert_eq!(pack_bin_shim(&quoted, &pack.bin[0]), None);
        let mut relative = pack.clone();
        relative.dir = PathBuf::from("packs/demo");
        assert_eq!(pack_bin_shim(&relative, &pack.bin[0]), None);
        let mut odd = pack.clone();
        odd.version = "1.0\nrm -rf /".into();
        assert_eq!(pack_bin_shim(&odd, &pack.bin[0]), None);
        let mut spaced = pack.clone();
        spaced.dir = PathBuf::from("/Applications/My App/skill-packs/demo");
        assert!(
            pack_bin_shim(&spaced, &pack.bin[0]).unwrap().contains(
                "exec node '/Applications/My App/skill-packs/demo/scripts/run.mjs' \"$@\""
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_pack_bin_folders_of_exited_runtimes_are_removed() {
        let temp = tempfile::tempdir().expect("tmp");
        let now = std::time::SystemTime::now();
        let two_days_ago = now - std::time::Duration::from_secs(2 * 24 * 60 * 60);
        let mut exited = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        exited.wait().unwrap();
        let gone = exited.id();
        let make = |name: String, aged: bool| -> PathBuf {
            let dir = temp.path().join(name);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("demo"), "#!/bin/sh\n").unwrap();
            if aged {
                fs::File::open(&dir)
                    .unwrap()
                    .set_modified(two_days_ago)
                    .unwrap();
            }
            dir
        };
        let stale = make(format!("{PACK_BIN_DIR_PREFIX}{gone}-abc"), true);
        let unnamed = make(format!("{PACK_BIN_DIR_PREFIX}x-abc"), true);
        let fresh = make(format!("{PACK_BIN_DIR_PREFIX}{gone}-def"), false);
        let running = make(
            format!("{PACK_BIN_DIR_PREFIX}{}-ghi", std::process::id()),
            true,
        );
        let other = make("someone-elses-folder".into(), true);
        let target = make("target".into(), true);
        let link = temp
            .path()
            .join(format!("{PACK_BIN_DIR_PREFIX}{gone}-link"));
        std::os::unix::fs::symlink(&target, &link).unwrap();
        remove_stale_pack_bin_dirs(temp.path(), now);
        assert!(!stale.exists(), "an old folder of a runtime that exited");
        assert!(!unnamed.exists(), "an old folder with no runtime named");
        assert!(fresh.exists(), "less than a day old");
        assert!(running.exists(), "its runtime still runs");
        assert!(other.exists() && target.join("demo").exists(), "not ours");
        assert!(
            fs::symlink_metadata(&link).is_ok(),
            "a link is never followed or removed"
        );
    }
}
