use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio_postgres::Transaction;
use tracing::warn;
use uuid::Uuid;

use crate::{
    auth::authenticate_request,
    bad_request,
    config::{PgPool, RuntimeProviderConfig},
    forbidden, internal_error, ApiError, AppConfig, AppState,
};

pub(crate) async fn load_runtime_providers(
    pool: &PgPool,
    fallback: &[RuntimeProviderConfig],
) -> anyhow::Result<Vec<RuntimeProviderConfig>> {
    let connection = pool.get().await?;
    let rows = match connection
        .query(
            "select id, display_name, kind, owner_org_id, allowed_org_ids, endpoint, auth_token, metadata
             from runtime_providers
             order by created_at asc",
            &[],
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            warn!(
                %error,
                "runtime_providers table not available; falling back to env config"
            );
            return Ok(fallback.to_vec());
        }
    };

    if rows.is_empty() {
        for provider in fallback {
            let _ = connection
                .execute(
                    "insert into runtime_providers (id, display_name, kind, owner_org_id, allowed_org_ids, endpoint, auth_token)
                     values ($1, $2, $3, $4, $5, $6, $7)
                     on conflict (id) do update set
                        display_name = excluded.display_name,
                        kind = excluded.kind,
                        owner_org_id = excluded.owner_org_id,
                        allowed_org_ids = excluded.allowed_org_ids,
                        endpoint = excluded.endpoint,
                        auth_token = excluded.auth_token",
                    &[
                        &provider.id,
                        &provider.display_name,
                        &provider.kind,
                        &provider.owner_org_id,
                        &provider.allowed_org_ids,
                        &provider.endpoint,
                        &provider.auth_token,
                    ],
                )
                .await;
        }
        return Ok(fallback.to_vec());
    }

    let mut providers = Vec::with_capacity(rows.len());
    for row in rows {
        let provider = RuntimeProviderConfig {
            id: row.get::<_, String>("id"),
            display_name: row.get::<_, String>("display_name"),
            kind: row.get::<_, String>("kind"),
            owner_org_id: row.get::<_, Option<Uuid>>("owner_org_id"),
            allowed_org_ids: row
                .get::<_, Option<Vec<Uuid>>>("allowed_org_ids")
                .unwrap_or_default(),
            endpoint: row.get::<_, Option<String>>("endpoint"),
            auth_token: row.get::<_, Option<String>>("auth_token"),
            metadata: row.get::<_, Option<serde_json::Value>>("metadata"),
        };
        providers.push(provider);
    }

    Ok(providers)
}

fn build_provider_maps_from_list(
    providers: &[RuntimeProviderConfig],
) -> anyhow::Result<(
    std::collections::HashMap<String, RuntimeProviderConfig>,
    String,
)> {
    let mut configs = std::collections::HashMap::new();
    for provider in providers {
        let key = crate::provider_identifiers::provider_id_key(&provider.id);
        if key.is_empty() {
            anyhow::bail!(
                "runtime provider id '{}' has an empty normalized identity",
                provider.id
            );
        }
        if let Some(existing) = configs.insert(key.clone(), provider.clone()) {
            anyhow::bail!(
                "runtime provider ids '{}' and '{}' normalize to the same identity '{}'",
                existing.id,
                provider.id,
                key
            );
        }
    }
    let provider_has_endpoint = |provider: &RuntimeProviderConfig| {
        provider
            .endpoint
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .is_some()
    };
    let provider_requires_endpoint = |provider: &RuntimeProviderConfig| {
        !crate::provider_identifiers::is_self_hosted_provider_kind(&provider.kind)
    };

    let default_provider_id = providers
        .iter()
        .find(|provider| {
            crate::provider_identifiers::provider_id_key(&provider.id)
                == crate::provider_identifiers::PROVIDER_ID_INSTAFY_CLOUD
                && (!provider_requires_endpoint(provider) || provider_has_endpoint(provider))
        })
        .or_else(|| {
            providers.iter().find(|provider| {
                crate::provider_identifiers::is_instafy_cloud_provider_id(&provider.id)
                    && (!provider_requires_endpoint(provider) || provider_has_endpoint(provider))
            })
        })
        .or_else(|| {
            providers.iter().find(|provider| {
                !crate::provider_identifiers::is_self_hosted_provider_id(&provider.id)
                    && (!provider_requires_endpoint(provider) || provider_has_endpoint(provider))
            })
        })
        .or_else(|| providers.first())
        .map(|provider| provider.id.trim().to_string())
        .unwrap_or_else(|| "default".to_string());
    Ok((configs, default_provider_id))
}

pub(crate) async fn build_provider_registry(
    config: &AppConfig,
    pool: &PgPool,
) -> anyhow::Result<crate::state::ProviderRegistry> {
    let providers = load_runtime_providers(pool, &config.runtime_providers).await?;
    let (configs, default_provider_id) = build_provider_maps_from_list(&providers)?;
    Ok(crate::state::ProviderRegistry::new(
        configs,
        default_provider_id,
    ))
}

async fn refresh_provider_registry(state: &AppState) -> anyhow::Result<()> {
    let providers = load_runtime_providers(&state.pool, &state.config.runtime_providers).await?;
    let (configs, default_provider_id) = build_provider_maps_from_list(&providers)?;
    state
        .provider_registry
        .replace(configs, default_provider_id);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUpsertRequest {
    id: String,
    display_name: Option<String>,
    kind: String,
    #[serde(default)]
    owner_org_id: Option<Uuid>,
    #[serde(default)]
    allowed_org_ids: Vec<Uuid>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    auth_token: Option<String>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderResponse {
    id: String,
    display_name: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_org_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    allowed_org_ids: Vec<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}

fn map_provider(provider: RuntimeProviderConfig) -> ProviderResponse {
    ProviderResponse {
        id: provider.id,
        display_name: provider.display_name,
        kind: provider.kind,
        owner_org_id: provider.owner_org_id,
        allowed_org_ids: provider.allowed_org_ids,
        endpoint: provider.endpoint,
        auth_token: provider.auth_token,
        metadata: provider.metadata,
    }
}

fn parse_kind(kind: &str) -> Result<String, (axum::http::StatusCode, Json<ApiError>)> {
    let normalized = crate::provider_identifiers::canonical_provider_kind(kind);
    if normalized.is_empty() {
        return Err(bad_request("invalid provider kind"));
    }
    Ok(normalized)
}

async fn provider_route_is_in_use(
    transaction: &Transaction<'_>,
    provider_key: &str,
) -> Result<bool, (axum::http::StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            "select exists(
                select 1
                from runtimes r
                join runtime_leases rl on rl.runtime_id = r.id
                where btrim(lower(regexp_replace(btrim(r.provider), '[-_[:space:]]+', '_', 'g')), '_') = $1
                  and rl.released_at is null
                  and rl.status in ('pending', 'launching', 'active', 'cleanup_pending')
            )",
            &[&provider_key],
        )
        .await
        .map(|row| row.get(0))
        .map_err(|error| internal_error(format!("failed to check provider route usage: {error}")))
}

fn provider_route_id_conflicts(existing_id: Option<&str>, requested_id: &str) -> bool {
    existing_id.is_some_and(|existing_id| existing_id != requested_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_kind_normalizes_and_rejects_empty() {
        assert_eq!(parse_kind(" docker ").unwrap(), "docker".to_string());
        assert_eq!(
            parse_kind("self_hosted").unwrap(),
            "self-hosted".to_string()
        );
        assert_eq!(
            parse_kind(" external-http ").unwrap(),
            "external_http".to_string()
        );
        assert!(parse_kind("   ").is_err());
    }

    #[test]
    fn map_provider_keeps_kind_string() {
        let provider = RuntimeProviderConfig {
            id: "p1".to_string(),
            display_name: "Provider".to_string(),
            kind: "external_http".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some("http://example.com".to_string()),
            auth_token: Some("token".to_string()),
            metadata: None,
        };
        let mapped = map_provider(provider);
        assert_eq!(mapped.kind, "external_http".to_string());
    }

    #[test]
    fn provider_registry_rejects_normalized_identity_aliases() {
        let provider = |id: &str| RuntimeProviderConfig {
            id: id.to_string(),
            display_name: id.to_string(),
            kind: "external_http".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some("http://provider.test".to_string()),
            auth_token: None,
            metadata: None,
        };
        let error = build_provider_maps_from_list(&[
            provider("instafy-cloud"),
            provider(" -Instafy_Cloud- "),
        ])
        .expect_err("normalized provider aliases must fail closed");
        assert!(error
            .to_string()
            .contains("normalize to the same identity 'instafy_cloud'"));
    }

    #[test]
    fn provider_upsert_rejects_a_different_raw_alias_for_an_existing_route() {
        assert!(!provider_route_id_conflicts(
            Some("instafy-cloud"),
            "instafy-cloud"
        ));
        assert!(provider_route_id_conflicts(
            Some("instafy-cloud"),
            "instafy_cloud"
        ));
        assert!(!provider_route_id_conflicts(None, "instafy-cloud"));
    }

    #[tokio::test]
    async fn active_and_cleanup_pending_leases_fence_provider_route_rotation() -> anyhow::Result<()>
    {
        let pool = crate::tests::require_origin_test_pool("provider route rotation test").await?;
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let provider_id = "route-guard-test";
        let provider_key = crate::provider_identifiers::provider_id_key(provider_id);

        transaction
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        transaction
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, $3, 'requested', 600)",
                &[&runtime_id, &project_id, &provider_id],
            )
            .await?;
        transaction
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at)
                 values ($1, $2, $3, 'cleanup_pending', now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;

        let route_in_use = provider_route_is_in_use(&transaction, &provider_key)
            .await
            .map_err(|(_, body)| anyhow::anyhow!(body.0.message))?;
        assert!(
            route_in_use,
            "an unreleased generation must fence route rotation even when its active pointer is missing"
        );
        transaction
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;

        let route_in_use = provider_route_is_in_use(&transaction, &provider_key)
            .await
            .map_err(|(_, body)| anyhow::anyhow!(body.0.message))?;
        assert!(route_in_use);
        transaction
            .execute(
                "update runtime_leases
                 set status = 'released', released_at = now()
                 where id = $1",
                &[&lease_id],
            )
            .await?;
        let route_in_use = provider_route_is_in_use(&transaction, &provider_key)
            .await
            .map_err(|(_, body)| anyhow::anyhow!(body.0.message))?;
        assert!(!route_in_use);

        transaction.rollback().await?;
        Ok(())
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/providers", get(list_providers).post(upsert_provider))
        .route("/providers/refresh", post(refresh_providers))
}

async fn list_providers(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<ProviderResponse>>, (axum::http::StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if !context.is_service_role {
        return Err(forbidden("service role required"));
    }
    let providers = load_runtime_providers(&state.pool, &state.config.runtime_providers)
        .await
        .map_err(|error| internal_error(format!("failed to load providers: {error}")))?;
    Ok(Json(providers.into_iter().map(map_provider).collect()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRefreshResponse {
    ok: bool,
    provider_count: usize,
}

async fn refresh_providers(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ProviderRefreshResponse>, (axum::http::StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if !context.is_service_role {
        return Err(forbidden("service role required"));
    }

    refresh_provider_registry(&state)
        .await
        .map_err(|error| internal_error(format!("failed to refresh providers: {error}")))?;

    Ok(Json(ProviderRefreshResponse {
        ok: true,
        provider_count: state.provider_registry.provider_configs().len(),
    }))
}

async fn upsert_provider(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<ProviderUpsertRequest>,
) -> Result<Json<ProviderResponse>, (axum::http::StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if !context.is_service_role {
        return Err(forbidden("service role required"));
    }
    let id = payload.id.trim();
    if id.is_empty() {
        return Err(bad_request("id is required for provider"));
    }
    let display_name = payload
        .display_name
        .clone()
        .unwrap_or_else(|| payload.id.clone());
    let kind = parse_kind(&payload.kind)?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get db connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!("failed to start provider transaction: {error}"))
    })?;
    let provider_key = crate::provider_identifiers::provider_id_key(id);
    if provider_key.is_empty() {
        return Err(bad_request("provider id has an empty normalized identity"));
    }
    let route_lock_key = format!("runtime-provider:{provider_key}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&route_lock_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock provider route: {error}")))?;

    let existing = transaction
        .query_opt(
            "select id, kind, endpoint, auth_token, metadata
             from runtime_providers
             where btrim(lower(regexp_replace(btrim(id), '[-_[:space:]]+', '_', 'g')), '_') = $1
             for update",
            &[&provider_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load provider route: {error}")))?;
    let existing_id = existing.as_ref().map(|row| row.get::<_, String>("id"));
    if provider_route_id_conflicts(existing_id.as_deref(), id) {
        return Err((
            axum::http::StatusCode::CONFLICT,
            Json(ApiError::new(format!(
                "provider normalized identity is already registered under exact id '{}'",
                existing_id.as_deref().unwrap_or_default()
            ))),
        ));
    }
    let existing_metadata = existing
        .as_ref()
        .and_then(|row| row.get::<_, Option<serde_json::Value>>("metadata"))
        .unwrap_or_else(|| serde_json::json!({}));
    // Provider-service self-registration intentionally omits metadata. Preserve
    // controller-owned billing/transport policy in that case rather than
    // treating omission as an attempt to replace it with an empty object.
    let metadata = payload
        .metadata
        .clone()
        .unwrap_or_else(|| existing_metadata.clone());
    let route_changed = existing.as_ref().is_some_and(|row| {
        let existing_kind: String = row.get("kind");
        let existing_endpoint: Option<String> = row.get("endpoint");
        let existing_auth_token: Option<String> = row.get("auth_token");
        existing_kind != kind
            || existing_endpoint.as_deref().map(str::trim)
                != payload.endpoint.as_deref().map(str::trim)
            || existing_auth_token != payload.auth_token
            || (payload.metadata.is_some() && existing_metadata != metadata)
    });

    if route_changed {
        let route_in_use = provider_route_is_in_use(&transaction, &provider_key).await?;
        if route_in_use {
            return Err((
                axum::http::StatusCode::CONFLICT,
                Json(ApiError::new(
                    "provider route is in use; stop and clean its runtimes before rotating it",
                )),
            ));
        }
    }

    if let Some(existing_id) = existing_id.as_deref() {
        transaction
            .execute(
                "update runtime_providers
                 set display_name = $1,
                     kind = $2,
                     owner_org_id = $3,
                     allowed_org_ids = $4,
                     endpoint = $5,
                     auth_token = $6,
                     metadata = $7
                 where id = $8",
                &[
                    &display_name,
                    &kind,
                    &payload.owner_org_id,
                    &payload.allowed_org_ids,
                    &payload.endpoint,
                    &payload.auth_token,
                    &metadata,
                    &existing_id,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update provider route: {error}")))?;
    } else {
        transaction
            .execute(
                "insert into runtime_providers
                    (id, display_name, kind, owner_org_id, allowed_org_ids, endpoint, auth_token, metadata)
                 values ($1, $2, $3, $4, $5, $6, $7, $8)",
                &[
                    &id,
                    &display_name,
                    &kind,
                    &payload.owner_org_id,
                    &payload.allowed_org_ids,
                    &payload.endpoint,
                    &payload.auth_token,
                    &metadata,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to insert provider route: {error}")))?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit provider upsert: {error}")))?;

    refresh_provider_registry(&state)
        .await
        .map_err(|error| internal_error(format!("failed to refresh providers: {error}")))?;

    Ok(Json(map_provider(RuntimeProviderConfig {
        id: id.to_string(),
        display_name,
        kind,
        owner_org_id: payload.owner_org_id,
        allowed_org_ids: payload.allowed_org_ids,
        endpoint: payload.endpoint,
        auth_token: payload.auth_token,
        metadata: Some(metadata),
    })))
}
