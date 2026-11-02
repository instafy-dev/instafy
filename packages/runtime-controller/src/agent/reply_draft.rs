//! Ephemeral conversation replies. The durable completion remains authoritative.
use super::*;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_REPLY_DRAFT_BYTES: usize = 128 * 1024;
const MIN_PUBLISH_GAP: Duration = Duration::from_millis(100);
static LAST_PUBLISHED: Lazy<Mutex<HashMap<Uuid, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Deserialize)]
pub(crate) struct AgentReplyDraftPayload {
    job_id: Uuid,
    lease_attempt: i32,
    segment: u64,
    seq: u64,
    text: String,
}

fn claim_publish_slot(job_id: Uuid) -> bool {
    let Ok(mut entries) = LAST_PUBLISHED.lock() else {
        return false;
    };
    let now = Instant::now();
    if entries
        .get(&job_id)
        .is_some_and(|last| now.duration_since(*last) < MIN_PUBLISH_GAP)
    {
        return false;
    }
    if entries.len() >= 1024 {
        entries.retain(|_, last| now.duration_since(*last) < Duration::from_secs(60));
        if entries.len() >= 1024 {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, last)| **last)
                .map(|(id, _)| *id)
            {
                entries.remove(&oldest);
            }
        }
    }
    entries.insert(job_id, now);
    true
}

#[instrument(skip(state, headers, payload))]
pub(crate) async fn agent_reply_draft(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<AgentReplyDraftPayload>,
) -> Result<Json<AgentMessageResponseBody>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.message"])?;
    let AgentReplyDraftPayload {
        job_id,
        lease_attempt,
        segment,
        seq,
        text,
    } = payload;
    if text.len() > MAX_REPLY_DRAFT_BYTES
        || segment > 9_007_199_254_740_991
        || seq > 9_007_199_254_740_991
    {
        return Err(bad_request(
            "reply draft exceeds its display or sequence bound",
        ));
    }
    // This new route never supported an unbound project token: every draft
    // must belong to the exact machine holding the current job lease.
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent token missing runtime scope"))?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    ensure_agent_token_matches_runtime_lease_for_job(&state, &transaction, &claims, &runtime_id)
        .await?;
    // Same row lock as completion/cancellation: no cached authorization may keep
    // publishing after the job stopped. Holding it through publish orders the draft
    // before a terminal event, even if the user stops concurrently.
    let row = transaction
        .query_opt(
            "select run_id, session_id, conversation_id, payload, lease_attempts, lease_expires_at
         from agent_jobs where id = $1 and project_id = $2 and status = 'leased'
           and lease_attempts = $4
           and leased_by_runtime_id = $3
         for update",
            &[&job_id, &claims.project_id, &runtime_id, &lease_attempt],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load agent job: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("agent job not found or not leased"));
    };
    // Transaction/statement time was captured before a contended row lock. Read
    // the database clock after acquiring it so a lease that expired while waiting
    // cannot authorize a draft.
    let now: DateTime<Utc> = transaction
        .query_one("select clock_timestamp()", &[])
        .await
        .map_err(|error| internal_error(format!("failed to check job lease: {error}")))?
        .get(0);
    let expiry: Option<DateTime<Utc>> = row.get("lease_expires_at");
    if expiry.is_none_or(|expiry| expiry <= now) {
        return Err(not_found("agent job lease expired"));
    }
    let job_payload: JsonValue = row.get::<_, PgJson<JsonValue>>("payload").0;
    let payload_id = |name: &str| {
        job_payload
            .get(name)
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::from_str(value).ok())
    };
    let conversation_id = row
        .get::<_, Option<Uuid>>("conversation_id")
        .or_else(|| payload_id("conversation_id"))
        .ok_or_else(|| bad_request("agent job is not associated with a conversation"))?;
    let session_id = row
        .get::<_, Option<Uuid>>("session_id")
        .or_else(|| payload_id("session_id"));
    let run_id: Option<Uuid> = row.get("run_id");
    let role = job_payload
        .pointer("/metadata/multiAgentPlan/role")
        .or_else(|| job_payload.pointer("/metadata/multi_agent_plan/role"))
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if role.trim().eq_ignore_ascii_case("worker")
        || crate::conversations::is_internal_conversation(&transaction, &conversation_id).await?
    {
        return Err(forbidden(
            "internal worker conversations take no reply drafts",
        ));
    }
    // An ambient evaluation is silent and free until durable speech commits its
    // participation/billing decision. A speculative draft must not bypass it.
    if (crate::group_participation::job_payload_marks_agent_evaluation(&job_payload)
        || crate::group_participation::job_payload_marks_agent_declined(&job_payload))
        && !run_has_visible_assistant_message(&transaction, &claims.project_id, run_id).await?
    {
        return Ok(Json(AgentMessageResponseBody { ok: true }));
    }
    if claim_publish_slot(job_id) {
        publish_controller_event_with_conversation(
            &state.events,
            crate::state::REPLY_DRAFT_EVENT,
            Some(claims.project_id),
            session_id,
            Some(conversation_id),
            run_id,
            Some(job_id),
            json!({ "jobId": job_id, "runId": run_id, "conversationId": conversation_id,
                "attempt": row.get::<_, i32>("lease_attempts"), "segment": segment, "seq": seq, "text": text }),
        );
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finish draft check: {error}")))?;
    Ok(Json(AgentMessageResponseBody { ok: true }))
}
