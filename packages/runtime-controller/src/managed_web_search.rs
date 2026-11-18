//! Instafy AI's web searches, counted per message, and the check the proxy makes before each one.
//!
//! Each search costs the person credits (`docs/Credits-Billing.md`, "Web search for Instafy AI"),
//! so a message runs at most [`MANAGED_WEB_SEARCHES_PER_MESSAGE`] of them, or
//! [`MANAGED_WEB_SEARCHES_FOR_DEEPER_RESEARCH`] when its routing step read the person's own words
//! as asking for deeper research, in total across its turns. The count is kept with the message's
//! task budget ([`crate::research_budget::change_web_searches`]), which the jobs of a team plan and
//! of a message to several agents share; a build Instafy starts after the browser (a hand-back)
//! counts with the turn whose card it carries on.
//!
//! - `POST /internal/managed-web-search/claim`: the proxy, with its credential-lease bearer, asks
//!   before a managed job's searches run, and runs only as many as the answer grants. None is
//!   granted while `MANAGED_AI_NATIVE_WEB_SEARCH` is off, so turning it off refuses the next
//!   search on every machine while the jobs running there go on; nor for a job that no longer
//!   holds its lease; nor for a background check that may decline (an ambient evaluation) before
//!   it answers; nor past the message's limit. Each check has the proxy's id, so the same check
//!   asked again takes nothing more.
//! - `POST /internal/managed-web-search/settle`: the proxy says how many of a check's searches
//!   ran, and the rest go back to the message. A check whose answer the proxy never read (it
//!   timed out) is settled with none, so it takes nothing even if it lands afterwards.
//! - `POST /agent/jobs/:job_id/web-searches`: the runtime that holds a job's lease says its
//!   routing step read the person's own words as asking for deeper research (`deeper_research`),
//!   or that this lease attempt starts over (`starts_over`). A job put back in the queue (its
//!   machine stopped, its lease lapsed, or a short rate limit) runs again as a new lease attempt.
//!   A runtime that ran the attempt before goes on with that attempt's searches, and its
//!   completion reports them. Any other runtime holds none of them, and no completion charged
//!   them, so it says the attempt starts over, and they go back to the message.

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use runtime_contracts::research::{
    MANAGED_WEB_SEARCHES_FOR_DEEPER_RESEARCH, MANAGED_WEB_SEARCHES_PER_MESSAGE,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::research_budget::{change_web_searches, ClaimedSearches, WebSearches};
use crate::typed_sql::typed;
use crate::{bad_request, internal_error, unauthorized, ApiError, AppState};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

/// The most searches one claim asks for: the search bridge's limit per request
/// (openai-proxy-server `search_bridge::MAX_QUERIES`).
const MAX_SEARCHES_PER_CLAIM: u32 = 4;
/// The most checks a message keeps. Its searches are at most
/// [`MANAGED_WEB_SEARCHES_FOR_DEEPER_RESEARCH`], so only checks that hold none are ever dropped,
/// oldest first.
const MAX_KEPT_CLAIMS: usize = 32;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/internal/managed-web-search/claim", post(claim))
        .route("/internal/managed-web-search/settle", post(settle))
        .route("/agent/jobs/:job_id/web-searches", post(web_searches))
}

/// The proxy's check before a managed job's searches: the job, as the proxy read it from the
/// job's verified token, the check's id, and how many searches it asks to run.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    project_id: Uuid,
    job_id: Uuid,
    lease_attempt: i32,
    run_id: Uuid,
    claim_id: Uuid,
    searches: u32,
}

/// How many of a check's searches ran, from the proxy.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settle {
    project_id: Uuid,
    job_id: Uuid,
    lease_attempt: i32,
    run_id: Uuid,
    claim_id: Uuid,
    ran: u32,
}

/// Why fewer searches may run than the proxy asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Refusal {
    /// `MANAGED_AI_NATIVE_WEB_SEARCH` is off.
    Off,
    /// The job no longer holds its lease, or is not an Instafy AI job.
    Ended,
    /// A background check that may decline, which has not answered yet.
    Undecided,
    /// The message has used its searches.
    Used,
}

/// The answer to a claim: how many of the asked searches may run, the message's limit, and why
/// fewer may run, when they may.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Claimed {
    granted: u32,
    limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    refused: Option<Refusal>,
}

impl Claimed {
    fn refused(refusal: Refusal) -> Self {
        Self {
            granted: 0,
            limit: MANAGED_WEB_SEARCHES_PER_MESSAGE,
            refused: Some(refusal),
        }
    }
}

/// The message's limit.
fn limit(count: &WebSearches) -> u32 {
    if count.deeper_research {
        MANAGED_WEB_SEARCHES_FOR_DEEPER_RESEARCH
    } else {
        MANAGED_WEB_SEARCHES_PER_MESSAGE
    }
}

/// Takes up to `asked` of the message's searches for the check `claim` (its id, its job and
/// lease attempt). The same check again takes nothing more.
fn take(count: &mut WebSearches, claim: ClaimedSearches, asked: u32) -> Claimed {
    let limit = limit(count);
    if let Some(kept) = count.claims.iter().find(|kept| kept.id == claim.id) {
        return Claimed {
            granted: kept.searches.min(asked),
            limit,
            refused: (kept.searches < asked).then_some(Refusal::Used),
        };
    }
    let granted = asked.min(limit.saturating_sub(count.used()));
    if granted > 0 {
        keep(
            count,
            ClaimedSearches {
                searches: granted,
                ..claim
            },
        );
    }
    Claimed {
        granted,
        limit,
        refused: (granted < asked).then_some(Refusal::Used),
    }
}

/// Settles the check `claim`: `ran` of its searches ran, and the rest go back. Settling it again
/// changes nothing more. A check with no record (the proxy gave up on its answer, which may still
/// land) is kept as one that took nothing, so it takes nothing if it lands afterwards.
fn settle_claim(count: &mut WebSearches, claim: ClaimedSearches, ran: u32) {
    match count.claims.iter().position(|kept| kept.id == claim.id) {
        Some(index) => {
            let kept = &mut count.claims[index];
            kept.searches = kept.searches.min(ran);
        }
        None => keep(
            count,
            ClaimedSearches {
                searches: 0,
                ..claim
            },
        ),
    }
}

/// Gives back to the message the searches of `job_id`'s lease attempts before `lease_attempt`,
/// which starts over on a runtime that holds none of them. No completion charged them: a
/// completion that charges ends the job, and a requeue charges nothing.
fn start_over(count: &mut WebSearches, job_id: Uuid, lease_attempt: i32) {
    count
        .claims
        .retain(|kept| kept.job_id != job_id || kept.lease_attempt >= lease_attempt);
}

/// Keeps `claim`, dropping the oldest checks that hold no search past [`MAX_KEPT_CLAIMS`].
fn keep(count: &mut WebSearches, claim: ClaimedSearches) {
    count.claims.push(claim);
    while count.claims.len() > MAX_KEPT_CLAIMS {
        let Some(oldest) = count.claims.iter().position(|kept| kept.searches == 0) else {
            break;
        };
        count.claims.remove(oldest);
    }
}

fn metadata_flag(payload: &JsonValue, key: &str) -> bool {
    payload
        .get("metadata")
        .and_then(|metadata| metadata.get(key))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
}

/// A background check that may decline (an ambient evaluation, charged only once it answers)
/// that has not answered yet. Dispatch stamps the deferral only on such a check
/// (`dispatch.rs`), and its first reply marks it used (`agent.rs`,
/// `apply_deferred_managed_ai_billing_on_first_visible_message`). A stamp nobody should have
/// written only refuses searches.
fn has_not_answered(payload: &JsonValue) -> bool {
    metadata_flag(payload, "managedAiBillingDeferred") && !metadata_flag(payload, "managedAiUsed")
}

/// The job a verified hand-back carries on (its record's `cardJobId`), whose message it builds.
fn card_job_of_hand_back(payload: &JsonValue) -> Option<Uuid> {
    payload
        .pointer("/metadata/browserHandBack")
        .filter(|record| record.get("verified") == Some(&JsonValue::Bool(true)))
        .and_then(|record| record.get("cardJobId"))
        .and_then(JsonValue::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
}

/// A managed job that holds its lease: its payload, else None. The lease is the one its token
/// names, on its run, with no credential of its own (Instafy AI), for an intent that runs the AI.
async fn leased_managed_job(
    tx: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    lease_attempt: i32,
) -> ApiResult<Option<JsonValue>> {
    let row = tx
        .query_typed_opt(
            "select payload, intent
               from agent_jobs
              where id = $1 and project_id = $2 and lease_attempts = $3
                and status = 'leased' and lease_expires_at > clock_timestamp()
                and credential_id is null and run_id is not null and engine is null
                and ($4::uuid is null or run_id = $4)
                and ($5::uuid is null or leased_by_runtime_id = $5)",
            typed![job_id, project_id, &lease_attempt, &run_id, &runtime_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to read the searching job: {error}")))?;
    Ok(row.and_then(|row| {
        let intent: Option<String> = row.get("intent");
        crate::dispatch::dispatch_requires_ai_access(intent.as_deref().unwrap_or_default())
            .then(|| row.get::<_, JsonValue>("payload"))
    }))
}

/// The job whose task budget counts `job_id`'s searches: for a hand-back, the job whose card it
/// carries on, when that job is in the same space; else the job itself.
async fn counting_job(
    tx: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    payload: &JsonValue,
) -> ApiResult<Uuid> {
    let Some(card_job) = card_job_of_hand_back(payload).filter(|card| card != job_id) else {
        return Ok(*job_id);
    };
    let same_space = tx
        .query_typed_opt(
            "select 1 from agent_jobs where id = $1 and project_id = $2",
            typed![&card_job, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to read the card's job: {error}")))?
        .is_some();
    Ok(if same_space { card_job } else { *job_id })
}

async fn claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<Claim>,
) -> ApiResult<Json<Claimed>> {
    crate::credentials::require_proxy_credential_lease_token(&state.config, &headers)?;
    if !(1..=MAX_SEARCHES_PER_CLAIM).contains(&request.searches) {
        return Err(bad_request("searches must be between 1 and 4"));
    }
    // The one live switch: read here on every search, not only when a job's grant is minted.
    if !state.config.managed_ai_native_web_search {
        return Ok(Json(Claimed::refused(Refusal::Off)));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let tx = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let Some(payload) = leased_managed_job(
        &tx,
        &request.project_id,
        &request.job_id,
        Some(&request.run_id),
        None,
        request.lease_attempt,
    )
    .await?
    else {
        return Ok(Json(Claimed::refused(Refusal::Ended)));
    };
    if has_not_answered(&payload) {
        return Ok(Json(Claimed::refused(Refusal::Undecided)));
    }
    let counted_with = counting_job(&tx, &request.project_id, &request.job_id, &payload).await?;
    let check = ClaimedSearches {
        id: request.claim_id,
        job_id: request.job_id,
        lease_attempt: request.lease_attempt,
        searches: 0,
    };
    let claimed = change_web_searches(&tx, request.project_id, counted_with, |count| {
        take(count, check, request.searches)
    })
    .await?;
    tx.commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit web searches: {error}")))?;
    tracing::info!(
        job_id = %request.job_id,
        asked = request.searches,
        granted = claimed.granted,
        limit = claimed.limit,
        "managed web search claim"
    );
    Ok(Json(claimed))
}

async fn settle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<Settle>,
) -> ApiResult<StatusCode> {
    crate::credentials::require_proxy_credential_lease_token(&state.config, &headers)?;
    if request.ran > MAX_SEARCHES_PER_CLAIM {
        return Err(bad_request("ran must be between 0 and 4"));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let tx = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    // A job whose lease has ended since keeps nothing to settle: its next attempt, if any, gives
    // back what this one took.
    let Some(payload) = leased_managed_job(
        &tx,
        &request.project_id,
        &request.job_id,
        Some(&request.run_id),
        None,
        request.lease_attempt,
    )
    .await?
    else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let counted_with = counting_job(&tx, &request.project_id, &request.job_id, &payload).await?;
    let check = ClaimedSearches {
        id: request.claim_id,
        job_id: request.job_id,
        lease_attempt: request.lease_attempt,
        searches: 0,
    };
    change_web_searches(&tx, request.project_id, counted_with, |count| {
        settle_claim(count, check, request.ran)
    })
    .await?;
    tx.commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit web searches: {error}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// What a lease attempt of a job changes about its message's web searches, from the runtime
/// that holds the lease.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WebSearchReport {
    lease_attempt: i32,
    /// The routing step read the person's own words as asking for deeper research.
    #[serde(default)]
    deeper_research: bool,
    /// The attempt holds none of an earlier attempt's searches.
    #[serde(default)]
    starts_over: bool,
}

async fn web_searches(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(job_id): AxumPath<Uuid>,
    Json(request): Json<WebSearchReport>,
) -> ApiResult<StatusCode> {
    let token = crate::agent::extract_agent_token(&headers)?;
    let claims =
        crate::agent::verify_agent_token_with_scopes(&state.config, token, &["agent.lease"])?;
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent token missing runtime scope"))?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let tx = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let Some(payload) = leased_managed_job(
        &tx,
        &claims.project_id,
        &job_id,
        None,
        Some(&runtime_id),
        request.lease_attempt,
    )
    .await?
    else {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("agent job lease is no longer active")),
        ));
    };
    let counted_with = counting_job(&tx, &claims.project_id, &job_id, &payload).await?;
    change_web_searches(&tx, claims.project_id, counted_with, |count| {
        if request.deeper_research {
            count.deeper_research = true;
        }
        if request.starts_over {
            start_over(count, job_id, request.lease_attempt);
        }
    })
    .await?;
    tx.commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit web searches: {error}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A check of `job_id`'s lease attempt `lease_attempt`.
    fn check(job_id: Uuid, lease_attempt: i32) -> ClaimedSearches {
        ClaimedSearches {
            id: Uuid::new_v4(),
            job_id,
            lease_attempt,
            searches: 0,
        }
    }

    /// A message's searches are counted once for all its jobs: two jobs that share its budget
    /// get two in all, the third is refused, and what a search did not run goes back. Deeper
    /// research raises the message's limit to eight.
    #[test]
    fn a_message_runs_its_searches_once_whichever_job_asks() {
        let (lead, worker) = (Uuid::new_v4(), Uuid::new_v4());
        let mut message = WebSearches::default();
        // The lead's turn asks for one, a worker for two: one is left for the worker.
        assert_eq!(
            take(&mut message, check(lead, 1), 1),
            Claimed {
                granted: 1,
                limit: 2,
                refused: None
            }
        );
        let workers = check(worker, 1);
        assert_eq!(
            take(&mut message, workers, 2),
            Claimed {
                granted: 1,
                limit: 2,
                refused: Some(Refusal::Used)
            }
        );
        assert_eq!(
            take(&mut message, check(lead, 1), 1).granted,
            0,
            "a third search"
        );
        // The worker's search failed: it goes back, and the next one may run.
        settle_claim(&mut message, workers, 0);
        assert_eq!(message.used(), 1);
        assert_eq!(take(&mut message, check(lead, 1), 1).granted, 1);
        // A check that ran what it took keeps it.
        settle_claim(&mut message, workers, 4);
        assert_eq!(message.used(), 2);

        let mut deeper = WebSearches {
            deeper_research: true,
            ..message
        };
        assert_eq!(
            take(&mut deeper, check(lead, 1), 4),
            Claimed {
                granted: 4,
                limit: 8,
                refused: None
            }
        );
        assert_eq!(take(&mut deeper, check(worker, 1), 4).granted, 2);
    }

    /// A job put back in the queue runs again as a new lease attempt. On the runtime that ran
    /// the attempt before, it goes on with that attempt's searches, which its completion
    /// reports: they still count. On any other, it starts over: no completion charged the
    /// earlier attempt's searches, so they go back, and it may search again. Another job's
    /// searches, and the new attempt's own, still count.
    #[test]
    fn a_later_lease_attempt_that_starts_over_gets_back_what_its_earlier_attempt_took() {
        let (lead, worker) = (Uuid::new_v4(), Uuid::new_v4());
        let mut message = WebSearches::default();
        assert_eq!(take(&mut message, check(lead, 1), 2).granted, 2);
        assert_eq!(take(&mut message, check(worker, 1), 1).granted, 0);
        // It runs again where it ran before: the searches it ran there still count.
        let mut ran_here = message.clone();
        assert_eq!(take(&mut ran_here, check(lead, 2), 1).granted, 0);
        assert_eq!(ran_here.used(), 2);
        // It runs again elsewhere, and starts over.
        start_over(&mut message, lead, 2);
        assert_eq!(
            take(&mut message, check(lead, 2), 1),
            Claimed {
                granted: 1,
                limit: 2,
                refused: None
            }
        );
        assert_eq!(take(&mut message, check(worker, 1), 2).granted, 1);
        assert_eq!(
            take(&mut message, check(lead, 2), 1).granted,
            0,
            "the message's two"
        );
        // Starting over again changes nothing of the attempt's own, or of another job's.
        start_over(&mut message, lead, 2);
        start_over(&mut message, worker, 1);
        assert_eq!(message.used(), 2);
    }

    /// A check whose answer the proxy never read (it timed out, or the answer was lost) is
    /// settled with none: what it took goes back, and if it lands only afterwards it takes
    /// nothing. The same check asked or settled again changes nothing more.
    #[test]
    fn a_check_the_proxy_gave_up_on_takes_nothing() {
        let job = Uuid::new_v4();
        let mut message = WebSearches::default();
        // Its answer came too late: the proxy settles it with none.
        let late = check(job, 1);
        assert_eq!(take(&mut message, late, 2).granted, 2);
        settle_claim(&mut message, late, 0);
        assert_eq!(message.used(), 0);
        settle_claim(&mut message, late, 0);
        assert_eq!(
            take(&mut message, late, 2).granted,
            0,
            "the same check again"
        );
        assert_eq!(message.used(), 0);
        // It landed only after the proxy settled it.
        let landed_after = check(job, 1);
        settle_claim(&mut message, landed_after, 0);
        assert_eq!(
            take(&mut message, landed_after, 2),
            Claimed {
                granted: 0,
                limit: 2,
                refused: Some(Refusal::Used)
            }
        );
        // The message keeps its two for the next check.
        assert_eq!(take(&mut message, check(job, 1), 2).granted, 2);
        // A check that took searches is never dropped to make room.
        for _ in 0..(2 * MAX_KEPT_CLAIMS) {
            settle_claim(&mut message, check(job, 1), 0);
        }
        assert_eq!(message.claims.len(), MAX_KEPT_CLAIMS);
        assert_eq!(message.used(), 2);
    }

    /// A refused claim names why, in the words the proxy reads.
    #[test]
    fn a_refusal_names_why() {
        for (refusal, word) in [
            (Refusal::Off, "off"),
            (Refusal::Ended, "ended"),
            (Refusal::Undecided, "undecided"),
            (Refusal::Used, "used"),
        ] {
            assert_eq!(
                serde_json::to_value(Claimed::refused(refusal)).unwrap(),
                json!({"granted": 0, "limit": 2, "refused": word})
            );
        }
        assert_eq!(
            serde_json::to_value(Claimed {
                granted: 1,
                limit: 2,
                refused: None
            })
            .unwrap(),
            json!({"granted": 1, "limit": 2})
        );
    }

    /// A background check that may decline searches only once it has answered; any other job,
    /// and an automation's normally charged check, is not held back.
    #[test]
    fn an_ambient_check_searches_only_once_it_has_answered() {
        let deferred = json!({"metadata": {"managedAiBillingDeferred": true}});
        assert!(has_not_answered(&deferred));
        let answered =
            json!({"metadata": {"managedAiBillingDeferred": true, "managedAiUsed": true}});
        assert!(!has_not_answered(&answered));
        for other in [
            json!({"metadata": {"managedAiUsed": true}}),
            json!({"metadata": {"managedAiBillingDeferred": false}}),
            json!({}),
        ] {
            assert!(!has_not_answered(&other), "{other}");
        }
    }

    /// A verified hand-back counts with the job whose card it carries on; an unverified record,
    /// or none, counts with the job itself.
    #[test]
    fn a_hand_back_counts_with_its_cards_job() {
        let card = Uuid::new_v4();
        assert_eq!(
            card_job_of_hand_back(&json!({"metadata": {"browserHandBack": {
                "verified": true, "cardJobId": card.to_string()}}})),
            Some(card)
        );
        for not_verified in [
            json!({"metadata": {"browserHandBack": {"cardJobId": card.to_string()}}}),
            json!({"metadata": {"browserHandBack": {"verified": "true", "cardJobId": card.to_string()}}}),
            json!({"metadata": {"browserHandBack": {"verified": true, "cardJobId": "not-a-job"}}}),
            json!({"metadata": {}}),
        ] {
            assert_eq!(card_job_of_hand_back(&not_verified), None, "{not_verified}");
        }
    }

    /// The stored count keeps the page-load state it sits beside, and a task that never
    /// searched stores nothing new.
    #[test]
    fn the_count_round_trips_with_the_task_budget() {
        let (id, job_id) = (Uuid::new_v4(), Uuid::new_v4());
        let count = WebSearches {
            deeper_research: true,
            claims: vec![ClaimedSearches {
                id,
                job_id,
                lease_attempt: 1,
                searches: 1,
            }],
        };
        let stored = json!({"deeperResearch": true, "claims": [
            {"id": id, "jobId": job_id, "leaseAttempt": 1, "searches": 1}]});
        assert_eq!(serde_json::to_value(&count).unwrap(), stored);
        assert_eq!(
            serde_json::from_value::<WebSearches>(stored).unwrap(),
            count
        );
        assert_eq!(
            serde_json::to_value(WebSearches::default()).unwrap(),
            json!({"deeperResearch": false})
        );
        assert_eq!(
            serde_json::from_value::<WebSearches>(json!({})).unwrap(),
            WebSearches::default()
        );
    }
}
