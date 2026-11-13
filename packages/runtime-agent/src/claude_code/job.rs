//! A local-engine turn's job (docs/Local-Engine-Turns.md 3.1 and 3.9): the checks that need only
//! the leased job and this process's grant, and the session a turn resumes (2.7).
//!
//! [`refuse_unless_runnable`] runs in the job loop before anything of a job with an engine runs:
//! no heartbeat, no secrets, no folder. [`LaneJob::of`] runs there and again when the turn starts.
//! The workspace token's verification, the folder pre-flight and the per-turn probe need more
//! than the job, so they run inside the turn (`jobs::claude_code_turn`). A refused job fails
//! without starting `claude`, and an unknown engine never falls back to the embedded one.

use serde_json::Value;
use uuid::Uuid;

use super::events::{LaneFailure, PROVIDER};
use super::{FailureCode, Lane, LaunchGrant, NotReadyReason};
use crate::controller::LeaseJob;

/// The `engine` of a local-engine turn's job (`agent_jobs.engine`, 2.1).
pub const ENGINE: &str = "claude-code";

/// The longest message a lane turn takes, in characters (Unicode scalar values): the limit the
/// controller's gate enforces (G5, `CLAUDE_CODE_LANE_MAX_PROMPT_CHARS`), checked here again.
pub const MAX_PROMPT_CHARS: usize = 100_000;

/// What the person reads for a job that is not one plain message of their own (5.5's sentences
/// for `claude_code_turn_not_person` and `claude_code_turn_not_plain`).
const NOT_THE_PERSONS: &str = "Claude Code takes only a message you send yourself.";
const NOT_PLAIN: &str = "Claude Code takes only a plain message to Octo, of at most 100,000 characters, without attachments or a command.";

/// The metadata keys that mark a job nobody typed, or one Instafy wrote, queued or resent (3.9,
/// "Markers"). Any value but null counts.
const MARKER_KEYS: [&str; 16] = [
    // An automation's run, a space review, a controller dispatch (`job_is_unattended`,
    // `job_is_an_automations_run`).
    "automation",
    "spaceReview",
    "controllerDispatch",
    // A team plan's turn, or a worker's answer.
    "multiAgentPlan",
    "multi_agent_plan",
    "workerInputRouting",
    // A browser turn's hand-back.
    "browserHandBack",
    "browser_hand_back",
    // A resend, a goal's continuation.
    "retryOfMessageId",
    "goalContinuation",
    "goal_continuation",
    // A browser turn.
    "browserTransport",
    "browser_transport",
    // Words the app runs in place of the shown ones.
    "dispatchContent",
    "dispatch_content",
    "plan_seed",
];

/// The keys of a message's files and images.
const ATTACHMENT_KEYS: [&str; 3] = ["attachments", "attachment_downloads", "attachmentDownloads"];

/// A failure with no code of 5.5's table: its own words, in Details.
fn uncoded(message: impl Into<String>) -> LaneFailure {
    LaneFailure {
        code: None,
        message: message.into(),
        resets_at: None,
    }
}

/// The failure of a turn whose lane is not ready, with the reason as its code.
pub fn not_ready_failure(reason: NotReadyReason) -> LaneFailure {
    let message = match reason {
        NotReadyReason::BinaryMissing => "Instafy Desktop can't find Claude Code on this computer.",
        NotReadyReason::BinaryUnsafe => {
            "Instafy Desktop won't start this copy of Claude Code: other accounts on this computer can change it, or a setting it was given failed its checks."
        }
        NotReadyReason::ProbeFailed => {
            "Claude Code didn't answer as expected when Instafy checked its version."
        }
        NotReadyReason::UnsupportedVersion => {
            "This version of Claude Code is older than the one Instafy needs."
        }
        NotReadyReason::BareDefault => {
            "This version of Claude Code no longer lets other apps use your sign-in for a turn."
        }
    };
    LaneFailure::new(FailureCode::from(reason), message)
}

/// The artifacts a lane failure sends: its `claude-code/failure` code, when it has one (2.6).
pub fn failure_artifacts(failure: &LaneFailure) -> Vec<Value> {
    failure.artifact().into_iter().collect()
}

/// Whether `job` is a local-engine turn of any engine: such a job never runs on the embedded
/// engine.
pub fn has_engine(job: &LeaseJob) -> bool {
    job.engine.is_some()
}

/// The failure of a job with an engine that this process cannot run (3.1, step 1), checked before
/// heartbeats or secrets: an unknown engine, no ready grant (`lane` says why), or a check of 3.9
/// that needs only the job and the grant. `None` for a job without an engine, and for one that
/// may go on to its turn.
pub fn refuse_unless_runnable(
    job: &LeaseJob,
    lane: Result<&Lane, NotReadyReason>,
) -> Option<LaneFailure> {
    let engine = job.engine.as_deref()?;
    if engine != ENGINE {
        return Some(unknown_engine(engine));
    }
    let lane = match lane {
        Ok(lane) => lane,
        Err(reason) => return Some(not_ready_failure(reason)),
    };
    LaneJob::of(job, lane.grant()).err()
}

fn unknown_engine(engine: &str) -> LaneFailure {
    let shown: String = engine.chars().take(40).collect();
    uncoded(format!(
        "This turn asked for an engine this computer doesn't have ({}), so nothing ran.",
        super::events::redact_tokens(&shown)
    ))
}

/// A leased job that may run as a local-engine turn of the grant's person: each check of 3.9 that
/// needs only the job and the captured grant passed.
#[derive(Clone, Copy, Debug)]
pub struct LaneJob<'a> {
    job: &'a LeaseJob,
    prompt: &'a str,
}

impl<'a> LaneJob<'a> {
    /// Checks `job` against 3.9 for `grant`'s person:
    /// - the job's shape: `engine` is `claude-code`, it is leased for the first time, it holds no
    ///   proxy envelope, controller token, device grant, grant token or credential, and it has a
    ///   workspace token (verified later, in the turn);
    /// - the person and the mode: `payload.user_id` is the person who consented on this computer,
    ///   the message is marked as one a person sent (`input.kind`), and the job applies its turn;
    /// - no marker of a job nobody typed, or one Instafy wrote, queued or resent;
    /// - the prompt: not empty, at most [`MAX_PROMPT_CHARS`], and no `/` command.
    pub fn of(job: &'a LeaseJob, grant: &LaunchGrant) -> Result<Self, LaneFailure> {
        match job.engine.as_deref() {
            Some(ENGINE) => {}
            Some(other) => return Err(unknown_engine(other)),
            None => return Err(uncoded("This turn isn't one Claude Code runs.")),
        }
        if job.lease_attempts != 1 {
            return Err(uncoded(
                "This Claude Code turn was already handed to a computer once, so it won't start again.",
            ));
        }
        let carries_access = job.proxy.is_some()
            || job.controller_token.is_some()
            || !job.grants.is_empty()
            || job.grant_token.is_some()
            || job.credential_id.is_some();
        if carries_access {
            return Err(uncoded(
                "This Claude Code turn came with access a Claude Code turn never gets, so it didn't start.",
            ));
        }
        if job
            .workspace_token
            .as_deref()
            .is_none_or(|token| token.trim().is_empty())
        {
            return Err(uncoded(
                "This Claude Code turn came without the token its saves need, so it didn't start.",
            ));
        }

        let payload = &job.payload;
        let sender = payload
            .get("user_id")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok());
        if sender != Some(grant.user_id()) {
            return Err(uncoded(
                "This Claude Code turn isn't from the Instafy account that set up Claude Code on this computer.",
            ));
        }
        let metadata = payload.get("metadata").and_then(Value::as_object);
        let input_kind = metadata
            .and_then(|metadata| metadata.get("input"))
            .and_then(|input| input.get("kind"))
            .and_then(Value::as_str);
        if input_kind != Some("person") {
            return Err(uncoded(NOT_THE_PERSONS));
        }
        if !applies_its_turn(payload) {
            return Err(uncoded(NOT_PLAIN));
        }

        let present = |key: &str| {
            metadata
                .and_then(|metadata| metadata.get(key))
                .is_some_and(|value| !value.is_null())
        };
        let top_level = |key: &str| payload.get(key).is_some_and(|value| !value.is_null());
        if MARKER_KEYS.iter().any(|key| present(key))
            || ["plan_seed", "planSeed", "browser_hand_back_reads_note"]
                .iter()
                .any(|key| top_level(key))
            || is_an_evaluation(payload)
            || crate::personal_browser::payload_requests_personal_browser(payload)
            || crate::shared_browser::payload_requests_shared_browser(payload)
        {
            return Err(uncoded(NOT_THE_PERSONS));
        }
        if metadata.is_some_and(|metadata| {
            ATTACHMENT_KEYS
                .iter()
                .any(|key| metadata.get(*key).is_some_and(carries_something))
        }) {
            return Err(uncoded(NOT_PLAIN));
        }

        let prompt = payload
            .get("prompt_text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if prompt.trim().is_empty()
            || prompt.chars().count() > MAX_PROMPT_CHARS
            || prompt.trim_start().starts_with('/')
        {
            return Err(uncoded(NOT_PLAIN));
        }
        Ok(Self { job, prompt })
    }

    pub fn job(&self) -> &'a LeaseJob {
        self.job
    }

    /// Exactly the person's recorded message, byte for byte (3.5): never trimmed.
    pub fn prompt(&self) -> &'a str {
        self.prompt
    }
}

/// The job applies its turn: its execution mode, where it says one, is `apply` (`execution_mode`
/// in the job loop reads `metadata.execution_mode`). The payload's top-level `executionMode` is
/// something else, the workspace mode the controller writes on every write job (`shared_write`),
/// so it is not read here.
fn applies_its_turn(payload: &Value) -> bool {
    let is_apply = |value: Option<&Value>| match value {
        None | Some(Value::Null) => true,
        Some(Value::String(mode)) => mode.trim().eq_ignore_ascii_case("apply"),
        Some(_) => false,
    };
    is_apply(payload.pointer("/metadata/execution_mode"))
        && is_apply(payload.pointer("/metadata/executionMode"))
}

/// The controller's mark of a group turn where Octo first decides whether to answer
/// (`groupParticipation.decision: "agent_evaluation"`).
fn is_an_evaluation(payload: &Value) -> bool {
    payload
        .pointer("/metadata/groupParticipation/decision")
        .and_then(Value::as_str)
        == Some("agent_evaluation")
}

/// A list with an entry, or any other value but null.
fn carries_something(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        _ => true,
    }
}

/// The session a lane turn passes to `--resume` (2.7): only one from the lane's own conversation
/// state that this runtime's own registration started, with a session id in UUID form. Anything
/// else, the reset state included, starts a new session.
pub fn resume_session(state: Option<&Value>, runtime_id: Uuid) -> Option<Uuid> {
    let state = state?.as_object()?;
    if state.get("provider").and_then(Value::as_str) != Some(PROVIDER)
        || state.get("version").and_then(Value::as_u64) != Some(1)
        || state.get("reset").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let started_here = state
        .get("runtimeId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        == Some(runtime_id);
    if !started_here {
        return None;
    }
    let session = state.get("sessionId").and_then(Value::as_str)?;
    (session.len() == 36)
        .then(|| Uuid::parse_str(session).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_code::{Confinement, LaunchEnvSnapshot, RawLaunchGrant, Trust};
    use serde_json::json;
    use std::path::PathBuf;

    fn grant(user_id: Uuid) -> LaunchGrant {
        LaunchGrant::parse(
            RawLaunchGrant {
                bin: Some("/usr/local/bin/claude".into()),
                path: None,
                user_id: Some(user_id.to_string().into()),
                env_json: None,
            },
            LaunchEnvSnapshot::default(),
            Confinement::new([PathBuf::from("/workspace")]),
            Trust {
                euid: 501,
                admin_gid: None,
            },
        )
        .unwrap()
        .unwrap()
    }

    /// A lane job as the controller leases it: the payload keys and metadata of a real lane send
    /// (recorded from a controller and runtime driven end to end), the ids aside.
    fn lane_job(user_id: Uuid) -> LeaseJob {
        let conversation_id = Uuid::new_v4();
        serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "intent": "feature",
            "project_id": Uuid::new_v4(),
            "run_id": Uuid::new_v4(),
            "conversation_id": conversation_id,
            "engine": "claude-code",
            "lease_attempts": 1,
            "workspace_token": "workspace-token",
            "payload": {
                "intent": "feature",
                "version": "1.0",
                "user_id": user_id.to_string(),
                "prompt_text": "  Rename the project in README.md\n",
                "writeIntent": true,
                // The workspace mode, not the execution mode.
                "executionMode": "shared_write",
                "targetThreadId": conversation_id,
                "conversation_id": conversation_id,
                "metadata": {
                    "agent": {
                        "handle": "octo",
                        "displayName": "Octo",
                        "writeScope": { "mode": "unscoped", "ownedPaths": [], "readOnlyPaths": [] },
                    },
                    "writeScope": { "mode": "unscoped", "ownedPaths": [], "readOnlyPaths": [] },
                    "claudeCode": { "version": 1 },
                    "aiAccessMode": "claude-code",
                    "managedAiUsed": false,
                    "input": { "kind": "person" },
                    "writeIntent": true,
                    "runtimePreference": { "source": "conversation" },
                    "conversationVisibility": "public",
                },
            },
        }))
        .unwrap()
    }

    fn refusal(job: &LeaseJob, grant: &LaunchGrant) -> LaneFailure {
        LaneJob::of(job, grant).expect_err("refused")
    }

    #[test]
    fn a_plain_message_of_the_grants_person_runs_with_its_exact_words() {
        let person = Uuid::new_v4();
        let job = lane_job(person);
        let lane_job = LaneJob::of(&job, &grant(person)).expect("runnable");
        assert_eq!(lane_job.prompt(), "  Rename the project in README.md\n");
        assert_eq!(lane_job.job().id, job.id);
    }

    #[test]
    fn the_job_shape_person_mode_markers_and_prompt_are_checked() {
        let person = Uuid::new_v4();
        let grant = grant(person);
        let job_with = |change: &dyn Fn(&mut LeaseJob)| {
            let mut job = lane_job(person);
            change(&mut job);
            job
        };
        let mut cases: Vec<(String, LeaseJob)> = vec![
            (
                "another engine".into(),
                job_with(&|job| job.engine = Some("other".into())),
            ),
            ("no engine".into(), job_with(&|job| job.engine = None)),
            (
                "a second lease".into(),
                job_with(&|job| job.lease_attempts = 2),
            ),
            (
                "a proxy envelope".into(),
                job_with(&|job| {
                    job.proxy = Some(
                        serde_json::from_value(json!({
                            "url": "http://proxy.invalid", "token": "proxy-token",
                        }))
                        .unwrap(),
                    )
                }),
            ),
            (
                "a controller token".into(),
                job_with(&|job| job.controller_token = Some("controller-token".into())),
            ),
            (
                "a device grant".into(),
                job_with(&|job| job.grants = vec![crate::provider_mcp::tests::leased_grant()]),
            ),
            (
                "a grant token".into(),
                job_with(&|job| {
                    job.grant_token = Some(crate::controller::GrantToken("grant".into()))
                }),
            ),
            (
                "a credential".into(),
                job_with(&|job| job.credential_id = Some(Uuid::new_v4())),
            ),
            (
                "no workspace token".into(),
                job_with(&|job| job.workspace_token = None),
            ),
            (
                "an empty workspace token".into(),
                job_with(&|job| job.workspace_token = Some(" ".into())),
            ),
            (
                "another person".into(),
                job_with(&|job| job.payload["user_id"] = json!(Uuid::new_v4().to_string())),
            ),
            (
                "no person".into(),
                job_with(&|job| {
                    job.payload.as_object_mut().unwrap().remove("user_id");
                }),
            ),
            (
                "no input".into(),
                job_with(&|job| {
                    job.payload["metadata"]
                        .as_object_mut()
                        .unwrap()
                        .remove("input");
                }),
            ),
            (
                "a device's input".into(),
                job_with(&|job| job.payload["metadata"]["input"] = json!({ "kind": "device" })),
            ),
            (
                "plan only".into(),
                job_with(&|job| job.payload["metadata"]["execution_mode"] = json!("plan_only")),
            ),
            (
                "approval required".into(),
                job_with(&|job| {
                    job.payload["metadata"]["executionMode"] = json!("approval_required")
                }),
            ),
            (
                "a plan seed".into(),
                job_with(&|job| job.payload["plan_seed"] = json!({ "steps": [] })),
            ),
            (
                "a hand-back's reading note".into(),
                job_with(&|job| job.payload["browser_hand_back_reads_note"] = json!(true)),
            ),
            (
                "an evaluation".into(),
                job_with(&|job| {
                    job.payload["metadata"]["groupParticipation"] =
                        json!({ "decision": "agent_evaluation", "reason": "skill_mode_ambient" })
                }),
            ),
            (
                "a Personal Browser turn".into(),
                job_with(&|job| {
                    job.payload["metadata"]["browserTransport"] = json!("desktop_personal")
                }),
            ),
            (
                "attachments".into(),
                job_with(&|job| {
                    job.payload["metadata"]["attachments"] = json!([{ "name": "photo.png" }])
                }),
            ),
            (
                "attachment downloads".into(),
                job_with(&|job| {
                    job.payload["metadata"]["attachmentDownloads"] = json!([{ "url": "x" }])
                }),
            ),
            (
                "an empty prompt".into(),
                job_with(&|job| job.payload["prompt_text"] = json!(" \n ")),
            ),
            (
                "no prompt".into(),
                job_with(&|job| {
                    job.payload.as_object_mut().unwrap().remove("prompt_text");
                }),
            ),
            (
                "a long prompt".into(),
                job_with(&|job| {
                    job.payload["prompt_text"] = json!("é".repeat(MAX_PROMPT_CHARS + 1))
                }),
            ),
            (
                "a command".into(),
                job_with(&|job| job.payload["prompt_text"] = json!("  /terminal ls")),
            ),
        ];
        for key in MARKER_KEYS {
            cases.push((
                format!("the marker {key}"),
                job_with(&|job| job.payload["metadata"][key] = json!({ "any": "value" })),
            ));
        }
        for (name, job) in &cases {
            let failure = refusal(job, &grant);
            assert_eq!(failure.code, None, "{name}: {failure:?}");
            assert!(failure.artifact().is_none(), "{name}");
            assert!(!failure.message.is_empty(), "{name}");
        }

        // The limit is in characters, and the words are kept as they are.
        let mut longest = lane_job(person);
        longest.payload["prompt_text"] = json!("é".repeat(MAX_PROMPT_CHARS));
        assert!(LaneJob::of(&longest, &grant).is_ok());
        // Null markers and empty lists are no markers.
        let mut nulls = lane_job(person);
        nulls.payload["metadata"]["automation"] = Value::Null;
        nulls.payload["metadata"]["attachments"] = json!([]);
        nulls.payload["metadata"]["groupParticipation"] = json!({ "decision": "respond" });
        assert!(LaneJob::of(&nulls, &grant).is_ok());
    }

    #[test]
    fn the_job_loop_refuses_an_unknown_engine_or_a_lane_that_is_not_ready() {
        let person = Uuid::new_v4();
        let lane = Lane::new(grant(person));
        let mut plain = lane_job(person);
        plain.engine = None;
        assert!(refuse_unless_runnable(&plain, Ok(&lane)).is_none());
        assert!(refuse_unless_runnable(&lane_job(person), Ok(&lane)).is_none());

        let mut unknown = lane_job(person);
        unknown.engine = Some("other-engine".into());
        let failure = refuse_unless_runnable(&unknown, Ok(&lane)).expect("refused");
        assert_eq!(failure.code, None);
        assert!(failure.message.contains("other-engine"), "{failure:?}");

        for reason in [
            NotReadyReason::BinaryMissing,
            NotReadyReason::BinaryUnsafe,
            NotReadyReason::ProbeFailed,
            NotReadyReason::UnsupportedVersion,
            NotReadyReason::BareDefault,
        ] {
            let failure = refuse_unless_runnable(&lane_job(person), Err(reason)).expect("refused");
            assert_eq!(failure.code, Some(FailureCode::from(reason)));
            assert_eq!(
                failure_artifacts(&failure),
                [json!({ "kind": "claude-code/failure", "code": reason.as_str() })]
            );
        }

        let mut someone_else = lane_job(person);
        someone_else.payload["user_id"] = json!(Uuid::new_v4().to_string());
        assert!(refuse_unless_runnable(&someone_else, Ok(&lane)).is_some());
    }

    #[test]
    fn only_a_session_this_runtime_started_is_resumed() {
        let runtime = Uuid::new_v4();
        let session = Uuid::new_v4();
        let state = |session: &str, runtime: Uuid| {
            json!({
                "provider": "claude-code",
                "version": 1,
                "sessionId": session,
                "runtimeId": runtime.to_string(),
            })
        };
        assert_eq!(
            resume_session(Some(&state(&session.to_string(), runtime)), runtime),
            Some(session)
        );
        // Another registration's session, a session id that is no UUID, the reset state, a Codex
        // state, and none at all start a new session.
        assert_eq!(
            resume_session(Some(&state(&session.to_string(), Uuid::new_v4())), runtime),
            None
        );
        let simple = session.simple().to_string();
        for bad in ["", "not-a-uuid", "--fork-session", simple.as_str()] {
            assert_eq!(resume_session(Some(&state(bad, runtime)), runtime), None);
        }
        let reset = json!({ "provider": "claude-code", "version": 1, "reset": true });
        assert_eq!(resume_session(Some(&reset), runtime), None);
        let mut codex = state(&session.to_string(), runtime);
        codex["provider"] = json!("codex-embedded");
        assert_eq!(resume_session(Some(&codex), runtime), None);
        let mut newer = state(&session.to_string(), runtime);
        newer["version"] = json!(2);
        assert_eq!(resume_session(Some(&newer), runtime), None);
        assert_eq!(resume_session(None, runtime), None);
    }
}
