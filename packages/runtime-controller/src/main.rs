use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::routing::get;
use axum::Router;
use reqwest::Client;
use serde_json::json;
use tower_http::cors::CorsLayer;
use tracing::{error, info};
use uuid::Uuid;

mod active_job_auth;
mod activity;
mod agent;
mod agent_contexts;
mod agent_write_scopes;
mod ai_agents;
mod auth;
mod automations;
mod billing;
mod browser_profile;
mod browser_turn;
mod bug_reports;
mod config;
mod connection_limit;
mod conversations;
mod credential_keys;
mod credential_rotation;
mod credentials;
mod credits;
mod desktop_updates;
mod dev;
mod device_auth;
mod diagnostics;
mod dispatch;
mod edge_downloads;
mod errors;
mod events;
mod geo;
mod git_events;
mod group_participation;
mod imports;
mod integrations;
mod jwks;
mod message_search;
mod message_stashes;
mod model_defaults;
mod multi_agent_plan;
mod notification_platform;
mod notifications;
mod operator_admin;
mod operator_metrics;
mod org_limits;
mod origins;
mod ota;
mod projects;
mod provider_devices;
mod provider_identifiers;
mod provider_requests;
mod providers;
mod rate_limit;
mod redaction;
mod redis_bus;
mod runs;
mod runtime;
mod secrets;
mod send_intents;
mod send_queue;
mod skills_discovery;
mod speech_proxy;
mod state;
mod telemetry;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_managed_ai_refund;
#[cfg(test)]
mod tests_managed_credential;
#[cfg(test)]
mod tests_runtime_stop_fence;
mod tokens;
mod tunnels;
mod utils;
mod workspace;

pub(crate) use config::AppConfig;
pub(crate) use errors::{
    bad_request, database_unavailable, forbidden, internal_error, not_found, too_many_requests,
    unauthorized, ApiError,
};
pub(crate) use projects::{
    ensure_project_access, ensure_project_scoped_write_access, ensure_project_write_access,
    ensure_scoped_claims_allow_requested_scopes, load_project_record, parse_optional_uuid_param,
    resolve_scope, ProjectRecord, ScopeParams,
};
pub(crate) use state::{
    publish_controller_event, publish_controller_event_with_conversation, AppState,
    CredentialRefreshLocks, EventHub, LocalWorkspaceRegistry, RuntimeActivityTracker,
    RuntimePreferenceRegistry, RuntimeResourceUsageRegistry,
};
pub(crate) use utils::coerce_idle_ttl;

async fn lookup_service_runtime_user_id(
    pool: &crate::config::PgPool,
    email: &str,
) -> anyhow::Result<Option<Uuid>> {
    let normalized = email.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Ok(None);
    }

    let connection = pool
        .get()
        .await
        .map_err(|error| anyhow::anyhow!("failed to acquire database connection: {error}"))?;

    let row = connection
        .query_opt(
            "select id from auth.users where lower(email) = lower($1) limit 1",
            &[&normalized],
        )
        .await
        .map_err(|error| anyhow::anyhow!("failed to query auth.users: {error}"))?;

    Ok(row.map(|row| row.get(0)))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();

    // Configuration performs blocking HTTP work, including service-user bootstrap.
    // Keep its blocking clients outside Tokio's async execution context.
    let mut config = tokio::task::spawn_blocking(AppConfig::from_env)
        .await
        .map_err(|_| anyhow::anyhow!("controller configuration task failed"))??;
    let pool = config.build_pool().await?;
    browser_profile::ensure_browser_profiles_table(&pool)
        .await
        .map_err(|error| {
            anyhow::anyhow!("failed to initialize browser profile storage: {error}")
        })?;

    // Hosted workspaces are git-canonical working copies on an ephemeral node
    // disk; the git remote is the ONLY durable copy. Without it, a controller
    // replacement silently destroys every hosted working tree.
    if config.git_remote_base_url.is_none() && !config.dev_mode {
        tracing::error!(
            "GIT_REMOTE_BASE_URL is not set: hosted workspaces have NO durable backing and will be \
             lost on node replacement. Configure the git service remote base before serving users."
        );
    }

    if config.service_runtime_user_id.is_none() {
        let service_runtime_user_email = std::env::var("SERVICE_RUNTIME_USER_EMAIL")
            .ok()
            .map(|raw| raw.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "service-runtime@instafy.dev".to_string());
        match lookup_service_runtime_user_id(&pool, &service_runtime_user_email).await {
            Ok(Some(id)) => {
                config.service_runtime_user_id = Some(id);
                info!(service_runtime_user_id = %id, "resolved SERVICE_RUNTIME_USER_ID from database");
            }
            Ok(None) => {
                tracing::warn!(
                    service_runtime_user_email = %service_runtime_user_email,
                    "SERVICE_RUNTIME_USER_ID is unset and auth.users does not contain the service runtime user; runtime agents may not sync workspace changes."
                );
            }
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "failed to resolve SERVICE_RUNTIME_USER_ID from database; runtime agents may not sync workspace changes."
                );
            }
        }
    }

    info!(
        strict_mode = config.strict_mode,
        dev_isolation_mode = config.dev_isolation_mode,
        dev_mode = config.dev_mode,
        has_service_role_key = config.supabase_service_role_key.is_some(),
        has_service_runtime_user_id = config.service_runtime_user_id.is_some(),
        jwks_refresh_seconds = config.supabase_jwks_refresh_seconds,
        auto_create_projects = config.auto_create_projects,
        redis_event_bus = config.redis_url.is_some(),
        redis_namespace = config.redis_namespace.as_deref(),
        redis_events_channel = config.redis_events_channel.as_deref(),
        dev_project_registry = config
            .dev_project_registry_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        "controller configuration loaded"
    );
    let http_client = Client::builder()
        .user_agent("instafy-runtime-controller")
        .build()?;
    let origin_proxy_client = Client::builder()
        .user_agent("instafy-runtime-controller-origin-proxy")
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let (events, redis_event_bus) = match config.redis_url.clone() {
        Some(redis_url) => {
            let channel = config
                .redis_events_channel
                .clone()
                .unwrap_or_else(|| "instafy:controller:events".to_string());
            let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(2048);
            (
                EventHub::new_with_outbound(outbound_tx),
                Some((redis_url, channel, outbound_rx)),
            )
        }
        None => (EventHub::new(), None),
    };
    let runtime_activity = RuntimeActivityTracker::new(config.runtime_idle_release_seconds);
    let provider_registry = providers::build_provider_registry(&config, &pool).await?;
    let tunnel_broker = tunnels::build_tunnel_broker(&config, http_client.clone())?;
    let state = AppState {
        config: config.clone(),
        pool: pool.clone(),
        rate_limiter: rate_limit::RateLimiter::new(),
        connection_limiter: connection_limit::ConnectionLimiter::new(),
        events,
        http_client,
        origin_proxy_client,
        runtime_activity: runtime_activity.clone(),
        local_workspaces: LocalWorkspaceRegistry::new(),
        runtime_preferences: RuntimePreferenceRegistry::new(),
        runtime_resource_usage: RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker,
        device_auth_sessions: device_auth::DeviceAuthRegistry::new(),
        ota_registry: ota::OtaRegistry::new_postgres(pool.clone()),
        desktop_update_registry: desktop_updates::DesktopUpdateRegistry::new_postgres(pool.clone()),
        credential_refresh_locks: CredentialRefreshLocks::new(),
    };

    if let Err(error) =
        credentials::ensure_managed_ai_proxy_ready(&state.http_client, &state.config).await
    {
        let error_message = error.to_string();
        if let Err(report_error) = bug_reports::record_system_bug_report(
            &state,
            bug_reports::SystemBugReportInput {
                message: "Managed AI proxy startup check failed".to_string(),
                details: Some(error_message.clone()),
                project_id: None,
                runtime_id: None,
                run_id: None,
                conversation_id: None,
                priority: "urgent".to_string(),
                labels: vec![
                    "managed-ai".to_string(),
                    "proxy".to_string(),
                    "monitoring".to_string(),
                ],
                metadata: json!({
                    "source": "controller.startup",
                    "proxyBaseUrlConfigured": state.config.proxy_base_url.is_some(),
                }),
                logs: json!([
                    {
                        "kind": "managed_ai.proxy.startup_failed",
                        "error": error_message,
                    }
                ]),
                fingerprint: Some("managed_ai.proxy.startup".to_string()),
                dedupe_window_seconds: Some(15 * 60),
            },
        )
        .await
        {
            tracing::warn!(%report_error, "failed to record managed AI proxy startup issue");
        }
        return Err(error);
    }

    info!(
        tunnel_broker_enabled = state.tunnel_broker.is_some(),
        "tunnel broker configured"
    );

    if let Some((redis_url, channel, outbound_rx)) = redis_event_bus {
        redis_bus::spawn(redis_url, channel, state.events.clone(), outbound_rx);
    }

    if let Err(error) = origins::register_runtime_signing_key(&state).await {
        tracing::warn!(
            ?error,
            "failed to register runtime signing key; origin token validation may fail during blue/green overlap"
        );
    }

    workspace::spawn_workspace_watchers(&state);
    workspace::spawn_local_workspace_housekeeping(&state);
    origins::spawn_origin_presence_housekeeping(&state);
    automations::spawn_automation_scheduler(state.clone());
    notification_platform::spawn_worker(state.clone());
    send_queue::spawn_send_queue_recovery_sweep(state.clone());

    let idle_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(10));
        loop {
            ticker.tick().await;
            if let Err(error) = runtime::sweep_idle_activity(&idle_state).await {
                tracing::warn!(?error, "idle activity sweep failed");
            }
        }
    });

    // Telemetry/ephemeral-table retention, on its own slow ticker (separate from
    // the 10s idle sweep) so the periodic prunes are cheap and never compete with
    // the hot lifecycle path. High-volume telemetry and expired grants need only
    // short retention; lifecycle fencing evidence is retained by its pruner.
    let retention_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(300));
        loop {
            ticker.tick().await;
            if let Err(error) = runtime::prune_expired_runtime_events(&retention_state).await {
                tracing::warn!(?error, "runtime_events retention prune failed");
            }
            if let Err(error) = origins::prune_expired_access_grants(&retention_state.pool).await {
                tracing::warn!(?error, "origin_access_grants retention prune failed");
            }
        }
    });

    let billing_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        let mut transient_failure_started_at = None;
        loop {
            ticker.tick().await;
            let error = runtime::sweep_hosted_runtime_credit_usage(&billing_state)
                .await
                .err();
            if let Some(error) = error {
                let error_message = error.to_string();
                tracing::warn!(error = %error_message, "hosted runtime credit sweep failed");
                if !runtime::should_report_hosted_runtime_credit_sweep_error(
                    &error,
                    &mut transient_failure_started_at,
                    std::time::Instant::now(),
                ) {
                    continue;
                }
                record_hosted_runtime_credit_sweep_failure(&billing_state, error_message).await;
            } else {
                runtime::reset_hosted_runtime_credit_sweep_pool_pressure(
                    &mut transient_failure_started_at,
                );
            }
        }
    });

    if config.supabase_jwks_refresh_enabled {
        let jwks_handle = config.supabase_jwks.clone();
        let jwks_url = config.supabase_jwks_url.clone();
        let refresh_seconds = config.supabase_jwks_refresh_seconds;
        let http = state.http_client.clone();
        tokio::spawn(async move {
            loop {
                match jwks::SupabaseJwks::load_async(&http, &jwks_url).await {
                    Ok(next) => {
                        let mut guard = jwks_handle.write().await;
                        *guard = next;
                        tracing::debug!("Supabase JWKS refreshed");
                    }
                    Err(error) => {
                        tracing::warn!(%error, "failed to refresh Supabase JWKS");
                    }
                }
                tokio::time::sleep(Duration::from_secs(refresh_seconds)).await;
            }
        });
    }

    let cors = CorsLayer::permissive();

    let mut app = Router::new()
        .route(
            "/healthz",
            get(|State(state): State<AppState>| async move {
                let mut headers = HeaderMap::new();
                let pool_state = state.pool.state();
                headers.insert(
                    "x-instafy-has-service-runtime-user-id",
                    HeaderValue::from_static(if state.config.service_runtime_user_id.is_some() {
                        "1"
                    } else {
                        "0"
                    }),
                );
                headers.insert(
                    "x-instafy-has-service-role-key",
                    HeaderValue::from_static(if state.config.supabase_service_role_key.is_some() {
                        "1"
                    } else {
                        "0"
                    }),
                );
                if state.config.proxy_credential_lease_token.is_some() {
                    headers.insert(
                        "x-instafy-credential-lease-protocol",
                        HeaderValue::from_static("1"),
                    );
                }
                if let Ok(value) =
                    HeaderValue::from_str(&state.config.database_pool_size.to_string())
                {
                    headers.insert("x-instafy-db-pool-size", value);
                }
                if let Ok(value) = HeaderValue::from_str(&pool_state.connections.to_string()) {
                    headers.insert("x-instafy-db-pool-connections", value);
                }
                if let Ok(value) = HeaderValue::from_str(&pool_state.idle_connections.to_string()) {
                    headers.insert("x-instafy-db-pool-idle", value);
                }
                if let Ok(value) =
                    HeaderValue::from_str(&pool_state.statistics.get_waited.to_string())
                {
                    headers.insert("x-instafy-db-pool-get-waited", value);
                }
                if let Ok(value) =
                    HeaderValue::from_str(&pool_state.statistics.get_timed_out.to_string())
                {
                    headers.insert("x-instafy-db-pool-get-timed-out", value);
                }
                (StatusCode::OK, headers)
            }),
        )
        .merge(diagnostics::router())
        .merge(runtime::router())
        .merge(billing::router())
        .merge(bug_reports::router())
        .merge(dispatch::router())
        .merge(automations::router())
        .merge(projects::router())
        .merge(imports::router())
        .merge(integrations::router())
        .merge(providers::router())
        .merge(provider_devices::router())
        .merge(provider_requests::router())
        .merge(agent::router())
        .merge(agent_contexts::router())
        .merge(ai_agents::router())
        .merge(origins::router())
        .merge(speech_proxy::router())
        .merge(credits::router())
        .merge(credentials::router())
        .merge(credential_rotation::router())
        .merge(secrets::router())
        .merge(browser_profile::router())
        .merge(skills_discovery::router())
        .merge(device_auth::router())
        .merge(conversations::router())
        .merge(message_search::router())
        .merge(message_stashes::router())
        .merge(send_intents::router())
        .merge(send_queue::router())
        .merge(notifications::router())
        .merge(notification_platform::router())
        .merge(activity::router())
        .merge(runs::router())
        .merge(workspace::router())
        .merge(ota::router())
        .merge(operator_admin::router())
        .merge(operator_metrics::router())
        .merge(desktop_updates::router())
        .merge(edge_downloads::router())
        .merge(telemetry::router())
        .merge(events::router())
        .merge(git_events::router())
        .merge(tunnels::router());
    app = app.merge(auth::router());
    app = app.merge(dev::router(config.dev_project_registry_path.clone()));

    let app = app.with_state(state).layer(cors);

    // Prefer an IPv6 listener when available so `localhost` (often ::1) works in browsers,
    // while still accepting IPv4 loopback connections on platforms with dual-stack sockets.
    let addr_v6 = SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 0], config.port));
    let addr_v4 = SocketAddr::from(([0, 0, 0, 0], config.port));

    let listener_v6 = match tokio::net::TcpListener::bind(addr_v6).await {
        Ok(listener) => Some(listener),
        Err(error) => {
            tracing::warn!(%error, %addr_v6, "failed to bind IPv6 listener");
            None
        }
    };

    // If the IPv6 socket is dual-stack, binding IPv4 will fail with "address in use". That's fine.
    let listener_v4 = match tokio::net::TcpListener::bind(addr_v4).await {
        Ok(listener) => Some(listener),
        Err(error) => {
            tracing::debug!(%error, %addr_v4, "failed to bind IPv4 listener");
            None
        }
    };

    match (listener_v6, listener_v4) {
        (Some(v6), Some(v4)) => {
            info!(%addr_v6, %addr_v4, "runtime-controller listening");
            let server_v6 = axum::serve(v6, app.clone().into_make_service());
            let server_v4 = axum::serve(v4, app.into_make_service());
            if let Err(error) = tokio::try_join!(server_v6, server_v4)
                .map(|_| ())
                .map_err(|e| e)
            {
                error!(%error, "controller server exited with error");
                return Err(error.into());
            }
        }
        (Some(v6), None) => {
            info!(%addr_v6, "runtime-controller listening");
            if let Err(error) = axum::serve(v6, app.into_make_service()).await {
                error!(%error, "controller server exited with error");
                return Err(error.into());
            }
        }
        (None, Some(v4)) => {
            info!(%addr_v4, "runtime-controller listening");
            if let Err(error) = axum::serve(v4, app.into_make_service()).await {
                error!(%error, "controller server exited with error");
                return Err(error.into());
            }
        }
        (None, None) => {
            tracing::error!(
                port = config.port,
                "failed to bind runtime-controller listener on both IPv6 and IPv4"
            );
            return Err(anyhow::anyhow!(
                "failed to bind runtime-controller listener on port {}",
                config.port
            ));
        }
    }

    Ok(())
}

async fn record_hosted_runtime_credit_sweep_failure(state: &AppState, error_message: String) {
    if let Err(report_error) = bug_reports::record_system_bug_report(
        state,
        bug_reports::SystemBugReportInput {
            message: "Hosted runtime credit sweep failed".to_string(),
            details: Some(error_message.clone()),
            project_id: None,
            runtime_id: None,
            run_id: None,
            conversation_id: None,
            priority: "high".to_string(),
            labels: vec![
                "billing".to_string(),
                "runtime".to_string(),
                "monitoring".to_string(),
            ],
            metadata: json!({
                "source": "runtime.credit_sweep",
            }),
            logs: json!([
                {
                    "kind": "runtime.credit_sweep.failed",
                    "error": error_message,
                }
            ]),
            fingerprint: Some("runtime.credit_sweep.failed".to_string()),
            dedupe_window_seconds: Some(15 * 60),
        },
    )
    .await
    {
        tracing::warn!(
            %report_error,
            "failed to record hosted runtime credit sweep issue"
        );
    }
}
