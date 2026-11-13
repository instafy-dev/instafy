//! A local-engine turn's `claude` process, run and stopped (docs/Local-Engine-Turns.md, 3.6 and
//! 3.7; section 8, "Supervision" and "Events"), with the `--print` scenarios of
//! tests/fixtures/fake-claude.
//!
//! Hermetic: temporary folders, and the fake started through a wrapper each machine writes, as
//! the lane would start the person's `claude`: from the checked target the probe found, with the
//! exact command and environment of 3.3 and 3.4. Each test passes a cleanup latch of its own, so
//! one that sets it stops no other. Process tests shorten their limits through `TurnLimits`'s
//! test settings: none waits minutes.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use runtime_agent::agent::ShutdownSignal;
use runtime_agent::claude_code::command::{McpConfigFile, turn_command};
use runtime_agent::claude_code::events::{EventAdapter, LaneFailure, OUTSIDE_THIS_SPACE};
use runtime_agent::claude_code::supervise::{
    TurnEnd, TurnLimits, TurnOutcome, TurnSpec, supervise,
};
use runtime_agent::claude_code::{
    Confinement, FailureCode, Lane, LaunchEnvSnapshot, LaunchGrant, RawLaunchGrant, ReadyLane,
    Trust,
};
use runtime_agent::job_cancel::JobCancelSignal;
use serde_json::{Value, json};
use uuid::Uuid;

const FAKE_CLAUDE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude");
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/fake-claude-fixtures"
);
const USER_ID: &str = "6f1c2f6e-9d8a-4f7b-8f61-3c1f0a2b4d5e";
/// The session id the scenarios print, and the one a resumed turn passes.
const SESSION: &str = "5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50";
const PROMPT: &str = "Rename the project in README.md\n";

fn folder(path: &Path, mode: u32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    path.to_path_buf()
}

fn quote(value: impl AsRef<std::ffi::OsStr>) -> String {
    let value = value.as_ref().to_str().expect("test paths are UTF-8");
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// A temporary computer with a granted `claude` (a wrapper that sets the fake's settings and
/// execs it), a space folder, a home and a temporary folder, and its lane, probed ready.
struct Machine {
    _temp: tempfile::TempDir,
    root: PathBuf,
    lane: Lane,
    ready: ReadyLane,
}

impl Machine {
    async fn new() -> Self {
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
        write_settings(&root, None);
        let wrapper = root.join("bin/claude");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nset -a\n. {}\nset +a\nexec {} \"$@\"\n",
                quote(root.join("fake-claude.env")),
                quote(FAKE_CLAUDE)
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let home = root.join("home");
        let tmp = root.join("tmp");
        let snapshot = LaunchEnvSnapshot::from_lookup(|key| {
            Some(match key {
                "HOME" => home.clone().into_os_string(),
                "USER" | "LOGNAME" => "person".into(),
                "SHELL" => "/bin/zsh".into(),
                "TMPDIR" => tmp.clone().into_os_string(),
                "LANG" => "en_US.UTF-8".into(),
                "PATH" => "/usr/bin:/bin".into(),
                _ => return None,
            })
        });
        let grant = LaunchGrant::parse(
            RawLaunchGrant {
                bin: Some(wrapper.into_os_string()),
                path: None,
                user_id: Some(USER_ID.into()),
                env_json: None,
            },
            snapshot,
            Confinement::new([root.join("workspace")]),
            Trust::current(),
        )
        .unwrap()
        .expect("a grant");
        // These tests are about the turn, not the probe's own limit, which a machine busy with
        // many process tests at once can outlast.
        let lane = Lane::new(grant).with_probe_timeout(Duration::from_secs(60));
        let readiness = lane.probe().await;
        let ready = readiness
            .ready()
            .unwrap_or_else(|| panic!("the fake is not ready: {readiness:?}"))
            .clone();
        Self {
            _temp: temp,
            root,
            lane,
            ready,
        }
    }

    fn space(&self) -> PathBuf {
        self.root.join("workspace/space")
    }

    fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    /// The `--print` scenario the next turns run.
    fn scenario(&self, name: &str) {
        write_settings(&self.root, Some(name));
    }

    /// The pid a scenario step recorded as `name`, in any call.
    fn pid(&self, name: &str) -> Option<i32> {
        let record = self.root.join("record");
        std::fs::read_dir(&record)
            .ok()?
            .filter_map(Result::ok)
            .find_map(|call| std::fs::read_to_string(call.path().join(format!("{name}.pid"))).ok())
            .and_then(|pid| pid.trim().parse().ok())
    }

    /// The `--print` calls the fake recorded: argv and stdin.
    fn print_calls(&self) -> Vec<(Vec<String>, Vec<u8>)> {
        let mut calls = Vec::new();
        for n in 0.. {
            let call = self.root.join(format!("record/call-{n}"));
            if !call.join("done").exists() {
                break;
            }
            let argv: Vec<String> = std::fs::read(call.join("argv"))
                .unwrap()
                .split(|byte| *byte == 0)
                .filter(|arg| !arg.is_empty())
                .map(|arg| String::from_utf8(arg.to_vec()).unwrap())
                .collect();
            if argv.first().map(String::as_str) == Some("--print") {
                calls.push((argv, std::fs::read(call.join("stdin")).unwrap()));
            }
        }
        calls
    }
}

fn write_settings(root: &Path, scenario: Option<&str>) {
    let mut text = format!(
        "FAKE_CLAUDE_RECORD_DIR={}\nFAKE_CLAUDE_FIXTURES={}\nFAKE_CLAUDE_SESSION={}\n",
        quote(root.join("record")),
        quote(FIXTURES),
        SESSION
    );
    if let Some(scenario) = scenario {
        text.push_str(&format!("FAKE_CLAUDE_SCENARIO={}\n", quote(scenario)));
    }
    let next = root.join("fake-claude.env.next");
    std::fs::write(&next, text).unwrap();
    std::fs::rename(&next, root.join("fake-claude.env")).unwrap();
}

/// A finished turn: how it ended, what its adapter kept, the events it streamed.
struct Turn {
    outcome: TurnOutcome,
    adapter: EventAdapter,
    events: Vec<Value>,
    elapsed: Duration,
}

impl Turn {
    fn failure(&self) -> &LaneFailure {
        match &self.outcome.end {
            TurnEnd::Failed(failure) => failure,
            end => panic!("expected a failure, got {end:?} ({:?})", self.outcome),
        }
    }

    fn failed_with(&self, code: FailureCode) -> &LaneFailure {
        let failure = self.failure();
        assert_eq!(failure.code, Some(code), "{failure:?}");
        failure
    }

    fn succeeded(&self) {
        assert!(
            matches!(self.outcome.end, TurnEnd::Succeeded),
            "expected a success, got {:?}",
            self.outcome
        );
    }

    fn exit_code(&self) -> Option<i32> {
        self.outcome.exit_status.and_then(|status| status.code())
    }

    fn streamed(&self) -> String {
        serde_json::to_string(&self.events).unwrap()
    }
}

/// How a test runs its turn.
struct Run<'a> {
    machine: &'a Machine,
    limits: TurnLimits,
    stop: JobCancelSignal,
    shutdown: ShutdownSignal,
    resumed: bool,
}

impl<'a> Run<'a> {
    fn new(machine: &'a Machine, latch: &'static AtomicBool) -> Self {
        Self {
            machine,
            limits: TurnLimits::standard().with_cleanup_latch(latch),
            stop: JobCancelSignal::new(),
            shutdown: ShutdownSignal::new(),
            resumed: false,
        }
    }

    fn limits(mut self, limits: impl FnOnce(TurnLimits) -> TurnLimits) -> Self {
        self.limits = limits(self.limits);
        self
    }

    fn resumed(mut self) -> Self {
        self.resumed = true;
        self
    }

    async fn turn(&self, scenario: &str) -> Turn {
        let machine = self.machine;
        machine.scenario(scenario);
        let grant = machine.lane.grant();
        let mcp_config = McpConfigFile::create(grant).unwrap();
        let resume = self.resumed.then(|| Uuid::parse_str(SESSION).unwrap());
        let command = turn_command(grant, &machine.ready, &mcp_config, resume, &machine.space());
        let mut adapter = EventAdapter::for_turn(grant, &machine.space());
        let mut events = Vec::new();
        let mut sink = |event: &Value| events.push(event.clone());
        let started = Instant::now();
        let outcome = supervise(
            command,
            TurnSpec {
                prompt: PROMPT,
                resumed: self.resumed,
                stop: &self.stop,
                shutdown: &self.shutdown,
            },
            &self.limits,
            &mut adapter,
            &mut sink,
        )
        .await;
        let elapsed = started.elapsed();
        Turn {
            outcome,
            adapter,
            events,
            elapsed,
        }
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Waits until `pid` is gone: a killed process lingers until whatever adopted it reaps it.
async fn gone(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

/// Waits until the scenario recorded each of `names`, and the tracker had time to see them.
async fn started(machine: &Machine, names: &[&str]) -> Vec<i32> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let pids: Vec<i32> = names.iter().filter_map(|name| machine.pid(name)).collect();
        if pids.len() == names.len() {
            tokio::time::sleep(Duration::from_millis(300)).await;
            return pids;
        }
        assert!(
            Instant::now() < deadline,
            "the scenario never started {names:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn item_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| {
            let kind = event["type"].as_str().unwrap_or_default();
            match event["item"]["type"].as_str() {
                Some(item) => format!("{kind} {item}"),
                None => kind.to_string(),
            }
        })
        .collect()
}

#[tokio::test]
async fn a_turn_streams_its_steps_and_ends_at_its_result() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).turn("success").await;
    turn.succeeded();
    assert!(turn.outcome.cleanup_confirmed);
    assert!(!LATCH.load(Ordering::Acquire));
    // It left nothing running, so no status step says it stopped anything.
    assert_eq!(turn.outcome.programs_stopped, 0);

    // The prompt went to stdin, byte for byte, and nothing but flags to argv.
    let calls = machine.print_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1, PROMPT.as_bytes());
    assert!(
        calls[0]
            .0
            .iter()
            .all(|arg| arg.starts_with("--") || !arg.contains(' '))
    );
    assert!(!calls[0].0.iter().any(|arg| arg == "--resume"));
    // The edit the fake made is in the space's folder.
    assert_eq!(
        std::fs::read_to_string(machine.space().join("README.md")).unwrap(),
        "# Demo, renamed\n"
    );

    assert_eq!(
        item_types(&turn.events),
        [
            "item.updated agent_message",
            "item.updated agent_message",
            "item.completed agent_message",
            "draft.reset",
            "item.started mcp_tool_call",
            "item.completed mcp_tool_call",
            "item.started command_execution",
            "item.completed command_execution",
            "item.completed file_change",
            "item.completed file_change",
            "item.started command_execution",
            "item.completed command_execution",
            "item.completed web_search",
            "item.updated todo_list",
            "item.updated todo_list",
            "item.updated todo_list",
            "item.updated todo_list",
            "item.completed agent_message",
            "item.started mcp_tool_call",
            "item.completed agent_message",
            "item.started mcp_tool_call",
            "item.completed mcp_tool_call",
            "item.completed mcp_tool_call",
            "item.started mcp_tool_call",
            "item.completed mcp_tool_call",
            "item.started mcp_tool_call",
            "item.completed mcp_tool_call",
            "item.updated agent_message",
            "item.updated agent_message",
        ]
    );
    assert_eq!(turn.events[8]["item"]["paths"], json!(["README.md"]));
    assert_eq!(
        turn.adapter.reply(),
        Some("Renamed the project in README.md and wrote docs/notes.md.")
    );
    let init = turn.adapter.init().expect("init passed its checks");
    assert_eq!(init.session_id.to_string(), SESSION);
    assert_eq!(init.model, "claude-sonnet-4-5");
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(json!({
            "kind": "claude-code/usage",
            "model": "claude-sonnet-4-5",
            "usage": {"input_tokens": 1200, "cache_creation_input_tokens": 300, "cache_read_input_tokens": 4500, "output_tokens": 600},
        }))
    );
    // Nothing the turn streams or logs names the folder or the home folder, or carries a token.
    let run_log = serde_json::to_string(&turn.adapter.run_log().artifact()).unwrap();
    for text in [turn.streamed(), run_log] {
        for leak in [
            machine.root.to_str().unwrap(),
            "sk-ant-",
            "total_cost_usd",
            "Private thoughts",
        ] {
            assert!(!text.contains(leak), "{leak} leaked");
        }
    }
}

#[tokio::test]
async fn a_resumed_turn_passes_its_session() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).resumed().turn("success").await;
    turn.succeeded();
    let calls = machine.print_calls();
    assert_eq!(
        calls[0].0[calls[0].0.len() - 2..],
        ["--resume".to_string(), SESSION.to_string()]
    );
}

#[tokio::test]
async fn a_stop_sends_sigterm_then_kills_every_process_the_turn_started() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let run = Run::new(&machine, &LATCH);
    let stop = run.stop.clone();
    let (turn, pids) = tokio::join!(run.turn("hang"), async {
        let pids = started(&machine, &["child", "grandchild"]).await;
        stop.cancel();
        pids
    });
    assert!(
        matches!(turn.outcome.end, TurnEnd::Stopped),
        "{:?}",
        turn.outcome
    );
    // The fake exits as Claude Code documents for SIGTERM, well within the grace.
    assert_eq!(turn.exit_code(), Some(143));
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    for pid in pids {
        assert!(gone(pid).await, "{pid} survived the Stop");
    }
    assert!(turn.outcome.cleanup_confirmed);
    assert!(!LATCH.load(Ordering::Acquire));
}

#[tokio::test]
async fn a_claude_that_ignores_sigterm_is_killed_after_the_grace() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let run = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_stop_grace(Duration::from_millis(400)));
    let stop = run.stop.clone();
    let (turn, pids) = tokio::join!(run.turn("ignore-term"), async {
        let pids = started(&machine, &["child"]).await;
        stop.cancel();
        pids
    });
    assert!(
        matches!(turn.outcome.end, TurnEnd::Stopped),
        "{:?}",
        turn.outcome
    );
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            turn.outcome.exit_status.and_then(|status| status.signal()),
            Some(libc::SIGKILL)
        );
    }
    for pid in pids {
        assert!(gone(pid).await, "{pid} survived");
    }
    assert!(turn.outcome.cleanup_confirmed);
}

#[tokio::test]
async fn shutdown_reports_nothing() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let run = Run::new(&machine, &LATCH);
    let shutdown = run.shutdown.clone();
    let (turn, pids) = tokio::join!(run.turn("hang"), async {
        let pids = started(&machine, &["child", "grandchild"]).await;
        shutdown.cancel();
        pids
    });
    assert!(
        matches!(turn.outcome.end, TurnEnd::Shutdown),
        "{:?}",
        turn.outcome
    );
    for pid in pids {
        assert!(gone(pid).await, "{pid} survived the shutdown");
    }
    // A turn that starts while the runtime shuts down does not start `claude` at all.
    let before = machine.print_calls().len();
    let shutting = Run::new(&machine, &LATCH);
    shutting.shutdown.cancel();
    assert!(matches!(
        shutting.turn("success").await.outcome.end,
        TurnEnd::Shutdown
    ));
    assert_eq!(machine.print_calls().len(), before);
}

#[tokio::test]
async fn a_result_with_only_a_command_a_watch_or_an_ambient_task_live_ends_the_turn() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).turn("result-local-bash").await;
    turn.succeeded();
    // The runtime's own SIGTERM ended it, and its 143 counted as 0.
    assert_eq!(turn.exit_code(), Some(143));
    assert_eq!(turn.adapter.reply(), Some("The dev server is running."));
    assert_eq!(turn.adapter.results(), 1);
    assert!(!turn.streamed().contains("Late words"));
    let devserver = machine.pid("devserver").expect("the dev server started");
    assert!(
        gone(devserver).await,
        "the background command survived the turn"
    );
    assert!(turn.outcome.cleanup_confirmed);
    // The dev server outlived `claude`, and the kill path stopped it.
    assert!(
        turn.outcome.programs_stopped >= 1,
        "{}",
        turn.outcome.programs_stopped
    );
}

#[tokio::test]
async fn a_result_while_a_background_subagent_runs_waits_for_the_later_one() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).turn("result-subagent").await;
    turn.succeeded();
    assert_eq!(turn.adapter.results(), 2);
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper found the bug in parser.ts.")
    );
    assert_eq!(turn.exit_code(), Some(143));
    // It waited for the helper: the scenario pauses between its two results.
    assert!(
        turn.elapsed >= Duration::from_millis(300),
        "{:?}",
        turn.elapsed
    );
}

#[tokio::test]
async fn a_setsid_grandchild_and_a_double_forked_daemon_are_gone_after_the_turn() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).turn("setsid").await;
    turn.succeeded();
    for name in ["grandchild", "daemon"] {
        let pid = machine.pid(name).expect("the scenario recorded it");
        assert!(gone(pid).await, "the {name} survived the turn");
    }
    assert!(turn.outcome.cleanup_confirmed);
    // Both were still running when `claude` was done, and the kill path stopped them.
    assert!(
        turn.outcome.programs_stopped >= 2,
        "{}",
        turn.outcome.programs_stopped
    );
    assert!(!LATCH.load(Ordering::Acquire));
}

#[tokio::test]
async fn the_wall_clock_and_the_stall_limit_end_the_turn() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    // A turn that keeps printing, and so never stalls, past the wall clock.
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_wall_clock(Duration::from_millis(700)))
        .turn("hang")
        .await;
    turn.failed_with(FailureCode::TurnTimeout);
    assert!(turn.elapsed >= Duration::from_millis(700));
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    for name in ["child", "grandchild"] {
        let pid = machine.pid(name).expect("started");
        assert!(gone(pid).await, "the {name} survived the timeout");
    }

    // A turn that prints nothing more.
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| {
            limits
                .with_stall(Duration::from_millis(400))
                .with_wall_clock(Duration::from_secs(60))
        })
        .turn("stall")
        .await;
    turn.failed_with(FailureCode::Stalled);
    assert!(turn.elapsed >= Duration::from_millis(400));
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    assert!(turn.outcome.cleanup_confirmed);
}

#[tokio::test]
async fn sign_in_and_plan_limit_failures_are_classified() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let run = Run::new(&machine, &LATCH);
    let signed_out = run.turn("not-signed-in").await;
    let failure = signed_out.failed_with(FailureCode::NotSignedIn);
    assert!(failure.message.starts_with("Not logged in"), "{failure:?}");
    // The code comes from the structured fields, whether the fake's own `exit 1` or the
    // runtime's SIGTERM at its `result` ended it.
    assert!(
        matches!(signed_out.exit_code(), Some(1 | 143)),
        "{:?}",
        signed_out.outcome
    );

    let limited = run.turn("plan-limit").await;
    let failure = limited.failed_with(FailureCode::PlanLimit);
    assert_eq!(failure.resets_at, Some(1_763_060_400));
    assert_eq!(
        failure.artifact(),
        Some(json!({"kind": "claude-code/failure", "code": "plan_limit"}))
    );
}

#[tokio::test]
async fn a_resume_miss_before_init_is_session_unavailable_and_starts_nothing_else() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let missed = Run::new(&machine, &LATCH)
        .resumed()
        .turn("resume-miss")
        .await;
    let failure = missed.failed_with(FailureCode::SessionUnavailable);
    assert!(
        failure.message.starts_with("No conversation found"),
        "{failure:?}"
    );
    // One process, and no second one.
    assert_eq!(machine.print_calls().len(), 1);
    // The same exit without a resume is another startup failure.
    let fresh = Run::new(&machine, &LATCH).turn("resume-miss").await;
    fresh.failed_with(FailureCode::Crashed);
}

#[tokio::test]
async fn permission_denials_make_one_status_step_and_the_turn_succeeds() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    for scenario in ["permission-denials", "permission-denials-in-results"] {
        let turn = Run::new(&machine, &LATCH).turn(scenario).await;
        turn.succeeded();
        assert_eq!(
            turn.adapter.permission_denials(),
            ["Write", "Bash"],
            "{scenario}"
        );
        let step = turn
            .adapter
            .permission_denials_step()
            .expect("a status step");
        assert_eq!(
            step.content,
            "Claude Code skipped 2 steps that need your OK, since nobody can give it here. You can allow them in your own Claude Code settings."
        );
        assert_eq!(step.metadata.unwrap()["tools"], json!(["Write", "Bash"]));
        // The declined write outside the folder shows as such.
        let write = turn
            .events
            .iter()
            .find(|event| event["item"]["type"] == "file_change")
            .expect("a file change step");
        assert_eq!(write["item"]["paths"], json!([OUTSIDE_THIS_SPACE]));
        assert_eq!(write["item"]["status"], json!("failed"));
    }
}

#[tokio::test]
async fn lines_that_do_not_parse_are_tolerated_up_to_fifty_and_a_long_line_is_a_crash() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let run = Run::new(&machine, &LATCH);
    let noisy = run.turn("malformed").await;
    noisy.succeeded();
    assert_eq!(noisy.adapter.unparsed_lines(), 3);
    assert_eq!(noisy.adapter.reply(), Some("Done despite the noise."));

    let flood = run.turn("malformed-flood").await;
    let failure = flood.failed_with(FailureCode::Crashed);
    assert!(
        failure.message.contains("more than 50 lines"),
        "{failure:?}"
    );
    assert!(flood.elapsed < Duration::from_secs(10));

    // The real bound: a line over 8 MiB.
    let long = run.turn("long-line").await;
    let failure = long.failed_with(FailureCode::Crashed);
    assert!(failure.message.contains("longer than"), "{failure:?}");
    assert!(long.elapsed < Duration::from_secs(20), "{:?}", long.elapsed);
    assert!(long.outcome.cleanup_confirmed);
}

#[tokio::test]
async fn an_init_event_that_shows_another_setting_ends_the_turn() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    for scenario in [
        "init-other-cwd",
        "init-other-mode",
        "init-mcp-server",
        "init-missing-field",
        "init-bad-session",
        "no-init",
    ] {
        let turn = Run::new(&machine, &LATCH).turn(scenario).await;
        let failure = turn.failed_with(FailureCode::UnexpectedConfiguration);
        assert!(!failure.message.is_empty(), "{scenario}");
        // It ended at once, through the stop path, not at the stall limit.
        assert!(
            turn.elapsed < Duration::from_secs(10),
            "{scenario}: {:?}",
            turn.elapsed
        );
        assert_eq!(turn.exit_code(), Some(143), "{scenario}");
        assert!(turn.adapter.init().is_none(), "{scenario}");
    }
}

#[tokio::test]
async fn a_crash_of_claude_is_crashed_with_its_stderr_redacted() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).turn("crash").await;
    let failure = turn.failed_with(FailureCode::Crashed);
    assert!(
        failure.message.contains("~/.local/share/claude/cli.js")
            && failure.message.contains("[redacted]"),
        "{failure:?}"
    );
    for text in [&failure.message, &turn.outcome.stderr] {
        assert!(!text.contains(machine.home().to_str().unwrap()));
        assert!(!text.contains("sk-ant-"));
    }
    assert_eq!(turn.exit_code(), Some(1));
    // The command it started streamed its start, and no completion.
    assert_eq!(item_types(&turn.events), ["item.started command_execution"]);

    // Exit 0 with no result is no success either.
    let quiet = Run::new(&machine, &LATCH).turn("no-result").await;
    quiet.failed_with(FailureCode::Crashed);
}

#[tokio::test]
async fn a_dropped_turn_cannot_vouch_for_its_processes_and_sets_its_latch() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let run = Run::new(&machine, &LATCH);
    tokio::select! {
        _ = run.turn("hang") => panic!("the turn ended by itself"),
        _ = started(&machine, &["child"]) => {}
    }
    assert!(LATCH.load(Ordering::Acquire));
    let child = machine.pid("child").expect("started");
    assert!(gone(child).await, "the dropped turn's process survived");
}

#[tokio::test]
async fn a_runtime_whose_cleanup_is_unconfirmed_starts_no_turn() {
    static LATCH: AtomicBool = AtomicBool::new(true);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).turn("success").await;
    turn.failed_with(FailureCode::Crashed);
    assert!(machine.print_calls().is_empty());
}
