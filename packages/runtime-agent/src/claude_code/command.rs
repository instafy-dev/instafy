//! The exact `claude` command of a local-engine turn, and the environment it and the probe run
//! with (docs/Local-Engine-Turns.md, 3.3 and 3.4).
//!
//! The process starts with no shell, one argv element per item, in the space's folder, with the
//! prompt on stdin followed by EOF (3.5) and nothing in argv but flags. Its environment is built
//! from scratch: the launch snapshot's allowlist, the values Desktop granted, a `PATH` built from
//! values captured at startup, and `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Nothing else crosses,
//! however the process environment looks by then: granted secrets of other jobs, the proxy key,
//! `CONTROLLER_ACCESS_TOKEN`, a changed `HOME`, or anything `$CODEX_HOME/.env` loaded.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, Command};
use uuid::Uuid;

use super::{CheckedLaunch, LaunchGrant, ReadyLane};

/// The one value Instafy sets (3.4). Documented by Claude Code: it only stops claude.ai
/// connectors from loading, and does not depend on `--strict-mcp-config`.
pub const ENABLE_CLAUDEAI_MCP_SERVERS: &str = "ENABLE_CLAUDEAI_MCP_SERVERS";

/// The strict MCP configuration: no server (3.3, D7).
pub const EMPTY_MCP_CONFIG: &str = r#"{"mcpServers":{}}"#;

/// The argv after the program (3.3). `--no-bare` only when `--help` lists it, `--resume` only
/// with a session id the lane loader returned. Never `--bare`, `--dangerously-skip-permissions`,
/// another permission mode, a system prompt, tool lists, `--add-dir`, `--settings`, `--model`,
/// `--max-turns`, `--continue`, `--fork-session` or a prompt.
pub fn lane_argv(no_bare: bool, mcp_config: &Path, resume: Option<Uuid>) -> Vec<OsString> {
    let mut argv: Vec<OsString> = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--permission-prompts",
        "none",
        "--setting-sources",
        "user",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    argv.push(mcp_config.as_os_str().to_owned());
    argv.push("--include-partial-messages".into());
    if no_bare {
        argv.push("--no-bare".into());
    }
    if let Some(session) = resume {
        argv.push("--resume".into());
        argv.push(session.to_string().into());
    }
    argv
}

/// Every variable the child gets, in a fixed order (3.4): the snapshot's allowlisted values,
/// the granted D26 values that passed their checks, `PATH` and
/// `ENABLE_CLAUDEAI_MCP_SERVERS=false`. `CLAUDE_CONFIG_DIR` is the only `CLAUDE_*` name it can
/// hold, and only with the person's granted value.
pub fn lane_environment(grant: &LaunchGrant, launch: &CheckedLaunch) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<(OsString, OsString)> = grant
        .snapshot()
        .values()
        .iter()
        .chain(launch.granted_env())
        .map(|(name, value)| (OsString::from(name), value.clone()))
        .collect();
    environment.push(("PATH".into(), lane_path(grant, launch)));
    environment.push((ENABLE_CLAUDEAI_MCP_SERVERS.into(), "false".into()));
    environment
}

/// The child's `PATH` (3.4), from these sources in order: the granted path's own folder,
/// Desktop's login-shell entries, then the launch `PATH` from before the skill-pack shims joined
/// it. Entries are deduplicated, and one that fails [`LaunchGrant::path_entry_is_safe`] (not
/// absolute, missing, in the workspace, or writable by others) is dropped.
pub fn lane_path(grant: &LaunchGrant, launch: &CheckedLaunch) -> OsString {
    let launch_path = grant
        .snapshot()
        .path()
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    let candidates = std::iter::once(launch.granted_dir().to_path_buf())
        .chain(grant.path_entries().iter().cloned())
        .chain(launch_path);
    let mut entries: Vec<PathBuf> = Vec::new();
    for entry in candidates {
        if !entries.contains(&entry) && grant.path_entry_is_safe(&entry) {
            entries.push(entry);
        }
    }
    std::env::join_paths(entries).unwrap_or_default()
}

/// A turn's `--mcp-config` file, `{"mcpServers":{}}` with mode 0600, in a runtime-owned folder
/// outside every space folder. Dropping it removes the folder, when the turn ends (3.3).
pub struct McpConfigFile {
    _folder: tempfile::TempDir,
    path: PathBuf,
}

impl McpConfigFile {
    pub fn create(grant: &LaunchGrant) -> io::Result<Self> {
        let folder = super::runtime_owned_dir(grant, "instafy-claude-code-mcp-")?;
        let path = folder.path().join("mcp.json");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        io::Write::write_all(&mut file, EMPTY_MCP_CONFIG.as_bytes())?;
        Ok(Self {
            _folder: folder,
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// The turn's `claude` process, unspawned (3.3, 3.6): the checked target the probe ran, the
/// exact argv, a cleared environment holding only [`lane_environment`], the space's folder as
/// working directory, piped stdio and `kill_on_drop`. It stays in runtime-agent's own process
/// group, which Desktop signals and proves gone as a unit, so there is no `process_group(0)`.
pub fn turn_command(
    grant: &LaunchGrant,
    ready: &ReadyLane,
    mcp_config: &McpConfigFile,
    resume: Option<Uuid>,
    folder: &Path,
) -> Command {
    let mut command = Command::new(ready.launch().program());
    command
        .args(lane_argv(
            ready.help().lists_no_bare(),
            mcp_config.path(),
            resume,
        ))
        .env_clear()
        .envs(lane_environment(grant, ready.launch()))
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// Writes the prompt, exactly the UTF-8 bytes of the person's recorded message, then closes
/// stdin so `claude` reads EOF (3.5). Nothing is added to it.
pub async fn write_prompt(mut stdin: ChildStdin, prompt: &str) -> io::Result<()> {
    stdin.write_all(prompt.as_bytes()).await?;
    stdin.flush().await?;
    drop(stdin);
    Ok(())
}

/// A probe command (3.2): the same program and environment as a turn, stdin from null, and a
/// fresh, empty, runtime-owned working directory, so no project settings can load.
pub(super) fn probe_command(
    launch: &CheckedLaunch,
    environment: &[(OsString, OsString)],
    args: &[&str],
    folder: &Path,
) -> Command {
    let mut command = Command::new(launch.program());
    command
        .args(args)
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_code::{Confinement, LaunchEnvSnapshot, RawLaunchGrant, Trust};

    const FLAGS_WITH_VALUES: [&str; 6] = [
        "--output-format",
        "--permission-mode",
        "--permission-prompts",
        "--setting-sources",
        "--mcp-config",
        "--resume",
    ];

    fn strings(argv: &[OsString]) -> Vec<String> {
        argv.iter()
            .map(|arg| arg.to_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_argv_is_exactly_that_of_3_3() {
        let mcp_config = Path::new("/private/tmp/instafy-claude-code-mcp-x/mcp.json");
        assert_eq!(
            strings(&lane_argv(false, mcp_config, None)),
            [
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "acceptEdits",
                "--permission-prompts",
                "none",
                "--setting-sources",
                "user",
                "--strict-mcp-config",
                "--mcp-config",
                "/private/tmp/instafy-claude-code-mcp-x/mcp.json",
                "--include-partial-messages",
            ]
        );
        let session = Uuid::new_v4();
        let resumed = strings(&lane_argv(true, mcp_config, Some(session)));
        assert_eq!(
            resumed[14..],
            [
                "--no-bare".to_string(),
                "--resume".to_string(),
                session.to_string()
            ]
        );
        assert_eq!(
            strings(&lane_argv(true, mcp_config, None))[14..],
            ["--no-bare"]
        );
    }

    #[test]
    fn the_argv_holds_flags_and_their_values_and_nothing_forbidden() {
        const FORBIDDEN: [&str; 17] = [
            "--bare",
            "--dangerously-skip-permissions",
            "bypassPermissions",
            "dontAsk",
            "auto",
            "--system-prompt",
            "--append-system-prompt",
            "--allowedTools",
            "--allowed-tools",
            "--disallowedTools",
            "--disallowed-tools",
            "--add-dir",
            "--settings",
            "--model",
            "--max-turns",
            "--continue",
            "--fork-session",
        ];
        let mcp_config = Path::new("/private/tmp/instafy-claude-code-mcp-x/mcp.json");
        for no_bare in [false, true] {
            for resume in [None, Some(Uuid::new_v4())] {
                let argv = strings(&lane_argv(no_bare, mcp_config, resume));
                let mut args = argv.iter();
                while let Some(arg) = args.next() {
                    assert!(arg.starts_with("--"), "{arg} is not a flag in {argv:?}");
                    assert!(
                        !FORBIDDEN.contains(&arg.as_str())
                            && !arg.contains("system-prompt")
                            && !arg.starts_with("--permission-mode="),
                        "{arg} is never passed"
                    );
                    if FLAGS_WITH_VALUES.contains(&arg.as_str()) {
                        let value = args.next().expect("a flag value");
                        assert!(!FORBIDDEN.contains(&value.as_str()), "{value}");
                    }
                }
                assert_eq!(
                    argv.iter()
                        .filter(|arg| *arg == "--permission-mode")
                        .count(),
                    1
                );
            }
        }
    }

    #[cfg(unix)]
    fn folder(path: &Path, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        path.to_path_buf()
    }

    #[cfg(unix)]
    #[test]
    fn the_environment_is_the_allowlist_the_granted_values_path_and_one_constant() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let bin = folder(&root.join("bin"), 0o755);
        let workspace = folder(&root.join("workspace"), 0o755);
        let in_workspace = folder(&workspace.join("space/node_modules/.bin"), 0o755);
        let writable = folder(&root.join("writable"), 0o777);
        let tmp = folder(&root.join("tmp"), 0o700);
        let snapshot = LaunchEnvSnapshot::from_lookup(|key| {
            let value = match key {
                "HOME" => "/home/person".to_string(),
                "USER" => "person".to_string(),
                "TMPDIR" => tmp.display().to_string(),
                "LANG" => "en_US.UTF-8".to_string(),
                "PATH" => format!(
                    "{}:/usr/bin:relative/bin:/bin:/usr/bin:",
                    in_workspace.display()
                ),
                _ => return None,
            };
            Some(value.into())
        });
        let raw = RawLaunchGrant {
            bin: Some(bin.join("claude").into()),
            path: Some(
                std::env::join_paths([
                    writable.clone(),
                    PathBuf::from("/usr/bin"),
                    root.join("missing"),
                    bin.clone(),
                ])
                .unwrap(),
            ),
            user_id: Some(Uuid::new_v4().to_string().into()),
            env_json: Some(
                r#"{"HTTPS_PROXY": "http://proxy.example:3128", "NO_PROXY": "localhost", "ANTHROPIC_BASE_URL": "http://gateway.example"}"#
                    .into(),
            ),
        };
        let grant = LaunchGrant::parse(
            raw,
            snapshot,
            Confinement::new([workspace.clone()]),
            Trust::current(),
        )
        .unwrap()
        .unwrap();
        let launch = CheckedLaunch {
            program: bin.join("claude"),
            granted_dir: bin.clone(),
            identity: crate::claude_code::BinaryIdentity {
                canonical: bin.join("claude"),
                size: 0,
                modified: None,
            },
            granted_env: grant.granted_env().to_vec(),
        };
        let expected_path = format!("{}:/usr/bin:/bin", bin.display());
        let expected: Vec<(OsString, OsString)> = [
            ("HOME", "/home/person"),
            ("USER", "person"),
            ("LANG", "en_US.UTF-8"),
            ("TMPDIR", tmp.to_str().unwrap()),
            ("HTTPS_PROXY", "http://proxy.example:3128"),
            ("NO_PROXY", "localhost"),
            ("PATH", expected_path.as_str()),
            ("ENABLE_CLAUDEAI_MCP_SERVERS", "false"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
        assert_eq!(lane_environment(&grant, &launch), expected);
    }

    #[cfg(unix)]
    #[test]
    fn the_mcp_configuration_is_an_empty_private_file_the_turn_removes() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let tmp = folder(&root.join("tmp"), 0o700);
        let grant_with_tmp = |tmp: &Path, workspace: &Path| {
            let tmp = tmp.to_path_buf();
            LaunchGrant::parse(
                RawLaunchGrant {
                    bin: Some("/usr/local/bin/claude".into()),
                    user_id: Some(Uuid::new_v4().to_string().into()),
                    ..RawLaunchGrant::default()
                },
                LaunchEnvSnapshot::from_lookup(|key| {
                    (key == "TMPDIR").then(|| tmp.clone().into_os_string())
                }),
                Confinement::new([workspace.to_path_buf()]),
                Trust::current(),
            )
            .unwrap()
            .unwrap()
        };
        let grant = grant_with_tmp(&tmp, &root.join("workspace"));
        let config = McpConfigFile::create(&grant).unwrap();
        let path = config.path().to_path_buf();
        assert!(path.starts_with(&tmp));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), EMPTY_MCP_CONFIG);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let folder_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(folder_mode & 0o777, 0o700);
        drop(config);
        assert!(!path.exists() && !path.parent().unwrap().exists());

        // Never inside a space folder, even when the runtime's temporary folder is.
        let inside = grant_with_tmp(&tmp, &root);
        assert!(McpConfigFile::create(&inside).is_err());
        assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 0);
    }
}
