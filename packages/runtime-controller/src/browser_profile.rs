//! Durable per-project browser profile storage (spec step 1, shared tier).
//!
//! The agent's headed Chromium runs on the runtime's ephemeral disk, and in the
//! hosted case that disk does not survive a runtime restart (only git-canonical
//! content does, and browser cookies must never touch the user's repo). So the
//! runtime snapshots a pruned profile (cookies/localStorage/IndexedDB, not
//! caches) and uploads it here; the controller encrypts it at rest and hands it
//! back to the next runtime. This reuses the exact encryption + agent-token auth
//! + per-project scoping that `project_secrets` already uses.
//!
//! Only the shared `project` scope is implemented; the per-user `private` scope
//! needs per-user key management (spec step 3) and is rejected until then.

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent::{
    ensure_agent_token_matches_runtime_lease, extract_agent_token, verify_agent_token_with_scopes,
};
use crate::auth::{authenticate_request, require_user_session};
use crate::config::PgPool;
use crate::{
    bad_request, ensure_project_access, ensure_project_write_access, forbidden, internal_error,
    load_project_record, not_found, unauthorized, ApiError, AppState,
};

const BROWSER_PROFILE_SCOPE_PROJECT: &str = "project";
const AGENT_BROWSER_PROFILE_SCOPE: &str = "agent.browser_profile";
/// Generous ceiling on a stored (plaintext) profile. A profile pruned to the
/// auth surface is well under 1MB; anything larger means the runtime failed to
/// prune and we reject rather than store megabytes of caches.
const BROWSER_PROFILE_MAX_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/agent/browser-profile",
            get(get_browser_profile)
                .put(reject_legacy_browser_profile_upload)
                // Profiles are up to a few MB, above axum's 2MB default extractor
                // cap; align the limit with the handler's own size check.
                .layer(DefaultBodyLimit::max(BROWSER_PROFILE_MAX_BYTES)),
        )
        .route(
            "/agent/browser-profile/v2",
            axum::routing::put(put_browser_profile)
                .layer(DefaultBodyLimit::max(BROWSER_PROFILE_MAX_BYTES)),
        )
        .route(
            "/projects/:project_id/browser-profile",
            axum::routing::delete(reset_browser_profile),
        )
        .route(
            "/projects/:project_id/browser-profile/status",
            get(get_browser_profile_status),
        )
}

fn conflict(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::CONFLICT, Json(ApiError::new(message)))
}

fn is_supported_scope(scope: &str) -> bool {
    // Allowlist also guarantees a safe value for the (project_id, scope) key.
    scope == BROWSER_PROFILE_SCOPE_PROJECT
}

fn ensure_browser_profile_persistence_enabled(
    config: &crate::config::AppConfig,
    project_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if config.browser_profile_persistence_enabled_for_project(project_id) {
        Ok(())
    } else {
        Err(forbidden(
            "browser profile persistence is not enabled for this project",
        ))
    }
}

async fn ensure_browser_profile_runtime_is_managed_cloud(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select provider, capabilities
             from runtimes
             where id = $1 and project_id = $2
             for share",
            &[runtime_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate browser profile runtime provider: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Err(unauthorized(
            "agent token runtime is not registered for project",
        ));
    };

    let provider: String = row.get("provider");
    let capabilities: serde_json::Value = row.get("capabilities");
    if !crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(&provider)
        || crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities)
    {
        return Err(forbidden(
            "browser profile persistence is available only on managed Instafy Cloud runtimes",
        ));
    }

    Ok(())
}

fn required_browser_profile_version(
    expected: Option<i64>,
) -> Result<i64, (StatusCode, Json<ApiError>)> {
    let expected = expected.ok_or_else(|| {
        (
            StatusCode::PRECONDITION_REQUIRED,
            Json(ApiError::new(
                "browser profile uploads require the version restored by this runtime; upgrade the runtime before saving",
            )),
        )
    })?;
    if !(0..i64::MAX).contains(&expected) {
        return Err(bad_request("browser profile version is out of range"));
    }
    Ok(expected)
}

#[derive(Debug, Deserialize)]
struct BrowserProfileQuery {
    scope: Option<String>,
    /// Required for PUT: version of the restored profile (0 for an empty store).
    /// Missing preconditions fail with 428; stale writers fail with 409.
    version: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserProfileManifest {
    scope: String,
    version: i64,
    bytes: i64,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserProfileResetResponse {
    ok: bool,
    cleared: bool,
    stopped_runtime_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserProfileStatusResponse {
    enabled: bool,
    last_saved_at: Option<String>,
    saved_by_runtime_id: Option<Uuid>,
}

/// Member-visible durability metadata only. Reading status neither restores
/// login material nor implies that the saved profile is still usable by a site.
async fn get_browser_profile_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id_raw): Path<String>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    require_user_session(&context)?;
    let project_id = Uuid::parse_str(project_id_raw.trim())
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

    // Do not select or decrypt the archive. Revoking the persistence policy can
    // leave a saved row, so report that timestamp independently of `enabled`.
    let row = transaction
        .query_opt(
            "select updated_at, updated_by_runtime from project_browser_profiles
             where project_id = $1 and scope = $2",
            &[&project_id, &BROWSER_PROFILE_SCOPE_PROJECT],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load browser profile status: {error}"))
        })?;
    let response = BrowserProfileStatusResponse {
        enabled: state
            .config
            .browser_profile_persistence_enabled_for_project(&project_id),
        last_saved_at: row.as_ref().map(|row| {
            row.get::<_, chrono::DateTime<chrono::Utc>>("updated_at")
                .to_rfc3339()
        }),
        saved_by_runtime_id: row.as_ref().and_then(|row| row.get("updated_by_runtime")),
    };
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize browser profile status: {error}"
        ))
    })?;
    Ok(([("cache-control", "no-store")], Json(response)).into_response())
}

#[derive(Debug)]
struct BrowserProfileRuntime {
    id: Uuid,
    provider: String,
    capabilities: serde_json::Value,
    status: String,
    active_lease_id: Option<Uuid>,
}

fn runtime_may_hold_browser_profile_with_classification(
    runtime: &BrowserProfileRuntime,
    is_private_self_hosted: bool,
) -> bool {
    crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(&runtime.provider)
        && !is_private_self_hosted
        // Heartbeat loss (`offline`) and lifecycle cleanup (`removed`) do not
        // prove that the provider allocation released its decrypted profile.
        // Feed those ambiguous rows through the strict stop path so reset
        // retains the encrypted profile unless cleanup can be proven. Only a
        // generation-free `stopped` row is safe to ignore here.
        && (runtime.status != "stopped" || runtime.active_lease_id.is_some())
}

async fn runtime_may_hold_browser_profile(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    runtime: &BrowserProfileRuntime,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let may_hold = runtime_may_hold_browser_profile_with_classification(
        runtime,
        crate::runtime::runtime_is_private_self_hosted(
            state,
            &runtime.provider,
            &runtime.capabilities,
        ),
    );
    if !may_hold {
        return Ok(false);
    }

    // `removed` alone is only a local lifecycle label and is not proof that a
    // provider allocation released its decrypted profile. A normal successful
    // provider removal does, however, retain an ordered acknowledgement tied to
    // its released lease. Admit only that exact terminal state; ambiguous rows
    // and every row with an active generation remain fenced through stop.
    if runtime.status == "removed" && runtime.active_lease_id.is_none() {
        let release_was_proven =
            crate::runtime::provider_release_was_acknowledged_after_latest_stop(
                transaction,
                &runtime.id,
                &runtime.provider,
            )
            .await?;
        return Ok(!release_was_proven);
    }

    Ok(true)
}

fn map_browser_profile_runtime(row: &tokio_postgres::Row) -> BrowserProfileRuntime {
    BrowserProfileRuntime {
        id: row.get("id"),
        provider: row.get("provider"),
        capabilities: row.get("capabilities"),
        status: row.get("status"),
        active_lease_id: row.get("active_lease_id"),
    }
}

async fn load_browser_profile_runtime_candidates(
    state: &AppState,
    project_id: &Uuid,
) -> Result<Vec<Uuid>, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let rows = transaction
        .query(
            "select id, provider, capabilities, status, active_lease_id
             from runtimes
             where project_id = $1
             order by id",
            &[project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load runtimes before browser profile reset: {error}"
            ))
        })?;

    let mut runtime_ids = Vec::with_capacity(rows.len());
    for row in &rows {
        let runtime = map_browser_profile_runtime(row);
        if runtime_may_hold_browser_profile(state, &transaction, &runtime).await? {
            runtime_ids.push(runtime.id);
        }
    }
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize browser profile runtime scan: {error}"
        ))
    })?;
    Ok(runtime_ids)
}

/// Clear project-shared browser identity without leaving a live Chromium able
/// to restore or re-upload the old state. This deliberately remains available
/// after the persistence allowlist is revoked: policy revocation must never
/// strand encrypted login material that a project member can no longer clear.
async fn reset_browser_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id_raw): Path<String>,
) -> Result<Json<BrowserProfileResetResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }
    let project_id = Uuid::parse_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    // Authorize before doing externally visible provider cleanup. The same
    // builder-or-higher boundary is used for revoking a Project Secret.
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
        ensure_project_write_access(&transaction, &project, &context, None).await?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finalize browser profile reset authorization: {error}"
            ))
        })?;
    }

    // Stop every trusted managed runtime that might still have the decrypted
    // profile in memory. Provider-managed generations are fenced and this call
    // returns only after the allocator acknowledges release; ambiguity is an
    // error, so the encrypted row remains available for a safe retry.
    let runtime_ids = load_browser_profile_runtime_candidates(&state, &project_id).await?;
    let mut stopped_runtime_ids = Vec::with_capacity(runtime_ids.len());
    for runtime_id in runtime_ids {
        crate::runtime::stop_runtime_for_project(
            &state,
            &project_id,
            &runtime_id,
            Some("browser_profile_reset".to_string()),
            "browser_profile_reset",
        )
        .await?;
        stopped_runtime_ids.push(runtime_id);
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

    // Take only the project launch fence here, without also holding runtime
    // row locks. Launches that already passed their FOR SHARE boundary finish
    // before this lock is granted and become visible to the recheck below.
    // Launches behind this lock cannot contact/restore into Chromium until
    // after the old profile has been deleted and this transaction commits.
    let locked_project = transaction
        .query_opt(
            "select status from projects where id = $1 for update",
            &[&project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to lock project during browser profile reset: {error}"
            ))
        })?
        .ok_or_else(|| not_found("project not found"))?;
    let project_status: Option<String> = locked_project.get("status");
    if project_status
        .as_deref()
        .is_some_and(|status| status.eq_ignore_ascii_case("deleted"))
    {
        return Err(not_found("project not found"));
    }

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, None).await?;

    let current_runtimes = transaction
        .query(
            "select id, provider, capabilities, status, active_lease_id
             from runtimes
             where project_id = $1
             order by id",
            &[&project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to recheck runtimes during browser profile reset: {error}"
            ))
        })?;
    let mut runtime_may_hold_profile = false;
    for row in &current_runtimes {
        let runtime = map_browser_profile_runtime(row);
        if runtime_may_hold_browser_profile(&state, &transaction, &runtime).await? {
            runtime_may_hold_profile = true;
            break;
        }
    }
    if runtime_may_hold_profile {
        return Err(conflict(
            "a managed Shared Browser runtime became active during reset; retry",
        ));
    }

    let deleted = transaction
        .execute(
            "delete from project_browser_profiles
             where project_id = $1 and scope = $2",
            &[&project_id, &BROWSER_PROFILE_SCOPE_PROJECT],
        )
        .await
        .map_err(|error| internal_error(format!("failed to clear browser profile: {error}")))?
        > 0;
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit browser profile reset: {error}"))
    })?;

    Ok(Json(BrowserProfileResetResponse {
        ok: true,
        cleared: deleted,
        stopped_runtime_ids,
    }))
}

fn resolve_scope(query: &BrowserProfileQuery) -> Result<String, (StatusCode, Json<ApiError>)> {
    let scope = query
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(BROWSER_PROFILE_SCOPE_PROJECT)
        .to_string();
    if !is_supported_scope(&scope) {
        return Err(bad_request(
            "unsupported browser profile scope (only 'project' is available)",
        ));
    }
    Ok(scope)
}

pub(crate) async fn ensure_browser_profiles_table(pool: &PgPool) -> anyhow::Result<()> {
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    // Multiple controller replicas (and parallel database-backed tests) may
    // initialize this compatibility table at the same time. Serialize the
    // multi-statement DDL as one transaction: CREATE INDEX / ALTER TABLE /
    // REVOKE otherwise acquire different relation locks and can deadlock even
    // though every individual statement is idempotent. A transaction-scoped
    // advisory lock is released automatically on commit or rollback.
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&"runtime-controller:project-browser-profiles-schema-v1"],
        )
        .await?;
    transaction
        .batch_execute(
            "
            create table if not exists project_browser_profiles (
              id uuid primary key,
              project_id uuid not null references projects(id) on delete cascade,
              scope text not null,
              version bigint not null default 0,
              nonce_b64 text not null,
              ciphertext_b64 text not null,
              bytes bigint not null default 0,
              updated_by_runtime uuid,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );

            create unique index if not exists project_browser_profiles_project_scope_uidx
              on project_browser_profiles (project_id, scope);

            alter table project_browser_profiles enable row level security;
            revoke all privileges on table project_browser_profiles from anon, authenticated;
            ",
        )
        .await?;
    transaction.commit().await?;
    Ok(())
}

/// Old runtimes used this path for unconditional writes. Preserve its auth and
/// policy checks, but reject even callers that attach a version: new writers
/// must use a distinct route that old controllers cannot silently accept.
async fn reject_legacy_browser_profile_upload(
    state: State<AppState>,
    headers: HeaderMap,
    Query(mut query): Query<BrowserProfileQuery>,
    body: Bytes,
) -> Result<Json<BrowserProfileManifest>, (StatusCode, Json<ApiError>)> {
    query.version = None;
    put_browser_profile(state, headers, Query(query), body).await
}

async fn put_browser_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BrowserProfileQuery>,
    body: Bytes,
) -> Result<Json<BrowserProfileManifest>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims =
        verify_agent_token_with_scopes(&state.config, token, &[AGENT_BROWSER_PROFILE_SCOPE])?;
    let project_id = claims.project_id;
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent token missing runtime scope"))?;
    let scope = resolve_scope(&query)?;

    ensure_browser_profile_persistence_enabled(&state.config, &project_id)?;

    if body.len() > BROWSER_PROFILE_MAX_BYTES {
        return Err(bad_request(
            "browser profile too large; prune to cookies/localStorage/IndexedDB before upload",
        ));
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

    let project_status = transaction
        .query_opt(
            "select status from projects where id = $1 for share",
            &[&project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load browser profile project: {error}"))
        })?
        .map(|row| row.get::<_, String>("status"));
    if project_status.as_deref() == Some("deleted") || project_status.is_none() {
        return Err(not_found("browser profile project not found"));
    }

    ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, &runtime_id).await?;
    ensure_browser_profile_runtime_is_managed_cloud(&state, &transaction, &project_id, &runtime_id)
        .await?;

    // Keep the existing query shape, but reject legacy unconditional writers.
    // Otherwise an older runtime can still overwrite a version-aware writer.
    let expected_version = required_browser_profile_version(query.version)?;

    let keys = state
        .config
        .credential_keys
        .as_ref()
        .ok_or_else(|| internal_error("credential encryption key missing"))?;
    let (nonce_b64, ciphertext_b64) = keys
        .seal(&body)
        .map_err(|error| internal_error(format!("failed to encrypt browser profile: {error}")))?;
    let plaintext_bytes = body.len() as i64;

    // Atomic compare-and-swap, including the absent-row case: SELECT FOR UPDATE
    // cannot lock a row that does not exist. Two version=0 writers must never
    // both succeed through an unconditional ON CONFLICT update.
    let stored = if expected_version == 0 {
        transaction
            .query_opt(
                "insert into project_browser_profiles
                   (id, project_id, scope, version, nonce_b64, ciphertext_b64, bytes, updated_by_runtime, updated_at)
                 values ($1, $2, $3, 1, $4, $5, $6, $7, now())
                 on conflict (project_id, scope) do nothing
                 returning version, updated_at",
                &[&Uuid::new_v4(), &project_id, &scope, &nonce_b64, &ciphertext_b64,
                  &plaintext_bytes, &runtime_id],
            )
            .await
    } else {
        transaction
            .query_opt(
                "update project_browser_profiles
                 set version = version + 1, nonce_b64 = $4, ciphertext_b64 = $5,
                     bytes = $6, updated_by_runtime = $7, updated_at = now()
                 where project_id = $1 and scope = $2 and version = $3
                 returning version, updated_at",
                &[&project_id, &scope, &expected_version, &nonce_b64, &ciphertext_b64,
                  &plaintext_bytes, &runtime_id],
            )
            .await
    }
    .map_err(|error| internal_error(format!("failed to store browser profile: {error}")))?;
    let Some(stored) = stored else {
        return Err(conflict(
            "browser profile changed; this runtime must not save again without restoring the replacement profile",
        ));
    };
    let stored_version: i64 = stored.get("version");
    let updated_at: chrono::DateTime<chrono::Utc> = stored.get("updated_at");

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit browser profile: {error}")))?;

    Ok(Json(BrowserProfileManifest {
        scope,
        version: stored_version,
        bytes: plaintext_bytes,
        updated_at: updated_at.to_rfc3339(),
    }))
}

async fn get_browser_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BrowserProfileQuery>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims =
        verify_agent_token_with_scopes(&state.config, token, &[AGENT_BROWSER_PROFILE_SCOPE])?;
    let project_id = claims.project_id;
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent token missing runtime scope"))?;
    let scope = resolve_scope(&query)?;

    ensure_browser_profile_persistence_enabled(&state.config, &project_id)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, &runtime_id).await?;
    ensure_browser_profile_runtime_is_managed_cloud(&state, &transaction, &project_id, &runtime_id)
        .await?;
    let row = transaction
        .query_opt(
            "select profile.version, profile.nonce_b64, profile.ciphertext_b64
             from project_browser_profiles profile
             join projects project on project.id = profile.project_id
             where profile.project_id = $1
               and profile.scope = $2
               and project.status <> 'deleted'",
            &[&project_id, &scope],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load browser profile: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit browser profile read: {error}"))
    })?;

    let Some(row) = row else {
        // A policy marker on the authorized empty result lets new runtimes
        // distinguish this CAS implementation from an older unconditional one.
        let mut response = not_found("no browser profile stored").into_response();
        response.headers_mut().insert(
            "x-instafy-profile-write-policy",
            "versioned-v2".parse().unwrap(),
        );
        response
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
        return Ok(response);
    };

    let keys = state
        .config
        .credential_keys
        .as_ref()
        .ok_or_else(|| internal_error("credential encryption key missing"))?;

    let version: i64 = row.get("version");
    let nonce_b64: String = row.get("nonce_b64");
    let ciphertext_b64: String = row.get("ciphertext_b64");
    let plaintext = keys
        .open(&nonce_b64, &ciphertext_b64)
        .map_err(|error| internal_error(format!("failed to decrypt browser profile: {error}")))?;

    Response::builder()
        .header("content-type", "application/octet-stream")
        .header("x-instafy-profile-version", version.to_string())
        .header("x-instafy-profile-write-policy", "versioned-v2")
        .header("cache-control", "no-store")
        .body(Body::from(plaintext))
        .map_err(|error| internal_error(error.to_string()))
}

#[cfg(test)]
#[path = "browser_profile_status_tests.rs"]
mod status_tests;

#[cfg(test)]
mod tests {
    use super::{
        ensure_browser_profile_persistence_enabled, is_supported_scope,
        required_browser_profile_version, runtime_may_hold_browser_profile_with_classification,
        BrowserProfileRuntime,
    };
    use axum::http::StatusCode;
    use uuid::Uuid;

    #[test]
    fn scope_allowlist_blocks_unknown_and_traversal_scopes() {
        assert!(is_supported_scope("project"));
        assert!(!is_supported_scope("user"));
        assert!(!is_supported_scope("../../etc"));
        assert!(!is_supported_scope(""));
    }

    #[test]
    fn browser_profile_version_precondition_is_required_and_bounded() {
        assert_eq!(required_browser_profile_version(Some(0)).unwrap(), 0);
        assert_eq!(required_browser_profile_version(Some(3)).unwrap(), 3);
        assert_eq!(
            required_browser_profile_version(None).unwrap_err().0,
            StatusCode::PRECONDITION_REQUIRED
        );
        for invalid in [-1, i64::MAX] {
            assert_eq!(
                required_browser_profile_version(Some(invalid))
                    .unwrap_err()
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[test]
    fn project_policy_revocation_denies_existing_browser_profile_capability() {
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "browser-profile-policy-test",
        );
        let project_id = Uuid::new_v4();

        let (status, _) = ensure_browser_profile_persistence_enabled(&config, &project_id)
            .expect_err("default-empty allowlist must deny access");
        assert_eq!(status, StatusCode::FORBIDDEN);

        config.browser_profile_persist_project_ids.push(project_id);
        ensure_browser_profile_persistence_enabled(&config, &project_id)
            .expect("exact allowlisted project should be accepted");

        config.browser_profile_persist_project_ids.clear();
        let (status, _) = ensure_browser_profile_persistence_enabled(&config, &project_id)
            .expect_err("revocation must take effect independently of token lifetime");
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn reset_stops_only_potentially_live_trusted_managed_runtimes() {
        let runtime = |provider: &str, status: &str, active_lease_id| BrowserProfileRuntime {
            id: Uuid::new_v4(),
            provider: provider.to_string(),
            capabilities: serde_json::json!({}),
            status: status.to_string(),
            active_lease_id,
        };

        assert!(runtime_may_hold_browser_profile_with_classification(
            &runtime("instafy-cloud", "ready", Some(Uuid::new_v4()),),
            false
        ));
        assert!(runtime_may_hold_browser_profile_with_classification(
            &runtime("instafy_cloud", "requested", None,),
            false
        ));
        assert!(runtime_may_hold_browser_profile_with_classification(
            &runtime("instafy-cloud", "offline", Some(Uuid::new_v4()),),
            false
        ));

        for ambiguous_status in ["offline", "removed"] {
            assert!(runtime_may_hold_browser_profile_with_classification(
                &runtime("instafy-cloud", ambiguous_status, None,),
                false
            ));
        }
        assert!(!runtime_may_hold_browser_profile_with_classification(
            &runtime("instafy-cloud", "stopped", None,),
            false
        ));
        assert!(!runtime_may_hold_browser_profile_with_classification(
            &runtime("instafy-cloud-custom", "ready", Some(Uuid::new_v4()),),
            false
        ));
        assert!(!runtime_may_hold_browser_profile_with_classification(
            &runtime("self-hosted", "ready", Some(Uuid::new_v4()),),
            true
        ));
        assert!(!runtime_may_hold_browser_profile_with_classification(
            &runtime("instafy-cloud", "ready", Some(Uuid::new_v4()),),
            true
        ));
    }
}
