use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use runtime_contracts::multi_agent::{
    MultiAgentSettings, DEFAULT_MAX_AGENTS_PER_PLAN, DEFAULT_MAX_CONCURRENT_AGENTS,
    MAX_AGENTS_PER_PLAN, MAX_CONCURRENT_AGENTS,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::projects::{ensure_project_read_access, load_project_record};
use crate::{
    auth::authenticate_request, bad_request, forbidden, internal_error, ApiError, AppState,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/:project_id/multi-agent-settings",
        get(read).patch(update),
    )
}

/// Serialize admission and settings changes across controller processes. Running workers
/// are not canceled when a limit is lowered; new leases wait for capacity to become free.
pub(crate) async fn lock_capacity(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let key = format!("multi-agent-capacity:{project_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&key],
        )
        .await
        .map_err(|e| internal_error(format!("failed to lock team capacity: {e}")))?;
    Ok(())
}

pub(crate) async fn load(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
) -> Result<MultiAgentSettings, (StatusCode, Json<ApiError>)> {
    let row = transaction.query_opt(
        "select max_agents_per_plan, max_concurrent_agents from project_multi_agent_settings where project_id = $1",
        &[project_id],
    ).await.map_err(|e| internal_error(format!("failed to load team settings: {e}")))?;
    let settings = row
        .map(|row| MultiAgentSettings {
            max_agents_per_plan: row.get::<_, i32>("max_agents_per_plan") as u32,
            max_concurrent_agents: row.get::<_, i32>("max_concurrent_agents") as u32,
        })
        .unwrap_or_default();
    settings.validate().map_err(internal_error)
}

/// Hold this lock through lease admission or renewal. An expired worker may
/// rejoin only when it fits the current budget; active leases keep their slot.
pub(crate) async fn worker_slot_available(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    renewing_job_id: Option<&Uuid>,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    lock_capacity(transaction, project_id).await?;
    let settings = load(transaction, project_id).await?;
    let active_workers: i64 = transaction
        .query_one(
            "select count(*) from agent_jobs where project_id = $1 and status = 'leased'
             and lease_expires_at > statement_timestamp()
             and coalesce(agent_role, payload #>> '{metadata,multiAgentPlan,role}') = 'worker'
             and ($2::uuid is null or id <> $2)",
            &[project_id, &renewing_job_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to count active team workers: {error}")))?
        .get(0);
    Ok(active_workers < i64::from(settings.max_concurrent_agents))
}

pub(crate) fn validate_plan_size(
    settings: MultiAgentSettings,
    count: usize,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if count > settings.max_agents_per_plan as usize {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::with_details(
            format!("This plan requests {count} agents, but this space allows {} per plan. Split the work into separate plans or ask a space manager to update its agent settings. No agents were dispatched.", settings.max_agents_per_plan),
            "multi_agent_plan_invalid", json!({"requested":count,"maxAgentsPerPlan":settings.max_agents_per_plan}),
        ))));
    }
    Ok(())
}

fn response(settings: MultiAgentSettings, can_manage: bool) -> Value {
    json!({
        "maxAgentsPerPlan": settings.max_agents_per_plan,
        "maxConcurrentAgents": settings.max_concurrent_agents,
        "canManage": can_manage,
        "limits": {
            "maxAgentsPerPlan": { "min": 1, "max": MAX_AGENTS_PER_PLAN, "default": DEFAULT_MAX_AGENTS_PER_PLAN },
            "maxConcurrentAgents": { "min": 1, "max": MAX_CONCURRENT_AGENTS, "default": DEFAULT_MAX_CONCURRENT_AGENTS }
        }
    })
}

async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("Shared team settings require a signed-in user"));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("failed to get connection: {e}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("failed to start transaction: {e}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    let access = ensure_project_read_access(&transaction, &project, &context, None).await?;
    Ok(Json(response(
        load(&transaction, &project_id).await?,
        access.can_manage,
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPatch {
    #[serde(default, deserialize_with = "present_integer")]
    max_agents_per_plan: Option<u32>,
    #[serde(default, deserialize_with = "present_integer")]
    max_concurrent_agents: Option<u32>,
}

fn present_integer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u32>, D::Error> {
    u32::deserialize(deserializer).map(Some)
}

impl SettingsPatch {
    fn apply(
        self,
        current: MultiAgentSettings,
    ) -> Result<MultiAgentSettings, (StatusCode, Json<ApiError>)> {
        if self.max_agents_per_plan.is_none() && self.max_concurrent_agents.is_none() {
            return Err(bad_request(
                "Provide maxAgentsPerPlan or maxConcurrentAgents",
            ));
        }
        MultiAgentSettings {
            max_agents_per_plan: self
                .max_agents_per_plan
                .unwrap_or(current.max_agents_per_plan),
            max_concurrent_agents: self
                .max_concurrent_agents
                .unwrap_or(current.max_concurrent_agents),
        }
        .validate()
        .map_err(bad_request)
    }
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(patch): Json<SettingsPatch>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Runtime tokens cannot change shared team settings",
        ));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("failed to get connection: {e}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("failed to start transaction: {e}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    let access = ensure_project_read_access(&transaction, &project, &context, None).await?;
    if !access.can_manage {
        return Err(forbidden(
            "Only space managers can change shared team settings",
        ));
    }
    lock_capacity(&transaction, &project_id).await?;
    let settings = patch.apply(load(&transaction, &project_id).await?)?;
    transaction.execute(
        "insert into project_multi_agent_settings (project_id, max_agents_per_plan, max_concurrent_agents, updated_by)
         values ($1, $2, $3, $4) on conflict (project_id) do update set
         max_agents_per_plan = excluded.max_agents_per_plan, max_concurrent_agents = excluded.max_concurrent_agents,
         updated_by = excluded.updated_by, updated_at = now()",
        &[&project_id, &(settings.max_agents_per_plan as i32), &(settings.max_concurrent_agents as i32), &context.user_id],
    ).await.map_err(|e| internal_error(format!("failed to save team settings: {e}")))?;
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(format!("failed to save team settings: {e}")))?;
    Ok(Json(response(settings, true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_patch_preserves_other_limit_and_rejects_invalid_values() {
        let patch: SettingsPatch =
            serde_json::from_value(json!({"maxConcurrentAgents": 2})).unwrap();
        assert_eq!(
            patch.apply(MultiAgentSettings::default()).unwrap(),
            MultiAgentSettings {
                max_agents_per_plan: 64,
                max_concurrent_agents: 2
            }
        );
        for value in [
            json!({}),
            json!({"maxAgentsPerPlan":0}),
            json!({"maxAgentsPerPlan":257}),
            json!({"maxConcurrentAgents":65}),
        ] {
            assert!(serde_json::from_value::<SettingsPatch>(value)
                .unwrap()
                .apply(MultiAgentSettings::default())
                .is_err());
        }
        for value in [
            json!({"maxAgentsPerPlan":null}),
            json!({"maxAgentsPerPlan":1.5}),
            json!({"maxConcurrentAgents":-1}),
            json!({"maxConcurrentAgents":"4"}),
            json!({"other":4}),
        ] {
            assert!(serde_json::from_value::<SettingsPatch>(value).is_err());
        }
    }
}

#[cfg(test)]
mod capacity_tests;
