use std::str::FromStr;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::device_grants::{device_changed, DeviceState};
use crate::projects::load_project_record;
use crate::provider_requests::TOOL_NAME_MAX_LEN;
use crate::{
    bad_request, ensure_project_access, ensure_project_write_access, forbidden, internal_error,
    unauthorized, ApiError, AppState,
};

const PROVIDER_ID_MAX_LEN: usize = 128;
const PROVIDER_FAMILY_ID_MAX_LEN: usize = 128;
const DEVICE_ID_MAX_LEN: usize = 256;
const DEVICE_LABEL_MAX_LEN: usize = 256;
const DEVICE_STATUS_MAX_LEN: usize = 64;
const CONNECTION_TYPE_MAX_LEN: usize = 64;
const DEVICE_PRESENCE_ONLINE_TTL_SECONDS: i64 = 30;
pub(crate) const CATALOG_MAX_TOOLS: usize = 64;
const CATALOG_MAX_BYTES: usize = 64 * 1024;
/// The most characters a device's `context` may have.
const CONTEXT_MAX_CHARS: usize = 1_200;
pub(crate) const DEVICE_OWNED_BY_ANOTHER: &str = "This device belongs to another person.";

/// The person a device row `d` answers to: its owner, while they may still
/// write to its space as [`ensure_project_write_access`] decides for their own
/// session (the space's owner, or a builder, admin or owner of the space or of
/// its team). An owner who left the space, lost write access or deleted their
/// account owns nothing, so the device is anyone's to use or take again. A SQL
/// expression, null for a device with no owner.
macro_rules! live_owner {
    () => {
        "(case when d.owner_user_id is not null and exists (
             select 1 from projects owned_space
              where owned_space.id = d.project_id
                and (owned_space.owner_user_id = d.owner_user_id
                     or exists (
                         select 1 from project_memberships owner_role
                          where owner_role.project_id = owned_space.id
                            and owner_role.user_id = d.owner_user_id
                            and lower(btrim(owner_role.role)) in ('builder', 'admin', 'owner'))
                     or exists (
                         select 1 from org_memberships owner_team_role
                          where owner_team_role.org_id = owned_space.org_id
                            and owner_team_role.user_id = d.owner_user_id
                            and lower(btrim(owner_team_role.role)) in ('builder', 'admin', 'owner'))))
           then d.owner_user_id end)"
    };
}
pub(crate) use live_owner;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDeviceHeartbeatBody {
    provider_id: String,
    provider_family_id: Option<String>,
    device_id: String,
    device_label: Option<String>,
    platform: Option<String>,
    /// Free text, `ready` by default. `stopped` is the device's own stop
    /// ([`device_changed`]).
    status: Option<String>,
    connection_type: Option<String>,
    metadata: Option<JsonValue>,
    /// Replaces the device's tool catalog ([`DeviceCatalog`]), where device
    /// grants are on for the caller, and makes the device theirs if it has no
    /// live owner ([`live_owner`]). Absent: both stay as they are.
    catalog: Option<JsonValue>,
    /// What the device says of its own state now, plain text of at most
    /// 1,200 characters, where device grants are on for the caller: its
    /// granted turns read it as the device's words (`device_grants.rs`). Like
    /// the status, each heartbeat replaces it, so absent clears it.
    context: Option<String>,
}

/// A device's tools as MCP `tools/list` returns them, with the MCP
/// `initialize` instructions they come with. The controller checks what a
/// granted turn's broker serves a tool by, its name and input schema, bounds
/// the catalog's size and keeps it as the device sent it.
#[derive(Deserialize)]
struct DeviceCatalog {
    tools: Vec<DeviceCatalogTool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCatalogTool {
    name: String,
    input_schema: JsonValue,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListProviderDevicesQuery {
    provider_id: Option<String>,
    provider_family_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDevicePayload {
    project_id: String,
    provider_id: String,
    provider_family_id: String,
    device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    status: String,
    connection_type: String,
    metadata: JsonValue,
    presence_status: String,
    created_at: String,
    updated_at: String,
    last_seen_at: String,
}

#[derive(Debug, Clone)]
struct ProviderDeviceRecord {
    project_id: Uuid,
    provider_id: String,
    provider_family_id: String,
    device_id: String,
    device_label: Option<String>,
    platform: Option<String>,
    status: String,
    connection_type: String,
    metadata: JsonValue,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/provider-devices",
            get(list_provider_devices),
        )
        .route(
            "/projects/:project_id/provider-devices/heartbeat",
            post(record_provider_device_heartbeat),
        )
}

async fn list_provider_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Query(query): Query<ListProviderDevicesQuery>,
) -> Result<Json<Vec<ProviderDevicePayload>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let provider_id = normalize_optional_provider_id(query.provider_id.as_deref())?;
    let provider_family_id =
        normalize_optional_provider_family_id(query.provider_family_id.as_deref())?;
    let limit = query.limit.unwrap_or(20).clamp(1, 100);

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

    let rows = transaction
        .query(
            "select project_id, provider_id, provider_family_id, device_id, device_label, platform,
                    status, connection_type, metadata, created_at, updated_at, last_seen_at
               from project_provider_devices
              where project_id = $1
                and ($2::text is null or provider_id = $2)
                and ($3::text is null or provider_family_id = $3)
              order by last_seen_at desc, updated_at desc, provider_id asc
              limit $4",
            &[
                &project_id,
                &provider_id,
                &provider_family_id,
                &(limit as i64),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list provider devices: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit provider device list: {error}"))
    })?;

    Ok(Json(
        rows.iter()
            .map(map_provider_device_row)
            .map(|record| provider_device_to_payload(&record))
            .collect(),
    ))
}

async fn record_provider_device_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<ProviderDeviceHeartbeatBody>,
) -> Result<Json<ProviderDevicePayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    let project_id = parse_project_id(project_id_raw.as_str())?;
    let provider_id = normalize_provider_id(body.provider_id.as_str())?;
    let provider_family_id =
        normalize_provider_family_id(body.provider_family_id.as_deref(), provider_id.as_str())?;
    let device_id =
        normalize_named_identifier(body.device_id.as_str(), "deviceId", DEVICE_ID_MAX_LEN)?;
    let device_label =
        normalize_optional_identifier(body.device_label.as_deref(), DEVICE_LABEL_MAX_LEN);
    let platform = normalize_platform(body.platform.as_deref());
    let status = normalize_device_status(body.status.as_deref());
    let connection_type = normalize_connection_type(body.connection_type.as_deref());
    let metadata = normalize_metadata(body.metadata);
    // A device's catalog and context are published only from the own session
    // of a person device grants are on for, and a catalog from them takes the
    // device if it has no live owner; anywhere else both are ignored. An
    // owner already on record is enforced either way, and only they write an
    // owned device's catalog and context: a device that changes owner keeps
    // only the catalog its new owner sends.
    let caller = require_user_session(&context).ok();
    let grants_on = caller.is_some_and(|caller| state.config.device_grants.allow(caller));
    let catalog = match body.catalog {
        Some(catalog) if grants_on => Some(normalize_catalog(catalog)?),
        _ => None,
    };
    let device_context = normalize_context(body.context.filter(|_| grants_on))?;
    let owner_on_insert = caller.filter(|_| catalog.is_some());

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

    // The device as it is stored, locked until this heartbeat commits: its
    // grants follow what the heartbeat changes, such as its own stop
    // (`device_grants.rs`).
    let stored = if state.config.device_grants.on() {
        transaction
            .query_opt(
                "select status, owner_user_id from project_provider_devices
                  where project_id = $1 and provider_id = $2 and device_id = $3
                  for update",
                &[&project_id, &provider_id, &device_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load provider device: {error}")))?
    } else {
        None
    };

    // The owner rule is part of the upsert, so two first registrations cannot
    // both take a device: an owned row is updated only for its live owner, or,
    // while it has none, for anyone, though it keeps its recorded owner's
    // catalog and context until someone takes it.
    let row = transaction
        .query_opt(
            concat!(
                "insert into project_provider_devices as d (
                project_id,
                provider_id,
                provider_family_id,
                device_id,
                device_label,
                platform,
                status,
                connection_type,
                metadata,
                owner_user_id,
                catalog,
                context,
                created_at,
                updated_at,
                last_seen_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $13,
                       now(), now(), now())
             on conflict (project_id, provider_id, device_id)
             do update set
                provider_family_id = excluded.provider_family_id,
                device_label = excluded.device_label,
                platform = excluded.platform,
                status = excluded.status,
                connection_type = excluded.connection_type,
                metadata = excluded.metadata,
                owner_user_id = coalesce(excluded.owner_user_id, d.owner_user_id),
                catalog = case
                    when coalesce(excluded.owner_user_id, d.owner_user_id, $12) is distinct from $12
                        then d.catalog
                    when coalesce(excluded.owner_user_id, d.owner_user_id)
                        is distinct from d.owner_user_id then excluded.catalog
                    else coalesce(excluded.catalog, d.catalog) end,
                context = case
                    when coalesce(excluded.owner_user_id, d.owner_user_id, $12) is distinct from $12
                        then d.context
                    else excluded.context end,
                updated_at = now(),
                last_seen_at = now()
              where coalesce(",
                live_owner!(),
                ", $12) is not distinct from $12
             returning project_id, provider_id, provider_family_id, device_id, device_label,
                       platform, status, connection_type, metadata, created_at, updated_at,
                       last_seen_at, owner_user_id"
            ),
            &[
                &project_id,
                &provider_id,
                &provider_family_id,
                &device_id,
                &device_label,
                &platform,
                &status,
                &connection_type,
                &PgJson(&metadata),
                &owner_on_insert,
                &catalog.as_ref().map(PgJson),
                &caller,
                &device_context,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to record provider device heartbeat: {error}"
            ))
        })?
        .ok_or_else(|| forbidden(DEVICE_OWNED_BY_ANOTHER))?;
    let change = match stored {
        Some(stored) => Some(
            device_changed(
                &state.config,
                &transaction,
                project_id,
                &provider_id,
                &device_id,
                DeviceState {
                    status: stored.get("status"),
                    owner_user_id: stored.get("owner_user_id"),
                },
                DeviceState {
                    status: &status,
                    owner_user_id: row.get("owner_user_id"),
                },
            )
            .await?,
        ),
        None => None,
    };

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit provider device heartbeat: {error}"
        ))
    })?;
    if let Some(change) = change {
        change.publish(&state, &mut *connection).await;
    }

    Ok(Json(provider_device_to_payload(&map_provider_device_row(
        &row,
    ))))
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
        .await
        .map_err(|error| internal_error(format!("failed to load project integration: {error}")))?;

    let Some(row) = row else {
        return Err(bad_request("provider is not attached to this project"));
    };

    let status: String = row.get("status");
    let metadata: JsonValue = row.get("metadata");
    let status = status.trim().to_ascii_lowercase();
    let metadata = metadata.as_object().cloned().unwrap_or_default();
    let attached = matches!(
        status.as_str(),
        "attached" | "available" | "connected" | "enabled"
    ) && metadata
        .get("attached")
        .and_then(JsonValue::as_bool)
        .unwrap_or(true)
        && metadata
            .get("enabled")
            .and_then(JsonValue::as_bool)
            .unwrap_or(true);

    if attached {
        Ok(())
    } else {
        Err(bad_request("provider is not attached to this project"))
    }
}

fn provider_family_from_provider_id(provider_id: &str) -> &str {
    provider_id.split(':').next().unwrap_or(provider_id)
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

fn normalize_optional_provider_id(
    raw: Option<&str>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    raw.map(normalize_provider_id).transpose()
}

fn normalize_provider_family_id(
    raw: Option<&str>,
    provider_id: &str,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let candidate = raw.unwrap_or_else(|| provider_family_from_provider_id(provider_id));
    let normalized = candidate.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(bad_request("providerFamilyId is required"));
    }
    if normalized.len() > PROVIDER_FAMILY_ID_MAX_LEN {
        return Err(bad_request("providerFamilyId is too long"));
    }
    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(bad_request(
            "providerFamilyId contains unsupported characters",
        ));
    }
    Ok(normalized)
}

fn normalize_optional_provider_family_id(
    raw: Option<&str>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    raw.map(|value| normalize_provider_family_id(Some(value), value))
        .transpose()
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

fn normalize_platform(value: Option<&str>) -> Option<String> {
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "android" => Some("android".to_string()),
        "ios" => Some("ios".to_string()),
        _ => None,
    }
}

fn normalize_device_status(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("ready").trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "ready".to_string();
    }
    let filtered = normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(DEVICE_STATUS_MAX_LEN)
        .collect::<String>();
    if filtered.is_empty() {
        "ready".to_string()
    } else {
        filtered
    }
}

fn normalize_connection_type(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("native_runtime").trim();
    if normalized.is_empty() {
        return "native_runtime".to_string();
    }
    normalized
        .chars()
        .take(CONNECTION_TYPE_MAX_LEN)
        .collect::<String>()
}

/// A device's catalog as it is stored, once it has the MCP shape
/// ([`DeviceCatalog`]) and fits the limits: at most 64 tools whose names are
/// distinct as a granted turn's model reads them ([`model_tool_name`]), each
/// input schema a JSON Schema object, and 64 KiB in all.
fn normalize_catalog(value: JsonValue) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let invalid = |reason: &str| bad_request(format!("catalog {reason}"));
    let size = serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len());
    if size > CATALOG_MAX_BYTES {
        return Err(invalid("is too large"));
    }
    let catalog: DeviceCatalog = serde_json::from_value(value.clone())
        .map_err(|error| invalid(&format!("is not an MCP tools/list catalog: {error}")))?;
    if catalog.tools.len() > CATALOG_MAX_TOOLS {
        return Err(invalid("has too many tools"));
    }
    let mut names = std::collections::HashSet::new();
    for tool in &catalog.tools {
        let name_ok = !tool.name.is_empty()
            && tool.name.len() <= TOOL_NAME_MAX_LEN
            && tool
                .name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/'));
        if !name_ok || !names.insert(model_tool_name(&tool.name)) {
            return Err(invalid(
                "tool names must be of letters, digits, _ - . and /, and distinct with - . and / \
                 read as _",
            ));
        }
        if tool.input_schema.get("type").and_then(JsonValue::as_str) != Some("object") {
            return Err(invalid("tool input schemas must be JSON Schema objects"));
        }
    }
    Ok(value)
}

/// A tool's name as a granted turn's model reads it: Codex makes every
/// character but an ASCII letter, a digit or `_` an `_`.
pub(crate) fn model_tool_name(name: &str) -> String {
    name.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

/// A device's `context` as it is stored: trimmed, `None` when empty, and
/// refused unless it is plain text (no control character but a line break or
/// a tab) of at most [`CONTEXT_MAX_CHARS`] characters.
fn normalize_context(
    value: Option<String>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let Some(text) = value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    else {
        return Ok(None);
    };
    if text.chars().count() > CONTEXT_MAX_CHARS {
        return Err(bad_request(format!(
            "context must be at most {CONTEXT_MAX_CHARS} characters"
        )));
    }
    if text
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t'))
    {
        return Err(bad_request(
            "context must be plain text: no control characters but line breaks and tabs",
        ));
    }
    Ok(Some(text.to_string()))
}

fn normalize_metadata(value: Option<JsonValue>) -> JsonValue {
    value
        .filter(|entry| entry.is_object())
        .unwrap_or_else(|| JsonValue::Object(Default::default()))
}

fn parse_project_id(raw: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    Uuid::from_str(raw.trim()).map_err(|_| bad_request("projectId must be a valid UUID"))
}

fn map_provider_device_row(row: &Row) -> ProviderDeviceRecord {
    ProviderDeviceRecord {
        project_id: row.get("project_id"),
        provider_id: row.get("provider_id"),
        provider_family_id: row.get("provider_family_id"),
        device_id: row.get("device_id"),
        device_label: row.get("device_label"),
        platform: row.get("platform"),
        status: row.get("status"),
        connection_type: row.get("connection_type"),
        metadata: row.get("metadata"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        last_seen_at: row.get("last_seen_at"),
    }
}

fn provider_presence_status(last_seen_at: DateTime<Utc>, now: DateTime<Utc>) -> &'static str {
    if now.signed_duration_since(last_seen_at)
        <= ChronoDuration::seconds(DEVICE_PRESENCE_ONLINE_TTL_SECONDS)
    {
        "online"
    } else {
        "offline"
    }
}

fn provider_device_to_payload(record: &ProviderDeviceRecord) -> ProviderDevicePayload {
    ProviderDevicePayload {
        project_id: record.project_id.to_string(),
        provider_id: record.provider_id.clone(),
        provider_family_id: record.provider_family_id.clone(),
        device_id: record.device_id.clone(),
        device_label: record.device_label.clone(),
        platform: record.platform.clone(),
        status: record.status.clone(),
        connection_type: record.connection_type.clone(),
        metadata: record.metadata.clone(),
        presence_status: provider_presence_status(record.last_seen_at, Utc::now()).to_string(),
        created_at: record.created_at.to_rfc3339(),
        updated_at: record.updated_at.to_rfc3339(),
        last_seen_at: record.last_seen_at.to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_presence_status_marks_stale_devices_offline() {
        let now = DateTime::parse_from_rfc3339("2026-04-02T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let online_seen = DateTime::parse_from_rfc3339("2026-04-02T11:59:45.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let offline_seen = DateTime::parse_from_rfc3339("2026-04-02T11:59:00.000Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(provider_presence_status(online_seen, now), "online");
        assert_eq!(provider_presence_status(offline_seen, now), "offline");
    }

    #[test]
    fn a_catalog_must_have_the_mcp_shape_and_fit_its_limits() {
        let tool = |extra: JsonValue| {
            let mut tool = serde_json::json!({
                "name": "device.look",
                "inputSchema": { "type": "object", "properties": {} },
            });
            for (key, value) in extra.as_object().expect("object") {
                tool[key] = value.clone();
            }
            tool
        };
        let catalog = |tools: Vec<JsonValue>| serde_json::json!({ "tools": tools });
        let good = serde_json::json!({
            "instructions": "Use the device only when asked to.",
            "tools": [tool(serde_json::json!({ "title": "Look", "description": "Looks." }))],
        });
        assert_eq!(normalize_catalog(good.clone()).ok(), Some(good));

        let many = (0..65)
            .map(|n| tool(serde_json::json!({ "name": format!("device.t{n}") })))
            .collect();
        for bad in [
            serde_json::json!({ "tools": "device.look" }),
            catalog(vec![
                tool(serde_json::json!({})),
                tool(serde_json::json!({})),
            ]),
            // Two names a granted turn's model reads as one.
            catalog(vec![
                tool(serde_json::json!({ "name": "device.look" })),
                tool(serde_json::json!({ "name": "device-look" })),
            ]),
            catalog(vec![tool(serde_json::json!({ "name": "device look" }))]),
            catalog(vec![tool(serde_json::json!({ "name": "" }))]),
            catalog(vec![tool(
                serde_json::json!({ "inputSchema": { "type": "string" } }),
            )]),
            catalog(many),
            // 64 KiB in all.
            catalog(
                (0..40)
                    .map(|n| {
                        tool(serde_json::json!({
                            "name": format!("device.t{n}"),
                            "description": "d".repeat(2_000),
                        }))
                    })
                    .collect(),
            ),
        ] {
            let error = normalize_catalog(bad.clone()).expect_err("refused");
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn a_context_is_plain_text_of_at_most_its_cap() {
        assert_eq!(normalize_context(None).unwrap(), None);
        assert_eq!(normalize_context(Some(" \n\t ".to_string())).unwrap(), None);
        assert_eq!(
            normalize_context(Some("  status: idle\n\tpart_deg 0..20  ".to_string())).unwrap(),
            Some("status: idle\n\tpart_deg 0..20".to_string())
        );
        let at_cap = "é".repeat(CONTEXT_MAX_CHARS);
        assert_eq!(
            normalize_context(Some(at_cap.clone())).unwrap(),
            Some(at_cap)
        );
        for refused in [
            "x".repeat(CONTEXT_MAX_CHARS + 1),
            "status: idle\r\n".repeat(2),
            "bell \u{7}".to_string(),
            "escape \u{1b}[31m".to_string(),
        ] {
            let (status, _) = normalize_context(Some(refused.clone())).unwrap_err();
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused:?}");
        }
    }

    #[test]
    fn provider_family_defaults_to_instance_prefix() {
        assert_eq!(
            normalize_provider_family_id(None, "camera:phone_01").unwrap(),
            "camera"
        );
    }
}
