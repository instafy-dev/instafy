//! The local-engine lane before a turn runs (docs/Local-Engine-Turns.md, section 8): the capture
//! of Desktop's launch grant, the probe of the granted `claude` and of each of the person's Claude
//! Code logins (11.19), the capability and the plan limit's hold of a login (11.11), and the exact
//! command and environment each login's child gets.
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
    self, BIN_ENV, CapturedGrant, Confinement, ENV_JSON_ENV, ExecutionMode, LAUNCH_GRANT_ENV_KEYS,
    LOGINS_JSON_ENV, Lane, LaunchEnvSnapshot, LaunchGrant, NotReadyReason, PATH_ENV,
    RawLaunchGrant, Readiness, Trust, USER_ID_ENV,
};
use serde_json::{Value, json};
use uuid::Uuid;

const FAKE_CLAUDE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude");
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/fake-claude-fixtures"
);
const USER_ID: &str = "6f1c2f6e-9d8a-4f7b-8f61-3c1f0a2b4d5e";
/// The person's login in a folder of its own, `home/.claude-work`, the first the grant names.
/// Its id and [`USUAL`]'s are the ones runtime-contracts' `capability` fixture lists.
const WORK: &str = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";
/// The person's login in Claude Code's usual folder: its child gets no `CLAUDE_CONFIG_DIR`.
const USUAL: &str = "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02";
/// A third login, in `home/.claude-personal`, for the tests that need two folders of their own.
const PERSONAL: &str = "3c9d7e15-2a4b-4e8f-9c6d-1b2a3f4e5d06";

fn id(login: &str) -> Uuid {
    Uuid::parse_str(login).unwrap()
}

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

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../runtime-contracts/src/claude_code_lane_fixtures.json"
    ))
    .expect("the lane fixtures are JSON")
}

/// One call of the fake, as it recorded it.
#[derive(Debug)]
struct Call {
    argv: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: PathBuf,
    stdin: Vec<u8>,
}

impl Call {
    /// The `CLAUDE_CONFIG_DIR` the call ran with: its login's folder, none for the usual folder.
    fn config_dir(&self) -> Option<&str> {
        self.env.get("CLAUDE_CONFIG_DIR").map(String::as_str)
    }
}

/// What `/bin/sh` itself exports, and the wrapper's settings for the fake.
fn is_shell_or_fake_setting(name: &str) -> bool {
    matches!(name, "PWD" | "OLDPWD" | "SHLVL" | "_") || name.starts_with("FAKE_CLAUDE_")
}

/// A temporary computer: the granted `claude` (a wrapper that sets the fake's settings and execs
/// it), a workspace, a home with the folder of the person's work login, a temporary folder, and
/// the record of the fake's calls.
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
            ("home/.claude-work", 0o700),
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

    /// The folder of the [`WORK`] login.
    fn work_folder(&self) -> PathBuf {
        self.root.join("home/.claude-work")
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

    /// The `auth status` answer of the login whose folder is `folder` (the fake's
    /// `fake-claude-auth`), in place of `FAKE_CLAUDE_AUTH`.
    fn answer_for(&self, folder: &Path, answer: &str) {
        std::fs::write(folder.join("fake-claude-auth"), answer).unwrap();
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

    /// `INSTAFY_CLAUDE_CODE_LOGINS_JSON` with the [`WORK`] login, then the [`USUAL`] one.
    fn logins_json(&self) -> OsString {
        json!([
            { "id": WORK, "configDir": self.work_folder() },
            { "id": USUAL, "configDir": null },
        ])
        .to_string()
        .into()
    }

    fn raw(&self) -> RawLaunchGrant {
        RawLaunchGrant {
            bin: Some(self.bin().into_os_string()),
            path: None,
            user_id: Some(USER_ID.into()),
            env_json: None,
            logins_json: Some(self.logins_json()),
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

/// The capability of a machine's grant whose program and two logins are ready, each signed in
/// with a Claude plan (the fake's default answer).
fn ready_capability() -> Value {
    json!({
        "version": 2,
        "ready": true,
        "cli": "2.1.325",
        "verified": true,
        "partialMessages": true,
        "logins": {
            WORK: { "ready": true, "planSignIn": true, "signedIn": true },
            USUAL: { "ready": true, "planSignIn": true, "signedIn": true },
        },
    })
}

/// The capability of a machine's grant whose program is not ready for `reason` before any login's
/// `auth status` ran: each login carries the program's reason.
fn not_ready_capability(reason: &str) -> Value {
    json!({
        "version": 2,
        "ready": false,
        "reason": reason,
        "logins": {
            WORK: { "ready": false, "reason": reason, "planSignIn": false },
            USUAL: { "ready": false, "reason": reason, "planSignIn": false },
        },
    })
}

/// The startup and timed probe (3.2, 11.19): `--version` and `--help` once for the program, in
/// the first login's environment, then `auth status` once for each login, at the same time, each
/// with its own `CLAUDE_CONFIG_DIR` and nothing else changed; and the version 2 capability they
/// give.
#[tokio::test]
async fn a_supported_claude_gives_the_ready_capability_from_one_program_probe_and_each_logins_sign_in()
 {
    let machine = Machine::new();
    let lane = machine.lane();
    assert!(lane.probe_and_publish_all().await);
    assert_eq!(lane.capability(), Some(ready_capability()));
    let calls = machine.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.argv.clone())
            .collect::<Vec<_>>(),
        args(&[
            &["--version"],
            &["--help"],
            &["auth", "status"],
            &["auth", "status"]
        ])
    );
    let work = machine.work_folder().display().to_string();
    for call in &calls[..2] {
        assert_eq!(call.config_dir(), Some(work.as_str()), "{:?}", call.argv);
    }
    let mut folders: Vec<Option<&str>> = calls[2..].iter().map(Call::config_dir).collect();
    folders.sort();
    assert_eq!(folders, [None, Some(work.as_str())]);
    let without_folder = |call: &Call| {
        let mut env = call.env.clone();
        env.remove("CLAUDE_CONFIG_DIR");
        env
    };
    for call in &calls[1..] {
        assert_eq!(without_folder(call), without_folder(&calls[0]));
    }
    let tmp = machine.root.join("tmp");
    let mut cwds = BTreeSet::new();
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
        cwds.insert(call.cwd.clone());
    }
    assert_eq!(cwds.len(), calls.len());
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
        assert!(lane.probe_and_publish_all().await);
        assert_eq!(
            lane.capability(),
            Some(not_ready_capability(reason.as_str())),
            "{settings:?}"
        );
        // A turn's probe on either login says the program's reason.
        for login in [WORK, USUAL] {
            assert_eq!(lane.probe(id(login)).await.reason(), Some(reason));
        }
    }

    // A probe command that outlives its limit is killed, and the probe fails.
    for answer in ["VERSION", "HELP"] {
        machine.settings(&[(answer, "hang")]);
        let lane = machine
            .lane()
            .with_probe_timeout(Duration::from_millis(300));
        let started = std::time::Instant::now();
        assert_eq!(
            lane.probe(id(WORK)).await.reason(),
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
        Lane::new(grant).probe(id(WORK)).await.reason(),
        Some(NotReadyReason::BinaryMissing)
    );

    chmod(&machine.bin(), 0o757);
    let lane = machine.lane();
    assert_eq!(
        lane.probe(id(USUAL)).await.reason(),
        Some(NotReadyReason::BinaryUnsafe)
    );
    assert!(lane.probe_and_publish_all().await);
    assert_eq!(
        lane.capability(),
        Some(not_ready_capability("binary_unsafe"))
    );
    chmod(&machine.bin(), 0o755);
    assert!(machine.lane().probe(id(WORK)).await.is_ready());
}

#[tokio::test]
async fn a_flag_missing_from_help_is_logged_and_does_not_fail_the_probe() {
    let machine = Machine::new();
    machine.settings(&[("HELP", "missing-flags")]);
    let readiness = machine.lane().probe(id(WORK)).await;
    assert_eq!(
        ready(&readiness).help().missing_flags(),
        ["--permission-prompts", "--include-partial-messages"]
    );
}

/// Each login has its own sign-in (3.2, 11.19): `planSignIn` only for a Claude plan sign-in, and
/// `signedIn` by how `auth status` exited, true for 0, false for 1, and absent when the probe
/// could not tell. Neither ever makes a login not ready.
#[tokio::test]
async fn plan_sign_in_and_signed_in_are_each_logins_own() {
    let machine = Machine::new();
    for (auth, plan, signed_in) in [
        ("claude-ai", true, Some(true)),
        ("oauth-token", true, Some(true)),
        ("api-key", false, Some(true)),
        ("signed-out", false, Some(false)),
        ("unreadable", false, None),
    ] {
        machine.answer_for(&machine.work_folder(), auth);
        let lane = machine.lane();
        let readiness = lane.probe(id(WORK)).await;
        assert_eq!(ready(&readiness).plan_sign_in(), plan, "{auth}");
        assert_eq!(ready(&readiness).signed_in(), signed_in, "{auth}");
    }

    // One login signed out and the other signed in with a Claude plan, in one probe.
    machine.answer_for(&machine.work_folder(), "signed-out");
    let lane = machine.lane();
    assert!(lane.probe_and_publish_all().await);
    let capability = lane.capability().unwrap();
    assert_eq!(capability["ready"], true);
    assert_eq!(
        capability["logins"][WORK],
        json!({ "ready": true, "planSignIn": false, "signedIn": false })
    );
    assert_eq!(
        capability["logins"][USUAL],
        json!({ "ready": true, "planSignIn": true, "signedIn": true })
    );

    // A sign-in check that cannot finish says nothing about a plan or a sign-in; the login stays
    // ready.
    machine.answer_for(&machine.work_folder(), "hang");
    let lane = machine
        .lane()
        .with_probe_timeout(Duration::from_millis(300));
    let readiness = lane.probe(id(WORK)).await;
    assert!(!ready(&readiness).plan_sign_in());
    assert_eq!(ready(&readiness).signed_in(), None);
}

#[tokio::test]
async fn verified_holds_only_up_to_the_contract_constant() {
    let machine = Machine::new();
    let supported = machine.lane().probe(id(WORK)).await;
    assert!(ready(&supported).verified());
    machine.settings(&[("VERSION", "newer")]);
    let lane = machine.lane();
    let newer = lane.probe_and_publish(id(WORK)).await.readiness;
    assert_eq!(ready(&newer).cli().to_string(), "2.1.400");
    assert!(!ready(&newer).verified());
    assert_eq!(lane.capability().unwrap()["verified"], json!(false));
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

    assert!(lane.probe(id(WORK)).await.is_ready());
    assert_eq!(help_calls(&machine.calls_since(0)), 1);

    // Another login's probe reads the same help: it belongs to the program.
    let before = machine.calls().len();
    assert!(lane.probe(id(USUAL)).await.is_ready());
    assert_eq!(
        machine.calls_since(before),
        args(&[&["--version"], &["auth", "status"]])
    );

    // Another version.
    machine.settings(&[("VERSION", "newer")]);
    let before = machine.calls().len();
    assert!(lane.probe(id(WORK)).await.is_ready());
    assert_eq!(help_calls(&machine.calls_since(before)), 1);
    let before = machine.calls().len();
    lane.probe(id(WORK)).await;
    assert_eq!(help_calls(&machine.calls_since(before)), 0);

    // The same version from a binary of another size.
    machine.install_wrapper(&machine.bin(), "an update");
    let before = machine.calls().len();
    assert!(lane.probe(id(WORK)).await.is_ready());
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
    assert!(lane.probe(id(WORK)).await.is_ready());
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
    let first = linked.probe(id(WORK)).await;
    assert_eq!(ready(&first).launch().program(), machine.bin());
    let second_target = machine.root.join("bin/claude-2");
    machine.install_wrapper(&second_target, "");
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&second_target, &link).unwrap();
    let before = machine.calls().len();
    let second = linked.probe(id(WORK)).await;
    assert_eq!(ready(&second).launch().program(), second_target);
    assert_eq!(help_calls(&machine.calls_since(before)), 1);
}

/// A turn's probe covers the program and its own login (3.2, 11.19): one that disagrees with the
/// capability publishes it to register again. The person's other login keeps what it had.
#[tokio::test]
async fn a_per_turn_probe_that_disagrees_publishes_the_capability_to_register_again() {
    let machine = Machine::new();
    let lane = machine.lane();
    let mut updates = lane.subscribe();
    assert!(lane.probe_and_publish(id(WORK)).await.capability_changed);
    assert_eq!(
        updates.borrow_and_update().as_ref().unwrap()["logins"][WORK]["planSignIn"],
        json!(true)
    );

    // A turn's probe that agrees changes nothing.
    assert!(!lane.probe_and_publish(id(WORK)).await.capability_changed);
    assert!(!updates.has_changed().unwrap());

    // The person signed out of that login since the runtime registered.
    machine.answer_for(&machine.work_folder(), "signed-out");
    let probe = lane.probe_and_publish(id(WORK)).await;
    assert!(probe.readiness.is_ready());
    assert!(probe.capability_changed);
    assert!(updates.has_changed().unwrap());
    let logins = updates.borrow_and_update().as_ref().unwrap()["logins"].clone();
    assert_eq!(
        logins[WORK],
        json!({ "ready": true, "planSignIn": false, "signedIn": false })
    );
    // No probe asked the other login's `auth status` yet.
    assert_eq!(logins[USUAL], json!({ "ready": true, "planSignIn": false }));

    // Claude Code was replaced by a version the lane does not run: neither login is ready.
    machine.settings(&[("VERSION", "old")]);
    let probe = lane.probe_and_publish(id(USUAL)).await;
    assert_eq!(
        probe.readiness.reason(),
        Some(NotReadyReason::UnsupportedVersion)
    );
    assert!(probe.capability_changed);
    assert_eq!(
        lane.capability(),
        Some(json!({
            "version": 2,
            "ready": false,
            "reason": "unsupported_version",
            "logins": {
                WORK: {
                    "ready": false,
                    "reason": "unsupported_version",
                    "planSignIn": false,
                    "signedIn": false,
                },
                USUAL: { "ready": false, "reason": "unsupported_version", "planSignIn": false },
            },
        }))
    );
}

#[tokio::test]
async fn while_not_ready_a_timed_probe_publishes_once_the_result_changes() {
    let machine = Machine::new();
    machine.settings(&[("VERSION", "old")]);
    let lane = Arc::new(machine.lane());
    assert!(lane.probe_and_publish_all().await);
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
        updates.borrow_and_update().clone(),
        Some(ready_capability())
    );

    // Once ready, the timer leaves the probing to the turns.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let settled = machine.calls().len();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(machine.calls().len(), settled);
    reprobes.abort();
}

/// A login whose folder fails its checks is not ready, as `binary_unsafe`, and only it (11.19):
/// the program and the other login stay ready, nothing runs with that folder, and the timed probe
/// notices once the person fixes it. When every login's folder fails, nothing runs at all.
#[tokio::test]
async fn a_login_whose_folder_fails_its_checks_is_the_only_one_not_ready_until_it_passes() {
    let machine = Machine::new();
    chmod(&machine.work_folder(), 0o770);
    let lane = Arc::new(machine.lane());
    assert!(lane.probe_and_publish_all().await);
    let capability = lane.capability().unwrap();
    assert_eq!(capability["ready"], true, "{capability}");
    assert_eq!(capability["cli"], "2.1.325");
    assert_eq!(
        capability["logins"][WORK],
        json!({ "ready": false, "reason": "binary_unsafe", "planSignIn": false })
    );
    assert_eq!(
        capability["logins"][USUAL],
        json!({ "ready": true, "planSignIn": true, "signedIn": true })
    );
    // The program's commands ran in the other login's environment, and nothing in this one's.
    let calls = machine.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.argv.clone())
            .collect::<Vec<_>>(),
        args(&[&["--version"], &["--help"], &["auth", "status"]])
    );
    assert!(calls.iter().all(|call| call.config_dir().is_none()));
    // A turn's probe on it fails before anything runs.
    let before = machine.calls().len();
    assert_eq!(
        lane.probe(id(WORK)).await.reason(),
        Some(NotReadyReason::BinaryUnsafe)
    );
    assert_eq!(machine.calls().len(), before);

    let mut updates = lane.subscribe();
    updates.borrow_and_update();
    let reprobes = tokio::spawn({
        let lane = lane.clone();
        async move {
            lane.reprobe_while_not_ready(Duration::from_millis(50))
                .await
        }
    });
    chmod(&machine.work_folder(), 0o700);
    tokio::time::timeout(Duration::from_secs(10), updates.changed())
        .await
        .expect("a timed probe published the fixed folder")
        .unwrap();
    assert_eq!(
        updates.borrow_and_update().clone(),
        Some(ready_capability())
    );
    reprobes.abort();

    // A grant whose every login's folder fails its checks runs nothing, and the program is not
    // ready either.
    chmod(&machine.work_folder(), 0o770);
    let only_work = Lane::new(
        machine.grant_from(
            RawLaunchGrant {
                logins_json: Some(
                    json!([{ "id": WORK, "configDir": machine.work_folder() }])
                        .to_string()
                        .into(),
                ),
                ..machine.raw()
            },
            Trust::current(),
        ),
    );
    let before = machine.calls().len();
    assert!(only_work.probe_and_publish_all().await);
    assert_eq!(
        only_work.capability(),
        Some(json!({
            "version": 2,
            "ready": false,
            "reason": "binary_unsafe",
            "logins": {
                WORK: { "ready": false, "reason": "binary_unsafe", "planSignIn": false },
            },
        }))
    );
    assert_eq!(machine.calls().len(), before, "nothing ran");
    chmod(&machine.work_folder(), 0o700);
}

/// After a turn on a login failed at its Claude plan's limit, that login holds until the limit
/// resets (11.11, 11.19): the capability says it is not ready, as `plan_limit` with the reset
/// time, which registers again; a probe of it meanwhile runs nothing and says so, while the
/// person's other login stays ready and its turns' probes run; and at the reset time the timed
/// probe probes that login again, and only it, and publishes what it finds, here ready, which
/// registers again. A hold that starts while the timed probe waits wakes it, however long its
/// interval.
#[tokio::test]
async fn a_plan_limit_holds_its_login_until_its_reset_time_and_the_other_login_runs_on() {
    let machine = Machine::new();
    let lane = Arc::new(machine.lane());
    assert!(lane.probe_and_publish_all().await);
    let ready = lane.capability().unwrap();
    assert_eq!(ready, ready_capability());
    let mut updates = lane.subscribe();
    updates.borrow_and_update();
    let reprobes = tokio::spawn({
        let lane = lane.clone();
        async move { lane.reprobe_while_not_ready(Duration::from_secs(600)).await }
    });

    // A reset time two seconds ahead.
    let resets_at = chrono::Utc::now().timestamp() + 2;
    let hold = lane
        .hold_for_plan_limit(id(WORK), Some(resets_at))
        .expect("a hold");
    assert_eq!(hold.resets_at().timestamp(), resets_at);
    assert!(updates.has_changed().unwrap());
    let held = updates.borrow_and_update().clone().unwrap();
    let mut expected = ready.clone();
    expected["logins"][WORK] = json!({
        "ready": false,
        "reason": "plan_limit",
        "resetsAt": hold.resets_at().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "planSignIn": true,
        "signedIn": true,
    });
    assert_eq!(held, expected);
    assert!(
        held["logins"][WORK]["resetsAt"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    assert_eq!(lane.plan_limit_hold(id(WORK)), Some(hold));
    assert_eq!(lane.plan_limit_hold(id(USUAL)), None);

    // Meanwhile a turn's probe of that login runs nothing, says the limit holds, and changes
    // nothing.
    let before = machine.calls().len();
    let probe = lane.probe_and_publish(id(WORK)).await;
    assert!(matches!(probe.readiness, Readiness::Held(found) if found == hold));
    assert_eq!(probe.readiness.reason(), Some(NotReadyReason::PlanLimit));
    assert!(!probe.capability_changed);
    assert_eq!(machine.calls().len(), before, "nothing was probed");
    // The person's other login is ready, and its turns' probes run.
    let probe = lane.probe_and_publish(id(USUAL)).await;
    assert!(probe.readiness.is_ready());
    assert!(!probe.capability_changed);
    let after_usual = machine.calls().len();
    assert!(after_usual > before, "the other login's probe ran");

    // At the reset time the timed probe probes that login again, long before its interval.
    tokio::time::timeout(Duration::from_secs(20), updates.changed())
        .await
        .expect("the login was probed again at the reset time")
        .unwrap();
    assert!(chrono::Utc::now().timestamp() >= resets_at);
    assert_eq!(updates.borrow_and_update().clone(), Some(ready));
    assert_eq!(lane.plan_limit_hold(id(WORK)), None);
    let reprobed = &machine.calls()[after_usual..];
    let work = machine.work_folder().display().to_string();
    assert!(
        reprobed
            .iter()
            .any(|call| call.argv == ["auth", "status"] && call.config_dir() == Some(work.as_str())),
        "{reprobed:?}"
    );
    assert!(
        reprobed
            .iter()
            .all(|call| call.config_dir() == Some(work.as_str())),
        "only that login was probed: {reprobed:?}"
    );

    // A reset time that has passed holds nothing, and publishes nothing.
    assert_eq!(
        lane.hold_for_plan_limit(id(WORK), Some(resets_at - 60)),
        None
    );
    assert!(!updates.has_changed().unwrap());
    // Without a reset time, the hold is an hour; one further ahead than a week is a week.
    let now = chrono::Utc::now().timestamp();
    let hour = lane.hold_for_plan_limit(id(USUAL), None).expect("a hold");
    assert!((now + 3_600..=now + 3_602).contains(&hour.resets_at().timestamp()));
    let week = lane
        .hold_for_plan_limit(id(USUAL), Some(now + 30 * 24 * 3_600))
        .expect("a hold");
    assert!(
        (now + 7 * 24 * 3_600..=now + 7 * 24 * 3_600 + 2).contains(&week.resets_at().timestamp())
    );
    assert_eq!(lane.plan_limit_hold(id(USUAL)), Some(week));
    let capability = lane.capability().unwrap();
    assert_eq!(capability["logins"][USUAL]["reason"], "plan_limit");
    assert_eq!(capability["logins"][WORK]["ready"], true);
    reprobes.abort();
}

/// A runtime with two logins, one held by its plan's limit, reports the capability runtime-contracts
/// records (11.19), with that hold's own reset time.
#[tokio::test]
async fn two_logins_one_held_give_the_capability_runtime_contracts_records() {
    let machine = Machine::new();
    let lane = machine.lane();
    assert!(lane.probe_and_publish_all().await);
    let hold = lane
        .hold_for_plan_limit(id(USUAL), Some(chrono::Utc::now().timestamp() + 3_600))
        .expect("a hold");
    let mut capability = fixtures()["capability"].clone();
    capability["logins"][USUAL]["resetsAt"] = json!(hold.resets_at_rfc3339());
    assert_eq!(lane.capability(), Some(capability));
}

/// The runtime registers, and so takes any turn, Codex's too, only once the startup probe ended:
/// its commands share one limit, the limit of one command, and a probe that runs out of it is
/// `probe_failed`, which the timed re-probe corrects (3.2). A turn's probe keeps a limit for each
/// command.
#[tokio::test]
async fn the_startup_probe_has_one_limit_for_all_its_commands() {
    let machine = Machine::new();
    let limit = Duration::from_secs(3);
    // The limit, the last command's kill and a busy machine's slack.
    let at_most = limit + Duration::from_secs(3);

    // A sign-in check that never finishes.
    machine.settings(&[("AUTH", "hang")]);
    let lane = machine.lane().with_probe_timeout(limit);
    let started = std::time::Instant::now();
    assert!(lane.probe_and_publish_at_startup().await);
    assert!(started.elapsed() < at_most, "{:?}", started.elapsed());
    assert_eq!(
        lane.capability(),
        Some(not_ready_capability("probe_failed"))
    );
    // A turn's probe waits out the sign-in check alone, and finds its login ready.
    let readiness = lane.probe(id(WORK)).await;
    assert!(!ready(&readiness).plan_sign_in());

    // Commands that each finish within the limit, but not all within it.
    machine.settings(&[("PROBE_DELAY", "1")]);
    let lane = machine.lane().with_probe_timeout(limit);
    let started = std::time::Instant::now();
    assert!(lane.probe_and_publish_at_startup().await);
    assert!(started.elapsed() < at_most, "{:?}", started.elapsed());
    assert_eq!(
        lane.capability(),
        Some(not_ready_capability("probe_failed"))
    );
    assert!(lane.probe_and_publish_all().await);
    assert_eq!(lane.capability().unwrap()["ready"], true);

    // A claude that answers in time is ready at startup.
    machine.settings(&[]);
    let lane = machine.lane().with_probe_timeout(limit);
    assert!(lane.probe_and_publish_at_startup().await);
    assert_eq!(lane.capability(), Some(ready_capability()));
}

/// The logins' sign-in checks run side by side within the startup probe's one limit (11.19): two
/// that each take most of it end within it together, where one after the other they would not.
#[tokio::test]
async fn the_startup_probe_runs_each_logins_sign_in_check_side_by_side() {
    let machine = Machine::new();
    let personal = folder(&machine.root.join("home/.claude-personal"), 0o700);
    for login_folder in [machine.work_folder(), personal.clone()] {
        std::fs::write(login_folder.join("fake-claude-auth-delay"), "3").unwrap();
    }
    let lane = Lane::new(
        machine.grant_from(
            RawLaunchGrant {
                logins_json: Some(
                    json!([
                        { "id": WORK, "configDir": machine.work_folder() },
                        { "id": PERSONAL, "configDir": personal },
                    ])
                    .to_string()
                    .into(),
                ),
                ..machine.raw()
            },
            Trust::current(),
        ),
    )
    .with_probe_timeout(Duration::from_secs(5));
    let started = std::time::Instant::now();
    assert!(lane.probe_and_publish_at_startup().await);
    let elapsed = started.elapsed();
    let capability = lane.capability().unwrap();
    assert_eq!(capability["ready"], true, "{capability} after {elapsed:?}");
    for login in [WORK, PERSONAL] {
        assert_eq!(
            capability["logins"][login],
            json!({ "ready": true, "planSignIn": true, "signedIn": true }),
            "{elapsed:?}"
        );
    }
    assert!(elapsed >= Duration::from_secs(3), "{elapsed:?}");
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

/// A granted CA file that fails its checks makes the program unsafe, every login with it; a
/// login's folder gets the checks a granted `CLAUDE_CONFIG_DIR` got (D26), and one that fails
/// them makes only its own login not ready (11.19). A `CLAUDE_CONFIG_DIR` in
/// `INSTAFY_CLAUDE_CODE_ENV_JSON` is ignored: never checked, never passed.
#[tokio::test]
async fn a_ca_file_that_fails_its_checks_makes_the_program_unsafe_and_a_folder_only_its_login() {
    let machine = Machine::new();
    let config_dir = machine.work_folder();
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
    let in_workspace = folder(&machine.root.join("workspace/space/.claude"), 0o700);
    let granted = json!({
        "NODE_EXTRA_CA_CERTS": ca_file,
        "HTTPS_PROXY": "http://proxy.example:3128",
        "ANTHROPIC_BASE_URL": "http://gateway.example",
        "CLAUDE_CONFIG_DIR": in_workspace,
    });
    let launch = machine
        .grant_from(with_env(granted.clone()), trust)
        .check()
        .unwrap();
    assert_eq!(
        launch.granted_env(),
        [
            ("HTTPS_PROXY", OsString::from("http://proxy.example:3128")),
            ("NODE_EXTRA_CA_CERTS", ca_file.clone().into_os_string()),
        ]
    );

    let program_check = |env: Value| machine.grant_from(with_env(env), trust).check().err();
    chmod(&ca_file, 0o664);
    assert_eq!(
        program_check(granted.clone()),
        Some(NotReadyReason::BinaryUnsafe)
    );
    chmod(&ca_file, 0o644);
    for env in [
        json!({ "NODE_EXTRA_CA_CERTS": config_dir }),
        json!({ "NODE_EXTRA_CA_CERTS": machine.root.join("workspace/space/ca.pem") }),
    ] {
        assert_eq!(
            program_check(env.clone()),
            Some(NotReadyReason::BinaryUnsafe),
            "{env}"
        );
    }

    // A login's folder.
    let with_work_folder = |work_folder: &Path| RawLaunchGrant {
        logins_json: Some(
            json!([
                { "id": WORK, "configDir": work_folder },
                { "id": USUAL, "configDir": null },
            ])
            .to_string()
            .into(),
        ),
        ..machine.raw()
    };
    let login_check = |work_folder: &Path, login: &str| {
        let grant = machine.grant_from(with_work_folder(work_folder), trust);
        assert!(grant.check().is_ok(), "the program passes");
        grant
            .check_login(grant.login(id(login)).unwrap())
            .map(|login| login.config_dir().map(Path::to_path_buf))
    };
    assert_eq!(login_check(&config_dir, WORK), Ok(Some(config_dir.clone())));
    assert_eq!(login_check(&config_dir, USUAL), Ok(None));
    chmod(&config_dir, 0o770);
    assert_eq!(
        login_check(&config_dir, WORK),
        Err(NotReadyReason::BinaryUnsafe)
    );
    chmod(&config_dir, 0o700);
    let not_there = machine.root.join("home/.claude-gone");
    let links = folder(&machine.root.join("links"), 0o755);
    std::os::unix::fs::symlink(&in_workspace, links.join("into-workspace")).unwrap();
    for work_folder in [
        in_workspace.clone(),
        not_there.clone(),
        ca_file.clone(),
        links.join("into-workspace"),
    ] {
        assert_eq!(
            login_check(&work_folder, WORK),
            Err(NotReadyReason::BinaryUnsafe),
            "{work_folder:?}"
        );
        assert_eq!(login_check(&work_folder, USUAL), Ok(None));
    }

    // Through the probe: that login alone is not ready, and nothing ran with its folder.
    let lane = Lane::new(machine.grant_from(with_work_folder(&not_there), Trust::current()));
    assert!(lane.probe_and_publish_all().await);
    let capability = lane.capability().unwrap();
    assert_eq!(capability["ready"], true, "{capability}");
    assert_eq!(capability["logins"][WORK]["reason"], "binary_unsafe");
    assert_eq!(capability["logins"][USUAL]["ready"], true);
    assert_eq!(
        lane.probe(id(WORK)).await.reason(),
        Some(NotReadyReason::BinaryUnsafe)
    );
    let not_there = not_there.display().to_string();
    assert!(
        machine
            .calls()
            .iter()
            .all(|call| call.config_dir() != Some(not_there.as_str()))
    );
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

/// The exact command of a turn in either mode, on either login (3.3, 11.12, 11.19): a
/// `plan_only` turn passes `--permission-mode plan` where a turn that applies its changes passes
/// `acceptEdits`, and nothing else differs; the logins' turns differ only in `CLAUDE_CONFIG_DIR`,
/// the work login's folder or none at all for the usual one.
#[tokio::test]
async fn the_turn_command_is_exact_in_either_mode_on_either_login_and_no_bare_is_passed_only_when_listed()
 {
    let machine = Machine::new();
    let prompt = "Rename the `--help` flag in README.md\n\nnaïve résumé 🎉 $HOME \"quotes\" -p\r\n\ttrailing white space  \n";
    let space = machine.root.join("workspace/space");
    let work = machine.work_folder().display().to_string();
    for (help, no_bare) in [("full", false), ("bare-will-become-default", true)] {
        machine.settings(&[("SCENARIO", "record-only"), ("HELP", help)]);
        let lane = machine.lane();
        let mut environments: Vec<BTreeMap<String, String>> = Vec::new();
        for (login, config_dir) in [(WORK, Some(work.as_str())), (USUAL, None)] {
            let readiness = lane.probe(id(login)).await;
            let ready = ready(&readiness);
            assert_eq!(ready.login().id(), id(login));
            assert_eq!(ready.help().lists_no_bare(), no_bare);
            let mcp_config = McpConfigFile::create(lane.grant()).unwrap();
            let session = Uuid::new_v4();
            for (mode, permission_mode, resume) in [
                (ExecutionMode::Apply, "acceptEdits", None),
                (ExecutionMode::Apply, "acceptEdits", Some(session)),
                (ExecutionMode::PlanOnly, "plan", None),
                (ExecutionMode::PlanOnly, "plan", Some(session)),
            ] {
                let before = machine.calls().len();
                let mut child =
                    turn_command(lane.grant(), ready, &mcp_config, mode, resume, &space)
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
                    permission_mode,
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
                    lane_environment(lane.grant(), ready.launch(), ready.login())
                        .into_iter()
                        .map(|(name, value)| {
                            (name.into_string().unwrap(), value.into_string().unwrap())
                        })
                        .collect();
                assert_eq!(call.env, environment);
                assert_eq!(call.config_dir(), config_dir, "{login}");
            }
            environments.push(
                lane_environment(lane.grant(), ready.launch(), ready.login())
                    .into_iter()
                    .filter(|(name, _)| name != "CLAUDE_CONFIG_DIR")
                    .map(|(name, value)| {
                        (name.into_string().unwrap(), value.into_string().unwrap())
                    })
                    .collect(),
            );
        }
        assert_eq!(environments[0], environments[1], "only the folder differs");
    }
}

// The process-wide capture, in child test processes.

const CHILD: &str = "INSTAFY_CLAUDE_CODE_LANE_TEST_CHILD";
const CHILD_ROOT: &str = "INSTAFY_CLAUDE_CODE_LANE_TEST_ROOT";

/// The launch environment of a Desktop runtime with a grant of two logins, and the poison the
/// lane must keep from its child: Anthropic and Claude sign-ins in shell variables, another
/// `CLAUDE_CONFIG_DIR` (in the process environment, and in `INSTAFY_CLAUDE_CODE_ENV_JSON`, which
/// no longer grants one) and proxy, the proxy key, Instafy's tokens, a project secret, and more.
fn launch_environment(machine: &Machine) -> Vec<(String, OsString)> {
    let root = &machine.root;
    let elsewhere = folder(&root.join("home/.claude-elsewhere"), 0o700);
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
        "CLAUDE_CONFIG_DIR": elsewhere,
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
        (LOGINS_JSON_ENV.into(), machine.logins_json()),
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
    assert!(LAUNCH_GRANT_ENV_KEYS.contains(&LOGINS_JSON_ENV));
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
    assert_eq!(
        lane.grant()
            .logins()
            .iter()
            .map(|login| (login.id(), login.config_dir().map(Path::to_path_buf)))
            .collect::<Vec<_>>(),
        [
            (id(WORK), Some(root.join("home/.claude-work"))),
            (id(USUAL), None),
        ]
    );

    // The capability exists only on macOS (D18), and never holds a path. A leased lane job runs
    // on the captured lane there, and elsewhere fails as `binary_missing`.
    let capability = claude_code::registration_capability();
    if cfg!(target_os = "macos") {
        assert_eq!(capability, Some(ready_capability()));
        assert!(!capability.unwrap().to_string().contains('/'));
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
        std::env::set_var(LOGINS_JSON_ENV, "[]");
        claude_code::capture_and_scrub_launch_grant();
    }
    assert!(std::env::var_os(BIN_ENV).is_none());
    assert!(std::env::var_os(LOGINS_JSON_ENV).is_none());
    assert_eq!(captured_lane().grant().binary(), root.join("bin/claude"));
    assert_eq!(captured_lane().grant().logins().len(), 2);
}

/// Each login's child gets exactly the allowlist, with that login's own `CLAUDE_CONFIG_DIR` or
/// none at all for the usual folder (3.4, 11.19), whatever the process environment holds by then
/// and whatever `INSTAFY_CLAUDE_CODE_ENV_JSON` named.
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
    let expected = |config_dir: Option<PathBuf>| -> BTreeMap<String, String> {
        let mut expected: BTreeMap<String, String> = [
            ("HOME", root.join("home").display().to_string()),
            ("USER", "person".to_string()),
            ("LOGNAME", "person".to_string()),
            ("SHELL", "/bin/zsh".to_string()),
            ("TMPDIR", root.join("tmp").display().to_string()),
            ("LANG", "en_US.UTF-8".to_string()),
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
        if let Some(folder) = config_dir {
            expected.insert("CLAUDE_CONFIG_DIR".into(), folder.display().to_string());
        }
        expected
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let lane = captured_lane();
        for (login, config_dir, probe_calls) in [
            (WORK, Some(root.join("home/.claude-work")), 3),
            (USUAL, None, 2),
        ] {
            let before = recorded_calls(&root).len();
            let readiness = lane.probe(id(login)).await;
            let ready = ready(&readiness);
            let calls = recorded_calls(&root);
            assert_eq!(calls.len(), before + probe_calls, "{login}");
            for call in &calls[before..] {
                assert_eq!(call.env, expected(config_dir.clone()), "{:?}", call.argv);
            }

            let mcp_config = McpConfigFile::create(lane.grant()).unwrap();
            let space = root.join("workspace/space");
            let session = Uuid::new_v4();
            let prompt = "Fix the failing test\n";
            let mut child = turn_command(
                lane.grant(),
                ready,
                &mcp_config,
                ExecutionMode::Apply,
                Some(session),
                &space,
            )
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
            assert_eq!(turn.env, expected(config_dir), "{login}");
            assert!(mcp_config.path().starts_with(root.join("tmp")));
        }
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

/// A malformed grant is no lane: where the lane is offered, the capability says why, with no
/// login, and so does a leased lane job; elsewhere there is no capability, and a lane job fails as
/// `binary_missing`. Run for a binary path that is not absolute, and for a list of logins that
/// names one login twice (11.19).
fn a_malformed_grant_gives_its_reason_where_the_lane_is_offered(
    test: &str,
    malformed: impl FnOnce(&Machine, &mut Vec<(String, OsString)>),
) {
    if child_root().is_none() {
        let machine = Machine::new();
        let mut environment = launch_environment(&machine);
        malformed(&machine, &mut environment);
        in_child(test, environment);
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
            Some(json!({ "version": 2, "ready": false, "reason": "binary_unsafe", "logins": {} }))
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
    // Nothing ran: no probe of what the grant named.
    assert!(recorded_calls(&child_root().unwrap()).is_empty());
}

fn replace(environment: &mut [(String, OsString)], key: &str, value: OsString) {
    for (name, current) in environment.iter_mut() {
        if name.as_str() == key {
            *current = value.clone();
        }
    }
}

#[test]
fn a_binary_path_that_is_not_absolute_makes_the_grant_malformed() {
    a_malformed_grant_gives_its_reason_where_the_lane_is_offered(
        "a_binary_path_that_is_not_absolute_makes_the_grant_malformed",
        |_, environment| replace(environment, BIN_ENV, OsString::from("bin/claude")),
    );
}

#[test]
fn a_login_named_twice_makes_the_grant_malformed() {
    a_malformed_grant_gives_its_reason_where_the_lane_is_offered(
        "a_login_named_twice_makes_the_grant_malformed",
        |machine, environment| {
            let twice = json!([
                { "id": WORK, "configDir": machine.work_folder() },
                { "id": WORK.to_uppercase(), "configDir": null },
            ]);
            replace(environment, LOGINS_JSON_ENV, twice.to_string().into());
        },
    );
}

#[test]
fn a_grant_without_its_logins_is_malformed() {
    a_malformed_grant_gives_its_reason_where_the_lane_is_offered(
        "a_grant_without_its_logins_is_malformed",
        |_, environment| environment.retain(|(name, _)| name.as_str() != LOGINS_JSON_ENV),
    );
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
