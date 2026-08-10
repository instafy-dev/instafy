use std::collections::HashSet;
use std::str::FromStr;

use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::Json;
use axum::Router;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::GenericClient;
use uuid::Uuid;

use crate::auth::{authenticate_request, RequestContext};
use crate::conversations::{ensure_conversation_access, load_conversation_record};
use crate::credits::{
    extract_credit_snapshot, extract_provider_conversation_state, extract_provider_from_metadata,
};
use crate::{
    bad_request, ensure_project_access, internal_error, load_project_record, not_found,
    publish_controller_event_with_conversation, resolve_scope, ApiError, AppState, ScopeParams,
};
use anyhow::Context;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunsQuery {
    pub(crate) project_id: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RunResultResponse {
    #[serde(rename = "runId")]
    pub(crate) run_id: Uuid,
    #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct RunSnapshot {
    pub(crate) id: Uuid,
    pub(crate) project_id: Option<Uuid>,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) prompt_id: Option<Uuid>,
    pub(crate) run_type: String,
    pub(crate) status: String,
    pub(crate) progress: Option<f64>,
    pub(crate) progress_stage: Option<String>,
    pub(crate) preview_url: Option<String>,
    pub(crate) last_message: Option<String>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

pub(crate) const RUN_SELECT_BASE: &str = "select id, project_id, session_id, conversation_id, prompt_id, run_type, status, progress, progress_stage, preview_url, last_message, metadata, created_at, updated_at from runs";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/runs", get(list_runs))
        .route("/runs/:run_id/result", get(get_run_result))
}

pub(crate) async fn list_runs(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Query(params): Query<RunsQuery>,
) -> Result<Json<Vec<RunSnapshot>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let scope = resolve_scope(
        &state,
        ScopeParams {
            project_id: params.project_id.clone(),
            session_id: params.session_id.clone(),
            run_id: params.run_id.clone(),
        },
        &context,
    )
    .await?;

    let limit_raw = params.limit.unwrap_or(50);
    let limit = limit_raw.clamp(1, 200);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let mut runs: Vec<RunSnapshot> = Vec::new();

    if let Some(run_id) = scope.run_id {
        let query = format!("{RUN_SELECT_BASE} where id = $1 and project_id = $2");
        let row = transaction
            .query_opt(&query, &[&run_id, &scope.project.id])
            .await
            .map_err(|error| internal_error(format!("failed to load run: {error}")))?;
        if let Some(row) = row {
            let snapshot = map_run_row(&row);
            ensure_run_conversation_access(&transaction, &snapshot, &context).await?;
            runs.push(snapshot);
        }
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to commit run lookup: {error}")))?;
        return Ok(Json(runs));
    }

    // Apply conversation visibility before LIMIT so inaccessible recent runs do
    // not hide older accessible runs. Each returned conversation scope is also
    // reauthorized below to keep this query fail-closed if rules evolve.
    let rows = if context.is_service_role {
        let query = format!(
            "{RUN_SELECT_BASE}
             where project_id = $1
               and ($2::uuid is null or session_id = $2)
             order by created_at desc
             limit $3"
        );
        transaction
            .query(&query, &[&scope.project.id, &scope.session_id, &limit])
            .await
    } else if let Some(user_id) = context.user_id {
        let query = format!(
            "{RUN_SELECT_BASE}
             where runs.project_id = $1
               and ($2::uuid is null or runs.session_id = $2)
               and (
                 runs.conversation_id is null
                 or exists (
                   select 1
                   from conversations access_conversation
                   where access_conversation.id = runs.conversation_id
                     and access_conversation.project_id = runs.project_id
                     and (
                       access_conversation.visibility <> 'private'
                       or access_conversation.created_by = $3
                       or exists (
                         select 1
                         from conversation_participants access_participant
                         where access_participant.conversation_id = access_conversation.id
                           and access_participant.user_id = $3
                       )
                     )
                 )
               )
             order by runs.created_at desc
             limit $4"
        );
        transaction
            .query(
                &query,
                &[&scope.project.id, &scope.session_id, &user_id, &limit],
            )
            .await
    } else {
        let query = format!(
            "{RUN_SELECT_BASE}
             where runs.project_id = $1
               and ($2::uuid is null or runs.session_id = $2)
               and (
                 runs.conversation_id is null
                 or exists (
                   select 1
                   from conversations access_conversation
                   where access_conversation.id = runs.conversation_id
                     and access_conversation.project_id = runs.project_id
                     and access_conversation.visibility <> 'private'
                 )
               )
             order by runs.created_at desc
             limit $3"
        );
        transaction
            .query(&query, &[&scope.project.id, &scope.session_id, &limit])
            .await
    }
    .map_err(|error| internal_error(format!("failed to list runs: {error}")))?;

    let mut authorized_conversation_ids = HashSet::new();
    for row in rows {
        let snapshot = map_run_row(&row);
        if snapshot
            .conversation_id
            .map(|conversation_id| authorized_conversation_ids.insert(conversation_id))
            .unwrap_or(false)
        {
            ensure_run_conversation_access(&transaction, &snapshot, &context).await?;
        }
        runs.push(snapshot);
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit runs query: {error}")))?;

    Ok(Json(runs))
}

pub(crate) async fn get_run_result(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(run_id_raw): axum::extract::Path<String>,
) -> Result<Json<RunResultResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let run_id =
        Uuid::from_str(run_id_raw.trim()).map_err(|_| bad_request("runId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let mut transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let snapshot = load_run_snapshot(&mut transaction, &run_id)
        .await?
        .ok_or_else(|| not_found("run not found"))?;

    let project_id = snapshot
        .project_id
        .ok_or_else(|| internal_error("run is missing project_id; cannot authorize access"))?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, snapshot.session_id).await?;
    ensure_run_conversation_access(&transaction, &snapshot, &context).await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit run lookup: {error}")))?;

    let mut status = "pending".to_string();
    let mut result_payload = None;

    match rebuild_run_result_from_db(&mut connection, &run_id, &snapshot).await {
        Ok(Some(payload)) => {
            tracing::info!(run_id = %run_id, "rebuilt run result payload from database");
            status = "ready".to_string();
            result_payload = Some(payload);
        }
        Ok(None) => {
            tracing::info!(run_id = %run_id, "no persisted agent job found while rebuilding run result");
        }
        Err(error) => {
            tracing::warn!(?error, run_id = %run_id, "failed to rebuild run result from database");
            status = "error".to_string();
        }
    }

    Ok(Json(RunResultResponse {
        run_id,
        conversation_id: snapshot.conversation_id,
        status,
        result: result_payload,
    }))
}

async fn ensure_run_conversation_access(
    transaction: &tokio_postgres::Transaction<'_>,
    snapshot: &RunSnapshot,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(conversation_id) = snapshot.conversation_id else {
        return Ok(());
    };

    let conversation = load_conversation_record(transaction, &conversation_id).await?;
    if snapshot.project_id != Some(conversation.project_id) {
        return Err(internal_error(
            "run conversation does not belong to the run project",
        ));
    }

    ensure_conversation_access(transaction, &conversation, context).await
}

pub(crate) fn map_run_row(row: &tokio_postgres::Row) -> RunSnapshot {
    let progress: Option<f64> = row.get("progress");
    let metadata: Option<JsonValue> = row.get("metadata");

    RunSnapshot {
        id: row.get("id"),
        project_id: row.get("project_id"),
        session_id: row.get("session_id"),
        conversation_id: row.get("conversation_id"),
        prompt_id: row.get("prompt_id"),
        run_type: row.get("run_type"),
        status: row.get("status"),
        progress,
        progress_stage: row.get("progress_stage"),
        preview_url: row.get("preview_url"),
        last_message: row.get("last_message"),
        metadata,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

pub(crate) fn run_snapshot_to_json(snapshot: &RunSnapshot) -> JsonValue {
    match serde_json::to_value(snapshot) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(?error, "failed to serialize run snapshot");
            JsonValue::Null
        }
    }
}

pub(crate) async fn load_run_snapshot<C>(
    client: &mut C,
    run_id: &Uuid,
) -> Result<Option<RunSnapshot>, (StatusCode, Json<ApiError>)>
where
    C: GenericClient + Send,
{
    let query = format!("{RUN_SELECT_BASE} where id = $1");
    let row = client
        .query_opt(&query, &[run_id])
        .await
        .map_err(|error| internal_error(format!("failed to load run snapshot: {error}")))?;

    let Some(row) = row else {
        return Ok(None);
    };

    let snapshot = map_run_row(&row);

    Ok(Some(snapshot))
}

pub(crate) async fn rebuild_run_result_from_db(
    client: &mut tokio_postgres::Client,
    run_id: &Uuid,
    snapshot: &RunSnapshot,
) -> anyhow::Result<Option<JsonValue>> {
    let row = client
        .query_opt(
            "select id,
                    project_id,
                    session_id,
                    conversation_id,
                    prompt_id,
                    summary,
                    error_message,
                    outcome,
                    status,
                    artifacts,
                    proxy_metadata
             from agent_jobs
             where run_id = $1
             order by completed_at desc nulls last, updated_at desc
             limit 1",
            &[run_id],
        )
        .await
        .context("failed to load agent job for run result")?;

    let Some(row) = row else {
        return Ok(None);
    };

    let job_id: Uuid = row.get("id");
    let job_project_id: Uuid = row.get("project_id");
    let session_id: Option<Uuid> = row.get("session_id");
    let conversation_id: Option<Uuid> = row.get("conversation_id");
    let prompt_id: Option<Uuid> = row.get("prompt_id");
    let summary: Option<String> = row.get("summary");
    let error_message: Option<String> = row.get("error_message");
    let outcome_column: Option<String> = row.get("outcome");
    let status: String = row.get("status");
    let artifacts_json: Option<PgJson<JsonValue>> = row.get("artifacts");
    let proxy_metadata_json: Option<PgJson<JsonValue>> = row.get("proxy_metadata");

    let artifacts_value = artifacts_json
        .map(|json| json.0)
        .unwrap_or_else(|| JsonValue::Array(Vec::new()));

    let proxy_metadata = proxy_metadata_json.map(|json| json.0);
    let provider_value = extract_provider_from_metadata(&proxy_metadata);
    let conversation_state = extract_provider_conversation_state(&proxy_metadata);
    let credit_snapshot_value = extract_credit_snapshot(&proxy_metadata);

    let project_id = snapshot.project_id.unwrap_or(job_project_id);
    let resolved_conversation = conversation_id.or(snapshot.conversation_id);
    let resolved_session = session_id.or(snapshot.session_id);
    let resolved_prompt = prompt_id.or(snapshot.prompt_id);

    let outcome_value = outcome_column
        .as_deref()
        .map(|value| value.to_string())
        .unwrap_or_else(|| status.clone());
    let run_status = status.clone();
    let final_status = status;

    let payload = crate::dispatch::build_run_result_payload(
        &job_id,
        run_id,
        &project_id,
        resolved_conversation,
        resolved_session,
        resolved_prompt,
        summary.as_ref(),
        error_message.as_ref(),
        &outcome_value,
        &run_status,
        &final_status,
        provider_value.as_deref(),
        conversation_state.as_ref(),
        &artifacts_value,
        credit_snapshot_value.as_ref(),
    );

    Ok(Some(payload))
}

#[allow(dead_code)]
pub(crate) async fn update_run_status_after_dispatch(
    state: &AppState,
    run_id: &Uuid,
    status: &str,
    stage: Option<&str>,
    message: Option<&str>,
    workflow_url: Option<&str>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let stage_param = stage.map(|value| value.to_string());
    let message_param = message.map(|value| value.to_string());

    connection
        .execute(
            "update runs
             set status = $2,
                 progress = case when $2 = 'failed' then progress else greatest(progress, 5) end,
                 progress_stage = $3,
                 last_message = $4,
                 updated_at = now()
             where id = $1",
            &[run_id, &status, &stage_param, &message_param],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update run status: {error}")))?;

    if let Some(url) = workflow_url {
        connection
            .execute(
                "update runs
                 set metadata = jsonb_set(
                     coalesce(metadata, '{}'::jsonb),
                     '{workflow_url}',
                     to_jsonb($2::text),
                     true
                 )
                 where id = $1",
                &[run_id, &url],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update run metadata: {error}")))?;
    }

    let (project_id, session_id, conversation_id, run_payload) = {
        let client = &mut *connection;
        match load_run_snapshot(client, run_id).await {
            Ok(Some(snapshot)) => (
                snapshot.project_id,
                snapshot.session_id,
                snapshot.conversation_id,
                run_snapshot_to_json(&snapshot),
            ),
            Ok(None) => {
                tracing::warn!(run_id = %run_id, "run snapshot missing after status update");
                (None, None, None, JsonValue::Null)
            }
            Err((status_code, Json(api_error))) => {
                tracing::warn!(
                    run_id = %run_id,
                    status = status_code.as_u16(),
                    error = %api_error.message,
                    "failed to load run snapshot after status update"
                );
                (None, None, None, JsonValue::Null)
            }
        }
    };

    publish_controller_event_with_conversation(
        &state.events,
        "run.progress",
        project_id,
        session_id,
        conversation_id,
        Some(*run_id),
        None,
        json!({
            "status": status,
            "stage": stage,
            "message": message,
            "workflowUrl": workflow_url,
            "run": run_payload,
        }),
    );
    Ok(())
}
