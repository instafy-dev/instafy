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
//!   "engines": {"node": ">=22"}, "env": ["UW_*", "SOME_SETTING"], ...}`. A pack whose manifest does
//! not parse or check out is skipped with a warning.
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
        .filter(|(key, _)| {
            key.to_str()
                .is_some_and(|name| is_pack_setting(packs, name))
        })
        .collect()
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
    Ok(InstalledPack {
        name: manifest.name,
        version: manifest.version,
        dir: dir.to_path_buf(),
        skill,
        cli,
        node,
        env: manifest.env,
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
                ("UW_TURN_BUDGET", "0"),
                ("INSTAFY_LOOKUP_PROVIDERS", "{}"),
                ("UW_API_KEY", "x"),
                ("UW_SECRET", "x"),
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
            ["UW_PHOTON", "UW_TURN_BUDGET", "INSTAFY_LOOKUP_PROVIDERS"]
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
}
