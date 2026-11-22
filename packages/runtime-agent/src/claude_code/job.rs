//! A local-engine turn's job (docs/Local-Engine-Turns.md 3.1, 3.9, 11.12 and 11.19): the checks
//! that need only the leased job and this process's grant, the login of the grant the turn runs
//! on, the turn's execution mode, and the session a turn resumes (2.7, 11.9).
//!
//! [`refuse_unless_runnable`] runs in the job loop before anything of a job with an engine runs:
//! no heartbeat, no secrets, no folder. [`LaneJob::of`] runs there and again when the turn starts.
//! The workspace token's verification, the folder pre-flight and the per-turn probe need more
//! than the job, so they run inside the turn (`jobs::claude_code_turn`). A refused job fails
//! without starting `claude`, and an unknown engine never falls back to the embedded one.
//!
//! Version 2 runs every turn of an agent whose AI is Claude Code, whatever started it: a message,
//! a queued or resent one, an automation's run, a goal's wake-up, an evaluation (11.4). So the
//! job carries no mark of who started it that the runtime reads. What Claude Code cannot take is
//! still refused here, as a backstop for dispatch's refusals: a browser turn, a team plan's turn,
//! attachments, a command, an empty or too long prompt, a mode other than `apply` and
//! `plan_only`, and a write scope other than `unscoped` and `read_only`. A turn whose mode is
//! `plan_only`, or whose write scope is `read_only`, runs read-only, in Claude Code's plan mode.

use serde_json::Value;
use uuid::Uuid;

use super::events::{LaneFailure, PROVIDER};
use super::{ExecutionMode, FailureCode, Lane, LaunchGrant, NotReadyReason, PlanLimitHold};
use crate::controller::LeaseJob;

/// The `engine` of a local-engine turn's job (`agent_jobs.engine`, 2.1).
pub const ENGINE: &str = "claude-code";

/// The longest message a lane turn takes, in characters (Unicode scalar values): the limit the
/// controller's gate enforces (`CLAUDE_CODE_LANE_MAX_PROMPT_CHARS`), checked here again.
pub const MAX_PROMPT_CHARS: usize = 100_000;

/// The metadata keys that mark a team plan's turn: a lead's or a worker's (`multiAgentPlan` and
/// its role), a worker's answer, and a plan's seed (11.4's `team_plan`). Any value but null
/// counts. A worker must keep to its write scope and report through Instafy's tools, and Instafy
/// can hold Claude Code to neither (D40).
const TEAM_PLAN_KEYS: [&str; 4] = [
    "multiAgentPlan",
    "multi_agent_plan",
    "workerInputRouting",
    "plan_seed",
];
/// The same, at the payload's top level.
const TOP_LEVEL_TEAM_PLAN_KEYS: [&str; 2] = ["plan_seed", "planSeed"];

/// The metadata keys that mark a turn that needs Instafy's browser (11.4's `browser`): its
/// transport, a Shared Browser page it targets, and a browser turn's hand-back, which carries a
/// browser turn on. Any value but null counts.
const BROWSER_KEYS: [&str; 6] = [
    "browserTransport",
    "browser_transport",
    "browserPageId",
    "browser_page_id",
    "browserHandBack",
    "browser_hand_back",
];
/// The same, at the payload's top level: a hand-back's reading note.
const TOP_LEVEL_BROWSER_KEYS: [&str; 1] = ["browser_hand_back_reads_note"];

/// The keys of a message's files and images.
const ATTACHMENT_KEYS: [&str; 3] = ["attachments", "attachment_downloads", "attachmentDownloads"];

/// Every place a job's write scope can be, as the job loop's readers look for it
/// (`jobs::write_scope_value_from_metadata` and the job loop's own claim reader): the metadata's
/// own, its agent's and its collaboration's, each in either spelling.
const WRITE_SCOPE_PLACES: [&str; 8] = [
    "/metadata/writeScope",
    "/metadata/write_scope",
    "/metadata/agent/writeScope",
    "/metadata/agent/write_scope",
    "/metadata/agentCollaboration/writeScope",
    "/metadata/agentCollaboration/write_scope",
    "/metadata/agent_collaboration/writeScope",
    "/metadata/agent_collaboration/write_scope",
];

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
        NotReadyReason::PlanLimit => {
            "Your Claude plan's usage limit was reached, so this turn didn't start."
        }
    };
    LaneFailure::new(FailureCode::from(reason), message)
}

/// The failure of a turn that a plan limit's hold kept from starting (11.11): `plan_limit`, with
/// the reset time, in words as Claude Code's own plan limits are worded (2.6).
pub fn plan_limit_hold_failure(hold: &PlanLimitHold) -> LaneFailure {
    LaneFailure {
        code: Some(FailureCode::PlanLimit),
        message: format!(
            "Claude Code reached your Claude plan's usage limit in an earlier turn, so this turn didn't start.\nThe limit resets at {}.",
            hold.resets_at().format("%Y-%m-%d %H:%M UTC")
        ),
        resets_at: Some(hold.resets_at().timestamp()),
    }
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
    mode: ExecutionMode,
    login: Uuid,
}

impl<'a> LaneJob<'a> {
    /// Checks `job` against 3.9, 11.12 and 11.19 for `grant`'s person:
    /// - the job's shape: `engine` is `claude-code`, it is leased for the first time, it holds no
    ///   proxy envelope, controller token, device grant, grant token or credential, and it has a
    ///   workspace token (verified later, in the turn);
    /// - the person: `payload.user_id` is the person who consented on this computer, the owner
    ///   of the agent whose turn it is (11.5);
    /// - the login: the job's `claude_code_login_id`, the login its lease took, is one of the
    ///   grant's, so the turn runs with a folder the person consented to here (11.19); no lease
    ///   hands out any other, so a job without one is refused with no code;
    /// - the mode: `metadata.execution_mode` is absent, `apply` or `plan_only`, and the write
    ///   scope is absent, `unscoped` or `read_only`; a `plan_only` or `read_only` turn runs
    ///   read-only ([`ExecutionMode::PlanOnly`]);
    /// - what Claude Code cannot take (11.4): no browser turn, no team plan's turn, no
    ///   attachments;
    /// - the prompt: not empty, at most [`MAX_PROMPT_CHARS`], and no `/` command.
    ///
    /// Whatever started the turn passes: a person, a queue, a resend, an automation, a goal's
    /// wake-up or an evaluation, whose words dispatch already put in `prompt_text` (11.10).
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
        let login = job
            .claude_code_login_id
            .filter(|login| grant.login(*login).is_some())
            .ok_or_else(|| {
                uncoded(
                    "This Claude Code turn isn't for a Claude Code login set up on this computer, so it didn't start.",
                )
            })?;
        let mode = execution_mode(payload)?;
        let mode = if reads_only(payload)? {
            ExecutionMode::PlanOnly
        } else {
            mode
        };

        let metadata = payload.get("metadata").and_then(Value::as_object);
        let in_metadata = |keys: &[&str]| {
            metadata.is_some_and(|metadata| {
                keys.iter()
                    .any(|key| metadata.get(*key).is_some_and(|value| !value.is_null()))
            })
        };
        let at_top_level = |keys: &[&str]| {
            keys.iter()
                .any(|key| payload.get(*key).is_some_and(|value| !value.is_null()))
        };
        if in_metadata(&BROWSER_KEYS) || at_top_level(&TOP_LEVEL_BROWSER_KEYS) {
            return Err(uncoded(
                "Claude Code doesn't take turns that need Instafy's browser, so this turn didn't start.",
            ));
        }
        if in_metadata(&TEAM_PLAN_KEYS) || at_top_level(&TOP_LEVEL_TEAM_PLAN_KEYS) {
            return Err(uncoded(
                "Claude Code doesn't take the turns of a team plan, so this turn didn't start.",
            ));
        }
        if metadata.is_some_and(|metadata| {
            ATTACHMENT_KEYS
                .iter()
                .any(|key| metadata.get(*key).is_some_and(carries_something))
        }) {
            return Err(uncoded(
                "Claude Code doesn't take messages with attachments, so this turn didn't start.",
            ));
        }

        let prompt = payload
            .get("prompt_text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if prompt.trim().is_empty() {
            return Err(uncoded(
                "This turn has no words for Claude Code, so it didn't start.",
            ));
        }
        if prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(uncoded(
                "This turn has more than 100,000 characters, more than Claude Code takes from Instafy, so it didn't start.",
            ));
        }
        if prompt.trim_start().starts_with('/') {
            return Err(uncoded(
                "This turn starts with /, which Claude Code would read as a command of its own, so it didn't start.",
            ));
        }
        Ok(Self {
            job,
            prompt,
            mode,
            login,
        })
    }

    pub fn job(&self) -> &'a LeaseJob {
        self.job
    }

    /// The grant's login the turn runs on, the one its lease took (11.19).
    pub fn login(&self) -> Uuid {
        self.login
    }

    /// Exactly the words dispatch recorded for the turn, byte for byte (3.5, 11.10): never
    /// trimmed.
    pub fn prompt(&self) -> &'a str {
        self.prompt
    }

    /// Whether the turn applies its changes or only plans them (11.12): it plans them when its
    /// mode is `plan_only` or its write scope is `read_only`.
    pub fn mode(&self) -> ExecutionMode {
        self.mode
    }
}

/// The turn's execution mode (11.12): `metadata.execution_mode`, as the job loop reads it for any
/// job, when it is `apply` or `plan_only`; `apply` when it is absent. Any other mode, such as
/// `approval_required`, which no runtime implements for the lane, refuses the turn. The payload's
/// top-level `executionMode` is something else, the workspace mode the controller writes on every
/// job (`shared_write`, or `shared_read` for a `plan_only` turn), so it is not read here.
fn execution_mode(payload: &Value) -> Result<ExecutionMode, LaneFailure> {
    match payload.pointer("/metadata/execution_mode") {
        None | Some(Value::Null) => Ok(ExecutionMode::Apply),
        Some(Value::String(mode)) => ExecutionMode::parse(mode).ok_or_else(|| {
            let shown: String = mode.trim().chars().take(40).collect();
            uncoded(format!(
                "Claude Code runs a turn only to apply its changes or to plan them, and this turn asked for {}, so it didn't start.",
                super::events::redact_tokens(&shown)
            ))
        }),
        Some(_) => Err(uncoded(
            "Claude Code runs a turn only to apply its changes or to plan them, so this turn didn't start.",
        )),
    }
}

/// Whether the turn's write scope keeps it from changing the space's files (11.12): the
/// controller writes `read_only` for each target of a multi-agent send without write intent, and
/// such a turn runs in Claude Code's plan mode. Every place the job loop reads a scope from is
/// read, each as the job loop reads its mode (`jobs::write_scope_mode_from_value`), and the
/// strictest decides: none, or only `unscoped`, applies the turn's changes; a `read_only` one
/// (`readonly` too) makes it read-only; any other scope, such as `owned`, `write`,
/// `write_scoped` or `coordination_required`, or one whose mode cannot be read, refuses the
/// turn, since nothing can hold Claude Code to part of the space's files.
fn reads_only(payload: &Value) -> Result<bool, LaneFailure> {
    let mut read_only = false;
    for scope in WRITE_SCOPE_PLACES
        .iter()
        .filter_map(|place| payload.pointer(place))
        .filter(|scope| !scope.is_null())
    {
        match crate::jobs::write_scope_mode_from_value(scope).as_deref() {
            Some("unscoped") => {}
            Some("read_only" | "readonly") => read_only = true,
            _ => {
                return Err(uncoded(
                    "Claude Code can't be held to part of the space's files, so this turn didn't start.",
                ));
            }
        }
    }
    Ok(read_only)
}

/// A list with an entry, or any other value but null.
fn carries_something(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        _ => true,
    }
}

/// The session a lane turn passes to `--resume` (2.7, 11.9): the one in the lane's own
/// conversation state, with a session id in UUID form, whichever computer saved it. When this
/// computer does not have it, the turn starts again in a new session (`supervise`). Anything
/// else, the reset state included, starts a new session. The state's `runtimeId` says which
/// registration saved it, for Details, and is not read here.
pub fn resume_session(state: Option<&Value>) -> Option<Uuid> {
    let state = state?.as_object()?;
    if state.get("provider").and_then(Value::as_str) != Some(PROVIDER)
        || state.get("version").and_then(Value::as_u64) != Some(1)
        || state.get("reset").and_then(Value::as_bool) == Some(true)
    {
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

    /// The login a lane job's lease took: Claude Code's usual folder on this computer.
    const LOGIN: &str = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";
    /// The person's other login here, a folder of its own.
    const OTHER_LOGIN: &str = "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02";

    fn grant(user_id: Uuid) -> LaunchGrant {
        LaunchGrant::parse(
            RawLaunchGrant {
                bin: Some("/usr/local/bin/claude".into()),
                path: None,
                user_id: Some(user_id.to_string().into()),
                env_json: None,
                logins_json: Some(
                    json!([
                        { "id": LOGIN, "configDir": null },
                        { "id": OTHER_LOGIN, "configDir": "/home/person/.claude-work" },
                    ])
                    .to_string()
                    .into(),
                ),
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

    /// A lane job as the controller leases it, on [`LOGIN`]. Its payload is runtime-contracts'
    /// recorded lane job payload (claude_code_lane_fixtures.json), which the controller's own test
    /// builds the way dispatch does, with this job's ids in place of its placeholders and
    /// `user_id` as its sender. Its top-level `executionMode` is the workspace mode the controller
    /// writes on every write job (`shared_write`), not an execution mode.
    fn lane_job(user_id: Uuid) -> LeaseJob {
        /// `value` with each placeholder of `ids` replaced by its id.
        fn with_ids(value: &mut Value, ids: &[(&str, Uuid)]) {
            match value {
                Value::String(text) => {
                    if let Some((_, id)) = ids
                        .iter()
                        .find(|(placeholder, _)| text.as_str() == *placeholder)
                    {
                        *text = id.to_string();
                    }
                }
                Value::Array(items) => items.iter_mut().for_each(|item| with_ids(item, ids)),
                Value::Object(map) => map.values_mut().for_each(|item| with_ids(item, ids)),
                _ => {}
            }
        }

        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../runtime-contracts/src/claude_code_lane_fixtures.json"
        ))
        .expect("the lane fixtures are JSON");
        let (project_id, run_id, conversation_id) =
            (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut payload = fixtures["laneJobPayload"].clone();
        with_ids(
            &mut payload,
            &[
                ("<project_id>", project_id),
                ("<user_id>", user_id),
                ("<conversation_id>", conversation_id),
                ("<prompt_id>", Uuid::new_v4()),
                ("<run_id>", run_id),
                ("<agent_id>", Uuid::new_v4()),
                ("<runtime_id>", Uuid::new_v4()),
            ],
        );
        assert!(
            !payload.to_string().contains("\"<"),
            "a placeholder is left: {payload}"
        );
        serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "intent": "feature",
            "project_id": project_id,
            "run_id": run_id,
            "conversation_id": conversation_id,
            "engine": "claude-code",
            "claude_code_login_id": LOGIN,
            "lease_attempts": 1,
            "workspace_token": "workspace-token",
            "payload": payload,
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
        // The controller trims a send's ends; whatever words it records run as they are.
        let mut spaced = lane_job(person);
        spaced.payload["prompt_text"] = json!("  Rename the project in README.md\n");
        let lane_job = LaneJob::of(&job, &grant(person)).expect("runnable");
        assert_eq!(Some(lane_job.prompt()), job.payload["prompt_text"].as_str());
        assert_eq!(lane_job.job().id, job.id);
        assert_eq!(lane_job.mode(), ExecutionMode::Apply);
        assert_eq!(lane_job.login(), Uuid::parse_str(LOGIN).unwrap());
        let spaced = LaneJob::of(&spaced, &grant(person)).expect("runnable");
        assert_eq!(spaced.prompt(), "  Rename the project in README.md\n");
    }

    /// A turn runs on the login its lease took, when it is one of this computer's grant (11.19):
    /// any of them, the first or not. One that names no login, or a login not set up here, is
    /// refused with no code, before anything of it runs.
    #[test]
    fn a_turn_runs_on_the_login_its_lease_took_when_the_grant_has_it() {
        let person = Uuid::new_v4();
        let grant = grant(person);
        let mut other = lane_job(person);
        other.claude_code_login_id = Some(Uuid::parse_str(OTHER_LOGIN).unwrap());
        assert_eq!(
            LaneJob::of(&other, &grant).map(|lane_job| lane_job.login()),
            Ok(Uuid::parse_str(OTHER_LOGIN).unwrap())
        );
        let lane = Lane::new(grant.clone());
        for login in [None, Some(Uuid::new_v4())] {
            let mut job = lane_job(person);
            job.claude_code_login_id = login;
            let failure = refusal(&job, &grant);
            assert_eq!(failure.code, None, "{login:?}");
            assert_eq!(
                failure.message,
                "This Claude Code turn isn't for a Claude Code login set up on this computer, so it didn't start.",
            );
            assert!(refuse_unless_runnable(&job, Ok(&lane)).is_some());
        }
        // The lease names it as the controller writes it.
        let job: LeaseJob = serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "engine": "claude-code",
            "claude_code_login_id": OTHER_LOGIN,
        }))
        .unwrap();
        assert_eq!(
            job.claude_code_login_id,
            Some(Uuid::parse_str(OTHER_LOGIN).unwrap())
        );
        let job: LeaseJob = serde_json::from_value(json!({ "id": Uuid::new_v4() })).unwrap();
        assert_eq!(job.claude_code_login_id, None);
    }

    /// Every turn of a Claude Code agent runs, whatever started it (11.4, 11.12): what marked a
    /// turn nobody typed in version 1 refuses nothing now. An evaluation's instruction is already
    /// in front of its words in `prompt_text`, and runs as it is.
    #[test]
    fn an_agents_turn_runs_whatever_started_it() {
        let person = Uuid::new_v4();
        let grant = grant(person);
        let evaluation_words = "You are in a group chat. Reply only when you can help; otherwise reply NO_RESPONSE.\n\nSam: does the build pass?";
        let runs = |name: &str, change: &dyn Fn(&mut LeaseJob)| {
            let mut job = lane_job(person);
            change(&mut job);
            let lane_job =
                LaneJob::of(&job, &grant).unwrap_or_else(|failure| panic!("{name}: {failure:?}"));
            assert_eq!(lane_job.mode(), ExecutionMode::Apply, "{name}");
            assert_eq!(Some(lane_job.prompt()), job.payload["prompt_text"].as_str());
        };
        runs("no input kind", &|job| {
            job.payload["metadata"]
                .as_object_mut()
                .unwrap()
                .remove("input");
        });
        runs("a device's input", &|job| {
            job.payload["metadata"]["input"] = json!({ "kind": "device" })
        });
        runs("an automation's run", &|job| {
            job.payload["metadata"]["automation"] = json!({ "id": "nightly", "mode": "agent" })
        });
        runs("a space review", &|job| {
            job.payload["metadata"]["spaceReview"] = json!({ "automationId": "review" });
            job.payload["metadata"]["controllerDispatch"] = json!({ "suppressUserMessage": true });
        });
        runs("a goal's wake-up", &|job| {
            job.payload["metadata"]["goalContinuation"] = json!({ "goalId": "g" });
            job.payload["metadata"]["goal_continuation"] = json!(true);
        });
        runs("a resend", &|job| {
            job.payload["metadata"]["retryOfMessageId"] = json!(Uuid::new_v4().to_string())
        });
        runs("words the app runs in place of the shown ones", &|job| {
            job.payload["metadata"]["dispatchContent"] = json!("the words");
            job.payload["metadata"]["dispatch_content"] = json!("the words");
        });
        runs("an evaluation", &|job| {
            job.payload["metadata"]["groupParticipation"] =
                json!({ "decision": "agent_evaluation", "reason": "skill_mode_ambient" });
            job.payload["prompt_text"] = json!(evaluation_words);
        });
        runs("a queued message", &|job| {
            job.payload["metadata"]["dispatch_queue_entry_id"] = json!(Uuid::new_v4().to_string())
        });
    }

    /// The mode is `metadata.execution_mode`: `apply` or absent applies the turn's changes,
    /// `plan_only` only plans them, and any other mode refuses the turn (11.12). The payload's
    /// top-level `executionMode`, the workspace mode, is not read.
    #[test]
    fn the_mode_is_apply_or_plan_only_and_nothing_else() {
        let person = Uuid::new_v4();
        let grant = grant(person);
        let mode_of = |mode: Value, workspace: &str| {
            let mut job = lane_job(person);
            job.payload["metadata"]["execution_mode"] = mode;
            job.payload["executionMode"] = json!(workspace);
            LaneJob::of(&job, &grant).map(|lane_job| lane_job.mode())
        };
        assert_eq!(
            mode_of(Value::Null, "shared_write"),
            Ok(ExecutionMode::Apply)
        );
        assert_eq!(
            mode_of(json!("apply"), "shared_write"),
            Ok(ExecutionMode::Apply)
        );
        assert_eq!(
            mode_of(json!(" APPLY "), "shared_write"),
            Ok(ExecutionMode::Apply)
        );
        assert_eq!(
            mode_of(json!("plan_only"), "shared_read"),
            Ok(ExecutionMode::PlanOnly)
        );
        assert_eq!(
            mode_of(json!("Plan_Only"), "shared_read"),
            Ok(ExecutionMode::PlanOnly)
        );
        let mut absent = lane_job(person);
        absent.payload["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("execution_mode");
        assert_eq!(
            LaneJob::of(&absent, &grant).map(|lane_job| lane_job.mode()),
            Ok(ExecutionMode::Apply)
        );
        for other in [
            json!("approval_required"),
            json!("plan"),
            json!(""),
            json!("shared_read"),
            json!(true),
            json!({ "mode": "apply" }),
        ] {
            let failure = mode_of(other.clone(), "shared_write").expect_err("refused");
            assert_eq!(failure.code, None, "{other}");
            assert!(failure.message.contains("apply"), "{other}: {failure:?}");
        }
    }

    /// The write scope (11.12): none, or `unscoped`, applies the turn's changes; `read_only`,
    /// wherever the job loop reads a scope from and however it is spelled, runs the turn
    /// read-only, as `plan_only` does; any other scope refuses it before anything runs.
    #[test]
    fn a_read_only_write_scope_plans_and_any_other_scope_but_unscoped_is_refused() {
        let person = Uuid::new_v4();
        let grant = grant(person);
        let mode_with = |change: &dyn Fn(&mut Value)| {
            let mut job = lane_job(person);
            change(&mut job.payload["metadata"]);
            LaneJob::of(&job, &grant).map(|lane_job| lane_job.mode())
        };
        let without_scopes = |metadata: &mut Value| {
            metadata.as_object_mut().unwrap().remove("writeScope");
            metadata["agent"]
                .as_object_mut()
                .unwrap()
                .remove("writeScope");
        };
        // The recorded payload's scope is `unscoped`, in two places.
        assert_eq!(mode_with(&|_| {}), Ok(ExecutionMode::Apply));
        assert_eq!(mode_with(&without_scopes), Ok(ExecutionMode::Apply));
        assert_eq!(
            mode_with(&|metadata| metadata["writeScope"] = json!("unscoped")),
            Ok(ExecutionMode::Apply)
        );
        assert_eq!(
            mode_with(&|metadata| metadata["writeScope"] = Value::Null),
            Ok(ExecutionMode::Apply)
        );
        for place in [
            "writeScope",
            "write_scope",
            "agent.writeScope",
            "agent.write_scope",
            "agentCollaboration.writeScope",
            "agent_collaboration.write_scope",
        ] {
            for spelling in [
                json!({ "mode": "read_only", "ownedPaths": [] }),
                json!({ "mode": "Read-Only" }),
                json!({ "mode": "readonly" }),
                json!("read_only"),
            ] {
                let read_only = |metadata: &mut Value| {
                    without_scopes(metadata);
                    let (container, key) = place.split_once('.').unwrap_or(("", place));
                    if container.is_empty() {
                        metadata[key] = spelling.clone();
                    } else {
                        metadata[container][key] = spelling.clone();
                    }
                };
                assert_eq!(
                    mode_with(&read_only),
                    Ok(ExecutionMode::PlanOnly),
                    "{place}: {spelling}"
                );
            }
        }
        // The strictest place decides: an unscoped scope hides no read-only one.
        assert_eq!(
            mode_with(&|metadata| {
                metadata["agent"]["writeScope"] = json!({ "mode": "read_only" })
            }),
            Ok(ExecutionMode::PlanOnly)
        );
        // With the `plan_only` mode too, and never past a mode no lane turn runs in.
        assert_eq!(
            mode_with(&|metadata| {
                metadata["writeScope"] = json!({ "mode": "read_only" });
                metadata["execution_mode"] = json!("plan_only");
            }),
            Ok(ExecutionMode::PlanOnly)
        );
        let approval = mode_with(&|metadata| {
            metadata["writeScope"] = json!({ "mode": "read_only" });
            metadata["execution_mode"] = json!("approval_required");
        });
        assert!(approval.is_err());

        for scope in [
            json!({ "mode": "owned", "ownedPaths": ["src/app.ts"] }),
            json!({ "mode": "write" }),
            json!({ "mode": "write_scoped" }),
            json!({ "mode": "coordination_required" }),
            json!({ "mode": "a-later-mode" }),
            json!({ "ownedPaths": ["src/app.ts"] }),
            json!({}),
            json!(true),
        ] {
            for place in ["writeScope", "agent"] {
                let failure = mode_with(&|metadata| {
                    if place == "agent" {
                        metadata["agent"]["writeScope"] = scope.clone();
                    } else {
                        metadata[place] = scope.clone();
                    }
                })
                .expect_err("refused");
                assert_eq!(failure.code, None, "{scope}");
                assert_eq!(
                    failure.message,
                    "Claude Code can't be held to part of the space's files, so this turn didn't start.",
                    "{place}: {scope}"
                );
            }
        }
    }

    #[test]
    fn the_job_shape_the_person_the_mode_and_what_claude_code_cannot_take_are_checked() {
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
                "approval required".into(),
                job_with(&|job| {
                    job.payload["metadata"]["execution_mode"] = json!("approval_required")
                }),
            ),
            (
                "a plan seed".into(),
                job_with(&|job| job.payload["plan_seed"] = json!({ "steps": [] })),
            ),
            (
                "a plan seed, in camel case".into(),
                job_with(&|job| job.payload["planSeed"] = json!({ "steps": [] })),
            ),
            (
                "a team plan's worker".into(),
                job_with(&|job| {
                    job.payload["metadata"]["multiAgentPlan"] =
                        json!({ "role": "worker", "groupId": "group-1" })
                }),
            ),
            (
                "a team plan's lead".into(),
                job_with(&|job| {
                    job.payload["metadata"]["multi_agent_plan"] =
                        json!({ "role": "lead_continuation" })
                }),
            ),
            (
                "a hand-back's reading note".into(),
                job_with(&|job| job.payload["browser_hand_back_reads_note"] = json!(true)),
            ),
            (
                "a Personal Browser turn".into(),
                job_with(&|job| {
                    job.payload["metadata"]["browserTransport"] = json!("desktop_personal")
                }),
            ),
            (
                "a Shared Browser turn".into(),
                job_with(&|job| job.payload["metadata"]["browser_transport"] = json!("shared")),
            ),
            (
                "any browser transport".into(),
                job_with(&|job| {
                    job.payload["metadata"]["browserTransport"] = json!("a-later-browser")
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
        for key in TEAM_PLAN_KEYS.iter().chain(&BROWSER_KEYS) {
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
        // Each of what Claude Code cannot take says what it is.
        let says = |change: &dyn Fn(&mut LeaseJob), words: &str| {
            let failure = refusal(&job_with(change), &grant);
            assert!(failure.message.contains(words), "{words}: {failure:?}");
        };
        says(
            &|job| job.payload["metadata"]["browserTransport"] = json!("shared"),
            "browser",
        );
        says(
            &|job| job.payload["metadata"]["multiAgentPlan"] = json!({ "role": "worker" }),
            "team plan",
        );
        says(
            &|job| job.payload["metadata"]["attachments"] = json!([{ "name": "a.png" }]),
            "attachments",
        );
        says(&|job| job.payload["prompt_text"] = json!("/compact"), "/");

        // The limit is in characters, and the words are kept as they are.
        let mut longest = lane_job(person);
        longest.payload["prompt_text"] = json!("é".repeat(MAX_PROMPT_CHARS));
        assert!(LaneJob::of(&longest, &grant).is_ok());
        // Null markers and empty lists are no markers.
        let mut nulls = lane_job(person);
        nulls.payload["metadata"]["multiAgentPlan"] = Value::Null;
        nulls.payload["metadata"]["browserTransport"] = Value::Null;
        nulls.payload["metadata"]["attachments"] = json!([]);
        nulls.payload["plan_seed"] = Value::Null;
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
        let mut plan_only = lane_job(person);
        plan_only.payload["metadata"]["execution_mode"] = json!("plan_only");
        assert!(refuse_unless_runnable(&plan_only, Ok(&lane)).is_none());

        let mut unknown = lane_job(person);
        unknown.engine = Some("other-engine".into());
        let failure = refuse_unless_runnable(&unknown, Ok(&lane)).expect("refused");
        assert_eq!(failure.code, None);
        assert!(failure.message.contains("other-engine"), "{failure:?}");

        for reason in NotReadyReason::ALL {
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
        let mut approval = lane_job(person);
        approval.payload["metadata"]["execution_mode"] = json!("approval_required");
        assert!(refuse_unless_runnable(&approval, Ok(&lane)).is_some());
    }

    /// A turn a plan limit's hold kept from starting fails as `plan_limit`, with the reset time
    /// in its words, as Claude Code's own plan limits are worded, and as its own.
    #[test]
    fn a_turn_the_plan_limit_holds_fails_as_plan_limit_with_the_reset_time() {
        let now = chrono::DateTime::from_timestamp(1_900_000_000, 0).unwrap();
        let hold = PlanLimitHold::after(Some(1_900_003_600), now).expect("a hold");
        let failure = plan_limit_hold_failure(&hold);
        assert_eq!(failure.code, Some(FailureCode::PlanLimit));
        assert_eq!(failure.resets_at, Some(1_900_003_600));
        assert!(
            failure
                .message
                .ends_with("The limit resets at 2030-03-17 18:46 UTC."),
            "{failure:?}"
        );
        assert_eq!(
            failure_artifacts(&failure),
            [json!({ "kind": "claude-code/failure", "code": "plan_limit" })]
        );
    }

    /// A lane state's session is resumed whichever computer saved it (11.9): when this one does
    /// not have it, the turn starts again in a new session.
    #[test]
    fn a_session_is_resumed_whichever_computer_saved_it() {
        let session = Uuid::new_v4();
        let state = |session: &str, runtime: Option<Uuid>| {
            let mut state = json!({
                "provider": "claude-code",
                "version": 1,
                "sessionId": session,
            });
            if let Some(runtime) = runtime {
                state["runtimeId"] = json!(runtime.to_string());
            }
            state
        };
        for runtime in [Some(Uuid::new_v4()), Some(Uuid::new_v4()), None] {
            assert_eq!(
                resume_session(Some(&state(&session.to_string(), runtime))),
                Some(session)
            );
        }
        // A session id that is no UUID, the reset state, a Codex state, a newer version, and
        // none at all start a new session.
        let simple = session.simple().to_string();
        for bad in ["", "not-a-uuid", "--fork-session", simple.as_str()] {
            assert_eq!(resume_session(Some(&state(bad, None))), None);
        }
        let reset = json!({ "provider": "claude-code", "version": 1, "reset": true });
        assert_eq!(resume_session(Some(&reset)), None);
        let mut codex = state(&session.to_string(), None);
        codex["provider"] = json!("codex-embedded");
        assert_eq!(resume_session(Some(&codex)), None);
        let mut newer = state(&session.to_string(), None);
        newer["version"] = json!(2);
        assert_eq!(resume_session(Some(&newer)), None);
        assert_eq!(resume_session(None), None);
    }
}
