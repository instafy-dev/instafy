use std::str::FromStr;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::active_job_auth::{
    authorize_active_job_if_scoped, ActiveJobAuthorization, ActiveJobProjectAccess,
};
use crate::agent::{
    ensure_agent_token_matches_runtime_lease, extract_agent_token, verify_agent_token_with_scopes,
};
use crate::auth::authenticate_request;
use crate::config::{CredentialEncryptionKey, PgPool};
use crate::model_defaults::{resolve_agent_model_for_provider, DEFAULT_MANAGED_AI_PROVIDER_ID};
use crate::projects::load_project_record;
use crate::{
    bad_request, ensure_project_access, ensure_project_write_access, internal_error, not_found,
    unauthorized, ApiError, AppState,
};

const SECRET_NAME_MAX_LEN: usize = 64;
const SECRET_DESCRIPTION_MAX_LEN: usize = 800;
const SECRET_VALUE_MAX_LEN: usize = 16_384;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSecretListItem {
    id: String,
    name: String,
    description: Option<String>,
    agent_ids: Vec<String>,
    agent_handles: Vec<String>,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectSecretBody {
    name: String,
    value: String,
    description: Option<String>,
    #[serde(default)]
    agent_handles: Vec<String>,
    #[serde(default)]
    agent_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectSecretResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProjectSecretBody {
    description: Option<Option<String>>,
    value: Option<String>,
    #[serde(default)]
    agent_handles: Option<Vec<String>>,
    #[serde(default)]
    agent_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevokeProjectSecretResponse {
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct AgentSecretsRequest {
    #[serde(rename = "job_id", alias = "jobId")]
    job_id: String,
    #[serde(default)]
    touch: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSecretInventoryItem {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSecretsResponse {
    env: JsonValue,
    inventory: Vec<AgentSecretInventoryItem>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/secrets",
            get(list_project_secrets).post(create_project_secret),
        )
        .route(
            "/projects/:project_id/secrets/:secret_id",
            patch(update_project_secret).delete(revoke_project_secret),
        )
        .route("/agent/secrets", post(agent_secrets))
}

fn normalize_secret_name(input: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(bad_request("name is required"));
    }
    if trimmed.len() > SECRET_NAME_MAX_LEN {
        return Err(bad_request(format!(
            "name is too long (max {SECRET_NAME_MAX_LEN} chars)"
        )));
    }
    let normalized = trimmed.replace([' ', '-'], "_").to_ascii_uppercase();
    let bytes = normalized.as_bytes();
    let first = *bytes
        .first()
        .ok_or_else(|| bad_request("name is required"))?;
    if !(b'A'..=b'Z').contains(&first) {
        return Err(bad_request("name must start with a letter (A-Z)"));
    }
    for &byte in bytes {
        let ok = (b'A'..=b'Z').contains(&byte) || (b'0'..=b'9').contains(&byte) || byte == b'_';
        if !ok {
            return Err(bad_request(
                "name must contain only letters, numbers, or '_'",
            ));
        }
    }
    Ok(normalized)
}

fn normalize_optional_description(
    value: Option<String>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let normalized = value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty());
    if let Some(ref description) = normalized {
        if description.len() > SECRET_DESCRIPTION_MAX_LEN {
            return Err(bad_request(format!(
                "description is too long (max {SECRET_DESCRIPTION_MAX_LEN} chars)"
            )));
        }
    }
    Ok(normalized)
}

fn normalize_secret_value(value: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(bad_request("value is required"));
    }
    if trimmed.len() > SECRET_VALUE_MAX_LEN {
        return Err(bad_request(format!(
            "value is too long (max {SECRET_VALUE_MAX_LEN} chars)"
        )));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn encrypt_secret_payload(
    key: &CredentialEncryptionKey,
    plaintext: &[u8],
) -> anyhow::Result<(String, String)> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes())?;
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce_bytes, plaintext)
        .map_err(|error| anyhow::anyhow!("failed to encrypt secret payload: {error:?}"))?;
    Ok((
        BASE64.encode(nonce_bytes.as_slice()),
        BASE64.encode(ciphertext),
    ))
}

pub(crate) fn decrypt_secret_payload(
    key: &CredentialEncryptionKey,
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> anyhow::Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes())?;
    let nonce_raw = BASE64.decode(nonce_b64.trim().as_bytes())?;
    anyhow::ensure!(nonce_raw.len() == 12, "invalid nonce length");
    let nonce = Nonce::from_slice(&nonce_raw);
    let ciphertext = BASE64.decode(ciphertext_b64.trim().as_bytes())?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|error| anyhow::anyhow!("failed to decrypt secret payload: {error:?}"))?;
    Ok(plaintext)
}

async fn ensure_project_secrets_table(pool: &PgPool) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "
            create table if not exists project_secrets (
              id uuid primary key,
              project_id uuid not null,
              user_id uuid not null,
              name text not null,
              description text,
              nonce_b64 text not null,
              ciphertext_b64 text not null,
              last_used_at timestamptz,
              revoked_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );

            create unique index if not exists project_secrets_unique
              on project_secrets (project_id, user_id, name)
              where revoked_at is null;

            create unique index if not exists project_secrets_unique_project
              on project_secrets (project_id, name)
              where revoked_at is null;

            alter table project_secrets enable row level security;
            revoke all privileges on table project_secrets from anon, authenticated;
            ",
        )
        .await?;
    Ok(())
}

async fn ensure_project_secret_grants_table(pool: &PgPool) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "
            create table if not exists project_secret_agent_grants (
              secret_id uuid not null references project_secrets(id) on delete cascade,
              agent_id uuid not null references user_agents(id) on delete cascade,
              created_at timestamptz not null default now(),
              primary key (secret_id, agent_id)
            );

            alter table project_secret_agent_grants enable row level security;
            revoke all privileges on table project_secret_agent_grants from anon, authenticated;
            ",
        )
        .await?;
    Ok(())
}

async fn ensure_project_secret_handle_grants_table(pool: &PgPool) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "
            create table if not exists project_secret_agent_handle_grants (
              secret_id uuid not null references project_secrets(id) on delete cascade,
              agent_handle text not null,
              created_at timestamptz not null default now(),
              primary key (secret_id, agent_handle)
            );

            alter table project_secret_agent_handle_grants enable row level security;
            revoke all privileges on table project_secret_agent_handle_grants from anon, authenticated;
            ",
        )
        .await?;
    Ok(())
}

async fn ensure_secret_tables(pool: &PgPool) -> anyhow::Result<()> {
    ensure_project_secrets_table(pool).await?;
    ensure_project_secret_grants_table(pool).await?;
    ensure_project_secret_handle_grants_table(pool).await?;
    Ok(())
}

fn normalize_agent_handles(values: &[String]) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let mut out: Vec<String> = Vec::new();
    for raw in values {
        let trimmed = raw.trim().trim_start_matches('@').trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > 32 {
            return Err(bad_request("agentHandles entries are too long"));
        }
        let normalized = trimmed.to_ascii_lowercase();
        if out.contains(&normalized) {
            continue;
        }
        out.push(normalized);
    }
    out.sort();
    out.dedup();
    Ok(out)
}

async fn list_project_secrets(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
) -> Result<Json<Vec<ProjectSecretListItem>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

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
        active_job.ensure_project_id(&project_id)?;
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    if access_context.user_id.is_none() && !access_context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &access_context, None).await?;

    let attempt_list = || async {
        transaction
            .query(
                "select id, name, description, last_used_at, revoked_at, created_at, updated_at
                 from project_secrets
                 where project_id = $1 and revoked_at is null
                 order by created_at desc",
                &[&project_id],
            )
            .await
    };

    let rows = match attempt_list().await {
        Ok(rows) => rows,
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                ensure_secret_tables(&state.pool).await.map_err(|err| {
                    internal_error(format!("failed to create secrets table: {err}"))
                })?;
                attempt_list().await.map_err(|err| {
                    internal_error(format!("failed to list secrets after ensure: {err}"))
                })?
            } else {
                return Err(internal_error(format!("failed to list secrets: {error}")));
            }
        }
    };

    let mut secret_ids: Vec<Uuid> = Vec::new();
    let mut base: Vec<(Uuid, ProjectSecretListItem)> = Vec::new();
    for row in rows {
        let id: Uuid = row.get("id");
        let name: String = row.get("name");
        let description: Option<String> = row.get("description");
        let last_used_at: Option<DateTime<Utc>> = row.get("last_used_at");
        let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");
        let created_at: DateTime<Utc> = row.get("created_at");
        let updated_at: DateTime<Utc> = row.get("updated_at");
        secret_ids.push(id);
        base.push((
            id,
            ProjectSecretListItem {
                id: id.to_string(),
                name,
                description,
                agent_ids: Vec::new(),
                agent_handles: Vec::new(),
                last_used_at: last_used_at.map(|dt| dt.to_rfc3339()),
                revoked_at: revoked_at.map(|dt| dt.to_rfc3339()),
                created_at: created_at.to_rfc3339(),
                updated_at: updated_at.to_rfc3339(),
            },
        ));
    }

    if secret_ids.is_empty() {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to commit list secrets: {error}")))?;
        return Ok(Json(Vec::new()));
    }

    let mut grants_by_secret: std::collections::HashMap<Uuid, (Vec<String>, Vec<String>)> =
        std::collections::HashMap::new();

    // Legacy agent-id grants (best-effort).
    if let Ok(grants) = transaction
        .query(
            "select g.secret_id, ua.id as agent_id, ua.handle
             from project_secret_agent_grants g
             join user_agents ua on ua.id = g.agent_id
             where g.secret_id = any($1::uuid[])
               and ua.deleted_at is null
             order by ua.handle asc",
            &[&secret_ids],
        )
        .await
    {
        for row in grants {
            let secret_id: Uuid = row.get("secret_id");
            let agent_id: Uuid = row.get("agent_id");
            let handle: String = row.get("handle");
            let entry = grants_by_secret
                .entry(secret_id)
                .or_insert_with(|| (Vec::new(), Vec::new()));
            entry.0.push(agent_id.to_string());
            entry.1.push(handle);
        }
    }

    // Handle grants (preferred).
    let attempt_handle_grants = || async {
        transaction
            .query(
                "select secret_id, agent_handle
                 from project_secret_agent_handle_grants
                 where secret_id = any($1::uuid[])
                 order by agent_handle asc",
                &[&secret_ids],
            )
            .await
    };

    let handle_grants = match attempt_handle_grants().await {
        Ok(rows) => rows,
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                ensure_secret_tables(&state.pool).await.map_err(|err| {
                    internal_error(format!("failed to create secrets tables: {err}"))
                })?;
                attempt_handle_grants().await.map_err(|err| {
                    internal_error(format!("failed to load handle grants after ensure: {err}"))
                })?
            } else {
                return Err(internal_error(format!(
                    "failed to load secret handle grants: {error}"
                )));
            }
        }
    };

    for row in handle_grants {
        let secret_id: Uuid = row.get("secret_id");
        let handle: String = row.get("agent_handle");
        let entry = grants_by_secret
            .entry(secret_id)
            .or_insert_with(|| (Vec::new(), Vec::new()));
        entry.1.push(handle);
    }

    let mut out: Vec<ProjectSecretListItem> = Vec::new();
    for (id, mut item) in base {
        if let Some((agent_ids, agent_handles)) = grants_by_secret.remove(&id) {
            item.agent_ids = agent_ids;
            let mut handles = agent_handles;
            handles.sort();
            handles.dedup();
            item.agent_handles = handles;
        }
        out.push(item);
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit list secrets: {error}")))?;

    Ok(Json(out))
}

async fn create_project_secret(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<CreateProjectSecretBody>,
) -> Result<Json<CreateProjectSecretResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("user session required"))?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let name = normalize_secret_name(&body.name)?;
    let description = normalize_optional_description(body.description)?;
    let value = normalize_secret_value(&body.value)?;

    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| internal_error("credential encryption key missing"))?;

    let (nonce_b64, ciphertext_b64) = encrypt_secret_payload(key, value.as_bytes())
        .map_err(|error| internal_error(format!("failed to encrypt secret: {error}")))?;

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

    let mut agent_handles = normalize_agent_handles(&body.agent_handles)?;
    if agent_handles.is_empty() && !body.agent_ids.is_empty() {
        let mut agent_ids: Vec<Uuid> = Vec::new();
        for raw in body.agent_ids.iter() {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let id = Uuid::from_str(trimmed).map_err(|_| bad_request("agentIds must be UUIDs"))?;
            agent_ids.push(id);
        }
        agent_ids.sort();
        agent_ids.dedup();

        if !agent_ids.is_empty() {
            let rows = transaction
                .query(
                    "select handle from user_agents where user_id = $1 and id = any($2::uuid[]) and deleted_at is null",
                    &[&user_id, &agent_ids],
                )
                .await
                .map_err(|error| internal_error(format!("failed to validate agents: {error}")))?;
            if rows.len() != agent_ids.len() {
                return Err(bad_request("agentIds must belong to the signed-in user"));
            }
            let handles: Vec<String> = rows
                .into_iter()
                .map(|row| row.get::<_, String>("handle"))
                .collect();
            agent_handles = normalize_agent_handles(&handles)?;
        }
    }

    if agent_handles.is_empty() {
        agent_handles.push("octo".to_string());
    }

    let secret_id = Uuid::new_v4();

    let attempt_duplicate_check = || async {
        transaction
            .query_opt(
                "select id from project_secrets where project_id = $1 and name = $2 and revoked_at is null limit 1",
                &[&project_id, &name],
            )
            .await
    };

    match attempt_duplicate_check().await {
        Ok(Some(_)) => return Err(bad_request("secret name already exists")),
        Ok(None) => {}
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                ensure_secret_tables(&state.pool).await.map_err(|err| {
                    internal_error(format!("failed to create secrets tables: {err}"))
                })?;
                if attempt_duplicate_check()
                    .await
                    .map_err(|err| {
                        internal_error(format!("failed to check secret name after ensure: {err}"))
                    })?
                    .is_some()
                {
                    return Err(bad_request("secret name already exists"));
                }
            } else {
                return Err(internal_error(format!(
                    "failed to check secret name: {error}"
                )));
            }
        }
    }

    let attempt_insert = || async {
        transaction
            .execute(
                "insert into project_secrets (
                     id, project_id, user_id, name, description, nonce_b64, ciphertext_b64
                 ) values ($1, $2, $3, $4, $5, $6, $7)",
                &[
                    &secret_id,
                    &project_id,
                    &user_id,
                    &name,
                    &description,
                    &nonce_b64,
                    &ciphertext_b64,
                ],
            )
            .await
    };

    match attempt_insert().await {
        Ok(_) => {}
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                ensure_secret_tables(&state.pool).await.map_err(|err| {
                    internal_error(format!("failed to create secrets tables: {err}"))
                })?;
                attempt_insert().await.map_err(|err| {
                    internal_error(format!("failed to insert secret after ensure: {err}"))
                })?;
            } else if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNIQUE_VIOLATION)
                .unwrap_or(false)
            {
                return Err(bad_request("secret name already exists"));
            } else {
                return Err(internal_error(format!("failed to insert secret: {error}")));
            }
        }
    }

    let attempt_insert_grants = || async {
        for handle in agent_handles.iter() {
            transaction
                .execute(
                    "insert into project_secret_agent_handle_grants (secret_id, agent_handle)
                     values ($1, $2)
                     on conflict do nothing",
                    &[&secret_id, handle],
                )
                .await?;
        }
        Ok::<(), tokio_postgres::Error>(())
    };

    match attempt_insert_grants().await {
        Ok(_) => {}
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                ensure_secret_tables(&state.pool).await.map_err(|err| {
                    internal_error(format!("failed to create secrets tables: {err}"))
                })?;
                attempt_insert_grants().await.map_err(|err| {
                    internal_error(format!("failed to insert grants after ensure: {err}"))
                })?;
            } else {
                return Err(internal_error(format!(
                    "failed to insert secret grants: {error}"
                )));
            }
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit create secret: {error}")))?;

    Ok(Json(CreateProjectSecretResponse {
        id: secret_id.to_string(),
    }))
}

async fn update_project_secret(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, secret_id_raw)): AxumPath<(String, String)>,
    Json(body): Json<UpdateProjectSecretBody>,
) -> Result<Json<ProjectSecretListItem>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("user session required"))?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let secret_id = Uuid::from_str(secret_id_raw.trim())
        .map_err(|_| bad_request("secretId must be a valid UUID"))?;

    let (description_present, description_next) = match body.description {
        Some(value) => (true, normalize_optional_description(value)?),
        None => (false, None),
    };
    let value = body
        .value
        .as_deref()
        .map(normalize_secret_value)
        .transpose()?;

    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| internal_error("credential encryption key missing"))?;

    let (nonce_b64, ciphertext_b64) = match value.as_deref() {
        Some(value) => {
            let (nonce, cipher) = encrypt_secret_payload(key, value.as_bytes())
                .map_err(|error| internal_error(format!("failed to encrypt secret: {error}")))?;
            (Some(nonce), Some(cipher))
        }
        None => (None, None),
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

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, None).await?;

    let attempt_update = || async {
        transaction
            .query_opt(
                "update project_secrets
                 set description = case when $3 then $4 else description end,
                     nonce_b64 = coalesce($5, nonce_b64),
                     ciphertext_b64 = coalesce($6, ciphertext_b64),
                     updated_at = now()
                 where id = $1 and project_id = $2 and revoked_at is null
                 returning id, name, description, last_used_at, revoked_at, created_at, updated_at",
                &[
                    &secret_id,
                    &project_id,
                    &description_present,
                    &description_next,
                    &nonce_b64,
                    &ciphertext_b64,
                ],
            )
            .await
    };

    let updated = match attempt_update().await {
        Ok(updated) => updated,
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                ensure_secret_tables(&state.pool).await.map_err(|err| {
                    internal_error(format!("failed to create secrets tables: {err}"))
                })?;
                attempt_update().await.map_err(|err| {
                    internal_error(format!("failed to update secret after ensure: {err}"))
                })?
            } else {
                return Err(internal_error(format!("failed to update secret: {error}")));
            }
        }
    };

    let Some(row) = updated else {
        return Err(not_found("secret not found"));
    };

    if body.agent_handles.is_some() || body.agent_ids.is_some() {
        let mut next_handles = body
            .agent_handles
            .as_ref()
            .map(|handles| normalize_agent_handles(handles))
            .transpose()?
            .unwrap_or_default();

        if next_handles.is_empty() {
            if let Some(ids) = body.agent_ids.as_ref() {
                let mut agent_ids: Vec<Uuid> = Vec::new();
                for raw in ids.iter() {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let id = Uuid::from_str(trimmed)
                        .map_err(|_| bad_request("agentIds must be UUIDs"))?;
                    agent_ids.push(id);
                }
                agent_ids.sort();
                agent_ids.dedup();
                if !agent_ids.is_empty() {
                    let rows = transaction
                        .query(
                            "select handle from user_agents where user_id = $1 and id = any($2::uuid[]) and deleted_at is null",
                            &[&user_id, &agent_ids],
                        )
                        .await
                        .map_err(|error| internal_error(format!("failed to validate agents: {error}")))?;
                    if rows.len() != agent_ids.len() {
                        return Err(bad_request("agentIds must belong to the signed-in user"));
                    }
                    let handles: Vec<String> = rows
                        .into_iter()
                        .map(|row| row.get::<_, String>("handle"))
                        .collect();
                    next_handles = normalize_agent_handles(&handles)?;
                }
            }
        }

        if next_handles.is_empty() {
            next_handles.push("octo".to_string());
        }

        // Clear both legacy and handle grants, then re-insert handle grants.
        let attempt_update_grants = || async {
            transaction
                .execute(
                    "delete from project_secret_agent_grants where secret_id = $1",
                    &[&secret_id],
                )
                .await?;
            transaction
                .execute(
                    "delete from project_secret_agent_handle_grants where secret_id = $1",
                    &[&secret_id],
                )
                .await?;
            for handle in next_handles.iter() {
                transaction
                    .execute(
                        "insert into project_secret_agent_handle_grants (secret_id, agent_handle)
                         values ($1, $2)
                         on conflict do nothing",
                        &[&secret_id, handle],
                    )
                    .await?;
            }
            Ok::<(), tokio_postgres::Error>(())
        };

        match attempt_update_grants().await {
            Ok(_) => {}
            Err(error) => {
                if error
                    .as_db_error()
                    .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                    .unwrap_or(false)
                {
                    ensure_secret_tables(&state.pool).await.map_err(|err| {
                        internal_error(format!("failed to create secrets tables: {err}"))
                    })?;
                    attempt_update_grants().await.map_err(|err| {
                        internal_error(format!(
                            "failed to update secret grants after ensure: {err}"
                        ))
                    })?;
                } else {
                    return Err(internal_error(format!(
                        "failed to update secret grants: {error}"
                    )));
                }
            }
        }
    }

    let mut agent_id_out: Vec<String> = Vec::new();
    let mut agent_handle_out: Vec<String> = Vec::new();

    if let Ok(grant_rows) = transaction
        .query(
            "select ua.id as agent_id, ua.handle
             from project_secret_agent_grants g
             join user_agents ua on ua.id = g.agent_id
             where g.secret_id = $1 and ua.deleted_at is null
             order by ua.handle asc",
            &[&secret_id],
        )
        .await
    {
        for row in grant_rows {
            let agent_id: Uuid = row.get("agent_id");
            let handle: String = row.get("handle");
            agent_id_out.push(agent_id.to_string());
            agent_handle_out.push(handle);
        }
    }

    let attempt_handle_grants = || async {
        transaction
            .query(
                "select agent_handle from project_secret_agent_handle_grants where secret_id = $1 order by agent_handle asc",
                &[&secret_id],
            )
            .await
    };

    let handle_grants = match attempt_handle_grants().await {
        Ok(rows) => rows,
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                ensure_secret_tables(&state.pool).await.map_err(|err| {
                    internal_error(format!("failed to create secrets tables: {err}"))
                })?;
                attempt_handle_grants().await.map_err(|err| {
                    internal_error(format!("failed to load secret grants after ensure: {err}"))
                })?
            } else {
                return Err(internal_error(format!(
                    "failed to load secret grants: {error}"
                )));
            }
        }
    };

    for row in handle_grants {
        let handle: String = row.get("agent_handle");
        agent_handle_out.push(handle);
    }

    agent_handle_out.sort();
    agent_handle_out.dedup();

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit update secret: {error}")))?;

    let id: Uuid = row.get("id");
    let name: String = row.get("name");
    let description: Option<String> = row.get("description");
    let last_used_at: Option<DateTime<Utc>> = row.get("last_used_at");
    let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");
    let created_at: DateTime<Utc> = row.get("created_at");
    let updated_at: DateTime<Utc> = row.get("updated_at");

    Ok(Json(ProjectSecretListItem {
        id: id.to_string(),
        name,
        description,
        agent_ids: agent_id_out,
        agent_handles: agent_handle_out,
        last_used_at: last_used_at.map(|dt| dt.to_rfc3339()),
        revoked_at: revoked_at.map(|dt| dt.to_rfc3339()),
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
    }))
}

async fn revoke_project_secret(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, secret_id_raw)): AxumPath<(String, String)>,
) -> Result<Json<RevokeProjectSecretResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let secret_id = Uuid::from_str(secret_id_raw.trim())
        .map_err(|_| bad_request("secretId must be a valid UUID"))?;

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

    let updated = transaction
        .execute(
            "update project_secrets
             set revoked_at = now(), updated_at = now()
             where id = $1 and project_id = $2 and revoked_at is null",
            &[&secret_id, &project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to revoke secret: {error}")))?;

    if updated == 0 {
        return Err(not_found("secret not found"));
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit revoke secret: {error}")))?;

    Ok(Json(RevokeProjectSecretResponse { ok: true }))
}

fn parse_agent_job_identity(payload: &JsonValue) -> (Option<Uuid>, Option<String>, Option<Uuid>) {
    let meta = payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .or_else(|| {
            payload
                .get("prompt_metadata")
                .and_then(JsonValue::as_object)
        });

    let user_id = meta
        .and_then(|map| map.get("userId").or_else(|| map.get("user_id")))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::from_str(value.trim()).ok());

    let agent_meta = meta
        .and_then(|map| map.get("agent"))
        .and_then(JsonValue::as_object);

    let agent_handle = agent_meta
        .and_then(|map| map.get("handle"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let agent_id = agent_meta
        .and_then(|map| map.get("id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::from_str(value.trim()).ok());

    (user_id, agent_handle, agent_id)
}

fn payload_uses_managed_ai(payload: &JsonValue) -> bool {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("managedAiUsed"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
}

fn apply_managed_ai_env_overrides(
    env: &mut JsonMap<String, JsonValue>,
    config: &crate::config::AppConfig,
    payload: &JsonValue,
) {
    if !payload_uses_managed_ai(payload) {
        return;
    }

    env.insert(
        "CODEX_MODEL".to_string(),
        JsonValue::String(config.managed_ai_model_id.clone()),
    );
    env.insert(
        "CODEX_MODEL_PROVIDER".to_string(),
        JsonValue::String(DEFAULT_MANAGED_AI_PROVIDER_ID.to_string()),
    );
}

/// Resolved per-agent runtime overrides loaded from `user_agents`. `model` is
/// provider-resolved; `reasoning_effort` is the raw per-agent value (one of
/// minimal|low|medium|high, already normalized on write) or None to inherit.
struct AgentRuntimeOverrides {
    model: Option<String>,
    reasoning_effort: Option<String>,
}

fn read_agent_reasoning_effort(row: &tokio_postgres::Row) -> Option<String> {
    row.get::<_, Option<String>>("reasoning_effort")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn load_agent_model(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: &Uuid,
    agent_id: Option<&Uuid>,
    agent_handle: Option<&str>,
) -> Result<AgentRuntimeOverrides, (StatusCode, Json<ApiError>)> {
    if let Some(agent_id) = agent_id {
        let row = transaction
            .query_opt(
                "select provider, model, reasoning_effort
                 from user_agents
                 where id = $1 and user_id = $2 and deleted_at is null
                 limit 1",
                &[agent_id, user_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load agent model: {error}")))?;
        let Some(row) = row else {
            return Ok(AgentRuntimeOverrides {
                model: None,
                reasoning_effort: None,
            });
        };
        let provider: String = row.get("provider");
        let provider = resolve_effective_agent_model_provider(transaction, user_id, &provider)
            .await?
            .unwrap_or(provider);
        let model = row
            .get::<_, Option<String>>("model")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let reasoning_effort = read_agent_reasoning_effort(&row);
        return Ok(AgentRuntimeOverrides {
            model: resolve_agent_model_for_provider(&provider, model),
            reasoning_effort,
        });
    }

    let Some(handle) = agent_handle else {
        return Ok(AgentRuntimeOverrides {
            model: None,
            reasoning_effort: None,
        });
    };
    let trimmed = handle.trim().trim_start_matches('@').trim();
    if trimmed.is_empty() {
        return Ok(AgentRuntimeOverrides {
            model: None,
            reasoning_effort: None,
        });
    }

    let row = transaction
        .query_opt(
            "select provider, model, reasoning_effort
             from user_agents
             where user_id = $1 and lower(handle) = lower($2) and deleted_at is null
             limit 1",
            &[user_id, &trimmed],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load agent model: {error}")))?;

    let Some(row) = row else {
        return Ok(AgentRuntimeOverrides {
            model: None,
            reasoning_effort: None,
        });
    };
    let provider: String = row.get("provider");
    let provider = resolve_effective_agent_model_provider(transaction, user_id, &provider)
        .await?
        .unwrap_or(provider);
    let model = row
        .get::<_, Option<String>>("model")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let reasoning_effort = read_agent_reasoning_effort(&row);
    Ok(AgentRuntimeOverrides {
        model: resolve_agent_model_for_provider(&provider, model),
        reasoning_effort,
    })
}

async fn resolve_effective_agent_model_provider(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: &Uuid,
    provider: &str,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    if !provider.eq_ignore_ascii_case("assistant") {
        return Ok(Some(provider.to_string()));
    }

    let row = transaction
        .query_opt(
            "select kind, metadata
             from user_credentials
             where user_id = $1 and is_default = true and revoked_at is null
             order by updated_at desc, created_at desc
             limit 1",
            &[user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load default credential provider for agent model: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Ok(None);
    };

    let kind: String = row.get("kind");
    let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
    Ok(Some(crate::credentials::provider_for_credential(
        &kind, &metadata,
    )))
}

async fn agent_secrets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AgentSecretsRequest>,
) -> Result<Json<AgentSecretsResponse>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.secrets"])?;
    let project_id = claims.project_id;
    let runtime_scope = claims.runtime_id;

    let job_id = Uuid::from_str(body.job_id.trim())
        .map_err(|_| bad_request("jobId must be a valid UUID"))?;

    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| internal_error("credential encryption key missing"))?;

    if let Err(error) = ensure_secret_tables(&state.pool).await {
        tracing::warn!(
            ?error,
            "failed to ensure secret tables before agent secrets"
        );
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

    if let Some(runtime_id) = runtime_scope.as_ref() {
        ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, runtime_id).await?;
    }

    let row = transaction
        .query_opt(
            "select id, status, leased_by_runtime_id, payload, credential_id
             from agent_jobs
             where id = $1 and project_id = $2
             limit 1",
            &[&job_id, &project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load agent job: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("job not found"));
    };

    let status: String = row.get("status");
    if status != "leased" {
        return Err(bad_request("job is not leased"));
    }

    let leased_by_runtime_id: Option<Uuid> = row.get("leased_by_runtime_id");
    if let Some(required_runtime) = runtime_scope {
        if leased_by_runtime_id != Some(required_runtime) {
            return Err(unauthorized("job must be leased by this runtime"));
        }
    } else if state.config.strict_mode {
        return Err(unauthorized(
            "agent token missing runtime scope while strict mode is enabled",
        ));
    }

    let payload: JsonValue = row.get::<_, PgJson<JsonValue>>("payload").0;
    let touch = body.touch.unwrap_or(true);

    let (user_id, agent_handle_raw, agent_id) = parse_agent_job_identity(&payload);
    let agent_handle = agent_handle_raw
        .as_deref()
        .map(|value| value.trim().trim_start_matches('@').trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());

    if agent_handle.is_none() && agent_id.is_none() {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to commit agent secrets: {error}")))?;
        return Ok(Json(AgentSecretsResponse {
            env: JsonValue::Object(JsonMap::new()),
            inventory: Vec::new(),
        }));
    }

    let mut env = JsonMap::new();
    let mut secret_ids: Vec<Uuid> = Vec::new();
    let mut seen_secret_ids: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    let mut inventory_by_secret_id: std::collections::HashMap<Uuid, AgentSecretInventoryItem> =
        std::collections::HashMap::new();

    if let Some(user_id) = user_id.as_ref() {
        if let Ok(overrides) = load_agent_model(
            &transaction,
            user_id,
            agent_id.as_ref(),
            agent_handle_raw.as_deref(),
        )
        .await
        {
            if let Some(model) = overrides.model {
                env.entry("CODEX_MODEL".to_string())
                    .or_insert(JsonValue::String(model));
            }
            // Emit the per-agent reasoning effort only when the agent actually sets
            // one. When it is null we omit the key entirely so the runtime keeps its
            // existing per-job / global reasoning behavior. Use a distinct key from
            // the proxy's global CODEX_REASONING_EFFORT fallback.
            if let Some(reasoning_effort) = overrides.reasoning_effort {
                env.entry("CODEX_AGENT_REASONING_EFFORT".to_string())
                    .or_insert(JsonValue::String(reasoning_effort));
            }
        }
    }

    if let Some(handle) = agent_handle.as_deref() {
        let attempt = || async {
            transaction
                .query(
                    "select ps.id, ps.name, ps.description, ps.nonce_b64, ps.ciphertext_b64
                     from project_secrets ps
                     join project_secret_agent_handle_grants g on g.secret_id = ps.id
                     where ps.project_id = $1
                       and ps.revoked_at is null
                       and lower(g.agent_handle) = lower($2)
                     order by ps.updated_at asc",
                    &[&project_id, &handle],
                )
                .await
        };
        let rows = match attempt().await {
            Ok(rows) => rows,
            Err(error) => {
                if error
                    .as_db_error()
                    .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                    .unwrap_or(false)
                {
                    // Tables may not exist yet; treat as empty.
                    Vec::new()
                } else {
                    return Err(internal_error(format!(
                        "failed to load secret handle grants: {error}"
                    )));
                }
            }
        };

        for row in rows {
            let secret_id: Uuid = row.get("id");
            if !seen_secret_ids.insert(secret_id) {
                continue;
            }
            let name: String = row.get("name");
            let description: Option<String> = row.get("description");
            let nonce_b64: String = row.get("nonce_b64");
            let ciphertext_b64: String = row.get("ciphertext_b64");
            let plaintext =
                decrypt_secret_payload(key, &nonce_b64, &ciphertext_b64).map_err(|error| {
                    internal_error(format!("failed to decrypt secret payload: {error}"))
                })?;
            let value = String::from_utf8(plaintext)
                .map_err(|_| internal_error("secret payload must be utf-8"))?;
            env.insert(name.clone(), JsonValue::String(value));
            inventory_by_secret_id
                .insert(secret_id, AgentSecretInventoryItem { name, description });
            secret_ids.push(secret_id);
        }
    }

    if let Some(agent_id) = agent_id.as_ref() {
        let attempt = || async {
            transaction
                .query(
                    "select ps.id, ps.name, ps.description, ps.nonce_b64, ps.ciphertext_b64
                     from project_secrets ps
                     join project_secret_agent_grants g on g.secret_id = ps.id
                     where ps.project_id = $1
                       and ps.revoked_at is null
                       and g.agent_id = $2
                     order by ps.updated_at asc",
                    &[&project_id, agent_id],
                )
                .await
        };

        let rows = match attempt().await {
            Ok(rows) => rows,
            Err(error) => {
                if error
                    .as_db_error()
                    .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                    .unwrap_or(false)
                {
                    Vec::new()
                } else {
                    return Err(internal_error(format!(
                        "failed to load secret grants: {error}"
                    )));
                }
            }
        };

        for row in rows {
            let secret_id: Uuid = row.get("id");
            if !seen_secret_ids.insert(secret_id) {
                continue;
            }
            let name: String = row.get("name");
            let description: Option<String> = row.get("description");
            let nonce_b64: String = row.get("nonce_b64");
            let ciphertext_b64: String = row.get("ciphertext_b64");
            let plaintext =
                decrypt_secret_payload(key, &nonce_b64, &ciphertext_b64).map_err(|error| {
                    internal_error(format!("failed to decrypt secret payload: {error}"))
                })?;
            let value = String::from_utf8(plaintext)
                .map_err(|_| internal_error("secret payload must be utf-8"))?;
            env.insert(name.clone(), JsonValue::String(value));
            inventory_by_secret_id
                .insert(secret_id, AgentSecretInventoryItem { name, description });
            secret_ids.push(secret_id);
        }
    }

    if touch && !secret_ids.is_empty() {
        let _ = transaction
            .execute(
                "update project_secrets
                 set last_used_at = now(), updated_at = now()
                 where id = any($1::uuid[])",
                &[&secret_ids],
            )
            .await;
    }

    apply_managed_ai_env_overrides(&mut env, &state.config, &payload);

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit agent secrets: {error}")))?;

    let mut inventory: Vec<AgentSecretInventoryItem> =
        inventory_by_secret_id.into_values().collect();
    inventory.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(Json(AgentSecretsResponse {
        env: JsonValue::Object(env),
        inventory,
    }))
}

#[cfg(test)]
mod tests {
    use super::apply_managed_ai_env_overrides;
    use crate::model_defaults::default_managed_ai_model_id;
    use crate::tests::build_app_config;
    use serde_json::{json, Map as JsonMap, Value as JsonValue};

    #[test]
    fn managed_ai_env_override_forces_managed_model_and_provider() {
        let config = build_app_config("test-private", "test-public", "test-key");
        let payload = json!({
            "metadata": {
                "managedAiUsed": true
            }
        });
        let mut env = JsonMap::new();
        env.insert(
            "CODEX_MODEL".to_string(),
            JsonValue::String("glm-4.5".to_string()),
        );
        env.insert(
            "CODEX_MODEL_PROVIDER".to_string(),
            JsonValue::String("zai".to_string()),
        );

        apply_managed_ai_env_overrides(&mut env, &config, &payload);

        assert_eq!(
            env.get("CODEX_MODEL").and_then(JsonValue::as_str),
            Some(default_managed_ai_model_id())
        );
        assert_eq!(
            env.get("CODEX_MODEL_PROVIDER").and_then(JsonValue::as_str),
            Some("openai")
        );
    }

    #[test]
    fn non_managed_ai_env_override_leaves_existing_model_alone() {
        let config = build_app_config("test-private", "test-public", "test-key");
        let payload = json!({
            "metadata": {
                "managedAiUsed": false
            }
        });
        let mut env = JsonMap::new();
        env.insert(
            "CODEX_MODEL".to_string(),
            JsonValue::String("glm-4.5".to_string()),
        );

        apply_managed_ai_env_overrides(&mut env, &config, &payload);

        assert_eq!(
            env.get("CODEX_MODEL").and_then(JsonValue::as_str),
            Some("glm-4.5")
        );
    }
}
