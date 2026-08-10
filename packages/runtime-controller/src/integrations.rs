use std::collections::HashSet;
use std::str::FromStr;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::{GenericClient, Row};
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::config::PgPool;
use crate::projects::load_project_record;
use crate::{
    bad_request, ensure_project_access, ensure_project_write_access, internal_error, unauthorized,
    ApiError, AppState,
};

const PROVIDER_MAX_LEN: usize = 64;
const STATUS_MAX_LEN: usize = 32;
const CONNECTION_TYPE_MAX_LEN: usize = 32;
const CAPABILITY_MAX_LEN: usize = 128;
const SCOPE_MAX_LEN: usize = 128;
const MAX_LIST_ENTRIES: usize = 64;

fn project_integrations_storage_unavailable() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError::with_details(
            "Project integration storage is not ready. Please try again shortly.",
            "project_integrations_storage_unavailable",
            json!({ "retryable": true }),
        )),
    )
}

async fn project_integrations_storage_exists(
    client: &impl GenericClient,
) -> Result<bool, tokio_postgres::Error> {
    client
        .query_one(
            "select to_regclass('public.project_integrations') is not null as ready",
            &[],
        )
        .await
        .map(|row| row.get::<_, bool>("ready"))
}

pub(crate) async fn require_project_integrations_storage(
    client: &impl GenericClient,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let ready = project_integrations_storage_exists(client)
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect project integration storage: {error}"
            ))
        })?;
    if !ready {
        return Err(project_integrations_storage_unavailable());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrationProviderDescriptor {
    id: String,
    display_name: String,
    description: String,
    auth_methods: Vec<String>,
    default_secret_names: Vec<String>,
    default_scopes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIntegrationItem {
    id: String,
    project_id: String,
    provider: String,
    status: String,
    connection_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_id: Option<String>,
    metadata: JsonValue,
    required_scopes: Vec<String>,
    capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertProjectIntegrationBody {
    status: Option<String>,
    connection_type: Option<String>,
    credential_id: Option<String>,
    metadata: Option<JsonValue>,
    required_scopes: Option<Vec<String>>,
    capabilities: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectIntegrationUpsert {
    pub(crate) status: String,
    pub(crate) connection_type: String,
    pub(crate) credential_id: Option<Uuid>,
    pub(crate) metadata: JsonValue,
    pub(crate) required_scopes: Vec<String>,
    pub(crate) capabilities: Vec<String>,
}

impl Default for ProjectIntegrationUpsert {
    fn default() -> Self {
        Self {
            status: "connected".to_string(),
            connection_type: "oauth".to_string(),
            credential_id: None,
            metadata: json!({}),
            required_scopes: Vec::new(),
            capabilities: Vec::new(),
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/integrations/providers", get(list_integration_providers))
        .route(
            "/projects/:project_id/integrations",
            get(list_project_integrations),
        )
        .route(
            "/projects/:project_id/integrations/:provider",
            get(get_project_integration).put(upsert_project_integration),
        )
}

async fn list_integration_providers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<IntegrationProviderDescriptor>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    // Provider catalogs should be dynamic and AI/skill-driven; avoid hardcoding
    // integrations in the controller.
    Ok(Json(Vec::new()))
}

async fn get_project_integration(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, provider_raw)): AxumPath<(String, String)>,
) -> Result<Json<Option<ProjectIntegrationItem>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let provider =
        normalize_provider_identifier(provider_raw.as_str(), "provider", PROVIDER_MAX_LEN, true)?;

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
    require_project_integrations_storage(&transaction).await?;
    let row = load_project_integration_row(&transaction, &project_id, &provider)
        .await
        .map_err(|error| internal_error(format!("failed to load project integration: {error}")))?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit integration fetch: {error}")))?;

    Ok(Json(row.as_ref().map(row_to_project_integration_item)))
}

async fn list_project_integrations(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
) -> Result<Json<Vec<ProjectIntegrationItem>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

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

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, None).await?;
    require_project_integrations_storage(&transaction).await?;
    let rows = load_project_integrations_rows(&transaction, &project_id)
        .await
        .map_err(|error| internal_error(format!("failed to list project integrations: {error}")))?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit integration list: {error}")))?;

    let items = rows.iter().map(row_to_project_integration_item).collect();
    Ok(Json(items))
}

async fn upsert_project_integration(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, provider_raw)): AxumPath<(String, String)>,
    Json(body): Json<UpsertProjectIntegrationBody>,
) -> Result<Json<ProjectIntegrationItem>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let provider =
        normalize_provider_identifier(provider_raw.as_str(), "provider", PROVIDER_MAX_LEN, true)?;

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
    require_project_integrations_storage(&transaction).await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit integration auth: {error}")))?;

    let status = normalize_status(body.status)?;
    let connection_type = normalize_connection_type(body.connection_type)?;
    let credential_id = parse_optional_uuid(body.credential_id.as_deref(), "credentialId")?;
    let required_scopes = normalize_string_list(
        body.required_scopes.as_deref(),
        "requiredScopes",
        MAX_LIST_ENTRIES,
        SCOPE_MAX_LEN,
        true,
    )?;
    let capabilities = normalize_string_list(
        body.capabilities.as_deref(),
        "capabilities",
        MAX_LIST_ENTRIES,
        CAPABILITY_MAX_LEN,
        true,
    )?;
    let metadata = normalize_metadata(body.metadata);

    upsert_project_integration_record(
        &state,
        project_id,
        &provider,
        context.user_id,
        ProjectIntegrationUpsert {
            status,
            connection_type,
            credential_id,
            metadata,
            required_scopes,
            capabilities,
        },
    )
    .await
    .map_err(|error| internal_error(format!("failed to upsert project integration: {error}")))?;

    let item = load_project_integration_item(&state.pool, &project_id, &provider)
        .await
        .map_err(|error| internal_error(format!("failed to load project integration: {error}")))?
        .ok_or_else(|| internal_error("project integration was not found after upsert"))?;

    Ok(Json(item))
}

pub(crate) async fn upsert_project_integration_record(
    state: &AppState,
    project_id: Uuid,
    provider: &str,
    created_by: Option<Uuid>,
    input: ProjectIntegrationUpsert,
) -> anyhow::Result<()> {
    let normalized_provider =
        normalize_provider_identifier_anyhow(provider, "provider", PROVIDER_MAX_LEN, true)?;
    let status =
        normalize_identifier_anyhow(input.status.as_str(), "status", STATUS_MAX_LEN, true)?;
    let connection_type = normalize_identifier_anyhow(
        input.connection_type.as_str(),
        "connectionType",
        CONNECTION_TYPE_MAX_LEN,
        true,
    )?;

    let required_scopes = normalize_string_list_anyhow(
        &input.required_scopes,
        "requiredScopes",
        MAX_LIST_ENTRIES,
        SCOPE_MAX_LEN,
        true,
    )?;
    let capabilities = normalize_string_list_anyhow(
        &input.capabilities,
        "capabilities",
        MAX_LIST_ENTRIES,
        CAPABILITY_MAX_LEN,
        true,
    )?;

    let metadata = normalize_metadata(Some(input.metadata));

    let required_scopes_json = JsonValue::Array(
        required_scopes
            .iter()
            .map(|value| JsonValue::String(value.clone()))
            .collect(),
    );
    let capabilities_json = JsonValue::Array(
        capabilities
            .iter()
            .map(|value| JsonValue::String(value.clone()))
            .collect(),
    );

    let connection = state.pool.get().await?;
    anyhow::ensure!(
        project_integrations_storage_exists(&*connection).await?,
        "project integration storage is not ready"
    );
    let integration_id = Uuid::new_v4();
    let metadata_pg = PgJson(&metadata);
    let required_scopes_pg = PgJson(&required_scopes_json);
    let capabilities_pg = PgJson(&capabilities_json);

    connection
        .execute(
            "insert into project_integrations (
                     id, project_id, provider, status, connection_type, credential_id,
                     metadata, required_scopes, capabilities, created_by
                 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 on conflict (project_id, provider) do update set
                   status = excluded.status,
                   connection_type = excluded.connection_type,
                   credential_id = coalesce(excluded.credential_id, project_integrations.credential_id),
                   metadata = excluded.metadata,
                   required_scopes = excluded.required_scopes,
                   capabilities = excluded.capabilities,
                   created_by = coalesce(project_integrations.created_by, excluded.created_by),
                   updated_at = now()",
            &[
                &integration_id,
                &project_id,
                &normalized_provider,
                &status,
                &connection_type,
                &input.credential_id,
                &metadata_pg,
                &required_scopes_pg,
                &capabilities_pg,
                &created_by,
            ],
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!("failed to upsert project integration row: {error}")
        })?;
    Ok(())
}

/// Writes integration metadata only when the row is still in the state the
/// caller observed before a long-running operation. `None` means the caller
/// observed no row, so a concurrently-created row wins. This keeps a later
/// disconnect/account switch from being overwritten after an import.
pub(crate) async fn upsert_project_integration_record_if_unchanged(
    state: &AppState,
    project_id: Uuid,
    provider: &str,
    created_by: Option<Uuid>,
    input: ProjectIntegrationUpsert,
    expected_updated_at: Option<DateTime<Utc>>,
) -> anyhow::Result<bool> {
    let normalized_provider =
        normalize_provider_identifier_anyhow(provider, "provider", PROVIDER_MAX_LEN, true)?;
    let status =
        normalize_identifier_anyhow(input.status.as_str(), "status", STATUS_MAX_LEN, true)?;
    let connection_type = normalize_identifier_anyhow(
        input.connection_type.as_str(),
        "connectionType",
        CONNECTION_TYPE_MAX_LEN,
        true,
    )?;
    let required_scopes = normalize_string_list_anyhow(
        &input.required_scopes,
        "requiredScopes",
        MAX_LIST_ENTRIES,
        SCOPE_MAX_LEN,
        true,
    )?;
    let capabilities = normalize_string_list_anyhow(
        &input.capabilities,
        "capabilities",
        MAX_LIST_ENTRIES,
        CAPABILITY_MAX_LEN,
        true,
    )?;
    let metadata = normalize_metadata(Some(input.metadata));
    let required_scopes_json = JsonValue::Array(
        required_scopes
            .iter()
            .map(|value| JsonValue::String(value.clone()))
            .collect(),
    );
    let capabilities_json = JsonValue::Array(
        capabilities
            .iter()
            .map(|value| JsonValue::String(value.clone()))
            .collect(),
    );

    let connection = state.pool.get().await?;
    anyhow::ensure!(
        project_integrations_storage_exists(&*connection).await?,
        "project integration storage is not ready"
    );
    let integration_id = Uuid::new_v4();
    let metadata_pg = PgJson(&metadata);
    let required_scopes_pg = PgJson(&required_scopes_json);
    let capabilities_pg = PgJson(&capabilities_json);
    let result = if let Some(expected_updated_at) = expected_updated_at.as_ref() {
        connection
            .execute(
                "update project_integrations
                     set status = $3,
                         connection_type = $4,
                         credential_id = coalesce($5, credential_id),
                         metadata = $6,
                         required_scopes = $7,
                         capabilities = $8,
                         created_by = coalesce(created_by, $9),
                         updated_at = now()
                     where project_id = $1 and provider = $2 and updated_at = $10",
                &[
                    &project_id,
                    &normalized_provider,
                    &status,
                    &connection_type,
                    &input.credential_id,
                    &metadata_pg,
                    &required_scopes_pg,
                    &capabilities_pg,
                    &created_by,
                    expected_updated_at,
                ],
            )
            .await
    } else {
        connection
            .execute(
                "insert into project_integrations (
                         id, project_id, provider, status, connection_type, credential_id,
                         metadata, required_scopes, capabilities, created_by
                     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     on conflict (project_id, provider) do nothing",
                &[
                    &integration_id,
                    &project_id,
                    &normalized_provider,
                    &status,
                    &connection_type,
                    &input.credential_id,
                    &metadata_pg,
                    &required_scopes_pg,
                    &capabilities_pg,
                    &created_by,
                ],
            )
            .await
    };

    result.map(|updated| updated == 1).map_err(|error| {
        anyhow::anyhow!("failed to conditionally upsert project integration row: {error}")
    })
}

fn normalize_status(value: Option<String>) -> Result<String, (StatusCode, Json<ApiError>)> {
    let input = value.unwrap_or_else(|| "connected".to_string());
    normalize_identifier(input.as_str(), "status", STATUS_MAX_LEN, true)
}

fn normalize_connection_type(
    value: Option<String>,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let input = value.unwrap_or_else(|| "oauth".to_string());
    normalize_identifier(
        input.as_str(),
        "connectionType",
        CONNECTION_TYPE_MAX_LEN,
        true,
    )
}

fn normalize_metadata(value: Option<JsonValue>) -> JsonValue {
    match value {
        Some(JsonValue::Object(map)) => JsonValue::Object(map),
        _ => json!({}),
    }
}

fn parse_optional_uuid(
    value: Option<&str>,
    field_name: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Uuid::parse_str(trimmed)
        .map(Some)
        .map_err(|_| bad_request(format!("{field_name} must be a valid UUID")))
}

fn normalize_string_list(
    values: Option<&[String]>,
    field_name: &str,
    max_items: usize,
    max_len: usize,
    lowercase: bool,
) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in values.unwrap_or(&[]) {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > max_len {
            return Err(bad_request(format!(
                "{field_name} entries are too long (max {max_len} chars)"
            )));
        }
        let normalized = if lowercase {
            trimmed.to_ascii_lowercase()
        } else {
            trimmed.to_string()
        };
        if !seen.insert(normalized.clone()) {
            continue;
        }
        out.push(normalized);
        if out.len() >= max_items {
            break;
        }
    }
    Ok(out)
}

fn normalize_identifier(
    value: &str,
    field_name: &str,
    max_len: usize,
    lowercase: bool,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(bad_request(format!("{field_name} is required")));
    }
    if trimmed.len() > max_len {
        return Err(bad_request(format!(
            "{field_name} is too long (max {max_len} chars)"
        )));
    }

    let normalized = if lowercase {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    };

    if !normalized
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(bad_request(format!(
            "{field_name} must contain only letters, numbers, '_' or '-'"
        )));
    }

    Ok(normalized)
}

fn normalize_provider_identifier(
    value: &str,
    field_name: &str,
    max_len: usize,
    lowercase: bool,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(bad_request(format!("{field_name} is required")));
    }
    if trimmed.len() > max_len {
        return Err(bad_request(format!(
            "{field_name} is too long (max {max_len} chars)"
        )));
    }

    let normalized = if lowercase {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    };

    if !normalized.bytes().all(is_valid_provider_identifier_byte) {
        return Err(bad_request(format!(
            "{field_name} must contain only letters, numbers, '_', '-', or ':'"
        )));
    }

    Ok(normalized)
}

fn normalize_identifier_anyhow(
    value: &str,
    field_name: &str,
    max_len: usize,
    lowercase: bool,
) -> anyhow::Result<String> {
    let trimmed = value.trim();
    anyhow::ensure!(!trimmed.is_empty(), "{field_name} is required");
    anyhow::ensure!(
        trimmed.len() <= max_len,
        "{field_name} is too long (max {max_len} chars)"
    );

    let normalized = if lowercase {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    };

    anyhow::ensure!(
        normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
        "{field_name} must contain only letters, numbers, '_' or '-'"
    );

    Ok(normalized)
}

fn normalize_provider_identifier_anyhow(
    value: &str,
    field_name: &str,
    max_len: usize,
    lowercase: bool,
) -> anyhow::Result<String> {
    let trimmed = value.trim();
    anyhow::ensure!(!trimmed.is_empty(), "{field_name} is required");
    anyhow::ensure!(
        trimmed.len() <= max_len,
        "{field_name} is too long (max {max_len} chars)"
    );

    let normalized = if lowercase {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    };

    anyhow::ensure!(
        normalized.bytes().all(is_valid_provider_identifier_byte),
        "{field_name} must contain only letters, numbers, '_', '-', or ':'"
    );

    Ok(normalized)
}

fn is_valid_provider_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b':'
}

fn normalize_string_list_anyhow(
    values: &[String],
    field_name: &str,
    max_items: usize,
    max_len: usize,
    lowercase: bool,
) -> anyhow::Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for entry in values {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        anyhow::ensure!(
            trimmed.len() <= max_len,
            "{field_name} entries are too long (max {max_len} chars)"
        );
        let normalized = if lowercase {
            trimmed.to_ascii_lowercase()
        } else {
            trimmed.to_string()
        };
        if !seen.insert(normalized.clone()) {
            continue;
        }
        out.push(normalized);
        if out.len() >= max_items {
            break;
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_identifier, normalize_provider_identifier, normalize_provider_identifier_anyhow,
        PROVIDER_MAX_LEN,
    };

    #[test]
    fn provider_identifier_accepts_instance_separator() {
        assert_eq!(
            normalize_provider_identifier(" Camera:Phone_01 ", "provider", PROVIDER_MAX_LEN, true)
                .unwrap(),
            "camera:phone_01"
        );
        assert_eq!(
            normalize_provider_identifier_anyhow(
                "camera:pixel-test-device",
                "provider",
                PROVIDER_MAX_LEN,
                true
            )
            .unwrap(),
            "camera:pixel-test-device"
        );
    }

    #[test]
    fn generic_identifier_stays_strict() {
        assert!(normalize_identifier("camera:phone_01", "status", 32, true).is_err());
    }
}

async fn load_project_integrations_rows(
    client: &impl GenericClient,
    project_id: &Uuid,
) -> Result<Vec<Row>, tokio_postgres::Error> {
    client
        .query(
            "select id, project_id, provider, status, connection_type, credential_id,
                    metadata, required_scopes, capabilities, created_by, created_at, updated_at
             from project_integrations
             where project_id = $1
             order by provider asc",
            &[project_id],
        )
        .await
}

async fn load_project_integration_row(
    client: &impl GenericClient,
    project_id: &Uuid,
    provider: &str,
) -> Result<Option<Row>, tokio_postgres::Error> {
    client
        .query_opt(
            "select id, project_id, provider, status, connection_type, credential_id,
                    metadata, required_scopes, capabilities, created_by, created_at, updated_at
             from project_integrations
             where project_id = $1 and provider = $2
             limit 1",
            &[project_id, &provider],
        )
        .await
}

async fn load_project_integration_item(
    pool: &PgPool,
    project_id: &Uuid,
    provider: &str,
) -> anyhow::Result<Option<ProjectIntegrationItem>> {
    let connection = pool.get().await?;
    anyhow::ensure!(
        project_integrations_storage_exists(&*connection).await?,
        "project integration storage is not ready"
    );
    let row = load_project_integration_row(&*connection, project_id, provider)
        .await
        .map_err(|error| anyhow::anyhow!("failed to load project integration row: {error}"))?;
    Ok(row.as_ref().map(row_to_project_integration_item))
}

fn row_to_project_integration_item(row: &Row) -> ProjectIntegrationItem {
    let id: Uuid = row.get("id");
    let project_id: Uuid = row.get("project_id");
    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let connection_type: String = row.get("connection_type");
    let credential_id: Option<Uuid> = row.get("credential_id");
    let metadata_json: PgJson<JsonValue> = row.get("metadata");
    let required_scopes_json: PgJson<JsonValue> = row.get("required_scopes");
    let capabilities_json: PgJson<JsonValue> = row.get("capabilities");
    let created_by: Option<Uuid> = row.get("created_by");
    let created_at: DateTime<Utc> = row.get("created_at");
    let updated_at: DateTime<Utc> = row.get("updated_at");

    ProjectIntegrationItem {
        id: id.to_string(),
        project_id: project_id.to_string(),
        provider,
        status,
        connection_type,
        credential_id: credential_id.map(|value| value.to_string()),
        metadata: metadata_json.0,
        required_scopes: parse_json_string_array(&required_scopes_json.0),
        capabilities: parse_json_string_array(&capabilities_json.0),
        created_by: created_by.map(|value| value.to_string()),
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
    }
}

fn parse_json_string_array(value: &JsonValue) -> Vec<String> {
    let Some(entries) = value.as_array() else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in entries {
        let Some(raw) = entry.as_str() else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let dedupe_key = trimmed.to_ascii_lowercase();
        if !seen.insert(dedupe_key) {
            continue;
        }
        out.push(trimmed.to_string());
        if out.len() >= MAX_LIST_ENTRIES {
            break;
        }
    }
    out
}
