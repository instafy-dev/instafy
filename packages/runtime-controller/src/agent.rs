use std::collections::HashSet;
use std::str::FromStr;

use axum::extract::Path as AxumPath;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use super::{
    bad_request, coerce_idle_ttl, ensure_project_access, ensure_project_write_access, forbidden,
    internal_error, load_project_record, not_found, publish_controller_event,
    publish_controller_event_with_conversation, runtime, ApiError, AppConfig, AppState,
    ProjectRecord,
};
use crate::active_job_auth::{
    authorize_active_job_if_scoped, ActiveJobAuthorization, ActiveJobProjectAccess,
};
use crate::auth::{
    authenticate_request, issue_agent_token_for_runtime, issue_proxy_envelope, RequestContext,
};
use crate::conversations::{
    ensure_conversation_access, load_conversation_record, map_conversation_message_row,
    publish_conversation_message_event, ConversationMessageRow,
};
use crate::credits::{
    extract_credit_snapshot, extract_provider_conversation_state, extract_provider_from_metadata,
    reconcile_managed_ai_usage_charge, ManagedAiTokenUsage,
};
use crate::dispatch::DispatchPromptNormalized;
use crate::redaction::RedactedHeaders;
use crate::runs::{load_run_snapshot, run_snapshot_to_json};
use crate::state::RuntimeResourceUsagePayload;
use crate::tokens::{
    decode_scoped_token, mint_scoped_token_with_runtime_generation, MintedAccessToken,
    ScopedTokenRequest,
};
use crate::workspace;

const AGENT_CONVERSATION_HISTORY_LIMIT: i64 = 80;

#[derive(Debug, Clone, Copy)]
pub(crate) struct TokenContext {
    pub(crate) project_id: Uuid,
    pub(crate) runtime_id: Option<Uuid>,
    pub(crate) lease_id: Option<Uuid>,
    pub(crate) runtime_generation: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AgentLeasePayload {
    #[serde(default = "default_max_jobs")]
    max: u32,
    #[serde(default = "default_lease_seconds")]
    lease_seconds: u32,
    runtime_id: Option<String>,
    #[serde(default)]
    resources: Option<RuntimeResourceUsagePayload>,
    #[serde(default)]
    supports_workspace_token: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct AgentLeaseResponse {
    jobs: Vec<AgentJob>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentLeaseMetrics {
    queued_at: DateTime<Utc>,
    leased_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    queue_wait_ms: Option<i64>,
    wall_time_ms: Option<i64>,
    lease_attempts: i32,
    leased_by_runtime_id: Option<Uuid>,
    agent_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_update_count: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AgentJob {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) prompt_id: Option<Uuid>,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) conversation_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credential_id: Option<Uuid>,
    pub(crate) intent: Option<String>,
    pub(crate) status: String,
    pub(crate) outcome: Option<String>,
    pub(crate) payload: JsonValue,
    pub(crate) priority: i32,
    pub(crate) lease_attempts: i32,
    pub(crate) leased_at: Option<DateTime<Utc>>,
    pub(crate) lease_expires_at: Option<DateTime<Utc>>,
    pub(crate) leased_by_runtime_id: Option<Uuid>,
    /// Internal dispatch binding used when minting exact-runtime credentials.
    /// The runtime already knows its own lease identity, so do not duplicate
    /// this controller-only routing field in the lease response.
    #[serde(skip)]
    pub(crate) target_runtime_id: Option<Uuid>,
    pub(crate) heartbeat_at: Option<DateTime<Utc>>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
    #[serde(rename = "leaseMetrics")]
    pub(crate) lease_metrics: AgentLeaseMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy: Option<runtime_contracts::ProxyEnvelopePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    controller_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    controller_token_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    controller_token_scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_token_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_token_scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentLeaseBatchMode {
    None,
    ReadOnly,
    ExactWriteScoped,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AgentHeartbeatPayload {
    #[serde(rename = "job_id")]
    job_id: String,
    #[serde(rename = "extend_seconds")]
    extend_seconds: Option<u32>,
    #[serde(default)]
    resources: Option<RuntimeResourceUsagePayload>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AgentHeartbeatResponseBody {
    ok: bool,
    #[serde(rename = "lease_expires_at")]
    lease_expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AgentCompletePayload {
    #[serde(rename = "job_id")]
    job_id: String,
    outcome: String,
    summary: Option<String>,
    #[serde(rename = "error_message", alias = "errorMessage")]
    error_message: Option<String>,
    artifacts: Option<JsonValue>,
    #[serde(rename = "proxy_metadata", alias = "proxyMetadata")]
    proxy_metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AgentCompleteResponseBody {
    ok: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AgentMessagePayload {
    #[serde(rename = "job_id")]
    job_id: String,
    content: String,
    #[serde(rename = "message_type", alias = "messageType")]
    message_type: Option<String>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AgentMessageResponseBody {
    ok: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentLoginRequest {
    project_id: String,
    runtime_type: Option<String>,
    idle_ttl_seconds: Option<u32>,
    #[serde(default, rename = "displayName", alias = "display_name")]
    display_name: Option<String>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/agent/login", post(agent_login))
        .route("/agent/lease", post(agent_lease))
        .route("/agent/heartbeat", post(agent_heartbeat))
        .route("/agent/message", post(agent_message))
        .route("/agent/complete", post(agent_complete))
        .route(
            "/agent/plan-groups/:group_id/status",
            get(agent_plan_group_status),
        )
}

fn extract_agent_handle_from_job_payload(payload: &JsonValue) -> Option<String> {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("agent"))
        .and_then(JsonValue::as_object)
        .and_then(|agent| agent.get("handle"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

fn extract_write_scope_from_job_payload(payload: &JsonValue) -> Option<JsonValue> {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| {
            metadata
                .get("writeScope")
                .or_else(|| metadata.get("write_scope"))
        })
        .cloned()
        .or_else(|| {
            payload
                .get("metadata")
                .and_then(JsonValue::as_object)
                .and_then(|metadata| metadata.get("agent"))
                .and_then(JsonValue::as_object)
                .and_then(|agent| agent.get("writeScope").or_else(|| agent.get("write_scope")))
                .cloned()
        })
}

fn extract_multi_agent_plan_from_job_payload(payload: &JsonValue) -> Option<JsonValue> {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| {
            metadata
                .get("multiAgentPlan")
                .or_else(|| metadata.get("multi_agent_plan"))
        })
        .cloned()
}

fn extract_write_scope_mode_from_job_payload(payload: &JsonValue) -> Option<String> {
    extract_write_scope_from_job_payload(payload)
        .and_then(|scope| {
            scope
                .get("mode")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
        })
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .filter(|value| !value.is_empty())
}

fn job_has_read_only_write_scope(job: &AgentJob) -> bool {
    extract_write_scope_mode_from_job_payload(&job.payload).as_deref() == Some("read_only")
}

fn job_payload_value<'a>(payload: &'a JsonValue, keys: &[&str]) -> Option<&'a JsonValue> {
    keys.iter().find_map(|key| payload.get(*key)).or_else(|| {
        payload
            .get("metadata")
            .and_then(JsonValue::as_object)
            .and_then(|metadata| keys.iter().find_map(|key| metadata.get(*key)))
    })
}

fn parse_job_runtime_bool(value: &JsonValue) -> Option<bool> {
    match value {
        JsonValue::Bool(value) => Some(*value),
        JsonValue::Number(value) => value.as_i64().map(|number| number != 0),
        JsonValue::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" | "required" | "require" => Some(true),
            "0" | "false" | "no" | "off" | "none" | "optional" | "disabled" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn normalized_job_payload_string(payload: &JsonValue, keys: &[&str]) -> Option<String> {
    job_payload_value(payload, keys)
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .filter(|value| !value.is_empty())
}

fn job_declares_read_only_execution(job: &AgentJob) -> bool {
    if job_has_read_only_write_scope(job) {
        return true;
    }

    let payload = &job.payload;
    let write_intent = job_payload_value(payload, &["writeIntent", "write_intent"])
        .and_then(parse_job_runtime_bool);
    if write_intent == Some(false) {
        return true;
    }

    let workspace_mode = normalized_job_payload_string(
        payload,
        &["workspaceMode", "workspace_mode", "executionMode"],
    );
    if matches!(workspace_mode.as_deref(), Some("shared_read" | "read_only")) {
        return true;
    }

    let execution_mode =
        normalized_job_payload_string(payload, &["execution_mode", "executionMode"]);
    execution_mode.as_deref() == Some("plan_only")
}

fn job_has_exact_owned_write_scope(job: &AgentJob) -> bool {
    let mode = extract_write_scope_mode_from_job_payload(&job.payload);
    if !matches!(mode.as_deref(), Some("owned" | "write" | "write_scoped")) {
        return false;
    }
    extract_exact_owned_write_scope_paths_from_payload(&job.payload)
        .is_some_and(|paths| !paths.is_empty())
}

fn extract_exact_owned_write_scope_paths_from_payload(payload: &JsonValue) -> Option<Vec<String>> {
    let scope = extract_write_scope_from_job_payload(payload)?;
    let scope = scope.as_object()?;
    let values = scope
        .get("ownedPaths")
        .or_else(|| scope.get("owned_paths"))
        .and_then(JsonValue::as_array)?;
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for item in values {
        let Some(path) = item.as_str().map(str::trim).filter(|value| {
            !value.is_empty()
                && !value.contains('*')
                && !value.contains('?')
                && !value.contains('[')
                && !value.contains(']')
                && !value.ends_with('/')
                && !value.ends_with('\\')
        }) else {
            return None;
        };
        if seen.insert(path.to_string()) {
            paths.push(path.to_string());
        }
    }
    Some(paths)
}

fn extract_multi_agent_group_id_from_job_payload(payload: &JsonValue) -> Option<String> {
    extract_multi_agent_plan_from_job_payload(payload).and_then(|plan| {
        plan.get("groupId")
            .or_else(|| plan.get("group_id"))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn job_requests_runtime_spread(job: &AgentJob) -> bool {
    payload_requests_runtime_spread(&job.payload)
}

fn payload_requests_runtime_spread(payload: &JsonValue) -> bool {
    let Some(routing) = payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| {
            metadata
                .get("runtimeRouting")
                .or_else(|| metadata.get("runtime_routing"))
        })
        .and_then(JsonValue::as_object)
    else {
        return false;
    };

    if routing
        .get("allowUntargetedAcrossPreferredRuntimes")
        .or_else(|| routing.get("allowRuntimeSpread"))
        .or_else(|| routing.get("allow_runtime_spread"))
        .and_then(JsonValue::as_bool)
        == Some(true)
    {
        return true;
    }

    routing
        .get("strategy")
        .or_else(|| routing.get("mode"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .is_some_and(|value| matches!(value.as_str(), "spread" | "parallel" | "scale_out"))
}

fn build_agent_lease_metrics(
    payload: &JsonValue,
    queued_at: DateTime<Utc>,
    leased_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    lease_attempts: i32,
    leased_by_runtime_id: Option<Uuid>,
    tool_update_count: Option<i64>,
) -> AgentLeaseMetrics {
    let queue_wait_ms = leased_at.map(|timestamp| {
        timestamp
            .signed_duration_since(queued_at)
            .num_milliseconds()
            .max(0)
    });
    let wall_time_ms = leased_at
        .zip(completed_at)
        .map(|(start, end)| end.signed_duration_since(start).num_milliseconds().max(0));
    AgentLeaseMetrics {
        queued_at,
        leased_at,
        completed_at,
        queue_wait_ms,
        wall_time_ms,
        lease_attempts,
        leased_by_runtime_id,
        agent_handle: extract_agent_handle_from_job_payload(payload),
        tool_update_count,
    }
}

/// Upper bound on the serialized `artifacts` JSON persisted per agent job. A
/// runaway or misbehaving agent can otherwise emit an arbitrarily large artifact
/// payload, which lands as a multi-megabyte row in agent_jobs (bloating the DB
/// and slowing every scan of the table). When over the cap we replace the
/// payload with a small marker rather than store or truncate the blob.
const MAX_ARTIFACTS_PAYLOAD_BYTES: usize = 1024 * 1024;

fn cap_artifacts_payload(artifacts: &JsonValue) -> std::borrow::Cow<'_, JsonValue> {
    let serialized_len = serde_json::to_string(artifacts)
        .map(|value| value.len())
        .unwrap_or(0);
    if serialized_len <= MAX_ARTIFACTS_PAYLOAD_BYTES {
        return std::borrow::Cow::Borrowed(artifacts);
    }
    let count = artifacts.as_array().map(|items| items.len());
    tracing::warn!(
        serialized_len,
        cap = MAX_ARTIFACTS_PAYLOAD_BYTES,
        ?count,
        "agent artifacts payload exceeded cap; storing marker instead"
    );
    // Keep the marker ARRAY-shaped so the columns that read stored artifacts
    // back (run-result rebuild, worker-checkpoint extraction) still see an
    // array and degrade to empty rather than mis-typing a bare object.
    std::borrow::Cow::Owned(json!([{
        "kind": "instafy/artifacts-truncated",
        "truncated": true,
        "reason": "artifacts_payload_exceeded_cap",
        "originalBytes": serialized_len,
        "originalCount": count,
    }]))
}

async fn count_job_tool_update_messages(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
) -> Result<i64, (StatusCode, Json<ApiError>)> {
    let job_id_text = job_id.to_string();
    // Scope by project_id (indexed) before the JSONB metadata filter. Every
    // message for a job lives in that job's project, so this cannot change the
    // count — but without it the query is a full-table seqscan of
    // conversation_messages across all tenants on every agent completion, which
    // drains the connection pool as the table grows.
    let row = transaction
        .query_one(
            "select count(*)::bigint
             from conversation_messages
             where project_id = $1
               and coalesce(metadata #>> '{jobId}', metadata #>> '{job_id}') = $2
               and lower(coalesce(metadata #>> '{messageType}', metadata #>> '{message_type}', '')) in (
                   'command_execution',
                   'mcp_tool_call',
                   'web_search',
                   'file_change'
               )",
            &[project_id, &job_id_text],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to count agent job tool updates for metrics: {error}"
            ))
        })?;
    Ok(row.get::<_, i64>(0).max(0))
}

fn attach_lease_metrics_to_metadata(
    metadata: JsonValue,
    lease_metrics: Option<&AgentLeaseMetrics>,
) -> JsonValue {
    let Some(lease_metrics) = lease_metrics else {
        return metadata;
    };

    let Ok(metrics_value) = serde_json::to_value(lease_metrics) else {
        return metadata;
    };

    match metadata {
        JsonValue::Object(mut map) => {
            map.insert("leaseMetrics".to_string(), metrics_value);
            JsonValue::Object(map)
        }
        other => other,
    }
}

fn sanitize_postgres_text(value: &str) -> String {
    if value.contains('\0') {
        value.replace('\0', "\u{FFFD}")
    } else {
        value.to_string()
    }
}

fn sanitize_json_for_postgres(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::String(value) => JsonValue::String(sanitize_postgres_text(&value)),
        JsonValue::Array(values) => {
            JsonValue::Array(values.into_iter().map(sanitize_json_for_postgres).collect())
        }
        JsonValue::Object(values) => JsonValue::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, sanitize_json_for_postgres(value)))
                .collect(),
        ),
        other => other,
    }
}

#[instrument(skip(state, payload))]
pub(crate) async fn agent_login(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: RedactedHeaders,
    axum::Json(payload): axum::Json<AgentLoginRequest>,
) -> Result<Json<runtime::RuntimeRegisterResponse>, (StatusCode, Json<ApiError>)> {
    let auth_context = authenticate_request(&state.config, &headers).await?;
    if auth_context.scoped_claims.is_some() {
        // `/agent/login` is the user/service bootstrap for self-hosted
        // runtimes. Letting an already-issued runtime/agent token bootstrap a
        // fresh runtime turns any stale hosted generation into a token-renewal
        // oracle after its lease has rotated or stopped.
        return Err(unauthorized(
            "agent login requires user or service-role authorization",
        ));
    }

    let project_id = Uuid::from_str(payload.project_id.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let runtime_provider = payload
        .runtime_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "self-hosted".to_string());
    if !runtime::provider_is_self_hosted(&state, &runtime_provider) {
        return Err(forbidden(
            "agent login may bootstrap only a private self-hosted runtime",
        ));
    }
    let runtime_owner = auth_context
        .user_id
        .or_else(|| {
            auth_context
                .is_service_role
                .then_some(state.config.service_runtime_user_id)
                .flatten()
        })
        .ok_or_else(|| unauthorized("agent login requires an authenticated runtime owner"))?;
    let idle_ttl_seconds = coerce_idle_ttl(payload.idle_ttl_seconds);
    let display_name = payload
        .display_name
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;

    ensure_project_write_access(&transaction, &project, &auth_context, None).await?;

    let runtime = runtime::ensure_runtime_record(
        &transaction,
        &project_id,
        Some(Uuid::new_v4()),
        &runtime_provider,
        idle_ttl_seconds,
        display_name.as_deref(),
        Some(json!({ "source": "agent_login" })),
        true,
    )
    .await?;

    let runtime = runtime::mark_runtime_ready(&transaction, &runtime.id, idle_ttl_seconds).await?;

    let runtime_generation = Uuid::new_v4();
    let mut runtime_capabilities = runtime.capabilities.clone();
    runtime::set_runtime_generation_capability(&mut runtime_capabilities, runtime_generation);
    if !runtime_capabilities.is_object() {
        runtime_capabilities = json!({});
    }
    runtime::set_self_hosted_access_attestation(
        runtime_capabilities
            .as_object_mut()
            .expect("self-hosted capabilities normalized to an object"),
        runtime_owner,
    );
    transaction
        .execute(
            "update runtimes set capabilities = $2, updated_at = now() where id = $1",
            &[&runtime.id, &runtime_capabilities],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to persist agent login runtime generation: {error}"
            ))
        })?;

    runtime::record_runtime_event(
        &transaction,
        &runtime.id,
        &project.id,
        "login",
        json!({
            "provider": runtime_provider,
            "idle_ttl_seconds": idle_ttl_seconds,
            "strict_mode": state.config.strict_mode,
            "dev_isolation_mode": state.config.dev_isolation_mode,
            "display_name": display_name,
        }),
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit agent login: {error}")))?;

    let agent_token = issue_agent_token_for_runtime(
        &state.config,
        &project_id,
        &runtime.id,
        None,
        Some(runtime_generation),
        &runtime.provider,
        &runtime_capabilities,
    )?;
    let agent_token_issued_at =
        DateTime::<Utc>::from_timestamp(agent_token.issued_at, 0).map(|dt| dt.to_rfc3339());
    let agent_token_expires_at =
        DateTime::<Utc>::from_timestamp(agent_token.expires_at, 0).map(|dt| dt.to_rfc3339());
    let proxy = issue_proxy_envelope(
        &state.config,
        &project_id,
        &runtime.id,
        None,
        None,
        None,
        None,
        None,
    );

    info!(
        runtime_id = %runtime.id,
        project_id = %project_id,
        expires_in = agent_token.expires_in,
        "agent login issued new token"
    );
    publish_controller_event(
        &state.events,
        "runtime.login",
        Some(project.id),
        None,
        None,
        None,
        json!({
            "runtimeId": runtime.id,
            "strictMode": state.config.strict_mode,
            "devIsolationMode": state.config.dev_isolation_mode,
            "agentTokenIssuedAt": agent_token_issued_at,
            "agentTokenExpiresAt": agent_token_expires_at,
            "agentTokenTtl": agent_token.expires_in,
            "agentTokenScopes": agent_token.scopes,
        }),
    );

    Ok(Json(runtime::RuntimeRegisterResponse {
        runtime_id: runtime.id,
        agent_token: agent_token.token,
        agent_token_issued_at,
        agent_token_expires_at,
        agent_token_scopes: Some(agent_token.scopes.clone()),
        agent_token_ttl: Some(agent_token.expires_in),
        lease_url: state.config.lease_path.clone(),
        heartbeat_url: state.config.heartbeat_path.clone(),
        stop_url: Some(state.config.stop_path.clone()),
        lease_id: None,
        proxy,
        runtime_token: None,
    }))
}

#[instrument(skip(state, payload))]
pub(crate) async fn agent_lease(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: RedactedHeaders,
    axum::Json(payload): axum::Json<AgentLeasePayload>,
) -> Result<Json<AgentLeaseResponse>, (StatusCode, Json<ApiError>)> {
    let AgentLeasePayload {
        max,
        lease_seconds: payload_lease_seconds,
        runtime_id: runtime_id_raw,
        resources,
        supports_workspace_token,
    } = payload;

    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.lease"])?;
    let TokenContext {
        project_id,
        runtime_id: token_runtime_id,
        lease_id: token_lease_id,
        runtime_generation: token_runtime_generation,
    } = claims;
    // Leasing exposes job payloads and conversation history. Always require a
    // signed machine identity so runtime ownership and generation checks run,
    // including when a caller minted only the public agent.lease scope.
    let runtime_id =
        token_runtime_id.ok_or_else(|| unauthorized("agent token missing runtime scope"))?;
    info!(project_id = %project_id, "agent lease request");
    let runtime_override = runtime_id_raw
        .as_deref()
        .and_then(|value| Uuid::from_str(value).ok());

    // A request body is not an identity credential. Even outside strict mode,
    // a runtime-scoped agent token may only lease as its signed runtime ID;
    // otherwise exact Personal Browser targets can be spoofed by a teammate's
    // runtime in the same project.
    if !runtime_override_matches_token_scope(token_runtime_id, runtime_override) {
        return Err(forbidden(
            "runtime override does not match agent token runtime scope",
        ));
    }

    if let Some(resources) = resources {
        state
            .runtime_resource_usage
            .set(runtime_id, resources)
            .await;
    }
    let mut allow_untargeted_jobs = true;
    if let Some(preference) = state.runtime_preferences.get(&project_id).await {
        if let Some(preferred_runtime_id) = preference.runtime_id {
            let preference_is_project_shareable =
                workspace::fetch_runtime_candidate(&state.pool, &project_id, &preferred_runtime_id)
                    .await?
                    .is_some_and(|candidate| {
                        !runtime::runtime_is_private_self_hosted(
                            &state,
                            &candidate.provider,
                            &candidate.capabilities,
                        )
                    });
            if preference_is_project_shareable && runtime_id != preferred_runtime_id {
                publish_controller_event(
                    &state.events,
                    "runtime.dev_isolation",
                    Some(project_id),
                    None,
                    None,
                    None,
                    json!({
                        "action": "lease_restricted_to_targeted_jobs",
                        "preferredRuntimeId": preferred_runtime_id,
                        "requestedRuntimeId": runtime_id,
                        "source": preference.source,
                    }),
                );
                info!(
                    project_id = %project_id,
                    preferred_runtime = %preferred_runtime_id,
                    requested_runtime = %runtime_id,
                    "restricting lease to targeted jobs (preferred runtime pinned)"
                );
                allow_untargeted_jobs = false;
            }
        }
    }
    let requested_lease_seconds = payload_lease_seconds as i32;
    let mut lease_seconds = std::cmp::max(requested_lease_seconds, 30);
    if state.config.dev_isolation_mode {
        lease_seconds = lease_seconds.min(120);
        if lease_seconds != std::cmp::max(requested_lease_seconds, 30) {
            publish_controller_event(
                &state.events,
                "runtime.dev_isolation",
                Some(project_id),
                None,
                None,
                None,
                json!({
                    "action": "lease_seconds_clamped",
                    "requested": requested_lease_seconds,
                    "effective": lease_seconds,
                    "runtimeId": runtime_id
                }),
            );
        }
    }
    let mut max_jobs = max.clamp(1, 5);
    if state.config.strict_mode && max_jobs > 1 {
        warn!(
            project_id = %project_id,
            "strict mode clamps leased job count to 1"
        );
        max_jobs = 1;
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    ensure_runtime_can_lease(
        &state,
        &transaction,
        &project_id,
        &runtime_id,
        token_lease_id,
        token_runtime_generation,
    )
    .await?;
    runtime::touch_runtime_last_seen(&transaction, &runtime_id).await?;

    let mut jobs = Vec::new();
    let mut batch_mode = AgentLeaseBatchMode::None;
    let mut batch_conversation_id: Option<Uuid> = None;
    let mut batch_group_id: Option<String> = None;
    for _ in 0..max_jobs {
        match lease_next_agent_job(
            &transaction,
            &project_id,
            Some(&runtime_id),
            lease_seconds,
            allow_untargeted_jobs,
            batch_mode == AgentLeaseBatchMode::ReadOnly,
            batch_mode == AgentLeaseBatchMode::ExactWriteScoped,
            batch_mode != AgentLeaseBatchMode::None,
            batch_conversation_id.as_ref(),
            batch_group_id.as_deref(),
        )
        .await?
        {
            Some(mut job) => {
                let is_read_only_job = job_has_read_only_write_scope(&job);
                let is_exact_write_scoped_job = job_has_exact_owned_write_scope(&job);
                let is_runtime_spread_job = job_requests_runtime_spread(&job);
                let job_batch_group_id =
                    extract_multi_agent_group_id_from_job_payload(&job.payload);
                let (agent_handle, agent_display_name, agent_description) =
                    extract_agent_prompt_identity_from_job_payload(&job.payload);
                job.proxy = issue_proxy_envelope(
                    &state.config,
                    &project_id,
                    &runtime_id,
                    job.run_id.as_ref(),
                    job.credential_id.as_ref(),
                    agent_handle.as_deref(),
                    agent_display_name.as_deref(),
                    agent_description.as_deref(),
                );
                jobs.push(job);
                if jobs.len() == 1 {
                    if is_runtime_spread_job {
                        break;
                    } else if is_read_only_job && job_batch_group_id.is_some() {
                        batch_mode = AgentLeaseBatchMode::ReadOnly;
                        batch_conversation_id =
                            jobs.first().and_then(|leased| leased.conversation_id);
                        batch_group_id = job_batch_group_id;
                    } else if is_exact_write_scoped_job && job_batch_group_id.is_some() {
                        batch_mode = AgentLeaseBatchMode::ExactWriteScoped;
                        batch_conversation_id =
                            jobs.first().and_then(|leased| leased.conversation_id);
                        batch_group_id = job_batch_group_id;
                    } else {
                        break;
                    }
                }
            }
            None => break,
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit agent lease: {error}")))?;

    if !jobs.is_empty() {
        attach_controller_tokens(
            &state.config,
            Some(&runtime_id),
            token_lease_id.as_ref(),
            token_runtime_generation,
            supports_workspace_token,
            &mut jobs,
        );

        // UI relies on controller events for run status updates. When a runtime leases a queued job we
        // mark the run as in_progress (see `lease_next_agent_job`) and emit a `run.progress` event so
        // Studio can switch from "Starting…" to "Thinking…" without waiting for the first agent update.
        for job in jobs.iter() {
            let Some(run_uuid) = job.run_id else {
                continue;
            };
            let (event_session, event_conversation, run_payload) =
                match load_run_snapshot(&mut *connection, &run_uuid).await {
                    Ok(Some(snapshot)) => {
                        let session = snapshot.session_id;
                        let conversation = snapshot.conversation_id.or(job.conversation_id);
                        let run_json = run_snapshot_to_json(&snapshot);
                        (session, conversation, run_json)
                    }
                    Ok(None) => {
                        warn!(run_id = %run_uuid, "run snapshot missing after job lease");
                        (None, job.conversation_id, JsonValue::Null)
                    }
                    Err((status, Json(api_error))) => {
                        warn!(
                            run_id = %run_uuid,
                            status = status.as_u16(),
                            error = %api_error.message,
                            "failed to load run snapshot after job lease"
                        );
                        (None, job.conversation_id, JsonValue::Null)
                    }
                };

            publish_controller_event_with_conversation(
                &state.events,
                "run.progress",
                Some(project_id),
                event_session,
                event_conversation,
                Some(run_uuid),
                Some(job.id),
                json!({
                    "status": "in_progress",
                    "stage": "agent:leased",
                    "percent": 1,
                    "jobId": job.id,
                    "leaseMetrics": &job.lease_metrics,
                    "writeScope": extract_write_scope_from_job_payload(&job.payload),
                    "multiAgentPlan": extract_multi_agent_plan_from_job_payload(&job.payload),
                    "run": run_payload,
                }),
            );
        }
    }

    if jobs.is_empty() {
        info!(project_id = %project_id, "agent lease returned no jobs");
    } else {
        info!(
            project_id = %project_id,
            lease_count = jobs.len(),
            "agent lease returned work items"
        );
    }

    Ok(Json(AgentLeaseResponse { jobs }))
}

fn runtime_override_matches_token_scope(
    token_runtime_id: Option<Uuid>,
    runtime_override: Option<Uuid>,
) -> bool {
    match runtime_override {
        Some(runtime_override) => token_runtime_id == Some(runtime_override),
        None => true,
    }
}

fn runtime_record_can_lease(
    provider: &str,
    status: &str,
    capabilities: &JsonValue,
    is_private_self_hosted: bool,
) -> bool {
    if !matches!(status, "ready" | "running") {
        return false;
    }
    if is_private_self_hosted && runtime::self_hosted_owner_user_id(capabilities).is_none() {
        return false;
    }
    let personal_browser = capabilities
        .get("personalBrowser")
        .or_else(|| capabilities.get("personal_browser"));
    let Some(personal_browser) = personal_browser else {
        return true;
    };
    let provider_is_self_hosted =
        provider.trim().to_ascii_lowercase().replace('_', "-") == "self-hosted";
    let has_valid_owner = personal_browser.get("enabled").and_then(JsonValue::as_bool)
        == Some(true)
        && personal_browser
            .get("ownerUserId")
            .or_else(|| personal_browser.get("owner_user_id"))
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok())
            .is_some();
    provider_is_self_hosted && has_valid_owner
}

async fn ensure_runtime_can_lease(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    token_lease_id: Option<Uuid>,
    token_runtime_generation: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select provider, status, capabilities, active_lease_id
             from runtimes
             where id = $1 and project_id = $2
             for share",
            &[runtime_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to validate leasing runtime: {error}")))?;
    let Some(row) = row else {
        return Err(unauthorized(
            "agent token runtime is not registered for project",
        ));
    };
    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let capabilities: JsonValue = row.get("capabilities");
    let active_lease_id: Option<Uuid> = row.get("active_lease_id");
    ensure_agent_token_runtime_binding_matches(
        &capabilities,
        token_lease_id,
        active_lease_id,
        token_runtime_generation,
        runtime::runtime_is_private_self_hosted(state, &provider, &capabilities),
    )?;
    if !runtime_record_can_lease(
        &provider,
        &status,
        &capabilities,
        runtime::runtime_is_private_self_hosted(state, &provider, &capabilities),
    ) {
        return Err(forbidden("runtime is not eligible to lease jobs"));
    }
    Ok(())
}

fn runtime_status_can_heartbeat(status: &str) -> bool {
    matches!(status, "ready" | "running" | "draining")
}

fn ensure_agent_token_runtime_is_active(status: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
    if !runtime_status_can_heartbeat(status) {
        return Err(unauthorized("agent token runtime is no longer active"));
    }
    Ok(())
}

pub(crate) async fn ensure_runtime_can_heartbeat(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    token_lease_id: Option<Uuid>,
    token_runtime_generation: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    // Serialize renewal with runtime stop. Safe stop holds this row FOR UPDATE
    // while it checks active jobs and changes their disposition. Whichever
    // transaction gets the runtime lock first therefore wins cleanly: a live
    // heartbeat renews before stop checks the lease, or a completed stop makes
    // the waiting heartbeat observe the terminal status and reject renewal.
    let row = transaction
        .query_opt(
            "select provider, status, capabilities, active_lease_id
             from runtimes
             where id = $1 and project_id = $2
             for share",
            &[runtime_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to validate heartbeat runtime: {error}"))
        })?;

    let Some(row) = row else {
        return Err(unauthorized(
            "agent token runtime is not registered for project",
        ));
    };
    let status: String = row.get("status");
    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    let active_lease_id: Option<Uuid> = row.get("active_lease_id");
    ensure_agent_token_runtime_binding_matches(
        &capabilities,
        token_lease_id,
        active_lease_id,
        token_runtime_generation,
        runtime::runtime_is_private_self_hosted(state, &provider, &capabilities),
    )?;
    if !runtime_status_can_heartbeat(&status) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("runtime is no longer active")),
        ));
    }

    Ok(())
}

fn ensure_agent_token_generation_matches(
    token_lease_id: Option<Uuid>,
    active_lease_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if token_lease_id != active_lease_id {
        return Err(unauthorized(
            "agent token runtime lease scope is no longer active",
        ));
    }
    Ok(())
}

fn ensure_agent_token_runtime_binding_matches(
    capabilities: &JsonValue,
    token_lease_id: Option<Uuid>,
    active_lease_id: Option<Uuid>,
    token_runtime_generation: Option<Uuid>,
    is_private_self_hosted: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    ensure_agent_token_generation_matches(token_lease_id, active_lease_id)?;
    if is_private_self_hosted {
        if runtime::self_hosted_owner_user_id(capabilities).is_none() {
            return Err(unauthorized(
                "private self-hosted runtime is missing its controller owner attestation",
            ));
        }
        runtime::ensure_bound_runtime_generation_matches(capabilities, token_runtime_generation)?;
    }
    Ok(())
}

/// Validate that a runtime-scoped agent token belongs to the runtime's current
/// launch generation. Hosted runtime IDs can be reused across launches, so the
/// runtime ID alone is not sufficient authorization after a lease rotates.
async fn ensure_agent_token_matches_runtime_lease_with_cleanup_retry(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    context: &TokenContext,
    runtime_id: &Uuid,
    allow_cleanup_pending_retry: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.runtime_id != Some(*runtime_id) {
        return Err(unauthorized("agent token runtime scope mismatch"));
    }

    let row = transaction
        .query_opt(
            "select provider, status, capabilities, active_lease_id
             from runtimes
             where id = $1 and project_id = $2
             for share",
            &[runtime_id, &context.project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate agent token runtime lease scope: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Err(unauthorized(
            "agent token runtime is not registered for project",
        ));
    };
    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let capabilities: JsonValue = row.get("capabilities");
    let active_lease_id: Option<Uuid> = row.get("active_lease_id");
    ensure_agent_token_runtime_binding_matches(
        &capabilities,
        context.lease_id,
        active_lease_id,
        context.runtime_generation,
        runtime::runtime_is_private_self_hosted(state, &provider, &capabilities),
    )?;

    if allow_cleanup_pending_retry && status == "requested" {
        if let Some(active_lease_id) = active_lease_id {
            let cleanup_pending = transaction
                .query_opt(
                    "select 1
                     from runtime_leases
                     where id = $1
                       and project_id = $2
                       and runtime_id = $3
                       and status = 'cleanup_pending'
                       and released_at is null
                     for share",
                    &[&active_lease_id, &context.project_id, runtime_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to validate cleanup-pending agent token lease scope: {error}"
                    ))
                })?;
            if cleanup_pending.is_some() {
                return Ok(());
            }
        }
    }

    ensure_agent_token_runtime_is_active(&status)
}

/// Validate that an agent token still belongs to the current active runtime
/// generation. Non-active runtimes cannot retain general agent capabilities.
pub(crate) async fn ensure_agent_token_matches_runtime_lease(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    context: &TokenContext,
    runtime_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    ensure_agent_token_matches_runtime_lease_with_cleanup_retry(
        state,
        transaction,
        context,
        runtime_id,
        false,
    )
    .await
}

/// Stop/remove retries are the only operation retained by an exact runtime
/// generation after provider cleanup is quarantined. The runtime is no longer
/// generally active, but its unreleased `cleanup_pending` lease must remain
/// callable so the provider acknowledgement can finish the fenced stop.
pub(crate) async fn ensure_agent_token_matches_runtime_lease_for_stop(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    context: &TokenContext,
    runtime_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    ensure_agent_token_matches_runtime_lease_with_cleanup_retry(
        state,
        transaction,
        context,
        runtime_id,
        true,
    )
    .await
}

fn attach_controller_tokens(
    config: &AppConfig,
    runtime_id: Option<&Uuid>,
    runtime_lease_id: Option<&Uuid>,
    runtime_generation: Option<Uuid>,
    supports_workspace_token: bool,
    jobs: &mut [AgentJob],
) {
    for job in jobs.iter_mut() {
        // `job.token.workspace-separated` is a protocol promise, not merely a
        // runtime feature flag: a current runtime fails closed when the marker
        // is present without the separate credential. Only advertise it for a
        // job that actually requires (and therefore attempts to mint) that
        // credential. If minting then fails, retaining the marker deliberately
        // prevents the runtime from falling back to the model-facing token.
        let separate_workspace_token =
            supports_workspace_token && job_requires_internal_workspace_token(job, runtime_id);
        if let Some(token) = mint_job_controller_token(
            config,
            runtime_id,
            runtime_lease_id,
            runtime_generation,
            job,
            separate_workspace_token,
        ) {
            let MintedAccessToken {
                token,
                expires_at,
                scopes,
                ..
            } = token;

            job.controller_token = Some(token);
            job.controller_token_expires_at = Some(expires_at.to_rfc3339());
            job.controller_token_scopes = Some(scopes);
        }

        if separate_workspace_token {
            let Some(token) = mint_job_workspace_token(
                config,
                runtime_id,
                runtime_lease_id,
                runtime_generation,
                job,
            ) else {
                continue;
            };
            let MintedAccessToken {
                token,
                expires_at,
                scopes,
                ..
            } = token;

            job.workspace_token = Some(token);
            job.workspace_token_expires_at = Some(expires_at.to_rfc3339());
            job.workspace_token_scopes = Some(scopes);
        }
    }
}

fn job_controller_token_scopes(job: &AgentJob) -> Vec<String> {
    let mut scopes = vec!["prompt.execute".to_string()];
    // Fail closed on model-controlled provider execution. A project-level
    // `provider.call` scope is too broad until a grant also binds the exact
    // approved tool/resource ids, target device, run, runtime generation and
    // live lease. Human sessions may keep using the provider request routes;
    // ordinary model jobs receive no provider authority.
    // Writable runtime jobs use this short-lived, project/runtime/run-bound
    // token to acquire a workspace lease and delegate an origin fs.write token
    // after Codex produces file changes. Every normalized read-only signal is
    // authoritative, including single-agent jobs that intentionally omit a
    // writeScope assignment, so those jobs cannot acquire write leases.
    if !job_declares_read_only_execution(job) {
        scopes.push("fs.write".to_string());
    }
    scopes
}

fn mint_job_controller_token(
    config: &AppConfig,
    runtime_id: Option<&Uuid>,
    runtime_lease_id: Option<&Uuid>,
    runtime_generation: Option<Uuid>,
    job: &AgentJob,
    workspace_token_separated: bool,
) -> Option<MintedAccessToken> {
    let subject_user = extract_controller_subject_user_id(job).or(config.service_runtime_user_id);
    let Some(subject_user) = subject_user else {
        return None;
    };

    let runtime_scope = runtime_id
        .or(job.leased_by_runtime_id.as_ref())
        .map(|id| id.to_string());

    let audience = runtime_scope
        .clone()
        .unwrap_or_else(|| job.project_id.to_string());

    // Start from the read-only-aware base scopes: `prompt.execute` plus a
    // conditional `fs.write` that the import-hardening pass withholds from jobs
    // that declare read-only execution.
    let mut scopes = job_controller_token_scopes(job);
    // Every active job may mint a read-only Git credential. The controller
    // revalidates writeIntent, write scope, and plan-group ownership before it
    // will add git.write to a child token.
    scopes.push(crate::origins::JOB_GIT_TOKEN_MINT_SCOPE.to_string());
    if workspace_token_separated {
        scopes.push(crate::origins::JOB_TOKEN_SEPARATED_SCOPE.to_string());
    }

    let request = ScopedTokenRequest {
        audience,
        subject: subject_user.to_string(),
        project_id: job.project_id.to_string(),
        origin_id: None,
        runtime_id: runtime_scope,
        protocol: None,
        scopes,
        lease_id: runtime_lease_id.map(Uuid::to_string),
        run_id: job.run_id.map(|id| id.to_string()),
        prefer_runtime: None,
        ttl_seconds: None,
    };

    match mint_scoped_token_with_runtime_generation(config, request, runtime_generation) {
        Ok(token) => Some(token),
        Err((status, Json(error))) => {
            warn!(
                job_id = %job.id,
                project_id = %job.project_id,
                %status,
                error = %error.message,
                "failed to mint controller access token for job"
            );
            None
        }
    }
}

fn mint_job_workspace_token(
    config: &AppConfig,
    runtime_id: Option<&Uuid>,
    runtime_lease_id: Option<&Uuid>,
    runtime_generation: Option<Uuid>,
    job: &AgentJob,
) -> Option<MintedAccessToken> {
    if !job_requires_internal_workspace_token(job, runtime_id) {
        return None;
    }
    let subject_user = extract_controller_subject_user_id(job).or(config.service_runtime_user_id)?;
    let runtime_id = runtime_id.or(job.leased_by_runtime_id.as_ref())?;
    let run_id = job.run_id?;

    let request = ScopedTokenRequest {
        audience: runtime_id.to_string(),
        subject: subject_user.to_string(),
        project_id: job.project_id.to_string(),
        origin_id: None,
        runtime_id: Some(runtime_id.to_string()),
        protocol: None,
        scopes: vec![
            crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE.to_string(),
            crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE.to_string(),
        ],
        lease_id: runtime_lease_id.map(Uuid::to_string),
        run_id: Some(run_id.to_string()),
        prefer_runtime: None,
        // This credential is kept internal to the runtime-agent and every
        // mutation revalidates the still-leased job plus current project
        // role. It must outlive long Codex turns so commit does not fail after
        // the shorter, model-facing controller token expires.
        ttl_seconds: Some(config.agent_token_ttl_seconds.max(3600)),
    };

    match mint_scoped_token_with_runtime_generation(config, request, runtime_generation) {
        Ok(token) => Some(token),
        Err((status, Json(error))) => {
            warn!(
                job_id = %job.id,
                project_id = %job.project_id,
                %status,
                error = %error.message,
                "failed to mint internal workspace token for job"
            );
            None
        }
    }
}

fn job_requires_internal_workspace_token(job: &AgentJob, runtime_id: Option<&Uuid>) -> bool {
    if crate::origins::job_allows_workspace_mutation(&job.payload) {
        return true;
    }

    // A current runtime treats `job.token.workspace-separated` as a strict
    // protocol promise: the controller token can never double as the internal
    // workspace token. Shared Browser turns may carry a read-only workspace
    // scope, but the runtime verifies the separated credential before
    // entering that bounded lane. Issue it only when the database proves this
    // is the exact runtime selected at dispatch and leased now. Read-only
    // terminal commands stay on the unseparated controller token instead: the
    // runtime accepts it for non-workspace jobs, so the terminal lane never
    // receives a workspace credential it does not need. Although the protocol
    // requires the two workspace scopes, origin routes independently
    // revalidate writeIntent/writeScope against the active job, so a
    // read-only job cannot exercise either capability.
    let metadata = job.payload.get("metadata").and_then(JsonValue::as_object);
    let shared_browser = metadata
        .and_then(|metadata| {
            metadata
                .get("browserTransport")
                .or_else(|| metadata.get("browser_transport"))
        })
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"))
        .as_deref()
        == Some("shared");
    if !shared_browser {
        return false;
    }

    let Some(target_runtime_id) = job.target_runtime_id else {
        return false;
    };
    let leasing_runtime_id = runtime_id.copied().or(job.leased_by_runtime_id);
    leasing_runtime_id == Some(target_runtime_id)
        && job.leased_by_runtime_id == Some(target_runtime_id)
}

fn extract_controller_subject_user_id(job: &AgentJob) -> Option<Uuid> {
    job.payload
        .get("user_id")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Uuid::from_str(value).ok())
}

#[instrument(skip(state, headers, payload))]
pub(crate) async fn agent_heartbeat(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<AgentHeartbeatPayload>,
) -> Result<Json<AgentHeartbeatResponseBody>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.heartbeat"])?;
    let TokenContext {
        project_id,
        runtime_id,
        lease_id,
        runtime_generation,
    } = claims;

    let AgentHeartbeatPayload {
        job_id,
        extend_seconds,
        resources,
    } = payload;

    let job_uuid =
        Uuid::from_str(&job_id).map_err(|_| bad_request("job_id must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let runtime_uuid = runtime_id.ok_or_else(|| {
        unauthorized("agent token missing runtime scope while strict mode is enabled")
    })?;

    ensure_runtime_can_heartbeat(
        &state,
        &transaction,
        &project_id,
        &runtime_uuid,
        lease_id,
        runtime_generation,
    )
    .await?;
    runtime::touch_runtime_last_seen(&transaction, &runtime_uuid).await?;

    let extend_interval = extend_seconds
        .map(|value| value as f64)
        .unwrap_or(60.0)
        .max(30.0);

    let row = transaction
        .query_opt(
            "update agent_jobs
             set heartbeat_at = now(),
                 lease_expires_at = greatest(
                     now() + interval '1 second' * $4,
                     coalesce(lease_expires_at, now())
                 )
             where id = $1
               and project_id = $2
               and status = 'leased'
               and coalesce(leased_by_runtime_id, $3::uuid) = $3
             returning lease_expires_at",
            &[&job_uuid, &project_id, &runtime_uuid, &extend_interval],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update heartbeat: {error}")))?;

    let lease_expires_at: Option<DateTime<Utc>> = row.and_then(|record| record.get(0));

    if let Some(resources) = resources {
        state
            .runtime_resource_usage
            .set(runtime_uuid, resources)
            .await;
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit heartbeat: {error}")))?;

    if lease_expires_at.is_none() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("agent job lease is no longer active")),
        ));
    }

    let response = AgentHeartbeatResponseBody {
        ok: true,
        lease_expires_at: lease_expires_at.map(|dt| dt.to_rfc3339()),
    };

    Ok(Json(response))
}

/// Hold the exact leased job row through the assistant-message insert and
/// transaction commit. A concurrent human-answer cancellation then has one
/// deterministic winner: cancellation first makes this SELECT return no row;
/// message delivery first commits before cancellation can update the job.
fn agent_message_job_select_sql(runtime_scoped: bool) -> &'static str {
    if runtime_scoped {
        "select run_id,
                prompt_id,
                session_id,
                conversation_id,
                payload,
                created_at,
                leased_at,
                lease_attempts,
                leased_by_runtime_id
         from agent_jobs
         where id = $1
           and project_id = $2
           and status = 'leased'
           and coalesce(leased_by_runtime_id, $3::uuid) = $3
         for update"
    } else {
        "select run_id,
                prompt_id,
                session_id,
                conversation_id,
                payload,
                created_at,
                leased_at,
                lease_attempts,
                leased_by_runtime_id
         from agent_jobs
         where id = $1
           and project_id = $2
           and status = 'leased'
         for update"
    }
}

#[instrument(skip(state, headers, payload))]
pub(crate) async fn agent_message(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<AgentMessagePayload>,
) -> Result<Json<AgentMessageResponseBody>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.message"])?;
    let TokenContext {
        project_id,
        runtime_id: token_runtime_id,
        ..
    } = claims;

    let AgentMessagePayload {
        job_id,
        content,
        message_type,
        metadata,
    } = payload;

    let content_trimmed = content.trim();
    if content_trimmed.is_empty() {
        return Err(bad_request("content must not be empty"));
    }

    let job_uuid =
        Uuid::from_str(&job_id).map_err(|_| bad_request("job_id must be a valid UUID"))?;

    let runtime_scope = if state.config.strict_mode {
        Some(token_runtime_id.ok_or_else(|| {
            unauthorized("agent token missing runtime scope while strict mode is enabled")
        })?)
    } else {
        token_runtime_id
    };

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let mut transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    if let Some(runtime_uuid) = runtime_scope.as_ref() {
        ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, runtime_uuid)
            .await?;
    }

    let row = match runtime_scope {
        Some(runtime_uuid) => {
            transaction
                .query_opt(
                    agent_message_job_select_sql(true),
                    &[&job_uuid, &project_id, &runtime_uuid],
                )
                .await
        }
        None => {
            transaction
                .query_opt(
                    agent_message_job_select_sql(false),
                    &[&job_uuid, &project_id],
                )
                .await
        }
    }
    .map_err(|error| internal_error(format!("failed to load agent job: {error}")))?;

    let row = match row {
        Some(row) => row,
        None => {
            if state.config.strict_mode {
                return Err(forbidden(
                    "job must be leased by the same runtime that posts messages while strict mode is enabled",
                ));
            }
            return Err(not_found("agent job not found or not leased"));
        }
    };

    let mut conversation_id: Option<Uuid> = row.get("conversation_id");
    let mut session_id: Option<Uuid> = row.get("session_id");
    let mut prompt_id: Option<Uuid> = row.get("prompt_id");
    let run_id: Option<Uuid> = row.get("run_id");
    let job_payload: JsonValue = row.get::<_, PgJson<JsonValue>>("payload").0;
    let lease_metrics = build_agent_lease_metrics(
        &job_payload,
        row.get("created_at"),
        row.get("leased_at"),
        None,
        row.get("lease_attempts"),
        row.get("leased_by_runtime_id"),
        None,
    );

    if conversation_id.is_none() {
        conversation_id = job_payload
            .get("conversation_id")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::from_str(value).ok());
    }
    if session_id.is_none() {
        session_id = job_payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::from_str(value).ok());
    }
    if prompt_id.is_none() {
        prompt_id = job_payload
            .get("prompt_id")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::from_str(value).ok());
    }

    let Some(conversation_uuid) = conversation_id else {
        return Err(bad_request(
            "agent job is not associated with a conversation",
        ));
    };

    // CONTROLLER EVALUATION: marked runs arbitrate their own participation.
    // A decline is the bare NO_RESPONSE sentinel as the run's first
    // conversational output; the controller swallows it (never persisted or
    // broadcast), records the decline on the job/run, and the job completes
    // as a normal success. A NO_RESPONSE on a non-evaluation run, or after
    // the run already streamed a visible assistant message, is persisted
    // verbatim — a direct answer is never silently eaten.
    if crate::group_participation::job_payload_marks_agent_evaluation(&job_payload)
        && agent_message_can_drive_evaluation(message_type.as_deref(), metadata.as_ref())
    {
        if crate::group_participation::is_group_participation_decline_sentinel(content_trimmed) {
            if !run_has_visible_assistant_message(&transaction, &project_id, run_id).await? {
                record_agent_evaluation_decline(&transaction, &project_id, &job_uuid, run_id)
                    .await?;
                transaction.commit().await.map_err(|error| {
                    internal_error(format!("failed to commit swallowed agent decline: {error}"))
                })?;
                return Ok(Json(AgentMessageResponseBody { ok: true }));
            }
        } else {
            // The agent chose to speak. Ambient evaluations land deferred
            // managed-AI billing here; normally billed automation evaluations
            // make this helper a no-op.
            let leased_by_runtime_id: Option<Uuid> = row.get("leased_by_runtime_id");
            apply_deferred_managed_ai_billing_on_first_visible_message(
                &state,
                &mut transaction,
                &project_id,
                &job_uuid,
                &job_payload,
                run_id,
                prompt_id,
                leased_by_runtime_id,
            )
            .await?;
        }
    }

    // Retain runtime preference metadata on streamed agent updates.
    let metadata_value = attach_lease_metrics_to_metadata(
        merge_runtime_preference_from_job_payload(
            build_agent_update_metadata(&job_uuid, message_type.as_deref(), metadata),
            &job_payload,
        ),
        Some(&lease_metrics),
    );
    let metadata_value = sanitize_json_for_postgres(metadata_value);
    let message_row = record_agent_conversation_message(
        &transaction,
        &project_id,
        &conversation_uuid,
        session_id,
        prompt_id,
        run_id,
        sanitize_postgres_text(content_trimmed),
        metadata_value,
    )
    .await?;
    let multi_agent_plan_metadata = message_row.metadata.clone();
    let multi_agent_plan_content = message_row.content.clone();
    let multi_agent_plan_job_payload = job_payload.clone();

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit agent message: {error}")))?;

    publish_conversation_message_event(&state.events, &message_row);
    crate::notifications::enqueue_message_push_notifications(state.clone(), message_row);
    if let Err((status, Json(api_error))) =
        crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
            &state,
            &multi_agent_plan_job_payload,
            job_uuid,
            run_id,
            &multi_agent_plan_metadata,
            multi_agent_plan_content.as_str(),
        )
        .await
    {
        warn!(
            project_id = %project_id,
            job_id = %job_uuid,
            status = status.as_u16(),
            error = %api_error.message,
            "failed to execute skill-authored multi-agent plan"
        );
    }

    Ok(Json(AgentMessageResponseBody { ok: true }))
}

/// Message types that stream tool/status telemetry rather than the agent
/// conversationally speaking; they never count as the run's visible answer.
const NON_CONVERSATIONAL_AGENT_MESSAGE_TYPES: [&str; 5] = [
    "command_execution",
    "mcp_tool_call",
    "web_search",
    "file_change",
    "status",
];

fn agent_message_type_is_conversational(message_type: Option<&str>) -> bool {
    match message_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(kind) => !NON_CONVERSATIONAL_AGENT_MESSAGE_TYPES
            .iter()
            .any(|excluded| kind.eq_ignore_ascii_case(excluded)),
        None => true,
    }
}

fn agent_message_can_drive_evaluation(
    message_type: Option<&str>,
    metadata: Option<&JsonValue>,
) -> bool {
    if agent_message_type_is_conversational(message_type) {
        return true;
    }

    // The runtime agent represents a plain-text final assistant item as a
    // status update with `kind=agent_message`. Treat that adapter shape as the
    // conversational result so an authenticated NO_RESPONSE is swallowed
    // before it can be persisted or notified.
    message_type.is_some_and(|kind| kind.trim().eq_ignore_ascii_case("status"))
        && metadata
            .and_then(JsonValue::as_object)
            .and_then(|map| map.get("kind"))
            .and_then(JsonValue::as_str)
            .is_some_and(|kind| kind.eq_ignore_ascii_case("agent_message"))
}

fn completion_is_successful_explicit_decline(
    outcome: &str,
    summary: Option<&str>,
    error_message: Option<&str>,
    job_marks_agent_evaluation: bool,
    job_marks_agent_declined: bool,
) -> bool {
    if outcome != "succeeded" || error_message.is_some() {
        return false;
    }

    let summary_is_decline =
        summary.is_some_and(crate::group_participation::is_group_participation_decline_sentinel);
    if job_marks_agent_evaluation {
        return summary_is_decline;
    }

    job_marks_agent_declined
        && summary.is_none_or(|value| value.trim().is_empty() || summary_is_decline)
}

fn select_completion_message_content<'a>(
    outcome: &str,
    summary: Option<&'a str>,
    error_message: Option<&'a str>,
    authenticated_evaluation: bool,
) -> Option<&'a str> {
    if !authenticated_evaluation {
        // Preserve the established completion contract for ordinary jobs,
        // including summary precedence and verbatim blank summaries.
        return summary.or(error_message);
    }

    let meaningful_summary = summary.filter(|value| !value.trim().is_empty());
    let meaningful_error = error_message.filter(|value| !value.trim().is_empty());
    if error_message.is_some() {
        return meaningful_error.or_else(|| {
            meaningful_summary.filter(|value| {
                !crate::group_participation::is_group_participation_decline_sentinel(value)
            })
        });
    }
    if outcome == "succeeded" {
        meaningful_summary.or(meaningful_error)
    } else {
        // An authenticated evaluation must never let a decline sentinel hide
        // the actual failure text.
        meaningful_error.or(meaningful_summary)
    }
}

async fn run_has_visible_assistant_message(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    run_id: Option<Uuid>,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let Some(run_uuid) = run_id else {
        return Ok(false);
    };
    // Tool/status telemetry and controller notices (runtime alerts,
    // cancellations) are not the agent conversationally speaking.
    transaction
        .query_one(
            "select exists (
                 select 1
                 from conversation_messages
                 where project_id = $1
                   and run_id = $2
                   and role = 'assistant'
                   and created_by is null
                   and nullif(btrim(content), '') is not null
                   and (
                       lower(coalesce(metadata #>> '{messageType}', metadata #>> '{message_type}', ''))
                           not in ('command_execution', 'mcp_tool_call', 'web_search', 'file_change',
                                   'status', 'runtime_alert', 'run_cancellation', 'runtime_switch',
                                   'agent_job_thread', 'token_usage', 'reasoning')
                       or (
                           lower(coalesce(metadata #>> '{messageType}', metadata #>> '{message_type}', '')) = 'status'
                           and lower(coalesce(metadata #>> '{details,kind}', '')) = 'agent_message'
                       )
                   )
                   and lower(coalesce(metadata #>> '{kind}', ''))
                       not in ('runtime_alert', 'run_cancellation', 'runtime_switch',
                               'agent_job_thread')
             )",
            &[project_id, &run_uuid],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| {
            internal_error(format!(
                "failed to check run assistant message visibility: {error}"
            ))
        })
}

/// Record a swallowed authenticated evaluation decline on the job payload
/// (and run metadata) so the transcript shows that arbitration happened even
/// though no assistant message was persisted.
async fn record_agent_evaluation_decline(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let marker = crate::group_participation::agent_declined_marker();
    let marker_param = PgJson(&marker);
    transaction
        .execute(
            "update agent_jobs
             set payload = jsonb_set(
                     jsonb_set(
                         coalesce(payload, '{}'::jsonb),
                         '{metadata}',
                         coalesce(payload -> 'metadata', '{}'::jsonb),
                         true
                     ),
                     '{metadata,groupParticipation}',
                     $3::jsonb,
                     true
                 )
             where id = $1 and project_id = $2",
            &[job_id, project_id, &marker_param],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to record agent evaluation decline on job: {error}"
            ))
        })?;
    if let Some(run_uuid) = run_id {
        transaction
            .execute(
                "update runs
                 set metadata = jsonb_set(
                         coalesce(metadata, '{}'::jsonb),
                         '{groupParticipation}',
                         $2::jsonb,
                         true
                     ),
                     updated_at = now()
                 where id = $1",
                &[&run_uuid, &marker_param],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to record agent evaluation decline on run: {error}"
                ))
            })?;
    }
    Ok(())
}

/// SKILL-MODE deferred billing: an ambient evaluation dispatched without a
/// burn pays for its managed-AI prompt the moment the agent visibly speaks.
/// The burn is idempotent on the same reserve key dispatch would have used,
/// so completion-time usage reconciliation keeps working unchanged.
#[allow(clippy::too_many_arguments)]
async fn apply_deferred_managed_ai_billing_on_first_visible_message(
    state: &AppState,
    transaction: &mut tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    job_payload: &JsonValue,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    leased_runtime_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    // Only ambient skill-mode evaluations are eligible for deferred managed
    // billing. Scheduled automations reuse the authenticated evaluation
    // protocol for NO_RESPONSE, but remain normally billed/BYOC runs even if
    // untrusted automation metadata contains a forged deferral flag.
    if !crate::group_participation::job_payload_marks_skill_mode_ambient_evaluation(job_payload) {
        return Ok(());
    }
    let job_metadata = job_payload.get("metadata").and_then(JsonValue::as_object);
    let billing_deferred = job_metadata
        .and_then(|map| map.get("managedAiBillingDeferred"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let already_marked_used = job_metadata
        .and_then(|map| map.get("managedAiUsed"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    if !billing_deferred || already_marked_used {
        return Ok(());
    }
    let Some(prompt_uuid) = prompt_id else {
        return Ok(());
    };

    let project = load_project_record(transaction, project_id).await?;
    let Some(org_id) = project.org_id else {
        return Ok(());
    };

    let mut burn_metadata = json!({
        "source": "managed_ai",
        "billingKind": "skill_mode_deferred",
        "promptId": prompt_uuid,
        "jobId": job_id,
    });
    // The burn runs inside a savepoint: a ledger-trigger rejection (e.g.
    // insufficient credits) must not poison the transaction that persists the
    // agent's message. The agent already spoke — never drop its message over
    // billing; completion-time usage reconciliation still charges real usage.
    let savepoint_result = {
        let savepoint = transaction
            .savepoint("deferred_managed_ai_burn")
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to open deferred managed AI burn savepoint: {error}"
                ))
            })?;
        match crate::credits::process_credit_burn(
            &savepoint,
            project_id,
            &org_id,
            leased_runtime_id,
            state.config.managed_ai_credit_burn_amount,
            "managed_ai_prompt",
            Some(&format!("managed-ai-prompt:{prompt_uuid}")),
            &mut burn_metadata,
        )
        .await
        {
            Ok(_) => savepoint.commit().await.map(|_| true),
            Err((status, Json(api_error))) => {
                warn!(
                    project_id = %project_id,
                    job_id = %job_id,
                    prompt_id = %prompt_uuid,
                    status = status.as_u16(),
                    error = %api_error.message,
                    "deferred managed AI burn failed; persisting agent message unbilled"
                );
                savepoint.rollback().await.map(|_| false)
            }
        }
    };
    savepoint_result.map_err(|error| {
        internal_error(format!(
            "failed to finalize deferred managed AI burn savepoint: {error}"
        ))
    })?;

    // Flip the usage mark so the daily prompt count and completion-time usage
    // reconciliation treat this run as a billed managed prompt.
    crate::dispatch::persist_prompt_ai_access_metadata(transaction, &prompt_uuid, true, true)
        .await?;
    if let Some(run_uuid) = run_id {
        crate::dispatch::persist_run_ai_access_metadata(transaction, &[run_uuid], true, true)
            .await?;
    }
    transaction
        .execute(
            "update agent_jobs
             set payload = jsonb_set(
                     jsonb_set(
                         coalesce(payload, '{}'::jsonb),
                         '{metadata}',
                         coalesce(payload -> 'metadata', '{}'::jsonb),
                         true
                     ),
                     '{metadata,managedAiUsed}',
                     'true'::jsonb,
                     true
                 )
             where id = $1 and project_id = $2",
            &[job_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to mark deferred managed AI usage on job: {error}"
            ))
        })?;
    Ok(())
}

#[instrument(skip(state, headers, payload))]
pub(crate) async fn agent_complete(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<AgentCompletePayload>,
) -> Result<Json<AgentCompleteResponseBody>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.complete"])?;
    let TokenContext {
        project_id,
        runtime_id: token_runtime_id,
        ..
    } = claims;

    let AgentCompletePayload {
        job_id,
        outcome,
        summary,
        error_message,
        artifacts,
        proxy_metadata,
    } = payload;
    let summary = summary.map(|value| sanitize_postgres_text(&value));
    let error_message = error_message.map(|value| sanitize_postgres_text(&value));
    let proxy_metadata = proxy_metadata.map(sanitize_json_for_postgres);

    let job_uuid =
        Uuid::from_str(&job_id).map_err(|_| bad_request("job_id must be a valid UUID"))?;
    let outcome_lower = outcome.to_lowercase();
    let job_status = match outcome_lower.as_str() {
        "succeeded" => "completed",
        "canceled" => "canceled",
        "expired" => "expired",
        "failed" => "failed",
        other => return Err(bad_request(format!("invalid outcome: {other}"))),
    };
    let run_status = match outcome_lower.as_str() {
        "succeeded" => "success",
        "canceled" => "canceled",
        "expired" => "canceled",
        "failed" => "failed",
        _ => unreachable!(),
    };
    let final_status_string = run_status.to_string();
    let runtime_scope = if state.config.strict_mode {
        Some(token_runtime_id.ok_or_else(|| {
            unauthorized("agent token missing runtime scope while strict mode is enabled")
        })?)
    } else {
        token_runtime_id
    };

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    if let Some(runtime_uuid) = runtime_scope.as_ref() {
        ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, runtime_uuid)
            .await?;
    }

    let artifacts_value =
        sanitize_json_for_postgres(artifacts.unwrap_or_else(|| JsonValue::Array(Vec::new())));
    // Cap only what gets STORED. artifacts_value stays intact below for usage/
    // billing and prompt-context extraction; only the persisted copy is replaced
    // with a marker when it exceeds the size cap.
    let stored_artifacts = cap_artifacts_payload(&artifacts_value);
    let artifacts_json = PgJson(stored_artifacts.as_ref());
    let summary_ref = summary.as_deref();
    let error_ref = error_message.as_deref();
    let artifacts_count = artifacts_value.as_array().map(|arr| arr.len());

    let row = match runtime_scope {
        Some(runtime_uuid) => {
            transaction
                .query_opt(
                    "update agent_jobs
                     set status = $3,
                         outcome = $4,
                         summary = $5,
                         error_message = $6,
                         artifacts = coalesce($7::jsonb, '[]'::jsonb),
                         completed_at = now(),
                         lease_expires_at = null,
                         active_input_ready_runtime_id = null,
                         active_input_ready_expires_at = null,
                         active_input_ready_turn_id = null,
                         heartbeat_at = now()
                     where id = $1
                       and project_id = $2
                       and status in ('leased','queued')
                       and coalesce(leased_by_runtime_id, $8::uuid) = $8
                     returning id,
                               project_id,
                               run_id,
                               conversation_id,
                               leased_by_runtime_id,
	                               payload,
	                               created_at,
	                               leased_at,
                               completed_at,
	                               lease_attempts",
                    &[
                        &job_uuid,
                        &project_id,
                        &job_status,
                        &outcome_lower,
                        &summary_ref,
                        &error_ref,
                        &artifacts_json,
                        &runtime_uuid,
                    ],
                )
                .await
        }
        None => {
            transaction
                .query_opt(
                    "update agent_jobs
                     set status = $3,
                         outcome = $4,
                         summary = $5,
                         error_message = $6,
                         artifacts = coalesce($7::jsonb, '[]'::jsonb),
                         completed_at = now(),
                         lease_expires_at = null,
                         active_input_ready_runtime_id = null,
                         active_input_ready_expires_at = null,
                         active_input_ready_turn_id = null,
                         heartbeat_at = now()
                     where id = $1 and project_id = $2 and status in ('leased','queued')
                     returning id,
                               project_id,
                               run_id,
                               conversation_id,
                               leased_by_runtime_id,
	                               payload,
	                               created_at,
	                               leased_at,
                               completed_at,
	                               lease_attempts",
                    &[
                        &job_uuid,
                        &project_id,
                        &job_status,
                        &outcome_lower,
                        &summary_ref,
                        &error_ref,
                        &artifacts_json,
                    ],
                )
                .await
        }
    }
    .map_err(|error| internal_error(format!("failed to complete job: {error}")))?;

    let row = match row {
        Some(row) => row,
        None => {
            if state.config.strict_mode {
                return Err(forbidden(
                    "job must be leased by the same runtime that completes it while strict mode is enabled",
                ));
            }
            return Err(not_found("agent job not found or already completed"));
        }
    };

    // Completion and human steering serialize on the agent_jobs row. Any
    // unacknowledged command is rejected in the same transaction. A command
    // already claimed by this runtime/lease may still deliver a late `applied`
    // acknowledgement when Codex accepted it immediately before completion.
    let job_input_state_updates =
        crate::send_intents::reject_unclaimed_inputs_for_completed_job(&transaction, &job_uuid)
            .await?;

    let project_id: Uuid = row.get("project_id");
    let run_id: Option<Uuid> = row.get("run_id");
    let job_row_conversation_id: Option<Uuid> = row.get("conversation_id");
    let leased_runtime_id: Option<Uuid> = row.get("leased_by_runtime_id");
    let job_payload: JsonValue = row.get::<_, PgJson<JsonValue>>("payload").0;
    let lease_metrics = build_agent_lease_metrics(
        &job_payload,
        row.get("created_at"),
        row.get("leased_at"),
        row.get("completed_at"),
        row.get("lease_attempts"),
        leased_runtime_id,
        None,
    );

    let job_session_id = job_payload
        .get("session_id")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::from_str(value).ok());
    let job_conversation_id = job_payload
        .get("conversation_id")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::from_str(value).ok());
    let job_prompt_id = job_payload
        .get("prompt_id")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::from_str(value).ok());

    if let Some(run_uuid) = run_id {
        // Mark the run as completed. We intentionally clear `progress_stage` so the frontend
        // doesn't interpret a stale "agent:leased" stage as an active/blocked run after completion.
        transaction
            .execute(
                "update runs
                 set status = $2,
                     progress = greatest(progress, 100),
                     progress_stage = null,
                     last_message = coalesce($3, last_message),
                     updated_at = now()
                 where id = $1",
                &[&run_uuid, &run_status, &summary_ref],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update run: {error}")))?;
    }

    let mut run_session_id: Option<Uuid> = job_session_id;
    let mut run_conversation_id: Option<Uuid> = job_row_conversation_id.or(job_conversation_id);
    let mut run_prompt_id: Option<Uuid> = job_prompt_id;

    if let Some(run_uuid) = run_id {
        if let Some(run_row) = transaction
            .query_opt(
                "select session_id, conversation_id, prompt_id from runs where id = $1",
                &[&run_uuid],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load run context: {error}")))?
        {
            let session: Option<Uuid> = run_row.get("session_id");
            let conversation: Option<Uuid> = run_row.get("conversation_id");
            let prompt: Option<Uuid> = run_row.get("prompt_id");
            if run_session_id.is_none() {
                run_session_id = session;
            }
            if run_conversation_id.is_none() {
                run_conversation_id = conversation;
            }
            if run_prompt_id.is_none() {
                run_prompt_id = prompt;
            }
        }
    }

    // A run that ended with "nothing to report" (the explicit decline an
    // automation or evaluation uses) is silence, not activity: no ledger row.
    let silent_completion = completion_is_successful_explicit_decline(
        &outcome_lower,
        summary.as_deref(),
        error_message.as_deref(),
        crate::group_participation::job_payload_marks_agent_evaluation(&job_payload),
        crate::group_participation::job_payload_marks_agent_declined(&job_payload),
    );
    if let (Some(run_uuid), false) = (run_id, silent_completion) {
        // Home's feed: the run reached a terminal state.
        crate::activity::record_run_completed(
            &transaction,
            &project_id,
            &run_uuid,
            run_conversation_id,
            run_prompt_id,
            &job_payload,
            run_status == "success",
            summary_ref,
            error_ref,
        )
        .await;
    }

    let provider_value = extract_provider_from_metadata(&proxy_metadata);
    let credit_snapshot_value = extract_credit_snapshot(&proxy_metadata);
    let suggested_replies = extract_ui_suggested_replies(&proxy_metadata);

    if let Some(run_uuid) = run_id {
        let conversation_state = extract_provider_conversation_state(&proxy_metadata);
        if let Err(error) = persist_run_completion_metadata(
            &transaction,
            &run_uuid,
            provider_value.as_deref(),
            conversation_state.as_ref(),
            credit_snapshot_value.as_ref(),
            summary_ref,
            error_ref,
            artifacts_count,
        )
        .await
        {
            warn!(
                run_id = %run_uuid,
                ?error,
                "failed to persist run completion metadata"
            );
        }
    }

    if let Some(runtime_id) = leased_runtime_id {
        let event_payload = json!({
            "job_id": job_uuid,
            "run_id": run_id,
            "outcome": outcome_lower,
            "artifacts_count": artifacts_value.as_array().map(|arr| arr.len()),
            "provider": provider_value,
        });
        runtime::record_runtime_event_with_conversation(
            &transaction,
            &runtime_id,
            &project_id,
            run_conversation_id.as_ref(),
            "agent.complete",
            event_payload,
        )
        .await?;
    }

    let tool_update_count =
        count_job_tool_update_messages(&transaction, &project_id, &job_uuid).await?;
    let lease_metrics = AgentLeaseMetrics {
        tool_update_count: (tool_update_count > 0).then_some(tool_update_count),
        ..lease_metrics
    };

    let mut token_usage_message: Option<ConversationMessageRow> = None;
    let mut assistant_message: Option<ConversationMessageRow> = None;
    if let Some(conversation_uuid) = run_conversation_id {
        let explicit_successful_decline = completion_is_successful_explicit_decline(
            &outcome_lower,
            summary.as_deref(),
            error_message.as_deref(),
            crate::group_participation::job_payload_marks_agent_evaluation(&job_payload),
            crate::group_participation::job_payload_marks_agent_declined(&job_payload),
        );
        let should_swallow_evaluation_decline = explicit_successful_decline
            && !run_has_visible_assistant_message(&transaction, &project_id, run_id).await?;

        if let Some(usage) = extract_turn_usage_from_artifacts(&artifacts_value) {
            let managed_ai_metadata = job_payload.get("metadata").and_then(JsonValue::as_object);
            let managed_ai_used = managed_ai_metadata
                .and_then(|metadata| metadata.get("managedAiUsed"))
                .and_then(JsonValue::as_bool)
                .unwrap_or(false);
            if managed_ai_used {
                let prompt_id_for_billing = run_prompt_id.or(job_prompt_id);
                if let Some(prompt_uuid) = prompt_id_for_billing {
                    let project = load_project_record(&transaction, &project_id).await?;
                    let org_id = project
                        .org_id
                        .ok_or_else(|| internal_error("managed AI project missing organization"))?;
                    let managed_ai_label = managed_ai_metadata
                        .and_then(|metadata| metadata.get("managedAiLabel"))
                        .and_then(JsonValue::as_str)
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    match reconcile_managed_ai_usage_charge(
                        &transaction,
                        &state.config,
                        &project_id,
                        &org_id,
                        leased_runtime_id,
                        &prompt_uuid,
                        provider_value.as_deref(),
                        managed_ai_label.as_deref(),
                        ManagedAiTokenUsage {
                            input_tokens: usage.input_tokens,
                            cached_input_tokens: usage.cached_input_tokens,
                            output_tokens: usage.output_tokens,
                        },
                    )
                    .await
                    {
                        Ok(charge) => {
                            if let Some(run_uuid) = run_id {
                                let reserve_key = format!("managed-ai-prompt:{prompt_uuid}");
                                let adjustment_key = format!("managed-ai-adjustment:{prompt_uuid}");
                                let reserve = crate::credits::load_credit_ledger_reference_by_idempotency_key(
                                    &transaction,
                                    &org_id,
                                    &project_id,
                                    &reserve_key,
                                )
                                .await;
                                let adjustment = crate::credits::load_credit_ledger_reference_by_idempotency_key(
                                    &transaction,
                                    &org_id,
                                    &project_id,
                                    &adjustment_key,
                                )
                                .await;
                                let reserve = match reserve {
                                    Ok(value) => {
                                        value.map(|entry| json!(entry)).unwrap_or_else(|| {
                                            json!({
                                                "ledgerId": JsonValue::Null,
                                                "idempotencyKey": reserve_key,
                                                "reason": "managed_ai_prompt",
                                                "delta": -(charge.reserve_units.abs()),
                                            })
                                        })
                                    }
                                    Err((status, Json(api_error))) => {
                                        warn!(
                                            project_id = %project_id,
                                            prompt_id = %prompt_uuid,
                                            status = status.as_u16(),
                                            error = %api_error.message,
                                            "failed to resolve managed AI reserve ledger reference"
                                        );
                                        json!({
                                            "ledgerId": JsonValue::Null,
                                            "idempotencyKey": reserve_key,
                                            "reason": "managed_ai_prompt",
                                            "delta": -(charge.reserve_units.abs()),
                                        })
                                    }
                                };
                                let adjustment = match adjustment {
                                    Ok(value) => {
                                        value.map(|entry| json!(entry)).unwrap_or_else(|| {
                                            json!({
                                                "ledgerId": JsonValue::Null,
                                                "idempotencyKey": adjustment_key,
                                                "reason": "managed_ai_adjustment",
                                                "delta": charge.adjustment_units,
                                            })
                                        })
                                    }
                                    Err((status, Json(api_error))) => {
                                        warn!(
                                            project_id = %project_id,
                                            prompt_id = %prompt_uuid,
                                            status = status.as_u16(),
                                            error = %api_error.message,
                                            "failed to resolve managed AI adjustment ledger reference"
                                        );
                                        json!({
                                            "ledgerId": JsonValue::Null,
                                            "idempotencyKey": adjustment_key,
                                            "reason": "managed_ai_adjustment",
                                            "delta": charge.adjustment_units,
                                        })
                                    }
                                };
                                let managed_ai_credit = json!({
                                    "promptId": prompt_uuid,
                                    "reserve": reserve,
                                    "adjustment": adjustment,
                                    "charge": {
                                        "reservedUnits": charge.reserve_units,
                                        "chargedUnits": charge.charged_units,
                                        "adjustmentUnits": charge.adjustment_units,
                                        "inputUsdMicros": charge.input_cost_usd_micros,
                                        "cachedInputUsdMicros": charge.cached_input_cost_usd_micros,
                                        "outputUsdMicros": charge.output_cost_usd_micros,
                                        "estimatedUsdMicros": charge.total_cost_usd_micros,
                                    }
                                });
                                if let Err((status, Json(api_error))) =
                                    crate::dispatch::persist_run_managed_ai_credit_metadata(
                                        &transaction,
                                        &[run_uuid],
                                        &managed_ai_credit,
                                    )
                                    .await
                                {
                                    warn!(
                                        project_id = %project_id,
                                        prompt_id = %prompt_uuid,
                                        status = status.as_u16(),
                                        error = %api_error.message,
                                        "failed to persist managed AI credit trace onto run"
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            warn!(
                                project_id = %project_id,
                                prompt_id = %prompt_uuid,
                                ?error,
                                "failed to attach managed AI usage metadata to credit ledger entry"
                            );
                        }
                    }
                }
            }

            if !should_swallow_evaluation_decline {
                let usage_content = format!(
                    "Token usage — input: {}, cached: {}, output: {}",
                    usage.input_tokens, usage.cached_input_tokens, usage.output_tokens
                );
                let mut details = json!({
                    "kind": "codex_turn_usage",
                    "usage": {
                        "input_tokens": usage.input_tokens,
                        "cached_input_tokens": usage.cached_input_tokens,
                        "output_tokens": usage.output_tokens,
                    }
                });
                if let Some(prompt_context) =
                    extract_prompt_context_from_artifacts(&artifacts_value)
                {
                    if let Some(details_map) = details.as_object_mut() {
                        details_map.insert("context".to_string(), prompt_context);
                    }
                }
                let usage_metadata = attach_lease_metrics_to_metadata(
                    merge_runtime_preference_from_job_payload(
                        build_agent_update_metadata(&job_uuid, Some("token_usage"), Some(details)),
                        &job_payload,
                    ),
                    Some(&lease_metrics),
                );
                let usage_metadata = sanitize_json_for_postgres(usage_metadata);
                let message_row = record_agent_conversation_message(
                    &transaction,
                    &project_id,
                    &conversation_uuid,
                    run_session_id,
                    run_prompt_id,
                    run_id,
                    usage_content,
                    usage_metadata,
                )
                .await?;
                token_usage_message = Some(message_row);
            }
        }

        // The codex-embedded provider delivers its final text via this
        // completion summary rather than a streamed /agent/message, so the
        // authenticated evaluation decline swallow must cover this path too:
        // a marked run completing with the bare sentinel (and no visible
        // answer streamed earlier) records the decline and posts nothing.
        if should_swallow_evaluation_decline {
            record_agent_evaluation_decline(&transaction, &project_id, &job_uuid, run_id).await?;
        } else {
            let authenticated_evaluation =
                crate::group_participation::job_payload_marks_agent_evaluation(&job_payload)
                    || crate::group_participation::job_payload_marks_agent_declined(&job_payload);
            let message_content = select_completion_message_content(
                &outcome_lower,
                summary.as_deref(),
                error_message.as_deref(),
                authenticated_evaluation,
            )
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                format!("Agent job {} finished with status {}", job_uuid, run_status)
            });
            // Apply the runtime preference to the final assistant message as well.
            let message_metadata = attach_lease_metrics_to_metadata(
                merge_runtime_preference_from_job_payload(
                    build_agent_message_metadata(
                        &outcome_lower,
                        provider_value.as_deref(),
                        artifacts_count,
                        &artifacts_value,
                        credit_snapshot_value.as_ref(),
                        error_message.as_deref(),
                        &job_uuid,
                        &suggested_replies,
                    ),
                    &job_payload,
                ),
                Some(&lease_metrics),
            );
            let message_metadata = sanitize_json_for_postgres(message_metadata);
            let message_row = record_agent_conversation_message(
                &transaction,
                &project_id,
                &conversation_uuid,
                run_session_id,
                run_prompt_id,
                run_id,
                message_content,
                message_metadata,
            )
            .await?;
            assistant_message = Some(message_row);
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit completion: {error}")))?;

    crate::send_intents::publish_job_input_state_updates(&state, &job_input_state_updates);

    if let Err((status, Json(api_error))) =
        crate::multi_agent_plan::maybe_enqueue_lead_continuation_after_completion(
            &state,
            job_uuid,
            &job_payload,
        )
        .await
    {
        warn!(
            project_id = %project_id,
            job_id = %job_uuid,
            status = status.as_u16(),
            error = %api_error.message,
            "failed to queue skill-authored multi-agent lead continuation"
        );
    }
    if let Some(conversation_id) = run_conversation_id {
        crate::send_queue::spawn_send_queue_drain(state.clone(), conversation_id);
    }
    if let Some(message) = token_usage_message.as_ref() {
        publish_conversation_message_event(&state.events, message);
        crate::notifications::enqueue_message_push_notifications(state.clone(), message.clone());
    }

    if let Some(message) = assistant_message.as_ref() {
        publish_conversation_message_event(&state.events, message);
        crate::notifications::enqueue_message_push_notifications(state.clone(), message.clone());
    }

    if let Some(run_uuid) = run_id {
        let (event_session, event_conversation, run_payload) =
            match load_run_snapshot(&mut *connection, &run_uuid).await {
                Ok(Some(snapshot)) => {
                    let session = snapshot.session_id;
                    let conversation = snapshot.conversation_id.or(run_conversation_id);
                    let run_json = run_snapshot_to_json(&snapshot);
                    (session, conversation, run_json)
                }
                Ok(None) => {
                    warn!(run_id = %run_uuid, "run snapshot missing after agent completion");
                    (None, run_conversation_id, JsonValue::Null)
                }
                Err((status, Json(api_error))) => {
                    warn!(
                        run_id = %run_uuid,
                        status = status.as_u16(),
                        error = %api_error.message,
                        "failed to load run snapshot after agent completion"
                    );
                    (None, run_conversation_id, JsonValue::Null)
                }
            };

        publish_controller_event_with_conversation(
            &state.events,
            "run.completed",
            Some(project_id),
            event_session,
            event_conversation,
            Some(run_uuid),
            Some(job_uuid),
            json!({
                "outcome": outcome_lower,
                "finalStatus": run_status,
                "runStatus": final_status_string,
                "summary": summary.clone(),
                "errorMessage": error_message,
                "artifactsCount": artifacts_count,
                "provider": provider_value,
                "creditSnapshot": credit_snapshot_value,
                "leaseMetrics": &lease_metrics,
                "multiAgentPlan": extract_multi_agent_plan_from_job_payload(&job_payload),
                "run": run_payload,
            }),
        );
    }

    Ok(Json(AgentCompleteResponseBody { ok: true }))
}

#[derive(Debug, Clone, Copy)]
struct TurnUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
}

fn extract_turn_usage_from_artifacts(artifacts: &JsonValue) -> Option<TurnUsage> {
    let artifacts = artifacts.as_array()?;
    for artifact in artifacts {
        let Some(map) = artifact.as_object() else {
            continue;
        };
        let kind = map.get("kind").and_then(JsonValue::as_str)?;
        if kind != "codex/run-log" {
            continue;
        }

        let events = map.get("events").and_then(JsonValue::as_array)?;
        for event in events.iter().rev() {
            let Some(event_map) = event.as_object() else {
                continue;
            };
            if event_map.get("type").and_then(JsonValue::as_str) != Some("turn.completed") {
                continue;
            }
            let usage = event_map.get("usage").and_then(JsonValue::as_object)?;
            return Some(TurnUsage {
                input_tokens: usage
                    .get("input_tokens")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(0),
                cached_input_tokens: usage
                    .get("cached_input_tokens")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(0),
                output_tokens: usage
                    .get("output_tokens")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(0),
            });
        }
    }
    None
}

fn extract_prompt_context_from_artifacts(artifacts: &JsonValue) -> Option<JsonValue> {
    let artifacts = artifacts.as_array()?;
    for artifact in artifacts.iter().rev() {
        let Some(map) = artifact.as_object() else {
            continue;
        };
        if map.get("kind").and_then(JsonValue::as_str) != Some("codex/prompt-context") {
            continue;
        }
        let metadata = map.get("metadata")?;
        if metadata.is_object() {
            return Some(metadata.clone());
        }
    }
    None
}

fn extract_agent_prompt_identity_from_job_payload(
    payload: &JsonValue,
) -> (Option<String>, Option<String>, Option<String>) {
    let agent = payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("agent"))
        .and_then(JsonValue::as_object);

    let handle = agent
        .and_then(|agent| agent.get("handle"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let display_name = agent
        .and_then(|agent| agent.get("displayName"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let description = agent
        .and_then(|agent| agent.get("description"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    (handle, display_name, description)
}

/// Live status of a multi-agent plan group, readable by the agents themselves.
///
/// Accepts the scoped controller token of a still-leased job in this exact
/// group, the service role, or a project member's user token. This is what
/// lets a lead agent poll sibling progress mid-run instead of staying blind
/// until the all-terminal checkpoint.
pub(crate) async fn agent_plan_group_status(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(group_id_raw): AxumPath<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let group_id_raw = group_id_raw.trim().to_string();
    let group_uuid = Uuid::parse_str(group_id_raw.as_str())
        .map_err(|_| bad_request("groupId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let mut transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    // A model-facing controller token is a capability of its still-leased
    // job, not a reusable project login. Resolve the complete active-job
    // binding before exposing sibling status.
    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    if active_job
        .as_ref()
        .is_some_and(|job| job.ensure_plan_group(&group_uuid).is_err())
    {
        return Err(not_found("plan group not found"));
    }

    let (project_id, conversation_id) = if let Some(active_job) = active_job.as_ref() {
        (active_job.project_id, Some(active_job.conversation_id))
    } else {
        // Prefer the indexed column; payload fallbacks cover rows created
        // before first-class hierarchy columns were introduced.
        let mut anchor = transaction
            .query_opt(
                "select id, project_id, conversation_id
                 from agent_jobs
                 where plan_group_id = $1
                 order by created_at asc
                 limit 1",
                &[&group_uuid],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load plan group: {error}")))?;
        if anchor.is_none() {
            anchor = transaction
                .query_opt(
                    "select id, project_id, conversation_id
                     from agent_jobs
                     where plan_group_id is null
                       and (
                         payload #>> '{metadata,multiAgentPlan,groupId}' = $1
                         or payload #>> '{metadata,multiAgentPlan,group_id}' = $1
                         or payload #>> '{metadata,multi_agent_plan,groupId}' = $1
                         or payload #>> '{metadata,multi_agent_plan,group_id}' = $1
                       )
                     order by created_at asc
                     limit 1",
                    &[&group_id_raw],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to load legacy plan group: {error}"))
                })?;
        }
        let Some(anchor) = anchor else {
            return Err(not_found("plan group not found"));
        };
        (
            anchor.get::<_, Uuid>("project_id"),
            anchor.get::<_, Option<Uuid>>("conversation_id"),
        )
    };

    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());

    let access = async {
        let project = load_project_record(&transaction, &project_id).await?;
        ensure_project_access(&transaction, &project, &access_context, None).await?;
        if let Some(conversation_id) = conversation_id {
            let conversation = load_conversation_record(&transaction, &conversation_id).await?;
            if conversation.project_id != project_id {
                return Err(forbidden("plan group conversation project mismatch"));
            }
            if let Some(active_job) = active_job.as_ref() {
                active_job
                    .ensure_conversation_read(&transaction, &conversation)
                    .await?;
            } else {
                ensure_conversation_access(&transaction, &conversation, &access_context).await?;
            }
        }
        Ok::<(), (StatusCode, Json<ApiError>)>(())
    }
    .await;
    if access.is_err() {
        // Match the missing-group response so callers cannot probe private
        // conversation or project membership through this endpoint.
        return Err(not_found("plan group not found"));
    }

    let snapshot = crate::multi_agent_plan::load_plan_group_snapshot(
        &mut transaction,
        project_id,
        conversation_id,
        group_id_raw.as_str(),
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finish access check: {error}")))?;

    Ok(Json(crate::multi_agent_plan::plan_group_snapshot_to_json(
        group_id_raw.as_str(),
        &snapshot,
    )))
}

fn extract_job_hierarchy_from_payload(
    payload: &JsonValue,
) -> (Option<Uuid>, Option<Uuid>, Option<String>) {
    let plan_meta = payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| {
            metadata
                .get("multiAgentPlan")
                .or_else(|| metadata.get("multi_agent_plan"))
        })
        .and_then(JsonValue::as_object);
    let Some(plan_meta) = plan_meta else {
        return (None, None, None);
    };
    let parent_job_id = plan_meta
        .get("parentJobId")
        .or_else(|| plan_meta.get("parent_job_id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    let plan_group_id = plan_meta
        .get("groupId")
        .or_else(|| plan_meta.get("group_id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    let agent_role = plan_meta
        .get("role")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    (parent_job_id, plan_group_id, agent_role)
}

pub(crate) async fn enqueue_agent_job_record(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    request: &DispatchPromptNormalized,
    run_id: &Uuid,
    prompt_id: &Uuid,
    target_runtime_id: Option<Uuid>,
    credential_id: Option<Uuid>,
    provider_conversation_state: Option<&JsonValue>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let payload_json = build_agent_job_payload(
        project,
        context,
        request,
        run_id,
        prompt_id,
        provider_conversation_state,
    );
    let (parent_job_id, plan_group_id, agent_role) =
        extract_job_hierarchy_from_payload(&payload_json);
    let payload_param = PgJson(&payload_json);
    let status = "queued";

    let row = transaction
        .query_opt(
            "insert into agent_jobs (
                 project_id,
                 run_id,
                 prompt_id,
                 session_id,
                 conversation_id,
                 credential_id,
                 intent,
                 status,
                 priority,
                 payload,
                 target_runtime_id,
                 parent_job_id,
                 plan_group_id,
                 agent_role
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
                 (select parent.id from agent_jobs parent
                  where parent.id = $12 and parent.project_id = $1),
                 $13, $14)
             returning id",
            &[
                &project.id,
                run_id,
                prompt_id,
                &request.session_id,
                &request.conversation_id,
                &credential_id,
                &request.intent,
                &status,
                &request.priority,
                &payload_param,
                &target_runtime_id,
                &parent_job_id,
                &plan_group_id,
                &agent_role,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to enqueue agent job: {error}")))?;

    Ok(row.map(|record| record.get::<_, Uuid>("id")))
}

pub(crate) async fn lease_next_agent_job(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    runtime_id: Option<&Uuid>,
    lease_seconds: i32,
    allow_untargeted_jobs: bool,
    require_read_only: bool,
    require_exact_owned_write_scope: bool,
    exclude_runtime_spread: bool,
    batch_conversation_id: Option<&Uuid>,
    batch_multi_agent_group_id: Option<&str>,
) -> Result<Option<AgentJob>, (StatusCode, Json<ApiError>)> {
    let runtime_uuid: Option<Uuid> = runtime_id.cloned();
    let batch_conversation_uuid: Option<Uuid> = batch_conversation_id.cloned();
    let batch_multi_agent_group: Option<String> = batch_multi_agent_group_id.map(str::to_string);
    // Personal Browser jobs may carry inherited spread metadata, but their
    // explicit desktop runtime remains an exact device boundary.
    let row = transaction
        .query_opt(
            "with eligible_jobs as (
                select aj.id,
                       aj.target_runtime_id,
                       aj.conversation_id,
                       aj.priority,
                       aj.created_at,
                       aj.payload #>> '{user_id}' as job_user_id,
                       lower(replace(coalesce(
                           aj.payload #>> '{metadata,runtimeRouting,strategy}',
                           aj.payload #>> '{metadata,runtime_routing,strategy}',
                           aj.payload #>> '{metadata,runtimeRouting,mode}',
                           aj.payload #>> '{metadata,runtime_routing,mode}',
                           ''
                       ), '-', '_')) as runtime_routing_strategy,
                       lower(replace(btrim(coalesce(
                           aj.payload #>> '{metadata,browserTransport}',
                           aj.payload #>> '{metadata,browser_transport}',
                           ''
                       )), '_', '-')) as browser_transport,
                       lower(coalesce(
                           aj.payload #>> '{metadata,runtimeRouting,allowUntargetedAcrossPreferredRuntimes}',
                           aj.payload #>> '{metadata,runtimeRouting,allowRuntimeSpread}',
                           aj.payload #>> '{metadata,runtime_routing,allow_runtime_spread}',
                           'false'
                       )) as runtime_routing_allow_spread,
                       lower(replace(coalesce(
                           aj.payload #>> '{metadata,writeScope,mode}',
                           aj.payload #>> '{metadata,write_scope,mode}',
                           aj.payload #>> '{metadata,agent,writeScope,mode}',
                           aj.payload #>> '{metadata,agent,write_scope,mode}',
                           ''
                       ), '-', '_')) as write_scope_mode,
                       coalesce(
                           aj.payload #> '{metadata,writeScope,ownedPaths}',
                           aj.payload #> '{metadata,write_scope,ownedPaths}',
                           aj.payload #> '{metadata,write_scope,owned_paths}',
                           aj.payload #> '{metadata,agent,writeScope,ownedPaths}',
                           aj.payload #> '{metadata,agent,write_scope,ownedPaths}',
                           aj.payload #> '{metadata,agent,write_scope,owned_paths}',
                           'null'::jsonb
                       ) as owned_paths_json,
                       nullif(aj.payload #>> '{metadata,multiAgentPlan,groupId}', '') as multi_agent_group_id,
                       nullif(aj.payload #>> '{metadata,multiAgentPlan,parentRuntimeId}', '') as multi_agent_parent_runtime_id
                from agent_jobs aj
                where aj.project_id = $1
                  and status = 'queued'
             ),
             candidate as (
                select id
                from eligible_jobs
                where true
                  and (
                        target_runtime_id = $2
                        or (
                            browser_transport not in ('desktop-personal', 'shared')
                            and
                            (
                                target_runtime_id is null
                                or runtime_routing_strategy in ('spread', 'parallel', 'scale_out')
                                or runtime_routing_allow_spread in ('true', '1', 'yes', 'on')
                            )
                            and (
                                $4
                                or runtime_routing_strategy in ('spread', 'parallel', 'scale_out')
                                or runtime_routing_allow_spread in ('true', '1', 'yes', 'on')
                            )
                            and (
                                not (
                                    runtime_routing_strategy in ('spread', 'parallel', 'scale_out')
                                    or runtime_routing_allow_spread in ('true', '1', 'yes', 'on')
                                )
                                or multi_agent_group_id is null
                                or multi_agent_parent_runtime_id = $2::text
                                or exists (
                                    select 1
                                    from runtimes r
                                    left join runtime_leases rl on rl.id = r.active_lease_id
                                    where r.id = $2
                                      and r.project_id = $1
                                      and r.status not in ('stopped', 'offline', 'removed')
                                      and rl.released_at is null
                                      and rl.metadata #>> '{groupId}' = multi_agent_group_id
                                )
                            )
                        )
                      )
                  and not exists (
                        select 1
                        from runtimes private_runtime
                        where private_runtime.id = $2
                          and private_runtime.project_id = $1
                          and (
                              lower(replace(replace(btrim(private_runtime.provider), '-', '_'), ' ', '_')) = 'self_hosted'
                              or private_runtime.capabilities ? '_instafySelfHostedAccess'
                              or private_runtime.capabilities ? '_instafy_self_hosted_access'
                              or private_runtime.capabilities ? 'personalBrowser'
                              or private_runtime.capabilities ? 'personal_browser'
                          )
                          and coalesce(
                              private_runtime.capabilities #>> '{_instafySelfHostedAccess,ownerUserId}',
                              private_runtime.capabilities #>> '{_instafy_self_hosted_access,owner_user_id}',
                              private_runtime.capabilities #>> '{personalBrowser,ownerUserId}',
                              private_runtime.capabilities #>> '{personal_browser,owner_user_id}'
                          ) is distinct from job_user_id
                      )
                  and (
                        not $5
                        or write_scope_mode = 'read_only'
                      )
                  and (
                        not $6
                        or (
                            write_scope_mode in ('owned', 'write', 'write_scoped')
                            and jsonb_typeof(owned_paths_json) = 'array'
                            and jsonb_array_length(owned_paths_json) > 0
                            and not exists (
                                select 1
                                from jsonb_array_elements_text(owned_paths_json) as owned_path(value)
                                where btrim(value) = ''
                                  or value like '%*%'
                                  or value like '%?%'
                                  or value like '%[%'
                                  or value like '%]%'
                                  or value like '%/'
                                  or right(value, 1) = E'\\\\'
                            )
                        )
                      )
                  and (
                        not $7
                        or not (
                            runtime_routing_strategy in ('spread', 'parallel', 'scale_out')
                            or runtime_routing_allow_spread in ('true', '1', 'yes', 'on')
                        )
                      )
                  and (
                        $8::uuid is null
                        or conversation_id = $8::uuid
                      )
                  and (
                        $9::text is null
                        or multi_agent_group_id = $9::text
                      )
                  and not (
                        $2 is not null
                        and (
                            runtime_routing_strategy in ('spread', 'parallel', 'scale_out')
                            or runtime_routing_allow_spread in ('true', '1', 'yes', 'on')
                        )
                        and exists (
                            select 1
                            from agent_jobs busy
                            where busy.project_id = $1
                              and busy.status = 'leased'
                              and busy.leased_by_runtime_id = $2
                              and busy.lease_expires_at > now()
                        )
                      )
                  and not (
                        $2 is not null
                        and multi_agent_group_id is not null
                        and (
                            runtime_routing_strategy in ('spread', 'parallel', 'scale_out')
                            or runtime_routing_allow_spread in ('true', '1', 'yes', 'on')
                        )
                        and exists (
                            select 1
                            from agent_jobs handled_by_this_runtime
                            where handled_by_this_runtime.project_id = $1
                              and handled_by_this_runtime.leased_by_runtime_id = $2
                              and handled_by_this_runtime.status <> 'queued'
                              and nullif(
                                  handled_by_this_runtime.payload #>> '{metadata,multiAgentPlan,groupId}',
                                  ''
                              ) = multi_agent_group_id
                        )
                        and exists (
                            select 1
                            from runtimes group_runtime
                            join runtime_leases group_runtime_lease
                              on group_runtime_lease.id = group_runtime.active_lease_id
                            where group_runtime.id <> $2
                              and group_runtime.project_id = $1
                              and group_runtime.status not in ('stopped', 'offline', 'removed')
                              and group_runtime_lease.released_at is null
                              and group_runtime_lease.metadata #>> '{groupId}' = multi_agent_group_id
                              and not exists (
                                  select 1
                                  from agent_jobs handled_by_group_runtime
                                  where handled_by_group_runtime.project_id = $1
                                    and handled_by_group_runtime.leased_by_runtime_id = group_runtime.id
                                    and handled_by_group_runtime.status <> 'queued'
                                    and nullif(
                                        handled_by_group_runtime.payload #>> '{metadata,multiAgentPlan,groupId}',
                                        ''
                                    ) = multi_agent_group_id
                              )
                        )
                      )
                order by
                  case when target_runtime_id = $2 then 0 else 1 end,
                  priority asc,
                  created_at asc
                limit 1
                for update skip locked
             )
             update agent_jobs aj
             set status = 'leased',
                 leased_at = now(),
                 lease_expires_at = now() + interval '1 second' * greatest($3::int, 30),
                 lease_attempts = lease_attempts + 1,
                 leased_by_runtime_id = $2,
                 active_input_ready_runtime_id = null,
                 active_input_ready_expires_at = null,
                 active_input_ready_turn_id = null,
                 heartbeat_at = now(),
                 payload = aj.payload - 'requeuedAt' - 'requeuedReason'
             from candidate
             where aj.id = candidate.id
             returning aj.*",
            &[
                project_id,
                &runtime_uuid,
                &lease_seconds,
                &allow_untargeted_jobs,
                &require_read_only,
                &require_exact_owned_write_scope,
                &exclude_runtime_spread,
                &batch_conversation_uuid,
                &batch_multi_agent_group,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lease job: {error:?}")))?;

    let Some(row) = row else {
        return Ok(None);
    };

    let conversation_id: Option<Uuid> = row.get("conversation_id");
    let run_id: Option<Uuid> = row.get("run_id");
    let credential_id: Option<Uuid> = row.try_get("credential_id").unwrap_or(None);
    let mut payload: JsonValue = row.get("payload");

    if let Some(run_uuid) = run_id {
        transaction
            .execute(
                "update runs
                 set status = 'in_progress',
                     progress = greatest(progress, 1),
                     progress_stage = 'agent:leased',
                     updated_at = now()
                 where id = $1
                   and status = 'queued'",
                &[&run_uuid],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to update run status on lease: {error}"))
            })?;
        // Home's feed: the run is now in flight.
        crate::activity::record_run_started(
            transaction,
            project_id,
            &run_uuid,
            conversation_id,
            row.try_get("prompt_id").unwrap_or(None),
            &payload,
        )
        .await;
    }

    if let Some(conversation_uuid) = conversation_id {
        let agent_scope_id = payload
            .get("metadata")
            .and_then(JsonValue::as_object)
            .and_then(|metadata| metadata.get("agent"))
            .and_then(JsonValue::as_object)
            .and_then(|agent| agent.get("id"))
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok());
        let agent_scope_handle = payload
            .get("metadata")
            .and_then(JsonValue::as_object)
            .and_then(|metadata| metadata.get("agent"))
            .and_then(JsonValue::as_object)
            .and_then(|agent| agent.get("handle"))
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        let history = load_conversation_history_for_agent(
            transaction,
            &conversation_uuid,
            agent_scope_id.as_ref(),
            agent_scope_handle.as_deref(),
            AGENT_CONVERSATION_HISTORY_LIMIT,
        )
        .await?;
        if let JsonValue::Object(ref mut map) = payload {
            map.insert(
                "conversation_history".to_string(),
                JsonValue::Array(history),
            );
        } else {
            let mut map = JsonMap::new();
            map.insert(
                "conversation_history".to_string(),
                JsonValue::Array(history),
            );
            payload = JsonValue::Object(map);
        }
    }

    // NOTE: Response-shape guidance is enforced by the runtime agent prompt scaffold.

    let created_at = row.get("created_at");
    let leased_at = row.get("leased_at");
    let lease_attempts = row.get("lease_attempts");
    let leased_by_runtime_id = row.get("leased_by_runtime_id");
    let lease_metrics = build_agent_lease_metrics(
        &payload,
        created_at,
        leased_at,
        None,
        lease_attempts,
        leased_by_runtime_id,
        None,
    );

    let job = AgentJob {
        id: row.get("id"),
        project_id: row.get("project_id"),
        run_id,
        prompt_id: row.get("prompt_id"),
        session_id: row.get("session_id"),
        conversation_id,
        credential_id,
        intent: row.get("intent"),
        status: row.get("status"),
        outcome: row.get("outcome"),
        payload,
        priority: row.get("priority"),
        lease_attempts,
        leased_at,
        lease_expires_at: row.get("lease_expires_at"),
        leased_by_runtime_id,
        target_runtime_id: row.get("target_runtime_id"),
        heartbeat_at: row.get("heartbeat_at"),
        created_at,
        updated_at: row.get("updated_at"),
        lease_metrics,
        proxy: None,
        controller_token: None,
        controller_token_expires_at: None,
        controller_token_scopes: None,
        workspace_token: None,
        workspace_token_expires_at: None,
        workspace_token_scopes: None,
    };

    Ok(Some(job))
}

async fn load_conversation_history_for_agent(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    agent_id: Option<&Uuid>,
    agent_handle: Option<&str>,
    limit: i64,
) -> Result<Vec<JsonValue>, (StatusCode, Json<ApiError>)> {
    let clamped_limit = limit.clamp(1, 200);
    let rows = transaction
        .query(
            "select id, role, content, metadata, created_at
             from conversation_messages
             where conversation_id = $1
             order by created_at desc
             limit $2",
            &[conversation_id, &clamped_limit],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load conversation history: {error}")))?;

    let mut entries: Vec<JsonValue> = rows
        .into_iter()
        .filter_map(|row| {
            let message_id: Uuid = row.get("id");
            let role: String = row.get("role");
            let mut content: String = row.get("content");
            let metadata: JsonValue = row.get("metadata");
            let created_at: DateTime<Utc> = row.get("created_at");

            let message_type = metadata
                .as_object()
                .and_then(|map| map.get("messageType").or_else(|| map.get("message_type")))
                .and_then(JsonValue::as_str)
                .map(|value| value.trim().to_ascii_lowercase());
            if !should_include_message_in_agent_history(&role, &metadata, message_type.as_deref()) {
                return None;
            }
            if role.eq_ignore_ascii_case("assistant")
                && !assistant_message_belongs_to_agent_scope(&metadata, agent_id, agent_handle)
            {
                return None;
            }

            let mut map = JsonMap::new();
            if role.eq_ignore_ascii_case("user") {
                if let Some(attachment_context) =
                    format_image_attachment_context_for_agent(&metadata)
                {
                    if !content.trim().is_empty() {
                        content.push_str("\n\n");
                    }
                    content.push_str(&attachment_context);
                }
            }
            // The message id lets the runtime resolve structured message
            // references (e.g. the undo affordance's `undoTargetMessageId`
            // metadata) against this history instead of text heuristics.
            map.insert("id".to_string(), JsonValue::String(message_id.to_string()));
            map.insert("role".to_string(), JsonValue::String(role));
            map.insert("content".to_string(), JsonValue::String(content));
            map.insert(
                "createdAt".to_string(),
                JsonValue::String(created_at.to_rfc3339()),
            );
            if !metadata.is_null() {
                map.insert("metadata".to_string(), metadata);
            }
            Some(JsonValue::Object(map))
        })
        .collect();

    entries.reverse();
    Ok(entries)
}

fn should_include_message_in_agent_history(
    role: &str,
    metadata: &JsonValue,
    message_type: Option<&str>,
) -> bool {
    if !role.eq_ignore_ascii_case("assistant") {
        return true;
    }

    let normalized_message_type = message_type
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if matches!(
        normalized_message_type.as_deref(),
        Some("reasoning" | "token_usage")
    ) {
        return false;
    }

    // A secret card is not a progress update, whatever its metadata says. It is
    // a standing request, and the next turn has to be able to see that it was
    // already made. Dropped here, the agent asks for the same value again the
    // next time anything touches setup, because from where it is standing it
    // never asked at all: a person who ran skill setup twice got two live cards
    // for one token, worded differently, and answered neither.
    if normalized_message_type.as_deref() == Some("secret_request") {
        return true;
    }

    let metadata = metadata.as_object();
    let kind = metadata
        .and_then(|map| map.get("kind"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase());
    let source = metadata
        .and_then(|map| map.get("source"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase());
    let outcome = metadata
        .and_then(|map| map.get("outcome"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase());

    if source.as_deref() == Some("agent")
        && kind.as_deref() == Some("update")
        && outcome.as_deref() == Some("in_progress")
    {
        return false;
    }

    true
}

fn assistant_message_belongs_to_agent_scope(
    metadata: &JsonValue,
    agent_id: Option<&Uuid>,
    agent_handle: Option<&str>,
) -> bool {
    let metadata = metadata.as_object();
    let source = metadata
        .and_then(|map| map.get("source"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase());
    if source.as_deref() != Some("agent") {
        return true;
    }

    let agent = metadata
        .and_then(|map| map.get("agent"))
        .and_then(JsonValue::as_object);
    let metadata_id = agent
        .and_then(|agent| agent.get("id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    if let Some(agent_id) = agent_id {
        if metadata_id == Some(*agent_id) {
            return true;
        }
    }

    let normalized_handle = agent_handle
        .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let metadata_handle = agent
        .and_then(|agent| agent.get("handle"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    if let Some(expected_handle) = normalized_handle {
        return metadata_handle.as_deref() == Some(expected_handle.as_str());
    }

    agent_id.is_none()
}

fn format_image_attachment_context_for_agent(metadata: &JsonValue) -> Option<String> {
    let metadata = metadata.as_object()?;

    let mut attachment_sources: Vec<&JsonValue> = Vec::new();
    if let Some(attachments) = metadata.get("attachments") {
        attachment_sources.push(attachments);
    }
    if let Some(prompt_meta) = metadata.get("prompt_metadata") {
        attachment_sources.push(prompt_meta);
    }
    if let Some(prompt_meta) = metadata.get("promptMetadata") {
        attachment_sources.push(prompt_meta);
    }

    if attachment_sources.is_empty() {
        return None;
    }

    let mut unique_paths = HashSet::new();
    let mut lines = Vec::new();

    for source in attachment_sources {
        let attachment_array = match source {
            JsonValue::Array(entries) => Some(entries),
            JsonValue::Object(map) => map.get("attachments").and_then(JsonValue::as_array),
            _ => None,
        };
        let Some(attachment_array) = attachment_array else {
            continue;
        };

        for attachment in attachment_array {
            let Some(entry) = attachment.as_object() else {
                continue;
            };
            let kind = entry
                .get("kind")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if kind != "image" {
                continue;
            }
            let workspace_path = entry
                .get("workspacePath")
                .and_then(JsonValue::as_str)
                .or_else(|| entry.get("workspace_path").and_then(JsonValue::as_str))
                .map(|value| value.trim())
                .filter(|value| !value.is_empty());
            let Some(workspace_path) = workspace_path else {
                continue;
            };
            if !unique_paths.insert(workspace_path.to_string()) {
                continue;
            }

            let file_name = entry
                .get("fileName")
                .and_then(JsonValue::as_str)
                .or_else(|| entry.get("file_name").and_then(JsonValue::as_str))
                .map(|value| value.trim())
                .filter(|value| !value.is_empty());
            let mime_type = entry
                .get("mimeType")
                .and_then(JsonValue::as_str)
                .or_else(|| entry.get("mime_type").and_then(JsonValue::as_str))
                .map(|value| value.trim())
                .filter(|value| !value.is_empty());
            let size_bytes = entry
                .get("sizeBytes")
                .and_then(JsonValue::as_u64)
                .or_else(|| entry.get("size_bytes").and_then(JsonValue::as_u64));

            let mut line = String::new();
            line.push_str("workspacePath: ");
            line.push_str(workspace_path);
            if file_name.is_some() || mime_type.is_some() || size_bytes.is_some() {
                line.push_str(" (");
                let mut wrote_detail = false;
                if let Some(file_name) = file_name {
                    line.push_str("fileName: ");
                    line.push_str(file_name);
                    wrote_detail = true;
                }
                if let Some(mime_type) = mime_type {
                    if wrote_detail {
                        line.push_str(", ");
                    }
                    line.push_str("mimeType: ");
                    line.push_str(mime_type);
                    wrote_detail = true;
                }
                if let Some(size_bytes) = size_bytes {
                    if wrote_detail {
                        line.push_str(", ");
                    }
                    line.push_str(&format!("sizeBytes: {size_bytes}"));
                }
                line.push(')');
            }
            lines.push(line);
        }
    }

    if lines.is_empty() {
        return None;
    }

    let mut section = String::new();
    section.push_str("User attached image(s):\n");
    for line in lines {
        section.push_str("- ");
        section.push_str(&line);
        section.push('\n');
    }
    section
        .push_str("Before answering, call the `view_image` tool with the `workspacePath` above.\n");
    Some(section)
}

pub(crate) async fn persist_run_completion_metadata(
    transaction: &tokio_postgres::Transaction<'_>,
    run_id: &Uuid,
    provider: Option<&str>,
    conversation_state: Option<&JsonValue>,
    credit_snapshot: Option<&JsonValue>,
    summary: Option<&str>,
    error_message: Option<&str>,
    artifacts_count: Option<usize>,
) -> Result<(), tokio_postgres::Error> {
    let row = transaction
        .query_opt(
            "select metadata from runs where id = $1 for update",
            &[run_id],
        )
        .await?;
    let existing_metadata = row
        .and_then(|row| row.get::<_, Option<PgJson<JsonValue>>>("metadata"))
        .map(|json| json.0);
    let merged_metadata = merge_run_completion_metadata(
        existing_metadata.as_ref(),
        provider,
        conversation_state,
        credit_snapshot,
        summary,
        error_message,
        artifacts_count,
    );
    let metadata_param = PgJson(&merged_metadata);
    transaction
        .execute(
            "update runs set metadata = $2::jsonb where id = $1",
            &[run_id, &metadata_param],
        )
        .await
        .map(|_| ())
}

fn merge_run_completion_metadata(
    existing: Option<&JsonValue>,
    provider: Option<&str>,
    conversation_state: Option<&JsonValue>,
    credit_snapshot: Option<&JsonValue>,
    summary: Option<&str>,
    error_message: Option<&str>,
    artifacts_count: Option<usize>,
) -> JsonValue {
    let mut root = match existing.cloned() {
        Some(JsonValue::Object(map)) => map,
        _ => JsonMap::new(),
    };

    if provider.is_some() || conversation_state.is_some() {
        let mut provider_map = root
            .remove("provider")
            .and_then(|value| match value {
                JsonValue::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();

        if let Some(value) = provider {
            provider_map.insert("id".to_string(), JsonValue::String(value.to_string()));
        }
        if let Some(state) = conversation_state {
            provider_map.insert("conversation".to_string(), state.clone());
        }

        root.insert("provider".to_string(), JsonValue::Object(provider_map));
    }

    if let Some(snapshot) = credit_snapshot {
        root.insert("creditSnapshot".to_string(), snapshot.clone());
    }
    if let Some(value) = summary {
        root.insert("summary".to_string(), JsonValue::String(value.to_string()));
    }
    if let Some(value) = error_message {
        root.insert(
            "errorMessage".to_string(),
            JsonValue::String(value.to_string()),
        );
    }
    if let Some(value) = artifacts_count {
        root.insert("artifactsCount".to_string(), JsonValue::from(value));
    }

    JsonValue::Object(root)
}

/// Per-agent participation preamble for ambient skill-mode evaluations. It
/// must be self-contained: custom agents can run on runtimes without the
/// bundled instafy-group-participation skill file, so the delivered turn
/// itself addresses the agent by its own identity, states the full decline
/// protocol, and lists the other AI participants (from the roster dispatch
/// stamped as `groupAiParticipants`) that are also evaluating this turn.
fn build_ambient_evaluation_preamble(metadata: &JsonValue) -> String {
    let agent = metadata.get("agent").and_then(JsonValue::as_object);
    let self_handle = agent
        .and_then(|map| map.get("handle"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let self_display_name = agent
        .and_then(|map| map.get("displayName"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let addressed = match (self_display_name, self_handle) {
        (Some(name), Some(handle)) => format!("you ({name}, @{handle})"),
        (Some(name), None) => format!("you ({name})"),
        (None, Some(handle)) => format!("you (@{handle})"),
        (None, None) => "you".to_string(),
    };

    let mut preamble = format!(
        "[Ambient group turn — nobody addressed {addressed} directly. Decide participation first per the instafy-group-participation skill. If this turn is not yours to answer, reply with exactly NO_RESPONSE and nothing else; statements about not answering (\"X should answer this\", \"I'll stay out\") are visible answers, not declines."
    );

    let other_participants = metadata
        .get("groupAiParticipants")
        .and_then(JsonValue::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(JsonValue::as_object)
                .filter_map(|entry| {
                    let handle = entry
                        .get("handle")
                        .and_then(JsonValue::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    if self_handle.is_some_and(|own| own.eq_ignore_ascii_case(handle)) {
                        return None;
                    }
                    let display_name = entry
                        .get("displayName")
                        .and_then(JsonValue::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    let description = entry
                        .get("description")
                        .and_then(JsonValue::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    Some(match (display_name, description) {
                        (Some(name), Some(description)) => {
                            format!("@{handle} ({name} — {description})")
                        }
                        (Some(name), None) => format!("@{handle} ({name})"),
                        (None, Some(description)) => format!("@{handle} ({description})"),
                        (None, None) => format!("@{handle}"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !other_participants.is_empty() {
        preamble.push_str(&format!(
            " Other AI participants are also evaluating this turn: {}. If this turn is better suited to another listed agent, reply NO_RESPONSE and let them take it; an explicit mention of another agent is never yours.",
            other_participants.join(", ")
        ));
    }
    preamble.push(']');
    preamble
}

fn build_agent_evaluation_preamble(metadata: &JsonValue) -> String {
    let reason = metadata
        .get("groupParticipation")
        .and_then(|participation| participation.get("reason"))
        .and_then(JsonValue::as_str);
    if reason == Some(crate::group_participation::AUTOMATION_NOTHING_TO_REPORT_REASON) {
        return concat!(
            "[Scheduled automation run — carry out the requested task normally. ",
            "If and only if the task succeeds and there is nothing worth reporting, ",
            "reply with exactly NO_RESPONSE and nothing else. Never use NO_RESPONSE ",
            "for an error or an incomplete check.]"
        )
        .to_string();
    }
    build_ambient_evaluation_preamble(metadata)
}

fn build_agent_job_payload(
    project: &ProjectRecord,
    context: &RequestContext,
    request: &DispatchPromptNormalized,
    run_id: &Uuid,
    prompt_id: &Uuid,
    provider_conversation_state: Option<&JsonValue>,
) -> JsonValue {
    let mut map = JsonMap::new();
    let bootstrap = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("bootstrap"))
        .cloned();
    map.insert("version".to_string(), JsonValue::String("1.0".into()));
    map.insert(
        "project_id".to_string(),
        JsonValue::String(project.id.to_string()),
    );
    if let Some(user_id) = context.user_id {
        map.insert(
            "user_id".to_string(),
            JsonValue::String(user_id.to_string()),
        );
    }
    if let Some(session_id) = request.session_id {
        map.insert(
            "session_id".to_string(),
            JsonValue::String(session_id.to_string()),
        );
    }
    if let Some(conversation_id) = request.conversation_id {
        map.insert(
            "conversation_id".to_string(),
            JsonValue::String(conversation_id.to_string()),
        );
        map.insert(
            "targetThreadId".to_string(),
            JsonValue::String(conversation_id.to_string()),
        );
    }
    map.insert(
        "prompt_id".to_string(),
        JsonValue::String(prompt_id.to_string()),
    );
    map.insert("run_id".to_string(), JsonValue::String(run_id.to_string()));
    map.insert(
        "intent".to_string(),
        JsonValue::String(request.intent.clone()),
    );
    map.insert(
        "executionMode".to_string(),
        JsonValue::String(request.workspace_mode.clone()),
    );
    // Controller-marked evaluations get their participation instruction inside
    // the delivered turn itself. The persisted conversation message keeps the
    // original prompt — this wrapper exists only in the runtime-facing payload.
    let delivered_prompt_text =
        if crate::group_participation::metadata_marks_agent_evaluation(&request.metadata) {
            format!(
                "{}\n\n{}",
                build_agent_evaluation_preamble(&request.metadata),
                request.prompt_text
            )
        } else {
            request.prompt_text.clone()
        };
    map.insert(
        "prompt_text".to_string(),
        JsonValue::String(delivered_prompt_text),
    );
    if let Some(plan_seed) = request.plan_seed.as_ref() {
        map.insert("plan_seed".to_string(), plan_seed.clone());
    }
    if let Some(metadata) = request.metadata.as_object() {
        map.insert("metadata".to_string(), JsonValue::Object(metadata.clone()));
    } else {
        map.insert("metadata".to_string(), request.metadata.clone());
    }
    if let Some(bootstrap) = bootstrap {
        map.insert("bootstrap".to_string(), bootstrap);
    }
    if let Some(state) = provider_conversation_state {
        map.insert("provider_conversation_state".to_string(), state.clone());
    }
    if let Some(tool_limits) = request.tool_limits.as_ref() {
        map.insert("tool_limits".to_string(), tool_limits.clone());
    }
    if let Some(write_intent) = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("writeIntent"))
        .cloned()
    {
        map.insert("writeIntent".to_string(), write_intent);
    }
    if let Some(repo) = request.repo.as_ref() {
        let mut repo_map = JsonMap::new();
        if let Some(owner) = repo.owner.as_ref() {
            repo_map.insert("owner".to_string(), JsonValue::String(owner.clone()));
        }
        if let Some(name) = repo.name.as_ref() {
            repo_map.insert("name".to_string(), JsonValue::String(name.clone()));
        }
        if let Some(installation) = repo.installation_id {
            repo_map.insert("installation_id".to_string(), JsonValue::from(installation));
        }
        if !repo_map.is_empty() {
            map.insert("repo".to_string(), JsonValue::Object(repo_map));
        }
    }

    JsonValue::Object(map)
}

// Ensure every agent message keeps the runtime selection metadata that dispatch attached to the job,
// so downstream consumers (UI, history, tests) can see which runtime handled the response.
fn merge_runtime_preference_from_job_payload(
    metadata: JsonValue,
    job_payload: &JsonValue,
) -> JsonValue {
    let agent_identity = job_payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("agent"))
        .cloned();
    let runtime_preference = job_payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("runtimePreference"))
        .cloned();
    let thread_id = job_payload
        .get("conversation_id")
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let source_agent_id = job_payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("agent"))
        .and_then(JsonValue::as_object)
        .and_then(|agent| agent.get("id"))
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let execution_mode = job_payload
        .get("executionMode")
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .or_else(|| {
            job_payload
                .get("metadata")
                .and_then(JsonValue::as_object)
                .and_then(|map| {
                    map.get("executionMode")
                        .or_else(|| map.get("workspaceMode"))
                })
                .and_then(JsonValue::as_str)
                .map(str::to_string)
        });
    let write_intent = job_payload.get("writeIntent").cloned().or_else(|| {
        job_payload
            .get("metadata")
            .and_then(JsonValue::as_object)
            .and_then(|map| map.get("writeIntent"))
            .cloned()
    });
    let linked_thread_id = job_payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("linkedThreadId"))
        .cloned();
    let advisory_scope_claims = job_payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("advisoryScopeClaims"))
        .cloned();
    let agent_collaboration = job_payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("agentCollaboration"))
        .cloned();
    let write_scope = extract_write_scope_from_job_payload(job_payload);
    let multi_agent_plan = extract_multi_agent_plan_from_job_payload(job_payload);

    let Some(preference_value) = runtime_preference else {
        return match metadata {
            JsonValue::Object(mut map) => {
                if let Some(identity) = agent_identity {
                    map.insert("agent".to_string(), identity);
                }
                if let Some(thread_id) = thread_id {
                    map.insert("agentThreadId".to_string(), JsonValue::String(thread_id));
                }
                if let Some(source_agent_id) = source_agent_id {
                    map.insert(
                        "sourceAgentId".to_string(),
                        JsonValue::String(source_agent_id),
                    );
                }
                if let Some(execution_mode) = execution_mode {
                    map.insert(
                        "executionMode".to_string(),
                        JsonValue::String(execution_mode),
                    );
                }
                if let Some(write_intent) = write_intent {
                    map.insert("writeIntent".to_string(), write_intent);
                }
                if let Some(linked_thread_id) = linked_thread_id {
                    map.insert("linkedThreadId".to_string(), linked_thread_id);
                }
                if let Some(advisory_scope_claims) = advisory_scope_claims {
                    map.insert("advisoryScopeClaims".to_string(), advisory_scope_claims);
                }
                if let Some(agent_collaboration) = agent_collaboration {
                    map.insert("agentCollaboration".to_string(), agent_collaboration);
                }
                if let Some(write_scope) = write_scope {
                    map.insert("writeScope".to_string(), write_scope);
                }
                if let Some(multi_agent_plan) = multi_agent_plan {
                    map.insert("multiAgentPlan".to_string(), multi_agent_plan);
                }
                JsonValue::Object(map)
            }
            other => other,
        };
    };

    match metadata {
        JsonValue::Object(mut map) => {
            map.insert("runtimePreference".to_string(), preference_value.clone());
            if let Some(identity) = agent_identity {
                map.insert("agent".to_string(), identity);
            }
            if let Some(thread_id) = thread_id {
                map.insert("agentThreadId".to_string(), JsonValue::String(thread_id));
            }
            if let Some(source_agent_id) = source_agent_id {
                map.insert(
                    "sourceAgentId".to_string(),
                    JsonValue::String(source_agent_id),
                );
            }
            if let Some(execution_mode) = execution_mode {
                map.insert(
                    "executionMode".to_string(),
                    JsonValue::String(execution_mode),
                );
            }
            if let Some(write_intent) = write_intent {
                map.insert("writeIntent".to_string(), write_intent);
            }
            if let Some(linked_thread_id) = linked_thread_id {
                map.insert("linkedThreadId".to_string(), linked_thread_id);
            }
            if let Some(advisory_scope_claims) = advisory_scope_claims {
                map.insert("advisoryScopeClaims".to_string(), advisory_scope_claims);
            }
            if let Some(agent_collaboration) = agent_collaboration {
                map.insert("agentCollaboration".to_string(), agent_collaboration);
            }
            if let Some(write_scope) = write_scope {
                map.insert("writeScope".to_string(), write_scope);
            }
            if let Some(multi_agent_plan) = multi_agent_plan {
                map.insert("multiAgentPlan".to_string(), multi_agent_plan);
            }

            if let Some(preference_object) = preference_value.as_object() {
                let runtime_id = preference_object
                    .get("runtimeId")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string);
                let source = preference_object
                    .get("source")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string);
                let display_name = preference_object
                    .get("displayName")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string);

                if let Some(details_value) = map.get_mut("details") {
                    if let JsonValue::Object(details_map) = details_value {
                        if let Some(ref runtime_id_value) = runtime_id {
                            details_map
                                .entry("runtimeId".to_string())
                                .or_insert(JsonValue::String(runtime_id_value.clone()));
                        }
                        if let Some(ref source_value) = source {
                            details_map
                                .entry("source".to_string())
                                .or_insert(JsonValue::String(source_value.clone()));
                        }
                        if let Some(ref display_value) = display_name {
                            details_map
                                .entry("displayName".to_string())
                                .or_insert(JsonValue::String(display_value.clone()));
                        }
                        details_map
                            .entry("kind".to_string())
                            .or_insert(JsonValue::String("runtime_selection".to_string()));
                        return JsonValue::Object(map);
                    }
                }

                if let Some(runtime_id_value) = runtime_id {
                    let mut details_map = JsonMap::new();
                    details_map.insert(
                        "kind".to_string(),
                        JsonValue::String("runtime_selection".to_string()),
                    );
                    details_map
                        .insert("runtimeId".to_string(), JsonValue::String(runtime_id_value));
                    if let Some(source_value) = source {
                        details_map.insert("source".to_string(), JsonValue::String(source_value));
                    }
                    if let Some(display_value) = display_name {
                        details_map
                            .insert("displayName".to_string(), JsonValue::String(display_value));
                    }
                    map.insert("details".to_string(), JsonValue::Object(details_map));
                }
            }

            JsonValue::Object(map)
        }
        other => other,
    }
}

fn build_agent_message_metadata(
    outcome: &str,
    provider: Option<&str>,
    artifacts_count: Option<usize>,
    artifacts: &JsonValue,
    credit_snapshot: Option<&JsonValue>,
    error_message: Option<&str>,
    job_id: &Uuid,
    suggested_replies: &[String],
) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert("source".to_string(), JsonValue::String("agent".to_string()));
    map.insert(
        "outcome".to_string(),
        JsonValue::String(outcome.to_string()),
    );
    if outcome.eq_ignore_ascii_case("failed") {
        map.insert(
            "messageType".to_string(),
            JsonValue::String("error".to_string()),
        );
    }
    map.insert("jobId".to_string(), JsonValue::String(job_id.to_string()));
    if let Some(value) = provider {
        map.insert("provider".to_string(), JsonValue::String(value.to_string()));
    }
    if let Some(count) = artifacts_count {
        map.insert("artifactsCount".to_string(), JsonValue::from(count));
    }
    if !artifacts.is_null() {
        // Same size cap as the agent_jobs.artifacts column: the full payload is
        // also embedded here in conversation_messages.metadata, so a runaway
        // artifact would otherwise land as a multi-MB row on this path too.
        map.insert(
            "artifacts".to_string(),
            cap_artifacts_payload(artifacts).into_owned(),
        );
    }
    if let Some(snapshot) = credit_snapshot {
        map.insert("creditSnapshot".to_string(), snapshot.clone());
    }
    if let Some(message) = error_message {
        map.insert(
            "errorMessage".to_string(),
            JsonValue::String(message.to_string()),
        );
    }
    if !suggested_replies.is_empty() {
        map.insert(
            "ui".to_string(),
            json!({
                "suggestedReplies": suggested_replies,
                "suggestedRepliesMode": "send",
            }),
        );
    }
    JsonValue::Object(map)
}

fn extract_ui_suggested_replies(metadata: &Option<JsonValue>) -> Vec<String> {
    const MAX_REPLIES: usize = 3;
    const MAX_REPLY_CHARS: usize = 160;

    let mut out = Vec::new();
    let mut dedupe = std::collections::HashSet::new();

    let Some(root) = metadata.as_ref().and_then(JsonValue::as_object) else {
        return out;
    };
    let Some(ui) = root.get("ui").and_then(JsonValue::as_object) else {
        return out;
    };

    if let Some(entries) = ui.get("suggestedReplies").and_then(JsonValue::as_array) {
        for entry in entries {
            let candidate = entry.as_str().map(str::to_owned).or_else(|| {
                entry
                    .as_object()
                    .and_then(|map| {
                        map.get("text")
                            .or_else(|| map.get("prompt"))
                            .or_else(|| map.get("reply"))
                            .or_else(|| map.get("label"))
                    })
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned)
            });
            let Some(candidate) = candidate else {
                continue;
            };
            let trimmed = candidate.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = if trimmed.chars().count() > MAX_REPLY_CHARS {
                trimmed.chars().take(MAX_REPLY_CHARS).collect::<String>()
            } else {
                trimmed.to_string()
            };
            if !dedupe.insert(normalized.to_lowercase()) {
                continue;
            }
            out.push(normalized);
            if out.len() >= MAX_REPLIES {
                return out;
            }
        }
    }

    if let Some(value) = ui.get("suggestedReply").and_then(JsonValue::as_str) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            let normalized = if trimmed.chars().count() > MAX_REPLY_CHARS {
                trimmed.chars().take(MAX_REPLY_CHARS).collect::<String>()
            } else {
                trimmed.to_string()
            };
            if dedupe.insert(normalized.to_lowercase()) {
                out.push(normalized);
            }
        }
    }

    out.truncate(MAX_REPLIES);
    out
}

fn build_agent_update_metadata(
    job_id: &Uuid,
    message_type: Option<&str>,
    details: Option<JsonValue>,
) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert("source".to_string(), JsonValue::String("agent".to_string()));
    map.insert(
        "outcome".to_string(),
        JsonValue::String("in_progress".to_string()),
    );
    map.insert("kind".to_string(), JsonValue::String("update".to_string()));
    map.insert("jobId".to_string(), JsonValue::String(job_id.to_string()));
    let normalized_message_type = message_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if let Some(kind) = normalized_message_type.as_deref() {
        map.insert(
            "messageType".to_string(),
            JsonValue::String(kind.to_string()),
        );
    }
    if let Some(details) = details {
        if normalized_message_type
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("multi_agent_plan"))
            .unwrap_or(false)
        {
            if let Some(plan) = extract_multi_agent_plan_details(&details) {
                map.insert("multiAgentPlan".to_string(), plan.clone());
            }
        }
        map.insert("details".to_string(), details);
    }
    JsonValue::Object(map)
}

fn extract_multi_agent_plan_details(value: &JsonValue) -> Option<&JsonValue> {
    let object = value.as_object()?;
    if object.get("agents").and_then(JsonValue::as_array).is_some()
        || object
            .get("type")
            .and_then(JsonValue::as_str)
            .map(|kind| kind.eq_ignore_ascii_case("multi_agent_plan"))
            .unwrap_or(false)
    {
        return Some(value);
    }
    for key in ["multiAgentPlan", "multi_agent_plan", "details"] {
        if let Some(plan) = object.get(key).and_then(extract_multi_agent_plan_details) {
            return Some(plan);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completion_silences_only_successful_explicit_declines() {
        assert!(completion_is_successful_explicit_decline(
            "succeeded",
            Some("NO_RESPONSE"),
            None,
            true,
            false,
        ));
        assert!(completion_is_successful_explicit_decline(
            "succeeded",
            None,
            None,
            false,
            true,
        ));
        assert!(completion_is_successful_explicit_decline(
            "succeeded",
            Some("  "),
            None,
            false,
            true,
        ));

        for (outcome, summary, error, evaluating, declined) in [
            ("succeeded", None, None, true, false),
            ("succeeded", Some("A real finding"), None, true, false),
            ("succeeded", Some("A real finding"), None, false, true),
            (
                "failed",
                Some("NO_RESPONSE"),
                Some("scan failed"),
                true,
                false,
            ),
            ("canceled", Some("NO_RESPONSE"), None, true, false),
            (
                "succeeded",
                Some("NO_RESPONSE"),
                Some("scan failed"),
                true,
                false,
            ),
            ("succeeded", Some("NO_RESPONSE"), None, false, false),
        ] {
            assert!(
                !completion_is_successful_explicit_decline(
                    outcome, summary, error, evaluating, declined,
                ),
                "unexpected silence for outcome={outcome}, summary={summary:?}, error={error:?}"
            );
        }
    }

    #[test]
    fn completion_content_changes_are_scoped_to_authenticated_evaluations() {
        assert_eq!(
            select_completion_message_content(
                "failed",
                Some("legacy summary"),
                Some("failure detail"),
                false,
            ),
            Some("legacy summary")
        );
        assert_eq!(
            select_completion_message_content(
                "failed",
                Some("NO_RESPONSE"),
                Some("failure detail"),
                true,
            ),
            Some("failure detail")
        );
        assert_eq!(
            select_completion_message_content("succeeded", Some("   "), None, true),
            None
        );
        assert_eq!(
            select_completion_message_content("succeeded", Some("   "), None, false),
            Some("   ")
        );
        assert_eq!(
            select_completion_message_content(
                "succeeded",
                Some("NO_RESPONSE"),
                Some("failure detail"),
                true,
            ),
            Some("failure detail")
        );
        assert_eq!(
            select_completion_message_content("succeeded", Some("NO_RESPONSE"), Some("   "), true,),
            None
        );
    }

    #[test]
    fn plain_text_final_status_can_drive_an_authenticated_evaluation() {
        assert!(agent_message_can_drive_evaluation(
            Some("status"),
            Some(&json!({
                "kind": "agent_message",
                "event": { "type": "item.completed" }
            })),
        ));
        assert!(!agent_message_can_drive_evaluation(
            Some("status"),
            Some(&json!({ "kind": "runtime_status" })),
        ));
        assert!(agent_message_can_drive_evaluation(Some("assistant"), None,));
    }

    #[test]
    fn automation_evaluation_preamble_explains_the_success_only_protocol() {
        let metadata = json!({
            "groupParticipation": {
                "decision": "agent_evaluation",
                "reason": crate::group_participation::AUTOMATION_NOTHING_TO_REPORT_REASON,
                "enforcedBy": "runtime-controller"
            }
        });

        let preamble = build_agent_evaluation_preamble(&metadata);

        assert!(preamble.contains("Scheduled automation run"));
        assert!(preamble.contains("nothing worth reporting"));
        assert!(preamble.contains("Never use NO_RESPONSE for an error"));
    }

    #[test]
    fn agent_message_delivery_locks_the_exact_live_job_row() {
        for runtime_scoped in [false, true] {
            let sql = agent_message_job_select_sql(runtime_scoped).to_ascii_lowercase();
            for fence in [
                "from agent_jobs",
                "where id = $1",
                "project_id = $2",
                "status = 'leased'",
                "for update",
            ] {
                assert!(
                    sql.contains(fence),
                    "missing message-delivery fence: {fence}"
                );
            }
            assert_eq!(
                sql.matches("for update").count(),
                1,
                "job row must be locked exactly once"
            );
        }
        assert!(agent_message_job_select_sql(true)
            .contains("coalesce(leased_by_runtime_id, $3::uuid) = $3"));
        assert!(!agent_message_job_select_sql(false).contains("$3"));
    }

    #[test]
    fn runtime_scoped_agent_cannot_override_identity_when_strict_mode_is_off() {
        let token_runtime = Uuid::new_v4();
        let victim_runtime = Uuid::new_v4();

        assert!(runtime_override_matches_token_scope(
            Some(token_runtime),
            Some(token_runtime)
        ));
        assert!(!runtime_override_matches_token_scope(
            Some(token_runtime),
            Some(victim_runtime)
        ));
        // A body-supplied runtime ID is never an identity credential. This
        // must also fail when strict mode is off and the token is unscoped.
        assert!(!runtime_override_matches_token_scope(
            None,
            Some(victim_runtime)
        ));
    }

    #[test]
    fn personal_browser_runtime_must_be_live_self_hosted_and_attested_to_lease() {
        let owner = Uuid::new_v4();
        let personal = json!({
            "personalBrowser": {
                "enabled": true,
                "ownerUserId": owner.to_string(),
            }
        });

        assert!(runtime_record_can_lease(
            "self-hosted",
            "ready",
            &personal,
            true
        ));
        assert!(!runtime_record_can_lease(
            "docker", "ready", &personal, true
        ));
        assert!(!runtime_record_can_lease(
            "self-hosted",
            "stopped",
            &personal,
            true
        ));
        assert!(!runtime_record_can_lease(
            "self-hosted",
            "ready",
            &json!({ "personalBrowser": { "enabled": true } }),
            true
        ));
        assert!(runtime_record_can_lease(
            "docker",
            "running",
            &json!({ "agent": true }),
            false
        ));
        assert!(!runtime_record_can_lease(
            "self-hosted",
            "draining",
            &personal,
            true
        ));
    }

    #[test]
    fn heartbeat_only_continues_on_live_runtime_statuses() {
        assert!(runtime_status_can_heartbeat("ready"));
        assert!(runtime_status_can_heartbeat("running"));
        assert!(runtime_status_can_heartbeat("draining"));
        for status in [
            "requested",
            "launching",
            "stopping",
            "stopped",
            "offline",
            "removed",
            "error",
        ] {
            assert!(
                !runtime_status_can_heartbeat(status),
                "{status} must not renew an agent job lease"
            );
        }
    }

    #[test]
    fn agent_capabilities_require_a_current_active_runtime() {
        ensure_agent_token_runtime_is_active("ready")
            .expect("ready runtime must retain agent capabilities");
        ensure_agent_token_runtime_is_active("running")
            .expect("running runtime must retain agent capabilities");
        ensure_agent_token_runtime_is_active("draining")
            .expect("draining runtime must finish its active job");

        for status in [
            "requested",
            "launching",
            "stopping",
            "stopped",
            "offline",
            "removed",
            "error",
        ] {
            let (response_status, body) = ensure_agent_token_runtime_is_active(status)
                .expect_err("non-active runtime must lose agent capabilities");
            assert_eq!(response_status, StatusCode::UNAUTHORIZED);
            assert_eq!(body.0.message, "agent token runtime is no longer active");
        }
    }

    #[test]
    fn agent_token_generation_must_equal_active_runtime_lease() {
        let active_lease_id = Uuid::new_v4();
        ensure_agent_token_generation_matches(Some(active_lease_id), Some(active_lease_id))
            .expect("current hosted generation should be accepted");
        ensure_agent_token_generation_matches(None, None)
            .expect("unleased self-hosted runtime should be accepted");

        for token_lease_id in [None, Some(Uuid::new_v4())] {
            let (status, body) =
                ensure_agent_token_generation_matches(token_lease_id, Some(active_lease_id))
                    .expect_err("missing or stale hosted generation must be rejected");
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(
                body.0.message,
                "agent token runtime lease scope is no longer active"
            );
        }

        let (status, _) = ensure_agent_token_generation_matches(Some(active_lease_id), None)
            .expect_err("released generation must not authorize an unleased runtime");
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn self_hosted_agent_token_requires_exact_persisted_runtime_generation() {
        let current_generation = Uuid::new_v4();
        let stale_generation = Uuid::new_v4();
        let mut capabilities = json!({ "agent": true });

        let (status, body) =
            ensure_agent_token_runtime_binding_matches(&capabilities, None, None, None, true)
                .expect_err("unattested self-hosted runtime must be quarantined");
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            body.0.message,
            "private self-hosted runtime is missing its controller owner attestation"
        );

        let owner = Uuid::new_v4();
        runtime::set_self_hosted_access_attestation(
            capabilities
                .as_object_mut()
                .expect("test capabilities object"),
            owner,
        );
        runtime::set_runtime_generation_capability(&mut capabilities, current_generation);
        ensure_agent_token_runtime_binding_matches(
            &capabilities,
            None,
            None,
            Some(current_generation),
            true,
        )
        .expect("current self-hosted generation should be accepted");

        for token_generation in [None, Some(stale_generation)] {
            let (status, body) = ensure_agent_token_runtime_binding_matches(
                &capabilities,
                None,
                None,
                token_generation,
                true,
            )
            .expect_err("unmarked or stale generation must fail after a successor is persisted");
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(
                body.0.message,
                "runtime token generation is no longer current"
            );
        }

        // Hosted runtime authority remains lease-bound; its self-hosted
        // generation marker is intentionally ignored.
        let hosted_lease = Uuid::new_v4();
        ensure_agent_token_runtime_binding_matches(
            &capabilities,
            Some(hosted_lease),
            Some(hosted_lease),
            Some(stale_generation),
            false,
        )
        .expect("hosted runtime behavior must remain lease-bound");
    }

    #[test]
    fn agent_token_verification_parses_and_requires_well_formed_lease_scope() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "agent-token-lease-scope",
        );
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();

        let mint = |lease_id: Option<String>| {
            crate::tokens::mint_scoped_token(
                &config,
                ScopedTokenRequest {
                    audience: runtime_id.to_string(),
                    subject: "runtime.test".to_string(),
                    project_id: project_id.to_string(),
                    origin_id: None,
                    runtime_id: Some(runtime_id.to_string()),
                    protocol: None,
                    scopes: vec!["agent.lease".to_string()],
                    lease_id,
                    run_id: None,
                    prefer_runtime: None,
                    ttl_seconds: Some(120),
                },
            )
            .expect("mint agent token")
            .token
        };

        let token = mint(Some(lease_id.to_string()));
        let context = verify_agent_token_with_scopes(&config, &token, &["agent.lease"])
            .expect("verify lease-bound token");
        assert_eq!(context.project_id, project_id);
        assert_eq!(context.runtime_id, Some(runtime_id));
        assert_eq!(context.lease_id, Some(lease_id));

        let malformed = mint(Some("not-a-uuid".to_string()));
        let (status, body) = verify_agent_token_with_scopes(&config, &malformed, &["agent.lease"])
            .expect_err("malformed lease claim must fail closed");
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body.0.message, "agent token runtime lease scope invalid");
    }

    #[test]
    fn build_agent_lease_metrics_captures_runtime_handle_and_queue_wait() {
        let queued_at = DateTime::parse_from_rfc3339("2026-05-12T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let leased_at = DateTime::parse_from_rfc3339("2026-05-12T10:00:02.250Z")
            .unwrap()
            .with_timezone(&Utc);
        let completed_at = DateTime::parse_from_rfc3339("2026-05-12T10:00:06.500Z")
            .unwrap()
            .with_timezone(&Utc);
        let runtime_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();

        let metrics = build_agent_lease_metrics(
            &json!({
                "metadata": {
                    "agent": {
                        "handle": "@Octo"
                    }
                }
            }),
            queued_at,
            Some(leased_at),
            Some(completed_at),
            2,
            Some(runtime_id),
            Some(3),
        );

        assert_eq!(metrics.queue_wait_ms, Some(2250));
        assert_eq!(metrics.wall_time_ms, Some(4250));
        assert_eq!(metrics.completed_at, Some(completed_at));
        assert_eq!(metrics.lease_attempts, 2);
        assert_eq!(metrics.leased_by_runtime_id, Some(runtime_id));
        assert_eq!(metrics.tool_update_count, Some(3));
        assert_eq!(metrics.agent_handle.as_deref(), Some("octo"));
    }

    #[test]
    fn build_agent_update_metadata_wraps_details() {
        let job_id = Uuid::parse_str("00000000-0000-0000-0000-000000000000").unwrap();
        let details = json!({
            "kind": "agent_message",
            "event": { "type": "item.completed" }
        });

        let metadata = build_agent_update_metadata(&job_id, Some("status"), Some(details));
        assert_eq!(metadata["source"], json!("agent"));
        assert_eq!(metadata["kind"], json!("update"));
        assert_eq!(metadata["messageType"], json!("status"));
        assert!(metadata.get("details").is_some());
        let details_obj = metadata["details"].as_object().expect("details map");
        assert_eq!(
            details_obj.get("kind").and_then(JsonValue::as_str),
            Some("agent_message")
        );
    }

    #[test]
    fn build_agent_update_metadata_promotes_multi_agent_plan_details() {
        let job_id = Uuid::parse_str("00000000-0000-0000-0000-000000000000").unwrap();
        let details = json!({
            "messageType": "multi_agent_plan",
            "details": {
                "type": "multi_agent_plan",
                "mode": "read_only",
                "agents": [
                    {
                        "handle": "source-review",
                        "prompt": "Inspect source."
                    }
                ]
            }
        });

        let metadata =
            build_agent_update_metadata(&job_id, Some("multi_agent_plan"), Some(details));

        assert_eq!(metadata["messageType"], json!("multi_agent_plan"));
        assert_eq!(
            metadata["multiAgentPlan"]["agents"][0]["handle"],
            json!("source-review")
        );
        assert_eq!(metadata["details"]["details"]["mode"], json!("read_only"));
    }

    #[test]
    fn sanitize_json_for_postgres_replaces_nested_nul_characters() {
        let value = sanitize_json_for_postgres(json!({
            "content": "before\u{0000}after",
            "events": [
                {
                    "output": "line\u{0000}tail"
                }
            ],
            "ok": true
        }));

        assert_eq!(value["content"], json!("before\u{FFFD}after"));
        assert_eq!(value["events"][0]["output"], json!("line\u{FFFD}tail"));
        assert_eq!(value["ok"], json!(true));
    }

    #[test]
    fn agent_history_excludes_progress_updates() {
        let job_id = Uuid::parse_str("00000000-0000-0000-0000-000000000000").unwrap();
        let command_update = build_agent_update_metadata(
            &job_id,
            Some("command_execution"),
            Some(json!({ "command": "python AGENTS.py" })),
        );
        assert!(!should_include_message_in_agent_history(
            "assistant",
            &command_update,
            Some("command_execution"),
        ));

        let plan_update = build_agent_update_metadata(
            &job_id,
            Some("multi_agent_plan"),
            Some(json!({ "mode": "read_only" })),
        );
        assert!(!should_include_message_in_agent_history(
            "assistant",
            &plan_update,
            Some("multi_agent_plan"),
        ));

        let usage_update = json!({
            "source": "agent",
            "messageType": "token_usage",
        });
        assert!(!should_include_message_in_agent_history(
            "assistant",
            &usage_update,
            Some("token_usage"),
        ));

        let reasoning_update = json!({
            "source": "agent",
            "kind": "codex_reasoning",
            "messageType": "reasoning",
        });
        assert!(!should_include_message_in_agent_history(
            "assistant",
            &reasoning_update,
            Some("reasoning"),
        ));

        // The one carve-out: a secret card wears the same in-progress stamp as
        // everything above, and must survive it anyway, or the agent cannot see
        // that it has already asked.
        let secret_card = build_agent_update_metadata(
            &job_id,
            Some("secret_request"),
            Some(json!({ "name": "NOTION_API_KEY" })),
        );
        assert_eq!(secret_card["kind"], json!("update"));
        assert_eq!(secret_card["outcome"], json!("in_progress"));
        assert!(should_include_message_in_agent_history(
            "assistant",
            &secret_card,
            Some("secret_request"),
        ));
    }

    #[test]
    fn agent_history_keeps_user_and_terminal_assistant_messages() {
        let terminal_message = json!({
            "source": "agent",
            "outcome": "succeeded",
            "jobId": "00000000-0000-0000-0000-000000000000"
        });

        assert!(should_include_message_in_agent_history(
            "assistant",
            &terminal_message,
            None,
        ));
        assert!(should_include_message_in_agent_history(
            "user",
            &json!({
                "source": "agent",
                "kind": "update",
                "outcome": "in_progress",
                "messageType": "command_execution"
            }),
            Some("command_execution"),
        ));
    }

    #[test]
    fn extract_ui_suggested_replies_prefers_array_and_dedupes() {
        let metadata = Some(json!({
            "ui": {
                "suggestedReplies": [
                    "  open the logs  ",
                    "Open the logs",
                    { "prompt": "run the migration" },
                    "",
                    "deploy to production"
                ],
                "suggestedReply": "fallback value"
            }
        }));

        let replies = extract_ui_suggested_replies(&metadata);
        assert_eq!(
            replies,
            vec![
                "open the logs".to_string(),
                "run the migration".to_string(),
                "deploy to production".to_string()
            ]
        );
    }

    #[test]
    fn build_agent_message_metadata_includes_suggested_replies() {
        let job_id = Uuid::parse_str("00000000-0000-0000-0000-000000000000").unwrap();
        let replies = vec!["open the logs".to_string(), "run the migration".to_string()];

        let metadata = build_agent_message_metadata(
            "succeeded",
            Some("codex-embedded"),
            Some(0),
            &JsonValue::Null,
            None,
            None,
            &job_id,
            &replies,
        );

        assert_eq!(metadata["ui"]["suggestedReplies"], json!(replies));
        assert_eq!(metadata["ui"]["suggestedRepliesMode"], json!("send"));
    }

    #[test]
    fn build_agent_message_metadata_marks_failed_outcomes_as_error() {
        let job_id = Uuid::parse_str("00000000-0000-0000-0000-000000000000").unwrap();

        let metadata = build_agent_message_metadata(
            "failed",
            Some("codex-embedded"),
            None,
            &JsonValue::Null,
            None,
            Some("Backend said no"),
            &job_id,
            &[],
        );

        assert_eq!(metadata["messageType"], json!("error"));
        assert_eq!(metadata["errorMessage"], json!("Backend said no"));
    }

    #[test]
    fn assistant_message_belongs_to_agent_scope_filters_other_agent_messages() {
        let planner_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();

        assert!(assistant_message_belongs_to_agent_scope(
            &json!({
                "source": "agent",
                "agent": {
                    "id": planner_id,
                    "handle": "planner"
                }
            }),
            Some(&planner_id),
            Some("planner"),
        ));

        assert!(!assistant_message_belongs_to_agent_scope(
            &json!({
                "source": "agent",
                "agent": {
                    "id": "22222222-2222-2222-2222-222222222222",
                    "handle": "builder"
                }
            }),
            Some(&planner_id),
            Some("planner"),
        ));

        assert!(assistant_message_belongs_to_agent_scope(
            &json!({
                "source": "agent",
                "agent": {
                    "handle": "planner"
                }
            }),
            None,
            Some("planner"),
        ));

        assert!(!assistant_message_belongs_to_agent_scope(
            &json!({
                "source": "agent",
                "agent": {
                    "handle": "builder"
                }
            }),
            None,
            Some("planner"),
        ));

        assert!(assistant_message_belongs_to_agent_scope(
            &json!({
                "messageType": "status"
            }),
            Some(&planner_id),
            Some("planner"),
        ));
    }

    #[test]
    fn merge_runtime_preference_from_job_payload_preserves_workspace_mode_metadata() {
        let merged = merge_runtime_preference_from_job_payload(
            json!({
                "source": "agent"
            }),
            &json!({
                "conversation_id": "00000000-0000-0000-0000-000000000123",
                "executionMode": "shared_write",
                "metadata": {
                    "agent": {
                        "id": "00000000-0000-0000-0000-000000000999",
                        "handle": "builder"
                    },
                    "linkedThreadId": "thread-local-123",
                    "advisoryScopeClaims": [{
                        "kind": "task",
                        "label": "Investigate auth middleware",
                        "scope": "Investigate auth middleware",
                        "advisory": true,
                        "source": "prompt"
                    }],
                    "agentCollaboration": {
                        "mode": "thread"
                    },
                    "writeScope": {
                        "mode": "owned",
                        "ownedPaths": ["src/App.tsx"],
                        "rationale": "explicit owned path"
                    },
                    "multiAgentPlan": {
                        "groupId": "group-1",
                        "role": "worker",
                        "parentJobId": "job-parent-1"
                    },
                    "writeIntent": true
                }
            }),
        );

        assert_eq!(
            merged["agentThreadId"],
            json!("00000000-0000-0000-0000-000000000123")
        );
        assert_eq!(
            merged["sourceAgentId"],
            json!("00000000-0000-0000-0000-000000000999")
        );
        assert_eq!(merged["executionMode"], json!("shared_write"));
        assert_eq!(merged["writeIntent"], json!(true));
        assert_eq!(merged["linkedThreadId"], json!("thread-local-123"));
        assert_eq!(
            merged["advisoryScopeClaims"],
            json!([{
                "kind": "task",
                "label": "Investigate auth middleware",
                "scope": "Investigate auth middleware",
                "advisory": true,
                "source": "prompt"
            }])
        );
        assert_eq!(merged["agentCollaboration"], json!({ "mode": "thread" }));
        assert_eq!(merged["writeScope"]["mode"], json!("owned"));
        assert_eq!(merged["writeScope"]["ownedPaths"], json!(["src/App.tsx"]));
        assert_eq!(merged["multiAgentPlan"]["role"], json!("worker"));
        assert_eq!(
            merged["multiAgentPlan"]["parentJobId"],
            json!("job-parent-1")
        );
    }

    #[test]
    fn job_controller_token_scopes_withhold_provider_calls_and_write_for_read_only_jobs() {
        let mut job = AgentJob {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            run_id: Some(Uuid::new_v4()),
            prompt_id: None,
            session_id: None,
            conversation_id: None,
            credential_id: None,
            intent: None,
            status: "leased".to_string(),
            outcome: None,
            payload: json!({}),
            priority: 0,
            lease_attempts: 1,
            leased_at: Some(Utc::now()),
            lease_expires_at: None,
            leased_by_runtime_id: Some(Uuid::new_v4()),
            target_runtime_id: None,
            heartbeat_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            lease_metrics: AgentLeaseMetrics {
                queued_at: Utc::now(),
                leased_at: Some(Utc::now()),
                completed_at: None,
                queue_wait_ms: None,
                wall_time_ms: None,
                lease_attempts: 1,
                leased_by_runtime_id: None,
                agent_handle: None,
                tool_update_count: None,
            },
            proxy: None,
            controller_token: None,
            controller_token_expires_at: None,
            controller_token_scopes: None,
            workspace_token: None,
            workspace_token_expires_at: None,
            workspace_token_scopes: None,
        };

        assert_eq!(
            job_controller_token_scopes(&job),
            vec!["prompt.execute".to_string(), "fs.write".to_string()]
        );

        job.payload = json!({
            "metadata": {
                "writeScope": {
                    "mode": "read_only",
                    "readOnlyPaths": ["src/**"]
                }
            }
        });
        assert_eq!(
            job_controller_token_scopes(&job),
            vec!["prompt.execute".to_string()]
        );

        job.payload = json!({
            "writeIntent": false,
            "metadata": {}
        });
        assert_eq!(
            job_controller_token_scopes(&job),
            vec!["prompt.execute".to_string()]
        );

        job.payload = json!({
            "metadata": {
                "workspaceMode": "shared_read"
            }
        });
        assert_eq!(
            job_controller_token_scopes(&job),
            vec!["prompt.execute".to_string()]
        );

        job.payload = json!({
            "metadata": {
                "execution_mode": "plan_only"
            }
        });
        assert_eq!(
            job_controller_token_scopes(&job),
            vec!["prompt.execute".to_string()]
        );

        job.payload = json!({
            "metadata": {
                "writeScope": {
                    "mode": "owned",
                    "ownedPaths": ["src/App.tsx"]
                }
            }
        });
        assert_eq!(
            job_controller_token_scopes(&job),
            vec!["prompt.execute".to_string(), "fs.write".to_string()]
        );

        job.payload = json!({
            "writeIntent": true,
            "executionMode": "shared_write"
        });
        assert_eq!(
            job_controller_token_scopes(&job),
            vec!["prompt.execute".to_string(), "fs.write".to_string()]
        );
    }

    #[test]
    fn extract_controller_subject_user_id_uses_payload_user_id() {
        let user_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let job = AgentJob {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            run_id: None,
            prompt_id: None,
            session_id: None,
            conversation_id: None,
            credential_id: None,
            intent: None,
            status: "queued".to_string(),
            outcome: None,
            payload: json!({
                "user_id": user_id.to_string()
            }),
            priority: 0,
            lease_attempts: 0,
            leased_at: None,
            lease_expires_at: None,
            leased_by_runtime_id: None,
            target_runtime_id: None,
            heartbeat_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            lease_metrics: AgentLeaseMetrics {
                queued_at: Utc::now(),
                leased_at: None,
                completed_at: None,
                queue_wait_ms: None,
                wall_time_ms: None,
                lease_attempts: 0,
                leased_by_runtime_id: None,
                agent_handle: None,
                tool_update_count: None,
            },
            proxy: None,
            controller_token: None,
            controller_token_expires_at: None,
            controller_token_scopes: None,
            workspace_token: None,
            workspace_token_expires_at: None,
            workspace_token_scopes: None,
        };

        assert_eq!(extract_controller_subject_user_id(&job), Some(user_id));
    }

    #[test]
    fn extract_controller_subject_user_id_ignores_invalid_payload_user_id() {
        let job = AgentJob {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            run_id: None,
            prompt_id: None,
            session_id: None,
            conversation_id: None,
            credential_id: None,
            intent: None,
            status: "queued".to_string(),
            outcome: None,
            payload: json!({
                "user_id": "not-a-uuid"
            }),
            priority: 0,
            lease_attempts: 0,
            leased_at: None,
            lease_expires_at: None,
            leased_by_runtime_id: None,
            target_runtime_id: None,
            heartbeat_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            lease_metrics: AgentLeaseMetrics {
                queued_at: Utc::now(),
                leased_at: None,
                completed_at: None,
                queue_wait_ms: None,
                wall_time_ms: None,
                lease_attempts: 0,
                leased_by_runtime_id: None,
                agent_handle: None,
                tool_update_count: None,
            },
            proxy: None,
            controller_token: None,
            controller_token_expires_at: None,
            controller_token_scopes: None,
            workspace_token: None,
            workspace_token_expires_at: None,
            workspace_token_scopes: None,
        };

        assert_eq!(extract_controller_subject_user_id(&job), None);
    }

    #[test]
    fn controller_token_attachment_negotiates_separate_workspace_credential() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "job-workspace-token-negotiation",
        );
        let project_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let runtime_lease_id = Uuid::new_v4();
        let runtime_generation = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let build_job = || AgentJob {
            id: Uuid::new_v4(),
            project_id,
            run_id: Some(run_id),
            prompt_id: None,
            session_id: None,
            conversation_id: Some(Uuid::new_v4()),
            credential_id: None,
            intent: Some("feature".to_string()),
            status: "leased".to_string(),
            outcome: None,
            payload: json!({
                "user_id": user_id,
                "writeIntent": true,
            }),
            priority: 0,
            lease_attempts: 1,
            leased_at: Some(Utc::now()),
            lease_expires_at: Some(Utc::now() + chrono::Duration::minutes(5)),
            leased_by_runtime_id: Some(runtime_id),
            target_runtime_id: Some(runtime_id),
            heartbeat_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            lease_metrics: AgentLeaseMetrics {
                queued_at: Utc::now(),
                leased_at: Some(Utc::now()),
                completed_at: None,
                queue_wait_ms: Some(1),
                wall_time_ms: None,
                lease_attempts: 1,
                leased_by_runtime_id: Some(runtime_id),
                agent_handle: None,
                tool_update_count: None,
            },
            proxy: None,
            controller_token: None,
            controller_token_expires_at: None,
            controller_token_scopes: None,
            workspace_token: None,
            workspace_token_expires_at: None,
            workspace_token_scopes: None,
        };

        let mut legacy_jobs = vec![build_job()];
        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            false,
            &mut legacy_jobs,
        );
        let legacy = &legacy_jobs[0];
        assert!(legacy.workspace_token.is_none());
        let legacy_scopes = legacy
            .controller_token_scopes
            .as_ref()
            .expect("legacy controller token scopes");
        assert!(legacy_scopes.iter().any(|scope| scope == "prompt.execute"));
        assert!(legacy_scopes
            .iter()
            .any(|scope| scope == crate::origins::JOB_GIT_TOKEN_MINT_SCOPE));
        assert!(!legacy_scopes
            .iter()
            .any(|scope| scope == crate::origins::JOB_TOKEN_SEPARATED_SCOPE));
        let legacy_claims = decode_scoped_token(
            &config,
            legacy
                .controller_token
                .as_deref()
                .expect("legacy controller token"),
            "legacy job token",
        )
        .expect("decode legacy job token");
        assert_eq!(
            legacy_claims.lease_id.as_deref(),
            Some(runtime_lease_id.to_string().as_str())
        );

        let mut current_jobs = vec![build_job()];
        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            true,
            &mut current_jobs,
        );
        let current = &current_jobs[0];
        let controller_scopes = current
            .controller_token_scopes
            .as_ref()
            .expect("controller token scopes");
        assert!(controller_scopes
            .iter()
            .any(|scope| scope == crate::origins::JOB_TOKEN_SEPARATED_SCOPE));
        assert!(!controller_scopes
            .iter()
            .any(|scope| scope == crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE));
        assert!(!controller_scopes
            .iter()
            .any(|scope| scope == crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE));
        assert_eq!(
            current.workspace_token_scopes.as_deref(),
            Some(
                [
                    crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE.to_string(),
                    crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE.to_string(),
                ]
                .as_slice()
            )
        );

        for token in [
            current
                .controller_token
                .as_deref()
                .expect("controller token"),
            current.workspace_token.as_deref().expect("workspace token"),
        ] {
            let claims = decode_scoped_token(&config, token, "job token")
                .expect("decode negotiated job token");
            assert_eq!(claims.project_id, project_id.to_string());
            assert_eq!(
                claims.runtime_id.as_deref(),
                Some(runtime_id.to_string().as_str())
            );
            assert_eq!(claims.run_id.as_deref(), Some(run_id.to_string().as_str()));
            assert_eq!(
                claims.lease_id.as_deref(),
                Some(runtime_lease_id.to_string().as_str())
            );
            assert_eq!(claims.aud, runtime_id.to_string());
            assert_eq!(
                claims.runtime_generation.as_deref(),
                Some(runtime_generation.to_string().as_str())
            );
        }

        for write_intent in [Some(false), None] {
            let mut job = build_job();
            let payload = job
                .payload
                .as_object_mut()
                .expect("test job payload must be an object");
            match write_intent {
                Some(value) => {
                    payload.insert("writeIntent".to_string(), json!(value));
                }
                None => {
                    payload.remove("writeIntent");
                }
            }
            let mut jobs = vec![job];
            attach_controller_tokens(
                &config,
                Some(&runtime_id),
                Some(&runtime_lease_id),
                Some(runtime_generation),
                true,
                &mut jobs,
            );
            assert!(jobs[0].controller_token.is_some());
            assert!(
                jobs[0].workspace_token.is_none(),
                "workspace credential must require explicit writeIntent=true"
            );
            assert!(
                !jobs[0]
                    .controller_token_scopes
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .any(|scope| scope == crate::origins::JOB_TOKEN_SEPARATED_SCOPE),
                "controller token must not promise an omitted workspace credential"
            );
        }

        let mut read_only_job = build_job();
        read_only_job.payload["metadata"] = json!({
            "writeScope": { "mode": "read-only" },
        });
        let mut read_only_jobs = vec![read_only_job];
        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            true,
            &mut read_only_jobs,
        );
        assert!(read_only_jobs[0].controller_token.is_some());
        assert!(
            read_only_jobs[0].workspace_token.is_none(),
            "explicit read-only scope must not receive a workspace credential"
        );

        let mut shared_browser_job = build_job();
        shared_browser_job.payload["writeIntent"] = json!(false);
        shared_browser_job.payload["metadata"] = json!({
            "browserTransport": "shared",
            "writeScope": { "mode": "read-only" },
        });
        let mut shared_browser_jobs = vec![shared_browser_job];
        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            true,
            &mut shared_browser_jobs,
        );
        let shared_browser_job = &shared_browser_jobs[0];
        assert!(shared_browser_job.controller_token.is_some());
        assert!(
            shared_browser_job.workspace_token.is_some(),
            "an exact-runtime Shared Browser job must receive the separated internal token"
        );
        assert_eq!(
            shared_browser_job.workspace_token_scopes.as_deref(),
            Some(
                [
                    crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE.to_string(),
                    crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE.to_string(),
                ]
                .as_slice()
            )
        );
        assert!(
            !crate::origins::job_allows_workspace_mutation(&shared_browser_job.payload),
            "the internal protocol token must not make the browser job writable"
        );
        assert!(
            serde_json::to_value(shared_browser_job)
                .expect("serialize Shared Browser lease")
                .get("target_runtime_id")
                .is_none(),
            "controller-only target binding must not leak into the lease response"
        );

        let mut mismatched_shared_job = build_job();
        mismatched_shared_job.payload["writeIntent"] = json!(false);
        mismatched_shared_job.payload["metadata"] = json!({
            "browser_transport": "shared",
            "write_scope": { "mode": "read_only" },
        });
        mismatched_shared_job.target_runtime_id = Some(Uuid::new_v4());
        let mut mismatched_shared_jobs = vec![mismatched_shared_job];
        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            true,
            &mut mismatched_shared_jobs,
        );
        assert!(
            mismatched_shared_jobs[0].workspace_token.is_none(),
            "Shared Browser protocol credentials require the exact dispatch runtime"
        );

        let mut terminal_job = build_job();
        terminal_job.intent = Some("terminal_command".to_string());
        terminal_job.payload["writeIntent"] = json!(false);
        terminal_job.payload["metadata"] = json!({
            "runtimeExpectations": { "commandExecution": true },
        });
        let mut terminal_jobs = vec![terminal_job];
        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            true,
            &mut terminal_jobs,
        );
        assert!(
            terminal_jobs[0].workspace_token.is_none(),
            "a read-only terminal job stays on the unseparated controller token"
        );
        assert!(
            !terminal_jobs[0]
                .controller_token_scopes
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|scope| scope == crate::origins::JOB_TOKEN_SEPARATED_SCOPE),
            "a read-only terminal job must not promise a separated workspace credential"
        );
        assert!(
            !crate::origins::job_allows_workspace_mutation(&terminal_jobs[0].payload),
            "the terminal lane must not broaden a read-only terminal job"
        );

        let mut personal_browser_job = build_job();
        personal_browser_job.payload["writeIntent"] = json!(false);
        personal_browser_job.payload["metadata"] = json!({
            "browserTransport": "desktop-personal",
            "writeScope": { "mode": "read-only" },
        });
        let mut personal_browser_jobs = vec![personal_browser_job];
        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            true,
            &mut personal_browser_jobs,
        );
        assert!(
            personal_browser_jobs[0].workspace_token.is_none(),
            "the Shared Browser protocol exception must not broaden Personal Browser jobs"
        );
    }

    #[test]
    fn read_only_terminal_apply_lease_does_not_promise_workspace_token() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "terminal-apply-no-workspace-token",
        );
        let project_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let runtime_lease_id = Uuid::new_v4();
        let runtime_generation = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let now = Utc::now();
        let mut jobs = vec![AgentJob {
            id: Uuid::new_v4(),
            project_id,
            run_id: Some(run_id),
            prompt_id: None,
            session_id: None,
            conversation_id: Some(Uuid::new_v4()),
            credential_id: None,
            intent: Some("terminal_command".to_string()),
            status: "leased".to_string(),
            outcome: None,
            payload: json!({
                "user_id": user_id,
                "writeIntent": false,
                "executionMode": "shared_write",
                "metadata": {
                    "execution_mode": "apply",
                    "runtimeExpectations": {
                        "commandExecution": true
                    },
                    "terminalCommand": {
                        "command": "pwd",
                        "shell": "bash"
                    },
                    "writeIntent": false
                }
            }),
            priority: 0,
            lease_attempts: 1,
            leased_at: Some(now),
            lease_expires_at: Some(now + chrono::Duration::minutes(5)),
            leased_by_runtime_id: Some(runtime_id),
            target_runtime_id: Some(runtime_id),
            heartbeat_at: None,
            created_at: now,
            updated_at: now,
            lease_metrics: AgentLeaseMetrics {
                queued_at: now,
                leased_at: Some(now),
                completed_at: None,
                queue_wait_ms: Some(1),
                wall_time_ms: None,
                lease_attempts: 1,
                leased_by_runtime_id: Some(runtime_id),
                agent_handle: None,
                tool_update_count: None,
            },
            proxy: None,
            controller_token: None,
            controller_token_expires_at: None,
            controller_token_scopes: None,
            workspace_token: None,
            workspace_token_expires_at: None,
            workspace_token_scopes: None,
        }];

        attach_controller_tokens(
            &config,
            Some(&runtime_id),
            Some(&runtime_lease_id),
            Some(runtime_generation),
            true,
            &mut jobs,
        );

        let job = &jobs[0];
        assert!(
            !crate::origins::job_allows_workspace_mutation(&job.payload),
            "terminal command fixture must remain outside origin write authority"
        );
        assert!(
            !job.controller_token_scopes
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|scope| scope == crate::origins::JOB_TOKEN_SEPARATED_SCOPE),
            "controller token must not promise an omitted workspace credential"
        );
        assert!(
            job.workspace_token.is_none(),
            "read-only terminal command does not consume an internal workspace token"
        );
        assert!(job.workspace_token_scopes.is_none());

        let claims = decode_scoped_token(
            &config,
            job.controller_token
                .as_deref()
                .expect("terminal apply controller token"),
            "terminal apply controller token",
        )
        .expect("decode terminal apply controller token");
        assert_eq!(claims.project_id, project_id.to_string());
        assert_eq!(
            claims.runtime_id.as_deref(),
            Some(runtime_id.to_string().as_str())
        );
        assert_eq!(claims.run_id.as_deref(), Some(run_id.to_string().as_str()));
        assert!(claims.scopes.iter().any(|scope| scope == "prompt.execute"));
        assert!(!claims
            .scopes
            .iter()
            .any(|scope| scope == crate::origins::JOB_TOKEN_SEPARATED_SCOPE));
        assert_eq!(
            claims.lease_id.as_deref(),
            Some(runtime_lease_id.to_string().as_str())
        );
        assert_eq!(
            claims.runtime_generation.as_deref(),
            Some(runtime_generation.to_string().as_str())
        );
    }

    #[test]
    fn merge_run_completion_metadata_preserves_existing_provider_conversation() {
        let merged = merge_run_completion_metadata(
            Some(&json!({
                "provider": {
                    "conversation": {
                        "responseId": "resp_123"
                    }
                },
                "custom": true
            })),
            Some("openai"),
            None,
            Some(&json!({
                "remainingCredits": 42
            })),
            Some("Done"),
            None,
            Some(3),
        );

        assert_eq!(merged["provider"]["id"], json!("openai"));
        assert_eq!(
            merged["provider"]["conversation"]["responseId"],
            json!("resp_123")
        );
        assert_eq!(merged["creditSnapshot"]["remainingCredits"], json!(42));
        assert_eq!(merged["summary"], json!("Done"));
        assert_eq!(merged["artifactsCount"], json!(3));
        assert_eq!(merged["custom"], json!(true));
    }

    #[test]
    fn merge_run_completion_metadata_replaces_non_object_provider_shape() {
        let merged = merge_run_completion_metadata(
            Some(&json!({
                "provider": "legacy"
            })),
            Some("codex"),
            Some(&json!({
                "responseId": "resp_new"
            })),
            None,
            None,
            Some("Backend said no"),
            None,
        );

        assert_eq!(merged["provider"]["id"], json!("codex"));
        assert_eq!(
            merged["provider"]["conversation"]["responseId"],
            json!("resp_new")
        );
        assert_eq!(merged["errorMessage"], json!("Backend said no"));
    }

    // NOTE: Conversation history replay policy is intentionally kept outside unit tests here.
    // The controller always provides recent conversation context to agent jobs.
}

pub(crate) async fn record_agent_conversation_message(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    session_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    run_id: Option<Uuid>,
    content: String,
    metadata: JsonValue,
) -> Result<ConversationMessageRow, (StatusCode, Json<ApiError>)> {
    let message_id = Uuid::new_v4();
    let metadata_param = PgJson(&metadata);

    let row = transaction
        .query_one(
            "insert into conversation_messages (
                 id,
                 conversation_id,
                 project_id,
                 session_id,
                 prompt_id,
                 run_id,
                 role,
                 content,
                 metadata,
                 created_by
             ) values ($1, $2, $3, $4, $5, $6, 'assistant', $7, $8::jsonb, null)
             returning id,
                       conversation_id,
                       project_id,
                       session_id,
                       created_by,
                       prompt_id,
                       run_id,
                       role,
                       content,
                       metadata,
                       created_at",
            &[
                &message_id,
                conversation_id,
                project_id,
                &session_id,
                &prompt_id,
                &run_id,
                &content,
                &metadata_param,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to insert agent conversation message: {error}"
            ))
        })?;

    let last_message_preview =
        crate::conversations::build_conversation_last_message_preview(&content);
    transaction
        .execute(
            "update conversations
             set updated_at = now(),
                 last_message_id = $2,
                 last_message_at = now(),
                 last_message_preview = $3
             where id = $1",
            &[conversation_id, &message_id, &last_message_preview],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to bump conversation timestamp: {error}"))
        })?;

    transaction
        .execute(
            "update conversations
             set updated_at = now()
             where id = (select root_conversation_id from conversations where id = $1)
               and id <> $1",
            &[conversation_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to bump root conversation timestamp: {error}"
            ))
        })?;

    // Home's feed: an agent conversationally speaking is a reply row.
    crate::activity::record_reply_if_visible(
        transaction,
        project_id,
        conversation_id,
        run_id,
        prompt_id,
        &content,
        &metadata,
    )
    .await;

    Ok(map_conversation_message_row(&row))
}

pub(crate) fn verify_agent_token_with_scopes(
    config: &AppConfig,
    token: &str,
    required_scopes: &[&str],
) -> Result<TokenContext, (StatusCode, Json<ApiError>)> {
    let claims = decode_scoped_token(config, token, "agent token")?;
    let project_id = Uuid::from_str(&claims.project_id)
        .map_err(|_| unauthorized("agent token project scope invalid"))?;

    let runtime_id = match claims.runtime_id.as_ref() {
        Some(value) => Some(
            Uuid::from_str(value).map_err(|_| unauthorized("agent token runtime scope invalid"))?,
        ),
        None => None,
    };
    let lease_id = match claims.lease_id.as_ref() {
        Some(value) => Some(
            Uuid::from_str(value)
                .map_err(|_| unauthorized("agent token runtime lease scope invalid"))?,
        ),
        None => None,
    };
    let runtime_generation = match claims.runtime_generation.as_ref() {
        Some(value) => Some(
            Uuid::from_str(value)
                .map_err(|_| unauthorized("agent token runtime generation scope invalid"))?,
        ),
        None => None,
    };

    if lease_id.is_some() && runtime_id.is_none() {
        return Err(unauthorized(
            "agent token runtime lease scope requires runtime scope",
        ));
    }

    if config.strict_mode && runtime_id.is_none() {
        return Err(unauthorized(
            "agent token missing runtime scope while strict mode is enabled",
        ));
    }

    if let Some(runtime_uuid) = runtime_id {
        if !claims.aud.is_empty() && claims.aud != runtime_uuid.to_string() {
            return Err(unauthorized("agent token audience mismatch"));
        }
    }

    for scope in required_scopes {
        if !claims.scopes.iter().any(|value| value == scope) {
            return Err(unauthorized("agent token missing required scope"));
        }
    }

    Ok(TokenContext {
        project_id,
        runtime_id,
        lease_id,
        runtime_generation,
    })
}

pub(crate) fn extract_agent_token<'a>(
    headers: &'a HeaderMap,
) -> Result<&'a str, (StatusCode, Json<ApiError>)> {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| unauthorized("missing authorization header"))?;

    if !auth_header.starts_with("Bearer ") {
        return Err(unauthorized("authorization header must be Bearer token"));
    }

    let token = auth_header.trim_start_matches("Bearer ").trim();
    if token.is_empty() {
        return Err(unauthorized("authorization token is empty"));
    }
    Ok(token)
}

fn default_max_jobs() -> u32 {
    1
}

fn default_lease_seconds() -> u32 {
    120
}

fn unauthorized(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    super::unauthorized(message)
}
