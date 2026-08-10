use std::str::FromStr;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::active_job_auth::{
    authorize_active_job_if_scoped, ActiveJobAuthorization, ActiveJobProjectAccess,
};
use crate::auth::{authenticate_request, require_user_session};
use crate::projects::{ensure_project_access, ensure_project_write_access, load_project_record};
use crate::{bad_request, forbidden, internal_error, not_found, ApiError, AppState};

const MAX_HANDLE_LEN: usize = 20;
const MAX_DESCRIPTION_LEN: usize = 800;
const MAX_MODEL_LEN: usize = 120;

const PROVIDER_OPENAI: &str = "openai";
const PROVIDER_DEEPSEEK: &str = "deepseek";
const PROVIDER_ZAI: &str = "zai";
const PROVIDER_GEMINI: &str = "gemini";
const PROVIDER_ASSISTANT: &str = "assistant";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProfile {
    id: String,
    handle: String,
    display_name: Option<String>,
    description: Option<String>,
    avatar_seed: String,
    provider: String,
    model: Option<String>,
    credential_id: Option<String>,
    runtime_id: Option<String>,
    deleted_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListMyAgentsQuery {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateAgentBody {
    credential_id: Option<String>,
    handle: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    avatar_seed: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAgentBody {
    handle: Option<String>,
    #[serde(default)]
    display_name: Option<Option<String>>,
    #[serde(default)]
    description: Option<Option<String>>,
    #[serde(default)]
    avatar_seed: Option<Option<String>>,
    #[serde(default)]
    credential_id: Option<Option<String>>,
    #[serde(default)]
    model: Option<Option<String>>,
    project_id: Option<String>,
    #[serde(default)]
    runtime_id: Option<Option<String>>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/agents", get(list_my_agents))
        .route("/me/agents", post(create_my_agent))
        .route("/me/agents/:agent_id", patch(update_my_agent))
        .route("/me/agents/:agent_id", delete(delete_my_agent))
}

fn normalize_handle(input: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let trimmed = input.trim().trim_start_matches('@').trim().to_lowercase();
    if trimmed.is_empty() {
        return Err(bad_request("handle is required"));
    }
    if trimmed.len() > MAX_HANDLE_LEN {
        return Err(bad_request("handle is too long (max 20 chars)"));
    }
    let bytes = trimmed.as_bytes();
    let first = *bytes.first().unwrap();
    let valid_first = (b'a'..=b'z').contains(&first) || (b'0'..=b'9').contains(&first);
    if !valid_first {
        return Err(bad_request("handle must start with a letter or number"));
    }
    for &byte in bytes {
        let ok = (b'a'..=b'z').contains(&byte)
            || (b'0'..=b'9').contains(&byte)
            || byte == b'_'
            || byte == b'-';
        if !ok {
            return Err(bad_request(
                "handle must contain only letters, numbers, '_' or '-'",
            ));
        }
    }
    if trimmed == "octo" || trimmed == "ai" {
        return Err(bad_request("handle is reserved"));
    }
    Ok(trimmed)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn normalize_optional_description(
    value: Option<String>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let normalized = normalize_optional_text(value);
    if let Some(ref description) = normalized {
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(bad_request(format!(
                "description is too long (max {} chars)",
                MAX_DESCRIPTION_LEN
            )));
        }
    }
    Ok(normalized)
}

fn normalize_provider_id(raw: Option<&str>) -> Option<String> {
    raw.map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .map(|value| match value.as_str() {
            PROVIDER_OPENAI => PROVIDER_OPENAI.to_string(),
            PROVIDER_DEEPSEEK => PROVIDER_DEEPSEEK.to_string(),
            PROVIDER_ZAI => PROVIDER_ZAI.to_string(),
            PROVIDER_GEMINI | "google" | "google-ai" | "google_gemini" | "google-gemini" => {
                PROVIDER_GEMINI.to_string()
            }
            PROVIDER_ASSISTANT => PROVIDER_ASSISTANT.to_string(),
            _ => PROVIDER_OPENAI.to_string(),
        })
}

fn normalize_optional_model(
    value: Option<String>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let normalized = normalize_optional_text(value);
    if let Some(ref model) = normalized {
        if model.len() > MAX_MODEL_LEN {
            return Err(bad_request(format!(
                "model is too long (max {} chars)",
                MAX_MODEL_LEN
            )));
        }
    }
    Ok(normalized)
}

async fn resolve_agent_provider_for_credential(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    credential_id: &Uuid,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select kind, metadata
             from user_credentials
             where id = $1 and user_id = $2 and revoked_at is null
             limit 1",
            &[credential_id, user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load credential metadata: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("credential not found"));
    };

    let kind: String = row.get("kind");
    if kind == "codex_auth_json" {
        return Ok(PROVIDER_OPENAI.to_string());
    }

    let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
    let provider_hint = metadata
        .as_object()
        .and_then(|map| map.get("provider"))
        .and_then(JsonValue::as_str);
    Ok(normalize_provider_id(provider_hint).unwrap_or_else(|| PROVIDER_OPENAI.to_string()))
}

#[derive(Debug, Clone)]
pub(crate) struct OctoAgentProfile {
    pub(crate) id: Uuid,
    pub(crate) display_name: Option<String>,
    pub(crate) description: Option<String>,
}

pub(crate) async fn load_or_create_octo_agent_profile(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
) -> Result<OctoAgentProfile, (StatusCode, Json<ApiError>)> {
    let existing = transaction
        .query_opt(
            "select id, display_name, description
             from user_agents
             where user_id = $1 and lower(handle) = 'octo' and deleted_at is null
             limit 1",
            &[user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check octo agent profile: {error}")))?;

    if let Some(existing) = existing {
        let id: Uuid = existing.get("id");
        let display_name: Option<String> = existing.get("display_name");
        let description: Option<String> = existing.get("description");
        return Ok(OctoAgentProfile {
            id,
            display_name,
            description,
        });
    }

    let agent_id = Uuid::new_v4();
    let provider = "assistant".to_string();
    let handle = "octo".to_string();
    let display_name = Some("Octo".to_string());
    let description: Option<String> = None;
    let avatar_seed = "octo".to_string();

    let insert = transaction
        .execute(
            "insert into user_agents (
                 id, user_id, provider, handle, display_name, description, avatar_seed
             ) values ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &agent_id,
                user_id,
                &provider,
                &handle,
                &display_name,
                &description,
                &avatar_seed,
            ],
        )
        .await;

    match insert {
        Ok(_) => {}
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNIQUE_VIOLATION)
                .unwrap_or(false)
            {
                // Another request created @octo in the meantime; fall through to reload.
            } else {
                return Err(internal_error(format!(
                    "failed to insert octo agent profile: {error}"
                )));
            }
        }
    }

    let row = transaction
        .query_one(
            "select id, display_name, description
             from user_agents
             where user_id = $1 and lower(handle) = 'octo' and deleted_at is null
             limit 1",
            &[user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to reload octo agent profile: {error}")))?;

    let id: Uuid = row.get("id");
    let display_name: Option<String> = row.get("display_name");
    let description: Option<String> = row.get("description");

    Ok(OctoAgentProfile {
        id,
        display_name,
        description,
    })
}

fn generate_handle_base(label: Option<&str>) -> String {
    let raw = label.unwrap_or("codex");
    let lowered = raw.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut prev_sep = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_sep = false;
            continue;
        }
        if !prev_sep {
            out.push('-');
            prev_sep = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    let trimmed = if trimmed.is_empty() {
        "codex".to_string()
    } else {
        trimmed
    };
    let trimmed = if trimmed.len() > MAX_HANDLE_LEN {
        trimmed[..MAX_HANDLE_LEN].to_string()
    } else {
        trimmed
    };
    let starts_ok = trimmed
        .as_bytes()
        .first()
        .map(|byte| (b'a'..=b'z').contains(byte) || (b'0'..=b'9').contains(byte))
        .unwrap_or(false);
    if starts_ok {
        trimmed
    } else {
        format!("bot-{}", trimmed)
            .chars()
            .take(MAX_HANDLE_LEN)
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    }
}

async fn handle_exists(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    handle: &str,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select 1 from user_agents where user_id = $1 and lower(handle) = lower($2) and deleted_at is null limit 1",
            &[user_id, &handle],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check agent handle uniqueness: {error}")))?;
    Ok(row.is_some())
}

pub(crate) async fn create_default_agent_for_credential(
    transaction: &Transaction<'_>,
    user_id: Uuid,
    credential_id: Uuid,
    label: Option<&str>,
    description: Option<String>,
    model: Option<String>,
    provider: &str,
) -> Result<(Uuid, String), (StatusCode, Json<ApiError>)> {
    let base = generate_handle_base(label);
    let mut handle = base.clone();
    if handle == "octo" || handle == "ai" {
        handle = "codex".to_string();
    }
    if handle.len() > MAX_HANDLE_LEN {
        handle = handle[..MAX_HANDLE_LEN].to_string();
    }
    handle = handle.trim_matches('-').to_string();
    if handle.is_empty() {
        handle = "codex".to_string();
    }

    if handle_exists(transaction, &user_id, &handle).await? {
        for suffix in 2..=50 {
            let suffix_str = suffix.to_string();
            let max_base = MAX_HANDLE_LEN.saturating_sub(1 + suffix_str.len());
            let trimmed_base = base.chars().take(max_base.max(1)).collect::<String>();
            let candidate = format!("{}-{}", trimmed_base.trim_matches('-'), suffix_str);
            if candidate.len() > MAX_HANDLE_LEN {
                continue;
            }
            if !handle_exists(transaction, &user_id, &candidate).await? {
                handle = candidate;
                break;
            }
        }
    }

    let agent_id = Uuid::new_v4();
    let avatar_seed = credential_id.to_string();
    let display_name = label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let description = normalize_optional_description(description)?;
    let model = normalize_optional_model(model)?;

    transaction
        .execute(
            "insert into user_agents (
                 id, user_id, credential_id, provider, model, handle, display_name, description, avatar_seed
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            &[
                &agent_id,
                &user_id,
                &credential_id,
                &provider,
                &model,
                &handle,
                &display_name,
                &description,
                &avatar_seed,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert agent profile: {error}")))?;

    Ok((agent_id, handle))
}

async fn list_my_agents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListMyAgentsQuery>,
) -> Result<Json<Vec<AgentProfile>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let project_id = query
        .project_id
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::from_str(value).map_err(|_| bad_request("projectId must be a valid UUID"))
        })
        .transpose()?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        let requested_project_id = project_id.as_ref().ok_or_else(|| {
            bad_request("projectId is required when listing agents with a job token")
        })?;
        active_job.ensure_project_id(requested_project_id)?;
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let user_id = if let Some(active_job) = active_job.as_ref() {
        active_job.subject_user_id
    } else {
        require_user_session(&context)?
    };

    if let Some(project_id) = project_id.as_ref() {
        let project = load_project_record(&transaction, project_id).await?;
        ensure_project_access(&transaction, &project, &access_context, None).await?;
    }

    let _ = load_or_create_octo_agent_profile(&transaction, &user_id).await?;

    let rows = transaction
        .query(
            "select ua.id,
                    ua.handle,
                    ua.display_name,
                    ua.description,
                    ua.avatar_seed,
                    ua.provider,
                    ua.model,
                    ua.credential_id,
                    ua.deleted_at,
                    ua.created_at,
                    ua.updated_at,
                    uaps.runtime_id as runtime_id
             from user_agents ua
             left join user_agent_project_settings uaps
               on uaps.user_id = ua.user_id
              and uaps.agent_id = ua.id
              and uaps.project_id = $2
             where ua.user_id = $1 and ua.deleted_at is null
             order by ua.created_at asc, ua.id asc
             limit 200",
            &[&user_id, &project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list agents: {error}")))?;

    let agents = rows
        .into_iter()
        .map(|row| {
            let id: Uuid = row.get("id");
            let handle: String = row.get("handle");
            let display_name: Option<String> = row.get("display_name");
            let description: Option<String> = row.get("description");
            let avatar_seed: String = row.get("avatar_seed");
            let provider: String = row.get("provider");
            let model: Option<String> = row.get("model");
            let credential_id: Option<Uuid> = row.get("credential_id");
            let runtime_id: Option<Uuid> = row.get("runtime_id");
            let deleted_at: Option<DateTime<Utc>> = row.get("deleted_at");
            let created_at: DateTime<Utc> = row.get("created_at");
            let updated_at: DateTime<Utc> = row.get("updated_at");

            AgentProfile {
                id: id.to_string(),
                handle,
                display_name,
                description,
                avatar_seed,
                provider,
                model,
                credential_id: credential_id.map(|value| value.to_string()),
                runtime_id: runtime_id.map(|value| value.to_string()),
                deleted_at: deleted_at.map(|dt| dt.to_rfc3339()),
                created_at: created_at.to_rfc3339(),
                updated_at: updated_at.to_rfc3339(),
            }
        })
        .collect();

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit agent list: {error}")))?;

    Ok(Json(agents))
}

async fn create_my_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateAgentBody>,
) -> Result<Json<AgentProfile>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let credential_id = body
        .credential_id
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::from_str(value).map_err(|_| bad_request("credentialId must be a valid UUID"))
        })
        .transpose()?;

    let display_name = normalize_optional_text(body.display_name);
    let description = normalize_optional_description(body.description)?;
    let model = normalize_optional_model(body.model)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let provider = match credential_id.as_ref() {
        Some(credential_id) => {
            resolve_agent_provider_for_credential(&transaction, &user_id, credential_id).await?
        }
        None => normalize_provider_id(body.provider.as_deref())
            .unwrap_or_else(|| PROVIDER_OPENAI.to_string()),
    };

    let (agent_id, _handle) = if let Some(handle) = body
        .handle
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let handle = normalize_handle(handle)?;
        if handle_exists(&transaction, &user_id, &handle).await? {
            return Err(bad_request("handle is already in use"));
        }
        let agent_id = Uuid::new_v4();
        let avatar_seed =
            normalize_optional_text(body.avatar_seed).unwrap_or_else(|| agent_id.to_string());
        transaction
            .execute(
                "insert into user_agents (
                     id, user_id, credential_id, provider, model, handle, display_name, description, avatar_seed
                 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                &[
                    &agent_id,
                    &user_id,
                    &credential_id,
                    &provider,
                    &model,
                    &handle,
                    &display_name,
                    &description,
                    &avatar_seed,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to insert agent profile: {error}")))?;
        (agent_id, handle)
    } else {
        let credential_id = credential_id
            .ok_or_else(|| bad_request("credentialId is required when handle is omitted"))?;
        let credential_row = transaction
            .query_opt(
                "select label from user_credentials where id = $1 and user_id = $2 and revoked_at is null limit 1",
                &[&credential_id, &user_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load credential label: {error}")))?;
        let Some(credential_row) = credential_row else {
            return Err(not_found("credential not found"));
        };
        let credential_label: Option<String> = credential_row.get("label");
        let seed_label = display_name
            .as_deref()
            .or_else(|| credential_label.as_deref());
        create_default_agent_for_credential(
            &transaction,
            user_id,
            credential_id,
            seed_label,
            description.clone(),
            model.clone(),
            &provider,
        )
        .await?
    };

    let row = transaction
        .query_one(
            "select id, handle, display_name, description, avatar_seed, provider, model, credential_id, deleted_at, created_at, updated_at
             from user_agents
             where id = $1 and user_id = $2
             limit 1",
            &[&agent_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load new agent: {error}")))?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit agent insert: {error}")))?;

    let id: Uuid = row.get("id");
    let handle: String = row.get("handle");
    let display_name: Option<String> = row.get("display_name");
    let description: Option<String> = row.get("description");
    let avatar_seed: String = row.get("avatar_seed");
    let provider: String = row.get("provider");
    let model: Option<String> = row.get("model");
    let credential_id: Option<Uuid> = row.get("credential_id");
    let deleted_at: Option<DateTime<Utc>> = row.get("deleted_at");
    let created_at: DateTime<Utc> = row.get("created_at");
    let updated_at: DateTime<Utc> = row.get("updated_at");

    Ok(Json(AgentProfile {
        id: id.to_string(),
        handle,
        display_name,
        description,
        avatar_seed,
        provider,
        model,
        credential_id: credential_id.map(|value| value.to_string()),
        runtime_id: None,
        deleted_at: deleted_at.map(|dt| dt.to_rfc3339()),
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
    }))
}

async fn update_my_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(agent_id_raw): AxumPath<String>,
    Json(body): Json<UpdateAgentBody>,
) -> Result<Json<AgentProfile>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let agent_id = Uuid::from_str(agent_id_raw.trim())
        .map_err(|_| bad_request("agentId must be a valid UUID"))?;

    let desired_handle = body
        .handle
        .as_deref()
        .map(|value| normalize_handle(value))
        .transpose()?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let existing = transaction
        .query_opt(
            "select handle, display_name, description, avatar_seed, provider, model, credential_id
             from user_agents
             where id = $1 and user_id = $2 and deleted_at is null
             limit 1",
            &[&agent_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load agent: {error}")))?;

    let Some(existing) = existing else {
        return Err(not_found("agent not found"));
    };

    let existing_handle: String = existing.get("handle");
    let existing_display_name: Option<String> = existing.get("display_name");
    let existing_description: Option<String> = existing.get("description");
    let existing_avatar_seed: String = existing.get("avatar_seed");
    let existing_provider: String = existing.get("provider");
    let existing_model: Option<String> = existing.get("model");
    let existing_credential_id: Option<Uuid> = existing.get("credential_id");

    let next_handle = desired_handle.unwrap_or_else(|| existing_handle.clone());
    if next_handle != existing_handle {
        let row = transaction
            .query_opt(
                "select 1 from user_agents
                 where user_id = $1 and lower(handle) = lower($2) and id <> $3 and deleted_at is null
                 limit 1",
                &[&user_id, &next_handle, &agent_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to check handle uniqueness: {error}")))?;
        if row.is_some() {
            return Err(bad_request("handle is already in use"));
        }
    }

    let next_display_name = match body.display_name {
        None => existing_display_name,
        Some(value) => normalize_optional_text(value),
    };

    let next_description = match body.description {
        None => existing_description,
        Some(value) => normalize_optional_description(value)?,
    };

    let next_avatar_seed = match body.avatar_seed {
        None => existing_avatar_seed,
        Some(value) => {
            let candidate = normalize_optional_text(value);
            candidate.unwrap_or_else(|| existing_avatar_seed.clone())
        }
    };

    let next_credential_id = match body.credential_id {
        None => existing_credential_id,
        Some(None) => None,
        Some(Some(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(bad_request("credentialId cannot be empty"));
            }
            let credential_id = Uuid::from_str(trimmed)
                .map_err(|_| bad_request("credentialId must be a valid UUID"))?;
            let row = transaction
                .query_opt(
                    "select 1 from user_credentials
                     where id = $1 and user_id = $2 and revoked_at is null
                     limit 1",
                    &[&credential_id, &user_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to validate credential selection: {error}"))
                })?;
            if row.is_none() {
                return Err(not_found("credential not found"));
            }
            Some(credential_id)
        }
    };

    let next_provider = match next_credential_id.as_ref() {
        Some(credential_id) => {
            resolve_agent_provider_for_credential(&transaction, &user_id, credential_id).await?
        }
        None => existing_provider,
    };

    let next_model = match body.model {
        None => existing_model,
        Some(value) => normalize_optional_model(value)?,
    };

    let project_id = body
        .project_id
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::from_str(value).map_err(|_| bad_request("projectId must be a valid UUID"))
        })
        .transpose()?;

    if project_id.is_none() && body.runtime_id.is_some() {
        return Err(bad_request("projectId is required when updating runtimeId"));
    }

    if let Some(project_id) = project_id.as_ref() {
        let project = load_project_record(&transaction, project_id).await?;
        if body.runtime_id.is_some() {
            ensure_project_write_access(&transaction, &project, &context, None).await?;
        } else {
            ensure_project_access(&transaction, &project, &context, None).await?;
        }
    }

    if let (Some(project_id), Some(runtime_update)) =
        (project_id.as_ref(), body.runtime_id.as_ref())
    {
        match runtime_update.as_deref() {
            Some(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return Err(bad_request("runtimeId cannot be empty"));
                }
                let runtime_id = Uuid::from_str(trimmed)
                    .map_err(|_| bad_request("runtimeId must be a valid UUID"))?;
                let row = transaction
                    .query_opt(
                        "select provider, capabilities
                         from runtimes
                         where id = $1 and project_id = $2
                         limit 1
                         for share",
                        &[&runtime_id, project_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to validate runtime selection: {error}"))
                    })?;
                let Some(row) = row else {
                    return Err(not_found("runtime not found"));
                };
                let provider: String = row.get("provider");
                let capabilities: JsonValue = row.get("capabilities");
                let provider_is_self_hosted = crate::runtime::runtime_is_private_self_hosted(
                    &state,
                    &provider,
                    &capabilities,
                );
                if !agent_runtime_is_selectable(
                    &provider,
                    &capabilities,
                    user_id,
                    provider_is_self_hosted,
                ) {
                    return Err(forbidden(
                        "Self-hosted runtime is private to its authenticated owner",
                    ));
                }

                transaction
                    .execute(
                        "insert into user_agent_project_settings (user_id, project_id, agent_id, runtime_id)
                         values ($1, $2, $3, $4)
                         on conflict (user_id, project_id, agent_id)
                         do update set runtime_id = excluded.runtime_id, updated_at = now()",
                        &[&user_id, project_id, &agent_id, &runtime_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!(
                            "failed to persist agent runtime preference: {error}"
                        ))
                    })?;
            }
            None => {
                transaction
                    .execute(
                        "delete from user_agent_project_settings
                         where user_id = $1 and project_id = $2 and agent_id = $3",
                        &[&user_id, project_id, &agent_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to clear agent runtime preference: {error}"))
                    })?;
            }
        }
    }

    let agent_runtime_id: Option<Uuid> = if let Some(project_id) = project_id.as_ref() {
        transaction
            .query_opt(
                "select runtime_id
                 from user_agent_project_settings
                 where user_id = $1 and project_id = $2 and agent_id = $3
                 limit 1",
                &[&user_id, project_id, &agent_id],
            )
            .await
            .map(|row| row.and_then(|row| row.get::<_, Option<Uuid>>("runtime_id")))
            .map_err(|error| {
                internal_error(format!("failed to load agent runtime preference: {error}"))
            })?
    } else {
        None
    };

    let updated = transaction
        .query_opt(
            "update user_agents
             set handle = $3,
                 display_name = $4,
                 description = $5,
                 avatar_seed = $6,
                 credential_id = $7,
                 provider = $8,
                 model = $9,
                 updated_at = now()
             where id = $1 and user_id = $2 and deleted_at is null
             returning id, handle, display_name, description, avatar_seed, provider, model, credential_id, deleted_at, created_at, updated_at",
            &[
                &agent_id,
                &user_id,
                &next_handle,
                &next_display_name,
                &next_description,
                &next_avatar_seed,
                &next_credential_id,
                &next_provider,
                &next_model,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update agent: {error}")))?;

    let Some(row) = updated else {
        return Err(not_found("agent not found"));
    };

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit agent update: {error}")))?;

    let id: Uuid = row.get("id");
    let handle: String = row.get("handle");
    let display_name: Option<String> = row.get("display_name");
    let description: Option<String> = row.get("description");
    let avatar_seed: String = row.get("avatar_seed");
    let provider: String = row.get("provider");
    let model: Option<String> = row.get("model");
    let credential_id: Option<Uuid> = row.get("credential_id");
    let deleted_at: Option<DateTime<Utc>> = row.get("deleted_at");
    let created_at: DateTime<Utc> = row.get("created_at");
    let updated_at: DateTime<Utc> = row.get("updated_at");

    Ok(Json(AgentProfile {
        id: id.to_string(),
        handle,
        display_name,
        description,
        avatar_seed,
        provider,
        model,
        credential_id: credential_id.map(|value| value.to_string()),
        runtime_id: agent_runtime_id.map(|value| value.to_string()),
        deleted_at: deleted_at.map(|dt| dt.to_rfc3339()),
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
    }))
}

fn agent_runtime_is_selectable(
    provider: &str,
    capabilities: &JsonValue,
    owner_user_id: Uuid,
    provider_is_self_hosted: bool,
) -> bool {
    if !provider_is_self_hosted
        && !crate::runtime::runtime_has_private_self_hosted_identity(provider, capabilities)
    {
        return true;
    }

    crate::runtime::self_hosted_owner_user_id(capabilities) == Some(owner_user_id)
}

async fn delete_my_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(agent_id_raw): AxumPath<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let agent_id = Uuid::from_str(agent_id_raw.trim())
        .map_err(|_| bad_request("agentId must be a valid UUID"))?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let existing = connection
        .query_opt(
            "select handle
             from user_agents
             where id = $1 and user_id = $2 and deleted_at is null
             limit 1",
            &[&agent_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load agent: {error}")))?;

    let Some(existing) = existing else {
        return Err(not_found("agent not found"));
    };

    let handle: String = existing.get("handle");
    if handle.trim().to_ascii_lowercase() == "octo" {
        return Err(bad_request("cannot delete @octo"));
    }

    let updated = connection
        .execute(
            "update user_agents
             set deleted_at = now(), updated_at = now()
             where id = $1 and user_id = $2 and deleted_at is null",
            &[&agent_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to delete agent: {error}")))?;

    if updated == 0 {
        return Err(not_found("agent not found"));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::agent_runtime_is_selectable;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn agent_runtime_preference_requires_attested_self_hosted_owner() {
        let owner = Uuid::new_v4();
        let teammate = Uuid::new_v4();
        let capabilities = json!({
            "_instafySelfHostedAccess": {
                "mode": "private",
                "ownerUserId": owner.to_string(),
            }
        });

        assert!(agent_runtime_is_selectable(
            "self-hosted",
            &capabilities,
            owner,
            true,
        ));
        assert!(!agent_runtime_is_selectable(
            "self-hosted",
            &capabilities,
            teammate,
            true,
        ));
    }

    #[test]
    fn custom_self_hosted_agent_runtime_fails_closed_without_attestation() {
        let owner = Uuid::new_v4();

        assert!(!agent_runtime_is_selectable(
            "developer-workstation",
            &json!({}),
            owner,
            true,
        ));
        assert!(agent_runtime_is_selectable(
            "instafy-cloud",
            &json!({}),
            owner,
            false,
        ));
    }
}
