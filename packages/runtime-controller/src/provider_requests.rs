use std::str::FromStr;
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio::sync::OnceCell;
use tokio::time::sleep;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::{error::SqlState, Row};
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::projects::load_project_record;
use crate::{
    bad_request, ensure_project_access, ensure_project_scoped_write_access,
    ensure_project_write_access, internal_error, not_found, publish_controller_event, unauthorized,
    ApiError, AppState,
};

const PROVIDER_ID_MAX_LEN: usize = 128;
const TOOL_NAME_MAX_LEN: usize = 256;
const RESOURCE_URI_MAX_LEN: usize = 512;
const DEVICE_ID_MAX_LEN: usize = 256;
const DEVICE_LABEL_MAX_LEN: usize = 256;
const REQUEST_STATUS_PENDING: &str = "pending";
const REQUEST_STATUS_CLAIMED: &str = "claimed";
const REQUEST_STATUS_COMPLETED: &str = "completed";
const REQUEST_STATUS_FAILED: &str = "failed";
const REQUEST_STATUS_EXPIRED: &str = "expired";
const REQUEST_KIND_TOOL_CALL: &str = "tool_call";
const REQUEST_KIND_RESOURCE_READ: &str = "resource_read";
/// Scope carried by the per-job controller token that authorizes workspace
/// shells to dispatch provider tool calls / resource reads. The device-side
/// routes (list/claim/complete) keep their user-session checks: the phone
/// authenticates with a real session, not a job token.
pub(crate) const PROVIDER_CALL_SCOPE: &str = "provider.call";
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 45_000;
const MAX_WAIT_TIMEOUT_MS: u64 = 120_000;
const MIN_WAIT_TIMEOUT_MS: u64 = 5_000;
const WAIT_POLL_INTERVAL_MS: u64 = 350;
static PROVIDER_REQUEST_TABLES_READY: OnceCell<()> = OnceCell::const_new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchProviderToolCallBody {
    provider_id: String,
    name: String,
    arguments: Option<JsonValue>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchProviderResourceReadBody {
    provider_id: String,
    uri: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListProviderRequestsQuery {
    provider_id: String,
    #[serde(default, deserialize_with = "deserialize_status_query_filters")]
    statuses: Vec<String>,
    limit: Option<i64>,
}

fn deserialize_status_query_filters<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StatusValue {
        Single(String),
        Multiple(Vec<String>),
    }

    let value = Option::<StatusValue>::deserialize(deserializer)?;
    let raw_values = match value {
        Some(StatusValue::Single(entry)) => vec![entry],
        Some(StatusValue::Multiple(entries)) => entries,
        None => Vec::new(),
    };

    Ok(raw_values
        .into_iter()
        .flat_map(|entry| {
            entry
                .split(',')
                .map(|value| value.trim().to_string())
                .collect::<Vec<_>>()
        })
        .filter(|entry| !entry.is_empty())
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimProviderRequestBody {
    provider_id: String,
    device_id: String,
    device_label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteProviderRequestBody {
    provider_id: String,
    device_id: String,
    response: JsonValue,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRequestPayload {
    id: String,
    project_id: String,
    provider_id: String,
    request_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource_uri: Option<String>,
    arguments: JsonValue,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claimed_by_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claimed_by_device_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    claimed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct ProviderRequestRecord {
    id: Uuid,
    project_id: Uuid,
    provider_id: String,
    request_kind: String,
    tool_name: Option<String>,
    resource_uri: Option<String>,
    arguments: JsonValue,
    status: String,
    requested_by: Option<Uuid>,
    claimed_by_device_id: Option<String>,
    claimed_by_device_label: Option<String>,
    response: Option<JsonValue>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    claimed_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/provider-tools/call",
            post(dispatch_provider_tool_call),
        )
        .route(
            "/projects/:project_id/provider-resources/read",
            post(dispatch_provider_resource_read),
        )
        .route(
            "/projects/:project_id/provider-requests",
            get(list_provider_requests),
        )
        .route(
            "/projects/:project_id/provider-requests/:request_id/claim",
            post(claim_provider_request),
        )
        .route(
            "/projects/:project_id/provider-requests/:request_id/complete",
            post(complete_provider_request),
        )
}

async fn dispatch_provider_tool_call(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<DispatchProviderToolCallBody>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    ensure_provider_request_tables(&state).await?;

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let provider_id = normalize_provider_id(body.provider_id.as_str())?;
    let tool_name = normalize_named_identifier(body.name.as_str(), "tool name", TOOL_NAME_MAX_LEN)?;
    let timeout_ms = normalize_wait_timeout_ms(body.timeout_ms);

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
    // If a future bounded grant explicitly carries provider.call, still bind
    // it to this project. Ordinary model jobs currently receive no such scope;
    // user-session and service-role callers keep the membership write check.
    ensure_project_scoped_write_access(
        &transaction,
        &project,
        &context,
        None,
        &[PROVIDER_CALL_SCOPE],
    )
    .await?;
    ensure_provider_is_attached(&transaction, &project_id, provider_id.as_str()).await?;

    let request_id = Uuid::new_v4();
    insert_provider_request(
        &transaction,
        ProviderRequestInsert {
            id: request_id,
            project_id,
            provider_id: provider_id.clone(),
            request_kind: REQUEST_KIND_TOOL_CALL.to_string(),
            tool_name: Some(tool_name.clone()),
            resource_uri: None,
            arguments: body.arguments.unwrap_or_else(|| json!({})),
            requested_by: context.user_id,
        },
    )
    .await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit provider tool dispatch: {error}"))
    })?;

    publish_provider_request_event(
        &state,
        "provider.request.created",
        project_id,
        request_id,
        provider_id.as_str(),
        REQUEST_KIND_TOOL_CALL,
        Some(tool_name.as_str()),
        None,
        REQUEST_STATUS_PENDING,
    );

    let request =
        wait_for_provider_request_terminal_state(&state, project_id, request_id, timeout_ms)
            .await?;
    Ok(Json(build_tool_dispatch_response(&request)))
}

async fn dispatch_provider_resource_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<DispatchProviderResourceReadBody>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    ensure_provider_request_tables(&state).await?;

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let provider_id = normalize_provider_id(body.provider_id.as_str())?;
    let resource_uri =
        normalize_named_identifier(body.uri.as_str(), "resource uri", RESOURCE_URI_MAX_LEN)?;
    let timeout_ms = normalize_wait_timeout_ms(body.timeout_ms);

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
    // Same scoped-token authorization as dispatch_provider_tool_call.
    ensure_project_scoped_write_access(
        &transaction,
        &project,
        &context,
        None,
        &[PROVIDER_CALL_SCOPE],
    )
    .await?;
    ensure_provider_is_attached(&transaction, &project_id, provider_id.as_str()).await?;

    let request_id = Uuid::new_v4();
    insert_provider_request(
        &transaction,
        ProviderRequestInsert {
            id: request_id,
            project_id,
            provider_id: provider_id.clone(),
            request_kind: REQUEST_KIND_RESOURCE_READ.to_string(),
            tool_name: None,
            resource_uri: Some(resource_uri.clone()),
            arguments: json!({}),
            requested_by: context.user_id,
        },
    )
    .await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit provider resource dispatch: {error}"
        ))
    })?;

    publish_provider_request_event(
        &state,
        "provider.request.created",
        project_id,
        request_id,
        provider_id.as_str(),
        REQUEST_KIND_RESOURCE_READ,
        None,
        Some(resource_uri.as_str()),
        REQUEST_STATUS_PENDING,
    );

    let request =
        wait_for_provider_request_terminal_state(&state, project_id, request_id, timeout_ms)
            .await?;
    Ok(Json(build_resource_dispatch_response(&request)))
}

async fn list_provider_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Query(query): Query<ListProviderRequestsQuery>,
) -> Result<Json<Vec<ProviderRequestPayload>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    ensure_provider_request_tables(&state).await?;

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let provider_id = normalize_provider_id(query.provider_id.as_str())?;
    let statuses = normalize_status_filters(query.statuses);
    let limit = query.limit.unwrap_or(10).clamp(1, 20);

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
    ensure_project_access(&transaction, &project, &context, None).await?;
    ensure_provider_is_attached(&transaction, &project_id, provider_id.as_str()).await?;

    let rows = transaction
        .query(
            "select id, project_id, provider_id, request_kind, tool_name, resource_uri, arguments,
                    status, requested_by, claimed_by_device_id, claimed_by_device_label, response,
                    error, created_at, claimed_at, completed_at, updated_at
               from project_provider_requests
              where project_id = $1
                and provider_id = $2
                and status = any($3)
              order by created_at asc
              limit $4",
            &[&project_id, &provider_id, &statuses, &(limit as i64)],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list provider requests: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit provider request list: {error}"))
    })?;

    Ok(Json(
        rows.iter()
            .map(map_provider_request_row)
            .map(|record| provider_request_to_payload(&record))
            .collect(),
    ))
}

async fn claim_provider_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, request_id_raw)): AxumPath<(String, String)>,
    Json(body): Json<ClaimProviderRequestBody>,
) -> Result<Json<ProviderRequestPayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    ensure_provider_request_tables(&state).await?;

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let request_id = parse_request_id(request_id_raw.as_str())?;
    let provider_id = normalize_provider_id(body.provider_id.as_str())?;
    let device_id =
        normalize_named_identifier(body.device_id.as_str(), "device id", DEVICE_ID_MAX_LEN)?;
    let device_label =
        normalize_optional_identifier(body.device_label.as_deref(), DEVICE_LABEL_MAX_LEN);

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
    ensure_project_write_access(&transaction, &project, &context, None).await?;
    ensure_provider_is_attached(&transaction, &project_id, provider_id.as_str()).await?;

    let request = load_provider_request_for_update(&transaction, &project_id, &request_id).await?;
    if request.provider_id != provider_id {
        return Err(bad_request("provider id does not match this request"));
    }
    if request.status == REQUEST_STATUS_CLAIMED {
        if request.claimed_by_device_id.as_deref() == Some(device_id.as_str()) {
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to commit provider request claim: {error}"))
            })?;
            return Ok(Json(provider_request_to_payload(&request)));
        }
        return Err(bad_request(
            "provider request has already been claimed by another device",
        ));
    }
    if request.status != REQUEST_STATUS_PENDING {
        return Err(bad_request("provider request is no longer pending"));
    }

    let row = transaction
        .query_one(
            "update project_provider_requests
                set status = $3,
                    claimed_by_device_id = $4,
                    claimed_by_device_label = $5,
                    claimed_at = now(),
                    updated_at = now()
              where id = $1 and project_id = $2
          returning id, project_id, provider_id, request_kind, tool_name, resource_uri, arguments,
                    status, requested_by, claimed_by_device_id, claimed_by_device_label, response,
                    error, created_at, claimed_at, completed_at, updated_at",
            &[
                &request_id,
                &project_id,
                &REQUEST_STATUS_CLAIMED,
                &device_id,
                &device_label,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to claim provider request: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit provider request claim: {error}"))
    })?;

    let claimed = map_provider_request_row(&row);
    publish_provider_request_event(
        &state,
        "provider.request.updated",
        project_id,
        request_id,
        provider_id.as_str(),
        claimed.request_kind.as_str(),
        claimed.tool_name.as_deref(),
        claimed.resource_uri.as_deref(),
        claimed.status.as_str(),
    );

    Ok(Json(provider_request_to_payload(&claimed)))
}

async fn complete_provider_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, request_id_raw)): AxumPath<(String, String)>,
    Json(body): Json<CompleteProviderRequestBody>,
) -> Result<Json<ProviderRequestPayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    ensure_provider_request_tables(&state).await?;

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let request_id = parse_request_id(request_id_raw.as_str())?;
    let provider_id = normalize_provider_id(body.provider_id.as_str())?;
    let device_id =
        normalize_named_identifier(body.device_id.as_str(), "device id", DEVICE_ID_MAX_LEN)?;
    let response_value = normalize_completion_response(body.response);

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
    ensure_project_write_access(&transaction, &project, &context, None).await?;
    ensure_provider_is_attached(&transaction, &project_id, provider_id.as_str()).await?;

    let request = load_provider_request_for_update(&transaction, &project_id, &request_id).await?;
    if request.provider_id != provider_id {
        return Err(bad_request("provider id does not match this request"));
    }
    if request.status == REQUEST_STATUS_COMPLETED || request.status == REQUEST_STATUS_FAILED {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to commit provider request completion: {error}"
            ))
        })?;
        return Ok(Json(provider_request_to_payload(&request)));
    }
    if request.status != REQUEST_STATUS_CLAIMED {
        return Err(bad_request(
            "provider request must be claimed before completion",
        ));
    }
    if request.claimed_by_device_id.as_deref() != Some(device_id.as_str()) {
        return Err(bad_request(
            "provider request is claimed by a different device",
        ));
    }

    let response_ok = response_value
        .as_object()
        .and_then(|object| object.get("ok"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let error = response_value
        .as_object()
        .and_then(|object| object.get("error"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let next_status = if response_ok {
        REQUEST_STATUS_COMPLETED
    } else {
        REQUEST_STATUS_FAILED
    };

    let row = transaction
        .query_one(
            "update project_provider_requests
                set status = $3,
                    response = $4::jsonb,
                    error = $5,
                    completed_at = now(),
                    updated_at = now()
              where id = $1 and project_id = $2
          returning id, project_id, provider_id, request_kind, tool_name, resource_uri, arguments,
                    status, requested_by, claimed_by_device_id, claimed_by_device_label, response,
                    error, created_at, claimed_at, completed_at, updated_at",
            &[
                &request_id,
                &project_id,
                &next_status,
                &PgJson(&response_value),
                &error,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to complete provider request: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit provider request completion: {error}"
        ))
    })?;

    let completed = map_provider_request_row(&row);
    publish_provider_request_event(
        &state,
        "provider.request.updated",
        project_id,
        request_id,
        provider_id.as_str(),
        completed.request_kind.as_str(),
        completed.tool_name.as_deref(),
        completed.resource_uri.as_deref(),
        completed.status.as_str(),
    );

    Ok(Json(provider_request_to_payload(&completed)))
}

struct ProviderRequestInsert {
    id: Uuid,
    project_id: Uuid,
    provider_id: String,
    request_kind: String,
    tool_name: Option<String>,
    resource_uri: Option<String>,
    arguments: JsonValue,
    requested_by: Option<Uuid>,
}

async fn insert_provider_request(
    transaction: &tokio_postgres::Transaction<'_>,
    input: ProviderRequestInsert,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "insert into project_provider_requests (
                id,
                project_id,
                provider_id,
                request_kind,
                tool_name,
                resource_uri,
                arguments,
                status,
                requested_by
             ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
            &[
                &input.id,
                &input.project_id,
                &input.provider_id,
                &input.request_kind,
                &input.tool_name,
                &input.resource_uri,
                &PgJson(&input.arguments),
                &REQUEST_STATUS_PENDING,
                &input.requested_by,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert provider request: {error}")))?;
    Ok(())
}

async fn wait_for_provider_request_terminal_state(
    state: &AppState,
    project_id: Uuid,
    request_id: Uuid,
    timeout_ms: u64,
) -> Result<ProviderRequestRecord, (StatusCode, Json<ApiError>)> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    loop {
        let row = connection
            .query_opt(
                "select id, project_id, provider_id, request_kind, tool_name, resource_uri, arguments,
                        status, requested_by, claimed_by_device_id, claimed_by_device_label, response,
                        error, created_at, claimed_at, completed_at, updated_at
                   from project_provider_requests
                  where id = $1 and project_id = $2",
                &[&request_id, &project_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load provider request: {error}")))?;
        let request = row
            .as_ref()
            .map(map_provider_request_row)
            .ok_or_else(|| not_found("provider request not found"))?;
        if matches!(
            request.status.as_str(),
            REQUEST_STATUS_COMPLETED | REQUEST_STATUS_FAILED | REQUEST_STATUS_EXPIRED
        ) {
            return Ok(request);
        }
        if Instant::now() >= deadline {
            let timeout_message = "Timed out waiting for the provider device to respond.";
            let _ = connection
                .execute(
                    "update project_provider_requests
                        set status = $3,
                            error = $4,
                            completed_at = now(),
                            updated_at = now()
                      where id = $1
                        and project_id = $2
                        and status in ($5, $6)",
                    &[
                        &request_id,
                        &project_id,
                        &REQUEST_STATUS_EXPIRED,
                        &timeout_message,
                        &REQUEST_STATUS_PENDING,
                        &REQUEST_STATUS_CLAIMED,
                    ],
                )
                .await;
            let timed_out = connection
                .query_opt(
                    "select id, project_id, provider_id, request_kind, tool_name, resource_uri, arguments,
                            status, requested_by, claimed_by_device_id, claimed_by_device_label, response,
                            error, created_at, claimed_at, completed_at, updated_at
                       from project_provider_requests
                      where id = $1 and project_id = $2",
                    &[&request_id, &project_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to reload provider request: {error}")))?;
            let request = timed_out
                .as_ref()
                .map(map_provider_request_row)
                .ok_or_else(|| not_found("provider request not found"))?;
            publish_provider_request_event(
                state,
                "provider.request.updated",
                project_id,
                request_id,
                request.provider_id.as_str(),
                request.request_kind.as_str(),
                request.tool_name.as_deref(),
                request.resource_uri.as_deref(),
                request.status.as_str(),
            );
            return Ok(request);
        }
        sleep(Duration::from_millis(WAIT_POLL_INTERVAL_MS)).await;
    }
}

async fn load_provider_request_for_update(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    request_id: &Uuid,
) -> Result<ProviderRequestRecord, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id, project_id, provider_id, request_kind, tool_name, resource_uri, arguments,
                    status, requested_by, claimed_by_device_id, claimed_by_device_label, response,
                    error, created_at, claimed_at, completed_at, updated_at
               from project_provider_requests
              where id = $1 and project_id = $2
              for update",
            &[request_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load provider request: {error}")))?;
    let row = row.ok_or_else(|| not_found("provider request not found"))?;
    Ok(map_provider_request_row(&row))
}

async fn ensure_provider_is_attached(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    provider_id: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select status, metadata
               from project_integrations
              where project_id = $1
                and provider = $2
              limit 1",
            &[project_id, &provider_id],
        )
        .await;

    let row = match row {
        Ok(value) => value,
        Err(error) => {
            if error
                .as_db_error()
                .map(|db_error| db_error.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                return Err(bad_request("provider is not attached to this project"));
            }
            return Err(internal_error(format!(
                "failed to load provider integration: {error}"
            )));
        }
    };

    let Some(row) = row else {
        return Err(bad_request("provider is not attached to this project"));
    };

    let status: String = row.get("status");
    let metadata: JsonValue = row.get("metadata");
    let attached = matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "attached" | "available" | "connected" | "enabled"
    );
    let metadata_enabled = metadata
        .as_object()
        .map(|object| {
            object
                .get("attached")
                .and_then(JsonValue::as_bool)
                .unwrap_or(true)
                && object
                    .get("enabled")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(true)
        })
        .unwrap_or(true);

    if !attached || !metadata_enabled {
        return Err(bad_request("provider is not attached to this project"));
    }

    Ok(())
}

async fn ensure_provider_request_tables(
    state: &AppState,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    PROVIDER_REQUEST_TABLES_READY
        .get_or_try_init(|| async {
            let connection = state
                .pool
                .get()
                .await
                .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
            connection
                .batch_execute(
                    "
                    create table if not exists project_provider_requests (
                      id uuid primary key,
                      project_id uuid not null,
                      provider_id text not null,
                      request_kind text not null,
                      tool_name text,
                      resource_uri text,
                      arguments jsonb not null default '{}'::jsonb,
                      status text not null,
                      requested_by uuid,
                      claimed_by_device_id text,
                      claimed_by_device_label text,
                      response jsonb,
                      error text,
                      created_at timestamptz not null default now(),
                      claimed_at timestamptz,
                      completed_at timestamptz,
                      updated_at timestamptz not null default now()
                    );

                    create index if not exists project_provider_requests_lookup_idx
                      on project_provider_requests (project_id, provider_id, status, created_at);

                    create index if not exists project_provider_requests_project_idx
                      on project_provider_requests (project_id, created_at desc);

                    alter table project_provider_requests enable row level security;
                    revoke all privileges on table project_provider_requests from anon, authenticated;
                    ",
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to ensure provider request table: {error}"))
                })?;
            Ok(())
        })
        .await?;
    Ok(())
}

fn build_tool_dispatch_response(request: &ProviderRequestRecord) -> JsonValue {
    if let Some(response) = request.response.clone() {
        return response;
    }
    json!({
      "ok": false,
      "providerId": request.provider_id,
      "name": request.tool_name.clone().unwrap_or_default(),
      "error": request.error.clone().unwrap_or_else(|| "Provider request did not return a tool response.".to_string()),
    })
}

fn build_resource_dispatch_response(request: &ProviderRequestRecord) -> JsonValue {
    if let Some(response) = request.response.clone() {
        return response;
    }
    json!({
      "ok": false,
      "providerId": request.provider_id,
      "uri": request.resource_uri.clone().unwrap_or_default(),
      "exists": false,
      "error": request.error.clone().unwrap_or_else(|| "Provider request did not return a resource response.".to_string()),
    })
}

fn publish_provider_request_event(
    state: &AppState,
    kind: &str,
    project_id: Uuid,
    request_id: Uuid,
    provider_id: &str,
    request_kind: &str,
    tool_name: Option<&str>,
    resource_uri: Option<&str>,
    status: &str,
) {
    publish_controller_event(
        &state.events,
        kind,
        Some(project_id),
        None,
        None,
        Some(request_id),
        json!({
          "requestId": request_id,
          "providerId": provider_id,
          "requestKind": request_kind,
          "toolName": tool_name,
          "resourceUri": resource_uri,
          "status": status,
        }),
    );
}

fn provider_request_to_payload(record: &ProviderRequestRecord) -> ProviderRequestPayload {
    ProviderRequestPayload {
        id: record.id.to_string(),
        project_id: record.project_id.to_string(),
        provider_id: record.provider_id.clone(),
        request_kind: record.request_kind.clone(),
        tool_name: record.tool_name.clone(),
        resource_uri: record.resource_uri.clone(),
        arguments: record.arguments.clone(),
        status: record.status.clone(),
        requested_by: record.requested_by.map(|value| value.to_string()),
        claimed_by_device_id: record.claimed_by_device_id.clone(),
        claimed_by_device_label: record.claimed_by_device_label.clone(),
        response: record.response.clone(),
        error: record.error.clone(),
        created_at: record.created_at.to_rfc3339(),
        claimed_at: record.claimed_at.map(|value| value.to_rfc3339()),
        completed_at: record.completed_at.map(|value| value.to_rfc3339()),
        updated_at: record.updated_at.to_rfc3339(),
    }
}

fn map_provider_request_row(row: &Row) -> ProviderRequestRecord {
    ProviderRequestRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider_id: row.get("provider_id"),
        request_kind: row.get("request_kind"),
        tool_name: row.get("tool_name"),
        resource_uri: row.get("resource_uri"),
        arguments: row.get("arguments"),
        status: row.get("status"),
        requested_by: row.get("requested_by"),
        claimed_by_device_id: row.get("claimed_by_device_id"),
        claimed_by_device_label: row.get("claimed_by_device_label"),
        response: row.get("response"),
        error: row.get("error"),
        created_at: row.get("created_at"),
        claimed_at: row.get("claimed_at"),
        completed_at: row.get("completed_at"),
        updated_at: row.get("updated_at"),
    }
}

fn parse_project_id(raw: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    Uuid::from_str(raw.trim()).map_err(|_| bad_request("projectId must be a valid UUID"))
}

fn parse_request_id(raw: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    Uuid::from_str(raw.trim()).map_err(|_| bad_request("requestId must be a valid UUID"))
}

fn normalize_wait_timeout_ms(value: Option<u64>) -> u64 {
    value
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)
        .clamp(MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS)
}

fn normalize_provider_id(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(bad_request("providerId is required"));
    }
    if normalized.len() > PROVIDER_ID_MAX_LEN {
        return Err(bad_request("providerId is too long"));
    }
    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err(bad_request("providerId contains unsupported characters"));
    }
    Ok(normalized)
}

fn normalize_named_identifier(
    raw: &str,
    field: &str,
    max_len: usize,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Err(bad_request(&format!("{field} is required")));
    }
    if normalized.len() > max_len {
        return Err(bad_request(&format!("{field} is too long")));
    }
    Ok(normalized.to_string())
}

fn normalize_optional_identifier(value: Option<&str>, max_len: usize) -> Option<String> {
    let normalized = value.unwrap_or("").trim();
    if normalized.is_empty() {
        return None;
    }
    let truncated = normalized.chars().take(max_len).collect::<String>();
    Some(truncated)
}

fn normalize_status_filters(values: Vec<String>) -> Vec<String> {
    let mut output = values
        .into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                REQUEST_STATUS_PENDING
                    | REQUEST_STATUS_CLAIMED
                    | REQUEST_STATUS_COMPLETED
                    | REQUEST_STATUS_FAILED
                    | REQUEST_STATUS_EXPIRED
            )
        })
        .collect::<Vec<_>>();
    if output.is_empty() {
        output.push(REQUEST_STATUS_PENDING.to_string());
        output.push(REQUEST_STATUS_CLAIMED.to_string());
    }
    output.sort();
    output.dedup();
    output
}

fn normalize_completion_response(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(object) => JsonValue::Object(object),
        other => json!({
          "ok": false,
          "error": "Provider completion payload must be an object.",
          "raw": other,
        }),
    }
}

#[cfg(test)]
mod tests {
    use axum::extract::Query;
    use axum::http::Uri;

    use super::{normalize_provider_id, normalize_status_filters, ListProviderRequestsQuery};

    #[test]
    fn provider_id_accepts_instance_separator() {
        assert_eq!(
            normalize_provider_id(" Camera:Phone_01 ").unwrap(),
            "camera:phone_01"
        );
    }

    #[test]
    fn status_filters_default_to_pending_and_claimed() {
        assert_eq!(
            normalize_status_filters(Vec::new()),
            vec!["claimed".to_string(), "pending".to_string()]
        );
    }

    #[test]
    fn list_provider_requests_query_accepts_comma_separated_statuses() {
        let uri: Uri =
            "/provider-requests?providerId=camera%3Aphone_01&statuses=pending,claimed&limit=5"
                .parse()
                .expect("uri should parse");
        let Query(query) =
            Query::<ListProviderRequestsQuery>::try_from_uri(&uri).expect("query should parse");

        assert_eq!(query.provider_id, "camera:phone_01");
        assert_eq!(query.statuses, vec!["pending", "claimed"]);
        assert_eq!(query.limit, Some(5));
    }
}
