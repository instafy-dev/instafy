//! A turn that stopped on a short upstream rate limit before it acted goes back to the queue, at
//! most [`MAX_RERUNS`] times.
//!
//! A team's lane that hits a short provider rate limit runs once more in its group
//! (`multi_agent_plan::rate_limit_retry`). Any other turn failed outright: a person's turn, which
//! is where a team's lead plans, or a lead's checkpoint. When several teams start at once on one
//! upstream, a lead whose first request lands in the exhausted window fails, and with it the
//! person's whole request (two of four teams in run r10-pacing3). Such a turn now goes back to the
//! queue, as a runtime stop puts back the turns it cut off: the same job and run, the run shown as
//! queued again (`progress_stage` `requeued`, `metadata.interruption.reason`
//! [`REQUEUE_REASON`]), and no failure posted. No runtime leases it before the hold in
//! `payload.rateLimitRetry.heldUntilMs` has passed; the requeued-job expiry fails it with a
//! message if none does (`runtime::sweeps`).
//!
//! The rules are the lanes' rules, on the same shared classifier:
//!
//! - The failure is the provider rate-limit kind and states a wait of at most 30 s
//!   (`multi_agent_plan::short_rate_limit_wait`, pinned to `run_failure_fixtures.json`). A spent
//!   plan or usage window, a quota, auth, any other 4xx, or a rate limit that names no wait or a
//!   long one, fails the turn as before.
//! - The turn did not act: no command (other than the routing pre-observation the runtime itself
//!   runs before the model), MCP tool call or file change, no visible reply, and no job it
//!   started. Searching the web is not acting. A second run on top of an effect could repeat it.
//! - At most [`MAX_RERUNS`] times per job: the job keeps `payload.rateLimitRetry` with the number
//!   of `attempts`, so the rate limit after the last one fails it. One re-run was not enough when
//!   four teams started at once on an upstream that takes two requests per 30 s: the re-run landed
//!   in a window the other teams' lanes had used up (run r11-pacing).
//! - Not a team's lane or follow-on agent (its group retries it), not a terminal command, not a
//!   turn bound to a person's own or a shared browser, which a stop does not move either, and not
//!   a job holding device grants (`device_grants.rs`), which no lease hands out again.
//!
//! The hold is the stated wait plus a jitter fixed per job, as for lanes, and never ends before
//! the cooldown the pacing (`upstream_pacing`) holds the job's upstream in, which the attempt's
//! own rate limit also teaches. Billing does not change: the send's one flat reserve stays with the
//! job and covers every attempt, as it does for a turn a runtime stop puts back. An attempt that
//! failed this way finished no model turn, so it has no turn usage to settle; a routing call it
//! made before the refused request is covered by that reserve, as a failed turn's would be.

use std::time::Duration;

use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tracing::{info, warn};
use uuid::Uuid;

use crate::AppState;

/// The reason the run of a requeued turn records (`metadata.interruption.reason`) and the job
/// (`payload.requeuedReason`).
pub(crate) const REQUEUE_REASON: &str = "upstream_rate_limit";
/// Where the job records its retries; its `attempts` is what bounds them.
pub(crate) const PAYLOAD_KEY: &str = "rateLimitRetry";
/// How many times one job runs again after a short rate limit.
pub(crate) const MAX_RERUNS: u64 = 3;
/// The longest hold: the pacing's longest cooldown.
const MAX_HOLD: Duration = Duration::from_secs(60);
/// The runtime's own routing pre-observation, which it runs before the model (`agent.rs`).
const ROUTING_PRE_OBSERVATION_SOURCE: &str = "routing_pre_observation";

/// A turn that just ended, as far as its retry goes.
#[derive(Debug, Clone, Copy)]
pub(crate) struct EndedTurn<'a> {
    pub(crate) status: &'a str,
    pub(crate) error: Option<&'a str>,
    pub(crate) payload: &'a JsonValue,
    pub(crate) intent: Option<&'a str>,
    pub(crate) agent_role: Option<&'a str>,
    /// It ran a command, MCP tool or file change, replied visibly, or started a job.
    pub(crate) acted: bool,
    /// Its job holds device grants.
    pub(crate) holds_grants: bool,
}

/// How many times the job already went back to the queue after a short rate limit. A record
/// without `attempts` was written when a job ran again once only.
pub(crate) fn reruns_so_far(payload: &JsonValue) -> u64 {
    payload.get(PAYLOAD_KEY).map_or(0, |retry| {
        retry
            .get("attempts")
            .and_then(JsonValue::as_u64)
            .unwrap_or(1)
    })
}

/// The wait the turn's failure states when the turn goes back to the queue (see the module).
pub(crate) fn retry_wait(turn: &EndedTurn<'_>) -> Option<Duration> {
    if turn.status != "failed"
        || turn.acted
        || turn.holds_grants
        || reruns_so_far(turn.payload) >= MAX_RERUNS
    {
        return None;
    }
    let plan_role = turn
        .payload
        .pointer("/metadata/multiAgentPlan/role")
        .and_then(JsonValue::as_str);
    if turn.agent_role.or(plan_role) == Some("worker") {
        return None;
    }
    if turn
        .intent
        .is_some_and(|intent| intent.trim().eq_ignore_ascii_case("terminal_command"))
    {
        return None;
    }
    let transport = ["/metadata/browserTransport", "/metadata/browser_transport"]
        .iter()
        .find_map(|pointer| turn.payload.pointer(pointer).and_then(JsonValue::as_str))
        .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"));
    if matches!(transport.as_deref(), Some("desktop-personal" | "shared")) {
        return None;
    }
    crate::multi_agent_plan::short_rate_limit_wait(turn.error)
}

/// How long the requeued job waits: the lanes' hold for `wait`, but no shorter than what is left
/// of its upstream's cooldown, and at most [`MAX_HOLD`].
pub(crate) fn hold(wait: Duration, job_id: Uuid, cooldown_left: Duration) -> Duration {
    crate::multi_agent_plan::retry_hold(wait, job_id)
        .max(cooldown_left)
        .min(MAX_HOLD)
}

/// A turn put back in the queue; publish it once its transaction has committed.
#[derive(Debug)]
pub(crate) struct RequeuedTurn {
    job_id: Uuid,
    error: String,
}

impl RequeuedTurn {
    /// Teach the pacing what the attempt's rate limit says, and show the run waiting again.
    pub(crate) async fn publish(self, state: &AppState) {
        crate::upstream_pacing::record_requeued_attempt_end(&state.pool, self.job_id, &self.error)
            .await;
        crate::runtime::announce_requeued_job_run(state, &self.job_id).await;
    }
}

/// Put the job that just failed back in the queue when its turn may run once more (see the
/// module). Call it in the completion's transaction, right after the job row was marked failed
/// and before anything else of the failure is written: the job and its run go back to queued, and
/// the caller commits and returns without settling a failure. On an error the caller rolls the
/// savepoint back and fails the turn as before.
pub(crate) async fn maybe_requeue(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
    payload: &JsonValue,
    error: Option<&str>,
) -> anyhow::Result<Option<RequeuedTurn>> {
    // Cheap checks first: most failures are not a short rate limit.
    if crate::multi_agent_plan::short_rate_limit_wait(error).is_none() {
        return Ok(None);
    }
    let row = transaction
        .query_one(
            "select aj.status, aj.intent, aj.agent_role,
                    aj.grant_ids is not null as holds_grants,
                    exists (
                        select 1 from conversation_messages m
                        where m.project_id = aj.project_id
                          and coalesce(m.metadata #>> '{jobId}', m.metadata #>> '{job_id}') = aj.id::text
                          and lower(coalesce(m.metadata #>> '{messageType}', m.metadata #>> '{message_type}', ''))
                              in ('command_execution', 'mcp_tool_call', 'file_change')
                          and m.metadata #>> '{details,source}' is distinct from $2
                    ) as used_a_tool,
                    exists (
                        select 1 from agent_jobs started
                        where started.project_id = aj.project_id and started.parent_job_id = aj.id
                    ) as started_a_job
             from agent_jobs aj
             where aj.id = $1",
            &[&job_id, &ROUTING_PRE_OBSERVATION_SOURCE],
        )
        .await?;
    let status: String = row.get("status");
    let intent: Option<String> = row.get("intent");
    let agent_role: Option<String> = row.get("agent_role");
    let replied = crate::agent::run_has_visible_assistant_message(transaction, &project_id, run_id)
        .await
        .map_err(|(status, axum::Json(error))| {
            anyhow::anyhow!("failed to look for a reply ({status}): {}", error.message)
        })?;
    let turn = EndedTurn {
        status: &status,
        error,
        payload,
        intent: intent.as_deref(),
        agent_role: agent_role.as_deref(),
        acted: row.get::<_, bool>("used_a_tool") || row.get::<_, bool>("started_a_job") || replied,
        holds_grants: row.get("holds_grants"),
    };
    let Some(wait) = retry_wait(&turn) else {
        return Ok(None);
    };
    let cooldown_left = crate::upstream_pacing::cooldown_left(transaction, job_id).await?;
    let hold = hold(wait, job_id, cooldown_left);
    let error = error.unwrap_or_default().to_string();
    let attempts = reruns_so_far(payload) + 1;
    let retry = json!({
        "waitMs": wait.as_millis() as u64,
        "holdMs": hold.as_millis() as u64,
        "error": error,
        "attempts": attempts,
    });
    let requeued = transaction
        .execute(
            "update agent_jobs
             set status = 'queued',
                 outcome = null,
                 summary = null,
                 error_message = null,
                 completed_at = null,
                 leased_by_runtime_id = null,
                 lease_expires_at = null,
                 leased_at = null,
                 heartbeat_at = null,
                 active_input_ready_runtime_id = null,
                 active_input_ready_expires_at = null,
                 active_input_ready_turn_id = null,
                 payload = payload || jsonb_build_object(
                     'requeuedAt', to_jsonb(now()),
                     'requeuedReason', $2::text,
                     $3::text, $4::jsonb || jsonb_build_object(
                         'heldUntilMs',
                         floor(extract(epoch from now()) * 1000)::bigint + ($4::jsonb ->> 'holdMs')::bigint
                     )
                 ),
                 updated_at = now()
             where id = $1 and status = 'failed'",
            &[&job_id, &REQUEUE_REASON, &PAYLOAD_KEY, &PgJson(&retry)],
        )
        .await?;
    if requeued != 1 {
        return Ok(None);
    }
    crate::runtime::mark_interrupted_runs(transaction, &project_id, &[job_id], REQUEUE_REASON)
        .await
        .map_err(|(status, axum::Json(error))| {
            anyhow::anyhow!(
                "failed to mark the run requeued ({status}): {}",
                error.message
            )
        })?;
    info!(
        %project_id,
        %job_id,
        wait_ms = wait.as_millis() as u64,
        hold_ms = hold.as_millis() as u64,
        attempt = attempts,
        max_attempts = MAX_RERUNS,
        "a turn that stopped on a short provider rate limit before it acted goes back to the queue"
    );
    Ok(Some(RequeuedTurn { job_id, error }))
}

/// [`maybe_requeue`] in a savepoint of the completion's transaction: an error is logged, rolled
/// back and answered with `None`, so the turn fails as it would have.
pub(crate) async fn maybe_requeue_or_fail(
    transaction: &mut tokio_postgres::Transaction<'_>,
    project_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
    payload: &JsonValue,
    error: Option<&str>,
) -> Option<RequeuedTurn> {
    crate::multi_agent_plan::short_rate_limit_wait(error)?;
    let savepoint = match transaction.savepoint("turn_rate_limit_retry").await {
        Ok(savepoint) => savepoint,
        Err(savepoint_error) => {
            warn!(%job_id, error = %savepoint_error, "could not open the rate-limit retry savepoint");
            return None;
        }
    };
    match maybe_requeue(&savepoint, project_id, job_id, run_id, payload, error).await {
        Ok(Some(requeued)) => match savepoint.commit().await {
            Ok(()) => Some(requeued),
            Err(commit_error) => {
                warn!(%job_id, error = %commit_error, "could not keep the turn's requeue; it fails");
                None
            }
        },
        Ok(None) => {
            let _ = savepoint.rollback().await;
            None
        }
        Err(requeue_error) => {
            warn!(%job_id, error = %requeue_error, "could not requeue a rate-limited turn; it fails");
            let _ = savepoint.rollback().await;
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE_LIMITED: &str = "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 29.01s.";

    fn turn<'a>(payload: &'a JsonValue, error: &'a str) -> EndedTurn<'a> {
        EndedTurn {
            status: "failed",
            error: Some(error),
            payload,
            intent: Some("feature"),
            agent_role: None,
            acted: false,
            holds_grants: false,
        }
    }

    #[test]
    fn a_lead_turn_that_stopped_on_a_short_rate_limit_before_it_acted_runs_once_more() {
        // r10-pacing3: a person's turn to the lead, rate-limited on its routing call
        let planning = json!({"metadata": {"agent": {"handle": "octo"}}});
        assert_eq!(
            retry_wait(&turn(&planning, RATE_LIMITED)),
            Some(Duration::from_millis(29_010))
        );
        // a lead's checkpoint is not a lane: it is retried here too
        let checkpoint =
            json!({"metadata": {"multiAgentPlan": {"role": "lead_continuation", "groupId": "g"}}});
        assert!(retry_wait(&turn(&checkpoint, RATE_LIMITED)).is_some());
    }

    #[test]
    fn the_shared_failure_fixtures_decide_which_failures_are_retried() {
        let parsed: JsonValue =
            serde_json::from_str(include_str!("run_failure_fixtures.json")).expect("fixtures");
        let payload = json!({"metadata": {}});
        for case in parsed["cases"].as_array().expect("cases") {
            let text = case["text"].as_str().expect("text");
            assert_eq!(
                retry_wait(&turn(&payload, text)).map(|wait| wait.as_millis() as u64),
                case["shortRateLimitWaitMs"].as_u64(),
                "fixture {:?}",
                case["name"]
            );
        }
    }

    #[test]
    fn usage_limits_auth_other_4xx_and_long_or_unstated_waits_fail_as_before() {
        let payload = json!({"metadata": {}});
        for message in [
            "You\u{2019}ve hit your usage limit for GPT-5. Upgrade to Pro, or try again in 3 days 2 hours.",
            "rate limit exceeded: The upstream plan usage limit was reached. (usage_limit_reached, 429). Please try again in 7s.",
            "rate limit exceeded: insufficient_quota (upstream_rate_limit, 429). Please try again in 7s.",
            "unexpected status 401 Unauthorized: Please try again in 7s.",
            "unexpected status 403 Forbidden: Please try again in 7s.",
            "unexpected status 400 Bad Request: The upstream provider rejected the request.",
            "exceeded retry limit, last status: 429 Too Many Requests",
            "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 169s.",
            "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429).",
            "Codex run timed out",
        ] {
            assert_eq!(retry_wait(&turn(&payload, message)), None, "{message}");
        }
    }

    #[test]
    fn a_turn_that_acted_was_retried_or_is_not_safe_to_run_again_is_not_requeued() {
        let payload = json!({"metadata": {}});
        let mut acted = turn(&payload, RATE_LIMITED);
        acted.acted = true;
        assert_eq!(retry_wait(&acted), None, "acted");

        let again =
            json!({"metadata": {}, PAYLOAD_KEY: {"waitMs": 5_000, "attempts": MAX_RERUNS - 1}});
        assert!(
            retry_wait(&turn(&again, RATE_LIMITED)).is_some(),
            "it runs again until its last re-run"
        );
        let spent = json!({"metadata": {}, PAYLOAD_KEY: {"waitMs": 5_000, "attempts": MAX_RERUNS}});
        assert_eq!(
            retry_wait(&turn(&spent, RATE_LIMITED)),
            None,
            "at most MAX_RERUNS times per job"
        );
        let mut legacy = json!({"metadata": {}, PAYLOAD_KEY: {"waitMs": 5_000}});
        assert_eq!(
            reruns_so_far(&legacy),
            1,
            "a record from before the count is one re-run"
        );
        legacy[PAYLOAD_KEY]["attempts"] = json!("two");
        assert_eq!(reruns_so_far(&legacy), 1);
        assert_eq!(reruns_so_far(&payload), 0);

        let lane = json!({"metadata": {"multiAgentPlan": {"role": "worker"}}});
        assert_eq!(
            retry_wait(&turn(&lane, RATE_LIMITED)),
            None,
            "a lane's group retries it"
        );
        let mut by_column = turn(&payload, RATE_LIMITED);
        by_column.agent_role = Some("worker");
        assert_eq!(retry_wait(&by_column), None, "a lane by its column");

        let mut terminal = turn(&payload, RATE_LIMITED);
        terminal.intent = Some("terminal_command");
        assert_eq!(retry_wait(&terminal), None, "a terminal command");

        let mut granted = turn(&payload, RATE_LIMITED);
        granted.holds_grants = true;
        assert_eq!(retry_wait(&granted), None, "a job holding device grants");

        for transport in ["desktop-personal", "shared", "desktop_personal"] {
            let browser = json!({"metadata": {"browserTransport": transport}});
            assert_eq!(
                retry_wait(&turn(&browser, RATE_LIMITED)),
                None,
                "{transport}"
            );
        }

        let mut succeeded = turn(&payload, RATE_LIMITED);
        succeeded.status = "completed";
        assert_eq!(retry_wait(&succeeded), None, "not failed");
    }

    #[test]
    fn the_hold_never_ends_before_the_upstreams_cooldown() {
        let job = Uuid::new_v4();
        let wait = Duration::from_millis(7_632);
        let own = hold(wait, job, Duration::ZERO);
        assert!(own >= wait && own <= wait + wait / 2, "{own:?}");
        assert_eq!(
            hold(wait, job, Duration::from_secs(40)),
            Duration::from_secs(40),
            "a longer cooldown another job taught holds"
        );
        assert_eq!(
            hold(wait, job, Duration::from_secs(600)),
            MAX_HOLD,
            "never longer than the pacing's longest cooldown"
        );
    }
}
