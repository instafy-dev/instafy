//! A local-engine turn's `claude` process, run and stopped (docs/Local-Engine-Turns.md, 3.6 and
//! 3.7; section 8, "Supervision" and "Events"; 11.9 and 11.12 for a session that is not here and
//! a turn that only plans), with the `--print` scenarios of tests/fixtures/fake-claude.
//!
//! Hermetic: temporary folders, and the fake started through a wrapper each machine writes, as
//! the lane would start the person's `claude`: from the checked target the probe found, with the
//! exact command and environment of 3.3 and 3.4. Each test passes a cleanup latch of its own, so
//! one that sets it stops no other. Process tests shorten their limits through `TurnLimits`'s
//! test settings: none waits minutes.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use runtime_agent::agent::ShutdownSignal;
use runtime_agent::claude_code::command::{McpConfigFile, turn_command};
use runtime_agent::claude_code::events::{
    AdapterStatus, EventAdapter, LaneFailure, OUTSIDE_THIS_SPACE,
};
use runtime_agent::claude_code::supervise::{
    FOLLOW_UP_GRACE, FOLLOW_UP_REARMS, TurnEnd, TurnLimits, TurnOutcome, TurnSpec, supervise,
};
use runtime_agent::claude_code::{
    Confinement, ExecutionMode, FailureCode, Lane, LaunchEnvSnapshot, LaunchGrant, RawLaunchGrant,
    ReadyLane, Trust,
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
        write_settings(&root, &[]);
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

    /// The `--print` scenario the next turns run, and the one a `claude` started with `--resume`
    /// runs when it is another.
    fn scenario(&self, name: &str, when_resumed: Option<&str>) {
        let mut settings = vec![("FAKE_CLAUDE_SCENARIO", name)];
        settings.extend(when_resumed.map(|name| ("FAKE_CLAUDE_RESUME_SCENARIO", name)));
        write_settings(&self.root, &settings);
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

fn write_settings(root: &Path, settings: &[(&str, &str)]) {
    let mut text = format!(
        "FAKE_CLAUDE_RECORD_DIR={}\nFAKE_CLAUDE_FIXTURES={}\nFAKE_CLAUDE_SESSION={}\n",
        quote(root.join("record")),
        quote(FIXTURES),
        SESSION
    );
    for (key, value) in settings {
        text.push_str(&format!("{key}={}\n", quote(value)));
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
    mode: ExecutionMode,
    /// The session the turn resumes, and the scenario a `claude` started with `--resume` runs
    /// when it is another than the turn's (a resume miss, say).
    resume: Option<(Uuid, Option<&'static str>)>,
}

impl<'a> Run<'a> {
    fn new(machine: &'a Machine, latch: &'static AtomicBool) -> Self {
        Self {
            machine,
            limits: TurnLimits::standard().with_cleanup_latch(latch),
            stop: JobCancelSignal::new(),
            shutdown: ShutdownSignal::new(),
            mode: ExecutionMode::Apply,
            resume: None,
        }
    }

    fn limits(mut self, limits: impl FnOnce(TurnLimits) -> TurnLimits) -> Self {
        self.limits = limits(self.limits);
        self
    }

    /// A turn that resumes [`SESSION`], which the scenario runs as it is.
    fn resumed(mut self) -> Self {
        self.resume = Some((Uuid::parse_str(SESSION).unwrap(), None));
        self
    }

    /// A turn that resumes `session`, for which the `claude` started with `--resume` runs
    /// `scenario`; started without it, `claude` runs the turn's own scenario.
    fn resuming(mut self, session: Uuid, scenario: &'static str) -> Self {
        self.resume = Some((session, Some(scenario)));
        self
    }

    /// A `plan_only` turn (11.12).
    fn planning(mut self) -> Self {
        self.mode = ExecutionMode::PlanOnly;
        self
    }

    async fn turn(&self, scenario: &str) -> Turn {
        let machine = self.machine;
        machine.scenario(scenario, self.resume.and_then(|(_, when)| when));
        let grant = machine.lane.grant();
        let mcp_config = McpConfigFile::create(grant).unwrap();
        let space = machine.space();
        let resume = self.resume.map(|(session, _)| session);
        let command = turn_command(
            grant,
            &machine.ready,
            &mcp_config,
            self.mode,
            resume,
            &space,
        );
        let without_resume = resume
            .map(|_| turn_command(grant, &machine.ready, &mcp_config, self.mode, None, &space));
        let mut adapter = EventAdapter::for_turn(grant, &space, self.mode);
        let mut events = Vec::new();
        let mut sink = |event: &Value| events.push(event.clone());
        let started = Instant::now();
        let outcome = supervise(
            command,
            TurnSpec {
                prompt: PROMPT,
                without_resume,
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
            "item.started web_search",
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

/// The usage artifact of the turns' token counts, summed.
fn usage(input: u64, cache_creation: u64, cache_read: u64, output: u64) -> Value {
    json!({
        "kind": "claude-code/usage",
        "model": "claude-sonnet-4-5",
        "usage": {
            "input_tokens": input,
            "cache_creation_input_tokens": cache_creation,
            "cache_read_input_tokens": cache_read,
            "output_tokens": output,
        },
    })
}

/// Claude Code 2.1.325's order (Phase 0, item 5): a background subagent that finished before
/// the turn's `result` was printed makes `claude` run a follow-up turn first, a second top-level
/// `init`, and print both turns' `result`s back to back. The turn ends at the follow-up's,
/// whose `origin` names the subagent's run: the reply is the subagent's answer, and the usage is
/// both turns', never `modelUsage` (3.6, 3.7).
#[tokio::test]
async fn a_subagents_follow_up_turn_that_ran_first_gives_the_reply_and_its_usage_counts() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .turn("result-subagent-follow-up")
        .await;
    turn.succeeded();
    assert_eq!(turn.adapter.inits(), 2);
    assert_eq!(turn.adapter.results(), 2);
    assert_eq!(turn.adapter.reply(), Some("The helper answered: PONG."));
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(7, 880, 5_500, 162))
    );
    // The runtime's own SIGTERM ended it at that `result`, and its 143 counted as 0.
    assert_eq!(turn.exit_code(), Some(143));
    assert!(turn.outcome.cleanup_confirmed);
}

/// A background command's follow-up turn only says the command ended, and never gives the
/// reply (3.6). In Phase 0's bash-wait order it comes after the turn's `result`, which ends the
/// turn. When its notification and follow-up `init` came first, the turn reads on to the
/// follow-up's `result`, whose usage counts, and the reply stays the turn's own.
#[tokio::test]
async fn a_background_commands_follow_up_never_gives_the_reply() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let after = Run::new(&machine, &LATCH)
        .turn("result-local-bash-follow-up")
        .await;
    after.succeeded();
    assert_eq!(after.adapter.results(), 1);
    assert_eq!(
        after.adapter.reply(),
        Some("The tests pass, and the dev server is starting in the background.")
    );
    assert_eq!(after.exit_code(), Some(143));

    let first = Run::new(&machine, &LATCH)
        .turn("result-local-bash-follow-up-first")
        .await;
    first.succeeded();
    assert_eq!(first.adapter.results(), 2);
    assert_eq!(
        first.adapter.reply(),
        Some("The build runs in the background.")
    );
    assert_eq!(
        first.adapter.usage_artifact(),
        Some(usage(5, 120, 1_900, 80))
    );
    assert_eq!(first.exit_code(), Some(143));
}

/// A peer message, which another program can queue through the messaging socket every `init`
/// names, runs as a turn of its own (`origin.kind` `peer`). Here it runs between the subagent's
/// notification and the subagent's follow-up turn: its `result` closes its `init` but is never
/// the reply, and the turn waits on for the follow-up's, which is (3.6).
#[tokio::test]
async fn a_peer_messages_turn_never_gives_the_reply() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH).turn("result-peer").await;
    turn.succeeded();
    assert_eq!(turn.adapter.results(), 3);
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper found the bug in parser.ts.")
    );
    // Every top-level `result` read counts toward the usage, the peer's included.
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(6, 150, 1_500, 60))
    );
    // It waited past the peer's `result`: the scenario pauses before the follow-up turn.
    assert!(
        turn.elapsed >= Duration::from_millis(300),
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// The wall clock of a turn that would otherwise wait for a follow-up turn that never comes, or
/// for event turns that keep coming: it fails the turn instead of hanging the test.
const NEVER_ENDS: Duration = Duration::from_secs(20);

/// The run log's line that says the follow-up wait ended the turn, if one does.
fn ended_without_follow_up(turn: &Turn) -> Option<Value> {
    turn.adapter
        .run_log()
        .events()
        .into_iter()
        .find(|event| event["type"] == "instafy.ended_without_follow_up")
}

/// A background subagent that ends between two tool steps of the main conversation while a
/// background command runs. As the main conversation goes on to its next model request, Claude
/// Code 2.1.325 may fold the notification into it, and then no follow-up turn comes; but it
/// prints nothing of its own when it does, and these same lines come when the fold missed the
/// notification (3.6). So the subagent stays awaited: with the command keeping `claude` alive,
/// the turn ends after the follow-up grace at its own `result`, whose reply already answers, and
/// the command is stopped with it.
#[tokio::test]
async fn a_notification_the_running_turn_may_have_folded_in_is_awaited_for_the_grace() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let grace = Duration::from_millis(600);
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| {
            limits
                .with_wall_clock(NEVER_ENDS)
                .with_follow_up_grace(grace)
        })
        .turn("result-absorbed-notification")
        .await;
    turn.succeeded();
    assert_eq!(
        turn.adapter.reply(),
        Some("The dev server runs, and the helper found the bug in parser.ts.")
    );
    assert_eq!(turn.adapter.results(), 1);
    assert_eq!(turn.exit_code(), Some(143));
    assert!(turn.elapsed >= grace, "{:?}", turn.elapsed);
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    assert_eq!(
        ended_without_follow_up(&turn),
        Some(
            json!({"type": "instafy.ended_without_follow_up", "runs": 1, "grace_ms": 600, "restarts": 0, "claude_exited": false})
        )
    );
    let devserver = machine.pid("devserver").expect("the dev server started");
    assert!(gone(devserver).await, "the background command survived");
    assert!(turn.outcome.cleanup_confirmed);
}

/// The subagent's notification came after the last tool result, and no follow-up turn comes
/// while a background command keeps `claude` alive. The turn waits only for the subagent's
/// follow-up turn, and ends after the follow-up grace at its `result`, as a success: a follow-up
/// that never came fails nothing (3.6). The run log says so.
#[tokio::test]
async fn a_follow_up_that_never_comes_ends_the_turn_after_the_grace() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let grace = Duration::from_millis(600);
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| {
            limits
                .with_wall_clock(NEVER_ENDS)
                .with_follow_up_grace(grace)
        })
        .turn("result-follow-up-never-comes")
        .await;
    turn.succeeded();
    assert_eq!(
        turn.adapter.reply(),
        Some("The dev server runs, and the helper found the bug in parser.ts.")
    );
    assert_eq!(turn.adapter.results(), 1);
    assert_eq!(turn.exit_code(), Some(143));
    assert!(turn.elapsed >= grace, "{:?}", turn.elapsed);
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    let run_log = serde_json::to_string(&turn.adapter.run_log().artifact()).unwrap();
    assert!(
        run_log.contains(r#""type":"instafy.ended_without_follow_up""#),
        "{run_log}"
    );
    assert_eq!(
        ended_without_follow_up(&turn).map(|line| line["restarts"].clone()),
        Some(json!(0))
    );
    let devserver = machine.pid("devserver").expect("the dev server started");
    assert!(gone(devserver).await, "the background command survived");
}

/// The subagent ended during the turn's last model call, so the turn's own `result` went out
/// first and its follow-up turn starts a moment later, within the grace: the turn reads on to the
/// follow-up's `result`, which gives the reply, and ends there, not at the grace (3.6).
#[tokio::test]
async fn a_follow_up_that_starts_within_the_grace_gives_the_reply() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let grace = Duration::from_secs(3);
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_follow_up_grace(grace))
        .turn("result-follow-up-after-the-result")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (2, 2));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper found the bug in parser.ts.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(3, 150, 1_900, 50))
    );
    assert!(
        turn.elapsed >= Duration::from_millis(300) && turn.elapsed < grace,
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// After a `cd` inside the folder, Claude Code 2.1.325's follow-up `init` reports the shell's
/// folder as `cwd` and the folder it started in as `original_cwd`. The later `init` passes the
/// launch checks: its `cwd` is inside the folder and its `original_cwd` is the folder. The
/// subagent's follow-up gives the reply (3.6).
#[tokio::test]
async fn a_follow_up_turn_after_a_cd_inside_the_folder_gives_the_reply() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .turn("result-follow-up-after-cd")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (2, 2));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper says the changelog is up to date.")
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// A later `init` that started in another folder than the space's fails the launch checks as
/// the first one would: the turn ends at once as `unexpected_configuration`.
#[tokio::test]
async fn a_later_init_that_started_in_another_folder_ends_the_turn() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .turn("init-later-other-folder")
        .await;
    let failure = turn.failed_with(FailureCode::UnexpectedConfiguration);
    assert!(failure.message.contains("later turn"), "{failure:?}");
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    assert_eq!(turn.exit_code(), Some(143));
    assert!(
        turn.adapter.init().is_some(),
        "the launch's own init passed"
    );
    assert_eq!(turn.adapter.inits(), 1);
}

/// A Monitor watch's event turn, whose `origin` is a `task-notification` that names no run,
/// printed its `result` after the person's: it counts toward the tally and the usage, but never
/// gives the reply once the turn's task events name run ids (3.6).
#[tokio::test]
async fn a_monitor_events_turn_never_gives_the_reply() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .turn("result-monitor-event")
        .await;
    turn.succeeded();
    assert_eq!(turn.adapter.results(), 2);
    assert_eq!(
        turn.adapter.reply(),
        Some("The dev server is up, and I'm watching its log.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(6, 110, 2_100, 60))
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// Limits under which a turn that waits out the follow-up grace fails by the wall clock instead:
/// a turn that succeeds under them ended at a `result` it read.
fn no_grace(limits: TurnLimits) -> TurnLimits {
    limits
        .with_wall_clock(NEVER_ENDS)
        .with_follow_up_grace(Duration::from_secs(60))
}

/// A subagent in the foreground starts a helper in the background and returns before the helper
/// ends. Under `-p`, Claude Code 2.1.325 delivers the helper's notification to its subagent only
/// while that subagent runs, so it goes to the main conversation and runs a follow-up turn that
/// names the helper's run: the turn waits past its own `result` for that follow-up's, which
/// gives the reply (3.6).
#[tokio::test]
async fn a_task_a_subagent_started_is_awaited_until_its_follow_up() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-nested-under-foreground")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (2, 2));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper reports two failing tests in parser.ts.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(3, 150, 1_900, 50))
    );
    // It waited past its own `result`: the scenario pauses before the follow-up turn.
    assert!(
        turn.elapsed >= Duration::from_millis(300) && turn.elapsed < Duration::from_secs(10),
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// A subagent in the background starts a helper and ends while the helper runs, before a tool
/// step and a model request of the main conversation's. Both stay awaited, whatever those may
/// have folded in: the turn reads past its own `result` and the helper's follow-up to the
/// subagent's follow-up, which gives the reply (3.6).
#[tokio::test]
async fn a_subagent_that_ended_while_its_own_task_ran_is_awaited_until_its_follow_up() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-nested-outlives-owner")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (3, 3));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helpers found the bug in parser.ts.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(4, 200, 2_800, 90))
    );
    assert!(
        turn.elapsed >= Duration::from_millis(300) && turn.elapsed < Duration::from_secs(10),
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// A tool step that ends the turn (here a hook stops it after a command) goes on to no model
/// request, so the subagent that ended during it gets a follow-up turn after the turn's
/// `result`: the turn waits for it, and its `result` gives the reply (3.6).
#[tokio::test]
async fn a_tool_step_that_ends_the_turn_leaves_the_notification_to_its_follow_up() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-turn-ending-tool-step")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (2, 2));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper found the bug in parser.ts.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(3, 150, 1_900, 50))
    );
    assert!(
        turn.elapsed >= Duration::from_millis(300) && turn.elapsed < Duration::from_secs(10),
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// The subagent ended between two tool steps, and the main conversation's next model request may
/// have folded its notification in: no follow-up turn comes, and with nothing else to run Claude
/// Code exits right after its last `result`, by itself. That ends the turn as the follow-up wait
/// would, as a success with the person's reply, well before the grace would have run out (3.6).
#[tokio::test]
async fn claude_exiting_by_itself_ends_a_turn_whose_follow_up_never_comes() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_wall_clock(NEVER_ENDS))
        .turn("result-no-follow-up-then-exit")
        .await;
    turn.succeeded();
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper found the bug: the parser drops the last token.")
    );
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (1, 1));
    // `claude` exited 0 by itself: the runtime sent no SIGTERM, and the grace never ran out.
    assert_eq!(turn.exit_code(), Some(0));
    assert_eq!(
        ended_without_follow_up(&turn),
        Some(
            json!({"type": "instafy.ended_without_follow_up", "runs": 1, "grace_ms": 15_000, "restarts": 0, "claude_exited": true})
        )
    );
    assert!(turn.elapsed < FOLLOW_UP_GRACE / 3, "{:?}", turn.elapsed);
    assert!(turn.outcome.cleanup_confirmed);
}

/// While the turn waits for a follow-up that never comes, a background command's follow-up turn
/// ends in an error, and `claude`, with nothing left to run, exits 1: by a reading of 2.1.325's
/// code, its exit status follows its last `result`, whichever turn's. The turn ends as the
/// follow-up wait would, and succeeds as the person's own `result` says (3.6).
#[tokio::test]
async fn claude_exiting_with_another_turns_error_during_the_wait_keeps_the_persons_success() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-error-turn-then-exit")
        .await;
    turn.succeeded();
    assert_eq!(
        turn.adapter.reply(),
        Some("The tests run, and the helper traced the bug to the tokenizer.")
    );
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (2, 2));
    assert_eq!(turn.exit_code(), Some(1));
    assert_eq!(
        ended_without_follow_up(&turn),
        Some(
            json!({"type": "instafy.ended_without_follow_up", "runs": 1, "grace_ms": 60_000, "restarts": 1, "claude_exited": true})
        )
    );
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    let tests = machine.pid("tests").expect("the test run started");
    assert!(gone(tests).await, "the background command survived");
    assert!(turn.outcome.cleanup_confirmed);
}

/// While the turn waits for a follow-up that never comes, `claude` exits 1 by itself after a last
/// `result` that was no error, as a crash whose own `result` could not be written does. By a
/// reading of 2.1.325's code, an exit at `claude`'s natural end follows the last `result`, 1
/// meaning that `result` was an error, so this exit says what the `result`s do not. The
/// follow-up wait does not end the turn there, and it fails as `crashed`, as an exit 1 at any
/// other time does (3.6).
#[tokio::test]
async fn a_crash_during_the_follow_up_wait_fails_the_turn_as_crashed() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_wall_clock(NEVER_ENDS))
        .turn("result-crash-during-wait")
        .await;
    let failure = turn.failed_with(FailureCode::Crashed);
    assert!(
        failure.message.contains("exited with status 1"),
        "{failure:?}"
    );
    assert_eq!(turn.exit_code(), Some(1));
    assert_eq!(turn.adapter.status(), &AdapterStatus::Running);
    assert_eq!(ended_without_follow_up(&turn), None);
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (1, 1));
    assert!(turn.elapsed < FOLLOW_UP_GRACE / 3, "{:?}", turn.elapsed);
    assert!(turn.outcome.cleanup_confirmed);
}

/// The same wait, ended by a SIGTERM the runtime did not send: `claude` exits 143, as Claude Code
/// does on SIGTERM. Only after the runtime's own SIGTERM does 143 count as 0, so the turn fails,
/// and the follow-up wait does not end it there either (3.6).
#[tokio::test]
async fn an_outside_sigterm_during_the_follow_up_wait_fails_the_turn() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_wall_clock(NEVER_ENDS))
        .turn("result-killed-during-wait")
        .await;
    let failure = turn.failed_with(FailureCode::Crashed);
    assert!(
        failure.message.contains("exited with status 143"),
        "{failure:?}"
    );
    assert_eq!(turn.exit_code(), Some(143));
    assert_eq!(turn.adapter.status(), &AdapterStatus::Running);
    assert_eq!(ended_without_follow_up(&turn), None);
    assert!(turn.elapsed < FOLLOW_UP_GRACE / 3, "{:?}", turn.elapsed);
    assert!(turn.outcome.cleanup_confirmed);
}

/// A Monitor watch keeps `claude` alive, and its events keep running turns of their own while the
/// subagent's follow-up never comes. Each such turn restarts the follow-up grace, at most
/// `FOLLOW_UP_REARMS` times; the next one then ends the turn as it waits only for the follow-up
/// again, at once, as a success with the person's reply, far below the wall clock (3.6). The run
/// log says how many restarts the wait used, and the watch is stopped with the turn.
#[tokio::test]
async fn monitor_events_that_keep_coming_restart_the_follow_up_grace_only_five_times() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let grace = Duration::from_secs(3);
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| {
            limits
                .with_wall_clock(NEVER_ENDS)
                .with_follow_up_grace(grace)
        })
        .turn("result-monitor-events-keep-coming")
        .await;
    turn.succeeded();
    assert_eq!(
        turn.adapter.reply(),
        Some("A helper is checking the parser, and I'm watching the dev server's log.")
    );
    // The person's turn, then the event turns up to the one after the last restart.
    let turns = 1 + FOLLOW_UP_REARMS + 1;
    assert_eq!(
        (turn.adapter.inits(), turn.adapter.results()),
        (turns, turns)
    );
    assert_eq!(
        ended_without_follow_up(&turn),
        Some(
            json!({"type": "instafy.ended_without_follow_up", "runs": 1, "grace_ms": 3_000, "restarts": FOLLOW_UP_REARMS, "claude_exited": false})
        )
    );
    assert_eq!(turn.exit_code(), Some(143));
    assert!(turn.elapsed < grace * 2, "{:?}", turn.elapsed);
    let watcher = machine.pid("watcher").expect("the watch started");
    assert!(gone(watcher).await, "the Monitor watch survived");
    assert!(turn.outcome.cleanup_confirmed);
}

/// A Monitor watch's events keep running turns that each start a helper of their own, which ends
/// and is followed up, while the person's subagent's follow-up never comes. Those helpers are no
/// progress for the wait, which kept only the person's subagent: their turns use up its restarts,
/// two a helper, and the turn ends at once after the fifth, far below the wall clock. The latest
/// helper's follow-up gives the reply, as any subagent's follow-up can, whichever turn started
/// its task (3.6).
#[tokio::test]
async fn event_turns_that_keep_starting_helpers_still_end_the_wait() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let grace = Duration::from_secs(3);
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| {
            limits
                .with_wall_clock(NEVER_ENDS)
                .with_follow_up_grace(grace)
        })
        .turn("result-event-agents-keep-coming")
        .await;
    turn.succeeded();
    assert_eq!(turn.adapter.reply(), Some("Helper 3 reports a timeout."));
    // The person's turn, then three helpers' event and follow-up turns.
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (7, 7));
    assert_eq!(
        ended_without_follow_up(&turn),
        Some(
            json!({"type": "instafy.ended_without_follow_up", "runs": 1, "grace_ms": 3_000, "restarts": FOLLOW_UP_REARMS, "claude_exited": false})
        )
    );
    assert_eq!(turn.exit_code(), Some(143));
    assert!(turn.elapsed < grace * 2, "{:?}", turn.elapsed);
    let watcher = machine.pid("watcher").expect("the watch started");
    assert!(gone(watcher).await, "the Monitor watch survived");
    assert!(turn.outcome.cleanup_confirmed);
}

/// While the person's subagent runs, a Monitor watch's event runs a turn that starts a helper of
/// its own. 2.1.325 holds the `result`s back while a subagent runs, and prints them just before
/// the subagent's follow-up's. The helper's follow-up comes last, ends the turn and gives the
/// reply: the latest follow-up of a subagent does, whichever turn started its task (3.6).
#[tokio::test]
async fn the_latest_follow_up_gives_the_reply_whichever_turn_started_its_task() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-event-agent-follow-up")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (4, 4));
    assert_eq!(
        turn.adapter.reply(),
        Some("Helper E found the cause: a timeout.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(7, 200, 3_400, 120))
    );
    assert!(ended_without_follow_up(&turn).is_none());
    assert!(
        turn.elapsed >= Duration::from_millis(400) && turn.elapsed < Duration::from_secs(10),
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// The person's subagent and background test run end together. By a reading of 2.1.325's code,
/// Claude Code then runs the subagent's notification as a held turn, which makes no model request
/// and prints an `init` and an empty `result` with `num_turns` 0, and leaves it to the turn of the
/// test run's notification, queued behind it, which answers both. The held `result` neither ends
/// the turn nor gives the reply: the subagent awaits its follow-up until the next `result`, the
/// test run's follow-up's, which ends the turn and gives the reply, as the held one could have.
/// Every `result` counts toward the usage (3.6).
#[tokio::test]
async fn a_command_follow_up_that_answers_a_held_notification_gives_the_reply() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-held-notification-then-command")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (3, 3));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper fixed the parser, and all 57 tests pass.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(5, 190, 3_100, 110))
    );
    assert!(ended_without_follow_up(&turn).is_none());
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    assert_eq!(turn.exit_code(), Some(143));
    let tests = machine.pid("tests").expect("the test run started");
    assert!(gone(tests).await, "the background command survived");
}

/// As above, but the notification queued behind the held turn does not run next, so 2.1.325 runs
/// the turn it owes the held notification instead: one with no `origin`, which answers it. With
/// nothing else awaited, the held `result` still does not end the turn: that turn's does, and it
/// gives the reply (3.6).
#[tokio::test]
async fn a_held_notification_is_awaited_until_the_turn_owed_to_it() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-held-notification-then-owed-call")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (3, 3));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper fixed the parser in parser.ts: it dropped the last token.")
    );
    assert!(ended_without_follow_up(&turn).is_none());
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    assert_eq!(turn.exit_code(), Some(143));
}

/// On a resumed session, by a reading of 2.1.325's code, Claude Code first runs a turn with no
/// model request for each background task of an earlier turn that left no record of its end, as
/// a command the runtime stopped at that turn's end does. Each prints a held turn's `result`,
/// whose `origin` names no run, before the person's own turn runs. None of them ends the turn:
/// the person's `result` does, and gives the reply (3.6).
#[tokio::test]
async fn a_resumed_sessions_notices_before_the_persons_turn_do_not_end_it() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .resumed()
        .turn("result-resume-notices-before-the-persons-turn")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (3, 3));
    assert_eq!(
        turn.adapter.reply(),
        Some("The homepage loads, and the layout fix is in place.")
    );
    assert!(ended_without_follow_up(&turn).is_none());
    assert!(
        turn.elapsed >= Duration::from_millis(200) && turn.elapsed < Duration::from_secs(10),
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
}

/// While the turn waits for a follow-up that never comes, `claude` crashes. By a reading of
/// 2.1.325's code, it first writes an error `result` of its own, with no `origin` and no text,
/// and then exits 1. That `result` becomes the reply and fails the turn with the crash's own
/// words; the exit, 1 after an error `result`, ends it as the follow-up wait would (3.6).
#[tokio::test]
async fn a_crash_result_during_the_follow_up_wait_fails_the_turn_by_it() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_wall_clock(NEVER_ENDS))
        .turn("result-crash-result-during-wait")
        .await;
    let failure = turn.failure();
    assert_eq!(failure.code, None, "{failure:?}");
    assert!(failure.message.contains("[session_crash]"), "{failure:?}");
    assert_eq!(turn.exit_code(), Some(1));
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (1, 2));
    assert_eq!(
        ended_without_follow_up(&turn),
        Some(
            json!({"type": "instafy.ended_without_follow_up", "runs": 1, "grace_ms": 15_000, "restarts": 0, "claude_exited": true})
        )
    );
    assert!(turn.elapsed < FOLLOW_UP_GRACE / 3, "{:?}", turn.elapsed);
    assert!(turn.outcome.cleanup_confirmed);
}

/// The person's subagent stops at the plan's limit after Claude Code reported a refused request.
/// By a reading of 2.1.325's code, its notification only repeats a usage limit the session has
/// already reached, so it runs as a turn with no model request that prints a held turn's
/// `result`, and no later turn answers it. When `claude` then exits 0 by itself, the turn ends as
/// the follow-up wait would, but fails as `plan_limit`: the work the subagent stood for was
/// stopped by the limit, which the person's interim reply does not say (3.6).
#[tokio::test]
async fn a_usage_limit_repeat_that_nothing_answers_fails_the_turn_as_plan_limit() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| limits.with_wall_clock(NEVER_ENDS))
        .turn("result-usage-limit-repeat")
        .await;
    let failure = turn.failed_with(FailureCode::PlanLimit);
    assert_eq!(failure.resets_at, Some(1_900_000_000), "{failure:?}");
    assert_eq!(turn.adapter.reply(), Some("A helper is on it."));
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (2, 2));
    assert_eq!(turn.exit_code(), Some(0));
    assert_eq!(
        ended_without_follow_up(&turn).map(|line| line["claude_exited"].clone()),
        Some(json!(true))
    );
    assert!(turn.elapsed < FOLLOW_UP_GRACE / 3, "{:?}", turn.elapsed);
}

/// Five Monitor event turns use up the follow-up wait's restarts while the person's subagent's
/// follow-up is still to come. Then the build ends too, and 2.1.325 holds the subagent's
/// notification for the build's follow-up turn, which answers both. The held turn, of a task the
/// wait keeps, comes just before its answer, so it restarts the grace without using a restart:
/// the turn reads on to the build's follow-up, which gives the reply (3.6).
#[tokio::test]
async fn a_held_turn_after_the_last_restart_still_reaches_its_answer() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let grace = Duration::from_secs(3);
    let turn = Run::new(&machine, &LATCH)
        .limits(|limits| {
            limits
                .with_wall_clock(NEVER_ENDS)
                .with_follow_up_grace(grace)
        })
        .turn("result-held-after-five-event-turns")
        .await;
    turn.succeeded();
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper fixed the tokenizer, and the build passed.")
    );
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (8, 8));
    assert!(ended_without_follow_up(&turn).is_none());
    assert_eq!(turn.exit_code(), Some(143));
    assert!(turn.elapsed < grace * 2, "{:?}", turn.elapsed);
    let watcher = machine.pid("watcher").expect("the watch started");
    assert!(gone(watcher).await, "the Monitor watch survived");
}

/// A worktree subagent's notification is printed before Claude Code 2.1.325 queues it, behind its
/// git work, so the main conversation's next tool result and model request come in between and
/// fold nothing in. Its follow-up turn then comes only after an unrelated one, a background
/// command's follow-up: the turn reads past both, and the reply is the subagent's follow-up (3.6).
#[tokio::test]
async fn an_awaited_follow_up_after_another_turn_gives_the_reply() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .limits(no_grace)
        .turn("result-follow-up-after-another-turn")
        .await;
    turn.succeeded();
    assert_eq!((turn.adapter.inits(), turn.adapter.results()), (3, 3));
    assert_eq!(
        turn.adapter.reply(),
        Some("The helper found the bug in parser.ts: it drops the last token.")
    );
    assert_eq!(
        turn.adapter.usage_artifact(),
        Some(usage(6, 200, 3_400, 110))
    );
    assert!(ended_without_follow_up(&turn).is_none());
    // It waited past its own `result` and the command's follow-up: the scenario pauses before
    // each later turn.
    assert!(
        turn.elapsed >= Duration::from_millis(600) && turn.elapsed < Duration::from_secs(10),
        "{:?}",
        turn.elapsed
    );
    assert_eq!(turn.exit_code(), Some(143));
    let build = machine.pid("build").expect("the build started");
    assert!(gone(build).await, "the background command survived");
}

/// A later `init` whose shell left the folder fails the launch checks, though it names the
/// folder it started in: the turn ends at once as `unexpected_configuration`.
#[tokio::test]
async fn a_later_init_whose_shell_left_the_folder_ends_the_turn() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let turn = Run::new(&machine, &LATCH)
        .turn("init-later-cwd-outside")
        .await;
    let failure = turn.failed_with(FailureCode::UnexpectedConfiguration);
    assert!(failure.message.contains("later turn"), "{failure:?}");
    assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    assert_eq!(turn.exit_code(), Some(143));
    assert!(
        turn.adapter.init().is_some(),
        "the launch's own init passed"
    );
    assert_eq!(turn.adapter.inits(), 1);
    assert_eq!(turn.adapter.results(), 0);
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

/// The `--print` calls the fake recorded since `before`, by their argv, and each one's stdin.
fn print_calls_since(machine: &Machine, before: usize) -> Vec<(Vec<String>, Vec<u8>)> {
    machine.print_calls().split_off(before)
}

/// A resume miss's two starts: the first with `--resume <session>`, the second with the same
/// argv but for `--resume` and the same prompt (11.9).
fn started_again_without_resume(calls: &[(Vec<String>, Vec<u8>)], session: Uuid) {
    assert_eq!(calls.len(), 2, "{calls:?}");
    let (first, first_stdin) = &calls[0];
    let (second, second_stdin) = &calls[1];
    assert_eq!(
        first[first.len() - 2..],
        ["--resume".to_string(), session.to_string()]
    );
    assert_eq!(second[..], first[..first.len() - 2]);
    assert!(!second.iter().any(|arg| arg == "--resume"), "{second:?}");
    assert_eq!(first_stdin, PROMPT.as_bytes());
    assert_eq!(second_stdin, PROMPT.as_bytes());
}

/// A session this computer does not have: `claude`, started with `--resume`, says so on stderr
/// before any `init` and exits 1, as a version that says it only there would. The turn starts
/// `claude` once more, without `--resume`, and runs on it in a new session (11.9). The same exit
/// without a resume is another startup failure, and starts nothing else.
#[tokio::test]
async fn a_resume_miss_before_init_starts_claude_again_without_resume() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let missing = Uuid::new_v4();
    let turn = Run::new(&machine, &LATCH)
        .resuming(missing, "resume-miss")
        .turn("success")
        .await;
    turn.succeeded();
    assert!(turn.outcome.started_again);
    assert!(turn.outcome.cleanup_confirmed);
    started_again_without_resume(&print_calls_since(&machine, 0), missing);
    // The new session's turn, read from its start.
    assert_eq!(
        turn.adapter.init().map(|init| init.session_id.to_string()),
        Some(SESSION.to_string())
    );
    assert!(turn.adapter.reply().is_some());
    assert!(
        turn.adapter
            .run_log()
            .events()
            .iter()
            .any(|event| event["type"] == "instafy.started_without_the_missing_session")
    );

    // Without `--resume`, the same exit is a crash, and nothing starts again.
    let before = machine.print_calls().len();
    let fresh = Run::new(&machine, &LATCH).turn("resume-miss").await;
    fresh.failed_with(FailureCode::Crashed);
    assert!(!fresh.outcome.started_again);
    assert_eq!(print_calls_since(&machine, before).len(), 1);
}

/// Claude Code 2.1.325's resume miss (Phase 0, item 7): a `result` on stdout before any `init`,
/// whose `errors` name the missing session, then exit 1. That `result` ends the first `claude`'s
/// turn, so the runtime's own SIGTERM races the exit: whether `claude` exits 1 by itself, 143 on
/// the SIGTERM, 0 as a later version's may, or outlives the grace and is killed, the structured
/// `errors` say it, and the turn starts again without `--resume` and runs (11.9). Without
/// `--resume` the same line is another failure, in Claude Code's own words.
#[tokio::test]
async fn a_resume_miss_result_before_init_starts_claude_again_whatever_the_first_exit() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    for miss in [
        "resume-miss-result",
        "resume-miss-result-then-term",
        "resume-miss-result-term-0",
        "resume-miss-result-ignore-term",
    ] {
        let before = machine.print_calls().len();
        let missing = Uuid::new_v4();
        let turn = Run::new(&machine, &LATCH)
            .limits(|limits| limits.with_stop_grace(Duration::from_millis(300)))
            .resuming(missing, miss)
            .turn("success")
            .await;
        turn.succeeded();
        assert!(turn.outcome.started_again, "{miss}");
        assert!(turn.outcome.cleanup_confirmed, "{miss}");
        // The second `claude`'s exit: its own, or the runtime's SIGTERM at its `result`.
        assert!(
            matches!(turn.exit_code(), Some(0 | 143)),
            "{miss}: {:?}",
            turn.outcome
        );
        started_again_without_resume(&print_calls_since(&machine, before), missing);
    }
    let before = machine.print_calls().len();
    let fresh = Run::new(&machine, &LATCH).turn("resume-miss-result").await;
    let failure = fresh.failure();
    assert_eq!(failure.code, None, "{failure:?}");
    assert!(failure.message.starts_with("No conversation found"));
    assert!(!fresh.outcome.started_again);
    assert_eq!(print_calls_since(&machine, before).len(), 1);
}

/// The second start is the only one a turn makes: when it fails too, the turn fails as it says.
/// And a Stop that the check before the second start hears of starts nothing more (3.1, step
/// 6). A session that is there is resumed, and nothing starts again.
#[tokio::test]
async fn a_resume_miss_starts_claude_again_only_once_and_never_after_a_stop() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let missing = Uuid::new_v4();
    let failed = Run::new(&machine, &LATCH)
        .resuming(missing, "resume-miss-result")
        .turn("not-signed-in")
        .await;
    failed.failed_with(FailureCode::NotSignedIn);
    assert!(failed.outcome.started_again);
    started_again_without_resume(&print_calls_since(&machine, 0), missing);

    let before = machine.print_calls().len();
    let run = Run::new(&machine, &LATCH).resuming(missing, "resume-miss-result");
    run.stop
        .check_lease_with(Arc::new(|| Box::pin(async { false })));
    let stopped = run.turn("success").await;
    assert!(
        matches!(stopped.outcome.end, TurnEnd::Stopped),
        "{:?}",
        stopped.outcome
    );
    assert_eq!(print_calls_since(&machine, before).len(), 1);

    let before = machine.print_calls().len();
    let resumed = Run::new(&machine, &LATCH).resumed().turn("success").await;
    resumed.succeeded();
    assert!(!resumed.outcome.started_again);
    assert_eq!(print_calls_since(&machine, before).len(), 1);
}

/// A `plan_only` turn passes `--permission-mode plan` and nothing else changes in its argv, and
/// every `init` it reads must report `plan` (11.12). A turn of either mode whose `claude` reports
/// the other mode ends as `unexpected_configuration`. A `plan_only` turn whose session is not
/// here starts again in plan mode.
#[tokio::test]
async fn a_plan_only_turn_runs_claude_code_in_plan_mode() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    let machine = Machine::new().await;
    let planned = Run::new(&machine, &LATCH)
        .planning()
        .turn("plan-only")
        .await;
    planned.succeeded();
    assert_eq!(
        planned.adapter.reply(),
        Some("Plan: rename the project in README.md, then update its tests.")
    );
    let applied = Run::new(&machine, &LATCH).turn("success").await;
    applied.succeeded();
    let calls = machine.print_calls();
    assert_eq!(calls.len(), 2);
    let (plan_argv, apply_argv) = (&calls[0].0, &calls[1].0);
    let at = plan_argv
        .iter()
        .position(|arg| arg == "--permission-mode")
        .unwrap();
    assert_eq!(plan_argv[at + 1], "plan");
    assert_eq!(apply_argv[at + 1], "acceptEdits");
    // The same argv but for the mode, and for each turn's own MCP configuration file.
    let config = plan_argv
        .iter()
        .position(|arg| arg == "--mcp-config")
        .unwrap();
    let mut same = plan_argv.clone();
    same[at + 1] = "acceptEdits".to_string();
    same[config + 1] = apply_argv[config + 1].clone();
    assert_ne!(plan_argv[config + 1], apply_argv[config + 1]);
    assert_eq!(&same, apply_argv);

    for (run, scenario, expected) in [
        (
            Run::new(&machine, &LATCH).planning(),
            "success",
            "not plan.",
        ),
        (Run::new(&machine, &LATCH), "plan-only", "not acceptEdits."),
    ] {
        let turn = run.turn(scenario).await;
        let failure = turn.failed_with(FailureCode::UnexpectedConfiguration);
        assert!(failure.message.ends_with(expected), "{failure:?}");
        assert!(turn.elapsed < Duration::from_secs(10), "{:?}", turn.elapsed);
    }

    let before = machine.print_calls().len();
    let missing = Uuid::new_v4();
    let again = Run::new(&machine, &LATCH)
        .planning()
        .resuming(missing, "resume-miss-result")
        .turn("plan-only")
        .await;
    again.succeeded();
    let calls = print_calls_since(&machine, before);
    started_again_without_resume(&calls, missing);
    assert_eq!(calls[1].0[at + 1], "plan");
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
