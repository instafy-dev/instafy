use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::{Row, Transaction};
use tracing::{error, info};
use uuid::Uuid;

use crate::{internal_error, not_found, ApiError};

use super::lease::RuntimeLeaseScope;

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct RuntimeRecord {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) provider: String,
    pub(crate) status: String,
    pub(crate) idle_ttl_seconds: i32,
    pub(crate) capabilities: JsonValue,
    pub(crate) display_name: Option<String>,
    pub(crate) active_lease_id: Option<Uuid>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct RuntimeDetails {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) provider: String,
    pub(crate) capabilities: JsonValue,
    pub(crate) status: String,
    pub(crate) idle_ttl_seconds: i32,
    pub(crate) last_seen_at: Option<DateTime<Utc>>,
    pub(crate) endpoint_url: Option<String>,
    pub(crate) task_ref: Option<String>,
    pub(crate) display_name: Option<String>,
    pub(crate) active_lease_id: Option<Uuid>,
}

#[derive(Debug)]
pub(crate) struct RuntimeLeaseRecord {
    pub(crate) id: Uuid,
    #[allow(dead_code)]
    pub(crate) status: String,
    #[allow(dead_code)]
    pub(crate) scope: RuntimeLeaseScope,
}

#[derive(Debug)]
pub(crate) struct RuntimeLeaseDetails {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) runtime_id: Option<Uuid>,
    pub(crate) status: String,
    pub(crate) scope: RuntimeLeaseScope,
    pub(crate) parent_lease_id: Option<Uuid>,
    pub(crate) released_at: Option<DateTime<Utc>>,
    pub(crate) metadata: Option<JsonValue>,
}

#[derive(Debug, Clone)]
pub(super) struct OriginInstanceRecord {
    pub(super) id: Uuid,
    pub(super) lease_id: Option<Uuid>,
    pub(super) origin_id: Option<Uuid>,
    pub(super) mode: Option<String>,
    pub(super) status: String,
    pub(super) endpoint: Option<String>,
    pub(super) protocols: Vec<String>,
    pub(super) metadata: Option<JsonValue>,
}

pub(super) fn map_runtime_row(row: &Row) -> Result<RuntimeRecord, (StatusCode, Json<ApiError>)> {
    Ok(RuntimeRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider: row.get("provider"),
        status: row.get("status"),
        idle_ttl_seconds: row.get("idle_ttl_seconds"),
        capabilities: row.get("capabilities"),
        display_name: row.get("display_name"),
        active_lease_id: row.get("active_lease_id"),
    })
}

pub(super) fn runtime_provider_identity_matches(stored: &str, requested: &str) -> bool {
    crate::provider_identifiers::provider_id_key(stored)
        == crate::provider_identifiers::provider_id_key(requested)
}

pub(super) async fn ensure_project_exists(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    auto_create_projects: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let existing = transaction
        .query_opt("select 1 from projects where id = $1", &[project_id])
        .await
        .map_err(|error| internal_error(format!("failed to load project: {error}")))?;

    if existing.is_some() {
        return Ok(());
    }

    if !auto_create_projects {
        return Err(not_found("project not found"));
    }

    transaction
        .execute(
            "insert into projects (id, project_type, status) values ($1, 'sandbox', 'active') on conflict (id) do nothing",
            &[project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to auto-create project: {error}")))?;

    info!(project_id = %project_id, "auto-created project for runtime request");
    Ok(())
}

pub(crate) async fn ensure_runtime_record(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: Option<Uuid>,
    provider: &str,
    idle_ttl_seconds: u32,
    display_name: Option<&str>,
    metadata: Option<JsonValue>,
    update_idle_ttl_seconds: bool,
) -> Result<RuntimeRecord, (StatusCode, Json<ApiError>)> {
    if let Some(id) = runtime_id {
        if let Some(row) = transaction
            .query_opt(
                "select id, project_id, provider, status, idle_ttl_seconds, capabilities, display_name, active_lease_id, last_seen_at, endpoint_url from runtimes where project_id = $1 and id = $2",
                &[project_id, &id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load runtime: {error}")))? {
            let endpoint_url: Option<String> = row.get("endpoint_url");
            let last_seen_at: Option<DateTime<Utc>> = row.get("last_seen_at");
            let runtime = map_runtime_row(&row)?;
            if !runtime_provider_identity_matches(&runtime.provider, provider) {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "runtime provider identity does not match the requested provider",
                    )),
                ));
            }
            let reset_status = runtime.active_lease_id.is_none()
                && (matches!(runtime.status.as_str(), "offline" | "stopped")
                    || !crate::workspace::runtime_is_recent(
                        last_seen_at,
                        runtime.idle_ttl_seconds,
                        crate::workspace::endpoint_matches_local(endpoint_url.as_deref()),
                    ));
            let updated = transaction
                .query_one(
                    "update runtimes
                     set idle_ttl_seconds = case when $5 then $2 else idle_ttl_seconds end,
                         display_name = coalesce($3, display_name),
                         status = case when $4 then 'requested' else status end,
                         last_seen_at = case when $4 then null else last_seen_at end,
                         endpoint_url = case when $4 then null else endpoint_url end,
                         task_ref = case when $4 then null else task_ref end,
                         -- An active generation is only cleared by the fenced
                         -- stop path after the exact provider allocation has
                         -- acknowledged release. Ensure may reset presentation
                         -- state, but it must never orphan the old generation.
                         active_lease_id = active_lease_id,
                         updated_at = now()
                     where id = $1
                     returning id, project_id, provider, status, idle_ttl_seconds, capabilities, display_name, active_lease_id",
                    &[
                        &runtime.id,
                        &(idle_ttl_seconds as i32),
                        &display_name,
                        &reset_status,
                        &update_idle_ttl_seconds,
                    ],
                )
                .await
                .map_err(|error| internal_error(format!("failed to update runtime record: {error}")))?;
            return map_runtime_row(&updated);
        }

        let inserted = transaction
            .query_one(
            "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds, display_name) values ($1, $2, $3, 'requested', $4, $5) returning id, project_id, provider, status, idle_ttl_seconds, capabilities, display_name, active_lease_id",
            &[&id, project_id, &provider, &(idle_ttl_seconds as i32), &display_name],
            )
            .await
            .map_err(|error| internal_error(format!("failed to insert runtime: {error}")))?;

        let runtime = map_runtime_row(&inserted)?;

        record_runtime_event(
            transaction,
            &runtime.id,
            project_id,
            "requested",
            metadata.unwrap_or_else(|| json!({})),
        )
        .await?;

        return Ok(runtime);
    }

    if let Some(row) = transaction
        .query_opt(
            "select id, project_id, provider, status, idle_ttl_seconds, capabilities, display_name, active_lease_id, last_seen_at, endpoint_url
             from runtimes
             where project_id = $1
               and provider = $2
               and ($3::text is null or display_name = $3)
             order by
               case
                 when status in ('ready', 'running') then 0
                 when status = 'requested' then 1
                 else 2
               end,
               updated_at desc
             limit 1",
            &[project_id, &provider, &display_name],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load runtime: {error}")))?
    {
        let endpoint_url: Option<String> = row.get("endpoint_url");
        let last_seen_at: Option<DateTime<Utc>> = row.get("last_seen_at");
        let runtime = map_runtime_row(&row)?;
        let reset_status = runtime.active_lease_id.is_none()
            && (matches!(runtime.status.as_str(), "offline" | "stopped")
                || !crate::workspace::runtime_is_recent(
                    last_seen_at,
                    runtime.idle_ttl_seconds,
                    crate::workspace::endpoint_matches_local(endpoint_url.as_deref()),
                ));
        let updated = transaction
            .query_one(
                "update runtimes
                 set idle_ttl_seconds = case when $5 then $2 else idle_ttl_seconds end,
                     display_name = coalesce($3, display_name),
                     status = case when $4 then 'requested' else status end,
                     last_seen_at = case when $4 then null else last_seen_at end,
                     endpoint_url = case when $4 then null else endpoint_url end,
                     task_ref = case when $4 then null else task_ref end,
                     -- See the explicit-id path above: provider cleanup owns
                     -- generation release, never this record-refresh helper.
                     active_lease_id = active_lease_id,
                     updated_at = now()
                 where id = $1
                 returning id, project_id, provider, status, idle_ttl_seconds, capabilities, display_name, active_lease_id",
                &[
                    &runtime.id,
                    &(idle_ttl_seconds as i32),
                    &display_name,
                    &reset_status,
                    &update_idle_ttl_seconds,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update runtime record: {error}")))?;
        return map_runtime_row(&updated);
    }

    let inserted = transaction
        .query_one(
            "insert into runtimes (project_id, provider, status, idle_ttl_seconds, display_name) values ($1, $2, 'requested', $3, $4) returning id, project_id, provider, status, idle_ttl_seconds, capabilities, display_name, active_lease_id",
            &[project_id, &provider, &(idle_ttl_seconds as i32), &display_name],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert runtime: {error}")))?;

    let runtime = map_runtime_row(&inserted)?;

    record_runtime_event(
        transaction,
        &runtime.id,
        project_id,
        "requested",
        metadata.unwrap_or_else(|| json!({})),
    )
    .await?;

    Ok(runtime)
}

#[cfg(test)]
mod tests {
    use super::runtime_provider_identity_matches;

    #[test]
    fn explicit_runtime_id_cannot_cross_provider_identity() {
        assert!(runtime_provider_identity_matches(
            "instafy-cloud",
            "Instafy_Cloud"
        ));
        assert!(!runtime_provider_identity_matches(
            "runtime",
            "instafy-cloud"
        ));
    }
}

pub(crate) async fn create_runtime_lease(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    scope: RuntimeLeaseScope,
    parent_lease_id: Option<&Uuid>,
    metadata: Option<JsonValue>,
    link_runtime: bool,
) -> Result<RuntimeLeaseRecord, (StatusCode, Json<ApiError>)> {
    let metadata_value = metadata.unwrap_or(JsonValue::Null);
    let row = transaction
        .query_one(
            "insert into runtime_leases (project_id, runtime_id, scope, parent_lease_id, metadata) values ($1, $2, $3, $4, $5::jsonb) returning id, status, scope",
            &[project_id, runtime_id, &scope.as_str(), &parent_lease_id, &metadata_value],
        )
        .await
        .map_err(|error| {
            let summary = error
                .as_db_error()
                .map(|db_error| {
                    format!(
                        "postgres {}: {}",
                        db_error.code().code(),
                        db_error.message()
                    )
                })
                .unwrap_or_else(|| error.to_string());
            internal_error(format!("failed to create runtime lease: {summary}"))
        })?;

    let lease_id: Uuid = row.get("id");
    if link_runtime {
        transaction
            .execute(
                "update runtimes set active_lease_id = $2, updated_at = now() where id = $1",
                &[runtime_id, &lease_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to link runtime lease: {error}")))?;
    }

    let scope_value: String = row.get("scope");
    let lease_scope = RuntimeLeaseScope::from_db(&scope_value)?;

    Ok(RuntimeLeaseRecord {
        id: lease_id,
        status: row.get("status"),
        scope: lease_scope,
    })
}

pub(crate) async fn fetch_runtime_lease_for_update(
    transaction: &Transaction<'_>,
    lease_id: &Uuid,
) -> Result<RuntimeLeaseDetails, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id, project_id, runtime_id, status, scope, parent_lease_id, released_at, metadata
             from runtime_leases
             where id = $1
             for update",
            &[lease_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load runtime lease: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("runtime lease not found"));
    };

    Ok(RuntimeLeaseDetails {
        id: row.get("id"),
        project_id: row.get("project_id"),
        runtime_id: row.get("runtime_id"),
        status: row.get("status"),
        scope: RuntimeLeaseScope::from_db(row.get::<_, &str>("scope"))?,
        parent_lease_id: row.get("parent_lease_id"),
        released_at: row.get("released_at"),
        metadata: row.get("metadata"),
    })
}

pub(crate) async fn mark_runtime_lease_launching(
    transaction: &Transaction<'_>,
    lease_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let rows = transaction
        .execute(
            "update runtime_leases
             set status = 'launching',
                 updated_at = now()
             where id = $1",
            &[lease_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to mark runtime lease launching: {error}"))
        })?;

    if rows == 0 {
        return Err(not_found("runtime lease not found"));
    }

    Ok(())
}

pub(crate) async fn mark_runtime_lease_active(
    transaction: &Transaction<'_>,
    lease_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let rows = transaction
        .execute(
            "update runtime_leases
             set status = 'active',
                 launched_at = coalesce(launched_at, now()),
                 released_at = null,
                 updated_at = now()
             where id = $1",
            &[lease_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to mark runtime lease active: {error}")))?;

    if rows == 0 {
        return Err(not_found("runtime lease not found"));
    }

    Ok(())
}

fn map_origin_instance_row(row: &Row) -> OriginInstanceRecord {
    let protocols: Option<Vec<String>> = row.get("protocols");
    let metadata: Option<JsonValue> = row.get("metadata");
    let mode: Option<String> = row.get("mode");
    OriginInstanceRecord {
        id: row.get("id"),
        lease_id: row.get::<_, Option<Uuid>>("lease_id"),
        origin_id: row.get::<_, Option<Uuid>>("origin_id"),
        mode,
        status: row.get("status"),
        endpoint: row.get("endpoint"),
        protocols: protocols.unwrap_or_default(),
        metadata,
    }
}

pub(super) async fn upsert_origin_instance(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: &Uuid,
    mode: Option<String>,
    protocols: Vec<String>,
    metadata: Option<JsonValue>,
) -> Result<OriginInstanceRecord, (StatusCode, Json<ApiError>)> {
    let metadata_value = metadata.unwrap_or(JsonValue::Null);
    let mode_ref = mode.as_deref();
    let row = match transaction
        .query_one(
            "insert into origin_instances (project_id, runtime_id, lease_id, required, mode, protocols, metadata, status)
             values ($1, $2, $3, true, $4, $5::text[], $6::jsonb, 'requested')
             on conflict on constraint origin_instances_lease_unique
             do update set required = true,
                           origin_id = case
                             when origin_instances.status = 'released' then null
                             else origin_instances.origin_id
                           end,
                           mode = excluded.mode,
                           protocols = excluded.protocols,
                           metadata = excluded.metadata,
                           -- Preserve a healthy origin when nothing changed. Resetting the status to
                           -- 'requested' on every ensure causes the frontend to think the runtime is
                           -- reconnecting (\"Connecting to runtime...\") and can stall queued runs until a
                           -- new origin registration happens, even though the existing tunnel is still
                           -- usable. Only request a new origin when the current one isn't online or the
                           -- tunnel config changed.
                           status = case
                             when origin_instances.status = 'online'
                               and origin_instances.origin_id is not null
                               and origin_instances.endpoint is not null
                               and origin_instances.mode is not distinct from excluded.mode
                               and origin_instances.protocols is not distinct from excluded.protocols
                             then origin_instances.status
                             else 'requested'
                           end,
                           updated_at = now()
             returning id, project_id, runtime_id, lease_id, origin_id, required, mode, status, endpoint, protocols, metadata, updated_at",
            &[
                project_id,
                runtime_id,
                lease_id,
                &mode_ref,
                &protocols,
                &metadata_value,
            ],
        )
        .await
    {
        Ok(row) => row,
        Err(error) => {
            let pg_code = error
                .as_db_error()
                .map(|db_error| db_error.code().code().to_string());
            let pg_message = error
                .as_db_error()
                .map(|db_error| db_error.message().to_string());
            let pg_detail = error
                .as_db_error()
                .and_then(|db_error| db_error.detail().map(|detail| detail.to_string()));
            error!(
                project_id = %project_id,
                runtime_id = %runtime_id,
                lease_id = %lease_id,
                required = true,
                mode = ?mode_ref,
                protocols = ?protocols,
                metadata = ?metadata_value,
                error = %error,
                pg_code = ?pg_code,
                pg_message = ?pg_message,
                pg_detail = ?pg_detail,
                "failed to upsert origin instance"
            );
            return Err(internal_error(format!(
                "failed to upsert origin instance: {error}"
            )));
        }
    };

    Ok(map_origin_instance_row(&row))
}

pub(crate) async fn release_origin_instances_for_runtime(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "update origin_instances
             set status = 'released',
                 required = false,
                 endpoint = null,
                 updated_at = now()
             where runtime_id = $1",
            &[runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to release runtime origin instances: {error}"
            ))
        })?;
    Ok(())
}

pub(crate) async fn mark_runtime_lease_released(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
    lease_id: &Uuid,
    allow_cleanup_pending: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let updated = transaction
        .execute(
            "update runtime_leases
             set status = 'released', released_at = now(), updated_at = now()
             where id = $1
               and runtime_id = $3
               and released_at is null
               and status <> 'released'
               and ($2::boolean or status <> 'cleanup_pending')",
            &[lease_id, &allow_cleanup_pending, runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to mark runtime lease released: {error}"))
        })?;
    if updated != 1 {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "runtime provider cleanup is still pending; retry after release acknowledgement",
            )),
        ));
    }

    let cleared = transaction
        .execute(
            "update runtimes
             set active_lease_id = null, updated_at = now()
             where id = $1 and active_lease_id = $2",
            &[runtime_id, lease_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to clear runtime active lease: {error}"))
        })?;
    if cleared != 1 {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "runtime lease generation is no longer current",
            )),
        ));
    }

    Ok(())
}

pub(crate) async fn mark_runtime_ready(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
    idle_ttl_seconds: u32,
) -> Result<RuntimeRecord, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_one(
            "update runtimes
             set status = 'ready',
                 idle_ttl_seconds = $2,
                 last_seen_at = now(),
                 updated_at = now()
             where id = $1
             returning id, project_id, provider, status, idle_ttl_seconds, capabilities, display_name, active_lease_id",
            &[runtime_id, &(idle_ttl_seconds as i32)],
        )
        .await
        .map_err(|error| internal_error(format!("failed to mark runtime ready: {error}")))?;

    map_runtime_row(&row)
}

pub(crate) async fn touch_runtime_last_seen(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "update runtimes
             set last_seen_at = now(),
                 updated_at = now()
             where id = $1
               and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')",
            &[runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to touch runtime last_seen_at: {error}"))
        })?;

    Ok(())
}

pub(crate) async fn fetch_runtime_for_update(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
) -> Result<RuntimeDetails, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id, project_id, provider, capabilities, status, idle_ttl_seconds, last_seen_at, endpoint_url, task_ref, display_name, active_lease_id \
             from runtimes where id = $1 for update",
            &[runtime_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load runtime: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("runtime not found"));
    };

    Ok(RuntimeDetails {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider: row.get("provider"),
        capabilities: row.get("capabilities"),
        status: row.get("status"),
        idle_ttl_seconds: row.get("idle_ttl_seconds"),
        last_seen_at: row.get("last_seen_at"),
        endpoint_url: row.get("endpoint_url"),
        task_ref: row.get("task_ref"),
        display_name: row.get("display_name"),
        active_lease_id: row.get("active_lease_id"),
    })
}

pub(crate) async fn record_runtime_event(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
    project_id: &Uuid,
    kind: &str,
    data: JsonValue,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let data = sanitize_runtime_event_data(kind, data);
    transaction
        .execute(
            "insert into runtime_events (runtime_id, project_id, kind, data) values ($1, $2, $3, $4::jsonb)",
            &[runtime_id, project_id, &kind, &data],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record runtime event: {error}")))?;
    Ok(())
}

pub(crate) async fn record_runtime_event_with_conversation(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
    project_id: &Uuid,
    conversation_id: Option<&Uuid>,
    kind: &str,
    data: JsonValue,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let data = sanitize_runtime_event_data(kind, data);
    let inserted = transaction
        .execute(
            "insert into runtime_events (runtime_id, project_id, conversation_id, kind, data)
             select $1, $2, $3, $4, $5::jsonb
             where $3::uuid is null
                or exists (
                  select 1 from conversations
                  where id = $3 and project_id = $2
                )",
            &[runtime_id, project_id, &conversation_id, &kind, &data],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record runtime event: {error}")))?;
    if inserted != 1 {
        return Err(internal_error(
            "runtime event conversation does not belong to the event project",
        ));
    }
    Ok(())
}

fn copy_runtime_event_fields(data: &JsonValue, allowed: &[&str]) -> JsonMap<String, JsonValue> {
    let Some(source) = data.as_object() else {
        return JsonMap::new();
    };
    allowed
        .iter()
        .filter_map(|key| {
            source
                .get(*key)
                .filter(|value| !value.is_null())
                .map(|value| ((*key).to_string(), value.clone()))
        })
        .collect()
}

fn insert_runtime_event_array_count(
    target: &mut JsonMap<String, JsonValue>,
    source: &JsonValue,
    source_key: &str,
    target_key: &str,
) {
    if let Some(count) = source
        .get(source_key)
        .and_then(JsonValue::as_array)
        .map(Vec::len)
        .filter(|count| *count > 0)
    {
        target.insert(target_key.to_string(), json!(count));
    }
}

/// Runtime events are exposed to project members through the controller logs
/// endpoint. Keep this telemetry deliberately narrower than the source payloads:
/// conversation content and arbitrary runtime metadata belong in their
/// access-controlled source tables, not in a project-wide event mirror.
pub(crate) fn sanitize_runtime_event_data(kind: &str, data: JsonValue) -> JsonValue {
    let mut sanitized = match kind {
        "agent.complete" => copy_runtime_event_fields(
            &data,
            &["job_id", "run_id", "outcome", "artifacts_count", "provider"],
        ),
        "requested" => copy_runtime_event_fields(
            &data,
            &[
                "source",
                "execution_mode",
                "priority",
                "requested_preview",
                "repo_owner",
                "repo_name",
                "sizeId",
            ],
        ),
        "registered" => copy_runtime_event_fields(
            &data,
            &[
                "version",
                "display_name",
                "lease_id",
                "lease_scope",
                "requested_lease_scope",
            ],
        ),
        "login" => copy_runtime_event_fields(
            &data,
            &[
                "provider",
                "idle_ttl_seconds",
                "strict_mode",
                "dev_isolation_mode",
                "display_name",
            ],
        ),
        "stopped" => copy_runtime_event_fields(
            &data,
            &[
                "status",
                "provider",
                "reason",
                "source",
                "last_seen_at",
                "idle_duration_seconds",
                "idle_ttl_seconds",
                "runtimeLeaseId",
                "personal_browser_error",
                "shared_browser_error",
            ],
        ),
        // This acknowledgement fences provider-managed cleanup to the exact
        // opaque runtime lease generation. It contains no conversation or
        // user content, and retaining the lease ID keeps lifecycle retries
        // auditable without exposing the provider response body.
        "provider_release_acknowledged" => {
            copy_runtime_event_fields(&data, &["provider", "runtimeLeaseId"])
        }
        "personal_browser_disconnected" | "shared_browser_disconnected" => {
            copy_runtime_event_fields(&data, &["transport", "error"])
        }
        "dispatch_reconnect_released_stale_lease" => {
            copy_runtime_event_fields(&data, &["source", "leaseId", "runtimeStatus", "lastSeenAt"])
        }
        // Tenant metadata can describe another project. The event kind itself
        // is sufficient for project-level diagnostics.
        "shared_tenant_linked" => JsonMap::new(),
        // Fail closed for future event kinds until their viewer-safe contract
        // is explicitly reviewed here.
        _ => JsonMap::new(),
    };

    if kind == "stopped" {
        insert_runtime_event_array_count(
            &mut sanitized,
            &data,
            "requeued_jobs",
            "requeued_job_count",
        );
        insert_runtime_event_array_count(
            &mut sanitized,
            &data,
            "failed_personal_browser_jobs",
            "failed_personal_browser_job_count",
        );
        insert_runtime_event_array_count(
            &mut sanitized,
            &data,
            "failed_shared_browser_jobs",
            "failed_shared_browser_job_count",
        );
    } else if matches!(
        kind,
        "personal_browser_disconnected" | "shared_browser_disconnected"
    ) {
        insert_runtime_event_array_count(&mut sanitized, &data, "job_ids", "job_count");
        insert_runtime_event_array_count(&mut sanitized, &data, "run_ids", "run_count");
    }

    JsonValue::Object(sanitized)
}

#[cfg(test)]
mod runtime_event_tests {
    use super::sanitize_runtime_event_data;
    use serde_json::json;

    #[test]
    fn agent_complete_runtime_event_drops_conversation_content() {
        let sanitized = sanitize_runtime_event_data(
            "agent.complete",
            json!({
                "job_id": "job-safe",
                "run_id": "run-safe",
                "outcome": "succeeded",
                "summary": "private assistant answer",
                "proxy_metadata": { "providerConversation": "secret" },
                "creditSnapshot": { "balance": 42 },
                "artifacts_count": 2,
                "provider": "openai"
            }),
        );

        assert_eq!(sanitized["job_id"], "job-safe");
        assert_eq!(sanitized["run_id"], "run-safe");
        assert!(sanitized.get("summary").is_none());
        assert!(sanitized.get("proxy_metadata").is_none());
        assert!(sanitized.get("creditSnapshot").is_none());
    }

    #[test]
    fn runtime_event_metadata_is_allowlisted_and_private_ids_become_counts() {
        let requested = sanitize_runtime_event_data(
            "requested",
            json!({
                "source": "dispatch",
                "execution_mode": "agent",
                "conversation_id": "private-conversation",
                "run_id": "private-run",
                "session_id": "private-session",
                "env": { "API_TOKEN": "secret" }
            }),
        );
        assert_eq!(requested["source"], "dispatch");
        assert_eq!(requested["execution_mode"], "agent");
        assert!(requested.get("conversation_id").is_none());
        assert!(requested.get("run_id").is_none());
        assert!(requested.get("session_id").is_none());
        assert!(requested.get("env").is_none());

        let stopped = sanitize_runtime_event_data(
            "stopped",
            json!({
                "reason": "offline",
                "requeued_jobs": ["private-job-a", "private-job-b"],
                "failed_personal_browser_jobs": ["private-job-c"],
                "failed_shared_browser_jobs": ["private-job-d", "private-job-e"]
            }),
        );
        assert_eq!(stopped["reason"], "offline");
        assert_eq!(stopped["requeued_job_count"], 2);
        assert_eq!(stopped["failed_personal_browser_job_count"], 1);
        assert_eq!(stopped["failed_shared_browser_job_count"], 2);
        assert!(stopped.get("requeued_jobs").is_none());
        assert!(stopped.get("failed_personal_browser_jobs").is_none());
        assert!(stopped.get("failed_shared_browser_jobs").is_none());

        let shared_disconnected = sanitize_runtime_event_data(
            "shared_browser_disconnected",
            json!({
                "transport": "shared",
                "error": "safe browser disconnect",
                "job_ids": ["private-job-a", "private-job-b"],
                "run_ids": ["private-run-a"],
                "prompt": "private prompt"
            }),
        );
        assert_eq!(shared_disconnected["transport"], "shared");
        assert_eq!(shared_disconnected["error"], "safe browser disconnect");
        assert_eq!(shared_disconnected["job_count"], 2);
        assert_eq!(shared_disconnected["run_count"], 1);
        assert!(shared_disconnected.get("job_ids").is_none());
        assert!(shared_disconnected.get("run_ids").is_none());
        assert!(shared_disconnected.get("prompt").is_none());

        let provider_acknowledgement = sanitize_runtime_event_data(
            "provider_release_acknowledged",
            json!({
                "provider": "instafy-cloud",
                "runtimeLeaseId": "lease-safe",
                "responseBody": "private provider detail"
            }),
        );
        assert_eq!(provider_acknowledgement["provider"], "instafy-cloud");
        assert_eq!(provider_acknowledgement["runtimeLeaseId"], "lease-safe");
        assert!(provider_acknowledgement.get("responseBody").is_none());
    }
}
