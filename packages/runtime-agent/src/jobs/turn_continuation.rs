//! A turn that runs out of time hands its work to a new turn instead of dying.
//!
//! - **Wrap-up.** Shortly before an ordinary turn's hard limit the runtime steers it once with a
//!   note (`TurnWrapUp`): finish the step, save the work, end the turn.
//! - **Continuation note.** A job the controller can continue (a team's lane or follow-on agent
//!   that has continuations left) gets `INSTAFY_TURN_CONTINUE_FILE`: the agent writes what is left
//!   there before it ends. The runtime records it as `agent/turn-continuation`, and the controller
//!   starts the continuation turn from it. A turn the hard limit stops anyway is recorded the same
//!   way (`endedBy: "time_limit"`), with its last commands as the note when it wrote none, and its
//!   run log is kept.
//! - **Timings.** Every command's start and duration (`atMs` on the run log's item events), the
//!   wrap-up, and the steps tools report in `INSTAFY_STEP_TIMINGS_FILE` (one JSON object per line)
//!   become `agent/turn-timings`, so an eval can show where a turn's time went.
//!
//! Skills say how to use the note and the timings file; nothing here knows a skill.

use super::*;
use crate::codex::{TURN_WRAP_UP_EVENT_TYPE, TurnWrapUp};
use std::time::Duration;

pub(super) const TURN_CONTINUATION_ARTIFACT: &str = "agent/turn-continuation";
pub(super) const TURN_TIMINGS_ARTIFACT: &str = "agent/turn-timings";
const NOTE_MAX_CHARS: usize = 2_000;
const STEP_RECORDS_MAX: usize = 300;
const STEP_RECORD_MAX_BYTES: usize = 2_000;
const TIMED_COMMANDS_MAX: usize = 200;
const COMMAND_TEXT_MAX_CHARS: usize = 160;
const DEFAULT_WRAP_UP_SECONDS: u64 = 120;

/// The files a turn's tools may write, in a folder of the job's own outside the workspace (so
/// nothing in it is ever published).
pub(super) struct TurnFiles {
    dir: PathBuf,
    timings: PathBuf,
    continue_note: Option<PathBuf>,
}

impl TurnFiles {
    pub(super) fn for_job(job: &LeaseJob) -> Self {
        Self::in_dir(
            env::temp_dir()
                .join("instafy-turns")
                .join(job.id.to_string()),
            job_turn_can_continue(&job.payload),
        )
    }

    pub(super) fn in_dir(dir: PathBuf, continuable: bool) -> Self {
        let _ = fs::create_dir_all(&dir);
        Self {
            timings: dir.join("step-timings.ndjson"),
            continue_note: continuable.then(|| dir.join("continue.md")),
            dir,
        }
    }

    pub(super) fn continuable(&self) -> bool {
        self.continue_note.is_some()
    }

    /// The variables the agent's shell gets for this turn.
    pub(super) fn env_overrides(&self) -> Vec<EnvOverride> {
        vec![
            EnvOverride::apply("INSTAFY_STEP_TIMINGS_FILE", &self.timings.to_string_lossy()),
            match self.continue_note.as_ref() {
                Some(path) => {
                    EnvOverride::apply("INSTAFY_TURN_CONTINUE_FILE", &path.to_string_lossy())
                }
                None => EnvOverride::remove("INSTAFY_TURN_CONTINUE_FILE"),
            },
        ]
    }

    /// The steps tools reported, oldest first (lines that are not JSON objects are skipped).
    pub(super) fn step_timings(&self) -> Vec<JsonValue> {
        let Ok(text) = fs::read_to_string(&self.timings) else {
            return Vec::new();
        };
        text.lines()
            .filter(|line| !line.trim().is_empty() && line.len() <= STEP_RECORD_MAX_BYTES)
            .filter_map(|line| serde_json::from_str::<JsonValue>(line).ok())
            .filter(JsonValue::is_object)
            .take(STEP_RECORDS_MAX)
            .collect()
    }

    /// What the agent wrote is left, trimmed and capped; None when it wrote nothing.
    pub(super) fn continuation_note(&self) -> Option<String> {
        let text = fs::read_to_string(self.continue_note.as_ref()?).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| text.chars().take(NOTE_MAX_CHARS).collect())
    }

    pub(super) fn remove(&self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Whether the controller may start another turn for this job: a team's lane or follow-on agent
/// whose continuation (if it is one) is not marked the last one.
pub(super) fn job_turn_can_continue(payload: &JsonValue) -> bool {
    is_multi_agent_worker_payload(payload)
        && payload
            .pointer("/metadata/multiAgentPlan/continuation/last")
            .and_then(JsonValue::as_bool)
            != Some(true)
}

/// The wrap-up steer for an ordinary turn with this hard limit, or None when the limit is too
/// short to leave room for one.
pub(super) fn turn_wrap_up(run_timeout: Duration, continuable: bool) -> Option<TurnWrapUp> {
    let window = env::var("INSTAFY_TURN_WRAP_UP_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(DEFAULT_WRAP_UP_SECONDS));
    if window.is_zero() || window >= run_timeout {
        return None;
    }
    Some(TurnWrapUp {
        after: run_timeout - window,
        message: turn_wrap_up_message(window, continuable),
    })
}

pub(super) fn turn_wrap_up_message(window: Duration, continuable: bool) -> String {
    let minutes = (window.as_secs() + 30) / 60;
    let left = if minutes <= 1 {
        "about a minute".to_string()
    } else {
        format!("about {minutes} minutes")
    };
    if continuable {
        format!(
            "[Instafy runtime] This turn stops in {left}. Do not start a new long step. Finish or stop the step you are on and make sure your work so far is saved in files. If work is left, write what is left, in order, to the file named by $INSTAFY_TURN_CONTINUE_FILE (what is done, what comes next, and any background job to wait for), for example: printf '%s\\n' '<what is left>' > \"$INSTAFY_TURN_CONTINUE_FILE\". Then end this turn with a short summary. A new turn of yours starts right after, from your saved files and that note, so do not tell the person the work is finished when it is not."
        )
    } else {
        format!(
            "[Instafy runtime] This turn stops in {left}. Do not start a new long step. Finish or stop the step you are on, make sure your work so far is saved in files, and end this turn: say what is done and what is still open."
        )
    }
}

/// How long each command took, from the run log's stamped item events, and when the wrap-up came.
pub(super) fn turn_timings_artifact(events: &[JsonValue]) -> Option<JsonValue> {
    let mut started: HashMap<String, (u64, String)> = HashMap::new();
    let mut commands = Vec::new();
    let mut last_at = 0u64;
    let mut wrap_up = JsonValue::Null;
    let mut dropped = 0usize;
    for event in events {
        let at = event.get("atMs").and_then(JsonValue::as_u64);
        if let Some(at) = at {
            last_at = last_at.max(at);
        }
        if event.get("type").and_then(JsonValue::as_str) == Some(TURN_WRAP_UP_EVENT_TYPE) {
            wrap_up = json!({
                "atMs": event.get("atMs").cloned().unwrap_or(JsonValue::Null),
                "steered": event.get("steered").cloned().unwrap_or(JsonValue::Bool(false)),
            });
            continue;
        }
        let Some(item) = event.get("item") else {
            continue;
        };
        let kind = item
            .get("type")
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        if !matches!(kind, "command_execution" | "mcp_tool_call" | "web_search") {
            continue;
        }
        let (Some(id), Some(at)) = (item.get("id").and_then(JsonValue::as_str), at) else {
            continue;
        };
        let text = item
            .get("command")
            .or_else(|| item.get("tool"))
            .or_else(|| item.get("query"))
            .and_then(JsonValue::as_str)
            .map(|text| shorten_command(text))
            .unwrap_or_else(|| kind.to_string());
        match event.get("type").and_then(JsonValue::as_str) {
            Some("item.started") => {
                started.insert(id.to_string(), (at, text));
            }
            Some("item.completed") => {
                let (start, text) = started.remove(id).unwrap_or((at, text));
                if commands.len() >= TIMED_COMMANDS_MAX {
                    dropped += 1;
                    continue;
                }
                commands.push(json!({
                    "kind": kind,
                    "command": text,
                    "startMs": start,
                    "ms": at.saturating_sub(start),
                    "status": item.get("status").cloned().unwrap_or(JsonValue::Null),
                    "exitCode": item.get("exit_code").cloned().unwrap_or(JsonValue::Null),
                }));
            }
            _ => {}
        }
    }
    // a command still running when the turn ended (stopped at the limit)
    for (start, text) in started.into_values() {
        if commands.len() < TIMED_COMMANDS_MAX {
            commands.push(json!({
                "kind": "command_execution",
                "command": text,
                "startMs": start,
                "ms": last_at.saturating_sub(start),
                "status": "unfinished",
                "exitCode": JsonValue::Null,
            }));
        }
    }
    if commands.is_empty() && wrap_up.is_null() {
        return None;
    }
    commands.sort_by_key(|command| command["startMs"].as_u64().unwrap_or(0));
    let tool_ms: u64 = commands
        .iter()
        .filter_map(|command| command["ms"].as_u64())
        .sum();
    Some(json!({
        "kind": TURN_TIMINGS_ARTIFACT,
        "lastEventMs": last_at,
        "commandMs": tool_ms,
        "commands": commands,
        "commandsDropped": dropped,
        "wrapUp": wrap_up,
    }))
}

fn shorten_command(text: &str) -> String {
    let text = text
        .strip_prefix("/bin/bash -lc ")
        .or_else(|| text.strip_prefix("bash -lc "))
        .unwrap_or(text)
        .trim();
    let mut out: String = text.chars().take(COMMAND_TEXT_MAX_CHARS).collect();
    if text.chars().count() > COMMAND_TEXT_MAX_CHARS {
        out.push('…');
    }
    out
}

/// The run log and timings of a turn that ended in an error, from the events streamed so far.
pub(super) fn failed_turn_artifacts(events: &[JsonValue]) -> Vec<JsonValue> {
    if events.is_empty() {
        return Vec::new();
    }
    let mut artifacts = vec![build_codex_run_log_artifact(
        events,
        Some(json!({ "endedWith": "error" })),
    )];
    artifacts.extend(turn_timings_artifact(events));
    artifacts
}

/// "Codex run timed out": the turn's hard limit, not a failure of its own work.
pub(super) fn is_turn_time_limit(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().starts_with("Codex run timed out"))
}

/// The last few commands of a turn, as a note for its continuation when it wrote none.
fn last_commands_note(artifacts: &[JsonValue]) -> Option<String> {
    let timings = artifacts
        .iter()
        .find(|artifact| artifact["kind"] == TURN_TIMINGS_ARTIFACT)?;
    let commands = timings["commands"].as_array()?;
    let tail: Vec<String> = commands
        .iter()
        .rev()
        .take(3)
        .rev()
        .filter_map(|command| {
            let text = command["command"].as_str()?;
            let state = match command["status"].as_str() {
                Some("unfinished") => "still running".to_string(),
                _ => match command["exitCode"].as_i64() {
                    Some(code) => format!("exit {code}"),
                    None => "ended".to_string(),
                },
            };
            Some(format!("- {text} ({state})"))
        })
        .collect();
    (!tail.is_empty()).then(|| {
        format!(
            "No note was written: the turn was stopped at its time limit. Its last commands were:\n{}",
            tail.join("\n")
        )
    })
}

/// Adds the step timings the turn's tools reported and, for a job that can be continued, the
/// continuation request, to the job's result. The job's turn files are removed afterwards.
pub(super) fn attach_turn_records(
    result: Result<JobExecution>,
    files: &TurnFiles,
) -> Result<JobExecution> {
    let steps = files.step_timings();
    let note = files.continuation_note();
    let continuable = files.continuable();
    files.remove();
    let add = |artifacts: &mut Vec<JsonValue>, ended_by: Option<&str>| {
        if !steps.is_empty() {
            match artifacts
                .iter_mut()
                .find(|artifact| artifact["kind"] == TURN_TIMINGS_ARTIFACT)
            {
                Some(timings) => timings["steps"] = JsonValue::Array(steps.clone()),
                None => artifacts.push(json!({
                    "kind": TURN_TIMINGS_ARTIFACT,
                    "commands": [],
                    "steps": steps.clone(),
                })),
            }
        }
        if let (true, Some(ended_by)) = (continuable, ended_by) {
            let note = note.clone().or_else(|| last_commands_note(artifacts));
            artifacts.push(json!({
                "kind": TURN_CONTINUATION_ARTIFACT,
                "requested": true,
                "endedBy": ended_by,
                "note": note,
            }));
        }
    };
    match result {
        Ok(mut execution) => {
            let ended_by = note.is_some().then_some("agent");
            add(&mut execution.artifacts, ended_by);
            Ok(execution)
        }
        Err(error) => {
            if crate::agent_executor::is_lease_lost(&error) {
                return Err(error);
            }
            let ended_by = if is_turn_time_limit(&error) {
                Some("time_limit")
            } else {
                None
            };
            if steps.is_empty() && ended_by.is_none() {
                return Err(error);
            }
            let mut artifacts = extract_job_failure_artifacts(&error)
                .unwrap_or_default()
                .to_vec();
            add(&mut artifacts, ended_by);
            let message = extract_job_failure_message(&error)
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string());
            Err(error.context(JobFailureWithArtifacts { message, artifacts }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker_payload(continuation: JsonValue) -> JsonValue {
        json!({"metadata": {"multiAgentPlan": {"role": "worker", "groupId": "g", "continuation": continuation}}})
    }

    #[test]
    fn only_a_team_job_with_continuations_left_can_be_continued() {
        assert!(job_turn_can_continue(&worker_payload(JsonValue::Null)));
        assert!(job_turn_can_continue(&worker_payload(
            json!({"turn": 1, "last": false})
        )));
        assert!(!job_turn_can_continue(&worker_payload(
            json!({"turn": 2, "last": true})
        )));
        assert!(
            !job_turn_can_continue(&json!({"metadata": {}})),
            "a person's own turn"
        );
    }

    #[test]
    fn the_wrap_up_comes_before_the_hard_limit_and_says_how_to_hand_off() {
        let wrap = turn_wrap_up(Duration::from_secs(600), true).expect("room for it");
        assert_eq!(wrap.after, Duration::from_secs(480));
        assert!(wrap.message.contains("$INSTAFY_TURN_CONTINUE_FILE"));
        assert!(wrap.message.contains("about 2 minutes"));
        let solo = turn_wrap_up(Duration::from_secs(600), false).expect("room for it");
        assert!(!solo.message.contains("INSTAFY_TURN_CONTINUE_FILE"));
        assert!(
            turn_wrap_up(Duration::from_secs(100), true).is_none(),
            "a turn shorter than the wrap-up"
        );
    }

    #[test]
    fn timings_pair_each_commands_start_and_end_and_keep_one_still_running() {
        let events = vec![
            json!({"type": "item.started", "atMs": 1000, "item": {"id": "a", "type": "command_execution", "command": "/bin/bash -lc fetch-sources --all --detach"}}),
            json!({"type": "item.completed", "atMs": 1500, "item": {"id": "a", "type": "command_execution", "command": "/bin/bash -lc fetch-sources --all --detach", "status": "completed", "exit_code": 0}}),
            json!({"type": "item.completed", "atMs": 2000, "item": {"id": "r", "type": "reasoning"}}),
            json!({"type": TURN_WRAP_UP_EVENT_TYPE, "atMs": 480000, "steered": true}),
            json!({"type": "item.started", "atMs": 470000, "item": {"id": "b", "type": "command_execution", "command": "wait-job sources-1"}}),
            json!({"type": "item.completed", "atMs": 590000, "item": {"id": "z", "type": "reasoning"}}),
        ];
        let artifact = turn_timings_artifact(&events).expect("timings");
        assert_eq!(artifact["kind"], TURN_TIMINGS_ARTIFACT);
        let commands = artifact["commands"].as_array().unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0]["command"], "fetch-sources --all --detach");
        assert_eq!(commands[0]["ms"], 500);
        assert_eq!(commands[0]["exitCode"], 0);
        assert_eq!(commands[1]["status"], "unfinished");
        assert_eq!(commands[1]["ms"], 120000);
        assert_eq!(artifact["wrapUp"]["steered"], true);
        assert!(
            turn_timings_artifact(&[
                json!({"type": "item.completed", "item": {"type": "reasoning"}})
            ])
            .is_none()
        );
    }

    fn execution(artifacts: Vec<JsonValue>) -> JobExecution {
        JobExecution {
            summary: "done".into(),
            suggested_replies: Vec::new(),
            provider: "codex-embedded".into(),
            artifacts,
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: Vec::new(),
        }
    }

    #[test]
    fn a_note_the_agent_left_asks_for_a_continuation_and_tool_steps_join_the_timings() {
        let dir = tempfile::tempdir().unwrap();
        let files = TurnFiles::in_dir(dir.path().join("job"), true);
        fs::write(
            &files.timings,
            "{\"tool\":\"uw\",\"step\":\"lodging Kyoto\",\"ms\":4100}\nnot json\n",
        )
        .unwrap();
        fs::write(
            files.continue_note.as_ref().unwrap(),
            "  wait for sources-1, then the summaries\n",
        )
        .unwrap();
        let timings = json!({"kind": TURN_TIMINGS_ARTIFACT, "commands": []});
        let done = attach_turn_records(Ok(execution(vec![timings])), &files).unwrap();
        let request = done
            .artifacts
            .iter()
            .find(|a| a["kind"] == TURN_CONTINUATION_ARTIFACT)
            .expect("requested");
        assert_eq!(request["endedBy"], "agent");
        assert_eq!(request["note"], "wait for sources-1, then the summaries");
        let timings = done
            .artifacts
            .iter()
            .find(|a| a["kind"] == TURN_TIMINGS_ARTIFACT)
            .unwrap();
        assert_eq!(timings["steps"][0]["step"], "lodging Kyoto");
        assert!(
            !dir.path().join("job").exists(),
            "the turn's files are removed"
        );
    }

    #[test]
    fn a_turn_finished_without_a_note_asks_for_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let files = TurnFiles::in_dir(dir.path().join("job"), true);
        let done = attach_turn_records(Ok(execution(Vec::new())), &files).unwrap();
        assert!(done.artifacts.is_empty());
    }

    #[test]
    fn a_turn_stopped_at_its_time_limit_keeps_its_run_log_and_asks_for_a_continuation() {
        let dir = tempfile::tempdir().unwrap();
        let files = TurnFiles::in_dir(dir.path().join("job"), true);
        let events = vec![
            json!({"type": "item.started", "atMs": 100, "item": {"id": "a", "type": "command_execution", "command": "summarize --timeout 240"}}),
        ];
        let error = anyhow!("Codex run timed out").context(JobFailureWithArtifacts {
            message: "Codex run timed out".into(),
            artifacts: failed_turn_artifacts(&events),
        });
        let error = attach_turn_records(Err(error), &files).unwrap_err();
        assert_eq!(error.to_string(), "Codex run timed out");
        let artifacts = extract_job_failure_artifacts(&error).unwrap();
        assert!(
            artifacts.iter().any(|a| a["kind"] == "codex/run-log"),
            "the run log is kept"
        );
        let request = artifacts
            .iter()
            .find(|a| a["kind"] == TURN_CONTINUATION_ARTIFACT)
            .expect("requested");
        assert_eq!(request["endedBy"], "time_limit");
        assert!(
            request["note"]
                .as_str()
                .unwrap()
                .contains("summarize --timeout 240 (still running)")
        );
        // a job that cannot be continued records the run log, but asks for nothing
        let solo = TurnFiles::in_dir(dir.path().join("solo"), false);
        let error = anyhow!("Codex run timed out").context(JobFailureWithArtifacts {
            message: "Codex run timed out".into(),
            artifacts: failed_turn_artifacts(&events),
        });
        let error = attach_turn_records(Err(error), &solo).unwrap_err();
        let artifacts = extract_job_failure_artifacts(&error).unwrap();
        assert!(artifacts.iter().any(|a| a["kind"] == "codex/run-log"));
        assert!(
            !artifacts
                .iter()
                .any(|a| a["kind"] == TURN_CONTINUATION_ARTIFACT)
        );
        // any other failure is not a time limit
        let other = attach_turn_records(
            Err(anyhow!("upstream 502")),
            &TurnFiles::in_dir(dir.path().join("x"), true),
        )
        .unwrap_err();
        assert!(extract_job_failure_artifacts(&other).is_none());
    }
}
