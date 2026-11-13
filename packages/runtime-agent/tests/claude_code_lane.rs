//! The local-engine lane before a turn runs (docs/Local-Engine-Turns.md, section 8): the capture
//! of Desktop's launch grant, the probe of the granted `claude`, the capability, and the exact
//! command and environment the child gets.
//!
//! Hermetic: temporary folders and tests/fixtures/fake-claude, started through a wrapper each
//! test writes. Nothing runs a real `claude` or looks one up on PATH. The process-wide capture
//! runs in a child test process of its own (`in_child`), as the runtime's other startup captures
//! are tested.
#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use runtime_agent::claude_code::command::{
    McpConfigFile, lane_environment, lane_path, turn_command, write_prompt,
};
use runtime_agent::claude_code::{
    self, BIN_ENV, CapturedGrant, Confinement, ENV_JSON_ENV, LAUNCH_GRANT_ENV_KEYS, Lane,
    LaunchEnvSnapshot, LaunchGrant, NotReadyReason, PATH_ENV, RawLaunchGrant, Readiness, Trust,
    USER_ID_ENV,
};
use serde_json::{Value, json};
use uuid::Uuid;

const FAKE_CLAUDE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude");
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/fake-claude-fixtures"
);
const USER_ID: &str = "6f1c2f6e-9d8a-4f7b-8f61-3c1f0a2b4d5e";

fn folder(path: &Path, mode: u32) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    chmod(path, mode);
    path.to_path_buf()
}

fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn quote(value: impl AsRef<std::ffi::OsStr>) -> String {
    let value = value.as_ref().to_str().expect("test paths are UTF-8");
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// One call of the fake, as it recorded it.
#[derive(Debug)]
struct Call {
    argv: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: PathBuf,
    stdin: Vec<u8>,
}

/// What `/bin/sh` itself exports, and the wrapper's settings for the fake.
fn is_shell_or_fake_setting(name: &str) -> bool {
    matches!(name, "PWD" | "OLDPWD" | "SHLVL" | "_") || name.starts_with("FAKE_CLAUDE_")
}

/// A temporary computer: the granted `claude` (a wrapper that sets the fake's settings and execs
/// it), a workspace, a home, a temporary folder, and the record of the fake's calls.
struct Machine {
    _temp: tempfile::TempDir,
    root: PathBuf,
}

impl Machine {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        for (name, mode) in [
            ("bin", 0o755),
            ("workspace", 0o755),
            ("workspace/space", 0o755),
            ("home", 0o700),
            ("tmp", 0o700),
            ("record", 0o700),
        ] {
            folder(&root.join(name), mode);
        }
        let machine = Self { _temp: temp, root };
        machine.settings(&[]);
        machine.install_wrapper(&machine.bin(), "");
        machine
    }

    fn bin(&self) -> PathBuf {
        self.root.join("bin/claude")
    }

    fn workspace(&self) -> PathBuf {
        self.root.join("workspace")
    }

    /// The fake's answers for the next calls, as `FAKE_CLAUDE_<name>` values.
    fn settings(&self, settings: &[(&str, &str)]) {
        let mut text = format!(
            "FAKE_CLAUDE_RECORD_DIR={}\nFAKE_CLAUDE_FIXTURES={}\n",
            quote(self.root.join("record")),
            quote(FIXTURES)
        );
        for (name, value) in settings {
            text.push_str(&format!("FAKE_CLAUDE_{name}={}\n", quote(value)));
        }
        std::fs::write(self.root.join("fake-claude.env"), text).unwrap();
    }

    /// Writes a wrapper at `path`, replacing any by a rename, so nothing ever executes a file
    /// that is open for writing. `comment` makes a different file.
    fn install_wrapper(&self, path: &Path, comment: &str) {
        let next = path.with_extension("next");
        std::fs::write(
            &next,
            format!(
                "#!/bin/sh\n# {comment}\nset -a\n. {}\nset +a\nexec {} \"$@\"\n",
                quote(self.root.join("fake-claude.env")),
                quote(FAKE_CLAUDE)
            ),
        )
        .unwrap();
        chmod(&next, 0o755);
        std::fs::rename(&next, path).unwrap();
    }

    fn snapshot(&self) -> LaunchEnvSnapshot {
        let home = self.root.join("home");
        let tmp = self.root.join("tmp");
        LaunchEnvSnapshot::from_lookup(|key| {
            Some(match key {
                "HOME" => home.clone().into_os_string(),
                "USER" | "LOGNAME" => "person".into(),
                "SHELL" => "/bin/zsh".into(),
                "TMPDIR" => tmp.clone().into_os_string(),
                "LANG" => "en_US.UTF-8".into(),
                "PATH" => "/usr/bin:/bin".into(),
                _ => return None,
            })
        })
    }

    fn raw(&self) -> RawLaunchGrant {
        RawLaunchGrant {
            bin: Some(self.bin().into_os_string()),
            path: None,
            user_id: Some(USER_ID.into()),
            env_json: None,
        }
    }

    fn grant_from(&self, raw: RawLaunchGrant, trust: Trust) -> LaunchGrant {
        LaunchGrant::parse(
            raw,
            self.snapshot(),
            Confinement::new([self.workspace()]),
            trust,
        )
        .unwrap()
        .expect("a grant")
    }

    fn grant(&self) -> LaunchGrant {
        self.grant_from(self.raw(), Trust::current())
    }

    fn lane(&self) -> Lane {
        Lane::new(self.grant())
    }

    fn calls(&self) -> Vec<Call> {
        recorded_calls(&self.root)
    }

    fn calls_since(&self, before: usize) -> Vec<Vec<String>> {
        self.calls()
            .into_iter()
            .skip(before)
            .map(|call| call.argv)
            .collect()
    }
}

/// The calls the fake finished recording under a machine's `root`, in order.
fn recorded_calls(root: &Path) -> Vec<Call> {
    let record = root.join("record");
    let mut calls = Vec::new();
    for n in 0.. {
        let call = record.join(format!("call-{n}"));
        if !call.join("done").exists() {
            break;
        }
        let argv = std::fs::read(call.join("argv")).unwrap();
        let mut argv: Vec<String> = argv
            .split(|byte| *byte == 0)
            .map(|arg| String::from_utf8(arg.to_vec()).unwrap())
            .collect();
        if argv.last().is_some_and(String::is_empty) {
            argv.pop();
        }
        let env = std::fs::read_to_string(call.join("env"))
            .unwrap()
            .lines()
            .filter_map(|line| line.split_once('='))
            .filter(|(name, _)| !is_shell_or_fake_setting(name))
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        let cwd = std::fs::read_to_string(call.join("cwd")).unwrap();
        calls.push(Call {
            argv,
            env,
            cwd: PathBuf::from(cwd.trim_end()),
            stdin: std::fs::read(call.join("stdin")).unwrap(),
        });
    }
    calls
}

fn ready(readiness: &Readiness) -> &claude_code::ReadyLane {
    readiness
        .ready()
        .unwrap_or_else(|| panic!("expected a ready lane, got {readiness:?}"))
}

fn args(list: &[&[&str]]) -> Vec<Vec<String>> {
    list.iter()
        .map(|call| call.iter().map(|arg| arg.to_string()).collect())
        .collect()
}

#[tokio::test]
async fn a_supported_claude_gives_the_ready_capability_from_its_three_probe_calls() {
    let machine = Machine::new();
    let lane = machine.lane();
    let probe = lane.probe_and_publish().await;
    assert!(probe.capability_changed);
    assert_eq!(
        lane.capability(),
        Some(json!({
            "version": 1,
            "ready": true,
            "cli": "2.1.314",
            "verified": true,
            "planSignIn": true,
            "partialMessages": true,
        }))
    );
    let calls = machine.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.argv.clone())
            .collect::<Vec<_>>(),
        args(&[&["--version"], &["--help"], &["auth", "status"]])
    );
    let tmp = machine.root.join("tmp");
    let mut folders = BTreeSet::new();
    for call in &calls {
        // stdin from null, and a fresh runtime-owned folder outside the workspace, removed after.
        assert!(call.stdin.is_empty());
        assert!(call.cwd.starts_with(&tmp), "{call:?}");
        assert!(
            call.cwd
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("instafy-claude-code-probe-"))
        );
        assert!(!call.cwd.exists());
        folders.insert(call.cwd.clone());
    }
    assert_eq!(folders.len(), calls.len());
    assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 0);
}

#[tokio::test]
async fn each_reason_is_produced() {
    let machine = Machine::new();

    for (settings, reason) in [
        (
            &[("VERSION", "old")][..],
            NotReadyReason::UnsupportedVersion,
        ),
        (&[("VERSION", "garbage")][..], NotReadyReason::ProbeFailed),
        (&[("VERSION", "broken")][..], NotReadyReason::ProbeFailed),
        (&[("HELP", "broken")][..], NotReadyReason::ProbeFailed),
        (&[("HELP", "flood")][..], NotReadyReason::ProbeFailed),
        (&[("HELP", "bare-default")][..], NotReadyReason::BareDefault),
        (
            &[("HELP", "bare-default-with-no-bare")][..],
            NotReadyReason::BareDefault,
        ),
    ] {
        machine.settings(settings);
        let lane = machine.lane();
        let probe = lane.probe_and_publish().await;
        assert_eq!(probe.readiness.reason(), Some(reason), "{settings:?}");
        assert_eq!(
            lane.capability(),
            Some(json!({ "version": 1, "ready": false, "reason": reason.as_str() }))
        );
    }

    // A probe command that outlives its limit is killed, and the probe fails.
    for answer in ["VERSION", "HELP"] {
        machine.settings(&[(answer, "hang")]);
        let lane = machine
            .lane()
            .with_probe_timeout(Duration::from_millis(300));
        let started = std::time::Instant::now();
        assert_eq!(
            lane.probe().await.reason(),
            Some(NotReadyReason::ProbeFailed)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }
    machine.settings(&[]);

    let missing = machine.root.join("bin/not-installed");
    let grant = machine.grant_from(
        RawLaunchGrant {
            bin: Some(missing.into_os_string()),
            ..machine.raw()
        },
        Trust::current(),
    );
    assert_eq!(
        Lane::new(grant).probe().await.reason(),
        Some(NotReadyReason::BinaryMissing)
    );

    chmod(&machine.bin(), 0o757);
    assert_eq!(
        machine.lane().probe().await.reason(),
        Some(NotReadyReason::BinaryUnsafe)
    );
    chmod(&machine.bin(), 0o755);
    assert!(machine.lane().probe().await.is_ready());
}

#[tokio::test]
async fn a_flag_missing_from_help_is_logged_and_does_not_fail_the_probe() {
    let machine = Machine::new();
    machine.settings(&[("HELP", "missing-flags")]);
    let readiness = machine.lane().probe().await;
    assert_eq!(
        ready(&readiness).help().missing_flags(),
        ["--permission-prompts", "--include-partial-messages"]
    );
}

#[tokio::test]
async fn plan_sign_in_is_true_only_for_a_claude_plan_sign_in() {
    let machine = Machine::new();
    for (auth, plan) in [
        ("claude-ai", true),
        ("oauth-token", true),
        ("api-key", false),
        ("signed-out", false),
    ] {
        machine.settings(&[("AUTH", auth)]);
        let readiness = machine.lane().probe().await;
        assert_eq!(ready(&readiness).plan_sign_in(), plan, "{auth}");
        assert_eq!(readiness.capability()["planSignIn"], json!(plan), "{auth}");
    }
    // A sign-in check that cannot finish says nothing about a plan; the lane stays ready.
    machine.settings(&[("AUTH", "hang")]);
    let lane = machine
        .lane()
        .with_probe_timeout(Duration::from_millis(300));
    assert!(!ready(&lane.probe().await).plan_sign_in());
}

#[tokio::test]
async fn verified_holds_only_up_to_the_contract_constant() {
    let machine = Machine::new();
    let supported = machine.lane().probe().await;
    assert!(ready(&supported).verified());
    machine.settings(&[("VERSION", "newer")]);
    let newer = machine.lane().probe().await;
    assert_eq!(ready(&newer).cli().to_string(), "2.1.400");
    assert!(!ready(&newer).verified());
    assert_eq!(newer.capability()["verified"], json!(false));
}

#[tokio::test]
async fn help_runs_again_only_when_the_version_or_the_binary_changes() {
    let machine = Machine::new();
    let lane = machine.lane();
    let help_calls = |calls: &[Vec<String>]| {
        calls
            .iter()
            .filter(|argv| argv.as_slice() == ["--help"])
            .count()
    };

    assert!(lane.probe().await.is_ready());
    assert_eq!(help_calls(&machine.calls_since(0)), 1);

    let before = machine.calls().len();
    assert!(lane.probe().await.is_ready());
    assert_eq!(
        machine.calls_since(before),
        args(&[&["--version"], &["auth", "status"]])
    );

    // Another version.
    machine.settings(&[("VERSION", "newer")]);
    let before = machine.calls().len();
    assert!(lane.probe().await.is_ready());
    assert_eq!(help_calls(&machine.calls_since(before)), 1);
    let before = machine.calls().len();
    lane.probe().await;
    assert_eq!(help_calls(&machine.calls_since(before)), 0);

    // The same version from a binary of another size.
    machine.install_wrapper(&machine.bin(), "an update");
    let before = machine.calls().len();
    assert!(lane.probe().await.is_ready());
    assert_eq!(help_calls(&machine.calls_since(before)), 1);

    // The same size, modified again.
    let modified = std::fs::metadata(machine.bin())
        .unwrap()
        .modified()
        .unwrap();
    std::fs::File::open(machine.bin())
        .unwrap()
        .set_modified(modified + Duration::from_secs(10))
        .unwrap();
    let before = machine.calls().len();
    assert!(lane.probe().await.is_ready());
    assert_eq!(help_calls(&machine.calls_since(before)), 1);

    // Another target behind the same granted link.
    let links = folder(&machine.root.join("links"), 0o755);
    let link = links.join("claude");
    std::os::unix::fs::symlink(machine.bin(), &link).unwrap();
    let linked = Lane::new(machine.grant_from(
        RawLaunchGrant {
            bin: Some(link.clone().into_os_string()),
            ..machine.raw()
        },
        Trust::current(),
    ));
    let first = linked.probe().await;
    assert_eq!(ready(&first).launch().program(), machine.bin());
    let second_target = machine.root.join("bin/claude-2");
    machine.install_wrapper(&second_target, "");
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&second_target, &link).unwrap();
    let before = machine.calls().len();
    let second = linked.probe().await;
    assert_eq!(ready(&second).launch().program(), second_target);
    assert_eq!(help_calls(&machine.calls_since(before)), 1);
}

#[tokio::test]
async fn a_per_turn_probe_that_disagrees_publishes_the_capability_to_register_again() {
    let machine = Machine::new();
    let lane = machine.lane();
    let mut updates = lane.subscribe();
    assert!(lane.probe_and_publish().await.capability_changed);
    assert_eq!(
        updates.borrow_and_update().as_ref().unwrap()["planSignIn"],
        json!(true)
    );

    // A turn's probe that agrees changes nothing.
    assert!(!lane.probe_and_publish().await.capability_changed);
    assert!(!updates.has_changed().unwrap());

    // The person signed out of Claude Code since the runtime registered.
    machine.settings(&[("AUTH", "signed-out")]);
    let probe = lane.probe_and_publish().await;
    assert!(probe.readiness.is_ready());
    assert!(probe.capability_changed);
    assert!(updates.has_changed().unwrap());
    assert_eq!(
        updates.borrow_and_update().as_ref().unwrap()["planSignIn"],
        json!(false)
    );

    // Claude Code was replaced by a version the lane does not run.
    machine.settings(&[("VERSION", "old")]);
    let probe = lane.probe_and_publish().await;
    assert_eq!(
        probe.readiness.reason(),
        Some(NotReadyReason::UnsupportedVersion)
    );
    assert!(probe.capability_changed);
    assert_eq!(
        lane.capability(),
        Some(json!({ "version": 1, "ready": false, "reason": "unsupported_version" }))
    );
}

#[tokio::test]
async fn while_not_ready_a_timed_probe_publishes_once_the_result_changes() {
    let machine = Machine::new();
    machine.settings(&[("VERSION", "old")]);
    let lane = Arc::new(machine.lane());
    assert!(!lane.probe_and_publish().await.readiness.is_ready());
    let mut updates = lane.subscribe();
    updates.borrow_and_update();
    let reprobes = tokio::spawn({
        let lane = lane.clone();
        async move {
            lane.reprobe_while_not_ready(Duration::from_millis(50))
                .await
        }
    });

    // Probing on, nothing changes, so nothing is published.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(machine.calls().len() > 2, "the timer probed again");
    assert!(!updates.has_changed().unwrap());

    // The person updates Claude Code.
    machine.settings(&[]);
    tokio::time::timeout(Duration::from_secs(10), updates.changed())
        .await
        .expect("a timed probe published the change")
        .unwrap();
    assert_eq!(
        updates.borrow_and_update().as_ref().unwrap()["ready"],
        json!(true)
    );

    // Once ready, the timer leaves the probing to the turns.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let settled = machine.calls().len();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(machine.calls().len(), settled);
    reprobes.abort();
}

/// The runtime registers, and so takes any turn, Codex's too, only once the startup probe ended:
/// its three commands share one limit, the limit of one command, and a probe that runs out of it
/// is `probe_failed`, which the timed re-probe corrects (3.2). A turn's probe keeps a limit for
/// each command.
#[tokio::test]
async fn the_startup_probe_has_one_limit_for_its_three_commands() {
    let machine = Machine::new();
    let limit = Duration::from_secs(3);
    // The limit, the last command's kill and a busy machine's slack.
    let at_most = limit + Duration::from_secs(3);
    let probe_failed = json!({ "version": 1, "ready": false, "reason": "probe_failed" });

    // A sign-in check that never finishes.
    machine.settings(&[("AUTH", "hang")]);
    let lane = machine.lane().with_probe_timeout(limit);
    let started = std::time::Instant::now();
    let probe = lane.probe_and_publish_at_startup().await;
    assert!(started.elapsed() < at_most, "{:?}", started.elapsed());
    assert_eq!(probe.readiness.reason(), Some(NotReadyReason::ProbeFailed));
    assert_eq!(lane.capability(), Some(probe_failed.clone()));
    // A turn's probe waits out the sign-in check alone, and finds the lane ready.
    assert!(!ready(&lane.probe().await).plan_sign_in());

    // Commands that each finish within the limit, but not all three within it.
    machine.settings(&[("PROBE_DELAY", "1")]);
    let lane = machine.lane().with_probe_timeout(limit);
    let started = std::time::Instant::now();
    let probe = lane.probe_and_publish_at_startup().await;
    assert!(started.elapsed() < at_most, "{:?}", started.elapsed());
    assert_eq!(probe.readiness.reason(), Some(NotReadyReason::ProbeFailed));
    assert_eq!(lane.capability(), Some(probe_failed));
    assert!(lane.probe_and_publish().await.readiness.is_ready());

    // A claude that answers in time is ready at startup.
    machine.settings(&[]);
    let lane = machine.lane().with_probe_timeout(limit);
    assert!(
        lane.probe_and_publish_at_startup()
            .await
            .readiness
            .is_ready()
    );
}

#[test]
fn the_capture_refuses_what_others_can_write_or_the_workspace_holds() {
    let machine = Machine::new();
    let group_of = |path: &Path| {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).unwrap().gid()
    };
    let euid = Trust::current().euid;
    let no_admin = Trust {
        euid,
        admin_gid: None,
    };
    let admin_is_the_files_group = Trust {
        euid,
        admin_gid: Some(group_of(&machine.bin())),
    };
    let check = |raw: RawLaunchGrant, trust: Trust| {
        machine
            .grant_from(raw, trust)
            .check()
            .map(|launch| launch.program().to_path_buf())
    };
    assert_eq!(check(machine.raw(), no_admin), Ok(machine.bin()));

    // The binary: anyone, or a group other than admin, may write it.
    chmod(&machine.bin(), 0o757);
    assert_eq!(
        check(machine.raw(), admin_is_the_files_group),
        Err(NotReadyReason::BinaryUnsafe)
    );
    chmod(&machine.bin(), 0o775);
    assert_eq!(
        check(machine.raw(), no_admin),
        Err(NotReadyReason::BinaryUnsafe)
    );
    // Only the admin group may also write it, as Homebrew's files are.
    assert_eq!(
        check(machine.raw(), admin_is_the_files_group),
        Ok(machine.bin())
    );
    chmod(&machine.bin(), 0o755);

    // Its folder, the same way: /opt/homebrew/bin is the person's, group admin, 0775.
    let bin = machine.root.join("bin");
    let admin_is_the_folders_group = Trust {
        euid,
        admin_gid: Some(group_of(&bin)),
    };
    chmod(&bin, 0o777);
    assert_eq!(
        check(machine.raw(), admin_is_the_folders_group),
        Err(NotReadyReason::BinaryUnsafe)
    );
    chmod(&bin, 0o775);
    assert_eq!(
        check(machine.raw(), no_admin),
        Err(NotReadyReason::BinaryUnsafe)
    );
    assert_eq!(
        check(machine.raw(), admin_is_the_folders_group),
        Ok(machine.bin())
    );
    chmod(&bin, 0o755);

    // In the workspace or the project folder, directly or through a link either way.
    let in_workspace = machine.root.join("workspace/space/claude");
    machine.install_wrapper(&in_workspace, "");
    let at = |path: &Path| RawLaunchGrant {
        bin: Some(path.as_os_str().to_owned()),
        ..machine.raw()
    };
    assert_eq!(
        check(at(&in_workspace), no_admin),
        Err(NotReadyReason::BinaryUnsafe)
    );
    let project = folder(&machine.root.join("project"), 0o755);
    let in_project = project.join("claude");
    machine.install_wrapper(&in_project, "");
    let with_project = LaunchGrant::parse(
        at(&in_project),
        machine.snapshot(),
        Confinement::new([machine.workspace(), project.clone()]),
        no_admin,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        with_project.check().err(),
        Some(NotReadyReason::BinaryUnsafe)
    );
    let links = folder(&machine.root.join("links"), 0o755);
    std::os::unix::fs::symlink(&in_workspace, links.join("into-workspace")).unwrap();
    assert_eq!(
        check(at(&links.join("into-workspace")), no_admin),
        Err(NotReadyReason::BinaryUnsafe)
    );
    let link_in_workspace = machine.root.join("workspace/space/claude-link");
    std::os::unix::fs::symlink(machine.bin(), &link_in_workspace).unwrap();
    assert_eq!(
        check(at(&link_in_workspace), no_admin),
        Err(NotReadyReason::BinaryUnsafe)
    );
    let shared = folder(&machine.root.join("shared"), 0o777);
    std::os::unix::fs::symlink(machine.bin(), shared.join("claude")).unwrap();
    assert_eq!(
        check(at(&shared.join("claude")), no_admin),
        Err(NotReadyReason::BinaryUnsafe)
    );

    // A link from a trusted folder: the runtime spawns its checked target.
    std::os::unix::fs::symlink(machine.bin(), links.join("claude")).unwrap();
    let launch = machine
        .grant_from(at(&links.join("claude")), no_admin)
        .check()
        .unwrap();
    assert_eq!(launch.program(), machine.bin());
    assert_eq!(launch.granted_dir(), links);

    // Nothing runnable there.
    let not_executable = machine.root.join("bin/not-executable");
    std::fs::write(&not_executable, "#!/bin/sh\n").unwrap();
    chmod(&not_executable, 0o644);
    for path in [
        not_executable,
        machine.root.join("bin/not-installed"),
        machine.root.join("bin"),
        machine.root.join("bin/claude/inside-a-file"),
    ] {
        assert_eq!(
            check(at(&path), no_admin),
            Err(NotReadyReason::BinaryMissing),
            "{path:?}"
        );
    }
}

#[tokio::test]
async fn a_granted_config_dir_or_ca_file_that_fails_its_checks_makes_the_lane_unsafe() {
    let machine = Machine::new();
    let config_dir = folder(&machine.root.join("home/.claude-work"), 0o700);
    let ca_file = machine.root.join("home/corporate-ca.pem");
    std::fs::write(&ca_file, "-----BEGIN CERTIFICATE-----\n").unwrap();
    chmod(&ca_file, 0o644);
    let gid = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(&config_dir).unwrap().gid()
    };
    // Even the admin group may not write these.
    let trust = Trust {
        euid: Trust::current().euid,
        admin_gid: Some(gid),
    };
    let with_env = |env: Value| RawLaunchGrant {
        env_json: Some(env.to_string().into()),
        ..machine.raw()
    };
    let granted = json!({
        "CLAUDE_CONFIG_DIR": config_dir,
        "NODE_EXTRA_CA_CERTS": ca_file,
        "HTTPS_PROXY": "http://proxy.example:3128",
        "ANTHROPIC_BASE_URL": "http://gateway.example",
    });
    let launch = machine
        .grant_from(with_env(granted.clone()), trust)
        .check()
        .unwrap();
    assert_eq!(
        launch.granted_env(),
        [
            ("CLAUDE_CONFIG_DIR", config_dir.clone().into_os_string()),
            ("HTTPS_PROXY", OsString::from("http://proxy.example:3128")),
            ("NODE_EXTRA_CA_CERTS", ca_file.clone().into_os_string()),
        ]
    );

    let unsafe_check = |env: Value| machine.grant_from(with_env(env), trust).check().err();
    chmod(&config_dir, 0o770);
    assert_eq!(
        unsafe_check(granted.clone()),
        Some(NotReadyReason::BinaryUnsafe)
    );
    chmod(&config_dir, 0o700);
    chmod(&ca_file, 0o664);
    assert_eq!(
        unsafe_check(granted.clone()),
        Some(NotReadyReason::BinaryUnsafe)
    );
    chmod(&ca_file, 0o644);
    let in_workspace = folder(&machine.root.join("workspace/space/.claude"), 0o700);
    let not_there = machine.root.join("home/.claude-gone");
    for env in [
        json!({ "CLAUDE_CONFIG_DIR": in_workspace }),
        json!({ "CLAUDE_CONFIG_DIR": not_there }),
        json!({ "CLAUDE_CONFIG_DIR": ca_file }),
        json!({ "NODE_EXTRA_CA_CERTS": config_dir }),
        json!({ "NODE_EXTRA_CA_CERTS": machine.root.join("workspace/space/ca.pem") }),
    ] {
        assert_eq!(
            unsafe_check(env.clone()),
            Some(NotReadyReason::BinaryUnsafe),
            "{env}"
        );
    }
    // Through the probe: the lane is not ready, and `claude` never ran.
    let lane =
        Lane::new(machine.grant_from(with_env(json!({ "CLAUDE_CONFIG_DIR": not_there })), trust));
    assert_eq!(
        lane.probe().await.reason(),
        Some(NotReadyReason::BinaryUnsafe)
    );
    assert!(machine.calls().is_empty());
}

#[test]
fn path_entries_come_in_order_once_and_only_when_they_pass_the_checks() {
    let machine = Machine::new();
    let tools = folder(&machine.root.join("workspace/space/tools"), 0o755);
    let writable = folder(&machine.root.join("writable"), 0o777);
    let homebrew = folder(&machine.root.join("homebrew/bin"), 0o755);
    let links = folder(&machine.root.join("links"), 0o755);
    std::os::unix::fs::symlink(&tools, links.join("tools")).unwrap();
    let path = std::env::join_paths([
        tools.clone(),
        PathBuf::from("relative/bin"),
        homebrew.clone(),
        writable,
        machine.root.join("missing"),
        links.join("tools"),
        machine.root.join("bin"),
        PathBuf::from("/usr/bin"),
    ])
    .unwrap();
    let grant = machine.grant_from(
        RawLaunchGrant {
            path: Some(path),
            ..machine.raw()
        },
        Trust::current(),
    );
    let launch = grant.check().unwrap();
    assert_eq!(
        lane_path(&grant, &launch),
        OsString::from(format!(
            "{}:{}:/usr/bin:/bin",
            machine.root.join("bin").display(),
            homebrew.display()
        ))
    );
}

#[tokio::test]
async fn the_turn_command_is_exact_and_no_bare_is_passed_only_when_listed() {
    let machine = Machine::new();
    let prompt = "Rename the `--help` flag in README.md\n\nnaïve résumé 🎉 $HOME \"quotes\" -p\r\n\ttrailing white space  \n";
    let space = machine.root.join("workspace/space");
    for (help, no_bare) in [("full", false), ("bare-will-become-default", true)] {
        machine.settings(&[("SCENARIO", "record-only"), ("HELP", help)]);
        let lane = machine.lane();
        let readiness = lane.probe().await;
        let ready = ready(&readiness);
        assert_eq!(ready.help().lists_no_bare(), no_bare);
        let mcp_config = McpConfigFile::create(lane.grant()).unwrap();
        let session = Uuid::new_v4();
        for resume in [None, Some(session)] {
            let before = machine.calls().len();
            let mut child = turn_command(lane.grant(), ready, &mcp_config, resume, &space)
                .spawn()
                .unwrap();
            write_prompt(child.stdin.take().unwrap(), prompt)
                .await
                .unwrap();
            assert!(child.wait().await.unwrap().success());
            let calls = machine.calls();
            assert_eq!(calls.len(), before + 1);
            let call = &calls[before];
            let mut expected: Vec<String> = [
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
            .map(String::from)
            .to_vec();
            expected.push(mcp_config.path().to_str().unwrap().to_string());
            expected.push("--include-partial-messages".into());
            if no_bare {
                expected.push("--no-bare".into());
            }
            if let Some(session) = resume {
                expected.push("--resume".into());
                expected.push(session.to_string());
            }
            assert_eq!(call.argv, expected);
            assert_eq!(call.stdin, prompt.as_bytes());
            assert_eq!(call.cwd, space);
            let environment: BTreeMap<String, String> =
                lane_environment(lane.grant(), ready.launch())
                    .into_iter()
                    .map(|(name, value)| {
                        (name.into_string().unwrap(), value.into_string().unwrap())
                    })
                    .collect();
            assert_eq!(call.env, environment);
        }
    }
}

// The process-wide capture, in child test processes.

const CHILD: &str = "INSTAFY_CLAUDE_CODE_LANE_TEST_CHILD";
const CHILD_ROOT: &str = "INSTAFY_CLAUDE_CODE_LANE_TEST_ROOT";

/// The launch environment of a Desktop runtime with a grant, and the poison the lane must keep
/// from its child: Anthropic and Claude sign-ins in shell variables, another
/// `CLAUDE_CONFIG_DIR` and proxy, the proxy key, Instafy's tokens, a project secret, and more.
fn launch_environment(machine: &Machine) -> Vec<(String, OsString)> {
    let root = &machine.root;
    let config_dir = folder(&root.join("home/.claude"), 0o700);
    let project = folder(&root.join("project"), 0o755);
    folder(&project.join("bin"), 0o755);
    folder(&root.join("workspace/tools"), 0o755);
    let path = std::env::join_paths([
        root.join("workspace/tools"),
        project.join("bin"),
        PathBuf::from("/usr/bin"),
    ])
    .unwrap();
    let env_json = json!({
        "CLAUDE_CONFIG_DIR": config_dir,
        "HTTPS_PROXY": "http://proxy.example:3128",
        "ANTHROPIC_BASE_URL": "http://gateway.example",
        "CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token",
    });
    let mut environment: Vec<(String, OsString)> = vec![
        (CHILD.into(), "1".into()),
        (CHILD_ROOT.into(), root.clone().into_os_string()),
        (BIN_ENV.into(), machine.bin().into_os_string()),
        (PATH_ENV.into(), path),
        (USER_ID_ENV.into(), USER_ID.into()),
        (ENV_JSON_ENV.into(), env_json.to_string().into()),
        ("WORKSPACE_DIR".into(), machine.workspace().into_os_string()),
        ("WORKSPACE_PROJECT_DIR".into(), project.into_os_string()),
        ("HOME".into(), root.join("home").into_os_string()),
        ("USER".into(), "person".into()),
        ("LOGNAME".into(), "person".into()),
        ("SHELL".into(), "/bin/zsh".into()),
        ("TMPDIR".into(), root.join("tmp").into_os_string()),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ];
    for (name, value) in [
        ("ANTHROPIC_API_KEY", "not-a-real-key"),
        ("ANTHROPIC_AUTH_TOKEN", "not-a-real-token"),
        ("ANTHROPIC_BASE_URL", "http://teammate-gateway.example"),
        ("CLAUDE_CODE_OAUTH_TOKEN", "not-a-real-token"),
        ("CLAUDE_CONFIG_DIR", "/elsewhere/.claude"),
        ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ("HTTPS_PROXY", "http://other-proxy.example:8080"),
        ("HTTP_PROXY", "http://other-proxy.example:8080"),
        ("NO_PROXY", "*"),
        ("ALL_PROXY", "socks5://other-proxy.example:1080"),
        ("NODE_OPTIONS", "--require /elsewhere/hook.js"),
        ("NODE_EXTRA_CA_CERTS", "/elsewhere/ca.pem"),
        ("OPENAI_API_KEY", "proxy-key"),
        ("OPENAI_BASE_URL", "http://127.0.0.1:9/v1"),
        ("CODEX_API_KEY", "proxy-key"),
        ("CODEX_HOME", "/elsewhere/.codex"),
        ("CONTROLLER_ACCESS_TOKEN", "controller-token"),
        ("RUNTIME_ACCESS_TOKEN", "runtime-token"),
        ("SPACE_ID", "e3f1b1f6-6b8d-4c63-a3a1-1d9b0c7e2f40"),
        ("INSTAFY_TURN_ID", "turn"),
        ("STRIPE_SECRET_KEY", "project-secret"),
        ("TERM", "xterm-256color"),
        ("LD_LIBRARY_PATH", "/nonexistent-instafy-test"),
    ] {
        environment.push((name.into(), value.into()));
    }
    environment
}

fn in_child(test: &str, environment: Vec<(String, OsString)>) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env_clear()
        .envs(environment)
        .output()
        .unwrap();
    assert!(
        output.status.success()
            && String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"),
        "the child test failed or did not run exactly once\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn child_root() -> Option<PathBuf> {
    std::env::var_os(CHILD)?;
    std::env::var_os(CHILD_ROOT).map(PathBuf::from)
}

fn captured_lane() -> &'static Lane {
    match claude_code::captured_launch_grant() {
        Some(CapturedGrant::Granted(lane)) => lane,
        Some(CapturedGrant::Unusable(reason)) => panic!("the capture refused the grant: {reason}"),
        Some(CapturedGrant::Absent) => panic!("the capture found no grant"),
        None => panic!("nothing ran the capture"),
    }
}

#[test]
fn the_capture_scrubs_the_grant_and_reports_the_capability_only_on_macos() {
    const TEST: &str = "the_capture_scrubs_the_grant_and_reports_the_capability_only_on_macos";
    let Some(root) = child_root() else {
        let machine = Machine::new();
        in_child(TEST, launch_environment(&machine));
        return;
    };

    // SAFETY: this child process runs only this test, so no other thread uses the environment.
    unsafe { claude_code::capture_and_scrub_launch_grant() };
    for key in LAUNCH_GRANT_ENV_KEYS {
        assert!(
            std::env::var_os(key).is_none(),
            "{key} stayed in the environment"
        );
    }
    assert!(std::env::var_os("WORKSPACE_DIR").is_some());
    let lane = captured_lane();
    assert_eq!(lane.grant().user_id(), Uuid::parse_str(USER_ID).unwrap());
    assert_eq!(lane.grant().binary(), root.join("bin/claude"));
    assert_eq!(
        lane.grant().confinement().roots(),
        [root.join("workspace"), root.join("project")]
    );

    // The capability exists only on macOS (D18), and never holds a path. A leased lane job runs
    // on the captured lane there, and elsewhere fails as `binary_missing`.
    let capability = claude_code::registration_capability();
    if cfg!(target_os = "macos") {
        assert_eq!(
            capability,
            Some(json!({
                "version": 1,
                "ready": true,
                "cli": "2.1.314",
                "verified": true,
                "planSignIn": true,
                "partialMessages": true,
            }))
        );
        assert!(claude_code::lane().is_some());
        assert!(
            matches!(claude_code::lane_for_jobs(), Ok(lane) if std::ptr::eq(lane, captured_lane()))
        );
    } else {
        assert_eq!(capability, None);
        assert!(claude_code::lane().is_none());
        assert!(matches!(
            claude_code::lane_for_jobs(),
            Err(NotReadyReason::BinaryMissing)
        ));
    }

    // A second capture keeps the first, and still scrubs.
    // SAFETY: as above.
    unsafe {
        std::env::set_var(BIN_ENV, "/elsewhere/claude");
        claude_code::capture_and_scrub_launch_grant();
    }
    assert!(std::env::var_os(BIN_ENV).is_none());
    assert_eq!(captured_lane().grant().binary(), root.join("bin/claude"));
}

#[test]
fn the_child_gets_only_the_allowlist_whatever_the_process_environment_holds() {
    const TEST: &str = "the_child_gets_only_the_allowlist_whatever_the_process_environment_holds";
    let Some(root) = child_root() else {
        let machine = Machine::new();
        in_child(TEST, launch_environment(&machine));
        return;
    };

    // SAFETY: this child process runs only this test, so no other thread uses the environment.
    unsafe { claude_code::capture_and_scrub_launch_grant() };
    // What the process environment may hold by the time a turn runs: other jobs' granted
    // secrets, the proxy key, a controller token, a lost or replaced HOME, a new TMPDIR.
    // SAFETY: as above.
    unsafe {
        std::env::set_var("HOME", "/poisoned-home");
        std::env::set_var("TMPDIR", "/poisoned-tmp");
        std::env::set_var("PATH", "/poisoned/bin:/usr/bin:/bin");
        std::env::set_var("CLAUDE_CONFIG_DIR", "/poisoned/.claude");
        std::env::set_var("ANTHROPIC_API_KEY", "not-a-real-key");
        std::env::set_var("OPENAI_API_KEY", "proxy-key");
        std::env::set_var("CONTROLLER_ACCESS_TOKEN", "controller-token");
        std::env::set_var("DATABASE_URL", "project-secret");
    }
    let expected: BTreeMap<String, String> = [
        ("HOME", root.join("home").display().to_string()),
        ("USER", "person".to_string()),
        ("LOGNAME", "person".to_string()),
        ("SHELL", "/bin/zsh".to_string()),
        ("TMPDIR", root.join("tmp").display().to_string()),
        ("LANG", "en_US.UTF-8".to_string()),
        (
            "CLAUDE_CONFIG_DIR",
            root.join("home/.claude").display().to_string(),
        ),
        ("HTTPS_PROXY", "http://proxy.example:3128".to_string()),
        (
            "PATH",
            format!("{}:/usr/bin:/bin", root.join("bin").display()),
        ),
        ("ENABLE_CLAUDEAI_MCP_SERVERS", "false".to_string()),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value))
    .collect();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let lane = captured_lane();
        let readiness = lane.probe().await;
        let ready = ready(&readiness);
        let probe_calls = recorded_calls(&root);
        assert_eq!(probe_calls.len(), 3);
        for call in &probe_calls {
            assert_eq!(call.env, expected, "{:?}", call.argv);
        }

        let mcp_config = McpConfigFile::create(lane.grant()).unwrap();
        let space = root.join("workspace/space");
        let session = Uuid::new_v4();
        let prompt = "Fix the failing test\n";
        let mut child = turn_command(lane.grant(), ready, &mcp_config, Some(session), &space)
            .spawn()
            .unwrap();
        write_prompt(child.stdin.take().unwrap(), prompt)
            .await
            .unwrap();
        assert!(child.wait().await.unwrap().success());
        let calls = recorded_calls(&root);
        let turn = calls.last().unwrap();
        assert_eq!(turn.argv[0], "--print");
        assert_eq!(
            turn.argv[turn.argv.len() - 2..],
            ["--resume".to_string(), session.to_string()]
        );
        assert_eq!(turn.stdin, prompt.as_bytes());
        assert_eq!(turn.cwd, space);
        assert_eq!(turn.env, expected);
        assert!(mcp_config.path().starts_with(root.join("tmp")));
    });
}

#[test]
fn a_personal_browser_runtime_reports_no_capability() {
    const TEST: &str = "a_personal_browser_runtime_reports_no_capability";
    if child_root().is_none() {
        let machine = Machine::new();
        let mut environment = launch_environment(&machine);
        environment.extend([
            (
                "INSTAFY_PERSONAL_BROWSER_CONTROL_URL".to_string(),
                OsString::from("http://127.0.0.1:9/"),
            ),
            (
                "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN".to_string(),
                OsString::from("broker-token"),
            ),
            (
                "INSTAFY_PERSONAL_BROWSER_PROJECT_ID".to_string(),
                OsString::from(Uuid::new_v4().to_string()),
            ),
            (
                "INSTAFY_RUNTIME_AGENT_BIN".to_string(),
                std::env::current_exe().unwrap().into_os_string(),
            ),
        ]);
        in_child(TEST, environment);
        return;
    }

    runtime_agent::personal_browser::capture_and_scrub_process_capability()
        .expect("a complete Personal Browser capability");
    // SAFETY: this child process runs only this test, so no other thread uses the environment.
    unsafe { claude_code::capture_and_scrub_launch_grant() };
    for key in LAUNCH_GRANT_ENV_KEYS {
        assert!(
            std::env::var_os(key).is_none(),
            "{key} stayed in the environment"
        );
    }
    assert!(matches!(
        claude_code::captured_launch_grant(),
        Some(CapturedGrant::Granted(_))
    ));
    assert_eq!(claude_code::registration_capability(), None);
    assert!(claude_code::lane().is_none());
    // A lane job leased here anyway runs nothing.
    assert!(matches!(
        claude_code::lane_for_jobs(),
        Err(NotReadyReason::BinaryMissing)
    ));
}

/// A malformed grant (a binary path that is not absolute) is no lane: where the lane is offered,
/// the capability and a leased lane job say why; elsewhere there is no capability, and a lane job
/// fails as `binary_missing`.
#[test]
fn a_malformed_grant_gives_its_reason_where_the_lane_is_offered() {
    const TEST: &str = "a_malformed_grant_gives_its_reason_where_the_lane_is_offered";
    if child_root().is_none() {
        let machine = Machine::new();
        let mut environment = launch_environment(&machine);
        for (name, value) in &mut environment {
            if name.as_str() == BIN_ENV {
                *value = OsString::from("bin/claude");
            }
        }
        in_child(TEST, environment);
        return;
    }

    // SAFETY: this child process runs only this test, so no other thread uses the environment.
    unsafe { claude_code::capture_and_scrub_launch_grant() };
    for key in LAUNCH_GRANT_ENV_KEYS {
        assert!(
            std::env::var_os(key).is_none(),
            "{key} stayed in the environment"
        );
    }
    assert!(matches!(
        claude_code::captured_launch_grant(),
        Some(CapturedGrant::Unusable(NotReadyReason::BinaryUnsafe))
    ));
    assert!(claude_code::lane().is_none());
    if cfg!(target_os = "macos") {
        assert_eq!(
            claude_code::registration_capability(),
            Some(json!({ "version": 1, "ready": false, "reason": "binary_unsafe" }))
        );
        assert!(matches!(
            claude_code::lane_for_jobs(),
            Err(NotReadyReason::BinaryUnsafe)
        ));
    } else {
        assert_eq!(claude_code::registration_capability(), None);
        assert!(matches!(
            claude_code::lane_for_jobs(),
            Err(NotReadyReason::BinaryMissing)
        ));
    }
}

/// Desktop granted nothing: no capability, no lane, and a lane job leased anyway fails as
/// `binary_missing`.
#[test]
fn without_a_grant_there_is_no_lane() {
    const TEST: &str = "without_a_grant_there_is_no_lane";
    if child_root().is_none() {
        let machine = Machine::new();
        let mut environment = launch_environment(&machine);
        environment.retain(|(name, _)| !LAUNCH_GRANT_ENV_KEYS.contains(&name.as_str()));
        in_child(TEST, environment);
        return;
    }

    // SAFETY: this child process runs only this test, so no other thread uses the environment.
    unsafe { claude_code::capture_and_scrub_launch_grant() };
    assert!(matches!(
        claude_code::captured_launch_grant(),
        Some(CapturedGrant::Absent)
    ));
    assert_eq!(claude_code::registration_capability(), None);
    assert!(claude_code::lane().is_none());
    assert!(matches!(
        claude_code::lane_for_jobs(),
        Err(NotReadyReason::BinaryMissing)
    ));
    // The calls a probe would have made: none.
    assert!(recorded_calls(&child_root().unwrap()).is_empty());
}
