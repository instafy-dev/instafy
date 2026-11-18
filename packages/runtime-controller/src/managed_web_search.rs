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
//!   it answers; nor past the message's limit.
//! - `POST /internal/managed-web-search/give-back`: searches the proxy was let run and that did
//!   not search go back to the message.
//! - `POST /agent/jobs/:job_id/deeper-research`: the runtime that holds a job's lease says its
//!   routing step read the person's own words as asking for deeper research.

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

use crate::research_budget::{change_web_searches, WebSearches};
use crate::typed_sql::typed;
use crate::{bad_request, internal_error, unauthorized, ApiError, AppState};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

/// The most searches one claim asks for: the search bridge's limit per request
/// (openai-proxy-server `search_bridge::MAX_QUERIES`).
const MAX_SEARCHES_PER_CLAIM: u32 = 4;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/internal/managed-web-search/claim", post(claim))
        .route("/internal/managed-web-search/give-back", post(give_back))
        .route("/agent/jobs/:job_id/deeper-research", post(deeper_research))
}

/// A managed job's searches, as the proxy read them from the job's verified token.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Searches {
    project_id: Uuid,
    job_id: Uuid,
    lease_attempt: i32,
    run_id: Uuid,
    searches: u32,
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

/// Takes up to `asked` of the message's searches.
fn take(count: &mut WebSearches, asked: u32) -> Claimed {
    let limit = limit(count);
    let granted = asked.min(limit.saturating_sub(count.used));
    count.used += granted;
    Claimed {
        granted,
        limit,
        refused: (granted < asked).then_some(Refusal::Used),
    }
}

/// Gives back `searches` the proxy was let run and that did not search.
fn give(count: &mut WebSearches, searches: u32) {
    count.used = count.used.saturating_sub(searches);
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
    Json(request): Json<Searches>,
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
    let claimed = change_web_searches(&tx, request.project_id, counted_with, |count| {
        take(count, request.searches)
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

async fn give_back(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<Searches>,
) -> ApiResult<StatusCode> {
    crate::credentials::require_proxy_credential_lease_token(&state.config, &headers)?;
    if !(1..=MAX_SEARCHES_PER_CLAIM).contains(&request.searches) {
        return Err(bad_request("searches must be between 1 and 4"));
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
    // A job that has ended since keeps nothing to give back to.
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
    change_web_searches(&tx, request.project_id, counted_with, |count| {
        give(count, request.searches)
    })
    .await?;
    tx.commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit web searches: {error}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeeperResearch {
    lease_attempt: i32,
}

async fn deeper_research(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(job_id): AxumPath<Uuid>,
    Json(request): Json<DeeperResearch>,
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
        count.deeper_research = true;
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

    /// A message's searches are counted once for all its jobs: two jobs that share its budget
    /// get two in all, the third is refused, and what a search did not use goes back. Deeper
    /// research raises the message's limit to eight.
    #[test]
    fn a_message_runs_its_searches_once_whichever_job_asks() {
        let mut message = WebSearches::default();
        // The lead's turn asks for one, a worker for two: one is left for the worker.
        assert_eq!(
            take(&mut message, 1),
            Claimed {
                granted: 1,
                limit: 2,
                refused: None
            }
        );
        assert_eq!(
            take(&mut message, 2),
            Claimed {
                granted: 1,
                limit: 2,
                refused: Some(Refusal::Used)
            }
        );
        assert_eq!(take(&mut message, 1).granted, 0, "a third search");
        // The worker's search failed: it goes back, and the next one may run.
        give(&mut message, 1);
        assert_eq!(take(&mut message, 1).granted, 1);
        give(&mut message, 9);
        assert_eq!(message.used, 0, "never below none");

        let mut deeper = WebSearches {
            used: 2,
            deeper_research: true,
        };
        assert_eq!(
            take(&mut deeper, 4),
            Claimed {
                granted: 4,
                limit: 8,
                refused: None
            }
        );
        assert_eq!(take(&mut deeper, 4).granted, 2);
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
        let count = WebSearches {
            used: 1,
            deeper_research: true,
        };
        assert_eq!(
            serde_json::to_value(count).unwrap(),
            json!({"used": 1, "deeperResearch": true})
        );
        assert_eq!(
            serde_json::from_value::<WebSearches>(json!({})).unwrap(),
            WebSearches::default()
        );
    }
}
