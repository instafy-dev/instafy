use std::str::FromStr;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use subtle::ConstantTimeEq;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::bearer_token;
use crate::bug_reports::{record_system_bug_report, SystemBugReportInput};
use crate::errors::{bad_request, forbidden, unauthorized, ApiError};
use crate::internal_error;
use crate::ota::require_operator_access;
use crate::state::{publish_controller_event_with_conversation, AppState};
use crate::tokens::decode_scoped_token;
use runtime_contracts::AccessTokenClaims;

const MAX_ANONYMOUS_AUTH_TELEMETRY_MESSAGE_LEN: usize = 512;
const MAX_ANONYMOUS_AUTH_TELEMETRY_METADATA_LEN: usize = 4096;
const DEFAULT_AUTH_LOGIN_EVENT_LIMIT: i64 = 50;
const MAX_AUTH_LOGIN_EVENT_LIMIT: i64 = 200;
const MAX_STORED_AUTH_LOGIN_EVENTS: i64 = 5_000;
const SCOPED_TELEMETRY_WRITE_SCOPE: &str = "telemetry.write";
const SCOPED_RUNTIME_TELEMETRY_KINDS: &[&str] = &["telemetry.error"];
const ANONYMOUS_AUTH_TELEMETRY_KINDS: &[&str] = &[
    "auth.login.github.started",
    "auth.login.github.start_failed",
    "auth.login.github.browser_finished_without_completion",
    "auth.login.github.callback_received",
    "auth.login.github.callback_error",
    "auth.login.github.exchange_failed",
    "auth.login.github.session_failed",
    "auth.login.github.callback_incomplete",
    "auth.login.github.completed",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryRequest {
    kind: String,
    level: Option<String>,
    message: Option<String>,
    project_id: Option<String>,
    runtime_id: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Clone, Copy)]
struct ScopedTelemetryResolution {
    project_id: Uuid,
    runtime_id: Uuid,
    run_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthLoginEventsQuery {
    limit: Option<i64>,
    kind: Option<String>,
    attempt_id: Option<String>,
    before_occurred_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthLoginTelemetryEvent {
    event_id: String,
    kind: String,
    level: String,
    message: Option<String>,
    provider: Option<String>,
    attempt_id: Option<String>,
    platform: Option<String>,
    anonymous: bool,
    occurred_at: DateTime<Utc>,
    metadata: JsonValue,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/telemetry", post(post_telemetry))
        .route("/telemetry/auth-login-events", get(list_auth_login_events))
}

fn kind_allows_anonymous_auth_telemetry(kind: &str) -> bool {
    ANONYMOUS_AUTH_TELEMETRY_KINDS
        .iter()
        .any(|candidate| *candidate == kind)
}

fn is_service_role_bearer_token(state: &AppState, token: &str) -> bool {
    if let Some(internal_token) = state.config.controller_internal_token.as_ref() {
        if ConstantTimeEq::ct_eq(token.as_bytes(), internal_token.as_bytes()).unwrap_u8() == 1 {
            return true;
        }
    }
    if let Some(service_role_key) = state.config.supabase_service_role_key.as_ref() {
        if ConstantTimeEq::ct_eq(token.as_bytes(), service_role_key.as_bytes()).unwrap_u8() == 1 {
            return true;
        }
    }
    false
}

fn parse_required_scoped_claim_uuid(
    raw: Option<&str>,
    field: &str,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let value = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| unauthorized(format!("telemetry token requires an exact {field} claim")))?;
    Uuid::from_str(value)
        .map_err(|_| unauthorized(format!("telemetry token {field} claim is invalid")))
}

fn scoped_telemetry_job_id(
    metadata: Option<&JsonValue>,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let raw = metadata
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("jobId").or_else(|| metadata.get("job_id")))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("scoped runtime telemetry requires metadata.jobId"))?;
    Uuid::from_str(raw).map_err(|_| bad_request("metadata.jobId must be a valid UUID"))
}

async fn resolve_scoped_runtime_telemetry(
    state: &AppState,
    claims: &AccessTokenClaims,
    kind: &str,
    level: &str,
    requested_project_id: Option<Uuid>,
    requested_runtime_id: Option<Uuid>,
    requested_run_id: Option<Uuid>,
    requested_conversation_id: Option<Uuid>,
    metadata: Option<&JsonValue>,
) -> Result<ScopedTelemetryResolution, (StatusCode, Json<ApiError>)> {
    if !claims
        .scopes
        .iter()
        .any(|scope| scope == SCOPED_TELEMETRY_WRITE_SCOPE)
    {
        return Err(forbidden(
            "telemetry token is missing telemetry.write scope",
        ));
    }
    if !SCOPED_RUNTIME_TELEMETRY_KINDS.contains(&kind) {
        return Err(forbidden(
            "scoped runtime tokens may only submit telemetry.error",
        ));
    }
    if level != "error" {
        return Err(forbidden(
            "scoped telemetry.error events must use error level",
        ));
    }

    let token_project_id =
        parse_required_scoped_claim_uuid(Some(claims.project_id.as_str()), "projectId")?;
    let token_runtime_id =
        parse_required_scoped_claim_uuid(claims.runtime_id.as_deref(), "runtimeId")?;
    if requested_project_id.is_some_and(|requested| requested != token_project_id) {
        return Err(forbidden("telemetry project mismatch"));
    }
    if requested_runtime_id.is_some_and(|requested| requested != token_runtime_id) {
        return Err(forbidden("telemetry runtime mismatch"));
    }

    let token_run_id = match claims.run_id.as_deref() {
        Some(raw) => Some(parse_required_scoped_claim_uuid(Some(raw), "runId")?),
        None => None,
    };
    if let (Some(requested), Some(claimed)) = (requested_run_id, token_run_id) {
        if requested != claimed {
            return Err(forbidden("telemetry run mismatch"));
        }
    }

    let job_id = scoped_telemetry_job_id(metadata)?;
    let connection =
        state.pool.get().await.map_err(|error| {
            internal_error(format!("failed to get telemetry connection: {error}"))
        })?;
    let row = connection
        .query_opt(
            "select aj.run_id,
                    aj.conversation_id as job_conversation_id,
                    r.id as validated_run_id,
                    r.conversation_id as run_conversation_id,
                    c.id as validated_conversation_id
             from agent_jobs aj
             left join runs r
               on r.id = aj.run_id
              and r.project_id = aj.project_id
             left join conversations c
               on c.id = coalesce(r.conversation_id, aj.conversation_id)
              and c.project_id = aj.project_id
             where aj.id = $1
               and aj.project_id = $2
               and aj.leased_by_runtime_id = $3
               and aj.status = 'leased'
               and exists (
                 select 1
                 from runtimes runtime
                 where runtime.id = $3
                   and runtime.project_id = $2
               )",
            &[&job_id, &token_project_id, &token_runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate scoped runtime telemetry: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Err(forbidden(
            "telemetry job does not belong to the token project and runtime",
        ));
    };

    let job_run_id: Option<Uuid> = row.get("run_id");
    let validated_run_id: Option<Uuid> = row.get("validated_run_id");
    if job_run_id.is_some() && validated_run_id != job_run_id {
        return Err(forbidden(
            "telemetry run does not belong to the token project",
        ));
    }
    if requested_run_id.is_some() && requested_run_id != job_run_id {
        return Err(forbidden("telemetry run mismatch"));
    }
    if token_run_id.is_some() && token_run_id != job_run_id {
        return Err(forbidden("telemetry run mismatch"));
    }

    let job_conversation_id: Option<Uuid> = row.get("job_conversation_id");
    let run_conversation_id: Option<Uuid> = row.get("run_conversation_id");
    if let (Some(job_conversation), Some(run_conversation)) =
        (job_conversation_id, run_conversation_id)
    {
        if job_conversation != run_conversation {
            return Err(forbidden(
                "telemetry job and run conversation scopes do not match",
            ));
        }
    }
    let conversation_id = run_conversation_id.or(job_conversation_id);
    let validated_conversation_id: Option<Uuid> = row.get("validated_conversation_id");
    if conversation_id.is_some() && validated_conversation_id != conversation_id {
        return Err(forbidden(
            "telemetry conversation does not belong to the token project",
        ));
    }
    if requested_conversation_id.is_some() && requested_conversation_id != conversation_id {
        return Err(forbidden("telemetry conversation mismatch"));
    }

    Ok(ScopedTelemetryResolution {
        project_id: token_project_id,
        runtime_id: token_runtime_id,
        run_id: job_run_id,
        conversation_id,
    })
}

async fn post_telemetry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<TelemetryRequest>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let kind = body.kind.trim().to_string();
    if kind.is_empty() {
        return Err(bad_request("telemetry kind is required"));
    }

    let token = bearer_token(&headers);
    let anonymous_auth_telemetry =
        token.is_none() && kind_allows_anonymous_auth_telemetry(kind.as_str());
    if token.is_none() && !anonymous_auth_telemetry {
        return Err(unauthorized("telemetry requires authorization"));
    }

    let message = body
        .message
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if anonymous_auth_telemetry {
        if body.project_id.is_some()
            || body.runtime_id.is_some()
            || body.run_id.is_some()
            || body.conversation_id.is_some()
        {
            return Err(forbidden(
                "anonymous auth telemetry cannot include project or runtime ids",
            ));
        }
        if message
            .as_ref()
            .is_some_and(|value| value.len() > MAX_ANONYMOUS_AUTH_TELEMETRY_MESSAGE_LEN)
        {
            return Err(bad_request("anonymous auth telemetry message is too long"));
        }
        if let Some(metadata) = body.metadata.as_ref() {
            if metadata.to_string().len() > MAX_ANONYMOUS_AUTH_TELEMETRY_METADATA_LEN {
                return Err(bad_request(
                    "anonymous auth telemetry metadata is too large",
                ));
            }
        }
    }

    let is_service_role = token
        .as_deref()
        .is_some_and(|token_value| is_service_role_bearer_token(&state, token_value));

    let scoped_claims = if let Some(token_value) = token.as_ref() {
        if is_service_role {
            None
        } else {
            Some(decode_scoped_token(
                &state.config,
                token_value,
                "telemetry token",
            )?)
        }
    } else {
        None
    };

    let level = body
        .level
        .as_deref()
        .unwrap_or("info")
        .trim()
        .to_ascii_lowercase();
    let level = if level.is_empty() {
        "info".to_string()
    } else {
        level
    };

    let requested_project_id = parse_uuid_optional(body.project_id.as_deref(), "projectId")?;
    let requested_runtime_id = parse_uuid_optional(body.runtime_id.as_deref(), "runtimeId")?;
    let requested_run_id = parse_uuid_optional(body.run_id.as_deref(), "runId")?;
    let requested_conversation_id =
        parse_uuid_optional(body.conversation_id.as_deref(), "conversationId")?;

    let (project_id, runtime_id, run_id, conversation_id) =
        if let Some(claims) = scoped_claims.as_ref() {
            let resolved = resolve_scoped_runtime_telemetry(
                &state,
                claims,
                &kind,
                &level,
                requested_project_id,
                requested_runtime_id,
                requested_run_id,
                requested_conversation_id,
                body.metadata.as_ref(),
            )
            .await?;
            (
                Some(resolved.project_id),
                Some(resolved.runtime_id),
                resolved.run_id,
                resolved.conversation_id,
            )
        } else {
            (
                requested_project_id,
                requested_runtime_id,
                requested_run_id,
                requested_conversation_id,
            )
        };

    let mut data = JsonMap::new();
    data.insert("level".to_string(), JsonValue::String(level.clone()));
    if let Some(message) = message.as_ref() {
        data.insert("message".to_string(), JsonValue::String(message.clone()));
    }
    if let Some(runtime_id) = runtime_id {
        data.insert(
            "runtimeId".to_string(),
            JsonValue::String(runtime_id.to_string()),
        );
    }
    let metadata = body.metadata.unwrap_or(JsonValue::Object(JsonMap::new()));
    let report_metadata = metadata.clone();
    if !metadata.is_null() {
        data.insert("metadata".to_string(), metadata);
    }
    if anonymous_auth_telemetry {
        data.insert("anonymous".to_string(), JsonValue::Bool(true));
    }

    match level.as_str() {
        "error" => {
            tracing::error!(
                kind = kind.as_str(),
                project_id = ?project_id,
                runtime_id = ?runtime_id,
                run_id = ?run_id,
                "telemetry error received"
            );
        }
        "warn" | "warning" => {
            tracing::warn!(
                kind = kind.as_str(),
                project_id = ?project_id,
                runtime_id = ?runtime_id,
                run_id = ?run_id,
                "telemetry warning received"
            );
        }
        _ => {
            tracing::info!(
                kind = kind.as_str(),
                project_id = ?project_id,
                runtime_id = ?runtime_id,
                run_id = ?run_id,
                "telemetry event received"
            );
        }
    }

    if anonymous_auth_telemetry {
        let stored_message = message.clone();
        let stored_metadata = data
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| JsonValue::Object(JsonMap::new()));
        if let Err(error) = record_auth_login_event(
            &state.pool,
            &kind,
            &level,
            stored_message.as_deref(),
            &stored_metadata,
        )
        .await
        {
            tracing::warn!(
                ?error,
                kind = kind.as_str(),
                "failed to persist auth login telemetry"
            );
        }
    }

    if let Some(input) = build_system_issue_from_telemetry(
        &kind,
        &level,
        message.as_deref(),
        project_id,
        runtime_id,
        run_id,
        conversation_id,
        &report_metadata,
    ) {
        if let Err(error) = record_system_bug_report(&state, input).await {
            tracing::warn!(
                ?error,
                kind = kind.as_str(),
                project_id = ?project_id,
                runtime_id = ?runtime_id,
                run_id = ?run_id,
                "failed to record system issue from telemetry error"
            );
        }
    }

    publish_controller_event_with_conversation(
        &state.events,
        &kind,
        project_id,
        None,
        conversation_id,
        run_id,
        None,
        JsonValue::Object(data),
    );

    Ok(StatusCode::ACCEPTED)
}

fn build_system_issue_from_telemetry(
    kind: &str,
    level: &str,
    message: Option<&str>,
    project_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    run_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    metadata: &JsonValue,
) -> Option<SystemBugReportInput> {
    if kind != "telemetry.error" || level != "error" {
        return None;
    }

    let message = message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Runtime telemetry error");
    let upstream_ai_failure = is_upstream_ai_failure(message);
    let labels = if upstream_ai_failure {
        vec![
            "managed-ai".to_string(),
            "proxy".to_string(),
            "runtime".to_string(),
            "monitoring".to_string(),
        ]
    } else {
        vec![
            "runtime".to_string(),
            "telemetry".to_string(),
            "monitoring".to_string(),
        ]
    };
    let fingerprint = if upstream_ai_failure {
        Some("runtime.agent.upstream_ai_failure".to_string())
    } else {
        Some("runtime.agent.telemetry_error".to_string())
    };

    Some(SystemBugReportInput {
        message: if upstream_ai_failure {
            "Runtime AI upstream request failed".to_string()
        } else {
            "Runtime telemetry error".to_string()
        },
        details: Some(message.to_string()),
        project_id,
        runtime_id,
        run_id,
        conversation_id,
        priority: "high".to_string(),
        labels,
        metadata: json!({
            "source": "runtime_telemetry",
            "telemetryKind": kind,
            "telemetryLevel": level,
            "telemetryMetadata": metadata,
        }),
        logs: json!([
            {
                "level": level,
                "message": message,
                "metadata": metadata,
            }
        ]),
        fingerprint,
        dedupe_window_seconds: Some(10 * 60),
    })
}

fn is_upstream_ai_failure(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("upstream request failed")
        || normalized.contains("unexpected status 429")
        || normalized.contains("unexpected status 500")
        || normalized.contains("unexpected status 502")
        || normalized.contains("unexpected status 503")
        || normalized.contains("unexpected status 504")
}

async fn list_auth_login_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<AuthLoginEventsQuery>,
) -> Result<Json<Vec<AuthLoginTelemetryEvent>>, (StatusCode, Json<ApiError>)> {
    require_auth_login_event_read_access(&state, &headers).await?;
    let events = load_auth_login_events(&state.pool, params)
        .await
        .map_err(|error| {
            tracing::warn!(?error, "failed to list auth login telemetry");
            crate::internal_error("failed to load auth login telemetry")
        })?;
    Ok(Json(events))
}

async fn require_auth_login_event_read_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if let Some(token) = bearer_token(headers) {
        if is_service_role_bearer_token(state, &token) {
            return Ok(());
        }
    }
    require_operator_access(state, headers).await?;
    Ok(())
}

fn parse_uuid_optional(
    raw: Option<&str>,
    field: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(value) = raw else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed = Uuid::from_str(trimmed)
        .map_err(|_| bad_request(format!("{field} must be a valid UUID")))?;
    Ok(Some(parsed))
}

fn normalize_optional_text(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_auth_login_event_limit(raw: Option<i64>) -> Result<i64, anyhow::Error> {
    match raw {
        None => Ok(DEFAULT_AUTH_LOGIN_EVENT_LIMIT),
        Some(value) if value <= 0 => Err(anyhow::anyhow!("limit must be positive")),
        Some(value) => Ok(value.min(MAX_AUTH_LOGIN_EVENT_LIMIT)),
    }
}

fn parse_before_occurred_at(raw: Option<&str>) -> Result<Option<DateTime<Utc>>, anyhow::Error> {
    let Some(value) = normalize_optional_text(raw) else {
        return Ok(None);
    };
    let parsed = DateTime::parse_from_rfc3339(&value)
        .map_err(|error| anyhow::anyhow!("beforeOccurredAt must be RFC3339: {error}"))?;
    Ok(Some(parsed.with_timezone(&Utc)))
}

fn metadata_string(metadata: &JsonValue, key: &str) -> Option<String> {
    metadata
        .as_object()
        .and_then(|value| value.get(key))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn ensure_auth_login_event_tables(pool: &crate::config::PgPool) -> Result<(), anyhow::Error> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "create table if not exists auth_login_events (
                event_id text primary key,
                kind text not null,
                level text not null check (level in ('info', 'warning', 'error')),
                message text,
                provider text,
                attempt_id text,
                platform text,
                anonymous boolean not null default false,
                occurred_at timestamptz not null,
                metadata jsonb not null default '{}'::jsonb,
                created_at timestamptz not null default now()
            );

            create index if not exists auth_login_events_occurred_at_idx
                on auth_login_events (occurred_at desc);
            create index if not exists auth_login_events_attempt_id_idx
                on auth_login_events (attempt_id, occurred_at desc);
            create index if not exists auth_login_events_kind_idx
                on auth_login_events (kind, occurred_at desc);

            alter table auth_login_events enable row level security;
            revoke all privileges on table auth_login_events from anon, authenticated;",
        )
        .await?;
    Ok(())
}

async fn record_auth_login_event(
    pool: &crate::config::PgPool,
    kind: &str,
    level: &str,
    message: Option<&str>,
    metadata: &JsonValue,
) -> Result<(), anyhow::Error> {
    ensure_auth_login_event_tables(pool).await?;

    let connection = pool.get().await?;
    let occurred_at = Utc::now();
    let attempt_id = metadata_string(metadata, "attemptId");
    let provider = metadata_string(metadata, "provider");
    let platform = metadata_string(metadata, "platform");
    let event_id = Uuid::new_v4().to_string();
    let metadata_json = PgJson(metadata);

    connection
        .execute(
            "insert into auth_login_events (
                event_id,
                kind,
                level,
                message,
                provider,
                attempt_id,
                platform,
                anonymous,
                occurred_at,
                metadata
             ) values ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)",
            &[
                &event_id,
                &kind,
                &level,
                &message.map(str::to_string),
                &provider,
                &attempt_id,
                &platform,
                &occurred_at,
                &metadata_json,
            ],
        )
        .await?;

    connection
        .execute(
            "delete from auth_login_events
              where event_id in (
                select event_id
                  from auth_login_events
                 order by occurred_at desc
                 offset $1
              )",
            &[&MAX_STORED_AUTH_LOGIN_EVENTS],
        )
        .await?;

    Ok(())
}

async fn load_auth_login_events(
    pool: &crate::config::PgPool,
    params: AuthLoginEventsQuery,
) -> Result<Vec<AuthLoginTelemetryEvent>, anyhow::Error> {
    ensure_auth_login_event_tables(pool).await?;

    let limit = parse_auth_login_event_limit(params.limit)?;
    let kind = normalize_optional_text(params.kind.as_deref());
    let attempt_id = normalize_optional_text(params.attempt_id.as_deref());
    let before_occurred_at = parse_before_occurred_at(params.before_occurred_at.as_deref())?;

    let connection = pool.get().await?;
    let rows = connection
        .query(
            "select event_id, kind, level, message, provider, attempt_id, platform, anonymous, occurred_at, metadata
               from auth_login_events
              where ($1::text is null or kind = $1)
                and ($2::text is null or attempt_id = $2)
                and ($3::timestamptz is null or occurred_at < $3)
              order by occurred_at desc
              limit $4",
            &[&kind, &attempt_id, &before_occurred_at, &limit],
        )
        .await?;

    rows.into_iter().map(auth_login_event_from_row).collect()
}

fn auth_login_event_from_row(row: Row) -> Result<AuthLoginTelemetryEvent, anyhow::Error> {
    let metadata: PgJson<JsonValue> = row.get("metadata");
    Ok(AuthLoginTelemetryEvent {
        event_id: row.get("event_id"),
        kind: row.get("kind"),
        level: row.get("level"),
        message: row.get("message"),
        provider: row.get("provider"),
        attempt_id: row.get("attempt_id"),
        platform: row.get("platform"),
        anonymous: row.get("anonymous"),
        occurred_at: row.get("occurred_at"),
        metadata: metadata.0,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_system_issue_from_telemetry, is_upstream_ai_failure,
        kind_allows_anonymous_auth_telemetry, SCOPED_RUNTIME_TELEMETRY_KINDS,
        SCOPED_TELEMETRY_WRITE_SCOPE,
    };
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        Router,
    };
    use serde_json::{json, Value as JsonValue};
    use tokio::time::{timeout, Duration};
    use tower::ServiceExt;
    use uuid::Uuid;

    fn mint_runtime_telemetry_token(
        config: &crate::config::AppConfig,
        project_id: Uuid,
        runtime_id: Option<Uuid>,
        run_id: Option<Uuid>,
        scopes: Vec<String>,
    ) -> anyhow::Result<String> {
        crate::tokens::mint_scoped_token(
            config,
            crate::tokens::ScopedTokenRequest {
                audience: runtime_id.unwrap_or(project_id).to_string(),
                subject: "runtime.telemetry.test".to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: runtime_id.map(|value| value.to_string()),
                protocol: None,
                scopes,
                lease_id: None,
                run_id: run_id.map(|value| value.to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map(|minted| minted.token)
        .map_err(|(status, axum::Json(error))| {
            anyhow::anyhow!(
                "failed to mint telemetry token ({status}): {}",
                error.message
            )
        })
    }

    async fn post_telemetry_json(
        app: &Router,
        token: &str,
        payload: JsonValue,
    ) -> anyhow::Result<StatusCode> {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/telemetry")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(payload.to_string()))?,
            )
            .await?;
        Ok(response.status())
    }

    #[test]
    fn anonymous_auth_telemetry_allowlist_is_narrow() {
        assert!(kind_allows_anonymous_auth_telemetry(
            "auth.login.github.callback_error"
        ));
        assert!(kind_allows_anonymous_auth_telemetry(
            "auth.login.github.completed"
        ));
        assert!(!kind_allows_anonymous_auth_telemetry(
            "auth.login.google.started"
        ));
        assert!(!kind_allows_anonymous_auth_telemetry("telemetry.error"));
        assert_eq!(SCOPED_RUNTIME_TELEMETRY_KINDS, &["telemetry.error"]);
        assert_eq!(SCOPED_TELEMETRY_WRITE_SCOPE, "telemetry.write");
    }

    #[test]
    fn telemetry_error_builds_system_issue_for_upstream_ai_failures() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let input = build_system_issue_from_telemetry(
            "telemetry.error",
            "error",
            Some("unexpected status 502 Bad Gateway: upstream request failed"),
            Some(project_id),
            Some(runtime_id),
            Some(run_id),
            Some(conversation_id),
            &json!({ "jobId": "job-1" }),
        )
        .expect("system issue input");

        assert_eq!(input.message, "Runtime AI upstream request failed");
        assert_eq!(input.project_id, Some(project_id));
        assert_eq!(input.runtime_id, Some(runtime_id));
        assert_eq!(input.run_id, Some(run_id));
        assert_eq!(input.conversation_id, Some(conversation_id));
        assert_eq!(
            input.fingerprint.as_deref(),
            Some("runtime.agent.upstream_ai_failure")
        );
        assert!(input.labels.iter().any(|label| label == "managed-ai"));
        assert!(input.labels.iter().any(|label| label == "monitoring"));
    }

    #[test]
    fn telemetry_system_issue_ignores_non_error_events() {
        assert!(build_system_issue_from_telemetry(
            "telemetry.error",
            "warning",
            Some("warn"),
            None,
            None,
            None,
            None,
            &JsonValue::Null,
        )
        .is_none());
        assert!(build_system_issue_from_telemetry(
            "runtime.unavailable",
            "error",
            Some("runtime unavailable"),
            None,
            None,
            None,
            None,
            &JsonValue::Null,
        )
        .is_none());
    }

    #[test]
    fn upstream_ai_failure_classifier_covers_retryable_statuses() {
        assert!(is_upstream_ai_failure(
            "unexpected status 429 Too Many Requests"
        ));
        assert!(is_upstream_ai_failure("upstream request failed"));
        assert!(!is_upstream_ai_failure("workspace command failed"));
    }

    #[tokio::test]
    async fn anonymous_auth_login_events_are_queryable() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping auth login telemetry test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        let state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "test-origin-key",
            ),
        );
        let app = super::router().with_state(state);
        let attempt_id = format!("attempt-{}", Uuid::new_v4());

        let post_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/telemetry")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "kind": "auth.login.github.browser_finished_without_completion",
                            "level": "warning",
                            "message": "GitHub sign-in did not complete. Try again.",
                            "metadata": {
                                "attemptId": attempt_id,
                                "platform": "android",
                                "provider": "github",
                                "source": "browser_finished"
                            }
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(post_response.status(), StatusCode::ACCEPTED);

        let get_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/telemetry/auth-login-events?attemptId={}",
                        attempt_id
                    ))
                    .header("authorization", "Bearer service-role-token")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(get_response.status(), StatusCode::OK);

        let body = to_bytes(get_response.into_body(), usize::MAX).await?;
        let payload: JsonValue = serde_json::from_slice(&body)?;
        let events = payload.as_array().expect("events array");
        assert!(
            !events.is_empty(),
            "expected at least one persisted auth login event"
        );
        assert_eq!(
            events[0]["kind"],
            JsonValue::String("auth.login.github.browser_finished_without_completion".to_string())
        );
        assert_eq!(events[0]["attemptId"], JsonValue::String(attempt_id));
        assert_eq!(
            events[0]["platform"],
            JsonValue::String("android".to_string())
        );
        Ok(())
    }

    #[tokio::test]
    async fn scoped_runtime_telemetry_is_scope_and_job_bound() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping scoped runtime telemetry test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let other_runtime_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .batch_execute(
                    "alter table if exists conversations
                         add column if not exists visibility text not null default 'public',
                         add column if not exists parent_conversation_id uuid,
                         add column if not exists root_conversation_id uuid,
                         add column if not exists thread_kind text,
                         add column if not exists last_message_id uuid,
                         add column if not exists last_message_at timestamptz,
                         add column if not exists last_message_preview text;",
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, name, project_type, status)
                     values ($1, 'Scoped telemetry test', 'customer', 'active')",
                    &[&project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtimes (id, project_id, provider, status)
                     values ($1, $2, 'test', 'ready'), ($3, $2, 'test', 'ready')",
                    &[&runtime_id, &project_id, &other_runtime_id],
                )
                .await?;
            connection
                .execute(
                    "insert into conversations (id, project_id, metadata, visibility)
                     values ($1, $2, '{}'::jsonb, 'private')",
                    &[&conversation_id, &project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runs (
                         id, project_id, conversation_id, run_type, status
                     ) values ($1, $2, $3, 'prompt', 'in_progress')",
                    &[&run_id, &project_id, &conversation_id],
                )
                .await?;
            connection
                .execute(
                    "insert into agent_jobs (
                         id, project_id, run_id, conversation_id, status, payload,
                         leased_by_runtime_id
                     ) values ($1, $2, $3, $4, 'leased', '{}'::jsonb, $5)",
                    &[&job_id, &project_id, &run_id, &conversation_id, &runtime_id],
                )
                .await?;
        }

        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-runtime-telemetry",
        );
        let telemetry_scope = vec![SCOPED_TELEMETRY_WRITE_SCOPE.to_string()];
        let valid_token = mint_runtime_telemetry_token(
            &config,
            project_id,
            Some(runtime_id),
            None,
            telemetry_scope.clone(),
        )?;
        let missing_scope_token = mint_runtime_telemetry_token(
            &config,
            project_id,
            Some(runtime_id),
            None,
            vec!["agent.lease".to_string()],
        )?;
        let missing_runtime_token =
            mint_runtime_telemetry_token(&config, project_id, None, None, telemetry_scope.clone())?;
        let wrong_runtime_token = mint_runtime_telemetry_token(
            &config,
            project_id,
            Some(other_runtime_id),
            None,
            telemetry_scope.clone(),
        )?;
        let wrong_run_claim_token = mint_runtime_telemetry_token(
            &config,
            project_id,
            Some(runtime_id),
            Some(Uuid::new_v4()),
            telemetry_scope,
        )?;

        let state = crate::tests::build_test_state(pool.clone(), config);
        let mut events = state.events.subscribe();
        let app = super::router().with_state(state);
        let valid_payload = || {
            json!({
                "kind": "telemetry.error",
                "level": "error",
                "message": "private run failed",
                "projectId": project_id,
                "runtimeId": runtime_id,
                "runId": run_id,
                "metadata": { "jobId": job_id }
            })
        };

        assert_eq!(
            post_telemetry_json(&app, &missing_scope_token, valid_payload()).await?,
            StatusCode::FORBIDDEN
        );

        let mut wrong_kind = valid_payload();
        wrong_kind["kind"] = json!("telemetry.warning");
        wrong_kind["level"] = json!("warning");
        assert_eq!(
            post_telemetry_json(&app, &valid_token, wrong_kind).await?,
            StatusCode::FORBIDDEN
        );

        let mut wrong_level = valid_payload();
        wrong_level["level"] = json!("info");
        assert_eq!(
            post_telemetry_json(&app, &valid_token, wrong_level).await?,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            post_telemetry_json(&app, &missing_runtime_token, valid_payload()).await?,
            StatusCode::UNAUTHORIZED
        );

        let mut wrong_project = valid_payload();
        wrong_project["projectId"] = json!(Uuid::new_v4());
        assert_eq!(
            post_telemetry_json(&app, &valid_token, wrong_project).await?,
            StatusCode::FORBIDDEN
        );

        let mut wrong_runtime = valid_payload();
        wrong_runtime["runtimeId"] = json!(other_runtime_id);
        assert_eq!(
            post_telemetry_json(&app, &valid_token, wrong_runtime).await?,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            post_telemetry_json(&app, &wrong_runtime_token, valid_payload()).await?,
            StatusCode::FORBIDDEN
        );

        let mut wrong_run = valid_payload();
        wrong_run["runId"] = json!(Uuid::new_v4());
        assert_eq!(
            post_telemetry_json(&app, &valid_token, wrong_run).await?,
            StatusCode::FORBIDDEN
        );

        let mut claim_bound_payload = valid_payload();
        claim_bound_payload
            .as_object_mut()
            .expect("telemetry payload object")
            .remove("runId");
        assert_eq!(
            post_telemetry_json(&app, &wrong_run_claim_token, claim_bound_payload).await?,
            StatusCode::FORBIDDEN
        );

        let mut spoofed_conversation = valid_payload();
        spoofed_conversation["conversationId"] = json!(Uuid::new_v4());
        assert_eq!(
            post_telemetry_json(&app, &valid_token, spoofed_conversation).await?,
            StatusCode::FORBIDDEN
        );

        let mut missing_job = valid_payload();
        missing_job["metadata"] = json!({});
        assert_eq!(
            post_telemetry_json(&app, &valid_token, missing_job).await?,
            StatusCode::BAD_REQUEST
        );

        assert_eq!(
            post_telemetry_json(&app, &valid_token, valid_payload()).await?,
            StatusCode::ACCEPTED
        );
        let telemetry_event = timeout(Duration::from_secs(3), async {
            loop {
                let event = events.recv().await?;
                if event.kind == "telemetry.error" {
                    return Ok::<_, tokio::sync::broadcast::error::RecvError>(event);
                }
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for scoped telemetry event"))??;
        assert_eq!(telemetry_event.project_id, Some(project_id));
        assert_eq!(telemetry_event.run_id, Some(run_id));
        assert_eq!(telemetry_event.conversation_id, Some(conversation_id));
        assert_eq!(
            telemetry_event.data["runtimeId"],
            JsonValue::String(runtime_id.to_string())
        );

        // Trusted service/operator callers retain their existing unrestricted
        // telemetry path; scoped runtime restrictions do not apply to them.
        assert_eq!(
            post_telemetry_json(
                &app,
                "service-role-token",
                json!({
                    "kind": "operator.telemetry",
                    "level": "info",
                    "conversationId": Uuid::new_v4()
                }),
            )
            .await?,
            StatusCode::ACCEPTED
        );

        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "delete from bug_reports where project_id = $1",
                    &[&project_id],
                )
                .await?;
            connection
                .execute("delete from projects where id = $1", &[&project_id])
                .await?;
        }
        Ok(())
    }
}
