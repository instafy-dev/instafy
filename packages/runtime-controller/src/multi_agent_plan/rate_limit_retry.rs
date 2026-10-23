//! A team's plan agent that stopped on a short upstream rate limit before it acted is started
//! once more.
//!
//! When several teams start at once, their lanes share one upstream bucket. Codex already waits
//! out a streamed rate limit inside the turn (#636), but a lane whose retry lands in the same
//! exhausted window fails, and its group then loses that lane (or wakes the lead early to re-plan
//! it). Such a lane is dispatched again in the same group, on the runtime that ran it, with its
//! own prompt: not leased before the delay the provider stated plus a per-lane jitter
//! (`metadata.multiAgentPlan.rateLimitRetry.holdMs`, read by the lease query). The queued retry
//! keeps the group open, so no early or final checkpoint starts for the failure while it waits.
//!
//! Only a run that did not act is started again. The runtime never replays a turn after this
//! failure (`should_retry_codex_run` in runtime-agent), because a replay on top of what the turn
//! already did could repeat its side effects. The same holds here, so a run that recorded any
//! command, MCP tool call or file change is left to the group's normal path; one that only
//! thought and searched the web did nothing a second run could repeat. In the itinerary evals
//! every lane that hit this reported no model usage at all: its first request never got through.
//!
//! The failure must be the shared provider rate-limit kind (`is_provider_rate_limited_failure`,
//! pinned with the Studio's to `run_failure_fixtures.json`, which also pins the wait read here):
//! a spent plan or usage window, a quota, auth or any other 4xx is never that kind. Its text must
//! state a wait of at most [`MAX_SHORT_WAIT`]. The proxy always states one (its own 5 s when the
//! provider gave none); codex's "exceeded retry limit, last status: 429" states none and is not
//! retried. An agent is started again by the controller at most once: not when any earlier run of
//! it in the group failed. A stopped group starts none (`checkpoint_plan_group` returns before
//! this). Each job is charged only for the usage it reports, so the failed run and the retry are
//! never billed twice.

use std::time::Duration;

use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tracing::{info, warn};
use uuid::Uuid;

use super::turn_continuation::{
    leased_runtime_id, plan_job_agent, redispatch_plan_agent, PlanAgentRedispatch,
};
use super::{normalize_agent_handle, RerunReason, SiblingJobSnapshot};
use crate::AppState;

pub(crate) const RATE_LIMIT_RETRY_ARTIFACT: &str = "agent/rate-limit-retry";
/// The longest stated wait that counts as short: the proxy's own bound for a wait it derives
/// (`MAX_DERIVED_RETRY_AFTER_SECS`). A longer one is a provider's explicit long window.
const MAX_SHORT_WAIT: Duration = Duration::from_secs(30);
/// The longest a retry is held before a runtime may lease it.
const MAX_HOLD: Duration = Duration::from_secs(45);
/// Jitter spreads the retries of lanes that failed together over up to half their wait (half of
/// this, at least), so they do not all return to the bucket at the same instant.
const MIN_JITTER_BASE: Duration = Duration::from_secs(5);
/// Marks where the retry's note starts in the agent's prompt.
pub(crate) const RETRY_MARKER: &str = "\n\n--- Started again after a provider rate limit ---\n";

/// The wait a failed job's error states for a short provider rate limit, if it is one: the shared
/// provider rate-limit kind, with a stated wait ("try again in 5.968s") of at most
/// [`MAX_SHORT_WAIT`].
pub(crate) fn short_rate_limit_wait(error: Option<&str>) -> Option<Duration> {
    let error = error?;
    if !crate::agent::is_provider_rate_limited_failure(error) {
        return None;
    }
    let wait = stated_wait(&error.to_ascii_lowercase())?;
    (!wait.is_zero() && wait <= MAX_SHORT_WAIT).then_some(wait)
}

/// The wait a message states after its last "try again in" (`{n}s` or `{n}ms`), whatever its kind.
pub(crate) fn stated_rate_limit_wait(message: &str) -> Option<Duration> {
    stated_wait(&message.to_ascii_lowercase())
}

/// The wait after the last "try again in" of a lowercased message: `{n}s` or `{n}ms`.
fn stated_wait(lower: &str) -> Option<Duration> {
    const PREFIX: &str = "try again in ";
    let at = lower.rfind(PREFIX)? + PREFIX.len();
    let rest = &lower[at..];
    let digits = rest
        .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .unwrap_or(rest.len());
    let value: f64 = rest[..digits].parse().ok()?;
    let unit = rest[digits..].trim_start();
    let seconds = if unit.starts_with("ms") {
        value / 1_000.0
    } else if unit.starts_with('s') {
        value
    } else {
        return None;
    };
    Duration::try_from_secs_f64(seconds).ok()
}

/// How long the retry of `job_id` waits before it may be leased: the stated wait plus a jitter
/// fixed per job, at most [`MAX_HOLD`].
pub(crate) fn retry_hold(wait: Duration, job_id: Uuid) -> Duration {
    let spread = wait.max(MIN_JITTER_BASE) / 2;
    let fraction = (job_id.as_u128() as u64 % 1_000) as f64 / 1_000.0;
    (wait + spread.mul_f64(fraction)).min(MAX_HOLD)
}

/// The agent's prompt with the note that its previous run stopped on a rate limit.
pub(crate) fn rate_limit_retry_prompt(agent_prompt: &str) -> String {
    let base = agent_prompt
        .split(RETRY_MARKER)
        .next()
        .unwrap_or(agent_prompt)
        .trim_end();
    format!(
        "{base}{RETRY_MARKER}Your previous run of this task stopped on a short provider rate limit, not on your work. Check the workspace for anything it saved, then do the task."
    )
}

/// Whether the lane of `job_id` may be started again after a short rate limit: the job failed
/// with one before it acted, its failure did not start
/// a retry yet (a repeated completion starts nothing more), and no other run of this agent in the
/// group failed (the controller re-runs an agent at most once).
pub(crate) fn rate_limit_retry_wait(
    job_id: Uuid,
    workers: &[SiblingJobSnapshot],
) -> Option<Duration> {
    let failed = workers.iter().find(|worker| worker.id == job_id)?;
    if failed.status != "failed" || failed.retried_as.is_some() || failed.acting_tool_count > 0 {
        return None;
    }
    let wait = short_rate_limit_wait(failed.error_message.as_deref())?;
    let handle = failed.handle.as_deref().and_then(normalize_agent_handle)?;
    // a turn stopped at its time limit and continued is not a failure of the agent
    let failed_before = workers.iter().any(|worker| {
        worker.id != job_id
            && worker.status == "failed"
            && !matches!(worker.retried_as, Some((_, RerunReason::TurnContinuation)))
            && worker
                .handle
                .as_deref()
                .and_then(normalize_agent_handle)
                .as_deref()
                == Some(handle.as_str())
    });
    (!failed_before).then_some(wait)
}

/// Queue the lane of the job that just failed once more when it stopped on a short rate limit
/// before it acted (see [`rate_limit_retry_wait`]). Called under the group's checkpoint lock: a
/// queued retry keeps the group open. Returns whether one was queued.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn maybe_dispatch_rate_limit_retry<C>(
    connection: &C,
    state: &AppState,
    project_id: Uuid,
    conversation_id: Uuid,
    group_id: &str,
    job_id: Uuid,
    job_payload: &JsonValue,
    plan_meta: &JsonMap<String, JsonValue>,
    workers: &[SiblingJobSnapshot],
) -> bool
where
    C: tokio_postgres::GenericClient + Sync,
{
    let Some(wait) = rate_limit_retry_wait(job_id, workers) else {
        return false;
    };
    let Some(agent) = plan_job_agent(job_payload) else {
        warn!(%job_id, "a plan job stopped on a rate limit, but its lane is not in its plan seed");
        return false;
    };
    let runtime_id = workers
        .iter()
        .find(|worker| worker.id == job_id)
        .and_then(leased_runtime_id);
    let hold = retry_hold(wait, job_id);
    let wait_ms = wait.as_millis() as u64;
    let hold_ms = hold.as_millis() as u64;
    let mut entries = vec![(
        "rateLimitRetry",
        json!({
            "of": job_id,
            "waitMs": wait_ms,
            "holdMs": hold_ms,
            "reason": "upstream_rate_limit",
        }),
    )];
    // a continuation turn is retried as that turn, so its turn count carries on
    if let Some(continuation) = plan_meta
        .get("continuation")
        .filter(|value| value.is_object())
    {
        entries.push(("continuation", continuation.clone()));
    }
    let handle = agent.handle.clone();
    let redispatch = PlanAgentRedispatch {
        prompt: rate_limit_retry_prompt(&agent.prompt),
        agent,
        rationale: "Started by the controller: the agent's previous run stopped on a short provider rate limit",
        reason: "The agent's previous run stopped on a short provider rate limit; the controller started it once more.",
        runtime_id,
        plan_meta: entries,
    };
    let response = match redispatch_plan_agent(
        state,
        project_id,
        conversation_id,
        group_id,
        job_id,
        job_payload,
        plan_meta,
        redispatch,
    )
    .await
    {
        Ok(response) => response,
        Err((status, axum::Json(error))) => {
            warn!(
                %group_id,
                %job_id,
                handle = %handle,
                status = status.as_u16(),
                error = %error.message,
                "could not queue the lane again after a rate limit; the group goes on without it"
            );
            return false;
        }
    };
    let artifact = json!({
        "kind": RATE_LIMIT_RETRY_ARTIFACT,
        "retriedBy": response.job_id,
        "waitMs": wait_ms,
        "holdMs": hold_ms,
    });
    if let Err(error) = connection
        .execute(
            "update agent_jobs
             set artifacts = case when jsonb_typeof(artifacts) = 'array' then artifacts else '[]'::jsonb end
                             || jsonb_build_array($2::jsonb)
             where id = $1",
            &[&job_id, &PgJson(artifact)],
        )
        .await
    {
        warn!(%job_id, %error, "could not record the rate-limit retry on the failed plan job");
    }
    info!(
        %group_id,
        %job_id,
        handle = %handle,
        wait_ms,
        hold_ms,
        retry_job_id = ?response.job_id,
        "queued a lane once more after a short provider rate limit"
    );
    true
}

#[cfg(test)]
mod tests {
    use super::super::parse_skill_multi_agent_plan;
    use super::*;

    const EVIDENCE: &str = "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 7.632s.";

    #[test]
    fn the_short_wait_matches_the_shared_failure_fixtures() {
        // The list the Studio's failure card and the agent-history label are pinned to: a text
        // gets a short wait only if it is the provider rate-limit kind there.
        let parsed: JsonValue =
            serde_json::from_str(include_str!("../run_failure_fixtures.json")).expect("fixtures");
        let cases = parsed["cases"].as_array().expect("cases");
        assert!(
            cases
                .iter()
                .filter(|case| case["shortRateLimitWaitMs"].is_u64())
                .count()
                >= 3
        );
        for case in cases {
            let text = case["text"].as_str().expect("text");
            let expected = case["shortRateLimitWaitMs"].as_u64();
            assert_eq!(
                short_rate_limit_wait(Some(text)).map(|wait| wait.as_millis() as u64),
                expected,
                "fixture {:?}",
                case["name"]
            );
            if expected.is_some() {
                assert_eq!(
                    case["providerRateLimited"], true,
                    "fixture {:?}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn a_short_upstream_rate_limit_states_its_wait() {
        assert_eq!(
            short_rate_limit_wait(Some(EVIDENCE)),
            Some(Duration::from_millis(7_632))
        );
        assert_eq!(
            short_rate_limit_wait(Some(
                "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 29.846s."
            )),
            Some(Duration::from_millis(29_846))
        );
    }

    #[test]
    fn usage_limits_auth_and_other_4xx_are_not_retried() {
        for message in [
            "You\u{2019}ve hit your usage limit for GPT-5. Upgrade to Pro, or try again in 3 days 2 hours.",
            "You've hit your usage limit. Please try again in 5s.",
            "You\u{2019}ve hit your usage limit (upstream_rate_limit, 429). Please try again in 5s.",
            "rate limit exceeded: The upstream plan usage limit was reached. (usage_limit_reached, 429). Please try again in 7s.",
            "rate limit exceeded: insufficient_quota (upstream_rate_limit, 429). Please try again in 7s.",
            "rate limit exceeded: monthly quota spent (upstream_rate_limit, 429). Please try again in 7s.",
            "unexpected status 401 Unauthorized: Please try again in 7s.",
            "unexpected status 403 Forbidden: Please try again in 7s.",
            "unexpected status 400 Bad Request: The upstream provider rejected the request.",
            "Scoped worker proxy request failed with status 429 Too Many Requests: try again in 2s",
            // codex's own rate limit for a provider it called directly names no wait
            "exceeded retry limit, last status: 429 Too Many Requests",
        ] {
            assert_eq!(short_rate_limit_wait(Some(message)), None, "{message}");
        }
        assert_eq!(short_rate_limit_wait(None), None);
    }

    #[test]
    fn a_long_or_missing_wait_is_not_a_short_rate_limit() {
        for message in [
            "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 169s.",
            "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429).",
            "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 0s.",
        ] {
            assert_eq!(short_rate_limit_wait(Some(message)), None, "{message}");
        }
    }

    #[test]
    fn the_hold_is_the_wait_plus_a_bounded_jitter_fixed_per_job() {
        let job = Uuid::new_v4();
        let wait = Duration::from_millis(7_632);
        let hold = retry_hold(wait, job);
        assert!(hold >= wait && hold <= wait + wait / 2, "{hold:?}");
        assert_eq!(retry_hold(wait, job), hold, "the same job waits the same");
        let short = retry_hold(Duration::from_millis(1_156), job);
        assert!(short <= Duration::from_millis(1_156 + 2_500), "{short:?}");
        assert!(retry_hold(Duration::from_secs(30), job) <= MAX_HOLD);
        let holds: std::collections::HashSet<_> =
            (0..32).map(|_| retry_hold(wait, Uuid::new_v4())).collect();
        assert!(
            holds.len() > 1,
            "lanes that failed together come back apart"
        );
    }

    #[test]
    fn the_retry_prompt_keeps_the_agents_prompt_and_says_so_once() {
        let first = rate_limit_retry_prompt("Research Tokyo.");
        assert!(first.starts_with("Research Tokyo."));
        assert!(first.contains("short provider rate limit"));
        assert_eq!(
            rate_limit_retry_prompt(&first)
                .matches(RETRY_MARKER)
                .count(),
            1
        );
    }

    fn worker(handle: &str, status: &str, error: Option<&str>) -> SiblingJobSnapshot {
        SiblingJobSnapshot {
            id: Uuid::new_v4(),
            status: status.into(),
            outcome: None,
            summary: None,
            error_message: error.map(str::to_string),
            handle: Some(handle.into()),
            scope_summary: None,
            lease_metrics: None,
            paths: Vec::new(),
            initial_evidence_gaps: None,
            last_message: None,
            acting_tool_count: 0,
            retried_as: None,
            rerun_of: None,
            unfinished_note: None,
        }
    }

    #[test]
    fn a_lane_is_retried_at_most_once() {
        let failed = worker("tokyo", "failed", Some(EVIDENCE));
        let other = worker("kyoto", "leased", None);
        let workers = vec![failed.clone(), other.clone()];
        assert_eq!(
            rate_limit_retry_wait(failed.id, &workers),
            Some(Duration::from_millis(7_632))
        );
        assert_eq!(
            rate_limit_retry_wait(other.id, &workers),
            None,
            "not failed"
        );

        // its retry failed the same way: no third run
        let mut retry = worker("@Tokyo", "failed", Some(EVIDENCE));
        retry.rerun_of = Some((failed.id, RerunReason::RateLimit));
        let mut first = failed.clone();
        first.retried_as = Some((retry.id, RerunReason::RateLimit));
        let workers = vec![first.clone(), other.clone(), retry.clone()];
        assert_eq!(rate_limit_retry_wait(retry.id, &workers), None);
        assert_eq!(
            rate_limit_retry_wait(first.id, &workers),
            None,
            "a repeated completion"
        );

        // a lane the lead already re-planned after an earlier failure is not run a third time
        let earlier = worker("osaka", "failed", Some("unexpected status 502 Bad Gateway"));
        let second = worker("osaka", "failed", Some(EVIDENCE));
        assert_eq!(
            rate_limit_retry_wait(second.id, &[earlier, second.clone()]),
            None
        );
    }

    #[test]
    fn the_retry_runs_only_its_lane_with_the_plans_lead() {
        let payload = json!({
            "metadata": {"agent": {"handle": "kyoto"}},
            "plan_seed": {
                "type": "multi_agent_plan", "mode": "read_only",
                "lanes": [
                    {"handle": "tokyo", "prompt": "Research Tokyo."},
                    {"handle": "kyoto", "prompt": "Research Kyoto.", "scopeSummary": "Kyoto"},
                ],
                "lead": {"leadHandle": "octo", "continuationPrompt": "Report.", "expectedReportFormat": "text"},
                "runtimeRouting": {"strategy": "spread"},
            },
        });
        let agent = plan_job_agent(&payload).expect("the lane");
        assert_eq!(agent.prompt, "Research Kyoto.");
        let seed = super::super::turn_continuation::redispatch_seed(
            &payload["plan_seed"],
            &agent,
            &rate_limit_retry_prompt(&agent.prompt),
            "retried",
        );
        let plan = parse_skill_multi_agent_plan(&seed).expect("a valid plan");
        assert_eq!(plan.agents.len(), 1);
        assert_eq!(plan.agents[0].handle, "kyoto");
        assert!(plan.agents[0].prompt.contains("short provider rate limit"));
        assert_eq!(plan.lead.lead_handle, "octo");
        assert_eq!(seed["runtimeRouting"]["strategy"], "reuse");
        assert!(plan_job_agent(
            &json!({"metadata": {"agent": {"handle": "nara"}}, "plan_seed": payload["plan_seed"]})
        )
        .is_none());
    }

    #[test]
    fn a_run_that_acted_before_the_rate_limit_is_not_started_again() {
        // A replay could repeat what its commands, MCP tools or file changes did.
        let mut acted = worker("tokyo", "failed", Some(EVIDENCE));
        acted.acting_tool_count = 1;
        assert_eq!(rate_limit_retry_wait(acted.id, &[acted.clone()]), None);
        acted.acting_tool_count = 0;
        assert!(rate_limit_retry_wait(acted.id, &[acted.clone()]).is_some());
    }

    #[test]
    fn the_lead_reads_a_retried_lane_as_superseded() {
        let mut failed = worker("tokyo", "failed", Some(EVIDENCE));
        let mut retry = worker("tokyo", "completed", None);
        retry.summary = Some("Saved Tokyo lodging.".into());
        retry.rerun_of = Some((failed.id, RerunReason::RateLimit));
        failed.retried_as = Some((retry.id, RerunReason::RateLimit));
        let workers = vec![failed.clone(), retry.clone()];
        let note = format!("the controller ran it again as job={}", retry.id);
        let lead = super::super::SkillMultiAgentLead {
            lead_handle: "octo".into(),
            continuation_prompt: "Report.".into(),
            expected_report_format: "text".into(),
        };
        let final_prompt = super::super::build_lead_continuation_prompt("g", &workers, &lead, &[]);
        assert_eq!(final_prompt.matches(&note).count(), 1, "{final_prompt}");
        let early = super::super::build_lead_early_checkpoint_prompt("g", &workers, &lead, &[]);
        assert_eq!(early.matches(&note).count(), 1, "{early}");
        assert_eq!(
            super::super::sibling_snapshot_to_json(&failed)["retriedAs"],
            json!(retry.id.to_string())
        );
    }
}
