use std::fmt::Debug;
use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::browser_turn::BrowserTurnRestConfig;
use crate::{bad_request, forbidden, internal_error, ApiError, AppState};

const BROWSER_PROFILE_PERSIST_ENV: &str = "INSTAFY_BROWSER_PROFILE_PERSIST";
const BROWSER_PROFILE_SNAPSHOT_SECS_ENV: &str = "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS";

/// Upper bound for a fenced provider release (stop, remove, sweeps, reclaim).
/// The provider serializes ensure/release per runtime in detached tasks, so a
/// release can legitimately queue behind a slow provider-side ensure, and a
/// controller-side timeout never cancels the release itself. Timing out leaves
/// the generation quarantined as `cleanup_pending`, which every stop path and
/// the launch-timeout sweep already treat as retryable. Without a bound, one
/// unresponsive provider stalled the whole sequential idle sweep forever.
pub(super) const RUNTIME_PROVIDER_RELEASE_TIMEOUT: Duration = Duration::from_secs(180);
/// The OOM post-mortem is best-effort and read-only; a slow answer is simply
/// "unknown" and must not delay the heartbeat-timeout stop behind it.
pub(super) const RUNTIME_PROVIDER_INSPECT_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn apply_git_remote_env(
    config: &crate::config::AppConfig,
    project_id: Uuid,
    metadata: Option<JsonValue>,
) -> Option<JsonValue> {
    let Some(base) = config.git_remote_base_url.as_deref() else {
        return metadata;
    };

    let remote_url = format!("{base}/{}.git", project_id);

    let mut root = match metadata {
        Some(JsonValue::Object(map)) => map,
        Some(other) => {
            let mut map = JsonMap::new();
            map.insert("metadata".to_string(), other);
            map
        }
        None => JsonMap::new(),
    };

    let env_entry = root
        .entry("env".to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if !matches!(env_entry, JsonValue::Object(_)) {
        *env_entry = JsonValue::Object(JsonMap::new());
    }
    if let JsonValue::Object(env) = env_entry {
        env.entry("ORIGIN_GIT_REMOTE_URL".to_string())
            .or_insert_with(|| JsonValue::String(remote_url));
    }

    Some(JsonValue::Object(root))
}

/// Enforce the privacy-sensitive hosted-browser persistence policy after all
/// client and provider metadata has been merged. Both sources are untrusted for
/// these keys: only the controller allowlist may turn persistence on or choose
/// the snapshot interval.
pub(super) fn apply_browser_profile_persistence_policy(
    config: &crate::config::AppConfig,
    project_id: Uuid,
    metadata: Option<JsonValue>,
) -> Option<JsonValue> {
    apply_browser_profile_persistence_env(
        metadata,
        config.browser_profile_persistence_enabled_for_project(&project_id),
        config.browser_profile_snapshot_secs,
    )
}

fn apply_browser_profile_persistence_env(
    metadata: Option<JsonValue>,
    enabled: bool,
    snapshot_secs: u64,
) -> Option<JsonValue> {
    let mut root = match metadata {
        Some(JsonValue::Object(map)) => map,
        Some(other) => {
            let mut map = JsonMap::new();
            map.insert("metadata".to_string(), other);
            map
        }
        None => JsonMap::new(),
    };

    let mut env = match root.remove("env") {
        Some(JsonValue::Object(env)) => env,
        _ => JsonMap::new(),
    };
    env.remove(BROWSER_PROFILE_PERSIST_ENV);
    env.remove(BROWSER_PROFILE_SNAPSHOT_SECS_ENV);

    if enabled {
        env.insert(
            BROWSER_PROFILE_PERSIST_ENV.to_string(),
            JsonValue::String("1".to_string()),
        );
        env.insert(
            BROWSER_PROFILE_SNAPSHOT_SECS_ENV.to_string(),
            JsonValue::String(snapshot_secs.to_string()),
        );
    } else {
        // Explicitly override any stale provider-process/controller environment.
        // Merely removing client metadata is not enough because Compose also
        // resolves substitutions from its ambient environment.
        env.insert(
            BROWSER_PROFILE_PERSIST_ENV.to_string(),
            JsonValue::String("0".to_string()),
        );
        env.insert(
            BROWSER_PROFILE_SNAPSHOT_SECS_ENV.to_string(),
            JsonValue::String("0".to_string()),
        );
    }

    if !env.is_empty() {
        root.insert("env".to_string(), JsonValue::Object(env));
    }

    if root.is_empty() {
        None
    } else {
        Some(JsonValue::Object(root))
    }
}

pub(super) fn merge_provider_metadata(
    runtime_meta: &Option<JsonValue>,
    provider_meta: &Option<JsonValue>,
) -> Option<JsonValue> {
    let mut merged = JsonMap::new();
    if let Some(JsonValue::Object(map)) = runtime_meta {
        for (key, value) in map {
            merged.insert(key.clone(), value.clone());
        }
    } else if let Some(other) = runtime_meta {
        merged.insert("runtimeMetadata".to_string(), other.clone());
    }
    if let Some(JsonValue::Object(map)) = provider_meta {
        for (key, value) in map {
            if key == "env" {
                let runtime_env = merged
                    .entry(key.clone())
                    .or_insert_with(|| JsonValue::Object(JsonMap::new()));
                if !runtime_env.is_object() {
                    *runtime_env = JsonValue::Object(JsonMap::new());
                }
                if let (Some(runtime_env), JsonValue::Object(provider_env)) =
                    (runtime_env.as_object_mut(), value)
                {
                    // Runtime metadata owns user/session choices, while provider
                    // metadata supplies deployment-only transport policy. Merge
                    // the environment one key at a time
                    // so a browser ensure request cannot accidentally erase the
                    // provider's transport configuration.
                    for (env_key, env_value) in provider_env {
                        if provider_owned_runtime_env_key(env_key) {
                            runtime_env.insert(env_key.clone(), env_value.clone());
                        } else {
                            runtime_env
                                .entry(env_key.clone())
                                .or_insert_with(|| env_value.clone());
                        }
                    }
                }
                continue;
            }
            merged.entry(key.clone()).or_insert_with(|| value.clone());
        }
    } else if let Some(other) = provider_meta {
        merged
            .entry("providerMetadata".to_string())
            .or_insert_with(|| other.clone());
    }
    if merged.is_empty() {
        None
    } else {
        Some(JsonValue::Object(merged))
    }
}

/// Inject controller-minted coturn REST credentials only after runtime and
/// provider metadata have been merged. This final overwrite is the trust
/// boundary: neither a runtime ensure payload nor provider metadata can choose
/// the TURN identity or disable relay-only ICE when managed TURN is configured.
pub(super) fn apply_controller_turn_credentials(
    config: Option<&BrowserTurnRestConfig>,
    project_id: Uuid,
    runtime_id: Uuid,
    now_unix: i64,
    mut metadata: Option<JsonValue>,
) -> Option<JsonValue> {
    let Some(config) = config else {
        return metadata;
    };
    let Some(env) = metadata
        .as_mut()
        .and_then(JsonValue::as_object_mut)
        .and_then(|root| root.get_mut("env"))
        .and_then(JsonValue::as_object_mut)
    else {
        return metadata;
    };
    if env
        .get("INSTAFY_BROWSER_WEBRTC_ENABLED")
        .and_then(JsonValue::as_str)
        != Some("1")
    {
        return metadata;
    }
    if !config.allows_project(project_id) {
        env.insert(
            "INSTAFY_BROWSER_WEBRTC_ENABLED".to_string(),
            JsonValue::String("0".to_string()),
        );
        env.remove("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON");
        env.remove("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN");
        if env
            .get("INSTAFY_BROWSER_PREFERRED_VIEWER")
            .and_then(JsonValue::as_str)
            == Some("webrtc")
        {
            let fallback = if env
                .get("INSTAFY_BROWSER_CDP_SCREENCAST")
                .and_then(JsonValue::as_str)
                == Some("1")
            {
                "cdp-screencast"
            } else {
                "rfb"
            };
            env.insert(
                "INSTAFY_BROWSER_PREFERRED_VIEWER".to_string(),
                JsonValue::String(fallback.to_string()),
            );
        }
        return metadata;
    }

    env.insert(
        "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON".to_string(),
        JsonValue::String(config.mint_ice_servers_json(project_id, runtime_id, now_unix)),
    );
    env.insert(
        "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN".to_string(),
        JsonValue::String("1".to_string()),
    );
    metadata
}

fn provider_owned_runtime_env_key(key: &str) -> bool {
    matches!(
        key,
        "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"
            | "INSTAFY_BROWSER_WEBRTC_SENDER_URL"
            | "INSTAFY_BROWSER_WEBRTC_BIND"
            | "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"
            | "INSTAFY_BROWSER_WEBRTC_FPS"
            | "INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS"
    )
}

pub(super) fn select_provider_config(
    state: &AppState,
    provider: &str,
) -> Option<crate::config::RuntimeProviderConfig> {
    state
        .provider_registry
        .provider_config(provider)
        .or_else(|| {
            state
                .provider_registry
                .provider_config(&state.provider_registry.default_provider_id())
        })
}

/// Hold a mutable provider route stable for the current transaction and load
/// its authoritative database row. Database-backed provider updates take the
/// matching exclusive advisory lock. Environment-only providers have no row,
/// so their process-local registry entry remains the source of truth.
pub(super) async fn lock_and_load_authoritative_provider_config(
    transaction: &Transaction<'_>,
    requested_provider: &str,
    registry_fallback: Option<&crate::config::RuntimeProviderConfig>,
) -> Result<Option<crate::config::RuntimeProviderConfig>, (StatusCode, Json<ApiError>)> {
    let provider_key = crate::provider_identifiers::provider_id_key(requested_provider);
    let lock_key = format!("runtime-provider:{provider_key}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to lock runtime provider route: {error}"))
        })?;

    let row = transaction
        .query_opt(
            "select id, display_name, kind, owner_org_id, allowed_org_ids,
                    endpoint, auth_token, metadata
             from runtime_providers
             where btrim(lower(regexp_replace(btrim(id), '[-_[:space:]]+', '_', 'g')), '_') = $1
             for share",
            &[&provider_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load locked runtime provider route: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Ok(registry_fallback.cloned());
    };

    Ok(Some(crate::config::RuntimeProviderConfig {
        id: row.get("id"),
        display_name: row.get("display_name"),
        kind: row.get("kind"),
        owner_org_id: row.get("owner_org_id"),
        allowed_org_ids: row
            .get::<_, Option<Vec<Uuid>>>("allowed_org_ids")
            .unwrap_or_default(),
        endpoint: row.get("endpoint"),
        auth_token: row.get("auth_token"),
        metadata: row.get("metadata"),
    }))
}

#[derive(Debug, serde::Serialize)]
pub(super) struct ProviderEnsureRequest<'a> {
    pub(super) project_id: &'a Uuid,
    pub(super) runtime_id: &'a Uuid,
    pub(super) lease_id: &'a Uuid,
    pub(super) provider: &'a str,
    pub(super) runtime_token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) metadata: Option<&'a JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) origin_instance_id: Option<&'a Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) origin_mode: Option<&'a String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) origin_protocols: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) origin_metadata: Option<&'a JsonValue>,
}

#[derive(Debug, serde::Serialize)]
pub(super) struct ProviderReleaseRequest<'a> {
    pub(super) project_id: &'a Uuid,
    pub(super) runtime_id: &'a Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) lease_id: Option<&'a Uuid>,
}

fn provider_call_status_is_final_success(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::OK | reqwest::StatusCode::CREATED | reqwest::StatusCode::NO_CONTENT
    )
}

/// Call one runtime provider endpoint with an explicit overall deadline.
///
/// The deadline covers every auth-fallback attempt and the response body, and
/// is required so no provider call can wait forever. Callers must not hold a
/// pooled database connection or open transaction across this call unless a
/// deliberate, capacity-bounded fence requires it (see the ensure launch
/// guard); a slow provider otherwise pins pool capacity for its full duration.
pub(super) async fn call_provider_endpoint<T: serde::Serialize + Debug>(
    state: &AppState,
    provider: &crate::config::RuntimeProviderConfig,
    path: &str,
    body: &T,
    timeout: Duration,
) -> anyhow::Result<Option<String>> {
    match tokio::time::timeout(
        timeout,
        call_provider_endpoint_unbounded(state, provider, path, body),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => anyhow::bail!(
            "runtime provider call to {} timed out after {timeout:?}",
            path.trim()
        ),
    }
}

async fn call_provider_endpoint_unbounded<T: serde::Serialize + Debug>(
    state: &AppState,
    provider: &crate::config::RuntimeProviderConfig,
    path: &str,
    body: &T,
) -> anyhow::Result<Option<String>> {
    let endpoint = provider
        .endpoint
        .as_ref()
        .map(|e| e.trim().trim_end_matches('/').to_string());
    let Some(base) = endpoint else {
        tracing::info!(
            provider = %provider.id,
            "provider endpoint not configured; skipping external call"
        );
        return Ok(None);
    };
    let url = format!("{}/{}", base, path.trim_start_matches('/'));
    let auth_tokens = resolve_provider_auth_tokens(
        &provider.id,
        provider.auth_token.as_deref(),
        state.config.controller_internal_token.as_deref(),
        state.config.supabase_service_role_key.as_deref(),
    );

    let mut attempts = auth_tokens
        .iter()
        .map(|token| Some(token.as_str()))
        .collect::<Vec<_>>();
    if attempts.is_empty() {
        attempts.push(None);
    }

    let mut last_error: Option<(reqwest::StatusCode, String)> = None;
    for (index, token) in attempts.iter().enumerate() {
        let mut req = state.http_client.post(url.clone()).json(body);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let res = req.send().await?;
        if provider_call_status_is_final_success(res.status()) {
            let value: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
            let msg = value
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            return Ok(msg);
        }

        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let has_fallback = index + 1 < attempts.len();
        if status == reqwest::StatusCode::UNAUTHORIZED && has_fallback {
            tracing::warn!(
                provider = %provider.id,
                attempt = index + 1,
                total_attempts = attempts.len(),
                "provider call unauthorized; retrying with fallback auth token"
            );
            last_error = Some((status, text));
            continue;
        }
        anyhow::bail!("provider call failed: status={status} body={text}");
    }

    if let Some((status, text)) = last_error {
        anyhow::bail!("provider call failed: status={status} body={text}");
    }

    anyhow::bail!("provider call failed: no request attempt was made")
}

fn push_unique_token(tokens: &mut Vec<String>, token: Option<&str>) {
    let Some(raw) = token else {
        return;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    if tokens.iter().any(|existing| existing == trimmed) {
        return;
    }
    tokens.push(trimmed.to_string());
}

fn resolve_provider_auth_tokens(
    provider_id: &str,
    provider_auth_token: Option<&str>,
    controller_internal_token: Option<&str>,
    supabase_service_role_key: Option<&str>,
) -> Vec<String> {
    let mut tokens = Vec::new();
    push_unique_token(&mut tokens, provider_auth_token);

    if crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(provider_id) {
        push_unique_token(&mut tokens, controller_internal_token);
        push_unique_token(&mut tokens, supabase_service_role_key);
    }

    tokens
}

pub(super) fn authorize_provider_for_project(
    state: &AppState,
    provider_id: &str,
    project_org_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if crate::provider_identifiers::is_self_hosted_provider_id(provider_id) {
        // Self-hosted runtimes are launched outside the allocator/provider registry.
        return Ok(());
    }

    let provider = state
        .provider_registry
        .provider_config(provider_id)
        .ok_or_else(|| {
            bad_request(&format!(
                "provider '{}' is not configured on this controller",
                provider_id
            ))
        })?;
    authorize_provider_config_for_project(&provider, project_org_id)
}

pub(crate) fn provider_is_self_hosted(state: &AppState, provider_id: &str) -> bool {
    crate::provider_identifiers::is_self_hosted_provider_id(provider_id)
        || state
            .provider_registry
            .provider_config(provider_id)
            .is_some_and(|provider| {
                crate::provider_identifiers::is_self_hosted_provider_kind(&provider.kind)
            })
}

/// Authorize one already-resolved provider snapshot.
///
/// Launch admission may wait while the provider registry is refreshed. The
/// launch path must authorize the exact same snapshot it later uses for kind,
/// routing, credentials, and metadata instead of performing another registry
/// read that could observe a different generation.
pub(super) fn authorize_provider_config_for_project(
    provider: &crate::config::RuntimeProviderConfig,
    project_org_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if let Some(owner_org) = provider.owner_org_id {
        if Some(owner_org) != project_org_id
            && !provider
                .allowed_org_ids
                .iter()
                .any(|org| Some(*org) == project_org_id)
        {
            return Err(forbidden("provider is not available for this organization"));
        }
    } else if !provider.allowed_org_ids.is_empty()
        && !provider
            .allowed_org_ids
            .iter()
            .any(|org| Some(*org) == project_org_id)
    {
        return Err(forbidden("provider is not available for this organization"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_browser_profile_persistence_env, apply_controller_turn_credentials,
        call_provider_endpoint, merge_provider_metadata, provider_call_status_is_final_success,
        resolve_provider_auth_tokens,
    };
    use crate::browser_turn::BrowserTurnRestConfig;
    use serde_json::{json, Value as JsonValue};
    use uuid::Uuid;

    const TEST_TURN_SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn provider_acknowledgement_must_be_synchronous_and_final() {
        for accepted in [
            reqwest::StatusCode::OK,
            reqwest::StatusCode::CREATED,
            reqwest::StatusCode::NO_CONTENT,
        ] {
            assert!(provider_call_status_is_final_success(accepted));
        }
        assert!(!provider_call_status_is_final_success(
            reqwest::StatusCode::ACCEPTED
        ));
        assert!(!provider_call_status_is_final_success(
            reqwest::StatusCode::PARTIAL_CONTENT
        ));
    }

    #[tokio::test]
    async fn provider_call_deadline_bounds_an_unresponsive_provider() -> anyhow::Result<()> {
        use std::time::{Duration, Instant};

        // Accepts the request and never answers, like a wedged allocator.
        let app = axum::Router::new().route(
            "/runtime/release",
            axum::routing::post(|| async {
                std::future::pending::<()>().await;
                axum::http::StatusCode::NO_CONTENT
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve unresponsive provider");
        });

        // The call never touches the database; an unconnected pool suffices.
        let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
            "postgres://postgres:postgres@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder().max_size(1).build_unchecked(manager);
        let state = crate::tests::build_test_state(
            pool,
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "provider-call-deadline",
            ),
        );
        let provider = crate::config::RuntimeProviderConfig {
            id: "provider_call_deadline_test".to_string(),
            display_name: "Unresponsive provider".to_string(),
            kind: "test".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some(format!("http://{address}")),
            auth_token: None,
            metadata: None,
        };

        let started = Instant::now();
        let error = tokio::time::timeout(
            Duration::from_secs(5),
            call_provider_endpoint(
                &state,
                &provider,
                "/runtime/release",
                &json!({ "project_id": Uuid::new_v4(), "runtime_id": Uuid::new_v4() }),
                Duration::from_millis(200),
            ),
        )
        .await
        .expect("the provider call must honour its own deadline")
        .expect_err("an unresponsive provider must fail the call");

        assert!(
            error.to_string().contains("/runtime/release timed out"),
            "unexpected error: {error}"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        server.abort();
        Ok(())
    }

    fn test_turn_config() -> BrowserTurnRestConfig {
        BrowserTurnRestConfig::for_test("turns:turn.example.test:5349", TEST_TURN_SECRET, 600)
    }

    #[test]
    fn provider_environment_fills_deployment_values_without_overriding_runtime_choices() {
        let runtime = Some(json!({
            "env": {
                "INSTAFY_BROWSER_CDP_SCREENCAST": "1",
                "INSTAFY_BROWSER_PREFERRED_VIEWER": "cdp-screencast",
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "[{\"urls\":[\"turn:attacker.test\"]}]",
                "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN": "0",
                "INSTAFY_BROWSER_WEBRTC_FPS": "60",
                "INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS": "20000"
            },
            "source": "browser-session"
        }));
        let provider = Some(json!({
            "env": {
                "INSTAFY_BROWSER_PREFERRED_VIEWER": "webrtc",
                "INSTAFY_BROWSER_WEBRTC_ENABLED": "1",
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "[{\"urls\":[\"turns:trusted.test:443\"]}]",
                "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN": "1",
                "INSTAFY_BROWSER_WEBRTC_FPS": "24",
                "INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS": "2800"
            },
            "source": "provider-default"
        }));

        let merged = merge_provider_metadata(&runtime, &provider).expect("merged metadata");
        let env = merged["env"].as_object().expect("merged environment");
        assert_eq!(env["INSTAFY_BROWSER_PREFERRED_VIEWER"], "cdp-screencast");
        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_ENABLED"], "1");
        assert_eq!(
            env["INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"],
            "[{\"urls\":[\"turns:trusted.test:443\"]}]"
        );
        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_FPS"], "24");
        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS"], "2800");
        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"], "1");
        assert_eq!(merged["source"], "browser-session");
    }

    #[test]
    fn provider_environment_replaces_malformed_runtime_environment() {
        let runtime = Some(json!({
            "env": "invalid",
            "source": "browser-session"
        }));
        let provider = Some(json!({
            "env": {
                "INSTAFY_BROWSER_WEBRTC_ENABLED": "1",
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "[{\"urls\":[\"turns:trusted.test:443\"]}]",
                "INSTAFY_BROWSER_WEBRTC_FPS": "24"
            }
        }));

        let merged = merge_provider_metadata(&runtime, &provider).expect("merged metadata");
        let env = merged["env"].as_object().expect("normalized environment");
        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_ENABLED"], "1");
        assert_eq!(
            env["INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"],
            "[{\"urls\":[\"turns:trusted.test:443\"]}]"
        );
        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_FPS"], "24");
    }

    #[test]
    fn controller_turn_credentials_override_runtime_and_provider_values_after_merge() {
        let project_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let runtime_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let runtime = Some(json!({
            "env": {
                "INSTAFY_BROWSER_WEBRTC_ENABLED": "1",
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "runtime-controlled",
                "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN": "0"
            }
        }));
        let provider = Some(json!({
            "env": {
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "provider-controlled",
                "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN": "0"
            }
        }));
        let merged = merge_provider_metadata(&runtime, &provider);
        let injected = apply_controller_turn_credentials(
            Some(&test_turn_config()),
            project_id,
            runtime_id,
            1_700_000_000,
            merged,
        )
        .expect("injected metadata");
        let env = injected["env"].as_object().expect("environment");
        let ice: serde_json::Value = serde_json::from_str(
            env["INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"]
                .as_str()
                .expect("ICE JSON string"),
        )
        .expect("ICE JSON");

        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"], "1");
        assert_eq!(ice[0]["urls"], json!(["turns:turn.example.test:5349"]));
        assert_eq!(
            ice[0]["username"],
            "1700000600:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"
        );
        assert_ne!(ice[0]["credential"], TEST_TURN_SECRET);
    }

    #[test]
    fn managed_webrtc_is_disabled_outside_the_controller_project_allowlist() {
        let allowed = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let denied = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let runtime_id = Uuid::new_v4();
        let config = BrowserTurnRestConfig::for_test_projects(
            "turns:turn.example.test:443",
            TEST_TURN_SECRET,
            600,
            &allowed.to_string(),
        );
        let metadata = Some(json!({
            "env": {
                "INSTAFY_BROWSER_CDP_SCREENCAST": "1",
                "INSTAFY_BROWSER_PREFERRED_VIEWER": "webrtc",
                "INSTAFY_BROWSER_WEBRTC_ENABLED": "1",
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "provider-controlled",
                "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN": "0"
            }
        }));

        let gated = apply_controller_turn_credentials(
            Some(&config),
            denied,
            runtime_id,
            1_700_000_000,
            metadata,
        )
        .expect("gated metadata");
        let env = gated["env"].as_object().expect("environment");
        assert_eq!(env["INSTAFY_BROWSER_WEBRTC_ENABLED"], "0");
        assert_eq!(env["INSTAFY_BROWSER_PREFERRED_VIEWER"], "cdp-screencast");
        assert!(!env.contains_key("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"));
        assert!(!env.contains_key("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"));
    }

    #[test]
    fn controller_turn_credentials_leave_disabled_and_malformed_metadata_unchanged() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let config = test_turn_config();
        let disabled = Some(json!({
            "env": {
                "INSTAFY_BROWSER_WEBRTC_ENABLED": "0",
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "existing",
                "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN": "0"
            }
        }));
        assert_eq!(
            apply_controller_turn_credentials(
                Some(&config),
                project_id,
                runtime_id,
                1_700_000_000,
                disabled.clone(),
            ),
            disabled
        );

        for malformed in [
            Some(json!({"env": "not-an-object"})),
            Some(json!({"env": {"INSTAFY_BROWSER_WEBRTC_ENABLED": 1}})),
            Some(json!(["not-an-object"])),
            None,
        ] {
            assert_eq!(
                apply_controller_turn_credentials(
                    Some(&config),
                    project_id,
                    runtime_id,
                    1_700_000_000,
                    malformed.clone(),
                ),
                malformed
            );
        }
    }

    #[test]
    fn controller_turn_credentials_are_not_injected_without_controller_config() {
        let metadata = Some(json!({
            "env": {
                "INSTAFY_BROWSER_WEBRTC_ENABLED": "1",
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON": "local-development"
            }
        }));
        assert_eq!(
            apply_controller_turn_credentials(
                None,
                Uuid::new_v4(),
                Uuid::new_v4(),
                1_700_000_000,
                metadata.clone(),
            ),
            metadata
        );
    }

    #[test]
    fn resolve_provider_auth_tokens_prefers_provider_token_and_adds_instafy_fallbacks() {
        let tokens = resolve_provider_auth_tokens(
            "instafy-cloud",
            Some("provider-token"),
            Some("internal-token"),
            Some("service-role-token"),
        );
        assert_eq!(
            tokens,
            vec![
                "provider-token".to_string(),
                "internal-token".to_string(),
                "service-role-token".to_string()
            ]
        );
    }

    #[test]
    fn resolve_provider_auth_tokens_keeps_non_instafy_provider_scoped() {
        for provider in ["external-http", "instafy-cloud-custom"] {
            let tokens = resolve_provider_auth_tokens(
                provider,
                Some("provider-token"),
                Some("internal-token"),
                Some("service-role-token"),
            );
            assert_eq!(
                tokens,
                vec!["provider-token".to_string()],
                "cloud-looking custom providers must never receive controller credentials"
            );
        }
    }

    #[test]
    fn browser_profile_policy_strips_client_attempt_to_enable_persistence() {
        let metadata = json!({
            "env": {
                "INSTAFY_BROWSER_PROFILE_PERSIST": "1",
                "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS": "1",
                "INSTAFY_ENABLE_BROWSER_SESSION": "1"
            },
            "source": "client"
        });

        let result = apply_browser_profile_persistence_env(Some(metadata), false, 30)
            .expect("unrelated metadata should remain");
        let env = result["env"].as_object().expect("env object");
        assert_eq!(
            env.get("INSTAFY_ENABLE_BROWSER_SESSION"),
            Some(&JsonValue::String("1".to_string()))
        );
        assert_eq!(
            env.get("INSTAFY_BROWSER_PROFILE_PERSIST"),
            Some(&JsonValue::String("0".to_string()))
        );
        assert_eq!(
            env.get("INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS"),
            Some(&JsonValue::String("0".to_string()))
        );
        assert_eq!(result["source"], "client");
    }

    #[test]
    fn browser_profile_policy_overrides_untrusted_values_for_allowlisted_project() {
        let metadata = json!({
            "env": {
                "INSTAFY_BROWSER_PROFILE_PERSIST": "0",
                "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS": "9999",
                "SAFE_KEY": "kept"
            }
        });

        let result = apply_browser_profile_persistence_env(Some(metadata), true, 30)
            .expect("policy metadata");
        assert_eq!(result["env"]["INSTAFY_BROWSER_PROFILE_PERSIST"], "1");
        assert_eq!(result["env"]["INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS"], "30");
        assert_eq!(result["env"]["SAFE_KEY"], "kept");
    }

    #[test]
    fn browser_profile_policy_explicitly_disables_ambient_persistence() {
        let result = apply_browser_profile_persistence_env(None, false, 30)
            .expect("disabled policy must override ambient provider env");
        assert_eq!(result["env"]["INSTAFY_BROWSER_PROFILE_PERSIST"], "0");
        assert_eq!(result["env"]["INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS"], "0");
    }
}
