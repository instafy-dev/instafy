use std::collections::HashSet;
use std::str::FromStr;

use anyhow::{Context, Result as AnyResult};
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::ToSql;
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::auth::{authenticate_request, RequestContext};
use crate::state::publish_controller_event_to_user;
use crate::state::{RuntimePreferenceEntry, RuntimePreferenceRegistry, RuntimeResourceUsageEntry};
use crate::tunnels::revoke_tunnels_for_scope;
use crate::workspace::{endpoint_matches_local, fetch_runtime_candidate, status_is_viable};
use crate::{
    bad_request, database_unavailable, ensure_project_access, ensure_project_write_access,
    internal_error, load_project_record, parse_optional_uuid_param, publish_controller_event,
    unauthorized, ApiError, AppState,
};
use crate::{workspace::LOCAL_RUNTIME_RECENCY_SECONDS, workspace::REMOTE_RUNTIME_RECENCY_SECONDS};

use super::db::{ensure_project_exists, sanitize_runtime_event_data};
use super::ensure::RuntimeEnsureOriginInfo;
use super::stop::{stop_runtime_safely, StopOptions};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeActivityPayload {
    status: Option<String>,
    #[serde(default)]
    last_interaction_at: Option<String>,
    #[serde(default, rename = "idleTtlSeconds")]
    idle_ttl_seconds: Option<i64>,
    #[serde(default, rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
    #[serde(default)]
    tenants: Option<Vec<RuntimeActivityTenantPayload>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeActivityTenantPayload {
    #[serde(rename = "projectId", alias = "project_id")]
    project_id: Option<String>,
    #[serde(default, rename = "workspacePath", alias = "workspace_path")]
    workspace_path: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeActivityResponse {
    ok: bool,
    released_jobs: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatusQuery {
    session_id: Option<String>,
    access_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatusEntry {
    runtime_id: String,
    status: String,
    provider: String,
    idle_ttl_seconds: i32,
    #[serde(skip_serializing_if = "Option::is_none", rename = "createdAt")]
    created_at: Option<String>,
    last_seen_at: Option<String>,
    endpoint_url: Option<String>,
    task_ref: Option<String>,
    #[serde(default)]
    is_local: bool,
    #[serde(default)]
    is_private_self_hosted: bool,
    #[serde(default)]
    is_preferred: bool,
    #[serde(default)]
    health: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "displayName")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<RuntimeEnsureOriginInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resources: Option<RuntimeResourceUsageEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_image: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatusResponse {
    runtimes: Vec<RuntimeStatusEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preferred_runtime_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeLogsQuery {
    session_id: Option<String>,
    access_token: Option<String>,
    limit: Option<u32>,
    runtime_id: Option<String>,
    kind: Option<String>,
    since: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeLogEntry {
    runtime_id: String,
    kind: String,
    created_at: String,
    data: JsonValue,
}

fn build_runtime_logs_sql(
    has_runtime_filter: bool,
    has_kind_filter: bool,
    has_since_filter: bool,
) -> String {
    let mut sql = String::from(
        "select e.runtime_id, e.kind, e.data, e.created_at,
                runtime_record.provider as runtime_provider,
                runtime_record.capabilities as runtime_capabilities
         from runtime_events e
         left join runtimes runtime_record
           on runtime_record.id = e.runtime_id
          and runtime_record.project_id = e.project_id
         where e.project_id = $1
           and (
             $2::boolean
             or (
               e.kind <> 'shared_tenant_heartbeat'
               and not (e.kind = 'agent.complete' and e.conversation_id is null)
             )
           )
           and (
             $2::boolean
             or e.conversation_id is null
             or exists (
               select 1
               from conversations c
               where c.id = e.conversation_id
                 and c.project_id = e.project_id
                 and (
                   lower(c.visibility) <> 'private'
                   or c.created_by = $3
                   or exists (
                     select 1
                     from conversation_participants cp
                     where cp.conversation_id = c.id
                       and cp.user_id = $3
                   )
                 )
             )
           )
           and (
             $2::boolean
             or not exists (
               select 1
               from runtimes private_runtime
               where private_runtime.id = e.runtime_id
                 and (
                   regexp_replace(lower(btrim(private_runtime.provider)), '[-_[:space:]]+', '_', 'g') = 'self_hosted'
                   or not (
                     regexp_replace(lower(btrim(private_runtime.provider)), '[-_[:space:]]+', '_', 'g') = any($4::text[])
                   )
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
                 ) is distinct from $3::uuid::text
             )
           )",
    );
    let mut next_index = 5;

    if has_runtime_filter {
        sql.push_str(&format!(" and e.runtime_id = ${next_index}"));
        next_index += 1;
    }

    if has_kind_filter {
        sql.push_str(&format!(" and e.kind = ${next_index}"));
        next_index += 1;
    }

    if has_since_filter {
        sql.push_str(&format!(" and e.created_at >= ${next_index}"));
        next_index += 1;
    }

    sql.push_str(&format!(" order by e.created_at desc limit ${next_index}"));
    sql
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePreferenceBody {
    runtime_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePreferenceResponse {
    project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "displayName")]
    display_name: Option<String>,
}

fn origin_info_from_status_row(row: &tokio_postgres::Row) -> Option<RuntimeEnsureOriginInfo> {
    let instance_id: Option<Uuid> = row.get("origin_instance_id");
    let status: Option<String> = row.get("origin_status");
    let origin_id: Option<Uuid> = row.get("origin_origin_id");
    let lease_id: Option<Uuid> = row.get("origin_lease_id");
    let mode: Option<String> = row.get("origin_mode");
    let endpoint: Option<String> = row.get("origin_endpoint");
    let protocols: Option<Vec<String>> = row.get("origin_protocols");
    let metadata: Option<JsonValue> = row.get("origin_metadata");

    if instance_id.is_none() && origin_id.is_none() && endpoint.is_none() && metadata.is_none() {
        return None;
    }

    Some(RuntimeEnsureOriginInfo {
        status,
        origin_id: origin_id.map(|value| value.to_string()),
        lease_id: lease_id.map(|value| value.to_string()),
        mode,
        protocols: protocols.unwrap_or_default(),
        endpoint,
        metadata,
    })
}

fn extract_runtime_image_from_metadata(metadata: Option<&JsonValue>) -> Option<String> {
    let value = metadata?;
    let object = value.as_object()?;

    let direct = object
        .get("runtimeAgentImage")
        .or_else(|| object.get("runtime_agent_image"))
        .or_else(|| object.get("runtime-agent-image"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if direct.is_some() {
        return direct;
    }

    object
        .get("env")
        .and_then(JsonValue::as_object)
        .and_then(|env| {
            env.get("RUNTIME_AGENT_IMAGE")
                .or_else(|| env.get("runtime_agent_image"))
                .or_else(|| env.get("runtimeAgentImage"))
        })
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn ensure_runtime_activity_identity(
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.scoped_claims.is_some() {
        return Err(unauthorized(
            "scoped runtime tokens cannot report user activity",
        ));
    }
    Ok(())
}

#[instrument(skip(state, headers, payload))]
pub(crate) async fn runtime_activity(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<RuntimeActivityPayload>,
) -> Result<Json<RuntimeActivityResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;

    let auth_context =
        authenticate_request(&state.config, &headers, payload.access_token.as_deref()).await?;
    ensure_runtime_activity_identity(&auth_context)?;

    let processed_tenants: Vec<(Uuid, Option<String>, Option<String>)> = payload
        .tenants
        .as_ref()
        .into_iter()
        .flatten()
        .filter_map(|tenant| {
            let tenant_id = tenant
                .project_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|value| Uuid::from_str(value).ok())?;
            Some((
                tenant_id,
                tenant.workspace_path.clone(),
                tenant.status.clone(),
            ))
        })
        .collect();

    {
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
        for (tenant_id, _, _) in &processed_tenants {
            let tenant_project = load_project_record(&transaction, tenant_id).await?;
            ensure_project_write_access(&transaction, &tenant_project, &auth_context, None).await?;
        }
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to commit activity transaction: {error}"))
        })?;
    }

    let status_is_idle = payload
        .status
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("idle"))
        .unwrap_or(false);
    let last_interaction_at = payload
        .last_interaction_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let idle_ttl_override = payload.idle_ttl_seconds;
    let entry = state
        .runtime_activity
        .mark_active(project_id, idle_ttl_override, last_interaction_at)
        .await;

    // Durable copy of GENUINE user activity (this endpoint is only called by
    // real clients — sweep bookkeeping never writes here). The idle-stop sweep
    // reads this table, so it survives controller restarts and cannot be
    // confused by in-memory refreshes. Active pings only; an explicit idle
    // signal must not extend the activity window.
    if !status_is_idle {
        let connection = state
            .pool
            .get()
            .await
            .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
        let result = connection
            .execute(
                "insert into project_user_activity (project_id, last_active_at)
                 values ($1, now())
                 on conflict (project_id) do update set last_active_at = now()",
                &[&project_id],
            )
            .await;
        if let Err(error) = result {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if !matches!(
                code,
                Some(&tokio_postgres::error::SqlState::UNDEFINED_TABLE)
            ) {
                warn!(project_id = %project_id, %error, "failed to persist project user activity");
            }
        }
    }

    let mut released_jobs = 0usize;
    if status_is_idle {
        released_jobs = release_leases_for_project(
            &state,
            &project_id,
            entry.idle_ttl_seconds,
            "explicit_idle_signal",
        )
        .await
        .map_err(|error| internal_error(format!("failed to release leases: {error}")))?;
        if released_jobs > 0 {
            state.runtime_activity.mark_released(&project_id).await;
        }
    }

    if !processed_tenants.is_empty() {
        let tenant_json_items: Vec<JsonValue> = processed_tenants
            .iter()
            .map(|(tenant_id, workspace_path, status)| {
                let mut map = serde_json::Map::new();
                map.insert(
                    "projectId".to_string(),
                    JsonValue::String(tenant_id.to_string()),
                );
                if let Some(path) = workspace_path {
                    map.insert("workspacePath".to_string(), JsonValue::String(path.clone()));
                }
                if let Some(state_value) = status {
                    map.insert("status".to_string(), JsonValue::String(state_value.clone()));
                }
                JsonValue::Object(map)
            })
            .collect();
        let tenant_json_value = JsonValue::Array(tenant_json_items.clone());
        let tenant_metadata = {
            let mut map = serde_json::Map::new();
            map.insert("tenants".to_string(), tenant_json_value.clone());
            JsonValue::Object(map)
        };

        let touched_runtime_ids: Vec<Uuid> = {
            let mut touched_runtime_ids: Vec<Uuid> = Vec::new();
            let mut lease_conn = state.pool.get().await.map_err(|error| {
                internal_error(format!(
                    "failed to get connection for tenant heartbeat: {error}"
                ))
            })?;
            let lease_tx = lease_conn.transaction().await.map_err(|error| {
                internal_error(format!(
                    "failed to start tenant heartbeat transaction: {error}"
                ))
            })?;
            let host_runtimes = lease_tx
                    .query(
                        "select id, active_lease_id from runtimes where project_id = $1 and active_lease_id is not null",
                        &[&project_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!(
                            "failed to load runtime leases for tenant heartbeat: {error}"
                        ))
                    })?;

            for host in host_runtimes {
                let runtime_id: Uuid = host.get("id");
                let lease_id: Option<Uuid> = host.get("active_lease_id");
                let Some(lease_id) = lease_id else {
                    continue;
                };
                let scope_row = lease_tx
                    .query_opt(
                        "select scope from runtime_leases where id = $1 for update",
                        &[&lease_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to inspect runtime lease scope: {error}"))
                    })?;
                let Some(scope_row) = scope_row else {
                    continue;
                };
                let scope: String = scope_row.get("scope");
                if scope != "shared" {
                    continue;
                }
                lease_tx
                        .execute(
                            "update runtime_leases set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1",
                            &[&lease_id, &tenant_metadata],
                        )
                        .await
                        .map_err(|error| {
                            internal_error(format!("failed to store tenant manifest: {error}"))
                        })?;
                // Liveness and the manifest already persist via the lease
                // row (metadata + updated_at) and the runtime.shared_tenants
                // pub/sub event below. We deliberately do NOT write a
                // runtime_events row per heartbeat: nothing reads it, and at
                // heartbeat frequency it was the dominant source of the
                // table's unbounded growth.
                touched_runtime_ids.push(runtime_id);
            }

            lease_tx.commit().await.map_err(|error| {
                internal_error(format!("failed to commit tenant heartbeat: {error}"))
            })?;

            touched_runtime_ids
        };

        for runtime_id in touched_runtime_ids {
            publish_controller_event(
                &state.events,
                "runtime.shared_tenants",
                Some(project_id),
                Some(runtime_id),
                None,
                None,
                tenant_metadata.clone(),
            );
        }
    }

    Ok(Json(RuntimeActivityResponse {
        ok: true,
        released_jobs,
    }))
}

#[instrument(skip(state, headers, query))]
pub(crate) async fn runtime_status(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
    Query(query): Query<RuntimeStatusQuery>,
) -> Result<Json<RuntimeStatusResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;

    let session_id = parse_optional_uuid_param(query.session_id.clone(), "sessionId")?;
    let token_override = query.access_token.clone();
    let auth_context =
        authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime status", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Runtime status", error))?;

    let project = match load_project_record(&transaction, &project_id).await {
        Ok(project) => project,
        Err((status, _))
            if status == StatusCode::NOT_FOUND && state.config.auto_create_projects =>
        {
            ensure_project_exists(&transaction, &project_id, state.config.auto_create_projects)
                .await?;
            load_project_record(&transaction, &project_id).await?
        }
        Err(err) => return Err(err),
    };
    ensure_project_access(&transaction, &project, &auth_context, session_id).await?;

    let response = load_runtime_status_response_for_viewer(
        &state,
        &transaction,
        &project_id,
        auth_context.user_id,
        auth_context.is_service_role,
    )
    .await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize runtime status check: {error}"))
    })?;

    tracing::info!(
        project_id = %project_id,
        entry_count = response.runtimes.len(),
        first_status = response.runtimes.get(0).map(|e| e.status.clone()).unwrap_or_default(),
        first_health = response.runtimes.get(0).map(|e| e.health.clone()).unwrap_or_default(),
        "[runtime_status] returning runtimes"
    );

    Ok(Json(response))
}

pub(crate) async fn load_runtime_status_response(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
) -> Result<RuntimeStatusResponse, (StatusCode, Json<ApiError>)> {
    load_runtime_status_response_for_viewer(state, transaction, project_id, None, true).await
}

async fn load_runtime_status_response_for_viewer(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    viewer_user_id: Option<Uuid>,
    include_all_private_runtimes: bool,
) -> Result<RuntimeStatusResponse, (StatusCode, Json<ApiError>)> {
    let rows = transaction
        .query(
            "select r.id,
                    r.provider,
                    r.capabilities,
                    r.status,
                    r.idle_ttl_seconds,
                    r.created_at,
                    r.last_seen_at,
                    r.endpoint_url,
                    r.task_ref,
                    r.updated_at,
                    r.display_name,
                    oi.id as origin_instance_id,
                    oi.status as origin_status,
                    oi.origin_id as origin_origin_id,
                    oi.lease_id as origin_lease_id,
                    oi.mode as origin_mode,
                    oi.endpoint as origin_endpoint,
                    oi.protocols as origin_protocols,
                    oi.metadata as origin_metadata,
                    rl.metadata as lease_metadata
             from runtimes r
             left join runtime_leases rl
               on rl.id = r.active_lease_id
             left join lateral (
                select oi.*
                from origin_instances oi
                where oi.runtime_id = r.id
                  and oi.status <> 'released'
                order by oi.updated_at desc
                limit 1
             ) oi on true
             where r.project_id = $1
               and r.status <> 'removed'
             order by
               case
                 when coalesce(rl.metadata #>> '{source}', '') = 'skill_multi_agent_plan' then 1
                 else 0
               end,
               r.updated_at desc",
            &[project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load runtime status: {error}")))?;

    let preference = if let Some(viewer_user_id) = viewer_user_id {
        state
            .runtime_preferences
            .get_private(project_id, &viewer_user_id)
            .await
            .or(state.runtime_preferences.get(project_id).await)
    } else {
        state.runtime_preferences.get(project_id).await
    };
    let preferred_runtime_id = preference
        .as_ref()
        .and_then(|entry| entry.runtime_id)
        .map(|id| id.to_string());

    let mut entries: Vec<RuntimeStatusEntry> = Vec::with_capacity(rows.len());
    for row in rows {
        let runtime_id: Uuid = row.get("id");
        let status: String = row.get("status");
        let provider: String = row.get("provider");
        let capabilities: JsonValue = row.get("capabilities");
        if !super::access::self_hosted_runtime_is_accessible_to_user(
            state,
            &provider,
            &capabilities,
            viewer_user_id,
            include_all_private_runtimes,
        ) {
            continue;
        }
        let endpoint_url: Option<String> = row.get("endpoint_url");
        let last_seen_at: Option<DateTime<Utc>> = row.get("last_seen_at");
        let created_at: Option<DateTime<Utc>> = row.get("created_at");
        let idle_ttl_seconds: i32 = row.get("idle_ttl_seconds");
        let origin = origin_info_from_status_row(&row);
        let is_private_self_hosted =
            super::access::runtime_is_private_self_hosted(state, &provider, &capabilities);
        let is_local = origin
            .as_ref()
            .and_then(|info| info.mode.clone())
            .map(|mode| mode.to_ascii_lowercase() == "desktop")
            .unwrap_or(false)
            || is_private_self_hosted
            || endpoint_matches_local(endpoint_url.as_deref());
        let health =
            determine_runtime_health(last_seen_at, idle_ttl_seconds, status.as_str(), is_local);
        let resources = state
            .runtime_resource_usage
            .get(&runtime_id)
            .await
            .map(RuntimeResourceUsageEntry::from);
        let lease_metadata: Option<JsonValue> = row.get("lease_metadata");
        let runtime_image = extract_runtime_image_from_metadata(lease_metadata.as_ref());

        entries.push(RuntimeStatusEntry {
            runtime_id: runtime_id.to_string(),
            status,
            provider,
            idle_ttl_seconds,
            created_at: created_at.map(|value| value.to_rfc3339()),
            last_seen_at: last_seen_at.map(|value| value.to_rfc3339()),
            endpoint_url: endpoint_url.clone(),
            task_ref: row.get("task_ref"),
            is_local,
            is_private_self_hosted,
            is_preferred: preferred_runtime_id
                .as_ref()
                .map(|value| value == &runtime_id.to_string())
                .unwrap_or(false),
            health,
            display_name: row.get::<_, Option<String>>("display_name"),
            origin,
            resources,
            runtime_image,
        });
        // Apply the public response cap only after private-runtime ownership
        // filtering. Otherwise another user's private rows can consume the SQL
        // limit and hide runtimes this viewer is actually allowed to see.
        if entries.len() == 20 {
            break;
        }
    }

    let preferred_runtime_id = preferred_runtime_id.filter(|preferred| {
        entries
            .iter()
            .any(|entry| entry.runtime_id.as_str() == preferred.as_str())
    });

    Ok(RuntimeStatusResponse {
        runtimes: entries,
        preferred_runtime_id,
    })
}

#[instrument(skip(state, headers))]
pub(super) async fn runtime_preference(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
    Query(query): Query<RuntimeStatusQuery>,
) -> Result<Json<RuntimePreferenceResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;

    let session_id = parse_optional_uuid_param(query.session_id.clone(), "sessionId")?;
    let token_override = query.access_token.clone();
    let auth_context =
        authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

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
    ensure_project_access(&transaction, &project, &auth_context, session_id).await?;

    let preference = if let Some(user_id) = auth_context.user_id {
        state
            .runtime_preferences
            .get_private(&project_id, &user_id)
            .await
            .or(state.runtime_preferences.get(&project_id).await)
    } else {
        state.runtime_preferences.get(&project_id).await
    };
    let mut runtime_id = preference
        .as_ref()
        .and_then(|entry| entry.runtime_id)
        .map(|id| id.to_string());
    if let Some(preferred_id) = preference.as_ref().and_then(|entry| entry.runtime_id) {
        let row = transaction
            .query_opt(
                "select provider, capabilities from runtimes where project_id = $1 and id = $2",
                &[&project_id, &preferred_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to validate preferred runtime owner: {error}"
                ))
            })?;
        let accessible = row.is_some_and(|row| {
            let provider: String = row.get("provider");
            let capabilities: JsonValue = row.get("capabilities");
            super::access::self_hosted_runtime_is_accessible_to_user(
                &state,
                &provider,
                &capabilities,
                auth_context.user_id,
                auth_context.is_service_role,
            )
        });
        if !accessible {
            runtime_id = None;
        }
    }
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize preference lookup: {error}"))
    })?;

    let visible_preference = runtime_id.is_some();
    let source = visible_preference
        .then(|| preference.as_ref().and_then(|entry| entry.source.clone()))
        .flatten();
    let updated_at = visible_preference
        .then(|| {
            preference
                .as_ref()
                .map(|entry| entry.updated_at.to_rfc3339())
        })
        .flatten();
    let display_name = visible_preference
        .then(|| {
            preference
                .as_ref()
                .and_then(|entry| entry.display_name.clone())
        })
        .flatten();

    Ok(Json(RuntimePreferenceResponse {
        project_id: project_id.to_string(),
        runtime_id,
        source,
        updated_at,
        display_name,
    }))
}

#[instrument(skip(state, headers, body))]
pub(super) async fn set_runtime_preference(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RuntimePreferenceBody>,
) -> Result<Json<RuntimePreferenceResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;

    let auth_context =
        authenticate_request(&state.config, &headers, body.access_token.as_deref()).await?;

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

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize preference change: {error}"))
    })?;

    let requested_runtime = body
        .runtime_id
        .as_ref()
        .map(|value| Uuid::from_str(value.trim()))
        .transpose()
        .map_err(|_| bad_request("runtimeId must be a valid UUID"))?;

    let mut preference_target_user = None;
    let preference_entry = if let Some(runtime_id) = requested_runtime {
        let candidate = fetch_runtime_candidate(&state.pool, &project_id, &runtime_id).await?;
        let Some(candidate) = candidate else {
            return Err(bad_request("runtimeId not found for project"));
        };
        super::access::ensure_self_hosted_runtime_access(
            &state,
            &candidate.provider,
            &candidate.capabilities,
            auth_context.user_id,
            auth_context.is_service_role,
        )?;
        if !status_is_viable(candidate.status.as_str()) {
            return Err(bad_request("runtimeId is not ready for leases"));
        }
        let is_private = super::access::runtime_is_private_self_hosted(
            &state,
            &candidate.provider,
            &candidate.capabilities,
        );
        let source = body.source.clone().or_else(|| Some("user".to_string()));
        let display_name = candidate.display_name.clone();
        if is_private {
            let owner_user_id = auth_context.user_id.ok_or_else(|| {
                unauthorized("private runtime preference requires an authenticated owner")
            })?;
            preference_target_user = Some(owner_user_id);
            state
                .runtime_preferences
                .set_private(
                    project_id,
                    owner_user_id,
                    Some(candidate.id),
                    source.clone(),
                    display_name.clone(),
                )
                .await
        } else {
            state
                .runtime_preferences
                .set(
                    project_id,
                    Some(candidate.id),
                    source.clone(),
                    display_name.clone(),
                )
                .await
        }
    } else {
        preference_target_user = clear_runtime_preference_for_context(
            &state.runtime_preferences,
            &project_id,
            &auth_context,
        )
        .await;
        RuntimePreferenceEntry {
            runtime_id: None,
            source: body.source.clone(),
            updated_at: Utc::now(),
            display_name: None,
        }
    };

    let preference_event = json!({
        "runtimeId": preference_entry.runtime_id,
        "source": preference_entry.source.clone(),
        "updatedAt": preference_entry.updated_at,
        "displayName": preference_entry.display_name.clone(),
    });
    if let Some(target_user_id) = preference_target_user {
        publish_controller_event_to_user(
            &state.events,
            "runtime.preference_updated",
            Some(project_id),
            target_user_id,
            preference_event,
        );
    } else {
        publish_controller_event(
            &state.events,
            "runtime.preference_updated",
            Some(project_id),
            None,
            None,
            None,
            preference_event,
        );
    }

    Ok(Json(RuntimePreferenceResponse {
        project_id: project_id.to_string(),
        runtime_id: preference_entry.runtime_id.map(|id| id.to_string()),
        source: preference_entry.source.clone(),
        updated_at: Some(preference_entry.updated_at.to_rfc3339()),
        display_name: preference_entry.display_name.clone(),
    }))
}

async fn clear_runtime_preference_for_context(
    preferences: &RuntimePreferenceRegistry,
    project_id: &Uuid,
    context: &RequestContext,
) -> Option<Uuid> {
    if !context.is_service_role {
        if let Some(user_id) = context.user_id {
            if preferences.clear_private(project_id, &user_id).await {
                return Some(user_id);
            }
        }
    }

    preferences.clear(project_id).await;
    None
}

#[instrument(skip(state, headers, query))]
pub(crate) async fn runtime_logs(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
    Query(query): Query<RuntimeLogsQuery>,
) -> Result<Json<Vec<RuntimeLogEntry>>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;

    let session_id = parse_optional_uuid_param(query.session_id.clone(), "sessionId")?;
    let token_override = query.access_token.clone();
    let auth_context =
        authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

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
    ensure_project_access(&transaction, &project, &auth_context, session_id).await?;

    let mut limit = query.limit.unwrap_or(50);
    if limit == 0 {
        limit = 50;
    }
    if limit > 200 {
        limit = 200;
    }
    let limit_i64: i64 = limit.into();

    let kind_filter = query
        .kind
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let since_filter = if let Some(raw) = query
        .since
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(
            DateTime::parse_from_rfc3339(raw)
                .map_err(|_| bad_request("since must be an RFC3339 timestamp"))?
                .with_timezone(&Utc),
        )
    } else {
        None
    };

    let runtime_filter = query
        .runtime_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| Uuid::from_str(value))
        .transpose()
        .map_err(|_| bad_request("runtimeId must be a valid UUID"))?;

    let conversation_filter_bypass = auth_context.is_service_role;
    let viewer_user_id = auth_context.user_id;
    let mut managed_runtime_provider_ids =
        vec![crate::provider_identifiers::PROVIDER_ID_INSTAFY_CLOUD.to_string()];
    managed_runtime_provider_ids.extend(
        state
            .provider_registry
            .provider_configs()
            .into_iter()
            .filter(|provider| {
                !crate::provider_identifiers::is_self_hosted_provider_kind(&provider.kind)
            })
            .map(|provider| crate::provider_identifiers::provider_id_key(&provider.id)),
    );
    managed_runtime_provider_ids.sort();
    managed_runtime_provider_ids.dedup();
    let sql = build_runtime_logs_sql(
        runtime_filter.is_some(),
        kind_filter.is_some(),
        since_filter.is_some(),
    );
    let mut params: Vec<&(dyn ToSql + Sync)> = Vec::new();
    params.push(&project_id);
    params.push(&conversation_filter_bypass);
    params.push(&viewer_user_id);
    params.push(&managed_runtime_provider_ids);

    if let Some(ref runtime_uuid) = runtime_filter {
        params.push(runtime_uuid);
    }

    if let Some(ref kind) = kind_filter {
        params.push(kind);
    }

    if let Some(ref since) = since_filter {
        params.push(since);
    }

    params.push(&limit_i64);

    let rows = transaction
        .query(sql.as_str(), &params)
        .await
        .map_err(|error| internal_error(format!("failed to load runtime logs: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize runtime logs check: {error}"))
    })?;

    let entries = rows
        .into_iter()
        .filter_map(|row| {
            let runtime_provider: Option<String> = row.get("runtime_provider");
            let runtime_capabilities: Option<JsonValue> = row.get("runtime_capabilities");
            if runtime_provider
                .as_deref()
                .zip(runtime_capabilities.as_ref())
                .is_some_and(|(provider, capabilities)| {
                    !super::access::self_hosted_runtime_is_accessible_to_user(
                        &state,
                        provider,
                        capabilities,
                        auth_context.user_id,
                        auth_context.is_service_role,
                    )
                })
            {
                return None;
            }
            let kind = row.get::<_, String>("kind");
            Some(RuntimeLogEntry {
                runtime_id: row.get::<_, Uuid>("runtime_id").to_string(),
                data: sanitize_runtime_event_data(&kind, row.get::<_, JsonValue>("data")),
                kind,
                created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(entries))
}

pub(super) async fn release_leases_for_project(
    state: &AppState,
    project_id: &Uuid,
    idle_ttl_seconds: i64,
    reason: &str,
) -> AnyResult<usize> {
    let mut connection = state
        .pool
        .get()
        .await
        .context("failed to get connection for lease release")?;
    let transaction = connection
        .transaction()
        .await
        .context("failed to start lease release transaction")?;

    let rows = transaction
        .query(
            "with expired_jobs as (
                 select id, leased_by_runtime_id
                 from agent_jobs
                 where project_id = $1
                   and status = 'leased'
                   and (lease_expires_at is null or lease_expires_at < now())
                 for update
             ), released_jobs as (
                 update agent_jobs jobs
                 set status = 'queued',
                     leased_by_runtime_id = null,
                     lease_expires_at = null,
                     leased_at = null,
                     heartbeat_at = null,
                     updated_at = now()
                 from expired_jobs expired
                 where jobs.id = expired.id
                 returning jobs.id
             )
             select released.id, expired.leased_by_runtime_id
             from released_jobs released
             join expired_jobs expired on expired.id = released.id",
            &[project_id],
        )
        .await
        .context("failed to release idle leases")?;

    let runtime_id_set: HashSet<Uuid> = rows
        .iter()
        .filter_map(|row| row.get::<_, Option<Uuid>>("leased_by_runtime_id"))
        .collect();

    transaction
        .commit()
        .await
        .context("failed to commit idle lease release")?;
    // Runtime cleanup and tunnel revocation both acquire their own pool
    // connections. Drop this one before the loop so pool size one remains a
    // supported production configuration.
    drop(connection);

    let released_job_ids: Vec<Uuid> = rows.iter().map(|row| row.get("id")).collect();
    let runtime_ids: Vec<Uuid> = runtime_id_set.into_iter().collect();

    for runtime_id in &runtime_ids {
        if let Some(candidate) = fetch_runtime_candidate(&state.pool, project_id, runtime_id)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!(
                    "failed to inspect runtime before idle cleanup ({}): {}",
                    status,
                    error.message
                )
            })?
        {
            if super::access::runtime_is_private_self_hosted(
                state,
                &candidate.provider,
                &candidate.capabilities,
            ) {
                // Expired work may be requeued, but a project-level idle signal
                // must never power down a collaborator's private machine.
                continue;
            }
        }
        let safe_stop = stop_runtime_safely(
            state,
            runtime_id,
            StopOptions {
                source: "idle_lease_release",
                reason: Some(reason.to_string()),
                // Another still-live hosted job may have renewed or acquired
                // the runtime after the expired rows were requeued.
                skip_if_active_jobs: true,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await;

        match safe_stop {
            Ok(stopped) if stopped.outcome.status_changed => {
                if let Err((status, payload)) = revoke_tunnels_for_scope(
                    state,
                    project_id,
                    Some(runtime_id),
                    stopped.outcome.released_runtime_lease_id.as_ref(),
                    reason,
                )
                .await
                {
                    warn!(
                        project_id = %project_id,
                        runtime_id = %runtime_id,
                        %status,
                        error = payload.0.message,
                        "failed to auto-revoke tunnels during lease release"
                    );
                }
            }
            Ok(_) => {}
            Err((status, payload)) => {
                warn!(
                    project_id = %project_id,
                    runtime_id = %runtime_id,
                    %status,
                    error = payload.0.message,
                    "runtime cleanup remains fenced after idle job release"
                );
            }
        }
    }

    if !released_job_ids.is_empty() {
        let job_strings: Vec<String> = released_job_ids.iter().map(|id| id.to_string()).collect();
        let runtime_strings: Vec<String> = runtime_ids.iter().map(|id| id.to_string()).collect();
        publish_controller_event(
            &state.events,
            "runtime.dev_isolation",
            Some(*project_id),
            None,
            None,
            None,
            json!({
                "action": "lease_released_idle",
                "reason": reason,
                "idleTtlSeconds": idle_ttl_seconds,
                "releasedJobCount": released_job_ids.len(),
                "jobIds": job_strings,
                "runtimeIds": runtime_strings,
            }),
        );
        tracing::info!(
            project_id = %project_id,
            released_jobs = released_job_ids.len(),
            %reason,
            "released leased jobs due to idle workspace"
        );
    }

    Ok(released_job_ids.len())
}

pub(crate) fn determine_runtime_health(
    last_seen_at: Option<DateTime<Utc>>,
    idle_ttl_seconds: i32,
    status: &str,
    is_local: bool,
) -> String {
    let normalized_status = status.trim().to_ascii_lowercase();
    if matches!(
        normalized_status.as_str(),
        "offline" | "stopped" | "stopping" | "error"
    ) {
        debug!(
            status = normalized_status.as_str(),
            "runtime health forced offline due to terminal status"
        );
        return "offline".to_string();
    }
    let Some(last_seen) = last_seen_at else {
        debug!("runtime health offline: runtime has never reported a heartbeat");
        return "offline".to_string();
    };
    let now = Utc::now();
    let elapsed = now.signed_duration_since(last_seen).num_seconds();
    let recency_grace = if is_local {
        *LOCAL_RUNTIME_RECENCY_SECONDS
    } else {
        *REMOTE_RUNTIME_RECENCY_SECONDS
    };
    let ttl = idle_ttl_seconds.max(1) as i64;
    let online_threshold = std::cmp::min(ttl, recency_grace);
    let idle_threshold = std::cmp::max(ttl.saturating_mul(3), recency_grace);
    if elapsed <= online_threshold {
        "online".to_string()
    } else if elapsed <= idle_threshold {
        "idle".to_string()
    } else {
        debug!(
            elapsed_seconds = elapsed,
            online_threshold_seconds = online_threshold,
            idle_threshold_seconds = idle_threshold,
            is_local,
            "runtime health offline due to heartbeat TTL expiry"
        );
        "offline".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;

    #[test]
    fn runtime_logs_query_filters_unsafe_project_wide_events_before_pagination() {
        let sql = build_runtime_logs_sql(false, false, false);
        let heartbeat_filter = sql
            .find("e.kind <> 'shared_tenant_heartbeat'")
            .expect("heartbeat filter");
        let conversationless_completion_filter = sql
            .find("not (e.kind = 'agent.complete' and e.conversation_id is null)")
            .expect("conversationless agent completion filter");
        let order = sql.find("order by e.created_at desc").expect("ordering");
        let limit = sql.find("limit $5").expect("limit");

        assert!(heartbeat_filter < order);
        assert!(conversationless_completion_filter < order);
        assert!(order < limit);
        assert!(sql.contains(
            "$2::boolean\n             or (\n               e.kind <> 'shared_tenant_heartbeat'"
        ));
    }

    #[test]
    fn runtime_logs_query_keeps_optional_parameter_order_stable() {
        let sql = build_runtime_logs_sql(true, true, true);

        assert!(sql.contains("e.runtime_id = $5"));
        assert!(sql.contains("e.kind = $6"));
        assert!(sql.contains("e.created_at >= $7"));
        assert!(sql.ends_with("limit $8"));
    }

    #[test]
    fn runtime_logs_query_treats_deleted_conversation_ids_as_private_tombstones() {
        let sql = build_runtime_logs_sql(false, false, false);

        assert!(sql.contains(
            "$2::boolean\n             or e.conversation_id is null\n             or exists ("
        ));
        assert!(sql.contains("where c.id = e.conversation_id"));
        assert!(sql.contains("and c.project_id = e.project_id"));
    }

    #[test]
    fn runtime_activity_rejects_scoped_machine_tokens() {
        let project_id = Uuid::new_v4();
        let scoped = RequestContext {
            user_id: Some(Uuid::new_v4()),
            is_service_role: false,
            scoped_claims: Some(runtime_contracts::AccessTokenClaims {
                aud: project_id.to_string(),
                sub: Uuid::new_v4().to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: Some(Uuid::new_v4().to_string()),
                protocol: None,
                scopes: vec!["agent.heartbeat".to_string()],
                lease_id: None,
                runtime_generation: None,
                run_id: None,
                iat: 1,
                exp: i64::MAX,
                jti: Uuid::new_v4().to_string(),
                prefer_runtime: None,
                actor_label: None,
                browser_session_id: None,
            }),
        };
        assert!(ensure_runtime_activity_identity(&scoped).is_err());

        let interactive = RequestContext {
            user_id: Some(Uuid::new_v4()),
            is_service_role: false,
            scoped_claims: None,
        };
        assert!(ensure_runtime_activity_identity(&interactive).is_ok());

        let trusted_service = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };
        assert!(ensure_runtime_activity_identity(&trusted_service).is_ok());
    }

    #[tokio::test]
    async fn human_private_preference_clear_preserves_shared_preference() {
        let preferences = RuntimePreferenceRegistry::new();
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let shared_runtime_id = Uuid::new_v4();
        let private_runtime_id = Uuid::new_v4();
        preferences
            .set(
                project_id,
                Some(shared_runtime_id),
                Some("shared".to_string()),
                None,
            )
            .await;
        preferences
            .set_private(
                project_id,
                owner_user_id,
                Some(private_runtime_id),
                Some("private".to_string()),
                None,
            )
            .await;

        let target = clear_runtime_preference_for_context(
            &preferences,
            &project_id,
            &RequestContext {
                user_id: Some(owner_user_id),
                is_service_role: false,
                scoped_claims: None,
            },
        )
        .await;

        assert_eq!(target, Some(owner_user_id));
        assert!(preferences
            .get_private(&project_id, &owner_user_id)
            .await
            .is_none());
        assert_eq!(
            preferences
                .get(&project_id)
                .await
                .and_then(|entry| entry.runtime_id),
            Some(shared_runtime_id)
        );
    }

    #[tokio::test]
    async fn human_without_private_preference_clears_shared_preference() {
        let preferences = RuntimePreferenceRegistry::new();
        let project_id = Uuid::new_v4();
        preferences
            .set(
                project_id,
                Some(Uuid::new_v4()),
                Some("shared".to_string()),
                None,
            )
            .await;

        let target = clear_runtime_preference_for_context(
            &preferences,
            &project_id,
            &RequestContext {
                user_id: Some(Uuid::new_v4()),
                is_service_role: false,
                scoped_claims: None,
            },
        )
        .await;

        assert_eq!(target, None);
        assert!(preferences.get(&project_id).await.is_none());
    }

    #[tokio::test]
    async fn service_role_clear_leaves_private_preference_untouched() {
        let preferences = RuntimePreferenceRegistry::new();
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        preferences
            .set(project_id, Some(Uuid::new_v4()), None, None)
            .await;
        preferences
            .set_private(project_id, owner_user_id, Some(Uuid::new_v4()), None, None)
            .await;

        let target = clear_runtime_preference_for_context(
            &preferences,
            &project_id,
            &RequestContext {
                user_id: Some(owner_user_id),
                is_service_role: true,
                scoped_claims: None,
            },
        )
        .await;

        assert_eq!(target, None);
        assert!(preferences.get(&project_id).await.is_none());
        assert!(preferences
            .get_private(&project_id, &owner_user_id)
            .await
            .is_some());
    }

    #[test]
    fn health_respects_terminal_status() {
        let now = Utc::now();
        let health = determine_runtime_health(Some(now), 120, "offline", false);
        assert_eq!(health, "offline");
        let health = determine_runtime_health(Some(now), 120, "error", false);
        assert_eq!(health, "offline");
        let health = determine_runtime_health(Some(now), 120, "stopped", false);
        assert_eq!(health, "offline");
    }

    #[test]
    fn health_marks_online_when_recent() {
        let now = Utc::now();
        let last_seen = now - ChronoDuration::seconds(5);
        let health = determine_runtime_health(Some(last_seen), 120, "ready", false);
        assert_eq!(health, "online");
    }

    #[test]
    fn health_marks_idle_when_not_recent() {
        let last_seen = Utc::now() - ChronoDuration::seconds(200);
        let health = determine_runtime_health(Some(last_seen), 60, "ready", false);
        assert_eq!(health, "idle");
    }

    #[test]
    fn health_marks_offline_when_runtime_has_never_heartbeat() {
        let health = determine_runtime_health(None, 60, "ready", false);
        assert_eq!(health, "offline");
    }

    #[test]
    fn health_falls_offline_after_ttl_expiry() {
        let last_seen = Utc::now() - ChronoDuration::seconds(400);
        let health = determine_runtime_health(Some(last_seen), 20, "ready", false);
        assert_eq!(health, "offline");
    }
}

pub(crate) fn runtime_supports_conversation_state(capabilities: &JsonValue) -> bool {
    fn pointer_is_true(value: &JsonValue, pointer: &str) -> bool {
        matches!(value.pointer(pointer), Some(JsonValue::Bool(true)))
    }

    pointer_is_true(capabilities, "/conversations/stateful")
        || pointer_is_true(capabilities, "/llm/statefulConversation")
        || pointer_is_true(capabilities, "/statefulConversation")
        || pointer_is_true(capabilities, "/conversationStateful")
        || capabilities
            .get("supportsStatefulConversations")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false)
}

pub(crate) fn runtime_supports_agent_and_origin(capabilities: &JsonValue) -> bool {
    fn pointer_is_true(value: &JsonValue, pointer: &str) -> bool {
        matches!(value.pointer(pointer), Some(JsonValue::Bool(true)))
    }
    let agent = pointer_is_true(capabilities, "/agent")
        || pointer_is_true(capabilities, "/runs")
        || pointer_is_true(capabilities, "/llm/agent");
    let origin = pointer_is_true(capabilities, "/origin")
        || pointer_is_true(capabilities, "/fs")
        || pointer_is_true(capabilities, "/workspace");
    agent && origin
}
