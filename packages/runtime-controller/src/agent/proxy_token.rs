//! Renew an existing job's proxy capability without extending its execution lease.

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RenewalRequest {
    lease_attempt: i32,
}

pub(super) async fn renew(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(job_id): AxumPath<Uuid>,
    Json(request): Json<RenewalRequest>,
) -> Result<Json<runtime_contracts::ProxyEnvelopePayload>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.lease"])?;
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
    // Runtime then job, as in heartbeat and stop. A draining runtime can finish
    // its existing work, but a retired generation cannot obtain a new grant.
    ensure_runtime_can_heartbeat(
        &state,
        &transaction,
        &claims.project_id,
        &runtime_id,
        claims.lease_id,
        claims.runtime_generation,
    )
    .await?;
    let row = transaction
        .query_opt(
            "select project_id, run_id, credential_id, payload, lease_expires_at, intent
         from agent_jobs
         where id = $1 and project_id = $2 and status = 'leased'
           and leased_by_runtime_id = $3 and lease_attempts = $4
         for update",
            &[
                &job_id,
                &claims.project_id,
                &runtime_id,
                &request.lease_attempt,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to validate proxy job lease: {error}")))?
        .ok_or_else(inactive_lease)?;
    // Use the database clock *after* acquiring the row: transaction/statement
    // start time could admit a lease that expired while this request waited.
    let now: DateTime<Utc> = transaction
        .query_one("select clock_timestamp()", &[])
        .await
        .map_err(|error| internal_error(format!("failed to read lease clock: {error}")))?
        .get(0);
    if row
        .get::<_, Option<DateTime<Utc>>>("lease_expires_at")
        .is_none_or(|expiry| expiry <= now)
    {
        return Err(inactive_lease());
    }
    let project_id: Uuid = row.get("project_id");
    let run_id: Option<Uuid> = row.get("run_id");
    let credential_id: Option<Uuid> = row.get("credential_id");
    let payload: JsonValue = row.get("payload");
    let (handle, name, description) = extract_agent_prompt_identity_from_job_payload(&payload);
    let proxy = issue_proxy_envelope(
        &state.config,
        &project_id,
        &runtime_id,
        run_id.as_ref(),
        credential_id.as_ref(),
        Some(ProxyJobBinding {
            job_id,
            lease_attempt: request.lease_attempt,
        }),
        handle.as_deref(),
        name.as_deref(),
        description.as_deref(),
    )
    .ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("job proxy token is unavailable")),
        )
    })?;
    let intent: Option<String> = row.get("intent");
    if credential_id.is_none()
        && crate::dispatch::dispatch_requires_ai_access(intent.as_deref().unwrap_or_default())
    {
        crate::ai_metering::job_record::bind_renewed_job_token(
            &transaction,
            &job_id,
            request.lease_attempt,
            &proxy.token,
        )
        .await?;
    }
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit proxy token renewal: {error}"))
    })?;
    tracing::info!(%job_id, lease_attempt = request.lease_attempt, "renewed job-scoped proxy grant");
    Ok(Json(proxy))
}

fn inactive_lease() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::new("agent job lease is no longer active")),
    )
}
