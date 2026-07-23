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
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Json, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent::{
    ensure_agent_token_matches_runtime_lease, extract_agent_token, verify_agent_token_with_scopes,
};
use crate::config::PgPool;
use crate::secrets::{decrypt_secret_payload, encrypt_secret_payload};
use crate::{bad_request, forbidden, internal_error, not_found, unauthorized, ApiError, AppState};

const BROWSER_PROFILE_SCOPE_PROJECT: &str = "project";
const AGENT_BROWSER_PROFILE_SCOPE: &str = "agent.browser_profile";
/// Generous ceiling on a stored (plaintext) profile. A profile pruned to the
/// auth surface is well under 1MB; anything larger means the runtime failed to
/// prune and we reject rather than store megabytes of caches.
const BROWSER_PROFILE_MAX_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/agent/browser-profile",
        get(get_browser_profile)
            .put(put_browser_profile)
            // Profiles are up to a few MB, above axum's 2MB default extractor
            // cap; align the limit with the handler's own size check.
            .layer(DefaultBodyLimit::max(BROWSER_PROFILE_MAX_BYTES)),
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

/// Decide the next version, enforcing the optimistic single-writer contract.
/// A caller that passes the version it last saw is rejected if another runtime
/// has since written. `None` means "write unconditionally".
fn next_browser_profile_version(current: Option<i64>, expected: Option<i64>) -> Result<i64, i64> {
    let current = current.unwrap_or(0);
    if let Some(expected) = expected {
        if expected != current {
            return Err(current);
        }
    }
    Ok(current + 1)
}

#[derive(Debug, Deserialize)]
struct BrowserProfileQuery {
    scope: Option<String>,
    /// Version the caller last saw, for optimistic concurrency (409 if stale).
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
    let connection = pool.get().await?;
    connection
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
    Ok(())
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

    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| internal_error("credential encryption key missing"))?;
    let (nonce_b64, ciphertext_b64) = encrypt_secret_payload(key, &body)
        .map_err(|error| internal_error(format!("failed to encrypt browser profile: {error}")))?;
    let plaintext_bytes = body.len() as i64;

    let current: Option<i64> = transaction
        .query_opt(
            // FOR UPDATE locks an existing row so concurrent snapshots serialize
            // on the optimistic version check rather than racing a lost update.
            "select version from project_browser_profiles
             where project_id = $1 and scope = $2 for update",
            &[&project_id, &scope],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to read browser profile version: {error}"))
        })?
        .map(|row| row.get::<_, i64>("version"));

    let next_version = match next_browser_profile_version(current, query.version) {
        Ok(version) => version,
        Err(current) => {
            return Err(conflict(format!(
                "browser profile changed since version {}; current is {current}",
                query.version.unwrap_or(0)
            )));
        }
    };

    transaction
        .execute(
            "insert into project_browser_profiles
               (id, project_id, scope, version, nonce_b64, ciphertext_b64, bytes, updated_by_runtime, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, now())
             on conflict (project_id, scope) do update set
               -- Increment from the stored value (not excluded.version) so two
               -- concurrent first-writers — whose FOR UPDATE locked nothing
               -- because the row did not exist yet — still advance the counter
               -- monotonically instead of both landing on version 1.
               version = project_browser_profiles.version + 1,
               nonce_b64 = excluded.nonce_b64,
               ciphertext_b64 = excluded.ciphertext_b64,
               bytes = excluded.bytes,
               updated_by_runtime = excluded.updated_by_runtime,
               updated_at = now()",
            &[
                &Uuid::new_v4(),
                &project_id,
                &scope,
                &next_version,
                &nonce_b64,
                &ciphertext_b64,
                &plaintext_bytes,
                &runtime_id,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to store browser profile: {error}")))?;

    // Read the persisted version back rather than trusting `next_version`: under
    // the first-write race the ON CONFLICT branch may have advanced it further,
    // so the DB row is the source of truth for what the client should report.
    let stored = transaction
        .query_one(
            "select version, updated_at from project_browser_profiles
             where project_id = $1 and scope = $2",
            &[&project_id, &scope],
        )
        .await
        .map_err(|error| internal_error(format!("failed to read browser profile: {error}")))?;
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
        // Nothing stored — the runtime treats this as "start fresh".
        return Err(not_found("no browser profile stored"));
    };

    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| internal_error("credential encryption key missing"))?;

    let version: i64 = row.get("version");
    let nonce_b64: String = row.get("nonce_b64");
    let ciphertext_b64: String = row.get("ciphertext_b64");
    let plaintext = decrypt_secret_payload(key, &nonce_b64, &ciphertext_b64)
        .map_err(|error| internal_error(format!("failed to decrypt browser profile: {error}")))?;

    Response::builder()
        .header("content-type", "application/octet-stream")
        .header("x-instafy-profile-version", version.to_string())
        .body(Body::from(plaintext))
        .map_err(|error| internal_error(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_browser_profile_persistence_enabled, is_supported_scope,
        next_browser_profile_version,
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
    fn version_advances_and_rejects_stale_writes() {
        // First write (no row yet): unconditional or expected 0 -> version 1.
        assert_eq!(next_browser_profile_version(None, None), Ok(1));
        assert_eq!(next_browser_profile_version(None, Some(0)), Ok(1));

        // Correct expected version advances.
        assert_eq!(next_browser_profile_version(Some(3), Some(3)), Ok(4));

        // Unconditional write over an existing row advances from current.
        assert_eq!(next_browser_profile_version(Some(3), None), Ok(4));

        // Stale expected version is rejected with the current version.
        assert_eq!(next_browser_profile_version(Some(3), Some(2)), Err(3));
        assert_eq!(next_browser_profile_version(Some(1), Some(0)), Err(1));
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
}
