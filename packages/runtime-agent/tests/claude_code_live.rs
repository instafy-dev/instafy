//! The live suite of local-engine turns (docs/Local-Engine-Turns.md, section 8, "The live
//! suite", and section 9, Phase 0), against the `claude` installed on this computer and signed in
//! to the account of the person who runs it.
//!
//! A maintainer runs it by hand, on their own Mac and Claude account, for each Claude Code
//! version the lane supports. No CI job or automated agent sets the variable:
//!
//! ```text
//! INSTAFY_CLAUDE_CODE_LIVE=1 cargo test --manifest-path packages/runtime-agent/Cargo.toml \
//!     --test claude_code_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! It runs `INSTAFY_CLAUDE_CODE_BIN` (an absolute path, as Desktop grants it) or, without it, the
//! first `claude` on `PATH`, through the same checks, probe, command and environment as a lane
//! turn (3.2-3.4), and grants it this shell's `CLAUDE_CONFIG_DIR`, `HTTPS_PROXY`, `HTTP_PROXY`,
//! `NO_PROXY` and `NODE_EXTRA_CA_CERTS`, as Desktop grants the login shell's (D26). It sends about
//! ten short prompts, each a real request on the person's own account. It writes only in a
//! temporary folder, apart from one file in the home folder for item 12's `@~/` import, which it
//! removes. It reads none of Claude Code's own files.
//!
//! - Without `INSTAFY_CLAUDE_CODE_LIVE=1` it is not run: `cargo test` lists it as ignored, and
//!   with `--ignored` it fails, saying it was not run. It never passes without running.
//! - With the variable set, it fails when no ready `claude` is found, and when any Phase 0 item
//!   that phase 8 needs does not hold or cannot be confirmed.
//!
//! It prints the version it ran, each item's result, and the items a person checks by hand. The
//! results go into the document's appendix with that version; a maintainer then raises
//! `CLAUDE_CODE_LANE_VERIFIED_THROUGH` (runtime-contracts) in a reviewed change.
#![cfg(unix)]

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use runtime_agent::agent::ShutdownSignal;
use runtime_agent::claude_code::command::{
    McpConfigFile, lane_environment, turn_command, write_prompt,
};
use runtime_agent::claude_code::events::{AdapterStatus, EventAdapter, ExitFacts, check_init};
use runtime_agent::claude_code::supervise::{TurnEnd, TurnLimits, TurnSpec, supervise};
use runtime_agent::claude_code::{
    BIN_ENV, Confinement, FailureCode, GRANTED_ENV_KEYS, HelpFacts, Lane, LaunchEnvSnapshot,
    LaunchGrant, RawLaunchGrant, ReadyLane, Trust, verified_through,
};
use runtime_agent::job_cancel::JobCancelSignal;
use serde_json::Value;
use sysinfo::{Pid, ProcessRefreshKind, System};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader, Lines};
use tokio::process::{ChildStderr, ChildStdout};
use uuid::Uuid;

/// The variable that runs the suite. Only a person sets it, by hand.
const LIVE_ENV: &str = "INSTAFY_CLAUDE_CODE_LIVE";
/// How long one turn of the suite may run before it is killed.
const TURN_LIMIT: Duration = Duration::from_secs(300);
/// How long `claude` gets to exit after a signal before it is killed: the lane's own grace for
/// SIGTERM (3.6), and longer for what the suite only records.
const SIGTERM_GRACE: Duration = Duration::from_secs(5);
const SIGINT_GRACE: Duration = Duration::from_secs(10);
const CLOSED_STDOUT_GRACE: Duration = Duration::from_secs(15);
/// How long the rest of stdout is read once `claude` exited.
const AFTER_EXIT_DRAIN: Duration = Duration::from_secs(2);
const STDERR_TAIL_BYTES: usize = 16 * 1024;
/// Every name the isolation turn plants contains this, so `init` can be searched for it.
const PLANTED_NAME: &str = "instafy-live-canary";

static CLEANUP_LATCH: AtomicBool = AtomicBool::new(false);

/// Whether the suite runs: only with [`LIVE_ENV`] set to `1`, and never in CI.
fn live_gate(variable: Option<&str>, ci: bool) -> Result<(), String> {
    if variable != Some("1") {
        return Err(format!(
            "not run: the live suite runs only with {LIVE_ENV}=1, by hand, on a computer with a signed-in claude; it never passes without running"
        ));
    }
    if ci {
        return Err("not run: the live suite never runs in CI".to_string());
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "not run: the live suite runs the person's own signed-in claude, only by hand with INSTAFY_CLAUDE_CODE_LIVE=1 and --ignored (see tests/claude_code_live.rs)"]
async fn the_live_suite_runs_the_phase_0_checklist_on_the_installed_claude() {
    if let Err(not_run) = live_gate(
        std::env::var(LIVE_ENV).ok().as_deref(),
        std::env::var_os("CI").is_some(),
    ) {
        panic!("{not_run}");
    }
    let live = match Live::new().await {
        Ok(live) => live,
        Err(why) => panic!("no ready claude: {why}"),
    };
    let report = live.run_checklist().await;
    report.print();
    assert!(report.passed(), "{}", report.failures());
}

// ---- The report ----------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    /// The item holds on this version.
    Holds,
    /// It does not: phase 8 cannot go ahead on this version.
    Fails,
    /// The run could not show it, for example because the model did not do what the prompt
    /// asked: run the suite again, or check it by hand.
    Unconfirmed,
    /// Observed and printed; no pass or fail (item 9, and SIGINT and EPIPE in item 6).
    Recorded,
}

impl Verdict {
    fn label(self) -> &'static str {
        match self {
            Self::Holds => "HOLDS",
            Self::Fails => "FAILS",
            Self::Unconfirmed => "UNCONFIRMED",
            Self::Recorded => "RECORDED",
        }
    }
}

struct Finding {
    item: &'static str,
    what: String,
    verdict: Verdict,
    detail: String,
}

struct Report {
    cli: String,
    verified_through: String,
    plan_sign_in: bool,
    help_lines: Vec<String>,
    findings: Vec<Finding>,
}

/// Phase 0 items that need a person: the suite prints them as a reminder.
const BY_HAND: [&str; 5] = [
    "item 2: with Project instructions set to claude-md-and-agents-md in your own Claude Code user settings, run the suite again; AGENTS.md must still not load.",
    "item 3: what ENABLE_CLAUDEAI_MCP_SERVERS=false changes: compare a turn with and without it, with a claude.ai connector set up.",
    "item 8: the signed-out and plan-limit result texts, from a test OS account with no Claude login.",
    "item 13: whether macOS shows a keychain prompt naming Instafy when a lane turn started from Desktop reads Claude Code's sign-in.",
    "item 14: whether a lane turn loads Claude Code's auto memory for its folder (~/.claude/projects/), and whether it writes there.",
];

impl Report {
    fn add(&mut self, item: &'static str, what: &str, verdict: Verdict, detail: impl Into<String>) {
        self.findings.push(Finding {
            item,
            what: what.to_string(),
            verdict,
            detail: detail.into(),
        });
    }

    fn passed(&self) -> bool {
        self.findings
            .iter()
            .all(|finding| matches!(finding.verdict, Verdict::Holds | Verdict::Recorded))
    }

    fn failures(&self) -> String {
        let failing: Vec<String> = self
            .findings
            .iter()
            .filter(|finding| matches!(finding.verdict, Verdict::Fails | Verdict::Unconfirmed))
            .map(|finding| {
                format!(
                    "{} {} ({}): {}",
                    finding.item,
                    finding.verdict.label(),
                    finding.what,
                    finding.detail
                )
            })
            .collect();
        format!(
            "the live suite found items that do not hold on claude {}:\n{}",
            self.cli,
            failing.join("\n")
        )
    }

    fn print(&self) {
        println!(
            "\nLocal-engine turns: the live suite (docs/Local-Engine-Turns.md, section 8 and Phase 0)"
        );
        println!("claude {}", self.cli);
        println!(
            "CLAUDE_CODE_LANE_VERIFIED_THROUGH is {}; a Claude plan sign-in: {}",
            self.verified_through,
            if self.plan_sign_in { "yes" } else { "no" }
        );
        println!("--help lines the bare check reads:");
        for line in &self.help_lines {
            println!("    {line}");
        }
        for finding in &self.findings {
            println!(
                "[{}] {:<11} {}",
                finding.item,
                finding.verdict.label(),
                finding.what
            );
            for line in finding.detail.lines() {
                println!("        {line}");
            }
        }
        println!("Checked by hand, and recorded with this version:");
        for item in BY_HAND {
            println!("- {item}");
        }
        if self.passed() {
            println!(
                "Every item the suite checks holds on claude {}. A maintainer may raise CLAUDE_CODE_LANE_VERIFIED_THROUGH to {} in a reviewed change, once the items checked by hand hold too.",
                self.cli, self.cli
            );
        } else {
            println!("{}", self.failures());
        }
    }
}

// ---- This computer's claude ----------------------------------------------------------------

/// The `claude` the suite runs: [`BIN_ENV`], or the first `claude` on `PATH`.
fn installed_claude() -> Option<PathBuf> {
    if let Some(bin) = std::env::var_os(BIN_ENV).filter(|bin| !bin.is_empty()) {
        return Some(PathBuf::from(bin));
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|folder| folder.join("claude"))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

/// The D26 values this shell has, as `INSTAFY_CLAUDE_CODE_ENV_JSON` carries them.
fn granted_env_json() -> String {
    let mut granted = serde_json::Map::new();
    for key in GRANTED_ENV_KEYS {
        if let Some(value) = std::env::var(key).ok().filter(|value| !value.is_empty()) {
            granted.insert(key.to_string(), Value::String(value));
        }
    }
    Value::Object(granted).to_string()
}

fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("a folder for a planted file");
    }
    std::fs::write(path, contents).expect("a planted file");
}

/// A file the suite wrote outside its temporary folder, removed when the suite ends.
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// This computer's `claude`, granted and probed as Desktop and the runtime would, and the
/// temporary folder the suite's spaces live in.
struct Live {
    _temp: tempfile::TempDir,
    root: PathBuf,
    lane: Lane,
    ready: ReadyLane,
}

impl Live {
    async fn new() -> Result<Self, String> {
        let bin = installed_claude().ok_or_else(|| {
            format!("set {BIN_ENV} to the absolute path of claude, or put claude on PATH")
        })?;
        let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
        let root = std::fs::canonicalize(temp.path()).map_err(|error| error.to_string())?;
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
        let grant = LaunchGrant::parse(
            RawLaunchGrant {
                bin: Some(bin.clone().into_os_string()),
                path: std::env::var_os("PATH"),
                user_id: Some(OsString::from(Uuid::new_v4().to_string())),
                env_json: Some(OsString::from(granted_env_json())),
            },
            LaunchEnvSnapshot::from_process(),
            Confinement::new([workspace]),
            Trust::current(),
        )
        .map_err(|reason| format!("{} cannot be granted: {reason}", bin.display()))?
        .ok_or_else(|| "nothing was granted".to_string())?;
        let lane = Lane::new(grant);
        let readiness = lane.probe().await;
        let ready = match readiness.ready() {
            Some(ready) => ready.clone(),
            None => {
                return Err(format!(
                    "{} is not ready: {}",
                    bin.display(),
                    readiness
                        .reason()
                        .map(|reason| reason.as_str())
                        .unwrap_or("unknown")
                ));
            }
        };
        Ok(Self {
            _temp: temp,
            root,
            lane,
            ready,
        })
    }

    /// A new space folder, with a README.
    fn space(&self, name: &str) -> PathBuf {
        let folder = self.root.join("workspace").join(name);
        write(&folder.join("README.md"), "# Live check\n");
        folder
    }

    /// `claude --help`, run as the probe runs it.
    async fn help_text(&self) -> String {
        let folder = tempfile::tempdir().expect("a folder for --help");
        let mut command = tokio::process::Command::new(self.ready.launch().program());
        command
            .arg("--help")
            .env_clear()
            .envs(lane_environment(self.lane.grant(), self.ready.launch()))
            .current_dir(folder.path())
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        match tokio::time::timeout(Duration::from_secs(10), command.output()).await {
            Ok(Ok(output)) => String::from_utf8_lossy(&output.stdout).into_owned(),
            _ => String::new(),
        }
    }

    async fn run_checklist(&self) -> Report {
        let help = self.help_text().await;
        let facts = HelpFacts::read(&help);
        let mut help_lines = bare_help_lines(&help);
        if help_lines.is_empty() {
            help_lines.push("(--help names neither --bare nor --no-bare)".to_string());
        }
        if !facts.missing_flags().is_empty() {
            help_lines.push(format!(
                "(--help does not list {}; the version floor vouches for them)",
                facts.missing_flags().join(", ")
            ));
        }
        let mut report = Report {
            cli: self.ready.cli().to_string(),
            verified_through: verified_through()
                .map(|version| version.to_string())
                .unwrap_or_else(|| "unset".to_string()),
            plan_sign_in: self.ready.plan_sign_in(),
            help_lines,
            findings: Vec::new(),
        };
        self.lane_turn(&mut report).await;
        self.baseline_turn(&mut report).await;
        self.isolation_turn(&mut report).await;
        self.edits_turn(&mut report).await;
        self.background_turn(&mut report).await;
        self.signal_turns(&mut report).await;
        self.resume_miss(&mut report).await;
        self.bash_process_group(&mut report).await;
        report
    }

    /// Item 1, end to end: a turn through the lane's own supervision, with the exact command.
    async fn lane_turn(&self, report: &mut Report) {
        let folder = self.space("lane");
        let nonce = nonce("LANE");
        let grant = self.lane.grant();
        let mcp_config = McpConfigFile::create(grant).expect("the turn's MCP configuration");
        let command = turn_command(grant, &self.ready, &mcp_config, None, &folder);
        let mut adapter = EventAdapter::for_turn(grant, &folder);
        let limits = TurnLimits::standard()
            .with_cleanup_latch(&CLEANUP_LATCH)
            .with_wall_clock(TURN_LIMIT);
        let stop = JobCancelSignal::new();
        let shutdown = ShutdownSignal::new();
        let prompt = format!("Reply with exactly this text and nothing else: {nonce}\n");
        let mut sink = |_: &Value| {};
        let outcome = supervise(
            command,
            TurnSpec {
                prompt: &prompt,
                resumed: false,
                stop: &stop,
                shutdown: &shutdown,
            },
            &limits,
            &mut adapter,
            &mut sink,
        )
        .await;
        let replied = adapter.reply().is_some_and(|reply| reply.contains(&nonce));
        let detail = format!(
            "{}; exit: {}; processes confirmed gone: {}; the reply {} the prompt's text",
            match &outcome.end {
                TurnEnd::Succeeded => "succeeded".to_string(),
                TurnEnd::Failed(failure) => format!(
                    "failed ({}): {}",
                    failure.code.map(|code| code.as_str()).unwrap_or("other"),
                    failure.message
                ),
                TurnEnd::Stopped => "stopped".to_string(),
                TurnEnd::Shutdown => "shut down".to_string(),
            },
            describe_exit(outcome.exit_status),
            outcome.cleanup_confirmed,
            if replied {
                "repeats"
            } else {
                "does not repeat"
            },
        );
        let holds = matches!(outcome.end, TurnEnd::Succeeded) && outcome.cleanup_confirmed;
        report.add(
            "item 1",
            "a lane turn, with every flag of 3.3, runs to success under the lane's supervision",
            if holds {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            detail,
        );
    }

    /// Items 1, 4, 5 (init, deltas, result), 6 (SIGTERM at the end of a turn) and 10.
    async fn baseline_turn(&self, report: &mut Report) {
        let folder = self.space("baseline");
        let before = folder_state(&folder);
        let nonce = nonce("STDIN");
        let prompt = format!("Reply with exactly this text and nothing else: {nonce}\n");
        let turn = self
            .turn(&folder, &prompt, None, StopPlan::AtEndOfTurn)
            .await;
        let after = folder_state(&folder);

        let init = turn.init_line();
        let started = init.is_some_and(|init| check_init(init, &folder).is_ok());
        report.add(
            "item 1",
            "every flag of 3.3 is accepted: the turn starts and reports its settings",
            if started && turn.adapter.succeeded() {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            turn.summary(),
        );
        report.add(
            "item 4",
            "-p with no prompt argument reads the prompt from stdin",
            if turn.reply().contains(&nonce) {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            format!(
                "the reply {} the text sent on stdin",
                if turn.reply().contains(&nonce) {
                    "repeats"
                } else {
                    "does not repeat"
                }
            ),
        );
        let init_check = match init {
            Some(init) => check_init(init, &folder).map(|facts| format!("model {}", facts.model)),
            None => Err("no system/init event".to_string()),
        };
        report.add(
            "item 5",
            "init has session_id (a UUID), cwd (the folder), model, permissionMode (acceptEdits) and mcp_servers (empty)",
            if init_check.is_ok() {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            match init_check {
                Ok(model) => model,
                Err(why) => why,
            },
        );
        let deltas = text_delta_summary(&turn.lines);
        report.add(
            "item 5",
            "stream_event text deltas stream the reply, and carry parent_tool_use_id",
            if deltas.text_deltas > 0 && deltas.all_carry_parent && turn.drafted() {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            format!(
                "{} text deltas in {} stream events; parent_tool_use_id on every one: {}; a reply draft streamed: {}",
                deltas.text_deltas,
                deltas.stream_events,
                deltas.all_carry_parent,
                turn.drafted()
            ),
        );
        match turn.top_level_result() {
            Some(result) => {
                let missing = missing_result_fields(result);
                let required_missing: Vec<&str> = missing
                    .iter()
                    .copied()
                    .filter(|field| REQUIRED_RESULT_FIELDS.contains(field))
                    .collect();
                report.add(
                    "item 5",
                    "the result has result, is_error and usage (and permission_denials, total_cost_usd)",
                    if required_missing.is_empty() {
                        Verdict::Holds
                    } else {
                        Verdict::Fails
                    },
                    if missing.is_empty() {
                        "every field is there".to_string()
                    } else {
                        format!("missing: {}", missing.join(", "))
                    },
                );
            }
            None => report.add(
                "item 5",
                "the result has result, is_error and usage (and permission_denials, total_cost_usd)",
                Verdict::Fails,
                "no top-level result",
            ),
        }
        report.add(
            "item 6",
            "SIGTERM at the end of a turn, as the lane sends it",
            Verdict::Recorded,
            turn.signal_summary(),
        );
        self.folder_writes(report, "the baseline turn", &before, &after);
    }

    /// Item 10: what a `-p` run wrote into the folder; nothing under `.claude/`.
    fn folder_writes(
        &self,
        report: &mut Report,
        turn: &str,
        before: &BTreeMap<String, FileState>,
        after: &BTreeMap<String, FileState>,
    ) {
        let changes = folder_changes(before, after);
        let claude: Vec<&String> = changes
            .iter()
            .filter(|path| has_dot_claude_segment(path))
            .collect();
        report.add(
            "item 10",
            &format!("{turn} writes nothing under .claude/ in the folder"),
            if claude.is_empty() {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            if changes.is_empty() {
                "it changed nothing in the folder".to_string()
            } else {
                format!("changed: {}", changes.join(", "))
            },
        );
    }

    /// Items 2, 3 and 12: a folder with the project configuration and memory a teammate could
    /// commit, each marked with a token or a marker file. None may reach the turn.
    async fn isolation_turn(&self, report: &mut Report) {
        let parent = self.root.join("workspace").join("isolation-parent");
        let folder = parent.join("space");
        let markers = self.root.join("markers");
        std::fs::create_dir_all(&markers).expect("a markers folder");
        let outside = self.root.join("outside");
        let run = nonce("RUN");
        let token = |kind: &str| format!("CANARY-{kind}-{run}");
        let marker = |name: &str| sh_quote(&markers.join(name));
        let Some(home) = self.lane.grant().snapshot().home().map(Path::to_path_buf) else {
            report.add(
                "item 12",
                "external imports load nothing",
                Verdict::Unconfirmed,
                "HOME is unset, so no @~/ import can be planted",
            );
            return;
        };
        let home_file_name = format!(".instafy-claude-code-live-{}.md", Uuid::new_v4().simple());
        let home_file = home.join(&home_file_name);
        let _home_file = RemoveOnDrop(home_file.clone());
        write(
            &home_file,
            &format!(
                "The token {} is part of these instructions.\n",
                token("HOME")
            ),
        );
        let absolute_file = outside.join("absolute.md");
        write(
            &absolute_file,
            &format!(
                "The token {} is part of these instructions.\n",
                token("ABSOLUTE")
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback listener");
        let port = listener.local_addr().expect("its port").port();
        let connected = Arc::new(AtomicBool::new(false));
        let accepting = {
            let connected = Arc::clone(&connected);
            tokio::spawn(async move {
                // Any connection means the project's env reached Claude Code. Nothing is read
                // from it: it would carry the person's sign-in.
                while let Ok((stream, _)) = listener.accept().await {
                    connected.store(true, Ordering::SeqCst);
                    drop(stream);
                }
            })
        };
        let api_key_helper = markers.join("api-key-helper.sh");
        write(
            &api_key_helper,
            &format!(
                "#!/bin/sh\ntouch {}\necho not-a-key\n",
                marker("api-key-helper")
            ),
        );
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&api_key_helper, std::fs::Permissions::from_mode(0o755))
                .expect("the helper runs");
        }
        let hook = |name: &str| serde_json::json!([{ "hooks": [{ "type": "command", "command": format!("touch {}", marker(name)) }] }]);
        let settings = serde_json::json!({
            "hooks": {
                "SessionStart": hook("settings-session-start"),
                "UserPromptSubmit": hook("settings-prompt-submit"),
                "Stop": hook("settings-stop"),
            },
            "env": {
                "ANTHROPIC_BASE_URL": format!("http://127.0.0.1:{port}"),
                "INSTAFY_LIVE_CANARY": token("ENV"),
            },
            "apiKeyHelper": api_key_helper.to_string_lossy(),
            "outputStyle": format!("{PLANTED_NAME}-style"),
            "enabledPlugins": { format!("{PLANTED_NAME}@{PLANTED_NAME}"): true },
        });
        let local_settings = serde_json::json!({
            "hooks": {
                "SessionStart": hook("local-session-start"),
                "UserPromptSubmit": hook("local-prompt-submit"),
            },
            "env": { "INSTAFY_LIVE_CANARY_LOCAL": token("LOCAL-ENV") },
        });
        write(
            &folder.join(".claude/settings.json"),
            &serde_json::to_string_pretty(&settings).unwrap(),
        );
        write(
            &folder.join(".claude/settings.local.json"),
            &serde_json::to_string_pretty(&local_settings).unwrap(),
        );
        write(
            &folder.join(format!(".claude/skills/{PLANTED_NAME}/SKILL.md")),
            &format!(
                "---\nname: {PLANTED_NAME}-skill\ndescription: The token {} names this skill.\n---\nThe token {} is part of this skill.\n",
                token("SKILL"),
                token("SKILL-BODY")
            ),
        );
        write(
            &folder.join(format!(".claude/agents/{PLANTED_NAME}.md")),
            &format!(
                "---\nname: {PLANTED_NAME}-agent\ndescription: The token {} names this agent.\n---\nYou are a canary.\n",
                token("AGENT")
            ),
        );
        write(
            &folder.join(format!(".claude/commands/{PLANTED_NAME}.md")),
            &format!("The token {} is part of this command.\n", token("COMMAND")),
        );
        write(
            &folder.join(format!(".claude/output-styles/{PLANTED_NAME}-style.md")),
            &format!(
                "---\nname: {PLANTED_NAME}-style\ndescription: The token {} names this style.\n---\nStart every reply with {}.\n",
                token("STYLE"),
                token("STYLE-BODY")
            ),
        );
        write(
            &folder.join(format!(".claude/rules/{PLANTED_NAME}.md")),
            &format!("The token {} is part of these rules.\n", token("RULES")),
        );
        write(
            &folder.join("CLAUDE.md"),
            &format!(
                "# Project notes\n\nThe token {} is part of these project instructions.\n\n@imported.md\n@~/{home_file_name}\n@{}\n",
                token("PROJECT"),
                absolute_file.display()
            ),
        );
        write(
            &folder.join("imported.md"),
            &format!(
                "The token {} is part of these instructions.\n",
                token("IMPORT")
            ),
        );
        write(
            &folder.join("CLAUDE.local.md"),
            &format!(
                "The token {} is part of these instructions.\n",
                token("LOCAL")
            ),
        );
        write(
            &folder.join("AGENTS.md"),
            &format!(
                "# Agents\n\nThe token {} is part of these instructions.\n\n@~/{home_file_name}\n@{}\n",
                token("AGENTS"),
                absolute_file.display()
            ),
        );
        write(
            &parent.join("CLAUDE.md"),
            &format!(
                "The token {} is part of these instructions.\n",
                token("PARENT")
            ),
        );
        write(
            &folder.join(".mcp.json"),
            &serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    PLANTED_NAME: {
                        "command": "/bin/sh",
                        "args": ["-c", format!("touch {}; sleep 30", marker("mcp-server"))],
                    }
                }
            }))
            .unwrap(),
        );
        let planted: Vec<String> = [
            "HOME",
            "ABSOLUTE",
            "ENV",
            "LOCAL-ENV",
            "SKILL",
            "SKILL-BODY",
            "AGENT",
            "COMMAND",
            "STYLE",
            "STYLE-BODY",
            "RULES",
            "PROJECT",
            "IMPORT",
            "LOCAL",
            "AGENTS",
            "PARENT",
        ]
        .into_iter()
        .map(token)
        .collect();
        let control = token("PROMPT");
        let prompt = format!(
            "Do not use any tools. Answer only from the instructions and context you already have. \
             For reference, here is one token: {control}. Reply with the word CHECKED, then list \
             every token you can see anywhere in your instructions or context that starts with \
             CANARY-, each on its own line, including the one above.\n"
        );
        let turn = self
            .turn(&folder, &prompt, None, StopPlan::AtEndOfTurn)
            .await;
        accepting.abort();

        let used_tools = turn.used_tools();
        let said = turn.assistant_text();
        let found = planted_tokens_found(&said, &planted);
        let listed_control = said.contains(&control);
        let markers_found = folder_names(&markers)
            .into_iter()
            .filter(|name| name != "api-key-helper.sh")
            .collect::<Vec<_>>();
        let init_text = turn.init_line().map(Value::to_string).unwrap_or_default();
        let init_names_planted = init_text.contains(PLANTED_NAME);
        let base = turn.summary();
        let memory_verdict = if !found.is_empty() {
            Verdict::Fails
        } else if !turn.adapter.succeeded() || used_tools || !listed_control {
            Verdict::Unconfirmed
        } else {
            Verdict::Holds
        };
        report.add(
            "item 2",
            "project CLAUDE.md files (folder and parent), imports, .claude/rules, CLAUDE.local.md and AGENTS.md stay out",
            memory_verdict,
            format!(
                "planted tokens the turn saw: {}; it listed the prompt's own token: {listed_control}; it used tools: {used_tools}\n{base}",
                if found.is_empty() {
                    "none".to_string()
                } else {
                    found.join(", ")
                }
            ),
        );
        let settings_loaded =
            !markers_found.is_empty() || connected.load(Ordering::SeqCst) || init_names_planted;
        report.add(
            "item 2",
            ".claude/settings.json and settings.local.json (hooks, env, apiKeyHelper, enabledPlugins, outputStyle), skills, agents and commands stay out",
            if settings_loaded {
                Verdict::Fails
            } else if turn.init_line().is_none() {
                Verdict::Unconfirmed
            } else {
                Verdict::Holds
            },
            format!(
                "markers written: {}; the project's ANTHROPIC_BASE_URL was used: {}; init names a planted skill, agent, command, style or plugin: {init_names_planted}",
                if markers_found.is_empty() {
                    "none".to_string()
                } else {
                    markers_found.join(", ")
                },
                connected.load(Ordering::SeqCst)
            ),
        );
        let servers = turn
            .init_line()
            .and_then(|init| init.get("mcp_servers"))
            .map(Value::to_string)
            .unwrap_or_else(|| "(no init)".to_string());
        let server_started = markers_found.iter().any(|name| name == "mcp-server");
        report.add(
            "item 3",
            "--strict-mcp-config with an empty --mcp-config loads no MCP server, .mcp.json included",
            if server_started || servers != "[]" {
                Verdict::Fails
            } else {
                Verdict::Holds
            },
            format!("init mcp_servers: {servers}; the planted .mcp.json server started: {server_started}"),
        );
        let external: Vec<String> = found
            .iter()
            .filter(|token| token.contains("-HOME-") || token.contains("-ABSOLUTE-"))
            .cloned()
            .collect();
        report.add(
            "item 12",
            "external @~/ and absolute imports in CLAUDE.md and AGENTS.md load nothing",
            if !external.is_empty() {
                Verdict::Fails
            } else {
                memory_verdict
            },
            if external.is_empty() {
                "neither import's token reached the turn".to_string()
            } else {
                format!("reached the turn: {}", external.join(", "))
            },
        );
    }

    /// Items 10 and 11: an edit outside the folder is declined; one inside it is made.
    async fn edits_turn(&self, report: &mut Report) {
        let folder = self.space("edits");
        let outside = self.root.join("outside-edits");
        std::fs::create_dir_all(&outside).expect("a folder outside the space");
        let outside_file = outside.join("outside.txt");
        let before = folder_state(&folder);
        let prompt = format!(
            "Use the Write tool to create the file {} containing the single word OUTSIDE. Then use \
             the Write tool to create the file inside.txt in the current folder containing the \
             single word INSIDE. Use no other tool. Then reply DONE.\n",
            outside_file.display()
        );
        let turn = self
            .turn(&folder, &prompt, None, StopPlan::AtEndOfTurn)
            .await;
        let after = folder_state(&folder);
        let wrote_outside = outside_file.exists();
        let wrote_inside = folder.join("inside.txt").exists();
        let denials = turn
            .top_level_result()
            .and_then(|result| result.get("permission_denials"))
            .map(Value::to_string)
            .unwrap_or_else(|| "(none reported)".to_string());
        report.add(
            "item 11",
            "acceptEdits with --permission-prompts none declines an edit outside the folder",
            if wrote_outside {
                Verdict::Fails
            } else if !wrote_inside {
                Verdict::Unconfirmed
            } else {
                Verdict::Holds
            },
            format!(
                "outside.txt written: {wrote_outside}; inside.txt written: {wrote_inside}; permission_denials: {denials}\n{}",
                turn.summary()
            ),
        );
        self.folder_writes(report, "a turn that edits", &before, &after);
    }

    /// Item 5: the background task events the end-of-turn rule reads (3.6).
    async fn background_turn(&self, report: &mut Report) {
        let folder = self.space("background");
        let prompt = "Use the Agent tool to start one subagent in the background, whose only task \
                      is to reply with the single word PONG. When it has finished, reply with its \
                      answer.\n";
        let turn = self
            .turn(&folder, prompt, None, StopPlan::AtEndOfTurn)
            .await;
        let tasks = task_event_summary(&turn.lines);
        let reply = turn.reply();
        let detail = format!(
            "task events: {}\nresults: {}; the last after the task_notification: {}; final reply mentions PONG: {}\n{}",
            if tasks.is_empty() {
                "none".to_string()
            } else {
                tasks
                    .iter()
                    .map(TaskEvent::describe)
                    .collect::<Vec<_>>()
                    .join("; ")
            },
            turn.adapter.results(),
            result_after_notification(&turn.lines),
            reply.contains("PONG"),
            turn.summary()
        );
        report.add(
            "item 5",
            "system/task_started, task_notification and background_tasks_changed carry a task id and task_type, and the turn ends at the result after the subagent's",
            background_verdict(&tasks, &turn.lines, turn.adapter.results(), &reply),
            detail,
        );
    }

    /// Item 6: SIGTERM mid-turn exits with code 143 rather than dying of the signal (phase 8
    /// needs it); what SIGINT does and what a closed stdout does are recorded.
    async fn signal_turns(&self, report: &mut Report) {
        let prompt = "Write a numbered list of 150 different one-sentence facts about the ocean.\n";
        let turn = self
            .turn(
                &self.space("sigterm"),
                prompt,
                None,
                StopPlan::OnFirstDraft(libc::SIGTERM),
            )
            .await;
        let exited_143 = turn
            .exit
            .is_some_and(|status| status.code() == Some(143) && status.signal().is_none());
        report.add(
            "item 6",
            "SIGTERM mid-turn: claude exits with code 143 and is not killed by the signal",
            if turn.signal_sent.is_none() {
                Verdict::Unconfirmed
            } else if exited_143 && !turn.killed {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            turn.signal_summary(),
        );
        let turn = self
            .turn(
                &self.space("sigint"),
                prompt,
                None,
                StopPlan::OnFirstDraft(libc::SIGINT),
            )
            .await;
        report.add(
            "item 6",
            "SIGINT mid-turn",
            Verdict::Recorded,
            turn.signal_summary(),
        );
        let turn = self
            .turn(
                &self.space("epipe"),
                prompt,
                None,
                StopPlan::CloseStdoutAfterFirstLine,
            )
            .await;
        report.add(
            "item 6",
            "stdout closed after the first line (EPIPE)",
            Verdict::Recorded,
            turn.signal_summary(),
        );
    }

    /// Item 7: `--resume` with a session that does not exist exits non-zero before `init`, with
    /// an error the lane classifies as `session_unavailable` (2.7).
    async fn resume_miss(&self, report: &mut Report) {
        let folder = self.space("resume");
        let turn = self
            .turn(
                &folder,
                "Reply with the single word OK.\n",
                Some(Uuid::new_v4()),
                StopPlan::AtEndOfTurn,
            )
            .await;
        let failure = turn.adapter.classify_failure(&ExitFacts {
            resumed: true,
            exit_code: turn.exit.and_then(|status| status.code()),
            signal: turn.exit.and_then(|status| status.signal()),
            exited_ok: false,
            stderr: &turn.stderr,
        });
        let nonzero = turn
            .exit
            .is_some_and(|status| status.code().is_some_and(|code| code != 0));
        let before_init = turn.init_line().is_none();
        let classified = failure.code == Some(FailureCode::SessionUnavailable);
        report.add(
            "item 7",
            "--resume with a missing session exits non-zero before init, as session_unavailable",
            if nonzero && before_init && classified {
                Verdict::Holds
            } else {
                Verdict::Fails
            },
            format!(
                "{}; before init: {before_init}; classified as {}; text: {}",
                describe_exit(turn.exit),
                failure.code.map(|code| code.as_str()).unwrap_or("other"),
                first_line(&failure.message)
            ),
        );
    }

    /// Item 9: whether the Bash tool starts its commands in a process group or session of their
    /// own. No pass or fail; the result is checked against the kill path (3.6).
    async fn bash_process_group(&self, report: &mut Report) {
        let folder = self.space("bash");
        let prompt = "Use the Bash tool to run exactly this command, and nothing else: sleep 8\n\
                      Then reply DONE.\n";
        let turn = self
            .turn(&folder, prompt, None, StopPlan::AtEndOfTurn)
            .await;
        let commands: Vec<&ObservedProcess> = turn
            .descendants
            .iter()
            .filter(|process| process.name.contains("sleep"))
            .collect();
        let detail = if commands.is_empty() {
            format!(
                "no `sleep` was seen running: Claude Code may have declined it (no allow rule for it). Allow Bash(sleep:*) in your own user settings for one run to record this.\nclaude: pid {} group {} session {}\n{}",
                turn.root.pid,
                turn.root.pgid,
                turn.root.sid,
                turn.summary()
            )
        } else {
            commands
                .iter()
                .map(|process| {
                    format!(
                        "{} (pid {}): its own group: {}; its own session: {}",
                        process.name,
                        process.pid,
                        process.pgid != turn.root.pgid,
                        process.sid != turn.root.sid
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        report.add(
            "item 9",
            "the Bash tool's process group and session",
            Verdict::Recorded,
            detail,
        );
    }

    /// Runs one turn of this computer's `claude` with the lane's exact command and environment,
    /// reading every line, feeding the lane's event adapter, and stopping it as `plan` says.
    /// Whatever it started that is still running afterwards is killed.
    async fn turn(
        &self,
        folder: &Path,
        prompt: &str,
        resume: Option<Uuid>,
        plan: StopPlan,
    ) -> LiveTurn {
        let grant = self.lane.grant();
        let mcp_config = McpConfigFile::create(grant).expect("the turn's MCP configuration");
        let mut child = turn_command(grant, &self.ready, &mcp_config, resume, folder)
            .spawn()
            .expect("claude starts");
        let pid = child.id().expect("claude's pid") as i32;
        // SAFETY: plain queries of a process this suite started.
        let root = ProcessIds {
            pid,
            pgid: unsafe { libc::getpgid(pid) },
            sid: unsafe { libc::getsid(pid) },
        };
        let mut tracker = Tracker::new(pid as u32);
        let writer = child.stdin.take().map(|stdin| {
            let prompt = prompt.to_owned();
            tokio::spawn(async move {
                let _ = write_prompt(stdin, &prompt).await;
            })
        });
        let stderr = child
            .stderr
            .take()
            .map(|stderr| tokio::spawn(read_tail(stderr, STDERR_TAIL_BYTES)));
        let mut stdout = child
            .stdout
            .take()
            .map(|stdout| BufReader::new(stdout).lines());
        let mut turn = LiveTurn {
            lines: Vec::new(),
            unparsed: Vec::new(),
            adapter: EventAdapter::for_turn(grant, folder),
            events: Vec::new(),
            exit: None,
            stderr: String::new(),
            signal_sent: None,
            exit_after_signal: None,
            lines_after_signal: 0,
            killed: false,
            timed_out: false,
            root,
            descendants: Vec::new(),
        };
        let started = Instant::now();
        let mut escalate_at: Option<Instant> = None;
        let mut drain_until: Option<Instant> = None;
        let mut ticker = tokio::time::interval(Duration::from_millis(50));
        loop {
            if turn.exit.is_some()
                && (stdout.is_none() || drain_until.is_some_and(|until| Instant::now() >= until))
            {
                break;
            }
            tokio::select! {
                line = next_line(stdout.as_mut()) => match line {
                    Ok(Some(text)) => {
                        if turn.signal_sent.is_some() {
                            turn.lines_after_signal += 1;
                        }
                        match serde_json::from_str::<Value>(&text) {
                            Ok(value) => {
                                let events = turn.adapter.feed(&value);
                                turn.events.extend(events);
                                turn.lines.push(value);
                            }
                            Err(_) => {
                                turn.adapter.note_unparsed(text.as_bytes());
                                if turn.unparsed.len() < 20 {
                                    turn.unparsed.push(turn.adapter.redactor().bounded(&text, 400));
                                }
                            }
                        }
                        if turn.signal_sent.is_none() && turn.exit.is_none() {
                            let now = Instant::now();
                            match plan {
                                StopPlan::AtEndOfTurn
                                    if !matches!(turn.adapter.status(), AdapterStatus::Running) =>
                                {
                                    send_signal(pid, libc::SIGTERM);
                                    turn.signal_sent = Some(("SIGTERM", now));
                                    escalate_at = Some(now + SIGTERM_GRACE);
                                }
                                StopPlan::OnFirstDraft(signal) if turn.drafted() => {
                                    send_signal(pid, signal);
                                    turn.signal_sent = Some((signal_name(signal), now));
                                    escalate_at = Some(
                                        now + if signal == libc::SIGTERM {
                                            SIGTERM_GRACE
                                        } else {
                                            SIGINT_GRACE
                                        },
                                    );
                                }
                                StopPlan::CloseStdoutAfterFirstLine => {
                                    stdout = None;
                                    turn.signal_sent = Some(("closed stdout", now));
                                    escalate_at = Some(now + CLOSED_STDOUT_GRACE);
                                }
                                _ => {}
                            }
                        }
                    }
                    Ok(None) | Err(_) => stdout = None,
                },
                status = child.wait(), if turn.exit.is_none() => {
                    let status = status.expect("claude's exit status");
                    turn.exit = Some(status);
                    drain_until = Some(Instant::now() + AFTER_EXIT_DRAIN);
                    if let Some((_, sent)) = turn.signal_sent {
                        turn.exit_after_signal = Some(sent.elapsed());
                    }
                },
                _ = ticker.tick() => {
                    tracker.observe();
                    let now = Instant::now();
                    if turn.exit.is_none() && !turn.killed {
                        let overdue = escalate_at.is_some_and(|at| now >= at);
                        let too_long = now >= started + TURN_LIMIT;
                        if overdue || too_long {
                            send_signal(pid, libc::SIGKILL);
                            turn.killed = true;
                            turn.timed_out = too_long && !overdue;
                        }
                    }
                }
            }
        }
        tracker.observe();
        turn.descendants = tracker.kill_survivors();
        if let Some(writer) = writer {
            writer.abort();
        }
        if let Some(stderr) = stderr
            && let Ok(Ok(tail)) = tokio::time::timeout(Duration::from_secs(2), stderr).await
        {
            turn.stderr = turn.adapter.redactor().text(&tail);
        }
        turn
    }
}

// ---- One turn ------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopPlan {
    /// SIGTERM once the adapter says the turn ended, or a launch check failed, as the lane does.
    AtEndOfTurn,
    /// This signal once the first reply draft streams.
    OnFirstDraft(i32),
    /// Close stdout after the first line.
    CloseStdoutAfterFirstLine,
}

#[derive(Clone, Copy, Debug)]
struct ProcessIds {
    pid: i32,
    pgid: i32,
    sid: i32,
}

#[derive(Clone, Debug)]
struct ObservedProcess {
    pid: i32,
    name: String,
    pgid: i32,
    sid: i32,
}

struct LiveTurn {
    /// Every line `claude` printed that parsed.
    lines: Vec<Value>,
    /// The first lines that did not, redacted and bounded.
    unparsed: Vec<String>,
    adapter: EventAdapter,
    /// The events the adapter made of them.
    events: Vec<Value>,
    exit: Option<ExitStatus>,
    /// The tail of stderr, redacted.
    stderr: String,
    signal_sent: Option<(&'static str, Instant)>,
    exit_after_signal: Option<Duration>,
    lines_after_signal: usize,
    killed: bool,
    timed_out: bool,
    root: ProcessIds,
    descendants: Vec<ObservedProcess>,
}

impl LiveTurn {
    fn init_line(&self) -> Option<&Value> {
        self.lines.iter().find(|line| {
            line.get("type").and_then(Value::as_str) == Some("system")
                && line.get("subtype").and_then(Value::as_str) == Some("init")
        })
    }

    /// The latest `result` that is not a subagent's.
    fn top_level_result(&self) -> Option<&Value> {
        self.lines.iter().rev().find(|line| {
            line.get("type").and_then(Value::as_str) == Some("result")
                && line
                    .get("parent_tool_use_id")
                    .is_none_or(|parent| parent.is_null())
        })
    }

    fn reply(&self) -> String {
        self.adapter.reply().unwrap_or_default().to_string()
    }

    /// Everything the model wrote: its text blocks, and the reply.
    fn assistant_text(&self) -> String {
        let mut text = String::new();
        for line in &self.lines {
            if line.get("type").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            for block in line
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(block_text) = block.get("text").and_then(Value::as_str) {
                    text.push_str(block_text);
                    text.push('\n');
                }
            }
        }
        text.push_str(&self.reply());
        text
    }

    fn used_tools(&self) -> bool {
        self.lines.iter().any(|line| {
            line.get("type").and_then(Value::as_str) == Some("assistant")
                && line
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("tool_use")
                        })
                    })
        })
    }

    fn drafted(&self) -> bool {
        self.events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("item.updated")
                && event.pointer("/item/type").and_then(Value::as_str) == Some("agent_message")
        })
    }

    /// How the turn went, for a finding's detail.
    fn summary(&self) -> String {
        let status = match self.adapter.status() {
            AdapterStatus::Running => "still running when it stopped".to_string(),
            AdapterStatus::EndOfTurn => "ended at its result".to_string(),
            AdapterStatus::Unexpected(why) => format!("a launch check failed: {why}"),
        };
        let mut summary = format!(
            "turn: {status}; {} lines, {} results, succeeded: {}; {}{}",
            self.lines.len(),
            self.adapter.results(),
            self.adapter.succeeded(),
            describe_exit(self.exit),
            if self.timed_out {
                "; killed after the suite's time limit"
            } else {
                ""
            }
        );
        if !self.unparsed.is_empty() {
            summary.push_str(&format!("\nunparsed output: {}", self.unparsed.join(" | ")));
        }
        if !self.adapter.succeeded() && !self.stderr.trim().is_empty() {
            summary.push_str(&format!("\nstderr: {}", last_lines(&self.stderr, 5)));
        }
        summary
    }

    /// What a signal, or a closed stdout, did.
    fn signal_summary(&self) -> String {
        match self.signal_sent {
            None => format!(
                "nothing was sent: the turn never reached that point\n{}",
                self.summary()
            ),
            Some((sent, _)) => {
                format!(
                    "{sent} sent; {}{}; {} lines printed after it; a result after it: {}",
                    describe_exit(self.exit),
                    match self.exit_after_signal {
                        Some(after) => format!(" after {} ms", after.as_millis()),
                        None => String::new(),
                    },
                    self.lines_after_signal,
                    self.result_after_signal(),
                ) + if self.killed {
                    "; it did not exit within the grace, so it was killed"
                } else {
                    ""
                }
            }
        }
    }

    fn result_after_signal(&self) -> bool {
        self.lines_after_signal > 0
            && self
                .lines
                .iter()
                .rev()
                .take(self.lines_after_signal)
                .any(|line| line.get("type").and_then(Value::as_str) == Some("result"))
    }
}

fn send_signal(pid: i32, signal: i32) {
    // SAFETY: a signal to the `claude` this suite started and has not reaped.
    unsafe { libc::kill(pid, signal) };
}

fn signal_name(signal: i32) -> &'static str {
    match signal {
        libc::SIGTERM => "SIGTERM",
        libc::SIGINT => "SIGINT",
        libc::SIGKILL => "SIGKILL",
        _ => "a signal",
    }
}

fn describe_exit(status: Option<ExitStatus>) -> String {
    match status {
        Some(status) => match (status.code(), status.signal()) {
            (Some(code), _) => format!("exit code {code}"),
            (None, Some(signal)) => format!("killed by signal {signal}"),
            (None, None) => "ended".to_string(),
        },
        None => "never exited".to_string(),
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or_default()
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(count)..].join(" | ")
}

fn nonce(kind: &str) -> String {
    format!(
        "INSTAFY-{kind}-{}",
        Uuid::new_v4().simple().to_string()[..12].to_uppercase()
    )
}

async fn next_line(
    lines: Option<&mut Lines<BufReader<ChildStdout>>>,
) -> std::io::Result<Option<String>> {
    match lines {
        Some(lines) => lines.next_line().await,
        None => std::future::pending().await,
    }
}

async fn read_tail(mut stderr: ChildStderr, cap: usize) -> String {
    let mut tail = Vec::new();
    let mut chunk = vec![0u8; 8 * 1024];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                tail.extend_from_slice(&chunk[..read]);
                if tail.len() > cap {
                    tail.drain(..tail.len() - cap);
                }
            }
        }
    }
    String::from_utf8_lossy(&tail).into_owned()
}

/// The processes a turn's `claude` started, found by parent links every 50 ms as the lane's
/// tracker finds them (3.6), with the group and session each was in.
struct Tracker {
    identities: HashMap<Pid, u64>,
    root: Pid,
    system: System,
    seen: Vec<ObservedProcess>,
}

impl Tracker {
    fn new(pid: u32) -> Self {
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessRefreshKind::new());
        let root = Pid::from_u32(pid);
        let identities = system
            .process(root)
            .map(|process| HashMap::from([(root, process.start_time())]))
            .unwrap_or_default();
        Self {
            identities,
            root,
            system,
            seen: Vec::new(),
        }
    }

    fn observe(&mut self) {
        self.system
            .refresh_processes_specifics(ProcessRefreshKind::new());
        loop {
            let new: Vec<(Pid, u64, String)> = self
                .system
                .processes()
                .iter()
                .filter_map(|(pid, process)| {
                    if self.identities.contains_key(pid) {
                        return None;
                    }
                    let parent = process.parent()?;
                    let known = self.identities.get(&parent)?;
                    let actual = self.system.process(parent)?;
                    (actual.start_time() == *known)
                        .then(|| (*pid, process.start_time(), process.name().to_string()))
                })
                .collect();
            if new.is_empty() {
                break;
            }
            for (pid, start, name) in new {
                let raw = pid.as_u32() as i32;
                // SAFETY: plain queries of a process this turn started.
                let (pgid, sid) = unsafe { (libc::getpgid(raw), libc::getsid(raw)) };
                self.seen.push(ObservedProcess {
                    pid: raw,
                    name,
                    pgid,
                    sid,
                });
                self.identities.insert(pid, start);
            }
        }
    }

    /// Kills every process the turn started that still runs, and returns all it saw.
    fn kill_survivors(mut self) -> Vec<ObservedProcess> {
        self.system
            .refresh_processes_specifics(ProcessRefreshKind::new());
        for (pid, start) in &self.identities {
            if *pid == self.root {
                continue;
            }
            if self
                .system
                .process(*pid)
                .is_some_and(|process| process.start_time() == *start)
            {
                send_signal(pid.as_u32() as i32, libc::SIGKILL);
            }
        }
        self.seen
    }
}

// ---- What the checks read ------------------------------------------------------------------

/// The `--help` lines about `--bare` and `--no-bare`: what the bare check reads (3.2).
fn bare_help_lines(help: &str) -> Vec<String> {
    help.lines()
        .filter(|line| line.contains("--bare") || line.contains("--no-bare"))
        .map(|line| line.trim().to_string())
        .collect()
}

/// The planted tokens `text` holds.
fn planted_tokens_found(text: &str, planted: &[String]) -> Vec<String> {
    planted
        .iter()
        .filter(|token| text.contains(token.as_str()))
        .cloned()
        .collect()
}

/// The result fields the lane reads (3.6-3.8).
const REQUIRED_RESULT_FIELDS: [&str; 3] = ["result", "is_error", "usage"];
/// The result fields Phase 0 item 5 lists.
const RESULT_FIELDS: [&str; 5] = [
    "result",
    "is_error",
    "usage",
    "permission_denials",
    "total_cost_usd",
];

fn missing_result_fields(result: &Value) -> Vec<&'static str> {
    RESULT_FIELDS
        .into_iter()
        .filter(|field| result.get(*field).is_none())
        .collect()
}

struct DeltaSummary {
    stream_events: usize,
    text_deltas: usize,
    all_carry_parent: bool,
}

/// The `stream_event` lines, how many are text deltas, and whether each carries
/// `parent_tool_use_id` (null for the main conversation), which the adapter reads (3.7).
fn text_delta_summary(lines: &[Value]) -> DeltaSummary {
    let stream_events: Vec<&Value> = lines
        .iter()
        .filter(|line| line.get("type").and_then(Value::as_str) == Some("stream_event"))
        .collect();
    DeltaSummary {
        stream_events: stream_events.len(),
        text_deltas: stream_events
            .iter()
            .filter(|line| {
                line.pointer("/event/type").and_then(Value::as_str) == Some("content_block_delta")
                    && line.pointer("/event/delta/type").and_then(Value::as_str)
                        == Some("text_delta")
            })
            .count(),
        all_carry_parent: !stream_events.is_empty()
            && stream_events
                .iter()
                .all(|line| line.get("parent_tool_use_id").is_some()),
    }
}

struct TaskEvent {
    subtype: String,
    id: bool,
    task_type: Option<String>,
    status: Option<String>,
    /// A `background_tasks_changed` event's own keys, and its list as the adapter reads it.
    keys: Vec<String>,
    list: Option<TaskList>,
}

/// The list of a `background_tasks_changed` event: the shape the adapter guesses (3.6).
struct TaskList {
    /// The key that holds it.
    key: String,
    /// Each entry's keys.
    entries: Vec<Vec<String>>,
    /// The entries with no id the adapter reads.
    without_id: usize,
}

impl TaskEvent {
    fn describe(&self) -> String {
        let mut described = format!(
            "{} (task id: {}, task_type: {}, status: {})",
            self.subtype,
            self.id,
            self.task_type.as_deref().unwrap_or("none"),
            self.status.as_deref().unwrap_or("none")
        );
        if self.subtype == "background_tasks_changed" {
            match &self.list {
                Some(list) => described.push_str(&format!(
                    " list under {}: {} entries, {} with no id the adapter reads; entry keys: {}",
                    list.key,
                    list.entries.len(),
                    list.without_id,
                    list.entries
                        .iter()
                        .map(|keys| format!("[{}]", keys.join(", ")))
                        .collect::<Vec<_>>()
                        .join(" ")
                )),
                None => described.push_str(&format!(
                    " no list the adapter reads; event keys: [{}]",
                    self.keys.join(", ")
                )),
            }
        }
        described
    }
}

/// Whether `value` has a task id the adapter reads: a string that is not blank, or a number.
fn reads_a_task_id(value: &Value) -> bool {
    ["task_id", "taskId", "id"]
        .iter()
        .any(|key| match value.get(*key) {
            Some(Value::String(id)) => !id.trim().is_empty(),
            Some(Value::Number(_)) => true,
            _ => false,
        })
}

/// The `system/task_*` and `background_tasks_changed` events, as the adapter reads them (3.6).
fn task_event_summary(lines: &[Value]) -> Vec<TaskEvent> {
    lines
        .iter()
        .filter(|line| line.get("type").and_then(Value::as_str) == Some("system"))
        .filter_map(|line| {
            let subtype = line.get("subtype").and_then(Value::as_str)?;
            matches!(
                subtype,
                "task_started" | "task_notification" | "background_tasks_changed"
            )
            .then(|| TaskEvent {
                subtype: subtype.to_string(),
                id: reads_a_task_id(line),
                task_type: ["task_type", "taskType"]
                    .iter()
                    .find_map(|key| line.get(*key).and_then(Value::as_str))
                    .map(str::to_string),
                status: line
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                keys: line
                    .as_object()
                    .map(|object| object.keys().cloned().collect())
                    .unwrap_or_default(),
                list: ["tasks", "background_tasks", "backgroundTasks"]
                    .iter()
                    .find_map(|key| Some((*key, line.get(*key)?.as_array()?)))
                    .map(|(key, entries)| TaskList {
                        key: key.to_string(),
                        entries: entries
                            .iter()
                            .map(|entry| {
                                entry
                                    .as_object()
                                    .map(|object| object.keys().cloned().collect())
                                    .unwrap_or_default()
                            })
                            .collect(),
                        without_id: entries
                            .iter()
                            .filter(|entry| !reads_a_task_id(entry))
                            .count(),
                    }),
            })
        })
        .collect()
}

/// Whether the latest top-level `result` came after the first `task_notification`: the reply is
/// not the interim one of a result printed while the background task still ran.
fn result_after_notification(lines: &[Value]) -> bool {
    let notified = lines.iter().position(|line| {
        line.get("type").and_then(Value::as_str) == Some("system")
            && line.get("subtype").and_then(Value::as_str) == Some("task_notification")
    });
    let replied = lines.iter().rposition(|line| {
        line.get("type").and_then(Value::as_str) == Some("result")
            && line
                .get("parent_tool_use_id")
                .is_none_or(|parent| parent.is_null())
    });
    matches!((notified, replied), (Some(notified), Some(replied)) if replied > notified)
}

/// Item 5's verdict (3.6). It holds only when a `task_started` carried a task id and type, a
/// `task_notification` a task id, every `background_tasks_changed` a list whose entries all carry
/// an id the adapter reads, and the turn's reply came from a result after the notification: at
/// least two results, the later one with the subagent's PONG.
fn background_verdict(
    tasks: &[TaskEvent],
    lines: &[Value],
    results: usize,
    reply: &str,
) -> Verdict {
    let started = tasks
        .iter()
        .any(|task| task.subtype == "task_started" && task.id && task.task_type.is_some());
    let ended = tasks
        .iter()
        .any(|task| task.subtype == "task_notification" && task.id);
    let lists_read = tasks
        .iter()
        .filter(|task| task.subtype == "background_tasks_changed")
        .all(|task| task.list.as_ref().is_some_and(|list| list.without_id == 0));
    let replied_after = results >= 2 && reply.contains("PONG") && result_after_notification(lines);
    if started && ended && lists_read && replied_after {
        Verdict::Holds
    } else {
        Verdict::Unconfirmed
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileState {
    directory: bool,
    len: u64,
    modified: Option<SystemTime>,
}

/// Every path under `folder`, relative, with its kind, size and modification time. Links are
/// not followed.
fn folder_state(folder: &Path) -> BTreeMap<String, FileState> {
    let mut state = BTreeMap::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            let relative = path
                .strip_prefix(folder)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            if metadata.is_dir() {
                pending.push(path);
            }
            state.insert(
                relative,
                FileState {
                    directory: metadata.is_dir(),
                    len: if metadata.is_dir() { 0 } else { metadata.len() },
                    modified: if metadata.is_dir() {
                        None
                    } else {
                        metadata.modified().ok()
                    },
                },
            );
        }
    }
    state
}

/// The paths added, changed or removed between two states.
fn folder_changes(
    before: &BTreeMap<String, FileState>,
    after: &BTreeMap<String, FileState>,
) -> Vec<String> {
    let mut changes: Vec<String> = after
        .iter()
        .filter(|(path, state)| before.get(*path) != Some(state))
        .map(|(path, _)| path.clone())
        .collect();
    changes.extend(
        before
            .keys()
            .filter(|path| !after.contains_key(*path))
            .map(|path| format!("{path} (removed)")),
    );
    changes
}

/// A path with a `.claude` segment, in any letter case, as the lane filter compares (3.8).
fn has_dot_claude_segment(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|component| component.as_os_str().eq_ignore_ascii_case(".claude"))
}

fn folder_names(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

// ---- The suite's own checks, hermetic ------------------------------------------------------

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/fake-claude-fixtures"
);

fn fixture_lines(scenario: &str) -> Vec<Value> {
    std::fs::read_to_string(format!("{FIXTURES}/scenarios/{scenario}.jsonl"))
        .expect("a scenario")
        .lines()
        .filter(|line| !line.starts_with("#!"))
        .map(|line| serde_json::from_str(line).expect("a stream-json line"))
        .collect()
}

#[test]
fn the_suite_runs_only_when_a_person_sets_the_variable() {
    for unset in [None, Some(""), Some("0"), Some("true"), Some("yes")] {
        let not_run = live_gate(unset, false).expect_err("not run");
        assert!(not_run.starts_with("not run:"), "{not_run}");
        assert!(not_run.contains("never passes"), "{not_run}");
    }
    assert!(live_gate(Some("1"), true).is_err());
    assert_eq!(live_gate(Some("1"), false), Ok(()));
}

#[test]
fn the_report_passes_only_when_nothing_fails_or_is_unconfirmed() {
    let mut report = Report {
        cli: "2.1.314".to_string(),
        verified_through: "2.1.314".to_string(),
        plan_sign_in: true,
        help_lines: Vec::new(),
        findings: Vec::new(),
    };
    report.add("item 1", "holds", Verdict::Holds, "");
    report.add("item 9", "recorded", Verdict::Recorded, "");
    assert!(report.passed());
    report.add(
        "item 5",
        "unconfirmed",
        Verdict::Unconfirmed,
        "no task events",
    );
    assert!(!report.passed());
    assert!(report.failures().contains("item 5 UNCONFIRMED"));
    report.findings.pop();
    report.add("item 6", "fails", Verdict::Fails, "killed by signal 15");
    assert!(!report.passed());
    assert!(report.failures().contains("killed by signal 15"));
}

#[test]
fn the_suite_reads_the_stream_shapes_the_lane_expects() {
    let lines = fixture_lines("success");
    let deltas = text_delta_summary(&lines);
    assert!(deltas.text_deltas > 0 && deltas.all_carry_parent);
    let result = lines
        .iter()
        .rev()
        .find(|line| line["type"] == "result")
        .expect("a result");
    assert!(missing_result_fields(result).is_empty());
    let mut bare = result.clone();
    bare.as_object_mut().unwrap().remove("total_cost_usd");
    bare.as_object_mut().unwrap().remove("usage");
    assert_eq!(missing_result_fields(&bare), ["usage", "total_cost_usd"]);

    let tasks = task_event_summary(&fixture_lines("result-subagent"));
    assert!(tasks.iter().any(|task| task.subtype == "task_started"
        && task.id
        && task.task_type.as_deref() == Some("local_agent")));
    assert!(
        tasks
            .iter()
            .any(|task| task.subtype == "task_notification" && task.id)
    );
}

/// Item 5 holds only on what the end-of-turn rule reads, and only when the turn's reply is the
/// result after the subagent's: an interim result, a list whose entries the adapter cannot tell
/// apart, or a list under another key leaves it unconfirmed, with the shapes in its details.
#[test]
fn item_5_holds_only_when_the_reply_follows_the_task_and_every_list_is_read() {
    let lines = fixture_lines("result-subagent");
    let verdict = |lines: &[Value], results: usize, reply: &str| {
        background_verdict(&task_event_summary(lines), lines, results, reply)
    };
    assert_eq!(verdict(&lines, 2, "PONG"), Verdict::Holds);
    // The turn ended at the interim result, or its reply is not the subagent's answer.
    assert_eq!(verdict(&lines, 1, "PONG"), Verdict::Unconfirmed);
    assert_eq!(
        verdict(&lines, 2, "A helper is looking."),
        Verdict::Unconfirmed
    );
    let notification = lines
        .iter()
        .position(|line| line["subtype"] == "task_notification")
        .expect("a task_notification");
    let mut late = lines.clone();
    let moved = late.remove(notification);
    late.push(moved);
    assert!(!result_after_notification(&late));
    assert_eq!(verdict(&late, 2, "PONG"), Verdict::Unconfirmed);

    // A list the adapter reads, and one whose entry it cannot tell apart.
    let listed = |list: Value| {
        let mut listed = lines.clone();
        listed.insert(notification, list);
        listed
    };
    let read = listed(serde_json::json!({
        "type": "system", "subtype": "background_tasks_changed",
        "tasks": [{"task_id": "agent_1", "task_type": "local_agent"}],
    }));
    assert_eq!(verdict(&read, 2, "PONG"), Verdict::Holds);
    let unread = listed(serde_json::json!({
        "type": "system", "subtype": "background_tasks_changed",
        "tasks": [{"agent_id": "agent_1", "task_type": "local_agent"}],
    }));
    assert_eq!(verdict(&unread, 2, "PONG"), Verdict::Unconfirmed);
    let described: Vec<String> = task_event_summary(&unread)
        .iter()
        .map(TaskEvent::describe)
        .collect();
    assert!(
        described
            .iter()
            .any(|event| event.contains("1 with no id") && event.contains("[agent_id, task_type]")),
        "{described:?}"
    );
    let elsewhere = listed(serde_json::json!({
        "type": "system", "subtype": "background_tasks_changed",
        "running": [{"task_id": "agent_1"}],
    }));
    assert_eq!(verdict(&elsewhere, 2, "PONG"), Verdict::Unconfirmed);
    assert!(
        task_event_summary(&elsewhere)
            .iter()
            .map(TaskEvent::describe)
            .any(|event| event.contains("no list the adapter reads") && event.contains("running")),
    );
}

#[test]
fn the_suite_finds_the_bare_help_lines_and_planted_tokens() {
    let help = std::fs::read_to_string(format!("{FIXTURES}/help/bare-default-with-no-bare.txt"))
        .expect("help text");
    let lines = bare_help_lines(&help);
    assert!(
        lines.iter().any(|line| line.starts_with("--bare")),
        "{lines:?}"
    );
    assert!(
        lines.iter().any(|line| line.starts_with("--no-bare")),
        "{lines:?}"
    );

    let planted = vec![
        "CANARY-PROJECT-RUN1".to_string(),
        "CANARY-HOME-RUN1".to_string(),
    ];
    assert_eq!(
        planted_tokens_found("CHECKED\nCANARY-PROMPT-RUN1\nCANARY-HOME-RUN1", &planted),
        ["CANARY-HOME-RUN1"]
    );
    assert!(planted_tokens_found("CHECKED\nNONE", &planted).is_empty());
}

#[test]
fn the_suite_sees_what_a_turn_wrote_under_dot_claude_in_any_letter_case() {
    let folder = tempfile::tempdir().unwrap();
    write(&folder.path().join("README.md"), "# Live check\n");
    write(&folder.path().join("keep.txt"), "same\n");
    let before = folder_state(folder.path());
    write(&folder.path().join(".Claude/settings.local.json"), "{}\n");
    write(&folder.path().join("notes/new.md"), "new\n");
    std::fs::remove_file(folder.path().join("keep.txt")).unwrap();
    let after = folder_state(folder.path());
    let changes = folder_changes(&before, &after);
    assert!(changes.contains(&".Claude".to_string()), "{changes:?}");
    assert!(changes.contains(&".Claude/settings.local.json".to_string()));
    assert!(changes.contains(&"notes/new.md".to_string()));
    assert!(changes.contains(&"keep.txt (removed)".to_string()));
    assert!(!changes.contains(&"README.md".to_string()));
    let under: Vec<&String> = changes
        .iter()
        .filter(|path| has_dot_claude_segment(path))
        .collect();
    assert_eq!(under.len(), 2, "{under:?}");
    assert!(!has_dot_claude_segment("docs/claude.md"));
    assert!(!has_dot_claude_segment(".claudeignore"));
}
