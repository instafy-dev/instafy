use std::str::FromStr;
use std::time::Duration;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::time::{sleep_until, timeout_at, Instant};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::{error::SqlState, GenericClient, Row};
use uuid::Uuid;

use crate::auth::{authenticate_request, RequestContext};
use crate::projects::load_project_record;
use crate::state::ControllerEvent;
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
const PROVIDER_REQUEST_CREATED_EVENT: &str = "provider.request.created";
const PROVIDER_REQUEST_UPDATED_EVENT: &str = "provider.request.updated";
const WAIT_TIMEOUT_ERROR: &str = "Timed out waiting for the provider device to respond.";
const EXPIRED_BEFORE_CLAIM_ERROR: &str = "The provider request expired before a device claimed it.";
/// Scope carried by the per-job controller token that authorizes workspace
/// shells to dispatch provider tool calls / resource reads. The device-side
/// routes (list/claim/complete) keep their user-session checks: the phone
/// authenticates with a real session, not a job token.
pub(crate) const PROVIDER_CALL_SCOPE: &str = "provider.call";
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 45_000;
const MAX_WAIT_TIMEOUT_MS: u64 = 120_000;
const MIN_WAIT_TIMEOUT_MS: u64 = 5_000;
/// A waiting dispatch wakes on the request's own update event and reads the
/// row only then, or after this long when no event arrives (another node
/// without the shared event bus, or a lagged subscriber).
const WAIT_FALLBACK_POLL_INTERVAL_MS: u64 = 1_000;

macro_rules! request_columns {
    () => {
        "id, project_id, provider_id, request_kind, tool_name, resource_uri, arguments,
         status, requested_by, claimed_by_device_id, claimed_by_device_label, response, error,
         created_at, claimed_at, completed_at, updated_at, expires_at,
         greatest(0, floor(extract(epoch from (now() - created_at)) * 1000))::bigint as age_ms"
    };
}

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
    /// No device may claim the request, or claim it again, after this time.
    expires_at: String,
    /// Milliseconds since the request was created, on the database clock,
    /// when this copy of it was read. A device judges freshness by this rather
    /// than by its own clock.
    age_ms: i64,
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
    expires_at: DateTime<Utc>,
    age_ms: i64,
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

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let provider_id = normalize_provider_id(body.provider_id.as_str())?;
    let tool_name = normalize_named_identifier(body.name.as_str(), "tool name", TOOL_NAME_MAX_LEN)?;
    let timeout_ms = normalize_wait_timeout_ms(body.timeout_ms);

    let request = dispatch_and_wait(
        &state,
        &context,
        ProviderRequestInsert {
            id: Uuid::new_v4(),
            project_id,
            provider_id,
            request_kind: REQUEST_KIND_TOOL_CALL,
            tool_name: Some(tool_name),
            resource_uri: None,
            arguments: body.arguments.unwrap_or_else(|| json!({})),
            requested_by: context.user_id,
        },
        timeout_ms,
    )
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

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let provider_id = normalize_provider_id(body.provider_id.as_str())?;
    let resource_uri =
        normalize_named_identifier(body.uri.as_str(), "resource uri", RESOURCE_URI_MAX_LEN)?;
    let timeout_ms = normalize_wait_timeout_ms(body.timeout_ms);

    let request = dispatch_and_wait(
        &state,
        &context,
        ProviderRequestInsert {
            id: Uuid::new_v4(),
            project_id,
            provider_id,
            request_kind: REQUEST_KIND_RESOURCE_READ,
            tool_name: None,
            resource_uri: Some(resource_uri),
            arguments: json!({}),
            requested_by: context.user_id,
        },
        timeout_ms,
    )
    .await?;
    Ok(Json(build_resource_dispatch_response(&request)))
}

/// Queues one request, then waits for a device to settle it. The pooled
/// connection that queued it goes back to the pool before the wait, so a
/// held-open dispatch holds no connection while it waits.
async fn dispatch_and_wait(
    state: &AppState,
    context: &RequestContext,
    insert: ProviderRequestInsert,
    timeout_ms: u64,
) -> Result<ProviderRequestRecord, (StatusCode, Json<ApiError>)> {
    let project_id = insert.project_id;
    let queued = {
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
        // If a future bounded grant explicitly carries provider.call, still
        // bind it to this project. Ordinary model jobs currently receive no
        // such scope; user-session and service-role callers keep the
        // membership write check.
        ensure_project_scoped_write_access(
            &transaction,
            &project,
            context,
            None,
            &[PROVIDER_CALL_SCOPE],
        )
        .await?;
        ensure_provider_is_attached(&transaction, &project_id, insert.provider_id.as_str()).await?;

        let queued = insert_provider_request(&transaction, &insert, timeout_ms).await?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to commit provider request dispatch: {error}"
            ))
        })?;
        queued
    };

    publish_provider_request_event(state, PROVIDER_REQUEST_CREATED_EVENT, &queued);
    wait_for_provider_request_terminal_state(state, project_id, queued.id, timeout_ms).await
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

    // Pending and claimed rows are listed only while a device may still claim
    // them. Once a request's window has closed, a device must not start it
    // again, and old rows must not fill the page ahead of new ones.
    let rows = transaction
        .query(
            concat!(
                "select ",
                request_columns!(),
                " from project_provider_requests
                 where project_id = $1
                   and provider_id = $2
                   and status = any($3)
                   and (status not in ($5, $6) or expires_at > now())
                 order by created_at asc
                 limit $4"
            ),
            &[
                &project_id,
                &provider_id,
                &statuses,
                &(limit as i64),
                &REQUEST_STATUS_PENDING,
                &REQUEST_STATUS_CLAIMED,
            ],
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
    let claimed_by_this_device =
        request.claimed_by_device_id.as_deref() == Some(device_id.as_str());
    if request.status == REQUEST_STATUS_CLAIMED && !claimed_by_this_device {
        return Err(bad_request(
            "provider request has already been claimed by another device",
        ));
    }
    if request.status != REQUEST_STATUS_PENDING && request.status != REQUEST_STATUS_CLAIMED {
        return Err(bad_request("provider request is no longer pending"));
    }

    // Pending, or claimed by this device. Either way the device would start
    // it, so it must still be inside its window.
    if request.expires_at <= database_now(&transaction).await? {
        if request.status == REQUEST_STATUS_CLAIMED {
            return Err(bad_request(
                "provider request can no longer be claimed; the device that claimed it may still complete it",
            ));
        }
        let expired = expire_pending_provider_request(
            &transaction,
            &project_id,
            &request_id,
            EXPIRED_BEFORE_CLAIM_ERROR,
        )
        .await?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to commit provider request expiry: {error}"))
        })?;
        if let Some(expired) = expired {
            publish_provider_request_event(&state, PROVIDER_REQUEST_UPDATED_EVENT, &expired);
        }
        return Err(bad_request(
            "provider request expired before it was claimed",
        ));
    }

    if request.status == REQUEST_STATUS_CLAIMED {
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to commit provider request claim: {error}"))
        })?;
        return Ok(Json(provider_request_to_payload(&request)));
    }

    let row = transaction
        .query_one(
            concat!(
                "update project_provider_requests
                    set status = $3,
                        claimed_by_device_id = $4,
                        claimed_by_device_label = $5,
                        claimed_at = now(),
                        updated_at = now()
                  where id = $1 and project_id = $2
              returning ",
                request_columns!()
            ),
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
    publish_provider_request_event(&state, PROVIDER_REQUEST_UPDATED_EVENT, &claimed);

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
    match request.status.as_str() {
        REQUEST_STATUS_CLAIMED => {}
        // An older controller expired claimed requests when its wait ran out.
        // The device that took one may still report how it went.
        REQUEST_STATUS_EXPIRED if request.claimed_at.is_some() => {}
        REQUEST_STATUS_EXPIRED => {
            return Err(bad_request(
                "provider request expired before any device claimed it",
            ));
        }
        _ => {
            return Err(bad_request(
                "provider request must be claimed before completion",
            ));
        }
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

    // A completion after the window closed is still the device's answer, so
    // it is recorded: the dispatch may have stopped waiting, but the action
    // ran.
    let row = transaction
        .query_one(
            concat!(
                "update project_provider_requests
                    set status = $3,
                        response = $4::jsonb,
                        error = $5,
                        completed_at = now(),
                        updated_at = now()
                  where id = $1 and project_id = $2
              returning ",
                request_columns!()
            ),
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
    publish_provider_request_event(&state, PROVIDER_REQUEST_UPDATED_EVENT, &completed);

    Ok(Json(provider_request_to_payload(&completed)))
}

struct ProviderRequestInsert {
    id: Uuid,
    project_id: Uuid,
    provider_id: String,
    request_kind: &'static str,
    tool_name: Option<String>,
    resource_uri: Option<String>,
    arguments: JsonValue,
    requested_by: Option<Uuid>,
}

/// Inserts a pending request whose window closes `timeout_ms` from now on the
/// database clock, the clock every later claim is judged by.
async fn insert_provider_request(
    transaction: &tokio_postgres::Transaction<'_>,
    input: &ProviderRequestInsert,
    timeout_ms: u64,
) -> Result<ProviderRequestRecord, (StatusCode, Json<ApiError>)> {
    let timeout_ms = i64::try_from(timeout_ms).unwrap_or(i64::MAX);
    let row = transaction
        .query_one(
            concat!(
                "insert into project_provider_requests (
                    id,
                    project_id,
                    provider_id,
                    request_kind,
                    tool_name,
                    resource_uri,
                    arguments,
                    status,
                    requested_by,
                    expires_at
                 ) values (
                    $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
                    now() + $10::bigint * interval '1 millisecond'
                 )
                 returning ",
                request_columns!()
            ),
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
                &timeout_ms,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert provider request: {error}")))?;
    Ok(map_provider_request_row(&row))
}

/// Waits until a device settles the request or `timeout_ms` passes, holding
/// a pooled connection only while it reads the row. It wakes on the
/// request's own update event, and reads the row at least every
/// `WAIT_FALLBACK_POLL_INTERVAL_MS` in case that event never reaches this
/// node.
///
/// At the deadline only a request no device has claimed is expired. A
/// claimed one is left claimed: the device may still be running it, and its
/// answer is recorded when it comes.
async fn wait_for_provider_request_terminal_state(
    state: &AppState,
    project_id: Uuid,
    request_id: Uuid,
    timeout_ms: u64,
) -> Result<ProviderRequestRecord, (StatusCode, Json<ApiError>)> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    // Subscribed before the first read, so an update that lands between a
    // read and the wait that follows it still wakes the wait.
    let mut events = state.events.subscribe();

    loop {
        let request = {
            let connection =
                state.pool.get().await.map_err(|error| {
                    internal_error(format!("failed to get connection: {error}"))
                })?;
            load_provider_request(&*connection, &project_id, &request_id).await?
        };
        if matches!(
            request.status.as_str(),
            REQUEST_STATUS_COMPLETED | REQUEST_STATUS_FAILED | REQUEST_STATUS_EXPIRED
        ) {
            return Ok(request);
        }

        let now = Instant::now();
        if now >= deadline {
            let connection =
                state.pool.get().await.map_err(|error| {
                    internal_error(format!("failed to get connection: {error}"))
                })?;
            let expired = expire_pending_provider_request(
                &*connection,
                &project_id,
                &request_id,
                WAIT_TIMEOUT_ERROR,
            )
            .await?;
            return match expired {
                Some(expired) => {
                    publish_provider_request_event(state, PROVIDER_REQUEST_UPDATED_EVENT, &expired);
                    Ok(expired)
                }
                // Claimed, or settled since the last read.
                None => load_provider_request(&*connection, &project_id, &request_id).await,
            };
        }

        let wake_at = deadline.min(now + Duration::from_millis(WAIT_FALLBACK_POLL_INTERVAL_MS));
        wait_for_event(&mut events, wake_at, |event| {
            is_update_of(event, request_id)
        })
        .await;
    }
}

fn is_update_of(event: &ControllerEvent, request_id: Uuid) -> bool {
    event.kind == PROVIDER_REQUEST_UPDATED_EVENT
        && event
            .data
            .get("requestId")
            .and_then(JsonValue::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
            == Some(request_id)
}

/// Returns when an event `wanted` picks arrives, when events were missed, or
/// at `wake_at`, whichever comes first.
async fn wait_for_event(
    events: &mut broadcast::Receiver<ControllerEvent>,
    wake_at: Instant,
    wanted: impl Fn(&ControllerEvent) -> bool,
) {
    loop {
        match timeout_at(wake_at, events.recv()).await {
            Err(_elapsed) => return,
            Ok(Ok(event)) if wanted(&event) => return,
            Ok(Ok(_)) => {}
            Ok(Err(RecvError::Lagged(_))) => return,
            Ok(Err(RecvError::Closed)) => {
                sleep_until(wake_at).await;
                return;
            }
        }
    }
}

async fn load_provider_request<C: GenericClient + Sync>(
    client: &C,
    project_id: &Uuid,
    request_id: &Uuid,
) -> Result<ProviderRequestRecord, (StatusCode, Json<ApiError>)> {
    let row = client
        .query_opt(
            concat!(
                "select ",
                request_columns!(),
                " from project_provider_requests where id = $1 and project_id = $2"
            ),
            &[request_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load provider request: {error}")))?;
    row.as_ref()
        .map(map_provider_request_row)
        .ok_or_else(|| not_found("provider request not found"))
}

/// Marks the request expired if it is still pending, and returns it if this
/// call did.
async fn expire_pending_provider_request<C: GenericClient + Sync>(
    client: &C,
    project_id: &Uuid,
    request_id: &Uuid,
    error: &str,
) -> Result<Option<ProviderRequestRecord>, (StatusCode, Json<ApiError>)> {
    let row = client
        .query_opt(
            concat!(
                "update project_provider_requests
                    set status = $3,
                        error = $4,
                        completed_at = now(),
                        updated_at = now()
                  where id = $1
                    and project_id = $2
                    and status = $5
              returning ",
                request_columns!()
            ),
            &[
                request_id,
                project_id,
                &REQUEST_STATUS_EXPIRED,
                &error,
                &REQUEST_STATUS_PENDING,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to expire provider request: {error}")))?;
    Ok(row.as_ref().map(map_provider_request_row))
}

async fn database_now(
    transaction: &tokio_postgres::Transaction<'_>,
) -> Result<DateTime<Utc>, (StatusCode, Json<ApiError>)> {
    transaction
        .query_one("select now()", &[])
        .await
        .map(|row| row.get(0))
        .map_err(|error| internal_error(format!("failed to read the database clock: {error}")))
}

async fn load_provider_request_for_update(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    request_id: &Uuid,
) -> Result<ProviderRequestRecord, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            concat!(
                "select ",
                request_columns!(),
                " from project_provider_requests
                 where id = $1 and project_id = $2
                 for update"
            ),
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

fn dispatch_fallback_error(request: &ProviderRequestRecord, missing_reply: &str) -> String {
    if request.status == REQUEST_STATUS_CLAIMED {
        return format!(
            "{WAIT_TIMEOUT_ERROR} The device claimed the request and may still complete it."
        );
    }
    request
        .error
        .clone()
        .unwrap_or_else(|| missing_reply.to_string())
}

fn build_tool_dispatch_response(request: &ProviderRequestRecord) -> JsonValue {
    if let Some(response) = request.response.clone() {
        return response;
    }
    json!({
      "ok": false,
      "providerId": request.provider_id,
      "name": request.tool_name.clone().unwrap_or_default(),
      "error": dispatch_fallback_error(request, "Provider request did not return a tool response."),
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
      "error": dispatch_fallback_error(request, "Provider request did not return a resource response."),
    })
}

fn publish_provider_request_event(state: &AppState, kind: &str, request: &ProviderRequestRecord) {
    publish_controller_event(
        &state.events,
        kind,
        Some(request.project_id),
        None,
        None,
        Some(request.id),
        json!({
          "requestId": request.id,
          "providerId": request.provider_id,
          "requestKind": request.request_kind,
          "toolName": request.tool_name,
          "resourceUri": request.resource_uri,
          "status": request.status,
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
        expires_at: record.expires_at.to_rfc3339(),
        age_ms: record.age_ms,
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
        expires_at: row.get("expires_at"),
        age_ms: row.get("age_ms"),
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
    use std::time::Duration;

    use axum::extract::Query;
    use axum::http::Uri;
    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use tokio::time::Instant;
    use uuid::Uuid;

    use super::{
        build_resource_dispatch_response, build_tool_dispatch_response, is_update_of,
        normalize_provider_id, normalize_status_filters, wait_for_event, ListProviderRequestsQuery,
        ProviderRequestRecord, PROVIDER_REQUEST_UPDATED_EVENT,
    };
    use crate::state::{publish_controller_event_to_user, EventHub};

    fn unanswered_request(
        status: &str,
        claimed_at: Option<chrono::DateTime<Utc>>,
        error: Option<&str>,
    ) -> ProviderRequestRecord {
        let created_at = Utc.with_ymd_and_hms(2026, 10, 12, 12, 0, 0).unwrap();
        ProviderRequestRecord {
            id: Uuid::nil(),
            project_id: Uuid::nil(),
            provider_id: "device-provider".to_string(),
            request_kind: "tool_call".to_string(),
            tool_name: Some("device.move".to_string()),
            resource_uri: Some("device://status".to_string()),
            arguments: json!({}),
            status: status.to_string(),
            requested_by: None,
            claimed_by_device_id: None,
            claimed_by_device_label: None,
            response: None,
            error: error.map(str::to_string),
            created_at,
            claimed_at,
            completed_at: None,
            updated_at: created_at,
            expires_at: created_at,
            age_ms: 0,
        }
    }

    /// A reply that is not the device's own says what became of the request.
    /// The device's own reply comes back as it gave it.
    #[test]
    fn a_reply_without_the_devices_says_whether_a_device_may_still_act() {
        let claimed_at = Some(Utc.with_ymd_and_hms(2026, 10, 12, 12, 0, 28).unwrap());
        let timeout = "Timed out waiting for the provider device to respond.";
        let claimed_timeout = "Timed out waiting for the provider device to respond. \
                               The device claimed the request and may still complete it.";
        for (status, claimed_at, stored_error, error) in [
            ("expired", None, Some(timeout), timeout),
            ("claimed", claimed_at, None, claimed_timeout),
        ] {
            let request = unanswered_request(status, claimed_at, stored_error);
            for response in [
                build_tool_dispatch_response(&request),
                build_resource_dispatch_response(&request),
            ] {
                assert_eq!(response["ok"], json!(false), "{status}");
                assert_eq!(response["error"], json!(error), "{status}");
            }
        }

        let mut answered = unanswered_request("completed", None, None);
        answered.response = Some(json!({ "ok": true, "name": "device.move" }));
        assert_eq!(
            build_tool_dispatch_response(&answered),
            json!({ "ok": true, "name": "device.move" })
        );
    }

    fn publish_update(hub: &EventHub, request_id: Uuid) {
        publish_controller_event_to_user(
            hub,
            PROVIDER_REQUEST_UPDATED_EVENT,
            Some(Uuid::nil()),
            Uuid::nil(),
            json!({ "requestId": request_id, "status": "completed" }),
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiting_dispatch_wakes_on_its_own_update() {
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let request_id = Uuid::new_v4();
        let start = Instant::now();

        let publisher = {
            let hub = hub.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                publish_update(&hub, Uuid::new_v4());
                tokio::time::sleep(Duration::from_millis(100)).await;
                publish_update(&hub, request_id);
            })
        };

        wait_for_event(&mut events, start + Duration::from_secs(5), |event| {
            is_update_of(event, request_id)
        })
        .await;
        publisher.await.expect("publisher");

        assert_eq!(start.elapsed(), Duration::from_millis(200));
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiting_dispatch_rereads_by_its_wake_time_without_an_event() {
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let start = Instant::now();
        publish_update(&hub, Uuid::new_v4());
        let request_id = Uuid::new_v4();

        wait_for_event(&mut events, start + Duration::from_secs(1), |event| {
            is_update_of(event, request_id)
        })
        .await;

        assert_eq!(start.elapsed(), Duration::from_secs(1));
    }

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
